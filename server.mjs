import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Tiny dependency-free backend ────────────────────────────────────────
// Serves the static app and exposes:
//   GET  /api/config   → local model + catalog source info
//   GET  /api/objects  → curated real objects from the CelesTrak SATCAT
//                        (the public satellite catalog), fetched once a day
//                        and cached on disk; a labelled sample fallback is
//                        returned when the catalog cannot be reached
//   POST /api/report   → asks Ollama (local machine only) for the plain-language
//                       report, or returns a labelled error for the UI fallback
// Private data never leaves this machine: the only outbound calls are to
// OLLAMA_URL (loopback by default) and the public CelesTrak catalog download.

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT) || 4173; // 0/NaN falls back to 4173
const model = process.env.OLLAMA_MODEL || 'llama3.2:3b';
const ollamaUrl = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
// The real-data source: CelesTrak's SATCAT bulk download (no API key, free
// for reasonable use — one fetch per day, cached locally). If that path is
// unavailable, the server falls back to CelesTrak's documented SATCAT query
// API (records.php) and merges the answers. Override either with CATALOG_URL.
const catalogUrl = process.env.CATALOG_URL || 'https://celestrak.org/pub/satcat.csv';
const SATCAT_QUERIES = [
  'GROUP=STATIONS', 'GROUP=WEATHER', 'GROUP=SCIENCE',
  'GROUP=GPS-OPS', 'GROUP=GALILEO', 'GROUP=BEIDOU', 'GROUP=STARLINK',
  'NAME=DEB', 'NAME=R%2FB',                      // debris + spent rocket stages
  'NAME=ENVISAT', 'NAME=VANGUARD', 'NAME=LANDSAT' // famous derelicts/legends not in any group
].map(query => `https://celestrak.org/satcat/records.php?${query}&FORMAT=CSV&ONORBIT=1`);
const CACHE_FILE = join(root, '.satcat.cache.json');
const CACHE_TTL = 24 * 60 * 60 * 1000; // CelesTrak updates the file daily

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

/* ── SATCAT: parse, curate ────────────────────────────────────────────── */
// CSV fields (RFC 4180, per celestrak.org/satcat/satcat-format.php):
// OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,
// LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,
// DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field); field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.length > 1) rows.push(row);
      row = [];
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const COL = {
  name: 0, intDes: 1, norad: 2, type: 3, status: 4, owner: 5,
  launch: 6, site: 7, decay: 8, period: 9, incl: 10, apogee: 11, perigee: 12
};

const STATUS_WORDS = {
  ACT: 'active', OP: 'operational', NONOP: 'non-operational',
  PEN: 'pending', D: 'decayed', NPA: 'no longer operational'
};

