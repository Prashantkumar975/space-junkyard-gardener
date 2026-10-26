// ── The hero Earth — Originkit "Terra Dusk" + layered orbital rings ──────
// The planet itself is the Originkit terra-dusk component (installed with
//   npx originkit@latest add terra-dusk --prompt
// original TSX at components/originkit/ui/terra-dusk.tsx). That component is
// React + TypeScript, but this app has no build step, so its renderer — the
// fragment shader, texture pipeline, terminator lighting, night lights,
// cloud shadows, atmosphere halo, hover spring — is ported verbatim to the
// vanilla ES module terra-dusk.js, which this file drives.
//
// The component only draws the globe. Everything else the scene needs — the
// five orbital rings, the decorative satellites-and-debris traffic, the cyan
// network arcs with their travelling pulses — is drawn here on two 2-D
// canvases that sandwich the globe canvas:
//
//   ring-back  (z 3)  → under the planet: the opaque disc hides whatever
//                       passes behind it, exactly like a depth buffer
//   earth      (z 4)  → the Terra Dusk WebGL globe
//   ring-front (z 5)  → over the planet: the near side of every ring/arc
//
// Markers stay plain DOM elements (z 3 behind / 5–7 in front, set by
// app.js) projected through the same rotation, so they ride the rings.
//
// Everything here is decorative: rings are fixed circles, positions are
// never computed from orbital mechanics, and the globe is real imagery
// drawn as a picture — not a simulation.
//
// The surface app.js depends on:
//   mode        'webgl' normally | 'flat' when WebGL is unavailable
//   setView()   yaw / pitch / zoom / dragging straight from the UI controls
//   resize()    refit both the globe and the ring canvases to the stage box
//   project()   world point → stage pixels, with depth scale + occlusion
//   render()    draw one frame (globe, rings, swarm, arcs, pulses)

import { SCENE, sceneRings, ringPoint } from './data-loader.js';
import { createTerraDusk } from './terra-dusk.js';

const RAD = Math.PI / 180;
const D = SCENE.distance;   // depth scale constant, as in the old scene
const ER = SCENE.earthRadius;
const FIT = SCENE.fitRadius;

// A loose scatter of well-known city coordinates — only the endpoints of
// the decorative network arcs. (Surface night-lights now come from the
// component's real earth-night texture instead of a hand-made point field.)
const HUB_COORDS = [
  [40.71, -74.01], [34.05, -118.24], [41.88, -87.63], [29.76, -95.37],
  [43.7, -79.42], [25.76, -80.19], [19.43, -99.13], [47.61, -122.33],
  [39.74, -104.99], [61.22, -149.9], [64.14, -21.9], [51.51, -0.13],
  [48.86, 2.35], [40.42, -3.7], [41.9, 12.5], [52.52, 13.4],
  [59.33, 18.07], [50.45, 30.52], [55.76, 37.62], [41.01, 28.98],
  [33.57, -7.59], [30.04, 31.24], [6.52, 3.38], [-1.29, 36.82],
  [-26.2, 28.05], [25.2, 55.27], [35.69, 51.39], [24.86, 67.01],
  [19.08, 72.88], [28.61, 77.21], [22.57, 88.36], [13.76, 100.5],
  [-6.21, 106.85], [1.35, 103.82], [14.6, 120.98], [22.32, 114.17],
  [31.23, 121.47], [39.9, 116.41], [37.57, 126.98], [35.68, 139.65],
  [34.69, 135.5], [25.03, 121.57], [43.24, 76.89], [41.3, 69.24],
  [55.03, 82.92], [-33.87, 151.21], [-37.81, 144.96], [-36.85, 174.76],
  [-12.05, -77.04], [4.71, -74.07], [-23.55, -46.63], [-34.6, -58.38],
  [-33.45, -70.67], [10.82, 106.63]
];

// Ring styles — colour, opacity, and dashes in world units (converted to
// pixels per frame so they scale with zoom, like the old dashed materials).
const RING_STYLE = {
  leo51: { color: '#00e5ff', opacity: 0.55 },
  leo98: { color: '#00e5ff', opacity: 0.4, dash: [0.1, 0.085] },
  leo74: { color: '#00e5ff', opacity: 0.32 },
  meo: { color: '#448bff', opacity: 0.5, dash: [0.16, 0.09] },
  geo: { color: '#d4af37', opacity: 0.7, dash: [0.05, 0.17] }
};

