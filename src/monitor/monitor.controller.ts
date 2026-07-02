import { Controller, Get, Header } from '@nestjs/common';

@Controller()
export class MonitorController {
  @Get('monitor')
  @Header('Content-Type', 'text/html; charset=utf-8')
  dashboard(): string {
    return DASHBOARD_HTML;
  }
}

const DASHBOARD_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PDF Sync Monitor</title>
<style>
:root {
  --bg:       #f1f5f9;
  --card:     #ffffff;
  --border:   #e2e8f0;
  --text:     #0f172a;
  --muted:    #64748b;
  --green:    #16a34a;
  --red:      #dc2626;
  --blue:     #2563eb;
  --yellow:   #d97706;
  --log-bg:   #0f172a;
  --log-dim:  #475569;
  --log-text: #94a3b8;
  --log-hi:   #38bdf8;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--text);
  font-size: 14px;
  line-height: 1.5;
}

/* ── Header ── */
.hdr {
  background: var(--card);
  border-bottom: 1px solid var(--border);
  padding: 14px 24px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.hdr h1 { font-size: 17px; font-weight: 600; }
.badge {
  font-size: 11px;
  font-weight: 600;
  background: #dbeafe;
  color: #1e40af;
  padding: 2px 8px;
  border-radius: 99px;
  letter-spacing: 0.03em;
}

/* ── Layout ── */
.page { max-width: 1080px; margin: 0 auto; padding: 20px; }
.row  { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
@media (max-width: 680px) { .row { grid-template-columns: 1fr; } }

/* ── Card ── */
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 18px 20px;
}
.card + .card { margin-top: 16px; }
.section-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin-bottom: 14px;
}

/* ── Status card ── */
.status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
.dot {
  width: 11px; height: 11px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot-idle    { background: var(--muted); }
.dot-running { background: var(--blue); animation: blink 1s ease-in-out infinite; }
.dot-success { background: var(--green); }
.dot-failed  { background: var(--red); }
@keyframes blink { 0%,100% { opacity:1; } 50% { opacity:.3; } }
.status-text { font-size: 16px; font-weight: 700; }

.kv { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); gap: 12px; }
.kv:last-of-type { border-bottom: none; }
.kv .k { color: var(--muted); white-space: nowrap; }
.kv .v { font-weight: 500; text-align: right; word-break: break-all; }

