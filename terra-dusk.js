// ── Terra Dusk — the photoreal WebGL globe ───────────────────────────────
// Ported from Originkit's `terra-dusk` component, installed with
//   npx originkit@latest add terra-dusk --prompt
// (original source kept at components/originkit/ui/terra-dusk.tsx).
//
// The component ships as React + TSX, but this app has no build step, so its
// renderer — fragment shader, texture pipeline, terminator lighting, night
// lights, cloud shadows, atmosphere halo, hover spring — is ported here as a
// plain ES module with the same behaviour. Interaction policy differs on
// purpose: the component drags itself, while here app.js owns yaw/pitch/zoom
// (markers, tooltips and pinch-zoom depend on that), so this module only
// listens for pointer position to drive the cursor-following sun and the
// gentle hover tilt.
//
// Textures are bundled locally under assets/terra/ so the planet renders with
// no network at all. Every texture is allowed to fail gracefully: the globe
// fades in whichever maps have arrived (uHave), and with none it degrades to
// a dark sphere with the atmosphere still lit.

const ASSETS = '/assets/terra/';
const DAY_SRC = ASSETS + 'earth-blue-marble.jpg';
const NIGHT_SRC = ASSETS + 'earth-night.jpg';
const WATER_SRC = ASSETS + 'earth-water.png';
const TOPO_SRC = ASSETS + 'earth-topology.png';
const CLOUD_SRC = ASSETS + 'clouds.png';

const TEX_W = 2048;
const TEX_H = 1024;
const DAY_W = 4096;    // day map keeps full source res so zooming in stays sharp
const NIGHT_W = 4096;
const AXIAL_TILT = (23.44 * Math.PI) / 180;
const CLOUD_DRIFT = 0.012 * 1.88; // component: speed(9.4)/5 × CLOUD_DRIFT, rad/s
const CURSOR_SUN_Z = 0.55;
const HOVER_TURN = 0.2;
const HOVER_SOFT = 1.4;
const HOVER_LIFT = 0.025;
const HOVER_K = 60;
const HOVER_C = 11;
const STAR_PARALLAX = 0.35;
const FADE_S = 0.6;
const MAX_PIXELS = 5e6;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const DEFAULT_LOOK = { clouds: 5, lights: 5, atmosphere: '#4F9BFF' };

/* ── Texture loading ─────────────────────────────────────────────────── */
// Each source is decoded once into a canvas (or a single greyscale channel
// for the water/topology/cloud aux maps) and cached module-wide.

const PIX_CACHE = new Map();

function loadPix(src, channel, width = TEX_W) {
  const key = src + '#' + channel + '@' + width;
  const hit = PIX_CACHE.get(key);
  if (hit) return hit;
  const e = { state: 'loading', canvas: null, chan: null };
  PIX_CACHE.set(key, e);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.onload = () => {
    try {
      const cv = document.createElement('canvas');
      cv.width = width;
      cv.height = width / 2;
      const cx = cv.getContext('2d');
      if (!cx) throw new Error('no 2d');
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(img, 0, 0, width, width / 2);
      const data = cx.getImageData(0, 0, channel < 0 ? 1 : TEX_W, channel < 0 ? 1 : TEX_H).data;
      if (channel < 0) e.canvas = cv;
      else {
        const out = new Uint8Array(TEX_W * TEX_H);
        for (let i = 0; i < out.length; i += 1) out[i] = data[i * 4 + channel];
        e.chan = out;
      }
      e.state = 'ready';
    } catch {
      e.state = 'failed';
    }
  };
  img.onerror = () => { e.state = 'failed'; };
  img.src = src;
  return e;
}

/* ── Colour parsing ──────────────────────────────────────────────────── */
const COLOR_CACHE = new Map();
function rgbOf(c) {
  const hit = COLOR_CACHE.get(c);
  if (hit) return hit;
  let out = [0, 0, 0];
  let s = (c || '').trim();
  if (s.startsWith('var(')) s = s.slice(s.indexOf(',') + 1);
  if (s[0] === '#') {
    let hx = s.slice(1);
    if (hx.length === 3 || hx.length === 4) hx = hx.split('').map(x => x + x).join('');
    const n = parseInt(hx.slice(0, 6), 16);
    if (!isNaN(n)) out = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  } else {
    const m = s.match(/[\d.]+/g);
    if (m && m.length >= 3) out = [+m[0], +m[1], +m[2]];
  }
  COLOR_CACHE.set(c, out);
  return out;
}