function toVec(lat, lon) {
  const cl = Math.cos(lat * RAD);
  return { x: cl * Math.cos(lon * RAD), y: Math.sin(lat * RAD), z: cl * Math.sin(lon * RAD) };
}

// Decorative network arcs: great-circle-ish curves lifted ~8.5% above the
// surface between pairs of hub nodes. Built once per scene.
function buildArcs(hubs) {
  const arcs = [];
  const count = hubs.length;
  for (let i = 0; i < 22; i += 1) {
    const a = hubs[i];
    const b = hubs[(i * 11 + 7) % count];
    const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
    if (dot > 0.985) continue; // endpoints nearly identical — skip
    const omega = Math.acos(dot);
    const so = Math.sin(omega) || 1e-6;
    const samples = [];
    const n = 30;
    for (let k = 0; k <= n; k += 1) {
      const t = k / n;
      const w1 = Math.sin((1 - t) * omega) / so;
      const w2 = Math.sin(t * omega) / so;
      let x = a.x * w1 + b.x * w2;
      let y = a.y * w1 + b.y * w2;
      let z = a.z * w1 + b.z * w2;
      const len = Math.hypot(x, y, z) || 1;
      const lift = 1 + 0.085 * Math.sin(Math.PI * t);
      samples.push({
        x: (x / len) * lift * ER,
        y: (y / len) * lift * ER,
        z: (z / len) * lift * ER
      });
    }
    arcs.push({
      samples,
      pulse: i % 3 === 0,
      speed: 0.00004 + (i % 5) * 0.000012,
      offset: (i * 0.37) % 1
    });
  }
  return arcs;
}

