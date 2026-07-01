# Architecture

PDF Sync automates a manual daily workflow: a FlixBus operations manager receives passenger manifest PDFs in a WhatsApp group and previously had to download each one and enter the data by hand. This system monitors the group, downloads new PDFs, parses them, and stores structured data in a normalized Supabase database — fully unattended.

---

## System Flow

```
WhatsApp Web (Playwright)
      │
      │  1. Persistent browser session (no QR scan after first run)
      │
      ▼  2. Load the latest successfully imported WhatsApp timestamp
      │     (MAX(whatsapp_received_at)) from flix_trips.
      │     This acts as the synchronization checkpoint.
      │
      ▼  3. Scrolls upward until the checkpoint boundary becomes visible.
      │
      ▼  4. Processes messages in chronological order (oldest → newest)
      │     — Skip if no PDF attachment
      │     — Read the WhatsApp timestamp (time + date divider from DOM)
      │     — Skip if timestamp < checkpoint (already imported)
      │     — Download the PDF
      │
      ▼  SHA-256 hash check
      │  (already in DB? → skip insert — handles re-sends and boundary duplicates)
      │
      ▼  Python subprocess: scripts/extract_pdf.py
      │  (pdfplumber — coordinate-aware table extraction)
      │
      ▼  Relational inserts
      │  ├── flix_trips             (one row per PDF, whatsapp_received_at in IST)
      │  ├── flix_trip_drivers      (one row per driver per trip)
      │  └── flix_trip_passengers   (one row per seat per trip)
      │
      ▼  Service ID auto-fill
         If line_number is null after insert:
         query trips table by vehicle_number + IST date range → fill from service_id
```

The async generator pattern (`streamPdfs`) lets the orchestrator receive and insert each PDF immediately as it is downloaded, rather than buffering everything in memory first.

---

## Key Design Decisions

### 1. Playwright persistent context over WhatsApp API

WhatsApp's official Business API requires approval and costs money. The Cloud API has rate limits and doesn't give access to group history. Playwright with a persistent browser context (saved to `.runtime/`) lets the system authenticate once via QR scan and then operate as a real browser session indefinitely — no approval, no fees, no message-count limits.

The tradeoff: WhatsApp Web uses a virtual DOM and only renders messages near the current scroll position. `scrollUpToCheckpoint()` handles this by scrolling upward until the oldest visible message is at or before the checkpoint timestamp, so the scan always starts from the right position without loading unnecessary history.

### 2. Checkpoint-based incremental sync (oldest → newest)

Each imported PDF has its WhatsApp received-at time stored in `flix_trips.whatsapp_received_at` as an IST `timestamp`. At the start of every sync, the service loads `MAX(whatsapp_received_at)` from the database as the **checkpoint**.

The browser scrolls back to the checkpoint boundary and the generator yields PDFs in **chronological order (oldest → newest)**:

- Messages **before** the checkpoint → skipped with `continue` (no download, no browser interaction)
- Messages **at or after** the checkpoint → downloaded and processed

Processing oldest-to-newest means the checkpoint only advances as far as what was successfully stored. If a PDF fails mid-run, the checkpoint stays at the last successful entry, and the next sync automatically retries from that position. This is robust against parse failures, network interruptions, and partial runs.

The hash dedup layer handles the boundary: PDFs exactly at the checkpoint timestamp are always re-attempted (since the skip condition is `< checkpoint`, not `<=`), and `pdf_hash` catches any that were already imported.

### 3. Timestamp extraction from the WhatsApp DOM

WhatsApp Web renders each message's visible clock time (e.g. "16:41") inside a `[data-testid="msg-meta"]` div as a plain leaf `<span>` with no dedicated test ID or aria-label. The extraction reads that leaf span directly rather than relying on `data-pre-plain-text` (which sits in a sibling branch of the DOM and does not have a reliable per-message relationship to the PDF attachment element).

The date component comes from WhatsApp's date-divider elements ("Today", "Yesterday", "29 June 2026") by walking backwards through ancestor siblings from the current `conv-msg-*` element. WhatsApp wraps each message in several anonymous positioned divs before reaching the list level where date dividers live, so the walk checks siblings at up to 8 ancestor levels before giving up. Combined, time + date produce an explicit IST datetime (`2026-06-30T16:41:00+05:30`) that is independent of the server's system timezone.

