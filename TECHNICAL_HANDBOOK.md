# PDF Sync — Technical Handbook

> Official developer reference for the `pdf-sync-standalone` project.
> Written for the future maintainer who has never seen this codebase before.

---

# 1. Project Overview

## What Problem This Solves

FlixBus bus operators receive passenger manifest PDFs in a shared WhatsApp group. These PDFs contain the complete passenger list for every trip: who is traveling, which seat they booked, which platform they booked through, and contact phone numbers for each passenger and driver.

Manually downloading each PDF, opening it, and reading the data is slow and error-prone. If someone misses a PDF or downloads the wrong version, operations break down.

This project automates the entire pipeline: it watches the WhatsApp group, downloads every new PDF, extracts all structured data from it, and stores it in a Supabase database — all without a human touching the file.

## End-to-End Workflow

```
WhatsApp Group ("Pdf sync")
        │
        │  Playwright opens WhatsApp Web in Chromium
        │  Searches for the group by name
        │  Scans visible PDF attachments newest → oldest
        ▼
PDF Download (Playwright saves to .runtime/pdf-sync/downloads/)
        │
        │  readFileSync() loads the file into a Buffer
        ▼
SHA-256 Hash Generation (crypto.createHash)
        │
        │  Hash is checked against pdf_hash column in flixbus_data
        ▼
Duplicate Detection (Supabase SELECT WHERE pdf_hash = ?)
        │  ├── DUPLICATE → skip, break scan loop, close browser
        │  └── NEW → continue
        ▼
PDF Parsing — pdf-parse extracts raw text
        │
        ▼
Text Normalization (normalizeText)
        │  Fixes missing spaces caused by PDF column layout:
        │  "MH49CW0841Date" → "MH49CW0841\nDate"
        │  "HyderabadArrival" → "Hyderabad\nArrival"
        │  "1DVenkatesh" → "1D Venkatesh"
        ▼
Field Extraction (parseText — regex matching on normalized lines)
        │  Extracts: plate, date, times, cities, drivers, seats
        ▼
Supabase INSERT into public.flixbus_data
        │
        ▼
Monitor Dashboard (GET /monitor)
        Displays imported rows, passenger counts, route, sync status
```

## Technology Stack

| Layer              | Technology            | Why                                                |
| ------------------ | --------------------- | -------------------------------------------------- |
| Backend framework  | NestJS v11            | Structured DI, decorators, lifecycle hooks         |
| Language           | TypeScript 5.7        | Type safety across all services                    |
| Database           | Supabase (PostgreSQL) | Hosted Postgres + REST client, no server to manage |
| Browser automation | Playwright 1.57       | Reliable cross-browser DOM automation              |
| PDF extraction     | pdf-parse 1.1.1       | Pure Node.js, no binary deps                       |
| Config             | @nestjs/config        | `.env` file loaded at boot                         |
| Auth guard         | Custom ApiKeyGuard    | Static API key via `X-API-Key` header              |

---

# 2. Folder Structure

```
pdf-sync-standalone 3/
│
├── src/                              Application source code
│   ├── main.ts                       Entry point — bootstraps NestJS
│   ├── app.module.ts                 Root module — wires together all modules
│   │
│   ├── common/
│   │   └── guards/
│   │       └── api-key.guard.ts      HTTP guard — validates X-API-Key header
│   │
│   ├── supabase/
│   │   ├── supabase.module.ts        Global module — exports SupabaseService everywhere
│   │   └── supabase.service.ts       Creates and exposes the Supabase client singleton
│   │
│   ├── monitor/
│   │   └── monitor.controller.ts     Serves the HTML dashboard at GET /monitor
│   │
│   └── pdf-sync/
│       ├── pdf-sync.module.ts        Feature module — registers all PDF sync providers
│       ├── pdf-sync.controller.ts    HTTP layer — exposes all /pdf-sync/* endpoints
│       ├── pdf-sync.service.ts       Orchestrator — coordinates parser, WhatsApp, Supabase
│       ├── pdf-parser.service.ts     PDF parsing engine — normalize + extract
│       ├── whatsapp.service.ts       Playwright automation — browser session + download
│       └── pdf-sync-scheduler.service.ts  Daily cron — auto-triggers sync at configured time
│
├── supabase/
│   ├── setup_fresh.sql               Run once on a new project to create schema
│   └── migrations/
│       ├── 001_create_pdf_sync.sql   Legacy — original 5-table schema (now dropped)
│       ├── 003_create_flixbus_tables.sql  Legacy — intermediate schema (now dropped)
│       └── 004_replace_with_flixbus_data.sql  CURRENT — single-table FlixBus schema
│
├── debug/
│   ├── raw-text.txt                  Written on every parse — raw pdf-parse output
│   └── normalized-text.txt           Written on every parse — after normalizeText()
│
├── .runtime/
│   └── pdf-sync/
│       ├── whatsapp-session/         Playwright persistent browser profile (cookies, localStorage)
│       └── downloads/                Staging directory for downloaded PDFs
│
├── .env                              Environment variables (never commit)
├── package.json                      Dependencies and npm scripts
└── tsconfig.json                     TypeScript compiler config
```

### File-by-file responsibilities

**`src/main.ts`**
The Node.js entry point. Calls `NestFactory.create(AppModule)`, attaches a global `ValidationPipe` (strips unknown fields, auto-transforms types), and starts listening on `PORT` (default 3000). Nothing else belongs here.

**`src/app.module.ts`**
Root module. Imports `ConfigModule` (global, loads `.env`), `SupabaseModule` (global, singleton client), and `PdfSyncModule` (the feature). Also directly registers `MonitorController` because the monitor is a standalone controller not part of any feature module.

**`src/common/guards/api-key.guard.ts`**
NestJS guard applied to all `PdfSyncController` endpoints. Reads `PDF_SYNC_API_KEY` from config. If the env var is not set, it passes all requests (dev mode). If set, it requires the key in the `X-API-Key` header or `Authorization: Bearer <key>`. Returns `401 Unauthorized` otherwise.

**`src/supabase/supabase.module.ts`**
Marked `@Global()`. This means `SupabaseService` is available anywhere in the application without re-importing the module. Exports only `SupabaseService`.

**`src/supabase/supabase.service.ts`**
Creates a single `SupabaseClient` at startup using the service role key. The service role key bypasses Row Level Security — the backend has full read/write access. `auth.autoRefreshToken` and `auth.persistSession` are both false because server-side code does not need token refresh or session persistence (it always uses the static service role key).

**`src/monitor/monitor.controller.ts`**
Contains a single `GET /monitor` endpoint. Returns a self-contained HTML string (inline CSS + vanilla JavaScript). No templating engine, no frontend framework, no build step. The HTML file is stored as a TypeScript template literal `DASHBOARD_HTML` inside the file itself.

**`src/pdf-sync/pdf-sync.module.ts`**
Feature module. Imports `ConfigModule` and `SupabaseModule`. Registers `PdfSyncController` plus five providers: `ApiKeyGuard`, `PdfSyncService`, `PdfParserService`, `WhatsAppService`, `PdfSyncSchedulerService`.

