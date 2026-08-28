#!/usr/bin/env node
/**
 * CNL Chapter Page Preview Server
 *
 * Renders live sample chapter pages using the LOCAL chapter.js / chapter.css
 * (instead of jsDelivr), with real data from the chapter registry sheet,
 * the real EveryAction forms, and real Luma events proxied from the
 * cnl-events Worker (luma.cnlhq.org).
 *
 * Usage:  node preview/server.js   (then open http://localhost:4400)
 *
 * Edit chapter.js / chapter.css and save — open pages reload automatically.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4400;
const REPO_ROOT = path.join(__dirname, '..');
const SITE_ORIGIN = 'https://www.cnliberalism.org';
const LUMA_EVENTS_ORIGIN = 'https://luma.cnlhq.org';
const SIGNUP_JS = path.join(REPO_ROOT, '..', 'cnl-action-network-forms', 'src', 'signup.js');
const SIGNUP_UPSTREAM = process.env.SIGNUP_UPSTREAM || '';
const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ0wq0Bm6gQrgX_Th252L2h9B1GzPQS_SeWg-_JrNi6ynm7CHGcuLw-RjmWC4M5Yg-KMXjvNN0d8ZVe/pub?gid=0&single=true&output=csv';

const WATCHED_ASSETS = ['chapter.css', 'chapter.js', 'cnl-events-widget.css', 'cnl-events.js', 'cnl-event-form.css', 'cnl-event-form.js'];

// ---------- tiny CSV parser (handles quoted fields) ----------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  const headers = rows.shift() || [];
  return rows.map(r => Object.fromEntries(headers.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}

// ---------- cached upstream fetches ----------
const cache = {};
async function cachedFetch(key, url, ttlMs) {
  const hit = cache[key];
  if (hit && Date.now() - hit.at < ttlMs) return hit.body;
  const res = await fetch(url, { headers: { 'user-agent': 'cnl-preview-server' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = await res.text();
  cache[key] = { at: Date.now(), body };
  return body;
}

async function getChapters() {
  const csv = await cachedFetch('csv', CSV_URL, 5 * 60 * 1000);
  return parseCSV(csv).filter(r => r.ChapterCode);
}

// ---------- live-reload: hash of asset mtimes ----------
function assetStamp() {
  return WATCHED_ASSETS.map(f => path.join(REPO_ROOT, f)).concat([SIGNUP_JS]).map(f => {
    try { return fs.statSync(f).mtimeMs; } catch { return 0; }
  }).join('|');
}

const RELOAD_SNIPPET = `
<script>
(function () {
  let stamp = null;
  setInterval(async () => {
    try {
      const s = await (await fetch('/__stamp')).text();
      if (stamp === null) stamp = s;
      else if (s !== stamp) location.reload();
    } catch (e) {}
  }, 1000);
})();
</script>`;

// ---------- page templates ----------
function pickerPage(chapters) {
  const cards = chapters.map(ch => `
    <a class="card" href="/chapter/${encodeURIComponent(ch.ChapterCode)}">
      <span class="code">${ch.ChapterCode}</span>
      <span class="name">${ch.ChapterName || '(unnamed)'}</span>
      <span class="meta">${[ch.City, ch.State].filter(Boolean).join(', ')} &middot; category: ${ch['Website Category'] || '&mdash;'}</span>
    </a>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>CNL Chapter Page Preview</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; background: #1d2440; color: #FDFBE9; margin: 0; padding: 40px 20px; }
  h1 { text-align: center; letter-spacing: 1px; }
  p.sub { text-align: center; opacity: .7; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; max-width: 1100px; margin: 30px auto; }
  .card { display: flex; flex-direction: column; gap: 4px; background: #2C3659; border: 1px solid rgba(253,251,233,.15);
          border-radius: 12px; padding: 16px 18px; text-decoration: none; color: inherit; transition: .15s; }
  .card:hover { transform: translateY(-2px); border-color: rgba(253,251,233,.5); }
  .code { font-weight: 900; color: #e8a49e; font-size: 13px; letter-spacing: 2px; }
  .name { font-size: 17px; font-weight: 700; }
  .meta { font-size: 12px; opacity: .65; }
</style></head>
<body>
  <h1>Chapter Page Preview</h1>
  <p class="sub">Serving local <code>chapter.js</code> / <code>chapter.css</code> &mdash; save a file and open pages auto-reload.</p>
  <div class="grid">${cards}</div>
  ${RELOAD_SNIPPET}
</body></html>`;
}

function chapterPage(ch, chapters) {
  const category = ch['Website Category'] || ch.City || '';
  const options = chapters.map(c =>
    `<option value="${c.ChapterCode}" ${c.ChapterCode === ch.ChapterCode ? 'selected' : ''}>${c.ChapterCode} — ${c.ChapterName}</option>`).join('');

  // Below is a 1:1 replica of the Squarespace code block, with jsDelivr URLs
  // swapped for local /assets/ URLs.
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${ch.ChapterName} — preview</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css">
<link rel="stylesheet" href="https://use.typekit.net/kxb6xor.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/date-fns/2.30.0/index.min.js"></script>

<link rel="stylesheet" href="/assets/chapter.css">
<script src="/assets/chapter.js" defer></script>

<script>
  window.CNL_SETTINGS = {
    chapterCode: ${JSON.stringify(ch.ChapterCode)},
    category: ${JSON.stringify(category)},
    // preview only: the Luma Worker's CORS allowlist is cnliberalism.org, so
    // route through this server. Production uses chapter.js's default.
    eventsEndpoint: '/luma/events',
    // preview only: local copy of the shared sign-up component, Turnstile's
    // always-passes test key, and a sign-up endpoint this server either mocks
    // or proxies to a local Worker (SIGNUP_UPSTREAM=http://localhost:8787).
    signupJs: '/signup-assets/signup.js',
    signupSitekey: '1x00000000000000000000AA',
    signupEndpoint: '/signup'
  };
</script>
<style>
  body { margin: 0; background: #FDFBE9; }
  /* mock of the live Squarespace site header, for design context only */
  #sq-header {
    display: flex; align-items: center; gap: 28px;
    background: #FDFBE9; padding: 14px 50px;
  }
  #sq-header img { width: 150px; height: auto; display: block; }
  #sq-header nav { display: flex; gap: 24px; flex: 1; flex-wrap: wrap; }
  #sq-header nav a {
    font-family: 'pragmatica-extended', Archivo, sans-serif; font-weight: 800;
    font-size: 15px; letter-spacing: 0.02em; text-transform: uppercase;
    color: #9F3C39; text-decoration: none;
  }
  #sq-header nav a:hover { color: #2C3659; }
  #sq-header .sq-cta {
    font-family: 'pragmatica-extended', Archivo, sans-serif; font-weight: 800;
    font-size: 13px; letter-spacing: 0.02em; text-transform: uppercase;
    background: #2C3659; color: #FDFBE9; text-decoration: none;
    padding: 14px 22px; border-radius: 4px; white-space: nowrap;
  }
  @media (max-width: 900px) { #sq-header { padding: 12px 20px; } #sq-header nav { display: none; } }
  #preview-bar { position: fixed; bottom: 0; left: 0; right: 0; z-index: 99999;
    background: #131a33; color: #FDFBE9; font: 13px system-ui, sans-serif;
    display: flex; align-items: center; gap: 14px; padding: 8px 16px;
    border-top: 1px solid rgba(253,251,233,.2); }
  #preview-bar a { color: #e8a49e; text-decoration: none; font-weight: 700; }
  #preview-bar select { background: #2C3659; color: #FDFBE9; border: 1px solid rgba(253,251,233,.3);
    border-radius: 6px; padding: 4px 8px; font: inherit; }
  #preview-pad { height: 60px; }
