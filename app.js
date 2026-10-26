// ── Space Junkyard Gardener — presentation layer ─────────────────────────
// This file draws a small rotatable 3-D scene and wires the interface up.
// Where objects come from lives in data-loader.js, how they are stored lives
// in sample-data.js, and how the plain-language report is produced lives in
// report-generator.js. Nothing in here computes a real orbit: the scene is
// decorative geometry you can spin around Earth.

import { loadOrbitalData, configureDataSource, sceneRings, ringPoint } from './data-loader.js';
import { generateReport, configureReportSource } from './report-generator.js';
import { createEarthScene } from './earth-scene.js';

const $ = selector => document.querySelector(selector);
const PAGE_TITLES = { overview: 'OVERVIEW', garden: 'ORBIT GARDEN', history: 'HISTORY' };
const HISTORY_KEY = 'sjg.history.v1';
const HISTORY_LIMIT = 24;
const HOME_VIEW = { yaw: -0.6, pitch: 0.38, zoom: 1 };

const stage = $('#orbitStage');
const layer = $('#objectLayer');
const tooltip = $('#objectTooltip');
const dateInput = $('#reportDate');
const earthCanvas = $('#earthCanvas');
const earthScene = createEarthScene(earthCanvas);
const zoomReadout = $('#zoomReadout');
const spinToggle = $('#spinToggle');
const stageNotice = $('#stageNotice');

// No WebGL? The planet can't be drawn — say so plainly and keep every
// other part of the app (data, markers, tooltips, reports) fully usable.
if (earthScene.mode === 'flat' && stageNotice) stageNotice.hidden = false;

const state = {
  config: {},
  objects: [],
  meta: { isSample: true },
  pinnedId: null,
  gardenFilter: 'all',
  gardenSelectedId: null,
  gardenDate: '',
  history: []
};

// Camera for the 3-D view: yaw spins Earth left/right, pitch tilts it up and
// down (capped at ±π so it can't run away, but free enough to look from over
// the poles, straight underneath, or fully inverted), zoom scales the whole
// scene. All of it is a decorative viewpoint.
const view = { yaw: HOME_VIEW.yaw, pitch: HOME_VIEW.pitch, zoom: HOME_VIEW.zoom, spin: true, dragging: false };
const markerEls = new Map();          // object id → button element
const projected = new Map();          // object id → last projected point
const pointers = new Map();           // active pointers during a drag/pinch
let pinchStart = 0;
let zoomAtPinch = 1;
let dragDistance = 0;
let lastInteraction = 0;

/* ── Navigation ─────────────────────────────────────────── */
function navigate(page) {
  if (!PAGE_TITLES[page]) return;
  // The Overview page is a full-screen scene: the shell chrome (sidebar,
  // top bar, status footer) only exists on the other two pages.
  document.body.classList.toggle('page-overview', page === 'overview');
  document.querySelectorAll('.page').forEach(section => {
    const active = section.dataset.page === page;
    section.hidden = !active;
    section.classList.toggle('active', active);
  });
  document.querySelectorAll('.nav-link, .hud-link').forEach(link => {
    const active = link.dataset.page === page;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('#currentPage').textContent = PAGE_TITLES[page];
  if (page === 'overview') {
    // Sizes are readable again now — refit the 3-D camera, then re-place markers.
    earthScene.resize();
    updateMarkers();
  }
  if (page === 'garden') renderGarden();
  if (page === 'history') renderHistory();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-goto]');
  if (!trigger) return;
  event.preventDefault();
  navigate(trigger.dataset.goto);
});

/* ── 3-D scene maths ────────────────────────────────────── */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function stageSize() {
  return { w: stage.clientWidth, h: stage.clientHeight };
}



