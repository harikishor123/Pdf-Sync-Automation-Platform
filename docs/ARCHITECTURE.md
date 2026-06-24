# Architecture

PDF Sync automates a manual daily workflow: a FlixBus operations manager receives passenger manifest PDFs in a WhatsApp group and previously had to download each one and enter the data by hand. This system monitors the group, downloads new PDFs, parses them, and stores structured data in Supabase — fully unattended.

---

## System Flow

```
WhatsApp Web (Playwright)
        │
        │  async generator — yields one PDF at a time
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
  Python subprocess (pdfplumber)
        │
        ▼
  Supabase insert
```

The async generator pattern (`streamPdfsNewestFirst`) lets the orchestrator control the scan — it can stop mid-stream after N consecutive duplicates without downloading everything first.

---

## Key Design Decisions

### 1. Playwright persistent context over WhatsApp API

WhatsApp's official Business API requires approval and costs money. The Cloud API has rate limits and doesn't give access to group history. Playwright with a persistent browser context (saved to `.runtime/`) lets the system authenticate once via QR scan and then operate as a real browser session indefinitely — no approval, no fees, no message-count limits.

The tradeoff: WhatsApp Web uses a virtual DOM and only renders messages near the current scroll position. The `scrollUpToRevealPDFs()` method handles this by scrolling upward in 1500px steps (up to 10 steps) and stopping once the first PDF card appears in the DOM.

### 2. Two-layer duplicate detection

Every PDF gets checked twice:

**Layer 1 — filename pre-check (before download):**  
WhatsApp assigns a UUID filename to each file at send time. The system loads all known `source_filename` values from the DB into a Set at sync start and skips any card whose filename is already known — no download needed.

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
**Interface**: takes a file path as argv[1], returns JSON to stdout matching `FlixBusParsed`.

### 5. `parseFile()` vs `parse(buffer)`

Downloaded PDFs already exist on disk (Playwright writes them to `.runtime/downloads/`). Passing the file path directly to the Python script avoids writing a redundant temp file. Uploaded PDFs (the manual import API endpoint) arrive as buffers and write a temp file that's cleaned up in a `finally` block.

---

## Data Model

```sql
flixbus_data (
  id              uuid  PRIMARY KEY
  bus_partner     text              -- "Divya Enterprises"
  plate           text              -- "MH49CW1053"
  date            date              -- trip date
  departure_time  time
  arrival_time    time
  departure       text              -- "Hyderabad"
  arrival         text              -- "Pune"
  driver_details  jsonb             -- [{driver_name, role, phone}]
  seat_details    jsonb             -- [{seat_no, name, phone, shop}]
  pdf_hash        text  UNIQUE      -- SHA-256, authoritative dedup
  source_filename text  UNIQUE      -- WhatsApp UUID, fast pre-check
  created_at      timestamptz
)
```

`driver_details` and `seat_details` are JSONB arrays. The schema of each manifest is stable enough that a relational approach would add complexity without benefit — and JSONB still allows querying into the arrays if needed.

Row Level Security is enabled with no policies, so the table is inaccessible to anon/authenticated roles. The backend uses the service role key which bypasses RLS entirely.

---

## Scheduler

The sync can be triggered manually via `POST /pdf-sync/sync` or runs automatically at a configured daily time (`PDF_SYNC_DAILY_TIME` env var). The scheduler uses a `setTimeout` loop that targets the next occurrence of that time each day, rather than a fixed interval — so it fires at the same clock time regardless of how long the previous run took.

---

## Project Structure

```
src/
  pdf-sync/
    pdf-sync.service.ts     ← orchestration, duplicate logic
    pdf-sync.controller.ts  ← HTTP endpoints
    pdf-parser.service.ts   ← subprocess wrapper
    whatsapp.service.ts     ← Playwright automation
  supabase/
    supabase.service.ts     ← Supabase client
  monitor/
    monitor.controller.ts   ← health / status endpoints
  common/
    scheduler.service.ts    ← daily time scheduler

scripts/
  extract_pdf.py            ← pdfplumber table extractor

supabase/
  schema.sql                ← full schema, safe to re-run
  migrations/               ← incremental migrations
```