</style>
</head>
<body>

<div id="sq-header">
  <img src="https://images.squarespace-cdn.com/content/v1/62ba153710aa8d1ca9881ae3/35d0a1a8-3967-47b6-ba6a-d02279f14d67/CNL+Logo+High+Resolution.png?format=500w" alt="Center for New Liberalism">
  <nav>
    <a href="#" onclick="return false">About Us</a>
    <a href="#" onclick="return false">Our Work</a>
    <a href="#" onclick="return false">Chapters</a>
    <a href="#" onclick="return false">Events</a>
    <a href="#" onclick="return false">NLAS</a>
    <a href="#" onclick="return false">Store</a>
  </nav>
  <a class="sq-cta" href="#" onclick="return false">Become a Member</a>
</div>

<div id="cnl-dashboard-container">
  <div id="cnl-header-wrapper">
    <h1 id="cnl-chapter-title">Loading...</h1>
    <div id="cnl-decorative-line"></div>
    <div id="cnl-social-pill"></div>
  </div>
  <div id="cnl-content-grid">
    <div id="cnl-signup-column">
      <div id="ea-glass-card">
        <h2 class="join-header">JOIN</h2>
        <div class="cnl-ea-form-wrap"><p style="text-align:center; color:#FDFBE9; font-family:sans-serif;">Loading...</p></div>
      </div>
    </div>
    <div id="cnl-events-column">
      <div id="cnl-events-feed"><p style="text-align:center; color:#FDFBE9; font-family:'pragmatica-extended', sans-serif; padding: 40px;">Checking for events...</p></div>
    </div>
  </div>