/* ── Scene rendering ────────────────────────────────────── */
// Projects every object's world position through the live 3-D camera and
// places its DOM marker. Markers the planet is hiding are dimmed and made
// unclickable — spin the scene and they come back around.
function updateMarkers() {
  const { w, h } = stageSize();
  if (w < 40 || h < 40) return; // Overview page is hidden — nothing to draw

  // Subtle starfield parallax follows the rotation (only visible in the
  // flat fallback — the WebGL starfield parallaxes on its own).
  stage.style.setProperty('--sky-x', `${(-view.yaw * 16).toFixed(1)}px`);
  stage.style.setProperty('--sky-y', `${(view.pitch * 14).toFixed(1)}px`);
  if (zoomReadout) zoomReadout.textContent = `ZOOM ×${view.zoom.toFixed(2)}`;

  const rings = sceneRings();
  state.objects.forEach(object => {
    const el = markerEls.get(object.id);
    if (!el) return;
    const ring = rings[object.ring] || rings.leo51;
    const pt = earthScene.project(ringPoint(ring, object.angle));
    if (!pt) return;
    el.style.left = `${((pt.x / w) * 100).toFixed(3)}%`;
    el.style.top = `${((pt.y / h) * 100).toFixed(3)}%`;
    el.style.setProperty('--depth', (0.82 + 0.49 * (pt.scale - 0.77)).toFixed(3));
    el.style.zIndex = pt.behind ? '3' : String(6 + Math.round((pt.scale - 1) * 2));
    el.style.opacity = pt.behind ? '0.55' : '1';
    // Behind the planet: dimmed *and* inert, so no click can land on a
    // marker the globe is hiding.
    el.style.pointerEvents = pt.behind ? 'none' : '';
    projected.set(object.id, pt);
  });

  if (state.pinnedId) positionTooltip(state.pinnedId);
}

/* ── Markers ────────────────────────────────────────────── */
function createMarkers() {
  layer.replaceChildren();
  markerEls.clear();

  state.objects.forEach((object, index) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `orbital-object ${object.type}`;
    dot.dataset.id = object.id;
    dot.style.setProperty('--size', `${object.type === 'satellite' ? (index % 5 === 0 ? 7 : 6) : (index % 4 === 0 ? 4 : 5)}px`);
    dot.title = object.name;
    // The visible marker rides inside the button, so the button can be a
    // thumb-friendly 30px hit target while the dot stays a tiny speck.
    const glyph = document.createElement('i');
    glyph.className = 'dot';
    glyph.setAttribute('aria-hidden', 'true');
    dot.append(glyph);
    dot.setAttribute(
      'aria-label',
      `${object.name}. ${object.type}. ${state.meta.isSample ? 'Illustrative altitude' : 'Catalogue altitude'} ${object.altitude.toLocaleString()} kilometres, ${object.band}. ${state.meta.isSample ? 'Sample object — decorative position.' : 'Catalogue object — decorative position in this scene.'}`
    );

    dot.addEventListener('mouseenter', () => { if (!state.pinnedId && !view.dragging) showTooltip(object); });
    dot.addEventListener('mouseleave', () => { if (!state.pinnedId) hideTooltip(); });
    dot.addEventListener('focus', () => { if (!state.pinnedId) showTooltip(object); });
    dot.addEventListener('blur', () => { if (!state.pinnedId) hideTooltip(); });
    dot.addEventListener('click', event => {
      event.stopPropagation();
      if (dragDistance > 6) return; // that was a drag to rotate, not a pick
      if (state.pinnedId === object.id) {
        clearSelection();
      } else {
        layer.querySelector('.selected')?.classList.remove('selected');
        state.pinnedId = object.id;
        dot.classList.add('selected');
        showTooltip(object);
      }
      updateHint();
    });

    layer.append(dot);
    markerEls.set(object.id, dot);
  });

  if (state.pinnedId) {
    const selected = markerEls.get(state.pinnedId);
    if (selected) selected.classList.add('selected');
  }
}

function showTooltip(object) {
  const typeEl = tooltip.querySelector('.tooltip-type');
  typeEl.textContent = object.type === 'debris' ? 'ORBITAL DEBRIS' : 'SATELLITE';
  typeEl.className = `tooltip-type ${object.type}`;
  tooltip.querySelector('.tooltip-name').textContent = object.name;
  tooltip.querySelector('.tooltip-altitude').textContent = `${state.meta.isSample ? 'Illustrative altitude' : 'Catalogue altitude'} · ${object.altitude.toLocaleString()} km`;
  tooltip.querySelector('.tooltip-extra').textContent = `Inclination ${object.inclination}° · ${object.band}${object.status ? ` · ${object.status}` : ''}`;
  tooltip.querySelector('.tooltip-note').textContent = object.blurb || '';
  tooltip.classList.add('visible');
  positionTooltip(object.id);
}