**`src/pdf-sync/pdf-sync.controller.ts`**
Thin HTTP layer. All six endpoints delegate immediately to `PdfSyncService`. Uses `@UseGuards(ApiKeyGuard)` at the class level so all routes are guarded. Uses `FileInterceptor` for the two upload endpoints (Multer handles multipart parsing, stores file in memory).

**`src/pdf-sync/pdf-sync.service.ts`**
The main orchestrator. Holds the core import pipeline: hash → duplicate check → parse → insert. Also implements the three data-reading methods (`getSummary`, `getImports`, `checkHealth`) that feed the dashboard.

**`src/pdf-sync/pdf-parser.service.ts`**
Pure parsing logic. Two public entry points: `parse(buffer)` (async, calls pdf-parse then normalizes), and `parseText(text)` (synchronous, regex-based field extraction from normalized lines). The normalization stage is `normalizeText()` (private). Debug files are written by `saveDebug()` (private).

**`src/pdf-sync/whatsapp.service.ts`**
Playwright browser automation. One public method: `streamPdfsNewestFirst()` which is an `AsyncGenerator`. It launches a persistent Chromium profile, navigates to WhatsApp Web, searches for the configured group, and yields one downloaded PDF at a time starting from the newest. The generator's `finally` block always closes the browser, even if the consumer breaks early.

**`src/pdf-sync/pdf-sync-scheduler.service.ts`**
Implements `OnModuleInit` and `OnModuleDestroy`. At module init, if `PDF_SYNC_SCHEDULER_ENABLED=true`, it schedules a `setTimeout` that fires once daily at the configured `PDF_SYNC_DAILY_TIME`. After each run it reschedules itself. On module destroy, it clears the pending timeout to prevent memory leaks or stale timers during hot-reload.

---

# 3. Backend Architecture

## Module hierarchy

```
AppModule
├── ConfigModule (global)          @nestjs/config — loads .env
├── SupabaseModule (global)        provides SupabaseService everywhere
├── PdfSyncModule                  feature module
│   ├── PdfSyncController          HTTP routes
│   ├── PdfSyncService             orchestrator
│   ├── PdfParserService           PDF text extraction
│   ├── WhatsAppService            Playwright browser
│   └── PdfSyncSchedulerService    daily cron
└── MonitorController              standalone dashboard
```

## Dependency Injection graph

```
PdfSyncController
  └── PdfSyncService
        ├── SupabaseService        (from SupabaseModule, global)
        ├── ConfigService          (from ConfigModule, global)
        ├── PdfParserService
        │     (no dependencies)
        └── WhatsAppService
              └── ConfigService

PdfSyncSchedulerService
  ├── ConfigService
  └── PdfSyncService

ApiKeyGuard
  └── ConfigService

MonitorController
  (no dependencies — returns static HTML)
```

## Controller layer

`PdfSyncController` is a pure HTTP adapter. It:

- Accepts HTTP requests
- Extracts inputs (query params, uploaded files)
- Calls one `PdfSyncService` method
- Returns the result (NestJS serialises it to JSON automatically)

It contains zero business logic.

## Service layer

`PdfSyncService` is the single source of truth for the pipeline. It does not know about HTTP — it only works with Buffers, strings, and Supabase. If you wanted to replace the HTTP layer with a CLI script, `PdfSyncService` would work unchanged.

`PdfParserService` is stateless. Every method call is independent. It holds no state between calls.

`WhatsAppService` is stateless between calls. Each call to `streamPdfsNewestFirst()` launches a fresh browser context, uses the persisted session, and closes the context on completion.

## Supabase layer

`SupabaseService.getClient()` returns the same `SupabaseClient` instance on every call (singleton). The client uses the service role key which means:

- Row Level Security is bypassed automatically
- No authentication step is needed before each request
- The client has full read/write/delete access to all tables

---

# 4. API Endpoints

All `/pdf-sync/*` endpoints require the `X-API-Key` header if `PDF_SYNC_API_KEY` is set in `.env`. If the env var is absent, all requests are open (development mode). The `/monitor` endpoint is always unguarded.

---

## GET /pdf-sync/summary

**Purpose:** Returns aggregate status for the dashboard's "Sync Status" card.

**Request:** No body, no query params.

**Response:**

```json
{
  "syncStatus": "idle",
  "lastSyncTime": "2026-06-16T12:45:00.000Z",
  "pdfsImported": 42,
  "lastImportedPdf": "Divya Enterprises · MH49CW0841 · 2026-06-16",
  "whatsappGroup": "Pdf sync"
}
```

**Code path:**

```
PdfSyncController.getSummary()
  → PdfSyncService.getSummary()
      → supabase.from('flixbus_data').select('id', { count: 'exact', head: true })
      → supabase.from('flixbus_data').select('bus_partner, plate, date, created_at').order('created_at').limit(1)
      → returns combined object
```

**Database operations:** Two parallel Supabase SELECT queries (COUNT and most-recent row).

**Sequence:**

```
Browser (dashboard)
  │  GET /pdf-sync/summary
  ▼
PdfSyncController.getSummary()
  │
  ▼
PdfSyncService.getSummary()
  │  Promise.all([count query, last row query])
  ▼
Supabase: flixbus_data
  │  returns count + last row
  ▼
PdfSyncService assembles response object
  │
  ▼
HTTP 200 JSON response to browser
```

---

## GET /pdf-sync/imports

**Purpose:** Returns a paginated list of recent imports for the "Recent Imports" table.

**Request:** Optional query param `?limit=20` (max 100, default 20).

**Response:**

```json
[
  {
    "id": "uuid",
    "bus_partner": "Divya Enterprises",
    "plate": "MH49CW0841",
    "date": "2026-06-16",
    "departure": "Hyderabad",
    "arrival": "Pune",
    "passenger_count": 8,
    "created_at": "2026-06-16T12:45:00.000Z"
  }
]
```

**Code path:**

```
PdfSyncController.getImports(limit)
  → PdfSyncService.getImports(20)
      → supabase SELECT id, bus_partner, plate, date, departure, arrival, seat_details, created_at
      → maps each row: passenger_count = seat_details.length
      → returns array
```

**Database operations:** Single SELECT with ORDER BY created_at DESC LIMIT n.

Note: `seat_details` is fetched only to compute `passenger_count`. The full JSONB is not returned to the client.

---

## GET /pdf-sync/health

**Purpose:** Checks if all external dependencies are reachable. Used by the "Environment Check" card.

**Request:** Nothing.

**Response:**

```json
{
  "backend": true,
  "supabase": true,
  "whatsappGroupConfigured": true,
  "whatsappGroup": "Pdf sync"
}
```

**Code path:**

```
PdfSyncController.checkHealth()
  → PdfSyncService.checkHealth()
      → supabase.from('flixbus_data').select('id', { head: true })  (silent catch on error)
      → configService.get('PDF_SYNC_WHATSAPP_GROUP')
      → assembles result
```

**Database operations:** One lightweight HEAD SELECT (fetches no rows, just checks connectivity).

---

## POST /pdf-sync/test-parse

**Purpose:** Parse a PDF without inserting it into the database. Used for debugging the parser.

**Request:** `multipart/form-data`, field name `file`, containing a PDF file (max 20 MB).

**Response:**