function num(value) {
  // SATCAT writes missing numbers as empty (or blank) fields — and
  // Number('') is 0, so those must be rejected explicitly or an object
  // without altitude data would sail through as sitting at 0 km.
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Strip SATCAT's square-bracket type suffix ("BREEZE-M DEB [TANK]" → the
// object name humans recognise); parenthesised alternate names stay.
function cleanName(name) {
  return name.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
}

// Rows that describe a real object sitting in an Earth orbit right now,
// with usable orbital figures.
function isOnOrbitEarth(row) {
  return row[COL.type] !== 'UNK'
    && row[15] === 'EA'           // ORBIT_CENTER
    && row[16] === 'ORB'          // ORBIT_TYPE
    && !row[COL.decay]            // still on orbit
    && num(row[COL.incl]) !== null
    && num(row[COL.apogee]) !== null
    && num(row[COL.perigee]) !== null;
}

function toEntry(row) {
  const apogee = num(row[COL.apogee]);
  const perigee = num(row[COL.perigee]);
  const status = row[COL.status];
  return {
    id: row[COL.norad],
    name: cleanName(row[COL.name]),
    type: row[COL.type] === 'PAY' ? 'satellite' : 'debris', // R/B counts as junk
    kind: row[COL.type],                                   // PAY | R/B | DEB
    altitude: Math.round((apogee + perigee) / 2),
    inclination: Number(num(row[COL.incl]).toFixed(1)),
    launched: row[COL.launch] || null,
    status: STATUS_WORDS[status] || null // unknown codes are dropped, never guessed
  };
}

// Hand-picked, well-known objects, in the user's language. Every claim here
// is stable public history — dates themselves come from the catalog row.
const FAMOUS = [
  { match: 'ISS (ZARYA)', note: 'The International Space Station’s core module — in orbit since 1998 and still crewed.' },
  { match: 'HST', exact: true, note: 'The Hubble Space Telescope, observing from above the atmosphere since 1990.' },
  { match: 'TIANHE', note: 'Core module of China’s space station, launched in 2021.' },
  { match: 'ENVISAT', note: 'A giant eight-tonne Earth observer, silent and drifting since 2012.' },
  { match: 'VANGUARD 1', note: 'The oldest human-made object still in orbit — up there since 1958.' },
  { match: 'GOES 16', note: 'A weather satellite parked high above the equator, holding one spot all day.' },
  { match: 'GOES 18', note: 'A weather satellite parked high above the equator, holding one spot all day.' },
  { match: ['NAVSTAR', 'GPS BII'], note: 'One of the GPS navigation satellites, about 20,200 km up.' },
  { match: 'GALILEO', note: 'One of Europe’s Galileo navigation satellites in the middle band.' },
  { match: 'BEIDOU', note: 'One of China’s BeiDou navigation satellites in the middle band.' },
  { match: ['NOAA 19', 'NOAA 20', 'NOAA 21', 'NOAA'], note: 'A polar weather satellite, circling from pole to pole.' },
  { match: 'LANDSAT 9', note: 'A NASA Earth-imagery satellite tracing the land below.' },
  { match: 'TERRA', note: 'A flagship Earth-observing satellite flying in the morning orbit.' },
  { match: 'SL-16 R/B', kind: 'R/B', note: 'A heavy spent rocket stage — one of the junkyard’s workhorses.' },
  { match: 'FENGYUN 1C DEB', note: 'A fragment from the 2007 Fengyun-1C anti-satellite test.' },
  { match: 'COSMOS 2251 DEB', note: 'Debris from the 2009 Iridium–Cosmos collision.' },
  { match: 'IRIDIUM 33 DEB', note: 'Debris from the 2009 Iridium–Cosmos collision.' },
  { match: 'COSMOS 1408 DEB', note: 'Fragments from a 2021 anti-satellite test.' },
  { match: 'ARIANE 5 R/B', kind: 'R/B', note: 'A spent upper stage left behind after a launch.' },
  { match: 'CZ-4B R/B', kind: 'R/B', note: 'A spent rocket stage left in a busy low orbit.' }
];

const TARGET_SATELLITES = 32;
const TARGET_DEBRIS = 30;

// Deterministic stride sampling: sort by catalog number and take every
// n-th row, so the same objects show up on every sync and reload.
function stridePick(rows, target) {
  if (rows.length <= target) return rows.slice();
  const stride = Math.max(1, Math.floor(rows.length / target));
  const picked = [];
  for (let i = 0; i < rows.length && picked.length < target; i += stride) picked.push(rows[i]);
  return picked;
}

function curate(entries) {
  const byName = new Map();
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(entry);
  }
  // `match` may list several candidate names (the catalogue spells the same
  // object differently in different queries — "NAVSTAR 81" vs "GPS BIIR-5");
  // `kind` pins a note to a kind so an attached payload+stage pair can't
  // receive a rocket-body note.
  const bestMatch = (needle, exact, kind) => {
    const tryOne = key => {
      const ok = entry => !kind || entry.kind === kind;
      if (exact) return (byName.get(key) || []).find(ok) || null;
      for (const [name, list] of byName) {
        if (!name.includes(key)) continue;
        const hit = list.find(ok);
        if (hit) return hit;
      }
      return null;
    };
    for (const candidate of Array.isArray(needle) ? needle : [needle]) {
      const found = tryOne(candidate.toLowerCase());
      if (found) return found;
    }
    return null;
  };

  const picked = [];
  const used = new Set();
  const notes = new Map();
  for (const famous of FAMOUS) {
    const entry = bestMatch(famous.match, famous.exact, famous.kind);
    if (!entry || used.has(entry.id)) continue;
    used.add(entry.id);
    picked.push(entry);
    if (famous.note) notes.set(entry.id, famous.note);
  }

  // Fill the rest with a deterministic cross-section of what is really up
  // there. Constellations dominate the population, so payloads are drawn
  // mostly from outside them, then topped up with constellation members.
  const isConstellation = name => /^(STARLINK|ONEWEB|IRIDIUM NEXT|SWARM|KONSTELLATI|BEIDOU-3 M|GPS|STARSHIELD)/i.test(name);
  const payloads = entries.filter(e => e.kind === 'PAY' && !used.has(e.id));
  const satCount = () => picked.filter(e => e.type === 'satellite').length;
  const needPlain = Math.max(0, TARGET_SATELLITES - satCount() - 2);
  const plainPayloads = stridePick(payloads.filter(e => !isConstellation(e.name)), needPlain);
  const needConstellation = Math.max(0, TARGET_SATELLITES - satCount() - plainPayloads.length);
  for (const entry of [...plainPayloads, ...stridePick(payloads.filter(e => isConstellation(e.name)), needConstellation)]) {
    if (satCount() >= TARGET_SATELLITES || used.has(entry.id)) continue;
    used.add(entry.id);
    picked.push(entry);
  }

  const junk = entries.filter(e => e.kind !== 'PAY' && !used.has(e.id));
  const needDebris = Math.max(0, TARGET_DEBRIS - picked.filter(e => e.type === 'debris').length);
  for (const entry of stridePick(junk, needDebris)) {
    if (used.has(entry.id)) continue;
    used.add(entry.id);
    picked.push(entry);
  }

  // Honest notes built only from catalog fields — no invention.
  for (const entry of picked) {
    if (notes.has(entry.id)) { entry.note = notes.get(entry.id); continue; }
    const since = entry.launched ? ` since ${entry.launched}` : '';
    if (entry.kind === 'R/B') entry.note = `A spent rocket stage, on orbit${since}.`;
    else if (entry.kind === 'DEB') entry.note = `A catalogued fragment of debris, tracked${since}.`;
    else entry.note = `A working catalogued payload, on orbit${since}.`;
  }

  // Catalog-wide totals for honest context in the stats card.
  const totals = { payload: 0, rocketBody: 0, debris: 0 };
  for (const entry of entries) {
    if (entry.kind === 'PAY') totals.payload += 1;
    else if (entry.kind === 'R/B') totals.rocketBody += 1;
    else if (entry.kind === 'DEB') totals.debris += 1;
  }

  return { objects: picked, totals };
}