function positionTooltip(id) {
  if (!tooltip.classList.contains('visible')) return;
  const pt = projected.get(id);
  if (!pt) return;
  const { w, h } = stageSize();
  const left = Math.min(Math.max(10, pt.x + 16), Math.max(10, w - 225));
  const top = Math.min(Math.max(10, pt.y - 74), Math.max(10, h - 140));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTooltip() {
  tooltip.classList.remove('visible');
}

// Touch screens have no hover, so the instructions say "tap" instead of
// "click" — same behaviour, honest wording.
const coarsePointer = window.matchMedia('(hover: none)');

function updateHint() {
  const hint = $('#exploreHint');
  const pinned = state.objects.find(object => object.id === state.pinnedId);
  const verb = coarsePointer.matches ? 'tap a marker' : 'click a marker';
  hint.classList.toggle('active', Boolean(pinned));
  hint.innerHTML = pinned
    ? `<span class="hint-star">✳</span> Select an object to explore · ${escapeHtml(pinned.name)}`
    : `<span class="hint-star">✳</span> Select an object to explore · drag to rotate · ${verb} to inspect`;
}

function clearSelection() {
  state.pinnedId = null;
  layer.querySelector('.selected')?.classList.remove('selected');
  hideTooltip();
  updateHint();
}

function selectInFieldView(id) {
  const object = state.objects.find(item => item.id === id);
  if (!object) return;
  navigate('overview');
  updateMarkers();
  const dot = markerEls.get(id);
  if (!dot) return;
  clearSelection();
  state.pinnedId = id;
  dot.classList.add('selected');
  showTooltip(object);
  updateHint();
  dot.focus({ preventScroll: true });
}

stage.addEventListener('click', event => {
  if (event.target.closest('.orbital-object')) return;
  if (dragDistance > 6) return; // finished a rotate, don't clear the pick
  clearSelection();
});

/* ── Drag to rotate · pinch / buttons to zoom ───────────── */
function pointerDistance() {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

stage.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  dragDistance = 0;
  lastInteraction = performance.now();
  if (pointers.size === 1) {
    view.dragging = true;
    stage.classList.add('dragging');
    if (!state.pinnedId) hideTooltip(); // hover tips get in the way while turning
  }
  if (pointers.size === 2) {
    pinchStart = pointerDistance();
    zoomAtPinch = view.zoom;
  }
});

window.addEventListener('pointermove', event => {
  if (!pointers.has(event.pointerId)) return;
  const previous = pointers.get(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  lastInteraction = performance.now();
  if (pointers.size === 1) {
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    dragDistance += Math.abs(dx) + Math.abs(dy);
    view.yaw += dx * 0.0068;
    // Full tumble: pitch is only capped at ±π so the view can be turned to
    // any direction — over the poles, straight underneath, fully inverted.
    view.pitch = clamp(view.pitch + dy * 0.0055, -Math.PI, Math.PI);
  } else if (pointers.size === 2 && pinchStart > 0) {
    view.zoom = clamp(zoomAtPinch * (pointerDistance() / pinchStart), 0.8, 1.5);
  }
});

function endPointer(event) {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinchStart = 0;
  if (pointers.size === 0) {
    view.dragging = false;
    stage.classList.remove('dragging');
  }
  lastInteraction = performance.now();
}
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);

// Wheel / trackpad-pinch zoom. Only while the Overview is a full-screen
// scene (desktop): in the stacked mobile/tablet column the page must scroll
// under the cursor, so the wheel is left alone below 901px.
const heroLayout = window.matchMedia('(min-width: 901px)');
stage.addEventListener('wheel', event => {
  if (!heroLayout.matches) return;
  event.preventDefault(); // stops ctrl+wheel (trackpad pinch) from page-zooming
  setZoom(view.zoom - event.deltaY * 0.0011);
}, { passive: false });

function setZoom(next) {
  view.zoom = clamp(next, 0.8, 1.5);
  lastInteraction = performance.now();
}

$('#zoomIn').addEventListener('click', () => setZoom(view.zoom + 0.15));
$('#zoomOut').addEventListener('click', () => setZoom(view.zoom - 0.15));

spinToggle.addEventListener('click', () => {
  view.spin = !view.spin;
  spinToggle.setAttribute('aria-pressed', String(view.spin));
  spinToggle.textContent = view.spin ? '◐ Auto-spin' : '○ Auto-spin';
  lastInteraction = performance.now();
});

