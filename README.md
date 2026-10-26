# Space Junkyard Gardener

A small dashboard for exploring an illustrative view of satellites and orbital debris around Earth — with plain-language reports written by a model running **locally** through Ollama. The 3-D globe is Originkit's `terra-dusk` WebGL component (ported to a build-step-free module); everything else is hand-written, and there is still no build step.

The app shows **real catalogue data by default** — names, altitudes, inclinations, launch dates and operational statuses come from [CelesTrak's SATCAT](https://celestrak.org/satcat/satcat-format.php) (the public satellite catalogue), fetched once a day by the local server and cached for 24 hours. Marker positions stay decorative. With no internet connection it falls back to a clearly labelled built-in sample, so it always works — no API key at any point.

## What's in the box

| File | Role |
| --- | --- |
| `index.html` | Markup: full-screen 3-D main page — top navigation bar, left hero with CTA, right-hand counts + report cards; the sidebar/top bar/status footer appear on Orbit Garden & History |
| `styles.css` | OSIRIS-style console theme: near-black void, gold + cyan accents, JetBrains Mono HUD, glass panels, scanlines, responsive layout |
| `sample-data.js` | **Fallback data only** — the labelled sample objects used when the catalogue is unreachable |
| `data-loader.js` | **Data source seam** + scene geometry (Earth, rings) — asks the local backend for catalogue objects, falls back to the sample |
| `earth-scene.js` | **Visualization only** — drives the Terra Dusk WebGL globe plus the two 2-D ring layers: orbital rings, the satellite-and-debris traffic, and the cyan network arcs |
| `app.js` | Camera-driven marker projection, page routing, interaction, stats, history |
| `report-generator.js` | Calls our own `/api/report`; falls back to a labelled sample report |
| `server.mjs` | Tiny Node backend (no dependencies): static files, the daily CelesTrak catalogue sync (`/api/objects`), and the local Ollama proxy |

## The 3-D view

The Overview page **is** the scene — full-screen, with no sidebar, top bar or footer around it. It mirrors the reference design: a top navigation bar (planet icon + brand, centre links with a cyan active underline, a `SAMPLE DATA` chip and an About pill), a left hero (eyebrow, the big *Space Junkyard Gardener* headline with a gradient second line, intro copy and a gradient **Explore 3D View** button), a right-hand column with a reference-style counts card above the floating garden report, a pulsing bottom-left status line, a decorative second-planet limb glowing in from the bottom-left corner, and one bottom controls bar — all over a large glowing Earth that fills the stage. The counts card shows only honest sample figures (satellites / debris / orbit bands) with an "Illustrative sample counts — not live orbital totals" note. (The other two pages keep the full shell: sidebar, top bar with the ZULU clock, and the status-bar ticker.) The globe is the Terra Dusk WebGL renderer: a textured sphere (real blue-marble day map, night city-lights, drifting clouds, water specular, a blue atmosphere halo and in-shader stars). Around it run five orbital rings (2-D lines on canvases that sandwich the globe, so they dive behind the planet and swing back in front) carrying the 50 interactive sample markers plus decorative **satellites and debris**. The satellites are little silhouettes — a central bus, two solar-panel wings and a dish — that orient along their direction of travel and orbit at Kepler-ordered speeds (lower rings visibly faster than higher ones). The debris are jagged pre-baked shards scattered on the rings and across a loose belt on its own orbital planes, drifting and slowly tumbling. All of it is decorative scenery: none of it is clickable and none of it is computed from orbital mechanics.

| Gesture / control | What it does |
| --- | --- |
| **Drag** on the scene (mouse or touch) | Rotates the view — yaw and pitch, so you can look from any direction |
| **Wheel / trackpad pinch** (desktop hero layout) | Zooms between 0.8× and 1.5×; the wheel is left to scroll the page in the stacked mobile/tablet layout |
| **Pinch** (touch) | Zooms between 0.8× and 1.5× |
| **− / +** buttons | Zoom without a touchscreen |
| **◐ Auto-spin** | Toggles the slow idle rotation (on by default; pauses while you drag or have an object picked) |
| **↺ Reset view** | Returns to the home angle and clears the selected object |

Markers, rings and tooltips are re-projected every frame, so rings correctly pass **behind** Earth and swing back **in front** of it. Positions remain decorative: nothing is computed from orbital mechanics.

## Requirements

- **Node.js 18 or newer** (tested on Node 24).
- **No npm packages** — `npm install` validates the (empty) dependency list. No bundler, no build step.
- A browser with **WebGL** (any modern browser). Without it, a labelled notice explains the flat fallback.
- **[Ollama](https://ollama.com)** — optional. Without it, the app still runs and shows a clearly labelled sample report.

## Launch

```bash
npm install   # no dependencies — validates the (empty) lockfile
npm start
```

Then open **http://localhost:4173**.

`npm start` runs `node server.mjs`. Use `PORT=5000 npm start` (or `$env:PORT = "5000"` on PowerShell) to change the port.

## The local model

The report endpoint expects an open-weight model served by Ollama. The default is:

```
llama3.2:3b
```

Install and start it:

```bash
ollama pull llama3.2:3b
ollama serve          # usually already running as a background service
```

Ollama listens on `http://127.0.0.1:11434` by default.

### Enabling AI reports

1. Install the model above and make sure `ollama serve` is running.
2. Start the app with `npm start`.
3. Open Overview and press **Generate with local AI** (it also runs once on page load).

The report card always states its source:

- **`Local model · llama3.2:3b`** — written by the model on your machine (mint dot).
- **`Sample fallback · local model unavailable`** — built-in sample text (amber dot), with the reason available on hover.

Report history on the **History** page is labelled the same way and is stored only in your browser's `localStorage`.

### Switching to another Ollama model

Set `OLLAMA_MODEL` before starting the server:

```bash
# macOS / Linux
OLLAMA_MODEL=qwen2.5:3b npm start
```

```powershell
# Windows PowerShell
$env:OLLAMA_MODEL = "qwen2.5:3b"
npm start
```

Any model Ollama can serve works (`llama3.2:1b`, `mistral:7b`, `gemma2:2b`, `qwen3:4b`, …). Pull it first with `ollama pull <name>`.

Related settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_MODEL` | `llama3.2:3b` | Which local model writes the report |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where the Ollama-compatible API lives |
| `PORT` | `4173` | Port for the app server |
| `CATALOG_URL` | `https://celestrak.org/pub/satcat.csv` | SATCAT-style CSV endpoint to use instead of CelesTrak's bulk download |

The active model name is shown in the About dialog and returned by `GET /api/config`.

## The real catalogue: how it works

The UI only ever asks `data-loader.js` for objects, which calls the local backend at `GET /api/objects`. The server keeps a curated slice of the real CelesTrak SATCAT — about 60 objects: famous satellites (ISS, Hubble, Tiangong, GOES, GPS/Galileo/BeiDou navigation satellites…), famous junk (Envisat, spent rocket stages, Fengyun/Cosmos/Iridium debris families), plus a deterministic cross-section of what else is up there. Real catalogue values throughout: names, altitudes (mean of apogee and perigee), inclinations, launch dates and operational statuses.

- **Synced once a day.** The first sync downloads the ~6.8 MB SATCAT file (a minute or two on a slow link) and caches the curated result in `.satcat.cache.json` for 24 hours; later loads are instant, and a stale cache is served while a refresh runs. If the bulk file is unavailable (CelesTrak's CDN occasionally blocks heavy users), the server automatically falls back to CelesTrak's documented SATCAT query API — 12 small group/name queries that are merged and de-duplicated — and the stats note then says the totals cover the queried groups rather than the whole catalogue.
- **Offline fallback.** If CelesTrak is unreachable, the app keeps working from the labelled built-in sample and every chip and note switches to the sample wording.
- **Override the source** with `CATALOG_URL` pointing at any CelesTrak-format SATCAT CSV.
- **Honest labels.** Chips say `REAL CATALOG · CELESTRAK` (green) or `SAMPLE DATA` (amber) depending on what is actually loaded; the About dialog states which source is active and when it was synced.

## Data, counts, and safety language

- Altitudes, inclinations, launch dates and statuses are **real catalogue values** from CelesTrak's SATCAT (or the labelled sample when offline). The ~60 objects shown are a curated view, not the whole catalogue — the stats card says how many of the catalogue's tens of thousands of on-orbit objects are in view.
- Marker positions are decorative for both sources. The date selector only re-labels the view and nudges markers; it does not compute real orbits.
- The interface states plainly: *"This illustrative view is not a precise orbit simulator or collision warning system."*
- No collision predictions, risk scores, or real-time tracking claims are shown anywhere.
- **Catalogue data never leaves your machine either** — the sync runs on the local server and is cached to disk. The only other outbound request the app makes is to Ollama on `OLLAMA_URL` (loopback by default). No hosted model API, no API key, no telemetry.
