# Architecture

PDF Sync automates a manual daily workflow: a FlixBus operations manager receives passenger manifest PDFs in a WhatsApp group and previously had to download each one and enter the data by hand. This system monitors the group, downloads new PDFs, parses them, and stores structured data in a normalized Supabase database — fully unattended.

---

## System Flow

```
WhatsApp Web (Playwright)
        │
        │  async generator — yields one PDF at a time, newest first
        ▼
  Pre-download check
  (known filename? → skip without downloading)
        │
        ▼
   Download PDF
        │
        ▼
  SHA-256 hash check
  (duplicate content? → skip insert)
        │
        ▼
  Python subprocess: scripts/extract_pdf.py
  (pdfplumber — coordinate-aware table extraction)
        │
        ▼
  Relational inserts
  ├── flix_trips        (one row per PDF)
  ├── trip_drivers      (one row per driver per trip)
  └── trip_passengers   (one row per seat per trip)
```

The async generator pattern (`streamPdfsNewestFirst`) lets the orchestrator control the scan — it can stop mid-stream after 2 consecutive duplicates without downloading everything first.

---

## Key Design Decisions

### 1. Playwright persistent context over WhatsApp API

WhatsApp's official Business API requires approval and costs money. The Cloud API has rate limits and doesn't give access to group history. Playwright with a persistent browser context (saved to `.runtime/`) lets the system authenticate once via QR scan and then operate as a real browser session indefinitely — no approval, no fees, no message-count limits.

The tradeoff: WhatsApp Web uses a virtual DOM and only renders messages near the current scroll position. The `scrollUpToRevealPDFs()` method handles this by scrolling upward in 1500px steps (up to 10 steps) and stopping once the first PDF card appears in the DOM.

### 2. Two-layer duplicate detection

Every PDF gets checked twice:

**Layer 1 — filename pre-check (before download):**  
WhatsApp assigns a UUID filename to each file at send time. The system loads all known `source_filename` values from `flix_trips` into a Set at sync start and skips any card whose filename is already known — no download needed.

**Layer 2 — SHA-256 hash check (after download):**  
The `pdf_hash` column has a unique constraint. If the same PDF is re-sent under a different filename (forwarded, re-uploaded), the hash catches it. This is the authoritative deduplication layer.

Layer 1 is a performance optimisation. Layer 2 is the correctness guarantee.

### 3. Consecutive duplicate threshold of 2, not 1

PDFs are scanned newest-first. When the system hits a known PDF, it doesn't stop immediately — it continues until it sees **2 consecutive** duplicates. This handles interrupted runs: if a previous sync downloaded PDFs 1 and 3 but crashed before 2, stopping at the first duplicate would permanently skip PDF 2. Two consecutive duplicates means we've genuinely reached the already-synced region.

### 4. pdfplumber over pdf-parse (Python subprocess)

`pdf-parse` (npm) extracts PDF text as a flat character stream, discarding coordinate information. The FlixBus PDFs have a multi-column driver table where cells from adjacent columns get concatenated — `"A, Ashok"` and `"host_India"` merged into `"A, Ashokhost_India"`. No regex can reliably split that back apart.

`pdfplumber` is coordinate-aware: it reconstructs table cells from their physical bounding boxes on the page. Each cell arrives separately. The extraction becomes straightforward header-index lookups with no regex fragility.

The cost is a Python subprocess per PDF. For this workload (a few PDFs per day), the latency is irrelevant. If throughput ever mattered, the subprocess could be replaced with a persistent Python process communicating over stdin/stdout.

**Script**: `scripts/extract_pdf.py`  
**Interface**: takes a file path as `argv[1]`, returns JSON to stdout matching the `FlixBusParsed` TypeScript interface.

### 5. `parseFile()` vs `parse(buffer)`

Downloaded PDFs already exist on disk (Playwright writes them to `.runtime/downloads/`). Passing the file path directly to the Python script avoids writing a redundant temp file. Uploaded PDFs (the manual import API endpoint) arrive as in-memory buffers — those write a temp file that is cleaned up in a `finally` block.

### 6. Flat 3-table schema over dimension tables

An earlier iteration explored a full star schema with five dimension tables (`bus_partners`, `routes`, `vehicles`, `drivers`, `booking_sources`) each storing entities by UUID. That design required async "get or create" upserts for every dimension before the fact row could be inserted, and the joins added complexity without benefit for a single-tenant workload.

