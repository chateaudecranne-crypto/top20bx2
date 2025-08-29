// server.js
// ------------------------------------------------------------
// "Bordeaux AOC Top 20" — Full-stack Node.js app with SQLite
// ------------------------------------------------------------
// Features
// - Shows Top 20 wines per AOC (Bordeaux) based solely on Vivino ratings
// - Admin can adjust a wine's score by up to ±25% (immediate re-ranking)
// - Colorful, airy UI with search by AOC and by note (rating)
// - Auto-refresh pipeline every 75 days (keeps admin overrides)
// - Import Vivino data via CSV or JSON (no scraping; bring your own export)
// - Basic-Auth protected admin routes
// ------------------------------------------------------------
// Quick start
// 1) npm init -y
// 2) npm i express better-sqlite3 node-cron multer csv-parse dayjs
// 3) node server.js
// 4) Open http://localhost:3000
// Optional env vars:
//   PORT=3000
//   ADMIN_USER=admin
//   ADMIN_PASSWORD=changeme (CHANGE THIS!)
//   REFRESH_HOUR_UTC=03 (hour of day to check refresh window)
//   DATA_SEED=./data/vivino_seed.json (optional seed file)
// ------------------------------------------------------------

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const upload = multer({ dest: path.join(__dirname, 'uploads') });
const cron = require('node-cron');
const { parse: parseCsv } = require('csv-parse/sync');
const dayjs = require('dayjs');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const REFRESH_HOUR_UTC = process.env.REFRESH_HOUR_UTC || '03';
const DATA_SEED = process.env.DATA_SEED || path.join(__dirname, 'data', 'vivino_seed.json');