/* ── Catalog state: prefetch + disk cache ─────────────────────────────── */
// state is null until the first successful sync; `syncing` dedupes parallel
// requests. Stale cache is served while a refresh runs in the background.
const catalog = { data: null, syncing: null, stale: false, nextRetryAt: 0 };
// After a failed sync, wait before trying again — CelesTrak's usage policy
// asks for reasonable request rates, and repeated failures usually mean a
// temporary block that only clears with time.
const RETRY_COOLDOWN = 15 * 60 * 1000;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

async function fetchCsv(url) {
  // CelesTrak's CDN refuses non-browser user agents (HTTP 403), so the
  // catalogue download presents itself as an ordinary browser request.
  const response = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'text/csv,application/csv,*/*' },
    signal: AbortSignal.timeout(240000)
  });
  if (!response.ok) throw new Error(`${url.split('?')[0]} returned HTTP ${response.status}`);
  return response.text();
}

// Fallback when the bulk file is unavailable (e.g. temporarily blocked by
// the CDN after heavy use): ask CelesTrak's documented query API for the
// same SATCAT rows in groups and merge them. ~9 requests, cached a day.
async function fetchViaQueries() {
  const parts = [];
  let failures = 0;
  for (const url of SATCAT_QUERIES) {
    try {
      parts.push(await fetchCsv(url));
    } catch (error) {
      failures += 1;
      console.warn(`  query fallback: ${error.message}`);
    }
  }
  if (parts.length === 0) throw new Error(`Bulk file and all ${SATCAT_QUERIES.length} query fallbacks failed`);
  console.log(`  query fallback: ${parts.length}/${SATCAT_QUERIES.length} queries succeeded${failures ? `, ${failures} failed` : ''}`);
  return parts.join('\n');
}

