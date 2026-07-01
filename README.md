<h1 align="center">PDF Sync Automation Platform</h1>

<p align="center">
  <img src="https://img.shields.io/badge/NestJS-v11-E0234E?style=for-the-badge&logo=nestjs&logoColor=white" alt="NestJS" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Playwright-1.57-2EAD33?style=for-the-badge&logo=playwright&logoColor=white" alt="Playwright" />
  <img src="https://img.shields.io/badge/Python-pdfplumber-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white" alt="Supabase" />
  <img src="https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License" />
</p>

<p align="center">
  <strong>End-to-end automation pipeline that monitors a WhatsApp group, extracts passenger manifests from FlixBus PDFs, and stores structured data in a normalized analytics-ready database — fully unattended.</strong>
</p>

---

## Overview

PDF Sync is a **production-grade automation system** built with NestJS that eliminates the manual overhead of processing FlixBus passenger manifest PDFs shared over WhatsApp. The platform uses Playwright-driven WhatsApp Web automation to watch a designated group, intercepts PDF attachments as they arrive, parses them using a Python `pdfplumber` subprocess for coordinate-aware table extraction, and persists clean relational records to Supabase.

Incremental sync is driven by a **timestamp checkpoint**: each PDF's WhatsApp received-at time (IST) is stored alongside the trip data. On every subsequent sync, only PDFs sent after the last recorded timestamp are downloaded — messages older than the checkpoint are skipped entirely without browser interaction.

Duplicate PDFs are rejected through SHA-256 content hashing: if the same PDF is re-sent under a different filename, the hash catches it before any insert occurs. The `pdf_hash` column carries a UNIQUE constraint as a database-level safety net.

> Built as a real-world automation project to demonstrate backend engineering depth across browser automation, document parsing, relational database design, and scheduled task orchestration.

---

## Features

| Feature | Description |
| --- | --- |
| **WhatsApp PDF Retrieval** | Playwright drives WhatsApp Web to detect and download PDF attachments from a specified group |
| **Persistent Session** | Browser session state is preserved across restarts — no repeated QR scans |
| **Headless Execution** | Runs fully headless in server and CI environments |
| **Checkpoint-based Incremental Sync** | WhatsApp received-at timestamp (IST) used as a cursor — only PDFs newer than the last import are downloaded |
| **Coordinate-aware PDF Parsing** | Python `pdfplumber` extracts table cells by physical position — no regex fragility |
| **SHA-256 Deduplication** | Content hash checked before every insert; UNIQUE constraint is the database-level backstop |
| **Service ID Auto-fill** | When `line_number` is absent from the PDF, queries a `trips` table by vehicle number and travel date to fill it automatically |
| **Relational Schema** | 3 tables with 8 pre-built analytics views for drivers, routes, vehicles, and passengers |
| **Monitor Dashboard** | Live web dashboard at `/monitor` — sync status, environment check, live logs, recent imports table |
| **Automated Scheduler** | Daily sync at a configurable time — fires at the same clock time every day |

---

## Architecture

```
WhatsApp Group
      │
      ▼  1. Playwright opens WhatsApp Web (persistent session — no QR every time)
      │     Navigates to the configured group
      │
      ▼  2. Load the latest successfully imported WhatsApp timestamp
      │     (MAX(whatsapp_received_at)) from flix_trips.
      │     This acts as the synchronization checkpoint.
      │
      ▼  3. Scrolls upward until the checkpoint boundary becomes visible.
      │
      ▼  4. Processes messages in chronological order (oldest → newest)
      │     For each message:
      │       — Skip if no PDF attachment
      │       — Read the WhatsApp timestamp (time + date divider)
      │       — Skip if timestamp < checkpoint (already imported)
      │       — Download the PDF
      │
      ▼  5. SHA-256 hash the PDF bytes
      │     Already in DB? → skip (handles re-sends and boundary duplicates)
      │
      ▼  6. Python subprocess: scripts/extract_pdf.py (pdfplumber)
      │     Returns structured JSON: trip metadata, drivers[], passengers[]
      │
      ▼  7. Insert into Supabase:
      │       flix_trips           — one row per PDF (whatsapp_received_at stored as IST)
      │       flix_trip_drivers    — one row per driver
      │       flix_trip_passengers — one row per seat
      │
      ▼  8. If line_number is still null:
             Query trips table by vehicle_number + IST date range
             → fill line_number from service_id
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the reasoning behind every key decision.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| **Framework** | [NestJS](https://nestjs.com/) v11 |
| **Language** | TypeScript 5.7 |
| **Browser Automation** | [Playwright](https://playwright.dev/) v1.57 |
| **PDF Parsing** | Python 3 + [pdfplumber](https://github.com/jsvine/pdfplumber) (subprocess) |
| **Database** | [Supabase](https://supabase.com/) (PostgreSQL 15) via `@supabase/supabase-js` v2 |
| **Hashing** | Node.js built-in `crypto` — SHA-256 |
| **Scheduler** | Custom `setTimeout` loop targeting a daily clock time |
| **Config** | `@nestjs/config` with `.env` |
| **Runtime** | Node.js v22 |

---

## Folder Structure

```
pdf-sync-standalone/
├── src/
│   ├── app.module.ts
│   ├── main.ts
│   ├── pdf-sync/
│   │   ├── pdf-sync.module.ts
│   │   ├── pdf-sync.service.ts          # Orchestration — checkpoint, dedup, DB writes
│   │   ├── pdf-sync.controller.ts       # HTTP endpoints
│   │   ├── pdf-sync-scheduler.service.ts
│   │   ├── whatsapp.service.ts          # Playwright WhatsApp Web automation
│   │   └── pdf-parser.service.ts        # Python subprocess wrapper
│   ├── supabase/
│   │   └── supabase.service.ts
│   ├── monitor/
│   │   └── monitor.controller.ts        # Live dashboard at /monitor
│   └── common/
│       └── guards/api-key.guard.ts
│
├── scripts/
│   ├── extract_pdf.py                   # pdfplumber table extractor
│   └── requirements.txt                 # Python dependencies
│
├── supabase/
│   └── schema.sql                       # Complete schema — run once on a new project
│
├── docs/
│   └── ARCHITECTURE.md
│
├── .env.example
├── nest-cli.json
├── tsconfig.json
└── package.json
```

---

## Installation

**Prerequisites:** Node.js v18+, Python 3.8+, a Supabase project, and a WhatsApp account.

```bash
# 1. Clone the repository
git clone https://github.com/your-username/pdf-sync-standalone.git
cd pdf-sync-standalone