### 4. IST timestamps stored as plain `timestamp` (not `timestamptz`)

`timestamptz` always normalizes stored values to UTC — regardless of what offset is provided on insert, Supabase displays and returns UTC. For an operations team working in IST, this means every timestamp requires a mental UTC→IST conversion.

The column is instead typed as `timestamp` (without timezone). The service formats the IST datetime as a plain string (`"2026-06-30 16:41:00"`) before inserting, so the database stores and displays it exactly as IST. When reading back for checkpoint comparison, the service appends `+05:30` before parsing to ensure a correct absolute `Date` regardless of server timezone.

### 5. pdfplumber over pdf-parse (Python subprocess)

`pdf-parse` (npm) extracts PDF text as a flat character stream, discarding coordinate information. The FlixBus PDFs have a multi-column driver table where cells from adjacent columns get concatenated — `"A, Ashok"` and `"host_India"` merge into `"A, Ashokhost_India"`. No regex can reliably split that back apart.

`pdfplumber` is coordinate-aware: it reconstructs table cells from their physical bounding boxes on the page. Each cell arrives separately. The extraction becomes straightforward header-index lookups with no regex fragility.

The cost is a Python subprocess per PDF. For this workload (a few PDFs per day), the latency is irrelevant. If throughput ever mattered, the subprocess could be replaced with a persistent Python process communicating over stdin/stdout.

**Script**: `scripts/extract_pdf.py`  
**Interface**: takes a file path as `argv[1]`, returns JSON to stdout matching the `FlixBusParsed` TypeScript interface.

### 6. Flat 3-table schema over dimension tables

An earlier iteration explored a full star schema with five dimension tables (`bus_partners`, `routes`, `vehicles`, `drivers`, `booking_sources`) each storing entities by UUID. That design required async "get or create" upserts for every dimension before the fact row could be inserted, and the joins added complexity without benefit for a single-tenant workload.

The current design collapses everything into three tables and uses plain text columns:

- **`flix_trips`** — one row per PDF; stores route, vehicle, and partner info directly as text
- **`flix_trip_drivers`** — one row per driver; stores name, role, and phone as text
- **`flix_trip_passengers`** — one row per seat; stores passenger name, phone, and booking source as text

Analytics queries (`GROUP BY vehicle_number`, `GROUP BY departure, arrival`) work identically on text columns. The service inserts into all three tables with a simple `Promise.all` and no upsert helpers.

### 7. Service ID auto-fill from `trips` table

FlixBus assigns each route departure a `service_id` (the internal line number). This ID may appear in the WhatsApp caption, in the PDF itself, or not at all.

When `line_number` is null after insert, the service queries a separate `trips` table using `vehicle_number` and an IST midnight date range on `departure_datetime`. If a match is found, `line_number` is updated in `flix_trips`. This decouples the sync from the data quality of individual PDFs — trips that arrive without a service ID are filled automatically from the operations database.

---

## Database Schema

```
flix_trips (
  id                   uuid  PRIMARY KEY
  line_number          text                    ← service ID (from PDF, caption, or trips lookup)
  bus_partner          text
  vehicle_number       text
  trip_date            date
  departure_time       time
  arrival_time         time
  departure            text
  arrival              text
  pdf_hash             text  UNIQUE            ← SHA-256, authoritative dedup
  whatsapp_received_at timestamp              ← IST local time, sync checkpoint
  created_at           timestamptz
)

flix_trip_drivers (
  id           uuid  PRIMARY KEY
  trip_id      uuid  → flix_trips  ON DELETE CASCADE
  driver_name  text
  role         text
  phone        text
)

flix_trip_passengers (
  id              uuid  PRIMARY KEY
  trip_id         uuid  → flix_trips  ON DELETE CASCADE
  seat_no         text
  passenger_name  text
  phone           text
  booking_source  text
)
```

`whatsapp_received_at` is stored as `timestamp` (without timezone) in IST. The Supabase client receives a formatted IST string (`"2026-06-30 16:41:00"`) so the dashboard displays local time directly. When read back for checkpoint comparison, the service appends `+05:30` before parsing to ensure a correct absolute `Date` regardless of server timezone.