$('#resetView').addEventListener('click', () => {
  view.yaw = HOME_VIEW.yaw;
  view.pitch = HOME_VIEW.pitch;
  view.zoom = HOME_VIEW.zoom;
  lastInteraction = performance.now();
  clearSelection();
});

// Reference-style hero CTA: clears any pick, eases the view in a touch
// and hands the scene back to the auto-spin.
$('#explore3d')?.addEventListener('click', () => {
  clearSelection();
  view.spin = true;
  spinToggle.setAttribute('aria-pressed', 'true');
  spinToggle.textContent = '◐ Auto-spin';
  setZoom(1.12);
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => earthScene.resize(), 120);
});

/* ── Animation loop ─────────────────────────────────────── */
// The browser drops frame callbacks scheduled while a tab is hidden, which
// would otherwise kill a plain requestAnimationFrame chain for good. Each
// call to startLoop() takes over with a fresh token, so a stale chain can
// never double up, and the visibility/pageshow handlers restart the loop the
// moment the page becomes visible again.
let loopToken = 0;

function frameWork() {
  if (stageSize().w < 40) return; // Overview hidden — skip the work
  const idleFor = performance.now() - lastInteraction;
  if (view.spin && !view.dragging && !state.pinnedId && idleFor > 2600) {
    view.yaw += 0.0011; // a slow, gentle drift so the scene reads as 3-D
  }
  // The WebGL scene draws every frame (arc pulses keep flowing); the DOM
  // marker layer is re-projected through the same camera each time.
  earthScene.setView(view);
  earthScene.render(performance.now());
  updateMarkers();
}

function startLoop() {
  const token = ++loopToken;
  const step = () => {
    if (token !== loopToken) return; // a newer chain took over
    try {
      frameWork();
    } finally {
      requestAnimationFrame(step); // one bad frame must never kill the loop
    }
  };
  requestAnimationFrame(step);
}

function reviveLoop() {
  startLoop();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) reviveLoop();
});
window.addEventListener('pageshow', reviveLoop);

/* ── Stats ──────────────────────────────────────────────── */
function counts() {
  const satellites = state.objects.filter(object => object.type === 'satellite').length;
  return { satellites, debris: state.objects.length - satellites, total: state.objects.length };
}

function patternLine() {
  const { satellites, debris } = counts();
  const sample = state.meta.isSample;
  if (debris === satellites) return sample
    ? 'Satellite and debris markers are evenly balanced in this sample.'
    : 'Satellites and debris fragments are evenly balanced in this catalogue view.';
  if (debris > satellites) return sample
    ? 'Debris markers outnumber working satellites here — a quiet nod to what gets left behind.'
    : 'Debris fragments outnumber working satellites in this catalogue view — a quiet nod to what gets left behind.';
  return sample
    ? 'Working satellites make up the larger share of this little sample sky.'
    : 'Working satellites make up the larger share of this catalogue view.';
}

function renderStats(data) {
  const { satellites, debris, total } = counts();
  const lowOrbit = state.objects.filter(object => object.altitude < 2000).length;
  // Null-safe: some of these live only on the Overview page.
  const set = (selector, value) => {
    const el = $(selector);
    if (el) el.textContent = String(value);
  };
  set('#statsTotal', total);
  // Proportion bar: satellites vs debris as a single split track.
  const satPct = total ? (satellites / total) * 100 : 50;
  const barSat = $('#barSat');
  const barDeb = $('#barDeb');
  if (barSat && barDeb) {
    barSat.style.width = `${satPct.toFixed(1)}%`;
    barDeb.style.width = `${(100 - satPct).toFixed(1)}%`;
  }
  set('#rowSat', satellites);
  set('#rowDeb', debris);
  set('#rowLeo', lowOrbit);
  set('#rowHigh', total - lowOrbit);
  set('#datasetStatus', `${data.source.toUpperCase()} · ${total} OBJECTS`);
  // The note under the stats card carries the source's honest framing —
  // real catalogue scale when real, the sample disclaimer otherwise.
  const statsNote = $('.stats-note');
  if (statsNote && state.meta.catalogTotals?.onOrbit) {
    // Full sync knows the whole on-orbit population; the query fallback only
    // covers CelesTrak's groups, so it must not claim catalogue-wide totals.
    statsNote.textContent = state.meta.totalsPartial
      ? `Real catalogue values · positions decorative · ${total} objects in view from CelesTrak’s queried groups.`
      : `Real catalogue values · positions decorative · ${total} of ${state.meta.catalogTotals.onOrbit.toLocaleString()} objects currently on orbit.`;
  }
  set('#countAll', total);
  set('#countSatellite', satellites);
  set('#countDebris', debris);
  fillTicker();
}