async function fetchAndCurate() {
  let text;
  let partial = false;
  try {
    text = await fetchCsv(catalogUrl);
  } catch (error) {
    if (process.env.CATALOG_URL) throw error; // user's own source: no silent substitution
    console.warn(`Bulk catalogue unavailable (${error.message}); trying the CelesTrak query API instead.`);
    text = await fetchViaQueries();
    partial = true; // group queries do not cover every object in the catalogue
  }
  const rows = parseCsv(text).filter(row => row.length >= 13 && row[COL.norad] !== 'NORAD_CAT_ID');
  // Queries can return the same object twice (overlapping groups) — keep one.
  const unique = new Map();
  for (const row of rows) if (!unique.has(row[COL.norad])) unique.set(row[COL.norad], row);
  const entries = [...unique.values()].filter(isOnOrbitEarth).map(toEntry);
  if (entries.length < 100) throw new Error('Catalog returned too few on-orbit objects');
  const { objects, totals } = curate(entries);
  const data = {
    provider: 'celestrak',
    label: 'CelesTrak SATCAT',
    isSample: false,
    sourceUrl: partial ? 'https://celestrak.org/satcat/records.php' : catalogUrl,
    totalsPartial: partial,
    syncedAt: new Date().toISOString(),
    catalogTotals: { ...totals, onOrbit: totals.payload + totals.rocketBody + totals.debris },
    objectCount: objects.length,
    objects
  };
  writeFile(CACHE_FILE, JSON.stringify(data)).catch(() => { /* cache is best-effort */ });
  return data;
}

function startSync() {
  if (catalog.syncing) return catalog.syncing;
  if (Date.now() < catalog.nextRetryAt) return Promise.resolve(catalog.data);
  catalog.syncing = fetchAndCurate()
    .then(data => { catalog.data = data; catalog.stale = false; return data; })
    .catch(error => {
      catalog.nextRetryAt = Date.now() + RETRY_COOLDOWN;
      console.warn(`Catalog sync failed (${error.message}); keeping ${catalog.data ? 'cached' : 'sample'} data. Next retry in ${RETRY_COOLDOWN / 60000} min.`);
      return catalog.data;
    })
    .finally(() => { catalog.syncing = null; });
  return catalog.syncing;
}

function ensureCatalog() {
  if (catalog.data) {
    if (!catalog.stale) return Promise.resolve(catalog.data);
    // Stale cache: refresh in the background, answer immediately.
    startSync();
    return Promise.resolve(catalog.data);
  }
  // Nothing cached yet: the first request waits for the initial sync.
  return startSync();
}