Row Level Security is enabled on all three tables. The service role key bypasses RLS; no policies are defined, so anon/authenticated clients cannot access these tables directly.

### Analytics Views

| View | Purpose |
| --- | --- |
| `v_flix_trip_summary` | All trip fields + passenger count (via join) — used by the monitor dashboard and `GET /imports` API |
| `v_flix_driver_stats` | Total trips, passengers, avg passengers, date range per driver |
| `v_flix_driver_routes` | Trip count per driver per route |
| `v_flix_vehicle_stats` | Total trips, passengers, routes served per vehicle |
| `v_flix_route_stats` | Total trips, passengers, avg load per route |
| `v_flix_partner_stats` | Trip and passenger volume per bus partner |
| `v_flix_monthly_trends` | Monthly passenger volume by route |
| `v_flix_booking_source_stats` | Booking channel breakdown (Redbus, Abhibus, Flix, etc.) |
| `v_flix_repeat_passengers` | Passengers with more than one trip (identified by phone) |

All views are dropped and recreated in `schema.sql` so re-running the file always applies the latest column definitions cleanly.

Full schema: [`supabase/schema.sql`](../supabase/schema.sql)

---

## NestJS Service Layer

```
MonitorController        ← live dashboard at /monitor (HTML, auto-refreshes every 10s)
       │
PdfSyncController        ← HTTP endpoints (sync, import-pdf, test-parse, summary, imports, health)
       │
PdfSyncService           ← orchestration: checkpoint load, hash dedup, 3-table inserts, service ID lookup
       ├── WhatsAppService     ← Playwright: scroll to checkpoint, scan oldest→newest, download
       ├── PdfParserService    ← Python subprocess wrapper (parse / parseFile)
       └── SupabaseService     ← Supabase client

PdfSyncSchedulerService  ← setTimeout loop targeting PDF_SYNC_DAILY_TIME
```

Each service is independently injectable — WhatsApp, parsing, and Supabase can be tested or swapped in isolation.

---

## Scheduler

The sync can be triggered manually via `POST /pdf-sync/sync` or runs automatically at a configured daily time (`PDF_SYNC_DAILY_TIME` env var). The scheduler uses a `setTimeout` loop that calculates the milliseconds until the next occurrence of that clock time, rather than a fixed interval — so it fires at the same wall-clock time every day regardless of how long the previous run took.

---

## Monitor Dashboard

A single-page HTML dashboard served at `/monitor` with no frontend build step — the HTML is a template string in `monitor.controller.ts`.

| Section | What it shows |
| --- | --- |
| Sync Status | Live dot (idle / running / success / failed), WhatsApp group, last sync time, total imports, last imported trip |
| Environment Check | Backend reachable, Supabase connected, WhatsApp group configured |
| Live Logs | Animated step-by-step log during sync (checkpoint load → scroll → scan → parse → insert → service ID lookup) |
| Recent Imports | Line No, Vehicle, Route, Travel Date, Pax count, WhatsApp Received (IST), Imported At |

The dashboard polls `/pdf-sync/summary` and `/pdf-sync/imports` every 10 seconds and updates in place.

---

## Project Structure

```
src/
  pdf-sync/
    pdf-sync.service.ts      ← orchestration, checkpoint, hash dedup, 3-table inserts, service ID lookup
    pdf-sync.controller.ts   ← HTTP endpoints
    pdf-parser.service.ts    ← Python subprocess wrapper
    whatsapp.service.ts      ← Playwright automation (scroll, timestamp, download)
    pdf-sync-scheduler.service.ts
  supabase/
    supabase.service.ts      ← Supabase client
  monitor/
    monitor.controller.ts    ← live dashboard at /monitor
  common/
    guards/api-key.guard.ts  ← optional API key protection

scripts/
  extract_pdf.py             ← pdfplumber table extractor
  requirements.txt

supabase/
  schema.sql                 ← complete schema, safe to re-run (IF NOT EXISTS / OR REPLACE)

docs/
  ARCHITECTURE.md            ← this file
```