```json
{
  "pdfName": "flixbus-manifest.pdf",
  "pdfHash": "abc123...",
  "parsed": {
    "bus_partner": "Divya Enterprises",
    "plate": "MH49CW0841",
    "date": "2026-06-16",
    "departure_time": "18:00:00",
    "arrival_time": "09:35:00",
    "departure": "Hyderabad",
    "arrival": "Pune",
    "driver_details": [],
    "seat_details": [
      {
        "seat_no": "1D",
        "name": "Venkatesh Vasamsetty",
        "phone": "+919491689434",
        "shop": "Redbus"
      }
    ]
  }
}
```

**Code path:**

```
PdfSyncController.testParse(file)
  → FileInterceptor (Multer) reads multipart body, stores file in memory
  → PdfSyncService.testParsePdf(file)
      → validateUploadedPdf(file)      checks .pdf extension / mime type
      → hashBuffer(buffer)             SHA-256 of file bytes
      → PdfParserService.parse(buffer) full parse pipeline
      → returns { pdfName, pdfHash, parsed }
```

**Database operations:** None. This endpoint is read-only and does not touch Supabase.

---

## POST /pdf-sync/import-pdf

**Purpose:** Parse a PDF and insert it into Supabase. Manual import without WhatsApp.

**Request:** Same as `test-parse` — `multipart/form-data` with field `file`.

**Response (new import):**

```json
{ "status": "imported", "id": "uuid", "pdfName": "manifest.pdf", "parsed": { ... } }
```

**Response (duplicate):**

```json
{ "status": "duplicate", "id": "existing-uuid", "pdfName": "manifest.pdf" }
```

**Code path:**

```
PdfSyncController.importPdf(file)
  → PdfSyncService.importUploadedPdf(file)
      → validateUploadedPdf(file)
      → importPdfBuffer(buffer, filename)
          → hashBuffer(buffer)
          → supabase SELECT WHERE pdf_hash = hash   (duplicate check)
          → if duplicate: return { status: 'duplicate' }
          → PdfParserService.parse(buffer)
          → supabase INSERT into flixbus_data
          → return { status: 'imported', id }
```

**Database operations:** SELECT (duplicate check) + INSERT (if new).

---

## POST /pdf-sync/sync

**Purpose:** Trigger the full WhatsApp automation pipeline. This is the main operation.

**Request:** No body.

**Response:**

```json
{
  "scanned": 3,
  "imported": 2,
  "skipped": 1,
  "results": [
    { "status": "imported", "id": "uuid1", "pdfName": "manifest1.pdf" },
    { "status": "imported", "id": "uuid2", "pdfName": "manifest2.pdf" },
    { "status": "duplicate", "id": "uuid3", "pdfName": "manifest3.pdf" }
  ]
}
```

**Code path:** See Section 10 for the detailed step-by-step walkthrough.

**Database operations:** Per-PDF: one SELECT (duplicate check) + one INSERT (if new).

---

# 5. WhatsApp Automation

## Why Playwright

WhatsApp does not provide a public API for reading group messages or downloading attachments. The only programmatic option is to automate the WhatsApp Web browser interface. Playwright was chosen because:

- It supports persistent browser contexts (saves login session between runs)
- It has a reliable download API (`context.waitForEvent('download')`)
- It handles JavaScript-heavy SPAs like WhatsApp Web correctly
- It runs Chromium without needing a system Chrome installation

## How `launchPersistentContext` Works

Normal Playwright contexts are ephemeral — they start fresh every time and discard all cookies, localStorage, and IndexedDB when closed.

`chromium.launchPersistentContext(sessionDir, options)` is different. It creates a real Chromium user profile directory at `sessionDir`. Everything the browser stores — cookies, localStorage, IndexedDB, cache — is written to disk in this directory. On the next launch, the same directory is loaded, so the browser restores exactly where it left off.

For WhatsApp Web, this means the authentication token (stored in IndexedDB and localStorage) survives between NestJS restarts. You scan the QR code once; every subsequent run reuses the stored session.

## Session Persistence

Session data location: `.runtime/pdf-sync/whatsapp-session/Default/`

Key subdirectories:

- `Local Storage/` — WhatsApp's primary auth token storage
- `IndexedDB/` — message cache and keys
- `Cookies` — session cookies
- `Session Storage/` — transient UI state

The session directory path is configured via `PDF_SYNC_WHATSAPP_SESSION_DIR` in `.env`. If the env var is absent, the default path `.runtime/pdf-sync/whatsapp-session` is used.

Important: `PDF_SYNC_SESSION_DIR` (without `WHATSAPP_`) is a different env var name. The code reads `PDF_SYNC_WHATSAPP_SESSION_DIR`. If you put `PDF_SYNC_SESSION_DIR` in `.env`, it will be silently ignored and the default path is used.

## Why Headless=true Originally Failed

When a browser runs in headless mode, Chromium sets `navigator.webdriver = true` in the JavaScript environment. WhatsApp Web checks this property as part of its bot detection. If it detects automation, it shows the QR code login screen even when a valid session exists in the profile directory — effectively forcing re-authentication on every run.

This means: QR code scanned in non-headless mode → session saved → switch to headless → WhatsApp detects automation → shows QR again → authentication error.

## The Fix Applied

Two changes were made to `launchPersistentContext`:

```typescript
// 1. Add Chromium flags to suppress automation detection
args: [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
],

// 2. Match a real Chrome user-agent string
userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
```

And immediately after context creation:

```typescript
// 3. Remove navigator.webdriver from the JavaScript environment
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});
```

`addInitScript` runs before any page script executes, so WhatsApp's bot detection never sees the `webdriver` property.

## Authentication Flow

```
First run (PDF_SYNC_HEADLESS=false):
  1. Chromium opens visibly
  2. WhatsApp Web loads, detects no session → shows QR code
  3. User scans QR on phone
  4. WhatsApp Web authenticates → chat list appears
  5. Session tokens written to .runtime/pdf-sync/whatsapp-session/Default/
  6. Browser closes (context.close() in finally block)

Subsequent runs (PDF_SYNC_HEADLESS=true):
  1. Chromium launches headless with automation flags suppressed
  2. WhatsApp Web loads, finds session in profile dir → chat list appears directly
  3. No QR code shown
  4. Pipeline continues to group search
```

## Group Search Process

```
1. waitForSelector('div[data-testid="chat-list"]')   — confirm logged in
2. Locate search input by multiple selector fallbacks
3. searchBox.fill(groupName)                          — type group name
4. waitForSelector('div[aria-label="Search results."] div[role="row"]')
5. Find span[title="${groupName}"]                    — exact name match
6. Click matching result
7. waitForSelector('header div[role="button"] span[title]')  — confirm group opened
8. waitForTimeout(2000)                               — let message list render
```

## PDF Download Process

```
1. page.locator('div[data-testid="document-thumb"]').count()
   — counts all PDF attachment cards visible in the chat

2. Loop from last index (newest) to 0 (oldest):
   a. pdfCard.scrollIntoViewIfNeeded()   — scroll card into view
   b. context.waitForEvent('download', timeout: 5000).catch(() => null)
      — arm download listener BEFORE clicking
   c. pdfCard.click()                   — click the card
   d. If download fires immediately → save it
   e. If not → overlay opened → try download button selectors:
      '[aria-label="Download"]'
      '[data-testid="media-download-btn"]'
      '[data-icon="media-download"]'
      etc.
   f. download.saveAs(filePath)         — write to downloads dir
   g. yield { filePath, pdfName }       — pass to consumer
   h. page.keyboard.press('Escape')     — close overlay before next card

3. Consumer (PdfSyncService) receives each PDF, processes it,
   and breaks the loop when it sees a duplicate hash.
   The generator's finally block closes the browser.
```