# 2. Install Node dependencies
npm install

# 3. Install Playwright browser
npx playwright install chromium

# 4. Install Python dependency
pip3 install pdfplumber

# 5. Configure environment variables
cp .env.example .env
# Edit .env with your Supabase credentials and WhatsApp group name

# 6. Apply the database schema
# Open Supabase SQL Editor → paste and run: supabase/schema.sql

# 7. Start the server
npm run start:dev
```

---

## Environment Variables

```env
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here

PDF_SYNC_WHATSAPP_GROUP=Your Group Name

# false = show the browser window (useful for first QR scan and debugging)
PDF_SYNC_HEADLESS=true

PDF_SYNC_SCHEDULER_ENABLED=true
PDF_SYNC_DAILY_TIME=03:00
```

| Variable | Required | Description |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key (bypasses RLS) |
| `PDF_SYNC_WHATSAPP_GROUP` | Yes | Exact display name of the WhatsApp group |
| `PDF_SYNC_HEADLESS` | No | `true` for servers, `false` to watch the browser |
| `PDF_SYNC_SCHEDULER_ENABLED` | No | Enable automatic daily sync (default: `true`) |
| `PDF_SYNC_DAILY_TIME` | No | Daily sync time in `HH:MM` format (default: `03:00`) |

---

## API Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/pdf-sync/health` | Supabase connectivity check |
| `GET` | `/pdf-sync/summary` | Total imports and last imported trip |
| `GET` | `/pdf-sync/imports?limit=20` | Recent trip list with line number, route, pax count, and IST received time |
| `POST` | `/pdf-sync/sync` | Trigger a WhatsApp scan manually |
| `POST` | `/pdf-sync/import-pdf` | Upload and import a PDF directly (multipart `file`) |
| `POST` | `/pdf-sync/test-parse` | Parse a PDF and return structured data without storing |
| `GET` | `/monitor` | Live HTML dashboard |

---

## Database Schema

Three tables, all in `public` schema:

```
flix_trips             — one row per imported PDF
flix_trip_drivers      — one row per driver per trip  (FK → flix_trips)
flix_trip_passengers   — one row per seat per trip    (FK → flix_trips)
```

**`flix_trips`**
```
id, line_number, bus_partner, vehicle_number,
trip_date, departure_time, arrival_time, departure, arrival,
pdf_hash, whatsapp_received_at, created_at
```

**`flix_trip_drivers`**
```
id, trip_id, driver_name, role, phone
```

**`flix_trip_passengers`**
```
id, trip_id, seat_no, passenger_name, phone, booking_source
```

**8 pre-built analytics views:**

| View | Answers |
| --- | --- |
| `v_flix_trip_summary` | All trip fields + passenger count — used by the monitor dashboard |
| `v_flix_driver_stats` | Trips, passengers, activity per driver |
| `v_flix_driver_routes` | Which routes each driver operates |
| `v_flix_vehicle_stats` | Trips and utilization per vehicle |
| `v_flix_route_stats` | Most/least popular routes |
| `v_flix_partner_stats` | Performance per bus partner |
| `v_flix_monthly_trends` | Passenger volume by month and route |
| `v_flix_repeat_passengers` | Passengers who have travelled more than once |

Full schema: [`supabase/schema.sql`](supabase/schema.sql)

---

## Checkpoint-based Sync

```
First sync (no checkpoint):
  Scrolls upward as far as possible → imports all PDFs found → stores IST timestamps

Subsequent syncs (checkpoint = MAX(whatsapp_received_at) from flix_trips):
  Loads the synchronization checkpoint
  Scrolls upward until the checkpoint boundary becomes visible
  Processes messages in chronological order (oldest → newest)
  Skips messages older than the checkpoint — no download, no browser interaction
  Hash dedup catches re-sent duplicates at the boundary
```

If a PDF fails to parse mid-run, the checkpoint stays at the last successfully stored entry — so the next sync automatically retries from there.

---

## WhatsApp Session

```
First run   →  QR code displayed  →  scan with phone  →  session saved to .runtime/
Subsequent  →  session loaded from disk  →  no QR required
```

Set `PDF_SYNC_HEADLESS=false` to watch the browser and debug selector issues.

---

## Future Improvements

- [ ] Docker + Docker Compose for one-command deployment
- [ ] Multi-group support (multiple WhatsApp groups, per-group checkpoints)
- [ ] Webhook notifications (Slack/Telegram) on each successful import
- [ ] Export endpoint — CSV/XLSX download
- [ ] Jest test suite + GitHub Actions CI

---

## License

This project is licensed under the [MIT License](LICENSE).

---

<p align="center">
  Built by <a href="https://github.com/your-username">Harikishor</a> &nbsp;·&nbsp;
  <a href="docs/ARCHITECTURE.md">Architecture</a>
</p>
