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

Duplicate PDFs are rejected through a two-layer strategy: a pre-download filename check skips already-known files before any download occurs, and a SHA-256 hash check catches content-identical PDFs re-sent under different filenames.

> Built as a real-world automation project to demonstrate backend engineering depth across browser automation, document parsing, relational database design, and scheduled task orchestration.

---

## Features

| Feature | Description |
| --- | --- |
| **WhatsApp PDF Retrieval** | Playwright drives WhatsApp Web to detect and download PDF attachments from a specified group |
| **Persistent Session** | Browser session state is preserved across restarts — no repeated QR scans |
| **Headless Execution** | Runs fully headless in server and CI environments |
| **Coordinate-aware PDF Parsing** | Python `pdfplumber` extracts table cells by physical position — no regex fragility |
| **Two-layer Duplicate Detection** | Pre-download filename check + post-download SHA-256 hash check |
| **Relational Schema** | 3 tables with 8 pre-built analytics views for drivers, routes, vehicles, and passengers |
| **Automated Scheduler** | Daily sync at a configurable time — fires at the same clock time every day |

---

## Architecture

```
WhatsApp Group
      │
      ▼
WhatsAppService (Playwright)
      │  async generator — yields one PDF at a time, newest first
      │
      ├─ Pre-download check (known filename? → skip, no download)
      │
      ▼
Download PDF
      │
      ├─ SHA-256 hash check (duplicate content? → skip insert)
      │
      ▼
Python subprocess: scripts/extract_pdf.py (pdfplumber)
      │  returns structured JSON: metadata, drivers[], passengers[]
      │
      ▼
PdfSyncService
      ├─ insert: flix_trips
      ├─ insert: trip_drivers
      └─ insert: trip_passengers
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
│   │   ├── pdf-sync.service.ts          # Orchestration — dedup + DB writes
│   │   ├── pdf-sync.controller.ts       # HTTP endpoints
│   │   ├── pdf-sync-scheduler.service.ts
│   │   ├── whatsapp.service.ts          # Playwright WhatsApp Web automation
│   │   └── pdf-parser.service.ts        # Python subprocess wrapper
│   ├── supabase/
│   │   └── supabase.service.ts
│   ├── monitor/
│   │   └── monitor.controller.ts
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

# false = show the browser window (useful for debugging)
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
| `GET` | `/pdf-sync/imports?limit=20` | Recent trip list |
| `POST` | `/pdf-sync/sync` | Trigger a WhatsApp scan manually |
| `POST` | `/pdf-sync/import-pdf` | Upload and import a PDF directly (multipart `file`) |
| `POST` | `/pdf-sync/test-parse` | Parse a PDF and return structured data without storing |

---

## Database Schema

Three tables, all in `public` schema:

```
flix_trips        — one row per imported PDF
trip_drivers      — one row per driver per trip  (FK → flix_trips)
trip_passengers   — one row per seat per trip    (FK → flix_trips)
```

**`flix_trips`**
```
id, bus_partner, plate, trip_date, departure_time, arrival_time,
departure, arrival, pdf_hash, source_filename, created_at
```

**`trip_drivers`**
```
id, trip_id, driver_name, role, phone, created_at
```

**`trip_passengers`**
```
id, trip_id, seat_no, passenger_name, phone, booking_source, created_at
```

**8 pre-built analytics views:**

| View | Answers |
| --- | --- |
| `v_trip_summary` | All trip details in one place |
| `v_driver_stats` | Trips, passengers, activity per driver |
| `v_driver_routes` | Which routes each driver operates |
| `v_vehicle_stats` | Trips and utilization per vehicle |
| `v_route_stats` | Most/least popular routes |
| `v_partner_stats` | Performance per bus partner |
| `v_monthly_trends` | Passenger volume by month and route |
| `v_repeat_passengers` | Passengers who have travelled more than once |

Full schema: [`supabase/schema.sql`](supabase/schema.sql)

---

## Duplicate Detection

```
Layer 1 — Pre-download (filename)
  WhatsApp UUID filename checked against known filenames in DB
  Match → skip without downloading

Layer 2 — Post-download (content)
  SHA-256 hash of PDF binary checked against flix_trips.pdf_hash
  Match → skip insert (catches re-forwarded PDFs with new filenames)
  Database UNIQUE constraint is a final safety net
```

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
- [ ] Webhook notifications (Slack/Telegram) on each successful import
- [ ] Admin dashboard for browsing and filtering passenger data
- [ ] Export endpoint — CSV/XLSX download
- [ ] Multi-group support
- [ ] Jest test suite + GitHub Actions CI

---

## License

This project is licensed under the [MIT License](LICENSE).

---

<p align="center">
  Built by <a href="https://github.com/your-username">Harikishor</a> &nbsp;·&nbsp;
  <a href="docs/ARCHITECTURE.md">Architecture</a>
</p>