---

# 6. PDF Parsing Engine

## pdf-parse Library

`pdf-parse` (npm) extracts the raw text content from a PDF binary buffer. It does not perform OCR — it reads the text layer that PDF authoring tools embed in the file. Most FlixBus manifests are generated by software and contain a proper text layer.

The library returns an object with a `text` property. This is a single string containing all visible text from all pages of the PDF, separated by newlines.

## Why FlixBus PDFs Originally Failed

FlixBus manifests use a **multi-column table layout**. The PDF format stores text in independent "text objects" — one per table cell. When `pdf-parse` flattens these into a single string, it concatenates adjacent cells with no separator between them.

The result is that text from different columns runs together on a single line:

```
ORIGINAL TEXT FROM PDF (what you see visually):
  ┌────────────────┬───────────────┬──────────────────┬───────────────┐
  │ Plate          │ Date          │ Departure Time   │ Arrival Time  │
  │ MH49CW0841     │ 16.06.2026    │ 18:00            │ 09:35         │
  └────────────────┴───────────────┴──────────────────┴───────────────┘

WHAT pdf-parse EXTRACTED (one line, no spaces between cells):
  "Plate MH49CW0841Date 16.06.2026Departure Time 18:00Arrival Time 09:35"
```

This caused every regex to fail:

- `\bDate` failed because `\b` requires a word boundary, and `1Date` has no boundary between `1` and `D`
- `\bDeparture` failed because `2026Departure` has no boundary between `6` and `D`
- The plate regex captured `MH49CW0841Date` because `[A-Z0-9]+` consumed the capital `D` of `Date`
- The arrival city regex failed because `\bArrival` has no boundary in `HyderabadArrival`

## normalizeText() Design

Instead of patching 10+ individual regexes, a single pre-processing function was added between raw text extraction and regex matching. It runs in five sequential phases, each targeting one class of concatenation problem.

The function is `private normalizeText(raw: string): string` in `PdfParserService`. It is called by `parse()` before `parseText()`.

## Phase 1 — Insert newlines before line-level field labels

**Purpose:** Break the single merged metadata line into separate lines, one label per line.

**Labels processed (in this order):**
`Departure Time`, `Arrival Time`, `Date`, `Departure`, `Arrival`

The order is critical. Compound labels like `Departure Time` must be processed before their prefixes (`Departure`) to avoid double-splitting. For example, if `Departure` were processed first, `Departure Time` would become `\nDeparture Time` — and then `Departure Time` would match again, resulting in `\n\nDeparture Time`.

**Rule:** Insert `\n` before the label only when the preceding character is a non-whitespace character (regex lookbehind `(?<=[^\s])`).

**Before → After:**

```
"Plate MH49CW0841Date 16.06.2026Departure Time 18:00Arrival Time 09:35"
  ↓ insert \n before "Departure Time"
"Plate MH49CW0841Date 16.06.2026\nDeparture Time 18:00Arrival Time 09:35"
  ↓ insert \n before "Arrival Time"
"Plate MH49CW0841Date 16.06.2026\nDeparture Time 18:00\nArrival Time 09:35"
  ↓ insert \n before "Date"
"Plate MH49CW0841\nDate 16.06.2026\nDeparture Time 18:00\nArrival Time 09:35"
  ↓ "Departure" already preceded by \n → no change
  ↓ "Arrival" already preceded by \n → no change

RESULT:
  Plate MH49CW0841
  Date 16.06.2026
  Departure Time 18:00
  Arrival Time 09:35
```

For the city line:

```
"Departure HyderabadArrival Pune"
  ↓ insert \n before "Arrival" (preceded by "d" — non-whitespace)
"Departure Hyderabad\nArrival Pune"

RESULT:
  Departure Hyderabad
  Arrival Pune
```

## Phase 2 — Insert spaces before column-header keywords

**Purpose:** Restore spaces between column header names that were merged in table headers.

**Labels processed:** `Name`, `Role`, `Phone(?!Pe)`, `Shop`

**Rule:** Insert a space before the keyword when it is preceded by a non-whitespace character.

`Phone(?!Pe)` is a negative lookahead — it matches `Phone` only when NOT followed by `Pe`. This prevents splitting the booking source `PhonePe` into `Phone Pe`.

**Before → After:**

```
"NameRolePhone"
  ↓ "Name" preceded by \n → no insertion (already at line start)
  ↓ "Role" preceded by "e" → insert space
"Name RolePhone"
  ↓ "Phone" preceded by "e" and NOT followed by "Pe" → insert space
"Name Role Phone"

"Seat NumberNamePhoneShop"
  ↓ "Name" preceded by "r" (from "Number") → insert space
"Seat Number NamePhoneShop"
  ↓ "Phone" preceded by "e" → insert space
"Seat Number Name PhoneShop"
  ↓ "Shop" preceded by "e" → insert space
"Seat Number Name Phone Shop"
```

## Phase 3 — Insert space between seat token and passenger name

**Purpose:** Split the seat number from the passenger name when they are concatenated without a space.

**Pattern:** `/^(\d{1,2}[A-Z])([A-Z])/gm`

The seat token in FlixBus manifests is always `\d{1,2}[A-Z]` (row number + column letter, e.g. `1D`, `12A`). Passenger names always start with an uppercase letter. The regex matches exactly one letter after the seat code and inserts a space.

**Before → After:**

```
"1DVenkatesh Vasamsetty+919491689434Redbus"
  ↓ "1D" + "V" → insert space
"1D Venkatesh Vasamsetty+919491689434Redbus"

"2AAsif Ahmed Mohammed+917337011194Redbus"
  ↓ "2A" + "A" → insert space
"2A Asif Ahmed Mohammed+917337011194Redbus"
```

## Phase 4 — Insert space before Indian phone numbers

**Purpose:** Separate the passenger name from the immediately following phone number.

**Pattern:** `/([^\s])((?:\+?91[-\s]?)?[6-9]\d{9})/g`

Matches any non-whitespace character directly followed by an Indian phone number (with or without `+91` prefix). Inserts a space between them.

**Before → After:**

```
"1D Venkatesh Vasamsetty+919491689434Redbus"
  ↓ "y" + "+919491689434" → insert space
"1D Venkatesh Vasamsetty +919491689434Redbus"
```

## Phase 5 — Insert space before booking source names

**Purpose:** Separate the last digit of the phone number from the booking source name.

**Pattern:** `(\d)(${shop})` with `gi` flags, for each shop name in the list.

Booking sources: `Redbus`, `PayTM`, `Paytm`, `AbhiBus`, `IntrCity`, `Offline`, `Agent`, `PhonePe`, `MakeMyTrip`, `Flix`

**Before → After:**

```
"1D Venkatesh Vasamsetty +919491689434Redbus"
  ↓ "4" + "Redbus" → insert space
"1D Venkatesh Vasamsetty +919491689434 Redbus"
```

## Final normalized output