.btn-row { margin-top: 16px; display: flex; align-items: center; gap: 10px; }
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 16px; border-radius: 7px; border: none;
  font-size: 13px; font-weight: 600; cursor: pointer;
  transition: background .12s;
}
.btn-blue   { background: var(--blue); color: #fff; }
.btn-blue:hover   { background: #1d4ed8; }
.btn-blue:disabled { background: #93c5fd; cursor: not-allowed; }
.sync-msg { font-size: 13px; color: var(--muted); }
.sync-msg.ok  { color: var(--green); }
.sync-msg.err { color: var(--red); }

/* ── Env check card ── */
.env-toggle {
  all: unset; cursor: pointer;
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted);
}
.env-body { margin-top: 12px; }
.env-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 7px 0; border-bottom: 1px solid var(--border);
}
.env-row:last-child { border-bottom: none; }
.ok   { color: var(--green); font-weight: 600; }
.fail { color: var(--red);   font-weight: 600; }
.dim  { color: var(--muted); }

/* ── Log panel ── */
.log-panel {
  background: var(--log-bg);
  border-radius: 8px;
  padding: 14px 16px;
  min-height: 160px;
  max-height: 260px;
  overflow-y: auto;
  font-family: "SF Mono", "Fira Code", "Menlo", monospace;
  font-size: 12px;
  line-height: 1.8;
}
.ll     { color: var(--log-text); }
.ll .t  { color: var(--log-dim); margin-right: 8px; }
.ll.hi  { color: var(--log-hi); }
.ll.ok  { color: #4ade80; }
.ll.err { color: #f87171; }
.ll.wrn { color: #fbbf24; }

/* ── Imports table ── */
.tbl-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th {
  text-align: left; padding: 9px 12px;
  font-size: 11px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--muted); border-bottom: 2px solid var(--border);
}
td { padding: 10px 12px; border-bottom: 1px solid var(--border); }
tr:last-child td { border-bottom: none; }
tr:hover td { background: #f8fafc; }
code { font-family: "SF Mono","Menlo",monospace; font-size: 12px; background: #f1f5f9; padding: 2px 5px; border-radius: 4px; }
.pill {
  display: inline-block;
  background: #dbeafe; color: #1e40af;
  padding: 2px 9px; border-radius: 99px;
  font-size: 12px; font-weight: 600;
}
.empty { text-align: center; color: var(--muted); padding: 32px; }
.refresh { font-size: 11px; color: var(--muted); text-align: right; margin-top: 8px; }

/* ── Spin ── */
@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin .8s linear infinite; display: inline-block; }
</style>
</head>
<body>

<div class="hdr">
  <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#2563eb" stroke-width="2">
    <path stroke-linecap="round" stroke-linejoin="round"
      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414A1 1 0 0119 9.414V19a2 2 0 01-2 2z"/>
  </svg>
  <h1>PDF Sync Monitor</h1>
</div>

<div class="page">

  <div class="row">

    <!-- Status card -->
    <div class="card">
      <div class="section-title">Sync Status</div>

      <div class="status-row">
        <div class="dot dot-idle" id="dot"></div>
        <div class="status-text" id="statusTxt">Loading…</div>
      </div>

      <div class="kv"><span class="k">WhatsApp Groups</span><span class="v" id="kvGroup">—</span></div>
      <div class="kv"><span class="k">Last Sync</span><span class="v" id="kvLast">—</span></div>
      <div class="kv"><span class="k">PDFs Imported</span><span class="v" id="kvCount">—</span></div>
      <div class="kv"><span class="k">Last Imported PDF</span><span class="v" id="kvLastPdf">—</span></div>

      <div class="btn-row">
        <button class="btn btn-blue" id="syncBtn" onclick="runSync()">
          &#x21BB;&nbsp; Run Sync
        </button>
        <span class="sync-msg" id="syncMsg"></span>
      </div>
    </div>

    <!-- Env check card -->
    <div class="card">
      <button class="env-toggle" onclick="toggleEnv()">
        <span id="envArrow">&#9654;</span> Environment Check
      </button>
      <div class="env-body" id="envBody">
        <div class="env-row">
          <span>Backend reachable</span>
          <span class="ok" id="envBackend">checking…</span>
        </div>
        <div class="env-row">
          <span>Supabase connected</span>
          <span class="ok" id="envSupa">checking…</span>
        </div>
        <div class="env-row">
          <span>WhatsApp group set</span>
          <span class="ok" id="envWa">checking…</span>
        </div>
        <div class="env-row">
          <span>Group name</span>
          <span class="dim" id="envWaName">—</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Live Logs -->
  <div class="card" style="margin-bottom:16px">
    <div class="section-title">Live Logs</div>
    <div class="log-panel" id="logPanel"></div>
  </div>

  <!-- Recent Imports -->
  <div class="card">
    <div class="section-title">Recent Imports</div>
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>Group</th>
            <th>Line No</th>
            <th>Vehicle</th>
            <th>Route</th>
            <th>Travel Date</th>
            <th>Pax</th>
            <th>WhatsApp Received</th>
            <th>Imported At</th>
          </tr>
        </thead>
        <tbody id="importsBody">
          <tr><td colspan="8" class="empty">Loading…</td></tr>
        </tbody>
      </table>
    </div>
    <div class="refresh" id="refreshNote"></div>
  </div>

</div><!-- /page -->

<script>
// ── Helpers ────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toLocaleTimeString('en-GB');
}

function log(msg, cls) {
  const p = document.getElementById('logPanel');
  const d = document.createElement('div');
  d.className = 'll' + (cls ? ' ' + cls : '');
  d.innerHTML = '<span class="t">[' + ts() + ']</span>' + escHtml(msg);
  p.appendChild(d);
  p.scrollTop = p.scrollHeight;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtDt(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch (_) { return iso; }
}

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch (_) { return d; }
}

// whatsapp_received_at is stored as plain IST string "YYYY-MM-DD HH:MM:SS" — display without conversion
function fmtIST(s) {
  if (!s) return '—';
  var parts = String(s).split(' ');
  if (parts.length < 2) return s;
  var dp = parts[0].split('-');
  if (dp.length < 3) return s;
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var mon = months[parseInt(dp[1], 10) - 1] || dp[1];
  return dp[2] + ' ' + mon + ' ' + dp[0] + ', ' + parts[1].slice(0, 5);
}

// ── Environment check ──────────────────────────────────────────────────────

async function loadHealth() {
  try {
    const r = await fetch('/pdf-sync/health');
    const h = await r.json();
    set('envBackend', h.backend  ? '✅ Yes' : '❌ No', h.backend);
    set('envSupa',    h.supabase ? '✅ Yes' : '❌ No', h.supabase);
    set('envWa',      h.whatsappGroupConfigured ? '✅ Yes' : '❌ Not set', h.whatsappGroupConfigured);
    document.getElementById('envWaName').textContent = h.whatsappGroup || '—';
    if (h.whatsappGroup) whatsappGroupName = h.whatsappGroup;
  } catch (_) {
    set('envBackend', '❌ Unreachable', false);
  }
}

function set(id, txt, ok) {
  const el = document.getElementById(id);
  el.textContent = txt;
  el.className = ok ? 'ok' : 'fail';
}

function toggleEnv() {
  const body  = document.getElementById('envBody');
  const arrow = document.getElementById('envArrow');
  const vis   = body.style.display !== 'none';
  body.style.display  = vis ? 'none' : '';
  arrow.style.transform = vis ? '' : 'rotate(90deg)';
}

// ── Summary ────────────────────────────────────────────────────────────────

async function loadSummary() {
  try {
    const r = await fetch('/pdf-sync/summary');
    const s = await r.json();
    const statusMap = { idle: 'dot-idle', running: 'dot-running', success: 'dot-success', failed: 'dot-failed' };
    const cls = statusMap[s.syncStatus] || 'dot-idle';
    document.getElementById('dot').className       = 'dot ' + cls;
    document.getElementById('statusTxt').textContent = capitalise(s.syncStatus || 'Idle');
    document.getElementById('kvGroup').textContent   = s.whatsappGroup   || 'Not configured';
    document.getElementById('kvLast').textContent    = fmtDt(s.lastSyncTime);
    document.getElementById('kvCount').textContent   = s.pdfsImported    ?? 0;
    document.getElementById('kvLastPdf').textContent = s.lastImportedPdf || '—';
  } catch (_) { /* backend unreachable */ }
}

function capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ── Imports table ──────────────────────────────────────────────────────────

async function loadImports() {
  try {
    const r    = await fetch('/pdf-sync/imports?limit=20');
    const rows = await r.json();
    const tbody = document.getElementById('importsBody');
    if (!Array.isArray(rows) || !rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No imports yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function(row) {
      const route = [row.departure, row.arrival].filter(Boolean).join(' → ') || '—';
      return '<tr>' +
        '<td class="dim">'  + escHtml(row.source_group || '—') + '</td>' +
        '<td><code>' + escHtml(row.line_number || '—') + '</code></td>' +
        '<td><code>' + escHtml(row.vehicle_number || '—') + '</code></td>' +
        '<td>'  + escHtml(route) + '</td>' +
        '<td>'  + fmtDate(row.date) + '</td>' +
        '<td><span class="pill">' + (row.passenger_count ?? 0) + '</span></td>' +
        '<td>'  + fmtIST(row.whatsapp_received_at) + '</td>' +
        '<td>'  + fmtDt(row.created_at) + '</td>' +
      '</tr>';
    }).join('');
    document.getElementById('refreshNote').textContent = 'Last refreshed: ' + ts();
  } catch (_) { /* ignore */ }
}

// ── Run Sync ───────────────────────────────────────────────────────────────

var whatsappGroupName = 'WhatsApp group';
var stepTimers = [];

async function runSync() {
  var btn = document.getElementById('syncBtn');
  var msg = document.getElementById('syncMsg');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">&#x21BB;</span>&nbsp; Running…';
  msg.textContent = '';
  msg.className   = 'sync-msg';
  document.getElementById('dot').className    = 'dot dot-running';
  document.getElementById('statusTxt').textContent = 'Running';

  log('▶ Sync triggered', 'hi');

  var STEPS = [
    [300,  '🔌 Connecting to WhatsApp Web…',                              'hi'],
    [900,  '📱 Opening WhatsApp Web…',                                    ''],
    [2200, '🔍 Searching for group "' + whatsappGroupName + '"…',         ''],
    [3400, '⏮  Loading checkpoint from Supabase…',                        ''],
    [4400, '⬆  Scrolling up to checkpoint position…',                     ''],
    [5600, '📂 Group found. Scanning messages oldest → newest…',          'hi'],
    [6800, '📥 Downloading PDF attachment(s)…',                           ''],
    [7500, '🔑 SHA-256 hash check (dedup)…',                              ''],
    [8200, '📄 Parsing FlixBus PDF via pdfplumber…',                      'hi'],
    [9000, '💾 Inserting into flix_trips…',                               ''],
    [9600, '🔎 Looking up service_id from trips table…',                  ''],
  ];

  stepTimers.forEach(clearTimeout);
  stepTimers = STEPS.map(function(s) {
    return setTimeout(function() { log(s[1], s[2]); }, s[0]);
  });

  try {
    var r   = await fetch('/pdf-sync/sync', { method: 'POST' });
    var res = await r.json();
    stepTimers.forEach(clearTimeout);

    if (!r.ok) throw new Error(res.message || 'Sync failed');

    var imp  = res.imported  || 0;
    var skip = res.skipped   || 0;
    var scan = res.scanned   || 0;
    log('✅ Done — scanned:' + scan + '  imported:' + imp + '  duplicates:' + skip, 'ok');
    msg.textContent = '✅ ' + imp + ' imported, ' + skip + ' skipped';
    msg.className   = 'sync-msg ok';
    document.getElementById('dot').className     = 'dot dot-success';
    document.getElementById('statusTxt').textContent = 'Success';
    await loadSummary();
    await loadImports();
  } catch (e) {
    stepTimers.forEach(clearTimeout);
    log('❌ ' + (e.message || 'Unknown error'), 'err');
    msg.textContent = '❌ ' + (e.message || 'Failed');
    msg.className   = 'sync-msg err';
    document.getElementById('dot').className     = 'dot dot-failed';
    document.getElementById('statusTxt').textContent = 'Failed';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '&#x21BB;&nbsp; Run Sync';
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────

// Open env section by default
document.getElementById('envArrow').style.transform = 'rotate(90deg)';

log('System ready.', 'hi');
log('Waiting for sync…');

loadHealth();
loadSummary();
loadImports();

// Auto-refresh every 10 s
setInterval(function() { loadSummary(); loadImports(); }, 10000);
</script>
</body>
</html>`;