// ---- DB setup ------------------------------------------------
const db = new Database(path.join(__dirname, 'bordeaux.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS wines (
  id INTEGER PRIMARY KEY,
  // external_id can be a Vivino wine id or any stable ID you map
  external_id TEXT UNIQUE,
  name TEXT NOT NULL,
  winery TEXT,
  aoc TEXT NOT NULL,
  vintage INTEGER,
  vivino_rating REAL NOT NULL,
  rating_count INTEGER DEFAULT 0,
  price REAL,
  last_source_update TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS admin_overrides (
  wine_id INTEGER PRIMARY KEY,
  adjustment_pct REAL NOT NULL DEFAULT 0, -- range [-25, 25]
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (wine_id) REFERENCES wines(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Useful prepared statements
const upsertWine = db.prepare(`
INSERT INTO wines (external_id, name, winery, aoc, vintage, vivino_rating, rating_count, price, last_source_update, updated_at)
VALUES (@external_id, @name, @winery, @aoc, @vintage, @vivino_rating, @rating_count, @price, @last_source_update, datetime('now'))
ON CONFLICT(external_id) DO UPDATE SET
  name=excluded.name,
  winery=excluded.winery,
  aoc=excluded.aoc,
  vintage=excluded.vintage,
  vivino_rating=excluded.vivino_rating,
  rating_count=excluded.rating_count,
  price=excluded.price,
  last_source_update=excluded.last_source_update,
  updated_at=datetime('now');
`);

const getWineById = db.prepare(`SELECT * FROM wines WHERE id = ?`);
const getWineByExternalId = db.prepare(`SELECT * FROM wines WHERE external_id = ?`);
const upsertOverride = db.prepare(`
INSERT INTO admin_overrides (wine_id, adjustment_pct, updated_at)
VALUES (?, ?, datetime('now'))
ON CONFLICT(wine_id) DO UPDATE SET adjustment_pct=excluded.adjustment_pct, updated_at=datetime('now');
`);

const setMeta = db.prepare(`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
const getMeta = db.prepare(`SELECT value FROM meta WHERE key = ?`);

// ---- Helpers -------------------------------------------------
function sanitizeNumber(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function adjustedRating(row) {
  const adj = sanitizeNumber(row.adjustment_pct || 0);
  const base = sanitizeNumber(row.vivino_rating || 0);
  const factor = 1 + Math.max(-25, Math.min(25, adj)) / 100;
  return base * factor;
}

function basicAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const [type, token] = header.split(' ');
  if (type !== 'Basic' || !token) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication required');
  }
  const [user, pass] = Buffer.from(token, 'base64').toString('utf8').split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();
  return res.status(403).send('Forbidden');
}

function ensureSeed() {
  // Seed with tiny demo data if DB is empty AND a seed file is present
  const count = db.prepare('SELECT COUNT(*) AS n FROM wines').get().n;
  if (count > 0) return;
  try {
    if (fs.existsSync(DATA_SEED)) {
      const raw = fs.readFileSync(DATA_SEED, 'utf8');
      const arr = JSON.parse(raw);
      const insert = db.transaction((items) => {
        for (const w of items) upsertWine.run(w);
      });
      insert(arr);
      setMeta.run('last_refresh', dayjs().toISOString());
      console.log(`[seed] Inserted ${arr.length} wines from seed file.`);
    } else {
      // Minimal inline seed as fallback
      const demo = [
        { external_id: 'demo-1', name: 'Château Demo 1', winery: 'Demo Estate', aoc: 'Saint-Estèphe', vintage: 2018, vivino_rating: 4.2, rating_count: 1200, price: 35.0, last_source_update: dayjs().toISOString() },
        { external_id: 'demo-2', name: 'Château Demo 2', winery: 'Demo Estate', aoc: 'Pauillac', vintage: 2019, vivino_rating: 4.5, rating_count: 980, price: 75.0, last_source_update: dayjs().toISOString() },
        { external_id: 'demo-3', name: 'Château Demo 3', winery: 'Demo Estate', aoc: 'Margaux', vintage: 2020, vivino_rating: 4.0, rating_count: 450, price: 52.0, last_source_update: dayjs().toISOString() },
        { external_id: 'demo-4', name: 'Château Demo 4', winery: 'Demo Estate', aoc: 'Saint-Julien', vintage: 2016, vivino_rating: 4.3, rating_count: 2100, price: 60.0, last_source_update: dayjs().toISOString() },
        { external_id: 'demo-5', name: 'Château Demo 5', winery: 'Demo Estate', aoc: 'Pessac-Léognan', vintage: 2017, vivino_rating: 4.1, rating_count: 800, price: 40.0, last_source_update: dayjs().toISOString() }
      ];
      const insert = db.transaction((items) => {
        for (const w of items) upsertWine.run(w);
      });
      insert(demo);
      setMeta.run('last_refresh', dayjs().toISOString());
      console.log('[seed] Inserted demo wines.');
    }
  } catch (err) {
    console.error('[seed] Failed:', err);
  }
}

ensureSeed();

// ---- Auto-refresh scheduler --------------------------------
// We run a daily check at REFRESH_HOUR_UTC; if last_refresh >= 75 days ago, we call refreshVivinoData().
cron.schedule(`0 ${REFRESH_HOUR_UTC} * * *`, () => {
  try {
    const last = getMeta.get('last_refresh');
    const lastIso = last && last.value ? dayjs(last.value) : null;
    const daysSince = lastIso ? dayjs().diff(lastIso, 'day') : 9999;
    if (daysSince >= 75) {
      console.log(`[refresh] ${daysSince} days since last refresh — running refreshVivinoData()`);
      refreshVivinoData();
    } else {
      console.log(`[refresh] ${daysSince} days since last refresh — not due yet.`);
    }
  } catch (e) {
    console.error('[refresh] Check failed:', e);
  }
}, { timezone: 'UTC' });

function refreshVivinoData() {
  // IMPORTANT: We do NOT scrape Vivino. Provide your own export (CSV/JSON) from legitimate sources.
  // This example will look for ./data/vivino_seed.json if present and update base ratings.
  try {
    if (fs.existsSync(DATA_SEED)) {
      const raw = fs.readFileSync(DATA_SEED, 'utf8');
      const arr = JSON.parse(raw);
      const tx = db.transaction((items) => {
        for (const w of items) {
          upsertWine.run({
            external_id: w.external_id,
            name: w.name,
            winery: w.winery,
            aoc: w.aoc,
            vintage: w.vintage,
            vivino_rating: sanitizeNumber(w.vivino_rating, 0),
            rating_count: sanitizeNumber(w.rating_count, 0),
            price: sanitizeNumber(w.price, null),
            last_source_update: dayjs().toISOString(),
          });
        }
      });
      tx(arr);
      setMeta.run('last_refresh', dayjs().toISOString());
      console.log(`[refresh] Updated ${arr.length} wines from ${DATA_SEED}`);
    } else {
      console.log(`[refresh] Seed file not found: ${DATA_SEED}. Skipping.`);
    }
  } catch (err) {
    console.error('[refresh] Failed:', err);
  }
}

// ---- Express app & API -------------------------------------
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS for dev convenience
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --- UI ------------------------------------------------------
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(INDEX_HTML);
});

// --- Public API ---------------------------------------------
app.get('/api/aocs', (req, res) => {
  const rows = db.prepare(`SELECT aoc, COUNT(*) AS n FROM wines GROUP BY aoc ORDER BY aoc`).all();
  res.json(rows.map(r => r.aoc));
});

// Fetch wines with optional filters. By default, returns top 20 for the provided AOC (if any)
app.get('/api/wines', (req, res) => {
  const { aoc, q, minRating, maxRating, limit, offset, all } = req.query;

  // Compose SQL: join overrides and compute adjusted rating
  let sql = `
    SELECT w.*, IFNULL(o.adjustment_pct, 0) AS adjustment_pct,
           (w.vivino_rating * (1 + (CASE WHEN IFNULL(o.adjustment_pct, 0) > 25 THEN 25 WHEN IFNULL(o.adjustment_pct, 0) < -25 THEN -25 ELSE IFNULL(o.adjustment_pct, 0) END)/100.0)) AS adjusted_rating
    FROM wines w
    LEFT JOIN admin_overrides o ON o.wine_id = w.id
    WHERE 1 = 1
  `;
  const params = [];
  if (aoc) { sql += ` AND w.aoc = ?`; params.push(aoc); }
  if (q) { sql += ` AND (w.name LIKE ? OR w.winery LIKE ?) `; params.push(`%${q}%`, `%${q}%`); }
  if (minRating) { sql += ` AND adjusted_rating >= ?`; params.push(Number(minRating)); }
  if (maxRating) { sql += ` AND adjusted_rating <= ?`; params.push(Number(maxRating)); }

  sql += ` ORDER BY adjusted_rating DESC, rating_count DESC, price ASC NULLS LAST`;

  const lim = all ? null : Number(limit || (aoc ? 20 : 100));
  const off = Number(offset || 0);
  if (lim) sql += ` LIMIT ${lim} OFFSET ${off}`;

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// --- Admin API ----------------------------------------------
app.post('/api/admin/override', basicAuth, (req, res) => {
  const { wine_id, adjustment_pct } = req.body || {};
  if (!wine_id || adjustment_pct === undefined) return res.status(400).json({ error: 'wine_id and adjustment_pct required' });
  const pct = Number(adjustment_pct);
  if (!Number.isFinite(pct)) return res.status(400).json({ error: 'adjustment_pct must be a number' });
  if (pct < -25 || pct > 25) return res.status(400).json({ error: 'adjustment_pct must be between -25 and 25' });
  const wine = getWineById.get(wine_id);
  if (!wine) return res.status(404).json({ error: 'Wine not found' });
  upsertOverride.run(wine_id, pct);
  const updated = db.prepare(`
    SELECT w.*, IFNULL(o.adjustment_pct, 0) AS adjustment_pct,
           (w.vivino_rating * (1 + (CASE WHEN IFNULL(o.adjustment_pct, 0) > 25 THEN 25 WHEN IFNULL(o.adjustment_pct, 0) < -25 THEN -25 ELSE IFNULL(o.adjustment_pct, 0) END)/100.0)) AS adjusted_rating
    FROM wines w LEFT JOIN admin_overrides o ON o.wine_id = w.id WHERE w.id = ?
  `).get(wine_id);
  res.json({ ok: true, wine: updated });
});

// Upload CSV/JSON and upsert wines (base ratings). Keeps overrides intact.
app.post('/api/admin/import', basicAuth, upload.single('file'), (req, res) => {
  const file = req.file;
  const { format } = req.body || {}; // 'csv' or 'json'
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const raw = fs.readFileSync(file.path, 'utf8');
    let items = [];
    if ((format || '').toLowerCase() === 'csv' || file.originalname.toLowerCase().endsWith('.csv')) {
      const records = parseCsv(raw, { columns: true, skip_empty_lines: true });
      items = records.map(r => ({
        external_id: r.external_id || r.id || `${r.name}|${r.vintage}|${r.aoc}`,
        name: r.name,
        winery: r.winery || r.domain || r.chateau,
        aoc: r.aoc,
        vintage: r.vintage ? Number(r.vintage) : null,
        vivino_rating: sanitizeNumber(r.vivino_rating ?? r.rating),
        rating_count: sanitizeNumber(r.rating_count ?? r.reviews),
        price: r.price ? Number(r.price) : null,
        last_source_update: dayjs().toISOString(),
      }));
    } else {
      const arr = JSON.parse(raw);
      items = arr.map(w => ({
        external_id: w.external_id || w.id || `${w.name}|${w.vintage}|${w.aoc}`,
        name: w.name,
        winery: w.winery,
        aoc: w.aoc,
        vintage: w.vintage,
        vivino_rating: sanitizeNumber(w.vivino_rating ?? w.rating),
        rating_count: sanitizeNumber(w.rating_count ?? w.reviews),
        price: w.price != null ? Number(w.price) : null,
        last_source_update: dayjs().toISOString(),
      }));
    }

    const tx = db.transaction((rows) => {
      for (const w of rows) upsertWine.run(w);
    });
    tx(items);

    setMeta.run('last_refresh', dayjs().toISOString());
    res.json({ ok: true, upserted: items.length });
  } catch (err) {
    console.error('[import] Failed:', err);
    res.status(500).json({ error: 'Import failed', detail: String(err) });
  } finally {
    if (file) fs.unlink(file.path, () => {});
  }
});

app.post('/api/admin/refresh', basicAuth, (req, res) => {
  refreshVivinoData();
  res.json({ ok: true });
});

app.get('/api/meta', (req, res) => {
  const last = getMeta.get('last_refresh');
  const lastIso = last && last.value ? dayjs(last.value).toISOString() : null;
  const next = lastIso ? dayjs(lastIso).add(75, 'day').toISOString() : null;
  res.json({ last_refresh: lastIso, next_refresh_due: next });
});

// Serve app
app.listen(PORT, () => {
  console.log(`Bordeaux AOC Top 20 running on http://localhost:${PORT}`);
});

// ---- Frontend (served inline) -------------------------------
const INDEX_HTML = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bordeaux — Top 20 par AOC (Vivino)</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = { theme: { extend: { colors: { brand: { 50:'#fff1f2',100:'#ffe4e6',200:'#fecdd3',300:'#fda4af',400:'#fb7185',500:'#f43f5e',600:'#e11d48',700:'#be123c',800:'#9f1239',900:'#881337' } } } } };
  </script>
  <style>
    html, body { height: 100%; }
    .glass { backdrop-filter: blur(8px); background: rgba(255,255,255,0.75); }
    .chip { @apply inline-flex items-center px-2 py-1 text-xs font-medium rounded-full border; }
    .sticky-head th { position: sticky; top: 0; background: white; }
  </style>
</head>
<body class="min-h-screen bg-gradient-to-br from-brand-50 via-fuchsia-50 to-sky-50 text-gray-800">
  <header class="sticky top-0 z-30 bg-gradient-to-r from-brand-500 to-fuchsia-500 text-white shadow-lg">
    <div class="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <span class="text-2xl">🍷</span>
        <h1 class="text-xl sm:text-2xl font-semibold">Bordeaux — Top 20 par AOC (Vivino)</h1>
      </div>
      <div class="text-sm opacity-90" id="meta"></div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-4 py-6">
    <section class="glass rounded-2xl shadow-md p-4 sm:p-6 mb-6">
      <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
        <div class="md:col-span-4">
          <label class="block text-sm font-medium mb-1">AOC</label>
          <select id="aocSelect" class="w-full rounded-xl border-gray-300 focus:ring-brand-500 focus:border-brand-500 p-2">
            <option value="">Toutes (affiche top 100 global)</option>
          </select>
        </div>
        <div class="md:col-span-3">
          <label class="block text-sm font-medium mb-1">Recherche (vin / château)</label>
          <input id="q" type="text" placeholder="ex: Margaux, Pontet-Canet..." class="w-full rounded-xl border-gray-300 focus:ring-brand-500 focus:border-brand-500 p-2" />
        </div>
        <div class="md:col-span-3">
          <label class="block text-sm font-medium mb-1">Filtrer par note finale</label>
          <div class="flex items-center gap-2">
            <input id="minRating" type="number" step="0.1" min="0" max="5" class="w-24 rounded-xl border-gray-300 focus:ring-brand-500 focus:border-brand-500 p-2" placeholder="min" />
            <span>—</span>
            <input id="maxRating" type="number" step="0.1" min="0" max="5" class="w-24 rounded-xl border-gray-300 focus:ring-brand-500 focus:border-brand-500 p-2" placeholder="max" />
          </div>
        </div>
        <div class="md:col-span-2 flex gap-2 md:justify-end">
          <button id="resetBtn" class="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200">Réinitialiser</button>
          <button id="adminBtn" class="px-4 py-2 rounded-xl bg-white text-brand-700 border border-brand-200 hover:bg-brand-50" title="Se connecter en admin">Admin</button>
        </div>
      </div>
    </section>

    <section class="glass rounded-2xl shadow-md overflow-hidden">
      <div class="flex items-center justify-between px-4 py-3 border-b bg-white/70">
        <h2 class="text-lg font-semibold">Classement <span id="rankingLabel" class="text-gray-500 font-normal"></span></h2>
        <div class="text-sm text-gray-600">Tri: note finale décroissante</div>
      </div>
      <div class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="sticky-head text-left text-xs uppercase tracking-wide text-gray-500 border-b">
            <tr>
              <th class="p-3">#</th>
              <th class="p-3">Vin</th>
              <th class="p-3">AOC</th>
              <th class="p-3">Millésime</th>
              <th class="p-3">Note Vivino</th>
              <th class="p-3">Ajust. admin (%)</th>
              <th class="p-3">Note finale</th>
              <th class="p-3">Avis</th>
              <th class="p-3">Prix</th>
              <th class="p-3">Actions</th>
            </tr>
          </thead>
          <tbody id="rows" class="divide-y bg-white/70"></tbody>
        </table>
      </div>
    </section>

    <p class="text-xs text-gray-500 mt-3">Sources: Notes de base issues de vos exports Vivino. Aucune collecte automatisée n'est effectuée ici. Les ajustements admin (±25% max) modifient le classement en temps réel.</p>
  </main>

  <!-- Admin modal -->
  <div id="adminModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4">
    <div class="w-full max-w-md bg-white rounded-2xl shadow-xl p-6">
      <h3 class="text-lg font-semibold mb-2">Connexion administrateur</h3>
      <p class="text-sm text-gray-600 mb-4">Entrez vos identifiants pour modifier les notes, importer des données ou lancer un rafraîchissement.</p>
      <form id="adminLogin" class="space-y-3">
        <div>
          <label class="block text-sm mb-1">Utilisateur</label>
          <input id="adminUser" class="w-full rounded-xl border-gray-300 p-2" placeholder="admin" />
        </div>
        <div>
          <label class="block text-sm mb-1">Mot de passe</label>
          <input id="adminPass" type="password" class="w-full rounded-xl border-gray-300 p-2" placeholder="••••••" />
        </div>
        <div class="flex items-center justify-end gap-2 pt-2">
          <button type="button" id="closeAdmin" class="px-4 py-2 rounded-xl bg-gray-100">Annuler</button>
          <button class="px-4 py-2 rounded-xl bg-brand-600 text-white hover:bg-brand-700">Se connecter</button>
        </div>
      </form>
      <div id="adminPanel" class="hidden mt-4 border-t pt-4">
        <div class="flex items-center gap-2 text-sm">
          <strong class="mr-2">Admin:</strong><span id="whoami"></span>
        </div>
        <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <form id="importForm" class="glass p-3 rounded-xl border">
            <h4 class="font-medium mb-2">Importer (CSV/JSON)</h4>
            <input type="file" id="importFile" class="block w-full text-sm" />
            <button type="submit" class="mt-2 w-full px-3 py-2 rounded-xl bg-brand-600 text-white">Importer</button>
          </form>
          <div class="glass p-3 rounded-xl border">
            <h4 class="font-medium mb-2">Rafraîchir maintenant</h4>
            <button id="refreshNow" class="w-full px-3 py-2 rounded-xl bg-emerald-600 text-white">Lancer</button>
          </div>
        </div>
      </div>
    </div>
  </div>

<script>
  const api = {
    async aocs() { return (await fetch('/api/aocs')).json(); },
    async wines(params={}) {
      const u = new URL('/api/wines', location.origin);
      for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
      return (await fetch(u)).json();
    },
    async meta() { return (await fetch('/api/meta')).json(); },
    async adminOverride(auth, wine_id, adjustment_pct) {
      return (await fetch('/api/admin/override', { method:'POST', headers: { 'Content-Type':'application/json', 'Authorization': auth }, body: JSON.stringify({ wine_id, adjustment_pct }) })).json();
    },
    async adminImport(auth, file) {
      const fd = new FormData(); fd.append('file', file);
      return (await fetch('/api/admin/import', { method:'POST', headers: { 'Authorization': auth }, body: fd })).json();
    },
    async adminRefresh(auth) {
      return (await fetch('/api/admin/refresh', { method:'POST', headers: { 'Authorization': auth } })).json();
    }
  };

  // State
  let AUTH = null;
  let current = { aoc: '', q: '', minRating: '', maxRating: '' };

  function fmt(x, d=1){ if (x==null || isNaN(x)) return '—'; return Number(x).toFixed(d); }
  function money(x){ if (x==null || isNaN(x)) return '—'; return Intl.NumberFormat('fr-FR', { style:'currency', currency:'EUR' }).format(x); }

  async function loadMeta(){
    const m = await api.meta();
    const el = document.getElementById('meta');
    const last = m.last_refresh ? new Date(m.last_refresh) : null;
    const next = m.next_refresh_due ? new Date(m.next_refresh_due) : null;
    el.textContent = last ? `Dernier rafraîchissement: ${last.toLocaleDateString('fr-FR')} • Prochain: ${next.toLocaleDateString('fr-FR')}` : 'Planification: tous les 75 jours';
  }

  async function populateAOCs(){
    const aocs = await api.aocs();
    const sel = document.getElementById('aocSelect');
    for (const a of aocs){
      const opt = document.createElement('option');
      opt.value = a; opt.textContent = a;
      sel.appendChild(opt);
    }
  }

  async function refreshTable(){
    const label = document.getElementById('rankingLabel');
    const params = { aoc: current.aoc, q: current.q, minRating: current.minRating, maxRating: current.maxRating, limit: current.aoc ? 20 : 100 };
    const rows = await api.wines(params);
    label.textContent = current.aoc ? `(Top 20 — ${current.aoc})` : '(Top 100 global)';

    const tbody = document.getElementById('rows');
    tbody.innerHTML = '';
    rows.forEach((w, idx) => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-brand-50/40';
      tr.innerHTML = `
        <td class="p-3 font-medium">${idx+1}</td>
        <td class="p-3">
          <div class="font-medium">${w.name || '—'}</div>
          <div class="text-xs text-gray-500">${w.winery || ''}</div>
        </td>
        <td class="p-3">${w.aoc}</td>
        <td class="p-3">${w.vintage || '—'}</td>
        <td class="p-3">${fmt(w.vivino_rating)}</td>
        <td class="p-3">${adminControl(w)}</td>
        <td class="p-3 font-semibold">${fmt(w.adjusted_rating)}</td>
        <td class="p-3">${w.rating_count ?? '—'}</td>
        <td class="p-3">${money(w.price)}</td>
        <td class="p-3">${actionsCell(w)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function actionsCell(w){
    return `<span class="chip border-brand-200 text-brand-700 bg-brand-50">ID: ${w.external_id || w.id}</span>`;
  }

  function adminControl(w){
    const pct = w.adjustment_pct ?? 0;
    const disabled = AUTH ? '' : 'disabled';
    return `
    <div class="flex items-center gap-2">
      <input type="number" min="-25" max="25" step="0.5" value="${pct}" class="w-20 rounded-lg border-gray-300 p-1" ${disabled}
        onChange="window.setAdj(${w.id}, this.value)" />
      <span class="text-xs text-gray-500">±25% max</span>
    </div>`;
  }

  window.setAdj = async (id, val) => {
    if (!AUTH) { alert('Connectez-vous en admin pour modifier.'); return; }
    const pct = Number(val);
    if (isNaN(pct)) return;
    if (pct < -25 || pct > 25) { alert('Valeur hors limite (±25%).'); return; }
    const res = await api.adminOverride(AUTH, id, pct);
    if (!res.ok) { alert(res.error || 'Échec de la mise à jour'); return; }
    refreshTable();
  };

  function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

  // Event bindings
  document.getElementById('aocSelect').addEventListener('change', e=>{ current.aoc = e.target.value; refreshTable(); });
  document.getElementById('q').addEventListener('input', debounce(e=>{ current.q = e.target.value; refreshTable(); }, 250));
  document.getElementById('minRating').addEventListener('input', debounce(e=>{ current.minRating = e.target.value; refreshTable(); }, 250));
  document.getElementById('maxRating').addEventListener('input', debounce(e=>{ current.maxRating = e.target.value; refreshTable(); }, 250));
  document.getElementById('resetBtn').addEventListener('click', ()=>{
    current = { aoc:'', q:'', minRating:'', maxRating:'' };
    document.getElementById('aocSelect').value='';
    document.getElementById('q').value='';
    document.getElementById('minRating').value='';
    document.getElementById('maxRating').value='';
    refreshTable();
  });

  // Admin modal
  const adminModal = document.getElementById('adminModal');
  document.getElementById('adminBtn').addEventListener('click', ()=> adminModal.classList.remove('hidden'));
  document.getElementById('closeAdmin').addEventListener('click', ()=> adminModal.classList.add('hidden'));

  document.getElementById('adminLogin').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const user = document.getElementById('adminUser').value || 'admin';
    const pass = document.getElementById('adminPass').value || '';
    AUTH = 'Basic ' + btoa(user + ':' + pass);
    // Quick probe: call a protected endpoint with harmless payload
    const probe = await fetch('/api/admin/refresh', { method:'POST', headers: { 'Authorization': AUTH } });
    if (probe.status === 200) {
      document.getElementById('whoami').textContent = user;
      document.getElementById('adminPanel').classList.remove('hidden');
      document.getElementById('adminLogin').classList.add('hidden');
      alert('Connecté. Vous pouvez maintenant modifier les notes.');
      adminModal.classList.add('hidden');
      refreshTable();
    } else {
      AUTH = null; alert('Identifiants invalides.');
    }
  });

  document.getElementById('importForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const f = document.getElementById('importFile').files[0];
    if (!f) { alert('Choisissez un fichier CSV/JSON'); return; }
    const res = await api.adminImport(AUTH, f);
    if (res.ok) { alert('Import réussi: ' + res.upserted + ' vins'); refreshTable(); loadMeta(); }
    else alert('Échec import: ' + (res.error||''));
  });

  document.getElementById('refreshNow').addEventListener('click', async ()=>{
    const res = await api.adminRefresh(AUTH);
    if (res.ok) { alert('Rafraîchissement lancé.'); loadMeta(); refreshTable(); }
    else alert('Échec: ' + (res.error||''));
  });

  // Init
  (async function init(){
    await loadMeta();
    await populateAOCs();
    await refreshTable();
  })();
</script>
</body>
</html>`;