```
PASSENGER LIST
Bus Partner: Divya Enterprises
Plate MH49CW0841
Date 16.06.2026
Departure Time 18:00
Arrival Time 09:35
Departure Hyderabad
Arrival Pune
Name Role Phone
Seat Number Name Phone Shop
1D Venkatesh Vasamsetty +919491689434 Redbus
1E Sathya Sathya +919491689434 Redbus
2A Asif Ahmed Mohammed +917337011194 Redbus
3D Bhavesh Dev +917742444062 PayTM
```

With this clean input, every existing regex in `parseText()` matches correctly without modification.

## Debug file output

Every call to `PdfParserService.parse()` writes two files:

- `debug/raw-text.txt` — exactly what pdf-parse returned
- `debug/normalized-text.txt` — the text after all 5 normalization phases

These files are overwritten on each parse. They are invaluable for diagnosing parser failures on new PDF layouts.

---

# 7. Data Model

## Why single-table design

The original schema had five tables:

- `pdf_imports` — one row per imported PDF file
- `passenger_imports` — aggregate counts
- `flixbus_trips` — trip metadata (route, times)
- `flixbus_drivers` — one row per driver per trip
- `flixbus_passengers` — one row per passenger per trip

This required five INSERT operations per PDF and four JOIN queries to reassemble a complete record. It also required foreign key management and migration coordination.

The new design stores everything about one PDF in a single row, using JSONB columns for the variable-length arrays (drivers and passengers). This means one INSERT per PDF, one SELECT to read a complete record, and zero JOINs. For a read-mostly dashboard that never needs to query individual passengers across trips, this is significantly simpler and faster.

## Table: `public.flixbus_data`

```sql
CREATE TABLE public.flixbus_data (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bus_partner    text,
  plate          text,
  date           date,
  departure_time time,
  arrival_time   time,
  departure      text,
  arrival        text,
  driver_details jsonb,
  seat_details   jsonb,
  pdf_hash       text UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now()
);
```

### Column reference

**`id`**
Type: `uuid`. Auto-generated by `gen_random_uuid()` on insert. Used as the primary key. Never set manually.
Example: `"3f2504e0-4f89-11d3-9a0c-0305e82c3301"`

**`bus_partner`**
Type: `text`. The bus operating company that runs this trip. Extracted from the line `Bus Partner: <value>` in the PDF.
Example: `"Divya Enterprises"`

**`plate`**
Type: `text`. The vehicle registration number. Extracted from the `Plate <value>` field in the PDF. Matches the physical number plate on the bus.
Example: `"MH49CW0841"`

**`date`**
Type: `date`. The travel date of this trip, stored as ISO `YYYY-MM-DD`. Parsed from the `Date DD.MM.YYYY` field. The PDF uses `DD.MM.YYYY` format; the parser converts it to ISO.
Example: `"2026-06-16"`

**`departure_time`**
Type: `time`. The scheduled departure time of the bus. Stored as `HH:MM:SS` (seconds always `00`). Extracted from `Departure Time HH:MM`.
Example: `"18:00:00"`

**`arrival_time`**
Type: `time`. The scheduled arrival time. Extracted from `Arrival Time HH:MM`.
Example: `"09:35:00"`

**`departure`**
Type: `text`. The city of departure. Extracted from the `Departure <city>` line (distinct from `Departure Time`).
Example: `"Hyderabad"`

**`arrival`**
Type: `text`. The destination city. Extracted from the `Arrival <city>` line (distinct from `Arrival Time`).
Example: `"Pune"`

**`driver_details`**
Type: `jsonb`. Array of driver objects for this trip. Can be empty if no drivers are listed. The driver section in the PDF is between the `Name Role Phone` header and the `Seat Number` header.

Schema:

```json
[
  {
    "driver_name": "Rajesh Kumar",
    "role": "Driver",
    "phone": "+919876543210"
  }
]
```

`role` is nullable — if a driver row has no role token before the phone number, it is stored as `null`.

**`seat_details`**
Type: `jsonb`. Array of passenger objects. One entry per passenger seat.

Schema:

```json
[
  {
    "seat_no": "1D",
    "name": "Venkatesh Vasamsetty",
    "phone": "+919491689434",
    "shop": "Redbus"
  }
]
```

`shop` is the booking platform. Nullable. Detected by matching known platform names: `Redbus`, `PayTM`, `Paytm`, `AbhiBus`, `IntrCity`, `Offline`, `Agent`, `PhonePe`, `MakeMyTrip`, `Flix`.

**`pdf_hash`**
Type: `text UNIQUE`. SHA-256 hex digest of the raw PDF binary. 64 characters. Used for duplicate detection. The `UNIQUE` constraint ensures no two rows can have the same hash at the database level, providing a second layer of protection beyond the application-level check.
Example: `"a3f5c2d1e8b9..."` (64 hex chars)

**`created_at`**
Type: `timestamptz NOT NULL DEFAULT now()`. The timestamp when the row was inserted into the database. Set automatically by PostgreSQL.
Example: `"2026-06-16T12:45:00.000Z"`

### Indexes

```sql
CREATE INDEX flixbus_data_date_idx ON public.flixbus_data (date DESC);
CREATE INDEX flixbus_data_plate_date_idx ON public.flixbus_data (plate, date);
```

`date_idx` speeds up queries that ORDER BY date (the dashboard loads most recent imports first).
`plate_date_idx` supports future queries like "show all trips for plate X" or "find the trip for plate X on date Y".

### Row Level Security

RLS is enabled but no policies are defined. This means:

- The service role key (used by the backend) bypasses RLS entirely → full access
- The anon key or authenticated user keys cannot read or write this table → zero access from the public internet

---

# 8. Duplicate Detection

## Why Duplicates Happen

The WhatsApp sync scans all visible PDFs in the chat group, newest first. If the same PDF was posted twice (forwarded, re-sent), or if a sync ran yesterday and today's sync runs again before any new PDFs were posted, the same file would be downloaded and processed again.

Inserting a duplicate would create two identical rows in `flixbus_data` — wrong passenger counts, confused reporting.

## SHA-256 Hashing

The hash is computed on the raw file bytes, not the parsed content:

```typescript
private hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
```

SHA-256 produces a 64-character hexadecimal string. Two files with identical bytes will always produce the same hash. Two files with even one byte difference will produce completely different hashes.

Hashing the raw bytes (not the parsed text) is important because:

- The parsed text might be identical for two different PDFs (same trip, re-generated)
- The raw bytes capture the exact PDF version, including metadata

## Detection Flow

```typescript
const { data: existing } = await supabase
  .from("flixbus_data")
  .select("id")
  .eq("pdf_hash", pdfHash)
  .maybeSingle();

if (existing) {
  this.logger.warn(`[PDF Sync] Duplicate skipped: ${pdfName}`);
  return { status: "duplicate", id: existing.id, pdfName };
}
```

`maybeSingle()` returns `null` if no row matches (not an error). If a row is found, the import is aborted and the existing row's `id` is returned.

## Early-Exit Optimization

In the WhatsApp sync loop (`checkForNewPdfs`), the consumer breaks as soon as it sees the first duplicate:

```typescript
if (result.status === "duplicate") {
  this.logger.log("[PDF Sync] Duplicate hit — stopping scan.");
  break;
}
```