// ── Decorative traffic: satellites and junk ────────────────────────────
// The space around the planet is populated so the scene reads as a junkyard
// at a glance: winged satellites and tumbling debris fragments ride the five
// rings, and a loose junk belt scatters fragments across its own random
// planes in a shell around Earth. Pure scenery — like the rings themselves
// it carries no data and is not clickable; every position is decorative.
// Built once per scene; the per-frame code only animates each item's angle.
// A jagged little junk shard: 3–5 vertices at random radii, pre-rotated by a
// random angle. Baking the shape + rotation once means the per-frame draw is
// just translate+scale into a path — no transform matrix per fragment.
function makeFragment() {
  const n = 3 + ((Math.random() * 3) | 0);
  const pts = [];
  const a0 = Math.random() * Math.PI * 2;
  for (let i = 0; i < n; i += 1) {
    const a = a0 + (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.7;
    const r = 0.45 + Math.random() * 0.65;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

function buildTraffic() {
  const RIDE = {
    leo51: { sats: 11, debris: 52 },
    leo98: { sats: 10, debris: 58 },
    leo74: { sats: 10, debris: 52 },
    meo: { sats: 8, debris: 38 },
    geo: { sats: 9, debris: 26 }
  };
  // Kepler-ish angular speed: ω ∝ r^-1.5, so lower orbits visibly travel
  // faster than higher ones — the ordering is what reads as "real" motion.
  const KEPLER_K = 2.6 * Math.pow(2.85, 1.5); // tuned so LEO ≈ 2.6 deg/s
  const sats = [];
  const debris = [];
  for (const [id, ring] of Object.entries(sceneRings())) {
    const cfg = RIDE[id] || RIDE.leo51;
    const base = KEPLER_K * Math.pow(ring.r, -1.5); // deg/s
    for (let i = 0; i < cfg.sats; i += 1) {
      sats.push({
        ring,
        phase: (i / cfg.sats) * 360 + Math.random() * (360 / cfg.sats) * 0.6,
        speed: base * (0.92 + Math.random() * 0.16),
        size: 0.042 + Math.random() * 0.03,
        gold: Math.random() < 0.32
      });
    }
    for (let i = 0; i < cfg.debris; i += 1) {
      debris.push({
        ring,
        phase: Math.random() * 360,
        speed: (Math.random() < 0.16 ? -1 : 1) * base * (0.24 + Math.random() * 0.46),
        size: 0.014 + Math.random() * 0.03,
        poly: makeFragment(),
        silver: Math.random() < 0.66
      });
    }
  }
  return { sats, debris };
}

// The junk belt: fragments on their own orbital planes (random inclination
// and node) in a shell between the inner and outer rings, so the space
// around Earth looks populated rather than like five clean lanes.
function buildBelt(count = 200) {
  const belt = [];
  for (let i = 0; i < count; i += 1) {
    belt.push({
      ring: { r: 2.6 + Math.random() * 1.32, inc: Math.random() * 130 - 15, node: Math.random() * 360 },
      phase: Math.random() * 360,
      speed: (Math.random() < 0.2 ? -1 : 1) * (0.2 + Math.random() * 0.7),
      size: 0.011 + Math.random() * 0.02,
      poly: makeFragment(),
      silver: Math.random() < 0.72
    });
  }
  return belt;
}

/* ── Colour helper ───────────────────────────────────────────────────── */
const RGB_CACHE = new Map();
function rgba(hex, a) {
  let rgb = RGB_CACHE.get(hex);
  if (!rgb) {
    const n = parseInt(hex.slice(1), 16);
    rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    RGB_CACHE.set(hex, rgb);
  }
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ── Flat fallback (no WebGL) ────────────────────────────────────────── */
// The planet isn't drawn, but rings still are — they are plain 2-D lines
// and need no GPU. Markers, tooltips, data and reports all keep working.
function createFlatProjector(getView) {
  let w = 0;
  let h = 0;
  const measure = el => { w = el.clientWidth; h = el.clientHeight; };
  measure._el = measure; // placeholder, real measure happens in resize below
  return {
    resize(el) { measure(el); },
    project(point) {
      if (!w || !h) return null;
      const view = getView();
      const unit = (Math.min(w, h) / (2 * FIT)) * view.zoom;
      const cosY = Math.cos(view.yaw);
      const sinY = Math.sin(view.yaw);
      const x1 = point.x * cosY + point.z * sinY;
      const z1 = -point.x * sinY + point.z * cosY;
      const cosP = Math.cos(view.pitch);
      const sinP = Math.sin(view.pitch);
      const y2 = point.y * cosP - z1 * sinP;
      const z2 = point.y * sinP + z1 * cosP;
      const scale = D / Math.max(0.01, D - z2);
      return { x: w / 2 + x1 * scale * unit, y: h / 2 - y2 * scale * unit, z: z2, scale, behind: false };
    }
  };
}

/* ── Scene ───────────────────────────────────────────────────────────── */
export function createEarthScene(canvas) {
  const backCv = document.getElementById('ringBack');
  const frontCv = document.getElementById('ringFront');
  const bctx = backCv.getContext('2d');
  const fctx = frontCv.getContext('2d');

  const view = { yaw: -0.6, pitch: 0.38, zoom: 1 };

  // The planet: Originkit Terra Dusk, driven by app.js's view. Pointer
  // position on the stage feeds its cursor-sun and hover tilt; drag itself
  // stays owned by app.js (markers, pinch-zoom and picking depend on it).
  const terra = createTerraDusk({
    canvas,
    input: canvas.parentElement || canvas,
    earthRadius: ER,
    fitRadius: FIT,
    stars: 4          // in-shader twinkling stars over the CSS starfield
  });
  const mode = terra ? 'webgl' : 'flat';
  const flat = mode === 'flat' ? createFlatProjector(() => view) : null;

  /* Ring/arc geometry, sampled once — the paths never change */
  const ringDefs = Object.entries(sceneRings()).map(([id, ring]) => {
    const style = RING_STYLE[id] || RING_STYLE.leo51;
    const N = 160;
    const pts = [];
    for (let i = 0; i <= N; i += 1) pts.push(ringPoint(ring, (i % N) * (360 / N)));
    return { pts, style };
  });
  const traffic = buildTraffic();
  const belt = buildBelt();
  const allBits = traffic.debris.concat(belt); // one array, no per-frame concat
  const arcs = buildArcs(HUB_COORDS.map(([lat, lon]) => toVec(lat, lon)));

  /* Ring-canvas sizing (≥1.5× supersampling like the old renderer) */
  let rw = 0;
  let rh = 0;
  let pr = 1.5;
  function sizeRingCanvas(cv, ctx, w, h, dpr) {
    let scale = Math.min(2, Math.max(1.5, dpr || 1));
    if (w * h * scale * scale > 4e6) scale = Math.sqrt(4e6 / Math.max(1, w * h));
    cv.width = Math.max(1, Math.round(w * scale));
    cv.height = Math.max(1, Math.round(h * scale));
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    return scale;
  }

  function resize() {
    rw = canvas.clientWidth;
    rh = canvas.clientHeight;
    pr = sizeRingCanvas(backCv, bctx, rw, rh, window.devicePixelRatio);
    sizeRingCanvas(frontCv, fctx, rw, rh, window.devicePixelRatio);
    terra?.resize();
    flat?.resize(canvas);
  }

  /* ── Projection ─────────────────────────────────────────────────────── */
  // World point → stage pixels. The Terra Dusk globe is orthographic, so
  // positions are linear through the same rotation the shader used;
  // `z` (view depth, globe units) decides which ring canvas a segment
  // lands on, and `behind` marks points the planet hides.
  function project(point) {
    if (terra) {
      const v = terra.project(point.x / ER, point.y / ER, point.z / ER);
      if (!v) return null;
      const zWorld = v.z * ER;
      const scale = clamp(D / Math.max(0.01, D - zWorld), 0.7, 1.55);
      return { x: v.x, y: v.y, z: v.z, scale, behind: v.behind };
    }
    return flat.project(point);
  }

  function setView(next) {
    if (Number.isFinite(next.yaw)) view.yaw = next.yaw;
    if (Number.isFinite(next.pitch)) view.pitch = next.pitch;
    if (Number.isFinite(next.zoom)) view.zoom = next.zoom;
    terra?.setView(next);
  }

  /* ── 2-D layer drawing ──────────────────────────────────────────────── */
  // Split a projected polyline into front (z ≥ 0) and back (z < 0) runs,
  // interpolating the exact plane crossing so both canvases meet without a
  // gap. Layering does the occlusion: the opaque globe hides back runs
  // inside its disc while back runs outside the silhouette stay visible.
  function collectRuns(proj) {
    const runs = { back: [], front: [] };
    let cur = null;
    let curSide = null;
    for (let i = 0; i < proj.length; i += 1) {
      const p = proj[i];
      const side = p.z >= 0 ? 'front' : 'back';
      if (cur && side !== curSide) {
        const q = proj[i - 1];
        const dz = q.z - p.z;
        const t = Math.abs(dz) > 1e-9 ? q.z / dz : 0.5;
        const mid = { x: q.x + (p.x - q.x) * t, y: q.y + (p.y - q.y) * t, z: 0 };
        cur.push(mid);
        cur = [mid];
        runs[side].push(cur);
      } else if (!cur) {
        cur = [];
        runs[side].push(cur);
      }
      cur.push(p);
      curSide = side;
    }
    return runs;
  }

  function strokeRun(ctx, pts, style, pxPerWorld, isFront) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (style.dash) ctx.setLineDash(style.dash.map(d => d * pxPerWorld));
    // Soft underpass: a dark halo on the front canvas keeps cyan readable
    // over the bright dayside; a coloured glow lifts back lines off space
    // (a cheap stand-in for the old bloom pass).
    if (isFront) {
      ctx.strokeStyle = 'rgba(4,8,16,0.42)';
      ctx.lineWidth = style.w + 1.8;
    } else {
      ctx.strokeStyle = rgba(style.color, style.opacity * 0.16);
      ctx.lineWidth = style.w + 3;
    }
    ctx.stroke();
    ctx.strokeStyle = rgba(style.color, style.opacity);
    ctx.lineWidth = style.w;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawRings(pxPerWorld) {
    for (const def of ringDefs) {
      const proj = [];
      let ok = true;
      for (const p of def.pts) {
        const v = project(p);
        if (!v) { ok = false; break; }
        proj.push(v);
      }
      if (!ok) continue;
      const runs = collectRuns(proj);
      for (const pts of runs.back) strokeRun(bctx, pts, def.style, pxPerWorld, false);
      for (const pts of runs.front) strokeRun(fctx, pts, def.style, pxPerWorld, true);
    }
  }

  // Batched draws: one path per style per side keeps the fill count near a
  // dozen no matter how many fragments are on screen. Per-item rotation is
  // applied with setTransform (no save/restore), so tumbling chips cost
  // almost nothing.
  function drawTraffic(now, pxPerWorld) {
    const t = now || 0;
    const S = pr; // supersample factor already baked into the canvas transform
    const groups = {
      back: { satCyan: [], satGold: [], debSil: [], debAmb: [] },
      front: { satCyan: [], satGold: [], debSil: [], debAmb: [] }
    };

    // Satellites drift along their ring, wings aligned to travel direction.
    for (const sat of traffic.sats) {
      const a = sat.phase + (t * sat.speed) / 1000;
      const v = project(ringPoint(sat.ring, a));
      if (!v) continue;
      if (v.behind) continue; // inside the globe disc on the back canvas — invisible
      const ahead = project(ringPoint(sat.ring, a + 1.6));
      groups[v.z >= 0 ? 'front' : 'back'][sat.gold ? 'satGold' : 'satCyan'].push({
        x: v.x,
        y: v.y,
        ang: ahead ? Math.atan2(ahead.y - v.y, ahead.x - v.x) : 0,
        s: Math.max(2.4, sat.size * pxPerWorld)
      });
    }

    // Debris fragments drift slowly, each a pre-baked jagged shard.
    for (const bit of allBits) {
      const a = bit.phase + (t * bit.speed) / 1000;
      const v = project(ringPoint(bit.ring, a));
      if (!v) continue;
      if (v.behind) continue; // hidden under the opaque globe — skip the work
      groups[v.z >= 0 ? 'front' : 'back'][bit.silver ? 'debSil' : 'debAmb'].push({
        x: v.x,
        y: v.y,
        s: Math.max(1.15, bit.size * pxPerWorld),
        poly: bit.poly
      });
    }

    const SAT_STYLE = {
      satCyan: { halo: 'rgba(110,220,255,', body: 'rgba(165,240,255,', wing: 'rgba(92,186,228,' },
      satGold: { halo: 'rgba(212,175,55,', body: 'rgba(255,238,196,', wing: 'rgba(212,175,55,' }
    };
    const DEB_STYLE = {
      debSil: 'rgba(196,210,226,',
      debAmb: 'rgba(226,166,84,'
    };

    for (const side of ['back', 'front']) {
      const ctx = side === 'back' ? bctx : fctx;
      const g = groups[side];
      const k = side === 'back' ? 0.66 : 1;

      if (side === 'front') {
        // Soft dark separation so objects stay readable over the bright
        // dayside — axis-aligned device-space rects, no per-item matrices.
        ctx.fillStyle = 'rgba(4,8,16,0.3)';
        ctx.beginPath();
        for (const key of ['satCyan', 'satGold'])
          for (const d of g[key]) ctx.rect((d.x - d.s * 1.75) * S, (d.y - d.s * 0.95) * S, d.s * 3.5 * S, d.s * 1.9 * S);
        for (const key of ['debSil', 'debAmb'])
          for (const d of g[key]) ctx.rect((d.x - d.s * 1.05) * S, (d.y - d.s * 0.85) * S, d.s * 2.1 * S, d.s * 1.7 * S);
        ctx.fill();
      }

      // Satellites: soft halo, then a real silhouette — central bus, two
      // solar-panel wings, and a small dish — aligned to travel direction.
      for (const key of ['satCyan', 'satGold']) {
        const sats = g[key];
        if (!sats.length) continue;
        const style = SAT_STYLE[key];
        ctx.fillStyle = style.halo + 0.1 * k + ')';
        ctx.beginPath();
        for (const d of sats) { ctx.rect((d.x - d.s * 2.5) * S, (d.y - d.s * 2.5) * S, d.s * 5 * S, d.s * 5 * S); }
        ctx.fill();

        // Wings (solar panels) — two panels either side of the bus.
        ctx.fillStyle = style.wing + 0.6 * k + ')';
        ctx.beginPath();
        for (const d of sats) {
          ctx.setTransform(S, 0, 0, S, d.x * S, d.y * S);
          const c = Math.cos(d.ang), n = Math.sin(d.ang);
          ctx.transform(c, n, -n, c, 0, 0);
          ctx.rect(-d.s * 2.1, -d.s * 0.62, d.s * 1.15, d.s * 1.24);   // left panel
          ctx.rect(d.s * 0.95, -d.s * 0.62, d.s * 1.15, d.s * 1.24);   // right panel
          ctx.setTransform(S, 0, 0, S, 0, 0);
        }
        ctx.fill();

        // Panel cell lines (thin darker grid over the wings).
        ctx.strokeStyle = 'rgba(4,10,18,' + (0.5 * k).toFixed(3) + ')';
        ctx.lineWidth = Math.max(0.5, sats[0].s * 0.14);
        ctx.beginPath();
        for (const d of sats) {
          ctx.setTransform(S, 0, 0, S, d.x * S, d.y * S);
          const c = Math.cos(d.ang), n = Math.sin(d.ang);
          ctx.transform(c, n, -n, c, 0, 0);
          for (const side of [-1, 1]) {
            const px = side < 0 ? -d.s * 1.525 : d.s * 1.525;
            ctx.moveTo(px, -d.s * 0.62); ctx.lineTo(px, d.s * 0.62);
          }
          ctx.setTransform(S, 0, 0, S, 0, 0);
        }
        ctx.stroke();

        // Bright central bus + a small dish on the leading edge.
        ctx.fillStyle = style.body + 0.96 * k + ')';
        ctx.beginPath();
        for (const d of sats) {
          ctx.setTransform(S, 0, 0, S, d.x * S, d.y * S);
          const c = Math.cos(d.ang), n = Math.sin(d.ang);
          ctx.transform(c, n, -n, c, 0, 0);
          ctx.rect(-d.s * 0.6, -d.s * 0.44, d.s * 1.2, d.s * 0.88);    // bus
          ctx.moveTo(d.s * 0.6, -d.s * 0.16);
          ctx.arc(d.s * 0.82, 0, d.s * 0.3, -1.2, 1.2);                 // dish
          ctx.setTransform(S, 0, 0, S, 0, 0);
        }
        ctx.fill();
      }

      // Debris: baked jagged shards, batched per colour.
      for (const key of ['debSil', 'debAmb']) {
        const bits = g[key];
        if (!bits.length) continue;
        ctx.fillStyle = DEB_STYLE[key] + (key === 'debSil' ? 0.85 : 0.8) * k + ')';
        ctx.beginPath();
        for (const d of bits) {
          const p = d.poly;
          ctx.moveTo((d.x + p[0].x * d.s) * S, (d.y + p[0].y * d.s) * S);
          for (let i = 1; i < p.length; i += 1) ctx.lineTo((d.x + p[i].x * d.s) * S, (d.y + p[i].y * d.s) * S);
          ctx.closePath();
        }
        ctx.fill();
      }
    }
  }

  function drawArcs(now) {
    const style = { color: '#00e5ff', opacity: 0.5, w: 0.9 };
    for (const arc of arcs) {
      const proj = [];
      let ok = true;
      for (const s of arc.samples) {
        const v = project(s);
        if (!v) { ok = false; break; }
        proj.push(v);
      }
      if (!ok) continue;
      const runs = collectRuns(proj);
      for (const pts of runs.back) strokeRun(bctx, pts, style, 1, false);
      for (const pts of runs.front) strokeRun(fctx, pts, style, 1, true);
      if (!arc.pulse) continue;
      // Travelling pulse along the arc, drawn on whichever side it is on.
      const t = ((now * arc.speed) + arc.offset) % 1;
      const f = t * (arc.samples.length - 1);
      const i0 = Math.min(arc.samples.length - 2, Math.floor(f));
      const ft = f - i0;
      const a = arc.samples[i0];
      const b = arc.samples[i0 + 1];
      const v = project({
        x: a.x + (b.x - a.x) * ft,
        y: a.y + (b.y - a.y) * ft,
        z: a.z + (b.z - a.z) * ft
      });
      if (!v) continue;
      const ctx = v.z >= 0 ? fctx : bctx;
      const alpha = Math.sin(Math.PI * t) * 0.95;
      ctx.fillStyle = `rgba(201,247,255,${0.18 * alpha})`;
      ctx.beginPath();
      ctx.arc(v.x, v.y, 6.5, 0, 6.2832);
      ctx.fill();
      ctx.fillStyle = `rgba(220,250,255,${alpha})`;
      ctx.beginPath();
      ctx.arc(v.x, v.y, 2.4, 0, 6.2832);
      ctx.fill();
    }
  }

  function drawLayers(now) {
    if (rw < 40 || rh < 40) return; // Overview hidden — nothing to draw
    bctx.clearRect(0, 0, rw, rh);
    fctx.clearRect(0, 0, rw, rh);
    const metrics = terra ? terra.metrics() : null;
    const pxPerWorld = terra
      ? metrics.Rd / ER
      : (Math.min(rw, rh) / (2 * FIT)) * view.zoom;
    drawRings(pxPerWorld);
    drawTraffic(now, pxPerWorld);
    drawArcs(now);
  }

  /* ── Frame ──────────────────────────────────────────────────────────── */
  function render(now = 0) {
    terra?.render(now);   // first: publishes this frame's rotation + metrics
    drawLayers(now);      // then: rings/traffic/arcs project through it
  }

  resize();

  return { mode, setView, resize, project, render };
}