/* ── Matrix maths (as in the component) ──────────────────────────────── */
const mul3 = (a, b) =>
  a.map(row => [0, 1, 2].map(j => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const rotX = a => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const rotY = a => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const rotZ = a => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
const apply3 = (m, v) => [0, 1, 2].map(r => m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]);
const orbit = (hx, hy) => mul3(rotY(hx), rotX(-hy));

// Builds the rotation the shader uses: view-space normal → globe space.
// Returns the matrix rows as well, so markers and rings can be projected
// through the exact same rotation the pixels used.
function globeFromView(yaw, pitch, view) {
  const worldFromView = view[0].map((_, c) => view.map(row => row[c]));
  return mul3(mul3(mul3(rotY(-yaw), rotX(-pitch)), rotZ(-AXIAL_TILT)), worldFromView);
}

/* ── Shaders (verbatim from the component) ───────────────────────────── */
const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
precision highp float;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uDpr;
uniform mat3 uRot;
uniform float uCloudRot;
uniform vec3 uLight;
uniform vec3 uAtmo;
uniform float uClouds;
uniform float uLights;
uniform float uStars;
uniform float uTime;
uniform vec2 uStarShift;
uniform vec4 uHave;
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform sampler2D uAux;

const float PI = 3.14159265;
const float TAU = 6.28318531;
const float GLOW = 0.07;
const float BUMP = 2.2;
const float SHADOW_REACH = 0.012;
const float EXPOSURE = 1.7;
const vec3 MOON = vec3(0.008, 0.012, 0.024);
const float STAR_CELL = 7.0;
const float STAR_SHARE = 0.16;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec2 equi(vec3 q, float shift) {
    float u1 = fract(atan(q.x, q.z) / TAU + 0.5 + shift);
    float u2 = fract(u1 + 0.5) - 0.5;
#ifdef GL_OES_standard_derivatives
    float u = fwidth(u1) < fwidth(u2) - 0.001 ? u1 : u2;
#else
    float u = u1;
#endif
    return vec2(u, acos(clamp(q.y, -1.0, 1.0)) / PI);
}

void main() {
    vec2 frag = gl_FragCoord.xy;
    vec2 p = (frag - uCenter) / uRadius;
    float r = length(p);
    vec2 s = r > 0.999 ? p / r * 0.999 : p;
    vec3 n = vec3(s, sqrt(max(0.0, 1.0 - dot(s, s))));
    vec3 q = uRot * n;
    vec3 L = uRot * uLight;
    vec3 H = uRot * normalize(uLight + vec3(0.0, 0.0, 1.0));
    float cl = max(length(q.xz), 1e-4);
    vec3 east = vec3(q.z, 0.0, -q.x) / cl;
    vec3 north = cross(q, east);

    vec2 uv = equi(q, 0.0);
    vec2 uvc = equi(q, -uCloudRot / TAU);
    vec3 day = texture2D(uDay, uv).rgb;
    vec3 night = texture2D(uNight, uv).rgb;
    float nightGlow = texture2D(uNight, uv, 3.0).r;
    vec4 aux = texture2D(uAux, uv);
    float hE = texture2D(uAux, uv + vec2(1.5 / 2048.0, 0.0)).g;
    float hN = texture2D(uAux, uv - vec2(0.0, 1.5 / 1024.0)).g;
    vec2 toSun = vec2(dot(L, east) / (TAU * cl), -dot(L, north) / PI) * SHADOW_REACH;
    float cloud = texture2D(uAux, uvc).b;
    float shadow = texture2D(uAux, uvc + toSun).b;

    float water = aux.r * uHave.z;
    float dry = 1.0 - water;
    vec3 nb = normalize(q - BUMP * uHave.z * dry * ((hE - aux.g) * east + (hN - aux.g) * north));
    float ndlS = dot(q, L);
    float ndl = dot(nb, L);
    float mu = n.z;

    vec3 sun = mix(vec3(1.0, 0.45, 0.22), vec3(1.0), smoothstep(0.0, 0.3, ndlS));

    vec3 alb = mix(vec3(0.010, 0.016, 0.030), pow(day, vec3(2.2)), uHave.x);
    float diff = max(ndl, 0.0) * smoothstep(-0.08, 0.12, ndlS);
    vec3 col = alb * sun * diff;

    float nh = max(dot(q, H), 0.0);
    col += sun * water * (pow(nh, 240.0) * 0.22 + pow(nh, 24.0) * 0.025) * smoothstep(0.0, 0.25, ndlS);

    float cov = clamp(cloud * uClouds, 0.0, 1.0) * uHave.w;
    float shade = clamp(shadow * uClouds, 0.0, 1.0) * uHave.w;
    col *= 1.0 - 0.55 * shade;

    float dark = 1.0 - smoothstep(-0.16, 0.06, ndlS);

    col += alb * MOON * dark;

    float li = clamp((night.r - 0.035) / 0.40, 0.0, 1.0);
    float lg = clamp((nightGlow - 0.035) / 0.40, 0.0, 1.0);
    vec3 lamp = mix(vec3(1.0, 0.46, 0.13), vec3(1.0, 0.84, 0.62), smoothstep(0.35, 0.9, li));
    vec3 city = lamp * li * li * 2.4 + vec3(1.0, 0.42, 0.12) * lg * 0.45;
    col += city * uLights * dark * (1.0 - 0.85 * cov) * (0.35 + 0.65 * mu) * uHave.y;

    float cdiff = smoothstep(-0.12, 0.25, ndlS) * (0.2 + 0.8 * max(ndlS, 0.0));
    col = mix(col, vec3(0.92, 0.94, 0.97) * (sun * cdiff + MOON * dark), cov);

    float lit = smoothstep(-0.35, 0.5, ndlS);
    float rim = 1.0 - mu;
    col = mix(col, uAtmo * 0.35 * lit, pow(rim, 3.0) * 0.55);
    col += uAtmo * (pow(rim, 1.6) * 0.05 + pow(rim, 6.0) * 0.8) * lit;
    col += vec3(1.0, 0.38, 0.12) * pow(rim, 3.0) * exp(-ndlS * ndlS / 0.012) * 0.22;

    float ia = clamp((1.0 - r) * uRadius + 0.5, 0.0, 1.0);
    float t = max(r - 1.0, 0.0) / GLOW;
    float halo = exp(-t * 3.5) * (1.0 - smoothstep(0.0, 1.0, t));
    float hl = smoothstep(-0.5, 0.7, dot(vec3(p / max(r, 1e-4), 0.0), uLight));
    vec3 lin = col * ia + uAtmo * halo * hl * 0.9 * (1.0 - ia);

    vec3 x = lin * EXPOSURE;
    vec3 rgb = pow(clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0), vec3(1.0 / 2.2));

    if (uStars > 0.0) {
        vec2 sp = (frag + uStarShift) / (STAR_CELL * uDpr);
        vec2 id = floor(sp);
        float h0 = hash(id);
        if (h0 < uStars * STAR_SHARE) {
            vec2 pos = vec2(hash(id + 17.3), hash(id + 41.9)) * 0.7 + 0.15;
            float d = length(fract(sp) - pos) * STAR_CELL;
            float mag = pow(hash(id + 7.1), 5.0);
            float tw = 0.7 + 0.3 * sin(uTime * (0.6 + 2.0 * hash(id + 3.3)) + h0 * 80.0);
            float star = exp(-d * d / (0.25 + 0.6 * mag)) * (0.15 + 0.85 * mag) * tw;
            rgb += vec3(star) * (1.0 - ia) * (1.0 - clamp(halo * 1.5, 0.0, 1.0));
        }
    }

    gl_FragColor = vec4(rgb, max(ia, max(rgb.r, max(rgb.g, rgb.b))));
}`;

/* ── GL setup ────────────────────────────────────────────────────────── */
function makeGL(canvas) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false });
  if (!gl) return null;
  gl.getExtension('OES_standard_derivatives');
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  const shader = (type, src) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('TerraDusk:', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = shader(gl.VERTEX_SHADER, VERT);
  const fs = shader(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = {};
  for (const name of [
    'uCenter', 'uRadius', 'uDpr', 'uRot', 'uCloudRot', 'uLight', 'uAtmo', 'uClouds', 'uLights',
    'uStars', 'uTime', 'uStarShift', 'uHave', 'uDay', 'uNight', 'uAux',
  ]) u[name] = gl.getUniformLocation(prog, name);
  const tex = [];
  for (let i = 0; i < 3; i += 1) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    tex.push(t);
  }
  gl.uniform1i(u.uDay, 0);
  gl.uniform1i(u.uNight, 1);
  gl.uniform1i(u.uAux, 2);
  return { gl, u, tex, held: ['', '', ''] };
}

function upload(g, slot, src) {
  const { gl } = g;
  gl.activeTexture(gl.TEXTURE0 + slot);
  gl.bindTexture(gl.TEXTURE_2D, g.tex[slot]);
  if (src instanceof Uint8Array) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TEX_W, TEX_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.generateMipmap(gl.TEXTURE_2D);
}

const AUX_CACHE = new Map();
function auxFor(water, topo, cloud, key) {
  const hit = AUX_CACHE.get(key);
  if (hit) return hit;
  const out = new Uint8Array(TEX_W * TEX_H * 4);
  for (let i = 0, k = 0; i < TEX_W * TEX_H; i += 1, k += 4) {
    out[k] = water ? water[i] : 0;
    out[k + 1] = topo ? topo[i] : 0;
    out[k + 2] = cloud ? cloud[i] : 0;
    out[k + 3] = 255;
  }
  AUX_CACHE.clear();
  AUX_CACHE.set(key, out);
  return out;
}

/**
 * Create the globe renderer on an existing <canvas>.
 *
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas  target canvas (fills its stage via CSS)
 * @param {HTMLElement} [opts.input]      element that reports pointer position (defaults to canvas)
 * @param {number} opts.earthRadius       scene units the globe radius spans
 * @param {number} opts.fitRadius         scene units half the short stage edge spans (at zoom 1)
 * @param {number} [opts.stars]           in-shader star density 0–10
 * @param {number} [opts.hover]           cursor hover-tilt strength 0–10 (0 disables)
 * @param {'cursor'|'fixed'} [opts.sun]   light follows the cursor, or stays at sunAngle
 * @param {number} [opts.sunAngle]        fixed light angle in degrees
 * @param {number} [opts.daylight]        0–100, how much of the disc faces the light
 * @returns {null | {
 *   resize: () => void,
 *   setView: (v: {yaw:number, pitch:number, zoom:number, dragging?:boolean}) => void,
 *   render: (timeMs: number) => void,
 *   project: (gx:number, gy:number, gz:number) => ({x:number, y:number, z:number, behind:boolean} | null),
 *   dispose: () => void
 * }} null when WebGL is unavailable (caller falls back to the flat scene)
 */
export function createTerraDusk(opts) {
  const {
    canvas,
    input = canvas,
    earthRadius,
    fitRadius,
    stars = 4,
    hover = 6.8,
    sun = 'cursor',
    sunAngle = 181,
    daylight = 87,
    look: lookOverride = {},
  } = opts;

  const g = makeGL(canvas);
  if (!g) return null;
  const { gl, u } = g;

  const view = { yaw: -0.6, pitch: 0.38, zoom: 1, dragging: false };
  let W = 0;
  let H = 0;
  let dpr = 1;
  let ready = false;

  // CSS-pixel metrics of the current frame — the single source of truth for
  // project(): markers and rings must land exactly where the shader drew.
  let cx = 0;
  let cy = 0;
  let Rd = 0;

  const resize = () => {
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    if (W * H * dpr * dpr > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / Math.max(1, W * H));
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    ready = W > 1 && H > 1;
  };
  resize();

  const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduce = !!(mq && mq.matches);
  const onMq = () => { reduce = !!(mq && mq.matches); };
  mq?.addEventListener?.('change', onMq);

  /* ── Pointer position: feeds the cursor sun + hover tilt only ─────── */
  let px = 0;
  let py = 0;
  let over = false;
  const onMove = e => {
    const b = canvas.getBoundingClientRect();
    px = (e.clientX - b.left) * (b.width ? W / b.width : 1);
    py = (e.clientY - b.top) * (b.height ? H / b.height : 1);
    over = true;
  };
  const onLeave = () => { over = false; };
  input.addEventListener('pointermove', onMove, { passive: true });
  input.addEventListener('pointerleave', onLeave, { passive: true });
  input.addEventListener('pointerdown', onMove, { passive: true });

  /* ── Frame state ──────────────────────────────────────────────────── */
  const rot = new Float32Array(9);   // column-major view→globe, for uRot
  let M = null;                      // same matrix as rows, for project()
  const have = [0, 0, 0, 0];
  let last = -1;
  let time = 0;
  let cloudRot = 0;
  const hov = { x: 0, vx: 0, y: 0, vy: 0, lift: 0, vl: 0 };
  let lx = NaN;
  let ly = 0;
  let lz = 0;
  let auxKey = '';

  const setView = next => {
    if (Number.isFinite(next.yaw)) view.yaw = next.yaw;
    if (Number.isFinite(next.pitch)) view.pitch = next.pitch;
    if (Number.isFinite(next.zoom)) view.zoom = next.zoom;
    view.dragging = !!next.dragging;
  };

  const render = now => {
    const dt = last < 0 ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!ready) return;
    time += dt;
    const look = { ...DEFAULT_LOOK, ...lookOverride };

    /* Textures: upload each source once it has decoded (verbatim policy) */
    const day = loadPix(DAY_SRC, -1, DAY_W);
    const want = [[day, DAY_SRC], [loadPix(NIGHT_SRC, -1, NIGHT_W), NIGHT_SRC]];
    want.forEach(([pix, src], slot) => {
      if (pix.state === 'ready' && pix.canvas && g.held[slot] !== src) {
        upload(g, slot, pix.canvas);
        g.held[slot] = src;
      }
    });
    const water = loadPix(WATER_SRC, 0);
    const topo = loadPix(TOPO_SRC, 0);
    const cloud = loadPix(CLOUD_SRC, 3);
    const key = [water, topo, cloud].map(x => (x.state === 'ready' ? 1 : 0)).join('');
    if (key !== auxKey && key !== '000') {
      upload(g, 2, auxFor(water.chan, topo.chan, cloud.chan, key));
      auxKey = key;
    }
    const targets = [g.held[0] ? 1 : 0, g.held[1] ? 1 : 0, water.chan ? 1 : 0, cloud.chan ? 1 : 0];
    const fk = 1 - Math.exp(-dt / FADE_S);
    for (let i = 0; i < 4; i += 1) have[i] += (targets[i] - have[i]) * fk;

    cloudRot += (reduce ? 0 : dt) * CLOUD_DRIFT;

    // CSS-pixel geometry: half the short stage edge covers fitRadius scene
    // units, of which the globe spans earthRadius — scaled by zoom.
    const cxCss = W / 2;
    const cyCss = H / 2;
    const RCss = Math.max(20, (Math.min(W, H) / 2) * (earthRadius / fitRadius) * view.zoom);

    /* Hover spring (component behaviour; drag is owned by app.js) */
    const hk = reduce ? 0 : Math.max(0, hover) / 5;
    const soft = v => Math.tanh(HOVER_SOFT * clamp(v, -1.5, 1.5)) / Math.tanh(HOVER_SOFT);
    let gx = 0;
    let gy = 0;
    let gl2 = 0;
    if (view.dragging) {
      gx = hov.x;
      gy = hov.y;
      gl2 = 1;
    } else if (over && hk > 0) {
      gx = soft((px - cxCss) / Math.max(1, cxCss)) * HOVER_TURN * hk;
      gy = -soft((py - cyCss) / Math.max(1, cyCss)) * HOVER_TURN * hk;
      gl2 = Math.hypot(px - cxCss, py - cyCss) < RCss * 1.1 ? 1 : 0;
    }
    const steps = Math.ceil(dt * 120);
    for (let i = 0; i < steps; i += 1) {
      const h = dt / steps;
      hov.vx += (HOVER_K * (gx - hov.x) - HOVER_C * hov.vx) * h;
      hov.x += hov.vx * h;
      hov.vy += (HOVER_K * (gy - hov.y) - HOVER_C * hov.vy) * h;
      hov.y += hov.vy * h;
      hov.vl += (HOVER_K * (gl2 - hov.lift) - HOVER_C * hov.vl) * h;
      hov.lift += hov.vl * h;
    }
    const viewM = orbit(hov.x, hov.y);
    M = globeFromView(view.yaw, view.pitch, viewM);
    for (let c = 0; c < 3; c += 1) for (let r = 0; r < 3; r += 1) rot[c * 3 + r] = M[r][c];
    const RdCss = RCss * (1 + HOVER_LIFT * hov.lift * Math.min(1, hk));

    /* Light: follows the cursor when allowed, else the fixed angle */
    const ang = (sunAngle * Math.PI) / 180;
    const tz0 = clamp(daylight / 50 - 1, -0.98, 1);
    const flat = Math.sqrt(1 - tz0 * tz0);
    let tx = Math.cos(ang) * flat;
    let ty = Math.sin(ang) * flat;
    let tz = tz0;
    if (sun === 'cursor' && over) {
      const w = apply3(rotX(hov.y), apply3(rotY(-hov.x), [
        clamp((px - cxCss) / RCss, -2.5, 2.5),
        clamp(-(py - cyCss) / RCss, -2.5, 2.5),
        CURSOR_SUN_Z,
      ]));
      tx = w[0];
      ty = w[1];
      tz = w[2];
    }
    const tl = Math.hypot(tx, ty, tz) || 1;
    if (isNaN(lx)) {
      lx = tx / tl;
      ly = ty / tl;
      lz = tz / tl;
    } else {
      const lk = 1 - Math.exp(-dt / 0.35);
      lx += (tx / tl - lx) * lk;
      ly += (ty / tl - ly) * lk;
      lz += (tz / tl - lz) * lk;
    }
    const ll = Math.hypot(lx, ly, lz) || 1;
    const Lv = apply3(viewM, [lx / ll, ly / ll, lz / ll]);

    const at = rgbOf(look.atmosphere);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // gl_FragCoord is in device pixels: feed the shader device-pixel geometry.
    gl.uniform2f(u.uCenter, canvas.width / 2, canvas.height / 2);
    gl.uniform1f(u.uRadius, RdCss * dpr);
    gl.uniform1f(u.uDpr, dpr);
    gl.uniformMatrix3fv(u.uRot, false, rot);
    gl.uniform1f(u.uCloudRot, cloudRot);
    gl.uniform3f(u.uLight, Lv[0], Lv[1], Lv[2]);
    gl.uniform3f(u.uAtmo, (at[0] / 255) ** 2.2, (at[1] / 255) ** 2.2, (at[2] / 255) ** 2.2);
    gl.uniform1f(u.uClouds, Math.max(0, look.clouds) / 5);
    gl.uniform1f(u.uLights, Math.max(0, look.lights) / 5);
    gl.uniform1f(u.uStars, clamp(stars / 10, 0, 1));
    gl.uniform1f(u.uTime, reduce ? 0 : time);
    gl.uniform2f(u.uStarShift, hov.x * RCss * dpr * STAR_PARALLAX, hov.y * RCss * dpr * STAR_PARALLAX);
    gl.uniform4f(u.uHave, have[0], have[1], have[2], have[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Publish this frame's geometry in CSS px for the marker/ring layers.
    cx = cxCss;
    cy = cyCss;
    Rd = RdCss;
  };

  /**
   * Project a globe-space point (globe radius = 1) to CSS pixels through the
   * rotation of the most recent frame. The globe renders as an orthographic
   * disc, so positions are linear; `behind` marks points the planet hides.
   */
  const project = (gx, gy, gz) => {
    if (!ready || !M) return null;
    const n0 = M[0][0] * gx + M[1][0] * gy + M[2][0] * gz;
    const n1 = M[0][1] * gx + M[1][1] * gy + M[2][1] * gz;
    const n2 = M[0][2] * gx + M[1][2] * gy + M[2][2] * gz;
    const rr = Math.hypot(n0, n1);
    return {
      x: cx + n0 * Rd,
      y: cy - n1 * Rd,
      z: n2,
      behind: n2 < 0 && rr < 1,
    };
  };

  const dispose = () => {
    input.removeEventListener('pointermove', onMove);
    input.removeEventListener('pointerleave', onLeave);
    input.removeEventListener('pointerdown', onMove);
    mq?.removeEventListener?.('change', onMq);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  };

  // CSS-pixel geometry of the last frame — the ring layer needs the globe
  // radius to size dashes, dots and line widths in the same units project()
  // returns.
  const metrics = () => ({ cx, cy, Rd });

  return { resize, setView, render, project, metrics, dispose };
}