</div>

<div id="preview-pad"></div>
<div id="preview-bar">
  <a href="/">&larr; All chapters</a>
  <label>Chapter:
    <select onchange="location.href='/chapter/'+this.value">${options}</select>
  </label>
  <span style="opacity:.6">category: ${category || '—'} &middot; local assets, live reload on</span>
</div>
${RELOAD_SNIPPET}
</body></html>`;
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (status, body, type = 'text/html; charset=utf-8', extra = {}) => {
    // CORS: the chapter page editor (tools site on :8000) fetches assets + events from here in dev.
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...extra });
    res.end(body);
  };

  try {
    if (url.pathname === '/__stamp') return send(200, assetStamp(), 'text/plain');

    if (url.pathname === '/') {
      return send(200, pickerPage(await getChapters()));
    }

    if (url.pathname.startsWith('/chapter/')) {
      const code = decodeURIComponent(url.pathname.split('/')[2] || '');
      const chapters = await getChapters();
      const ch = chapters.find(c => c.ChapterCode === code);
      if (!ch) return send(404, `<h1>Unknown chapter code: ${code}</h1><a href="/">back</a>`);
      return send(200, chapterPage(ch, chapters));
    }

    if (url.pathname.startsWith('/assets/')) {
      const file = path.basename(url.pathname); // strips any traversal
      if (!WATCHED_ASSETS.includes(file)) return send(404, 'not found', 'text/plain');
      const type = file.endsWith('.css') ? 'text/css' : 'application/javascript';
      return send(200, fs.readFileSync(path.join(REPO_ROOT, file)), type);
    }

    // Shared sign-up component, served from its source folder (sibling repo).
    if (url.pathname === '/signup-assets/signup.js') {
      return send(200, fs.readFileSync(SIGNUP_JS), 'application/javascript');
    }

    // Sign-up submissions. With SIGNUP_UPSTREAM set, forward to a local
    // `wrangler dev` of cnl-signup-worker (use AN_DRY_RUN=1 there unless you
    // mean it); otherwise mock success so the UI states can be exercised.
    if (url.pathname === '/signup' && req.method === 'POST') {
      const body = await new Promise((resolve) => {
        let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b));
      });
      if (SIGNUP_UPSTREAM) {
        const r = await fetch(SIGNUP_UPSTREAM, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:' + PORT },
          body,
        });
        return send(r.status, await r.text(), 'application/json; charset=utf-8');
      }
      console.log('[signup mock]', body);
      await new Promise((r) => setTimeout(r, 600));
      return send(200, JSON.stringify({ ok: true, mock: true }), 'application/json; charset=utf-8');
    }

    // Luma events feed (events-automation Worker). chapter.js is pointed here
    // via CNL_SETTINGS.eventsEndpoint; query string (chapter, limit) passes through.
    if (url.pathname === '/luma/events') {
      const upstream = LUMA_EVENTS_ORIGIN + '/events' + url.search;
      const body = await cachedFetch('luma:' + upstream, upstream, 60 * 1000);
      return send(200, body, 'application/json; charset=utf-8');
    }

    // Legacy: the old dashboard fetched Squarespace's /events?format=json
    // relative to the page. Kept so older assets still work in preview.
    if (url.pathname === '/events' || url.pathname.startsWith('/events/')) {
      const upstream = SITE_ORIGIN + url.pathname + url.search;
      const body = await cachedFetch('ev:' + upstream, upstream, 60 * 1000);
      return send(200, body, 'application/json; charset=utf-8');
    }

    send(404, 'not found', 'text/plain');
  } catch (err) {
    console.error(err);
    send(500, 'Preview server error: ' + err.message, 'text/plain');
  }
});

server.listen(PORT, () => {
  console.log(`\nCNL chapter preview running:\n  http://localhost:${PORT}\n`);
  console.log('Serving local chapter.js / chapter.css with live reload.');
});