This works because PDFs are processed newest-first. The moment a duplicate is found, all older PDFs are already in the database (they were imported in a previous run). There is no need to check them.

## Database Safety Net

Even if the application-level check is bypassed (concurrent requests, race condition), the `UNIQUE` constraint on `pdf_hash` prevents duplicate rows at the database level. Supabase would return a constraint violation error rather than insert the row.

## Example Scenarios

| Scenario                                                 | Result                                                    |
| -------------------------------------------------------- | --------------------------------------------------------- |
| New PDF, never imported                                  | Imported → new row with new uuid                          |
| Same PDF re-sent in group                                | Hash matches existing row → status: duplicate, scan stops |
| PDF with same content but different bytes (re-generated) | New hash → imported as new row                            |
| Two syncs running simultaneously (race condition)        | First INSERT wins, second gets DB constraint error        |

---

# 9. Dashboard (Monitor UI)

The dashboard is served at `GET /monitor`. It is a single HTML file returned as a string from `MonitorController`. There is no separate frontend build step, no React, no bundler.

## Page Load Sequence

```
Browser loads /monitor
  │
  ├── CSS and HTML render immediately (no network needed)
  │
  ├── JavaScript runs:
  │     log('System ready.', 'hi')
  │     log('Waiting for sync…')
  │
  ├── loadHealth()   → GET /pdf-sync/health
  ├── loadSummary()  → GET /pdf-sync/summary
  └── loadImports()  → GET /pdf-sync/imports?limit=20

Then: setInterval(10000) → loadSummary() + loadImports() every 10 seconds
```

## Sync Status Card

Data source: `GET /pdf-sync/summary` → `PdfSyncService.getSummary()`

| UI element        | Data field        | Notes                                                     |
| ----------------- | ----------------- | --------------------------------------------------------- |
| Coloured dot      | `syncStatus`      | idle=grey, running=blue(blink), success=green, failed=red |
| Status text       | `syncStatus`      | Capitalised                                               |
| WhatsApp Group    | `whatsappGroup`   | From `PDF_SYNC_WHATSAPP_GROUP` env var                    |
| Last Sync         | `lastSyncTime`    | `created_at` of most recent row in `flixbus_data`         |
| PDFs Imported     | `pdfsImported`    | COUNT(\*) of `flixbus_data`                               |
| Last Imported PDF | `lastImportedPdf` | Joined string: `bus_partner · plate · date`               |

The "Run Sync" button calls `POST /pdf-sync/sync`. While the request is in flight, the dashboard plays a pre-scripted log animation (the `STEPS` array with timed `setTimeout`s) to show the user what phase the sync is likely in. When the real response arrives, the animation is cancelled and the actual result is logged.

## Environment Check Card

Data source: `GET /pdf-sync/health` → `PdfSyncService.checkHealth()`

| UI element         | Data field                | Green if                               |
| ------------------ | ------------------------- | -------------------------------------- |
| Backend reachable  | `backend`                 | Always true (response received)        |
| Supabase connected | `supabase`                | Supabase SELECT did not error          |
| WhatsApp group set | `whatsappGroupConfigured` | `PDF_SYNC_WHATSAPP_GROUP` is non-empty |
| Group name         | `whatsappGroup`           | Display only                           |

The card is collapsible (click the section title to toggle).

## Live Logs Panel

A dark terminal-style `<div>` that appends log entries as the user interacts. Each entry has a timestamp prefix `[HH:MM:SS]`. There is no server-side log streaming — all log entries are generated client-side based on user actions and API responses.

Log classes: `hi` (blue highlight), `ok` (green), `err` (red), `wrn` (yellow), default (grey).

## Recent Imports Table

Data source: `GET /pdf-sync/imports?limit=20` → `PdfSyncService.getImports()`

| Column      | Data field            | Format                                  |
| ----------- | --------------------- | --------------------------------------- |
| Bus Partner | `bus_partner`         | Plain text                              |
| Vehicle     | `plate`               | Monospace `<code>` tag                  |
| Route       | `departure → arrival` | Joined with arrow, computed client-side |
| Travel Date | `date`                | `en-IN` locale date format              |
| Passengers  | `passenger_count`     | Blue pill badge                         |
| Imported At | `created_at`          | `en-IN` locale datetime                 |

Auto-refreshes every 10 seconds via `setInterval`.

---

# 10. Full Sync Execution Walkthrough

## User clicks "Run Sync"

```
1. Browser: onclick="runSync()"
   - Button disabled, spinner shown
   - Status dot → blue (running)
   - STEPS animation starts (timed log messages)
   - fetch('POST /pdf-sync/sync')
```

## Controller receives request

```
2. PdfSyncController.runSync()
   - No inputs to validate
   - Delegates: return this.service.checkForNewPdfs()
```

## Service orchestrates the pipeline

```
3. PdfSyncService.checkForNewPdfs()
   - Initialises results array, scanned counter
   - Opens async for-of loop over WhatsAppService.streamPdfsNewestFirst()
```

## WhatsApp automation starts

```
4. WhatsAppService.streamPdfsNewestFirst() [AsyncGenerator]
   a. Reads PDF_SYNC_WHATSAPP_GROUP from ConfigService
   b. Reads session dir, download dir, headless flag from ConfigService
   c. chromium.launchPersistentContext(sessionDir, { headless, args, userAgent })
   d. context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', ...))
   e. page.goto('https://web.whatsapp.com')
   f. waitForLoginState(page)
      - waitForSelector('canvas[aria-label*="Scan me"], div[data-testid="chat-list"]')
      - If QR visible → throw 'not authenticated'
      - If chat list visible → continue
   g. openGroupChat(page, 'Pdf sync')
      - Fill search box with group name
      - Click matching result from search
      - Wait for chat header to confirm group opened
      - waitForTimeout(2000) for message list to render
```

## PDF scanning

```
5. WhatsApp scans for PDF cards
   a. locator('div[data-testid="document-thumb"]').count() → e.g. 5 cards
   b. Loop i = 4 down to 0 (newest first):
      - scrollIntoViewIfNeeded()
      - Arm download listener (5 second timeout)
      - pdfCard.click()
      - If direct download → capture it
      - Else: try download button selectors in overlay
      - download.saveAs('.runtime/pdf-sync/downloads/<filename>')
      - yield { filePath, pdfName }   ← suspends generator here
```

## Back in the service — one PDF received

```
6. PdfSyncService receives yielded PDF
   a. scanned++
   b. ingestDownloadedPdf(download)
      - readFileSync(download.filePath)  → Buffer
      - importPdfBuffer(buffer, pdfName)
```

## Hash and duplicate check

```
7. importPdfBuffer(buffer, pdfName)
   a. pdfHash = createHash('sha256').update(buffer).digest('hex')
   b. supabase.from('flixbus_data').select('id').eq('pdf_hash', pdfHash).maybeSingle()
   c. If existing row found:
      - logger.warn('Duplicate skipped')
      - return { status: 'duplicate', id: existing.id }
      - Consumer (step 8) breaks the loop
   d. If no row found: continue to parse
```

## PDF parsing