// The footer status ticker scrolls the sample object names — two identical
// halves so the loop is seamless. Decorative, like everything else here.
function fillTicker() {
  const track = $('#tickerTrack');
  if (!track || state.objects.length === 0) return;
  const chunk = `${state.objects.map(object => object.name).join('  ✳  ')}  ✳  `;
  track.replaceChildren();
  for (let i = 0; i < 2; i += 1) {
    const half = document.createElement('span');
    half.textContent = chunk;
    track.append(half);
  }
}

/* ── Report ─────────────────────────────────────────────── */
async function refreshReport() {
  const button = $('#generateButton');
  button.disabled = true;
  button.textContent = 'Generating locally…';
  const copyEl = $('#reportCopy');
  copyEl.textContent = 'Asking the local model for a few thoughts…';
  copyEl.classList.add('working'); // gold shimmer while the model writes

  const { satellites, debris } = counts();
  const pattern = patternLine();
  const result = await generateReport({ counts: { satellites, debris }, pattern, gardenDate: state.gardenDate, isSample: state.meta.isSample });

  copyEl.textContent = result.report;
  copyEl.classList.remove('working');
  $('#reportSource').textContent = result.source;
  $('#reportSource').title = result.detail ? `Source detail: ${result.detail}` : result.source;
  $('#reportSourceDot').classList.toggle('sample', result.origin === 'sample');
  button.disabled = false;
  button.textContent = 'Generate with local AI';

  recordHistory({ counts: { satellites, debris }, pattern, result, catalog: !state.meta.isSample });
}

$('#generateButton').addEventListener('click', refreshReport);

/* ── Report history (this browser only) ─────────────────── */
function loadHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (Array.isArray(stored)) state.history = stored;
  } catch {
    state.history = [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
  } catch {
    /* storage unavailable — the log simply stays in memory */
  }
}

function recordHistory({ counts: c, pattern, result, catalog }) {
  const entry = {
    id: `${Date.now()}`,
    at: new Date().toISOString(),
    gardenDate: state.gardenDate,
    origin: result.origin,
    source: result.source,
    model: result.model || null,
    catalog: Boolean(catalog),
    counts: c,
    pattern,
    report: result.report
  };
  // Don't file the same report twice — e.g. when the page is reloaded.
  const latest = state.history[0];
  if (latest && latest.report === entry.report && latest.origin === entry.origin && latest.gardenDate === entry.gardenDate) return;
  state.history.unshift(entry);
  state.history = state.history.slice(0, HISTORY_LIMIT);
  saveHistory();
  renderHistory();
}

function renderHistory() {
  const list = $('#historyList');
  const empty = $('#historyEmpty');
  if (!list || !empty) return;
  list.replaceChildren();
  const hasEntries = state.history.length > 0;
  empty.hidden = hasEntries;

  state.history.forEach(entry => {
    const item = document.createElement('article');
    item.className = 'history-item';
    const when = new Date(entry.at);
    const isSample = entry.origin === 'sample';
    item.innerHTML = `
      <div class="history-meta">
        <span class="history-when">${escapeHtml(formatTime(when))}</span>
        <span class="history-date">GARDEN DATE ${escapeHtml(entry.gardenDate || '—')}</span>
        <span class="origin-badge ${isSample ? 'sample' : ''}">${isSample ? 'SAMPLE FALLBACK' : `LOCAL MODEL · ${escapeHtml((entry.model || 'ollama').toUpperCase())}`}</span>
        <span class="history-counts">${entry.counts.satellites} SAT · ${entry.counts.debris} DEB · ${entry.catalog ? 'REAL CATALOG' : 'ILLUSTRATIVE SAMPLE'}</span>
      </div>
      <p class="history-report">${escapeHtml(entry.report)}</p>`;
    list.append(item);
  });
}

