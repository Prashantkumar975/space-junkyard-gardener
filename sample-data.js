// ── Sample dataset for Space Junkyard Gardener ────────────────────────────
// A small, fixed, clearly illustrative list of familiar satellite and debris
// names. Nothing here is fetched from a live source: altitudes and
// inclinations are approximate round numbers kept only so the interface has
// something plain-language to describe.
//
// This module holds DATA ONLY. It knows nothing about markers, layout or the
// DOM. Swap it for a catalog-backed module when a real source is configured
// (see data-loader.js for the seam).

const entries = [
  { name: 'ISS (ZARYA)', type: 'satellite', altitude: 420, inclination: 51.6, note: 'The most crowded address in orbit — a crewed laboratory the size of a football pitch.' },
  { name: 'HUBBLE SPACE TELESCOPE', type: 'satellite', altitude: 550, inclination: 28.5, note: 'A veteran observatory that has been peering outward since 1990.' },
  { name: 'NOAA 19', type: 'satellite', altitude: 780, inclination: 99.2 },
  { name: 'TERRA', type: 'satellite', altitude: 705, inclination: 98.2 },
  { name: 'SENTINEL-2A', type: 'satellite', altitude: 690, inclination: 98.6 },
  { name: 'LANDSAT 9', type: 'satellite', altitude: 690, inclination: 98.2 },
  { name: 'STARLINK-3124', type: 'satellite', altitude: 540, inclination: 53 },
  { name: 'ENVISAT', type: 'debris', altitude: 790, inclination: 98.5, note: 'A large, silent derelict still drifting through a busy band.' },
  { name: 'COSMOS 1408 DEB', type: 'debris', altitude: 860, inclination: 82.5 },
  { name: 'SL-16 R/B', type: 'debris', altitude: 980, inclination: 74, note: 'A spent rocket body — one of the heaviest things left behind.' },
  { name: 'FENGYUN 1C DEB', type: 'debris', altitude: 840, inclination: 99 },
  { name: 'COSMOS 2251 DEB', type: 'debris', altitude: 790, inclination: 74 },
  { name: 'ARIANE 5 DEB', type: 'debris', altitude: 720, inclination: 51.6 },
  { name: 'STARLINK-5840', type: 'satellite', altitude: 540, inclination: 53 },
  { name: 'ATLAS 5 CENTAUR R/B', type: 'debris', altitude: 1040, inclination: 63 },
  { name: 'IRIDIUM 33 DEB', type: 'debris', altitude: 775, inclination: 86.4 },
  { name: 'COSMOS 954 DEB', type: 'debris', altitude: 790, inclination: 65 },
  { name: 'DELTA 1 DEB', type: 'debris', altitude: 1050, inclination: 98.7 },
  { name: 'CZ-4B R/B', type: 'debris', altitude: 825, inclination: 51.6 },
  { name: 'POLAR', type: 'satellite', altitude: 610, inclination: 86 },
  { name: 'AQUA', type: 'satellite', altitude: 700, inclination: 98.2 },
  { name: 'ICESAT-2', type: 'satellite', altitude: 495, inclination: 92 },
  { name: 'STARLINK-7210', type: 'satellite', altitude: 540, inclination: 53 },
  { name: 'COSMOS 1275 DEB', type: 'debris', altitude: 820, inclination: 74 },
  { name: 'PEGASUS DEB', type: 'debris', altitude: 970, inclination: 72 },
  { name: 'NAVSTAR 81', type: 'satellite', altitude: 20200, inclination: 55, note: 'A navigation satellite far above the low-Earth crowd.' },
  { name: 'METOP-C', type: 'satellite', altitude: 820, inclination: 98.7 },
  { name: 'CZ-2C DEB', type: 'debris', altitude: 690, inclination: 98.1 },
  { name: 'JASON-3', type: 'satellite', altitude: 1330, inclination: 66 },
  { name: 'PROGRESS MS-26', type: 'satellite', altitude: 410, inclination: 51.6 },
  { name: 'STARLINK-1920', type: 'satellite', altitude: 540, inclination: 53 },
  { name: 'ARIANE 4 DEB', type: 'debris', altitude: 740, inclination: 74 },
  { name: 'TIANGONG', type: 'satellite', altitude: 390, inclination: 41.5, note: 'A modern crewed station in a notably low, fast-moving orbit.' },
  { name: 'RESURS-DK1 DEB', type: 'debris', altitude: 820, inclination: 98.5 },
  { name: 'SL-14 R/B', type: 'debris', altitude: 900, inclination: 74 },
  { name: 'NOAA 18', type: 'satellite', altitude: 850, inclination: 99 },
  { name: 'ORBCOMM FM 103', type: 'satellite', altitude: 775, inclination: 45 },
  { name: 'COSMOS 2428 DEB', type: 'debris', altitude: 785, inclination: 74 },
  { name: 'FALCON 9 DEB', type: 'debris', altitude: 610, inclination: 53 },
  { name: 'SENTINEL-1A', type: 'satellite', altitude: 690, inclination: 98 },
  { name: 'STARLINK-4031', type: 'satellite', altitude: 540, inclination: 53 },
  { name: 'IRIDIUM 7 DEB', type: 'debris', altitude: 775, inclination: 86.4 },
  { name: 'ENVISAT DEB', type: 'debris', altitude: 800, inclination: 74 },
  { name: 'H-2A DEB', type: 'debris', altitude: 720, inclination: 51.6 },
  { name: 'GOES 16', type: 'satellite', altitude: 35786, inclination: 0.1, note: 'Parked high above the equator, holding one spot all day.' },
  { name: 'COSMOS 1818 DEB', type: 'debris', altitude: 810, inclination: 65 },
  { name: 'GOES 18', type: 'satellite', altitude: 35786, inclination: 0.1 },
  { name: 'TDRS 12', type: 'satellite', altitude: 35786, inclination: 0.6 },
  { name: 'GALILEO 24', type: 'satellite', altitude: 23222, inclination: 56, note: 'A positioning satellite in the middle band, halfway to the high orbits.' },
  { name: 'BEIDOU 3 M2', type: 'satellite', altitude: 21528, inclination: 55 }
];

// Golden-angle placement keeps the fixed sample evenly spread around the
// rings. It is a layout choice, not an orbital element.
export const sampleObjects = entries.map((entry, index) => ({
  id: `SAMPLE-${String(index + 1).padStart(3, '0')}`,
  angle: (index * 137.508) % 360,
  ...entry
}));

export const sampleMeta = {
  provider: 'sample',
  label: 'Illustrative sample dataset',
  isSample: true,
  objectCount: sampleObjects.length
};

// Plain-language bands used in tooltips and the Orbit Garden panel.
export function orbitBand(altitude) {
  if (altitude >= 34000) return 'Geostationary ring';
  if (altitude >= 2000) return 'Medium Earth orbit';
  return 'Low Earth orbit';
}

// A short sentence for an object without a hand-written note.
export function describeObject(object) {
  if (object.note) return object.note;
  const band = orbitBand(object.altitude).toLowerCase();
  return object.type === 'debris'
    ? `A drifting fragment parked in the ${band} — shown here for texture, not for tracking.`
    : `A working object in the ${band}, one of the sample garden’s regulars.`;
}