The current design collapses everything into three tables and uses plain text columns:

- **`flix_trips`** — one row per PDF; stores route, vehicle, and partner info directly as text
- **`trip_drivers`** — one row per driver; stores name, role, and phone as text
- **`trip_passengers`** — one row per seat; stores passenger name, phone, and booking source as text

Analytics queries (`GROUP BY plate`, `GROUP BY departure, arrival`) work identically on text columns. The service inserts into all three tables with a simple `Promise.all` and no upsert helpers.

---

## Database Schema

```
flix_trips (
  id               uuid  PRIMARY KEY
  bus_partner      text
  plate            text
  trip_date        date
  departure_time   time
  arrival_time     time
  departure        text
  arrival          text
  pdf_hash         text  UNIQUE   ← SHA-256, authoritative dedup
  source_filename  text  UNIQUE   ← WhatsApp UUID, fast pre-download dedup
  created_at       timestamptz
)

trip_drivers (
  id           uuid  PRIMARY KEY
  trip_id      uuid  → flix_trips  ON DELETE CASCADE
  driver_name  text
  role         text
  phone        text
  created_at   timestamptz
)

trip_passengers (
  id              uuid  PRIMARY KEY
  trip_id         uuid  → flix_trips  ON DELETE CASCADE
  seat_no         text
  passenger_name  text
  phone           text
  booking_source  text
  created_at      timestamptz
)
```

Row Level Security is enabled on all three tables. The service role key bypasses RLS; no policies are defined, so anon/authenticated clients cannot access these tables directly.

### Analytics Views

| View | Purpose |
| --- | --- |
| `v_trip_summary` | All trip fields — used by the `GET /imports` API |
| `v_driver_stats` | Total trips, passengers, avg passengers, date range per driver |
| `v_driver_routes` | Trip count per driver per route |
| `v_vehicle_stats` | Total trips, passengers, routes served per plate |
| `v_route_stats` | Total trips, passengers, avg load per route |
| `v_partner_stats` | Trip and passenger volume per bus partner |
| `v_monthly_trends` | Monthly passenger volume by route |
| `v_booking_source_stats` | Booking channel breakdown (Redbus, Abhibus, Flix, etc.) |
| `v_repeat_passengers` | Passengers with more than one trip (identified by phone) |

All views are dropped and recreated in `schema.sql` so re-running the file always applies the latest column definitions cleanly.

Full schema: [`supabase/schema.sql`](../supabase/schema.sql)

---

## NestJS Service Layer

```
PdfSyncController        ← HTTP endpoints (sync, import-pdf, test-parse, summary, imports, health)
       │
PdfSyncService           ← orchestration: dedup logic, batch inserts into 3 tables
       ├── WhatsAppService     ← Playwright: scroll, find PDF cards, download
       ├── PdfParserService    ← Python subprocess wrapper (parse / parseFile)
       └── SupabaseService     ← Supabase client

PdfSyncSchedulerService  ← setTimeout loop targeting PDF_SYNC_DAILY_TIME
```

Each service is independently injectable — WhatsApp, parsing, and Supabase can be tested or swapped in isolation.

---

## Scheduler

The sync can be triggered manually via `POST /pdf-sync/sync` or runs automatically at a configured daily time (`PDF_SYNC_DAILY_TIME` env var). The scheduler uses a `setTimeout` loop that calculates the milliseconds until the next occurrence of that clock time, rather than a fixed interval — so it fires at the same wall-clock time every day regardless of how long the previous run took.

---

## Project Structure

```
src/
  pdf-sync/
    pdf-sync.service.ts      ← orchestration, duplicate logic, 3-table inserts
    pdf-sync.controller.ts   ← HTTP endpoints
    pdf-parser.service.ts    ← Python subprocess wrapper
    whatsapp.service.ts      ← Playwright automation
    pdf-sync-scheduler.service.ts
  supabase/
    supabase.service.ts      ← Supabase client
  monitor/
    monitor.controller.ts    ← health / status endpoints
  common/
    guards/api-key.guard.ts  ← optional API key protection

scripts/
  extract_pdf.py             ← pdfplumber table extractor
  requirements.txt

supabase/
  schema.sql                 ← complete schema, safe to re-run (no migrations)

docs/
  ARCHITECTURE.md            ← this file
```