$('#clearHistory')?.addEventListener('click', () => {
  state.history = [];
  saveHistory();
  renderHistory();
});

/* ── Orbit Garden page ──────────────────────────────────── */
// Altitude → 0–100 fill for the card meter. The sample spans ~390 km
// (TIANGONG) to 35,786 km (geostationary), so a linear scale would squash
// every low object into the first few percent — a sqrt scale keeps the LEO
// crowd readable while still showing the high orbits sit far out.
function altitudeFill(altitude) {
  const MAX_ALT = 36000;
  const pct = Math.sqrt(Math.max(0, altitude) / MAX_ALT) * 100;
  return Math.max(4, Math.min(100, pct)).toFixed(1);
}

function renderGarden() {
  const grid = $('#gardenGrid');
  if (!grid) return;
  grid.replaceChildren();
  const items = state.objects.filter(object => state.gardenFilter === 'all' || object.type === state.gardenFilter);

  items.forEach(object => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `garden-card ${object.type}${state.gardenSelectedId === object.id ? ' selected' : ''}`;
    card.dataset.id = object.id;
    card.innerHTML = `
      <span class="card-type">${object.type === 'debris' ? 'DEBRIS' : 'SATELLITE'}</span>
      <strong>${escapeHtml(object.name)}</strong>
      <span class="card-meta">${object.altitude.toLocaleString()} km · ${object.inclination}°</span>
      <span class="card-alt-meter" aria-hidden="true"><i style="width:${altitudeFill(object.altitude)}%"></i></span>
      <span class="card-id">${escapeHtml(object.id)}</span>`;
    card.addEventListener('click', () => selectGardenObject(object.id));
    grid.append(card);
  });

  if (state.gardenSelectedId) showGardenDetail(state.gardenSelectedId);
}

function selectGardenObject(id) {
  state.gardenSelectedId = id;
  document.querySelectorAll('.garden-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.id === id);
  });
  showGardenDetail(id);
}

function showGardenDetail(id) {
  const object = state.objects.find(item => item.id === id);
  const panel = $('#gardenDetail');
  if (!object || !panel) return;
  $('#detailEmpty').hidden = true;
  $('#detailBody').hidden = false;
  panel.classList.toggle('debris', object.type === 'debris');
  $('#detailType').textContent = object.type === 'debris' ? 'ORBITAL DEBRIS' : 'SATELLITE';
  $('#detailName').textContent = object.name;
  $('#detailAltitude').textContent = `${object.altitude.toLocaleString()} km`;
  $('#detailInclination').textContent = `${object.inclination}°`;
  $('#detailBand').textContent = object.band;
  $('#detailId').textContent = object.id;
  $('#detailNote').textContent = `${object.blurb} ${state.meta.isSample
    ? 'Illustrative entry — decorative position, not a real state vector.'
    : 'Catalogue entry — the position drawn here is decorative, not a real state vector.'}`;
}

document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    state.gardenFilter = chip.dataset.filter;
    document.querySelectorAll('.filter-chip').forEach(other => other.classList.toggle('active', other === chip));
    renderGarden();
  });
});

$('#showInOrbit')?.addEventListener('click', () => {
  if (state.gardenSelectedId) selectInFieldView(state.gardenSelectedId);
});