```
8. PdfParserService.parse(buffer)
   a. pdfParse(buffer) → raw text string
   b. normalizeText(rawText):
      - Phase 1: insert \n before field labels
      - Phase 2: insert spaces before column header keywords
      - Phase 3: split seat token from passenger name
      - Phase 4: insert space before phone numbers
      - Phase 5: insert space before booking sources
   c. saveDebug(rawText, normalizedText) → writes debug/raw-text.txt, debug/normalized-text.txt
   d. parseText(normalizedText):
      - Split into lines, trim whitespace
      - field() extracts: bus_partner, plate
      - parseDate() extracts: date
      - parseTime() extracts: departure_time, arrival_time
      - parseDepartureCity() extracts: departure
      - parseArrivalCity() extracts: arrival
      - parseDrivers() extracts: driver_details (section between Name/Role/Phone and Seat headers)
      - parseSeats() extracts: seat_details (section after Seat Number header)
   e. Returns FlixBusParsed object
```

## Supabase insert

```
9. supabase.from('flixbus_data').insert({
     bus_partner:    parsed.bus_partner,
     plate:          parsed.plate,
     date:           parsed.date,
     departure_time: parsed.departure_time,
     arrival_time:   parsed.arrival_time,
     departure:      parsed.departure,
     arrival:        parsed.arrival,
     driver_details: parsed.driver_details,
     seat_details:   parsed.seat_details,
     pdf_hash:       pdfHash,
   }).select('id').single()

   Returns: { id: 'new-uuid' }
   logger.log('Imported manifest.pdf → new-uuid')
   return { status: 'imported', id, pdfName, parsed }
```

## Loop continues or breaks

```
10. PdfSyncService:
    - If status === 'duplicate': break (generator closes, browser shuts down via finally)
    - Else: loop to next iteration, generator resumes, next PDF downloaded and yielded
```

## Response returned

```
11. After loop exits:
    summary = {
      scanned:  3,
      imported: 2,
      skipped:  1,
      results:  [...]
    }
    logger.log('Sync complete. scanned=3, imported=2, skipped=1')
    return summary
```

## Dashboard refreshes

```
12. Browser receives JSON response
    - Clears STEPS animation timers
    - Logs: "✅ Done — scanned:3 imported:2 duplicates:1"
    - Updates status dot → green (success)
    - await loadSummary()   → refreshes count and last-imported
    - await loadImports()   → refreshes the table with new rows
    - Re-enables button
```

---

# 11. Environment Variables

## `SUPABASE_URL`

**Purpose:** The base URL of the Supabase project's REST API.
**Used by:** `SupabaseService` (constructor)
**Default:** None — server crashes at startup if missing
**Example:** `https://YOUR_PROJECT_ID.supabase.co`
**Where to find:** Supabase Dashboard → Project Settings → API → Project URL

## `SUPABASE_SERVICE_ROLE_KEY`

**Purpose:** The secret key that grants full database access, bypassing Row Level Security.
**Used by:** `SupabaseService` (constructor)
**Default:** None — server crashes at startup if missing
**Security:** Never expose this key in client-side code, logs, or version control. It has root-level access to your database.
**Example:** `sb_secret_...` (starts with `sb_secret_`)
**Where to find:** Supabase Dashboard → Project Settings → API → `service_role` key

## `PDF_SYNC_HEADLESS`

**Purpose:** Controls whether the Playwright browser opens a visible window.
**Used by:** `WhatsAppService` (line 48)
**Default:** If not set, `=== 'true'` evaluates to `false` → headless=false (browser visible)
**Values:** `true` (headless, no window) or `false` (shows browser window)
**Workflow:** Set to `false` to scan QR code on first run. Set to `true` for all subsequent automated runs.

## `PDF_SYNC_WHATSAPP_GROUP`

**Purpose:** The exact display name of the WhatsApp group to search for PDFs.
**Used by:** `WhatsAppService` (line 30)
**Default:** If not set, the service logs a warning and skips WhatsApp entirely.
**Example:** `Pdf sync`
**Note:** Must match the group name exactly as it appears in WhatsApp — case-sensitive, spaces matter.

## `PDF_SYNC_WHATSAPP_SESSION_DIR`

**Purpose:** Directory where Playwright stores the persistent Chromium browser profile (cookies, localStorage, IndexedDB).
**Used by:** `WhatsAppService` (line 40)
**Default:** `.runtime/pdf-sync/whatsapp-session` (relative to `process.cwd()`)
**Example:** `.whatsapp-session`
**Note:** This is `PDF_SYNC_WHATSAPP_SESSION_DIR` — not `PDF_SYNC_SESSION_DIR`. The names are different.

## `PDF_SYNC_DOWNLOAD_DIR`

**Purpose:** Directory where downloaded PDFs are staged before processing.
**Used by:** `WhatsAppService` (line 43)
**Default:** `.runtime/pdf-sync/downloads`
**Example:** `.downloads`

## `PDF_SYNC_SCHEDULER_ENABLED`

**Purpose:** Enables the daily automatic sync job.
**Used by:** `PdfSyncSchedulerService` (line 22)
**Default:** Disabled (if not set or any value other than `"true"`)
**Values:** `true` to enable, anything else to disable

## `PDF_SYNC_DAILY_TIME`

**Purpose:** The time of day to run the automatic sync when the scheduler is enabled.
**Used by:** `PdfSyncSchedulerService` (line 54)
**Default:** `03:00` (3 AM server local time)
**Format:** 24-hour `HH:MM`
**Example:** `02:30`

## `PDF_SYNC_API_KEY`

**Purpose:** Protects all `/pdf-sync/*` endpoints with a static API key.
**Used by:** `ApiKeyGuard`
**Default:** If not set, all requests are allowed (development mode — no authentication)
**How to use:** Set the key in `.env`, then pass it on every API request:
`X-API-Key: your-key` or `Authorization: Bearer your-key`
**Example:** `my-secret-key-abc123`

---

# 12. Troubleshooting Guide

## "Could not find the table 'public.flixbus_data' in the schema cache"

**Symptoms:** Any API call that touches Supabase returns this error. Specifically appears on `POST /pdf-sync/sync` or `GET /pdf-sync/summary`.

**Root cause:** The `flixbus_data` table does not exist in Supabase. The migration SQL has been written locally but not executed in the Supabase project.

**Fix:**

