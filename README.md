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

The normalized star schema unlocks analytics queries — driver performance, route trends, vehicle utilization, repeat passengers — that a flat table makes impossible.

> Built as a real-world automation project to demonstrate backend engineering depth across browser automation, document parsing, relational database design, and scheduled task orchestration.

---

## Features

| Feature | Description |
| --- | --- |
| **WhatsApp PDF Retrieval** | Playwright drives WhatsApp Web to detect and download PDF attachments from a specified group |
| **Persistent Session** | Browser session state is preserved across restarts — no repeated QR scans |
| **Headless Execution** | Runs fully headless in server and CI environments |
| **Coordinate-aware PDF Parsing** | Python `pdfplumber` extracts table cells by physical position — no regex fragility from flattened text |
| **Two-layer Duplicate Detection** | Pre-download filename check + post-download SHA-256 hash check |
| **Normalized Star Schema** | 8 relational tables: trips, drivers, vehicles, routes, passengers, partners |
| **8 Analytics Views** | Pre-built SQL views for driver stats, route trends, vehicle utilization, repeat passengers |
| **Supabase Integration** | Structured records stored in typed PostgreSQL via `@supabase/supabase-js` v2 |
| **Automated Scheduler** | Daily sync at a configurable time — no fixed interval, fires at the same clock time daily |

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
PdfSyncService — relational upserts
      │
      ├─ upsert: bus_partners, routes, vehicles, drivers, booking_sources
      │
      ├─ insert: trips (FK to all dimensions)
      │
      └─ insert: trip_drivers, trip_passengers (bridge tables)
```

The async generator pattern lets the orchestrator stop mid-scan after 2 consecutive duplicates — without having to download every PDF first.

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
│   │
│   ├── pdf-sync/
│   │   ├── pdf-sync.module.ts
│   │   ├── pdf-sync.service.ts          # Orchestration — dedup + relational writes
│   │   ├── pdf-sync.controller.ts       # HTTP endpoints
│   │   ├── pdf-sync-scheduler.service.ts
│   │   ├── whatsapp.service.ts          # Playwright WhatsApp Web automation
│   │   └── pdf-parser.service.ts        # Python subprocess wrapper
│   │
│   ├── supabase/
│   │   └── supabase.service.ts
│   │
│   ├── monitor/
│   │   └── monitor.controller.ts
│   │
│   └── common/
│
├── scripts/
│   └── extract_pdf.py                   # pdfplumber table extractor
│
├── supabase/
│   ├── schema.sql                       # Complete schema — safe to re-run on a fresh project
│   └── migrations/
│       ├── 001_initial.sql
│       ├── ...
│       └── 006_analytics_schema.sql     # Star schema + 8 analytics views
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

# 3. Install Playwright browser (Chromium for WhatsApp Web)
npx playwright install chromium

# 4. Install Python dependency
pip3 install pdfplumber

# 5. Configure environment variables
cp .env.example .env
# Edit .env with your Supabase URL, service role key, and WhatsApp group name

# 6. Apply the database schema
# Open Supabase SQL Editor and run: supabase/schema.sql

# 7. Start in development mode
npm run start:dev
```

---

## Environment Variables

```env
# ── Supabase ──────────────────────────────────────────────
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here

# ── WhatsApp Automation ────────────────────────────────────
PDF_SYNC_WHATSAPP_GROUP=Your Group Name

# ── Browser ───────────────────────────────────────────────
# false = show the browser window (useful for debugging)
PDF_SYNC_HEADLESS=true

# ── Scheduler ─────────────────────────────────────────────
PDF_SYNC_SCHEDULER_ENABLED=true
PDF_SYNC_DAILY_TIME=03:00
```

| Variable | Required | Description |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key (bypasses RLS for server-side writes) |
| `PDF_SYNC_WHATSAPP_GROUP` | Yes | Exact display name of the WhatsApp group to monitor |
| `PDF_SYNC_HEADLESS` | No | `true` for server deployments, `false` to watch the browser |
| `PDF_SYNC_SCHEDULER_ENABLED` | No | Enables automatic daily sync (default: `true`) |
| `PDF_SYNC_DAILY_TIME` | No | Daily sync time in `HH:MM` format (default: `03:00`) |

---

## API Endpoints

All endpoints are prefixed with `/pdf-sync`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/pdf-sync/health` | Supabase connectivity check |
| `GET` | `/pdf-sync/summary` | Total imports and last imported trip |
| `GET` | `/pdf-sync/imports?limit=20` | Recent trip list from the database |
| `POST` | `/pdf-sync/sync` | Trigger a WhatsApp scan manually |
| `POST` | `/pdf-sync/import-pdf` | Upload and import a PDF directly (multipart `file`) |
| `POST` | `/pdf-sync/test-parse` | Parse a PDF and return the result without storing it |

---

## Database Schema

The database uses a **normalized star schema** optimized for analytics.

```
bus_partners ─┐
routes        ─┤
vehicles      ─┼──→ trips ──→ trip_drivers   ──→ drivers
booking_sources┘         └──→ trip_passengers ──→ booking_sources
```

**8 pre-built analytics views:**

| View | Answers |
| --- | --- |
| `v_trip_summary` | Full trip details for dashboards |
| `v_driver_stats` | Trips, passengers, date range per driver |
| `v_driver_routes` | Which routes each driver operates |
| `v_vehicle_stats` | Trips and utilization per vehicle |
| `v_route_stats` | Most/least popular routes |
| `v_partner_stats` | Performance per bus partner |
| `v_monthly_trends` | Passenger volume by month and route |
| `v_repeat_passengers` | Passengers who have travelled more than once |

Example queries:

```sql
-- Driver leaderboard
SELECT name, total_trips, total_passengers FROM v_driver_stats ORDER BY total_trips DESC;

-- Busiest routes
SELECT departure, arrival, total_passengers FROM v_route_stats ORDER BY total_passengers DESC;

-- Monthly passenger trend
SELECT month, departure, arrival, passengers FROM v_monthly_trends;
```

Full schema: [`supabase/schema.sql`](supabase/schema.sql)

---

## Duplicate Detection

Every PDF passes through two independent checks:

```
Layer 1 — Pre-download (filename)
  WhatsApp UUID filename loaded into a Set at sync start
  Known filename → skip without downloading

Layer 2 — Post-download (content)
  SHA-256 hash of PDF binary checked against trips.pdf_hash
  Known hash → skip insert (catches re-forwarded PDFs with new filenames)
  Database UNIQUE constraint is a final safety net
```

---

## WhatsApp Session Management

```
First run   →  QR code displayed  →  scan with phone  →  session saved to .runtime/
Subsequent  →  session loaded from disk  →  no QR required
```

Set `PDF_SYNC_HEADLESS=false` to watch the browser and debug selector issues.

In Docker, volume-mount the `.runtime/` directory so the session survives container restarts.

---

## Future Improvements

- [ ] Docker + Docker Compose for one-command deployment
- [ ] Webhook notifications (Slack/Telegram) on each successful import
- [ ] Admin UI — CRUD dashboard for browsing and filtering passenger data
- [ ] Export endpoint — CSV/XLSX download of filtered records
- [ ] Multi-group support — monitor multiple WhatsApp groups
- [ ] Jest unit and integration test suite
- [ ] GitHub Actions CI pipeline (lint → build → test)

---

## License

This project is licensed under the [MIT License](LICENSE).

---

<p align="center">
  Built by <a href="https://github.com/your-username">Harikishor</a> &nbsp;·&nbsp;
  <a href="docs/ARCHITECTURE.md">Architecture</a>
</p>
