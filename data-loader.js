// ── Data access for Space Junkyard Gardener ──────────────────────────────
// Everything the visualization knows about *where objects come from* lives
// here. The UI only ever calls loadOrbitalData(date).
//
// By default the app shows REAL catalog data: the local backend (server.mjs)
// fetches CelesTrak's public SATCAT — the U.S. satellite catalogue — once a
// day, caches it for 24 hours and serves a curated slice at /api/objects.
// Names, altitudes, inclinations, launch dates and statuses are real
// catalogue values; marker positions in the scene stay decorative.
// If the catalogue cannot be reached (offline, or no server), the app falls
// back to the built-in labelled sample in sample-data.js, so it always works.
// To point at a different JSON source, set CATALOG_URL when starting the
// server — the endpoint must return CelesTrak-style SATCAT CSV or a JSON
// { objects: [ { name, type, altitude, inclination } ] } payload.

import { sampleObjects, sampleMeta, orbitBand, describeObject } from './sample-data.js';

let sourceConfig = {};

export function configureDataSource(config = {}) {
  sourceConfig = config;
}

// ── Scene geometry for the rotatable 3-D view ────────────────────────────
// Earth sits at the origin with radius SCENE.earthRadius, and every ring is
// a circle of radius `r` whose plane is tilted by `inc` degrees and turned
// by `node` degrees. Markers are placed on exactly these rings, so what you
// drag around always matches the drawn paths. This is decorative geometry,
// never an orbital calculation: no position is derived from time or from
// real orbital elements.
// Earth is deliberately huge relative to the rings — the front page is a
// close, OSIRIS-style look at the planet, so the globe fills most of the
// stage. `fitRadius` is the worst-case projected extent of the outer ring
// (horizontal at any yaw, vertical at the steepest pitch, plus marker
// margin); dividing by it — not by max(ring)×perspective — leaves the
// wasted headroom to the globe instead of empty space.
export const SCENE = { earthRadius: 2.4, fitRadius: 4.25, distance: 12 };

export const SCENE_RINGS = {
  leo51: { r: 2.85, inc: 51.6, node: 12 },
  leo98: { r: 3.1, inc: 98, node: 74 },
  leo74: { r: 3.35, inc: 74, node: 143 },
  meo: { r: 3.65, inc: 55, node: 205 },
  geo: { r: 3.95, inc: 0, node: 0 }
};

export function sceneRings() {
  return SCENE_RINGS;
}

// A point on a ring: a circle in the ring's own plane, tilted by `inc`
// degrees and turned by `node` degrees. `phase` is the decorative angle the
// data layer assigned. Shared by the 3-D renderer (ring meshes) and the UI
// (marker world positions) so both always describe the same paths.
export function ringPoint(ring, phase) {
  const theta = (phase * Math.PI) / 180;
  const inc = (ring.inc * Math.PI) / 180;
  const node = (ring.node * Math.PI) / 180;
  const x = ring.r * Math.cos(theta);
  const z = ring.r * Math.sin(theta);
  const y = -z * Math.sin(inc);   // tilt about X
  const z1 = z * Math.cos(inc);
  return {
    x: x * Math.cos(node) + z1 * Math.sin(node),
    y,
    z: -x * Math.sin(node) + z1 * Math.cos(node)
  };
}

// Which decorative ring an object rides on. Grouped by altitude (rough
// "how high") and then by inclination (rough "how tilted"), so it reads as
// neighbourhoods rather than as a real orbit.
export function ringFor(altitude, inclination = 0) {
  if (altitude >= 34000) return 'geo';
  if (altitude >= 2000) return 'meo';
  if (inclination >= 90) return 'leo98';
  if (inclination >= 66) return 'leo74';
  return 'leo51';
}

// The date selector only re-labels the view and nudges markers decoratively.
// It never computes a position from a timestamp.
function decorativeShift(date) {
  const days = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  return (days * 7.5) % 360;
}

function decorate(raw, date) {
  const shift = decorativeShift(date);
  return raw.map(object => ({
    ...object,
    band: orbitBand(object.altitude),
    blurb: describeObject(object),
    ring: ringFor(object.altitude, object.inclination),
    angle: (object.angle + shift) % 360
  }));
}

function normalize(entry, index) {
  const altitude = Number(entry.altitude ?? entry.altitudeKm ?? 0);
  const inclination = Number(entry.inclination ?? entry.inclinationDeg ?? 0);
  return {
    id: entry.id || `CATALOG-${String(index + 1).padStart(3, '0')}`,
    name: String(entry.name || `OBJECT ${index + 1}`),
    type: entry.type === 'debris' ? 'debris' : 'satellite',
    altitude,
    inclination,
    angle: Number.isFinite(Number(entry.angle)) ? Number(entry.angle) : (index * 137.508) % 360,
    launched: entry.launched ? String(entry.launched) : undefined,
    status: entry.status ? String(entry.status) : undefined,
    note: entry.note ? String(entry.note) : undefined
  };
}

// Real catalogue rows carry launch dates and operational status from the
// SATCAT, which the tooltip and detail panel show verbatim.
function decorateReal(raw, date) {
  const shift = decorativeShift(date);
  return raw.map(object => ({
    ...object,
    band: orbitBand(object.altitude),
    blurb: object.note || describeObject(object),
    ring: ringFor(object.altitude, object.inclination),
    angle: (object.angle + shift) % 360
  }));
}

async function loadFromServer() {
  // Generous timeout: the very first request may wait out the initial
  // one-time catalogue sync (later requests hit the 24-hour cache).
  const response = await fetch('/api/objects', { signal: AbortSignal.timeout(240000) });
  if (!response.ok) throw new Error(`Objects endpoint returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.isSample || !Array.isArray(payload.objects) || payload.objects.length === 0) {
    throw new Error(payload.error || 'Catalogue unavailable');
  }
  return payload;
}

export async function loadOrbitalData(date = new Date()) {
  if (sourceConfig.deployment === 'vercel') {
    return {
      objects: decorate(sampleObjects, date),
      date,
      source: sampleMeta.label,
      isSample: true,
      meta: sampleMeta
    };
  }
  try {
    const payload = await loadFromServer();
    return {
      objects: decorateReal(payload.objects.map(normalize), date),
      date,
      source: payload.label || 'CelesTrak SATCAT',
      isSample: false,
      meta: {
        provider: payload.provider || 'celestrak',
        label: payload.label || 'CelesTrak SATCAT',
        isSample: false,
        objectCount: payload.objects.length,
        syncedAt: payload.syncedAt || null,
        totalsPartial: Boolean(payload.totalsPartial),
        catalogTotals: payload.catalogTotals || null
      }
    };
  } catch (error) {
    console.warn(`Catalogue unavailable (${error.message}); using the built-in labelled sample instead.`);
  }
  return {
    objects: decorate(sampleObjects, date),
    date,
    source: sampleMeta.label,
    isSample: true,
    meta: sampleMeta
  };
}