1. Open [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your project
3. SQL Editor → New query
4. Paste the contents of `supabase/migrations/004_replace_with_flixbus_data.sql`
5. Click Run

**Diagnose:**

```bash
# Check health endpoint — supabase field will be false
curl http://localhost:3000/pdf-sync/health
```

---

## "WhatsApp session is not authenticated"

**Symptoms:** `POST /pdf-sync/sync` fails immediately with this error. The WhatsApp browser opens and closes within 60 seconds.

**Root cause:** The Playwright browser profile directory contains no valid WhatsApp session, or WhatsApp has expired/invalidated the session.

**Fix:**

1. Set `PDF_SYNC_HEADLESS=false` in `.env`
2. Delete the existing session: `rm -rf ".runtime/pdf-sync/whatsapp-session"`
3. Restart the server: `npm run start:dev`
4. When the Chromium window opens, scan the QR code with your phone
5. Wait for the chat list to appear
6. Trigger a sync — it will complete successfully
7. Set `PDF_SYNC_HEADLESS=true` in `.env` and restart for future automated runs

**Diagnose:**

```bash
ls ".runtime/pdf-sync/whatsapp-session/Default/"
# Should contain: Cookies, Local Storage, IndexedDB
# If empty or missing: session was never saved
```

---

## Headless mode fails even after scanning QR

**Symptoms:** `PDF_SYNC_HEADLESS=false` works fine and imports succeed. Setting `PDF_SYNC_HEADLESS=true` immediately triggers the "not authenticated" error.

**Root cause:** WhatsApp Web detects the Playwright browser automation via `navigator.webdriver = true` and forces re-authentication even with a valid saved session.

**Fix:** This was permanently fixed by adding to `whatsapp.service.ts`:

```typescript
args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ... Chrome/136.0.0.0 ...',
```

and:

```typescript
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});
```

If headless fails again after this fix, WhatsApp has updated its detection. Delete the session and re-scan.

---

## PDF parsing returns null fields or empty arrays

**Symptoms:** `POST /pdf-sync/test-parse` or `POST /pdf-sync/import-pdf` returns a `parsed` object with `null` values and empty `driver_details`/`seat_details`.

**Root cause:** The PDF layout may have changed, or the normalization phases are not covering a new concatenation pattern.

**Diagnose:**

```bash
# After uploading the PDF via test-parse, check debug files
cat debug/raw-text.txt
cat debug/normalized-text.txt
```

Compare the raw text to the normalized text. Find which field label is missing or malformed. The normalization phase that handles that label needs to be checked.

**Specific sub-cases:**

- `plate` ends with extra characters → the plate value is running into the next label without a space → Phase 1 failed to split before that label
- `date = null` → `\bDate` is not matching → Phase 1 did not insert a `\n` before `Date` → check that `Date` appears in Phase 1's label list
- `seat_details = []` → seat header not detected OR seat tokens not matching → check Phase 3 regex against the actual seat format in the new PDF

---

## Duplicate PDFs being imported as new rows

**Symptoms:** The same trip appears twice in the Recent Imports table.

**Root cause:** Two different PDF files with different bytes represent the same trip. Because the hash is computed from raw bytes, two separately-generated PDFs for the same trip will have different hashes and be imported as distinct rows.

**This is correct behaviour** — if the PDF bytes are different, they are treated as different documents. To de-duplicate by trip content, a composite unique index on `(plate, date)` could be added.

**If identical PDFs are being duplicated** (same hash but appearing twice), check if the `UNIQUE` constraint on `pdf_hash` exists:

```sql
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'flixbus_data';
```

---

## Internal Server Error on import

**Symptoms:** `POST /pdf-sync/import-pdf` or sync returns HTTP 500.

**Root cause options:**

1. Supabase INSERT failed (constraint violation, type mismatch, network error)
2. pdf-parse threw an exception (corrupted PDF, encrypted PDF, image-only PDF)
3. The parsed fields contain a type that Supabase rejects

**Diagnose:**

```bash
# Check server logs for the specific error message
npm run start:dev
# The PdfSyncService logger outputs the exact error before throwing
```

Check `debug/raw-text.txt` — if it is empty or contains only whitespace, the PDF has no text layer (it is a scanned image). pdf-parse cannot extract text from image PDFs without OCR.

---

## Port 3000 already in use

**Symptoms:** `npm run start:dev` fails with `EADDRINUSE: address already in use :::3000`.

**Root cause:** A previous server process did not shut down cleanly.

**Fix:**

```bash
# Find and kill the process
pkill -f "node dist/main"
# Or on specific port:
lsof -ti:3000 | xargs kill -9
```

---

## Session directory issues

**Symptoms:** Playwright crashes at launch, OR each run creates a new session directory, OR the session is not persisted between runs.

**Root cause options:**

1. The env var `PDF_SYNC_WHATSAPP_SESSION_DIR` is not being read (wrong key name in `.env`)
2. The directory path does not exist and `mkdirSync` failed silently
3. Permissions issue on the directory

**Diagnose:**

```bash
# Check what session dir is being used
ls -la ".runtime/pdf-sync/whatsapp-session/"

# Verify the env var name
grep SESSION .env
# Must be: PDF_SYNC_WHATSAPP_SESSION_DIR=<path>
# NOT:     PDF_SYNC_SESSION_DIR=<path>
```

---

# 13. Future Improvements

## Auto Scheduler (production hardening)

**Current state:** The scheduler uses `setTimeout` which is lost if the Node.js process crashes or is restarted.

**Improvement:** Replace with a proper cron mechanism:

- Use `@nestjs/schedule` with `@Cron('0 3 * * *')` decorator on `PdfSyncSchedulerService`
- Or use a managed queue like BullMQ (Redis-backed) with `@nestjs/bull`
- Either approach survives process restarts and provides retry logic on failure

**Implementation:** Add `@nestjs/schedule` to `package.json`, import `ScheduleModule.forRoot()` in `AppModule`, replace `setTimeout` with `@Cron(CronExpression.EVERY_DAY_AT_3AM)`.

## Dashboard Auto-Refresh with Server-Sent Events

**Current state:** Dashboard polls every 10 seconds regardless of whether anything changed.

**Improvement:** Use Server-Sent Events (SSE) to push updates from server to client only when a sync completes.

**Implementation:** Add a NestJS `@Sse()` endpoint in `MonitorController` that yields events. Add `PdfSyncService.syncCompleted$` as an `Observable`. After each import, emit an event. Client replaces `setInterval` with `new EventSource('/monitor/events')`.

## Notifications (Slack / Telegram / WhatsApp)

**Current state:** No notification when a sync runs or fails.

**Improvement:** After each sync, send a summary to a configured webhook:

- Slack: `POST` to Slack Incoming Webhook URL with the scan/import/skip counts
- Telegram: `POST` to `https://api.telegram.org/bot<token>/sendMessage`

**Implementation:** Add `NotificationService` injected into `PdfSyncService`. Call `notify(summary)` at the end of `checkForNewPdfs()`. Gate on `NOTIFICATION_WEBHOOK_URL` env var.

## Passenger Search API

**Current state:** Passenger data is stored in JSONB, not queryable by name or phone.

**Improvement:** Add a `GET /pdf-sync/search?phone=9876543210` endpoint that queries:

```sql
SELECT * FROM flixbus_data
WHERE seat_details @> '[{"phone": "+919876543210"}]';
```

This uses PostgreSQL's JSONB containment operator (`@>`) which works without schema changes.

## Route Analytics

**Current state:** No aggregation across imports.

**Improvement:** Add a `GET /pdf-sync/analytics` endpoint that returns:

- Most popular routes (GROUP BY departure, arrival)
- Busiest travel dates
- Average passengers per trip
- Booking source distribution

All queries run directly on `flixbus_data` using `jsonb_array_length(seat_details)` and JSONB operators.

## Export Functionality

**Current state:** Data is only viewable in the dashboard or Supabase Studio.

**Improvement:** Add `GET /pdf-sync/export?format=csv&date=2026-06` that generates a CSV/Excel file on-demand. NestJS response with `Content-Disposition: attachment; filename=exports.csv`. Use the `csv-writer` npm package for CSV generation.

## Multi-Group Support

**Current state:** One WhatsApp group is configured.

**Improvement:** Accept `PDF_SYNC_WHATSAPP_GROUPS` as a comma-separated list of group names. Run the scan in sequence for each group. Tag each imported row with a `group_name` column.