/* ── Date selector ──────────────────────────────────────── */
/* ── Data-source labelling ──────────────────────────────── */
// Every chip, status line and note that describes *where the numbers come
// from* is rewritten here from one place, so the sample and real-catalogue
// wordings can never drift apart across the interface. The trust lines
// ("not a precise orbit simulator or collision warning system") are true for
// both sources and are never touched.
function applySourceLabels() {
  const real = !state.meta.isSample;
  document.querySelectorAll('[data-source]').forEach(el => el.classList.toggle('real', real));
  const set = (selector, html) => { const el = $(selector); if (el) el.innerHTML = html; };

  set('[data-source="pill"]', `<span class="pill-dot"></span> ${real ? 'REAL CATALOG · CELESTRAK' : 'SAMPLE DATA'}`);
  set('[data-source="chip"]', `<span class="pill-dot"></span> ${real ? 'REAL CATALOG · CELESTRAK' : 'SAMPLE DATA'}`);
  set('[data-source="top"]', real
    ? '<span class="live-dot"></span> REAL CATALOG · CELESTRAK <span class="top-divider">/</span> POSITIONS DECORATIVE'
    : '<span class="live-dot"></span> ILLUSTRATIVE SAMPLE DATA <span class="top-divider">/</span> NOT LIVE TRACKING');
  set('[data-source="herostatus"]', `<span class="status-dot"></span> ${real ? 'REAL CATALOG · POSITIONS DECORATIVE' : 'ILLUSTRATIVE SAMPLE · NOT LIVE TRACKING'}`);
  set('[data-source="toolbar"]', real ? 'REAL CATALOG VALUES · CELESTRAK SATCAT' : 'ILLUSTRATIVE SAMPLE · NOT A LIVE CATALOG');
  set('[data-source="altlabel"]', real ? 'Catalogue altitude' : 'Illustrative altitude');
  set('[data-source="incllabel"]', real ? 'Catalogue inclination' : 'Illustrative inclination');
  set('[data-source="idlabel"]', real ? 'NORAD catalogue no.' : 'Sample ID');

  // Footer hint speaks the user's device language: "tap" on touch, "click" otherwise.
  const verb = coarsePointer.matches ? 'TAP' : 'CLICK';
  set('[data-source="foothint"]', `DRAG TO ROTATE · ${verb} A MARKER TO INSPECT · ${real ? 'REAL CATALOG · POSITIONS DECORATIVE' : 'ILLUSTRATIVE — NOT LIVE TRACKING'}`);

  // The About dialog tells the truth about the current source.
  const synced = state.meta.syncedAt
    ? new Date(state.meta.syncedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  set('#aboutDataNote', real
    ? `Names, altitudes, inclinations, launch dates and statuses come from CelesTrak’s SATCAT — the public satellite catalogue — ${synced ? `synced ${synced} and ` : ''}cached on this machine for a day at a time. Marker positions, rings and the scene remain decorative: nothing here calculates trajectories, proximity or collision risk.`
    : 'The app runs on a small, fixed sample of familiar satellite and debris names held in sample-data.js. Marker positions, altitudes and counts are decorative: real orbital data changes constantly, and this view never calculates trajectories, proximity or collision risk. No collision predictions or risk scores are shown anywhere.');
  if (state.config?.deployment === 'vercel') {
    set('#aboutReportNote', 'The hosted site uses a plain-language sample summary. The local Ollama model is available only when you run the app on your own machine.');
    set('#modelTitle', 'HOSTED MODE');
    set('#modelHint', 'sample summary');
  }
}

async function updateView() {
  state.gardenDate = dateInput.value;
  const date = new Date(`${dateInput.value}T12:00:00`);
  const data = await loadOrbitalData(Number.isNaN(date.getTime()) ? new Date() : date);
  state.objects = data.objects;
  state.meta = data.meta;
  clearSelection();
  createMarkers();
  renderStats(data);
  applySourceLabels();
  renderGarden();
  updateMarkers();
  await refreshReport();
}

dateInput.addEventListener('change', updateView);

/* ── Helpers ────────────────────────────────────────────── */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

function formatTime(date) {
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

/* ── About dialog ───────────────────────────────────────── */
const dialog = $('#aboutDialog');
$('#aboutButton').addEventListener('click', () => dialog.showModal());
$('#aboutHud')?.addEventListener('click', () => dialog.showModal());
$('#closeDialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
});

/* ── ZULU clock (HUD readout, top bar) ──────────────────── */
const zuluEl = $('#zuluClock');
function tickZulu() {
  if (!zuluEl) return;
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  zuluEl.textContent = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}Z`;
}
tickZulu();
setInterval(tickZulu, 1000);

/* ── Boot ───────────────────────────────────────────────── */
async function init() {
  const today = new Date();
  dateInput.value = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  // Everything synchronous runs before the first await, so a frame that
  // arrives early (pageshow, visibilitychange) can never race the setup.
  loadHistory();
  renderHistory();
  startLoop();

  const config = await fetch('/api/config').then(response => response.json()).catch(() => ({}));
  state.config = config;
  configureDataSource(config);
  configureReportSource(config);
  $('#modelConfig').textContent = config.deployment === 'vercel' ? 'not connected' : (config.model || 'llama3.2:3b');

  await updateView();
}

init();