// Restore the disk cache at boot (stale-while-revalidate), then refresh.
(async () => {
  try {
    if (existsSync(CACHE_FILE)) {
      const cached = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
      if (cached && Array.isArray(cached.objects) && cached.objects.length) {
        catalog.data = cached;
        catalog.stale = Date.now() - Date.parse(cached.syncedAt || 0) > CACHE_TTL;
        console.log(`  catalog    : ${cached.objects.length} cached objects (synced ${cached.syncedAt})`);
      }
    }
  } catch { /* corrupt cache — ignore and refetch */ }
  ensureCatalog().then(data => {
    if (data) console.log(`  catalog    : ready — ${data.objectCount} objects on orbit (CelesTrak SATCAT)`);
  });
})();

/* ── Report prompt ────────────────────────────────────────────────────── */
const RULES = [
  'You write short, warm "garden report" paragraphs for a playful dashboard about objects orbiting Earth.',
  'Rules: plain language, 2 or 3 short sentences, at most 65 words.',
  'Never invent measurements, positions, collision predictions, risk scores, or real-time tracking claims.',
  'Positions shown in the scene are decorative; altitudes and counts are catalogue figures.'
].join(' ');

const SYSTEM_PROMPT_REAL = [
  RULES,
  'The counts you are given are real figures from the CelesTrak satellite catalogue for the objects shown.'
].join(' ');

const SYSTEM_PROMPT_SAMPLE = [
  RULES,
  'The numbers you are given are illustrative sample counts, not live orbital data. Say so plainly.'
].join(' ');

function buildPrompt(payload) {
  const counts = payload.counts || {};
  const date = payload.gardenDate || 'today';
  const where = payload.isSample
    ? 'The illustrative sample shows'
    : 'From the CelesTrak catalogue, the view currently shows';
  return `Write today's garden report for the date ${date}. ${where} ${counts.satellites ?? 0} satellites and ${counts.debris ?? 0} debris objects. Notable pattern: ${payload.pattern || 'a balanced mix of satellites and debris markers'}.`;
}

/* ── Server ───────────────────────────────────────────────────────────── */
const server = createServer(async (req, res) => {
  if (req.url === '/api/config') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      model, ollamaUrl,
      catalog: { provider: 'celestrak', url: catalogUrl, syncedAt: catalog.data?.syncedAt || null }
    }));
    return;
  }

  if (req.url === '/api/objects') {
    const data = await ensureCatalog();
    if (data) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    } else {
      // No catalog available (offline, or CelesTrak unreachable): the client
      // keeps working from its labelled built-in sample.
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ provider: 'sample', label: 'Illustrative sample dataset', isSample: true, objects: [] }));
    }
    return;
  }

  if (req.url === '/api/report' && req.method === 'POST') {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw || '{}');
      const isSample = Boolean(payload.isSample);

      const response = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          system: isSample ? SYSTEM_PROMPT_SAMPLE : SYSTEM_PROMPT_REAL,
          prompt: buildPrompt(payload),
          stream: false,
          options: { temperature: 0.4 }
        }),
        signal: AbortSignal.timeout(25000)
      });
      if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
      const data = await response.json();
      const report = (data.response || '').trim();
      if (!report) throw new Error('The local model returned an empty report');

      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ report, model, origin: 'local', source: `Local model · ${model}` }));
    } catch (error) {
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: error.message || 'Local model unavailable', origin: 'sample' }));
    }
    return;
  }

  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
    const relativePath = relative(root, path);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) throw new Error('Invalid path');
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Not a file');
    res.writeHead(200, { 'content-type': mime[extname(path)] || 'application/octet-stream' });
    res.end(await readFile(path));
  } catch (error) {
    console.warn(`404 ${req.url} — ${error.message}`);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(port, '0.0.0.0', () => {
  const bound = server.address().port;
  console.log(`Space Junkyard Gardener → http://localhost:${bound}`);
  console.log(`  report model : ${model} (OLLAMA_MODEL)`);
  console.log(`  ollama url   : ${ollamaUrl} (OLLAMA_URL)`);
  console.log(`  catalog url  : ${catalogUrl} (CATALOG_URL)`);
});
