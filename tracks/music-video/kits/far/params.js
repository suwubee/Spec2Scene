// Parameters, legal ranges and generic presets of the far-range (distant mountains / horizon) layer.
// Values outside a legal range throw: the ranges are the measured limits beyond which the picture breaks (README "Parameters"),
// so they are constraints, not suggestions. Units: metres and degrees (azimuth clockwise from north, +x east = 90 deg).

/** One layer of ridges. Every field: README table "Layer parameters" (effect and what too large / too small looks like). */
export const LAYER_DEFAULTS = Object.freeze({
  R: 2400,            // crest radius from the layer centre
  W: 480,             // half depth of the band (front slope ~2W, back slope ~1.4W)
  az0: 200, az1: 330, // azimuth span (may wrap through 360)
  edge: 8,            // degrees over which both ends fade back into the plain
  H0: 40, H1: 140,    // crest height range above the plain
  sharp: 1.8,         // ridged sharpness (1.5 rounded ... 2.2 knife edge)
  lam: 420,           // 2D ridged wavelength: spurs and gullies; ~0.7 W gives 2-3 spurs per layer
  relief: 0.6,        // share of 2D relief (0 = a single crest line, reads as a dune)
  peakLen: 8,         // azimuthal wavelength of the crest line (degrees)
  gaps: [],           // [{az, w (half width deg), depth 0..0.9}] saddles / valley mouths
  step: 7,            // azimuthal arc step (m): silhouette resolution
  rows: 44,           // radial rows (denser near the crest)
  haze: 0,            // extra aerial perspective of this layer (0 near ... 0.8 farthest)
  snowLine: 0.18,     // relative height above which wind-scoured rock increases
  rock: 1.0,          // amount of bare rock
  seed: 1,
});
export const LAYER_RANGES = Object.freeze({
  R: [1500, 9000], W: [0.12, 0.3], edge: [0, 40], H0: [0, 600], H1: [10, 800], sharp: [1.2, 2.2], lam: [0.5, 1.4], relief: [0, 0.85],
  peakLen: [3, 30], step: [1, 40], rows: [24, 160], haze: [0, 0.85], snowLine: [0, 0.45], rock: [0, 1.5], seed: [-1e9, 1e9],
});
/** Maximum crest elevation seen from the centre (deg): taller layers hide the moon and the sky and stop reading as "far". */
export const MAX_ELEVATION_DEG = 5;
/** Maximum azimuthal step as an angle (deg): a coarser silhouette shows straight segments (paper folds) at long focal lengths. */
export const MAX_STEP_DEG = 0.19;

export const AIR_DEFAULTS = Object.freeze({vis: 9000, strength: 0.5, footH: 60, foot: 0.55});
export const AIR_RANGES = Object.freeze({vis: [1500, 60000], strength: [0, 1], footH: [5, 400], foot: [0, 0.9]});
export const SNOW_COLOR_DEFAULTS = Object.freeze({col: [0.78, 0.81, 0.88], rockCol: [0.10, 0.096, 0.10]});
export const LIGHT_DEFAULTS = Object.freeze({gain: 1, ambient: 1, subsurface: 0.35, airGlow: 1.5});   // airGlow >= ~1.4: far layers paler than near (E16)
export const LIGHT_RANGES = Object.freeze({gain: [0, 4], ambient: [0, 4], subsurface: [0, 1.5], airGlow: [0, 2]});
export const SLOT_KINDS = Object.freeze(['beacon', 'village']);

/**
 * Generic presets (no place, no work): spread into createFarRanges options and override baseY / center.
 *   layeredArc   four receding ranges over a 150 deg arc with one saddle through all layers and a side notch
 *   distantRing  one low, hazy ring all round: "sky and earth very large", only a faint scale reference on the horizon
 */
export const FAR_PRESETS = Object.freeze({
  layeredArc: {
    center: [0, 0],
    layers: [
      {R: 2350, W: 430, az0: 195, az1: 335, H0: 30, H1: 125, sharp: 1.9, lam: 300, relief: 0.75, peakLen: 4.2, step: 5, rows: 84, haze: 0.12, snowLine: 0.05, rock: 1.2, seed: 11,
        gaps: [{az: 268, w: 2.4, depth: 0.72}, {az: 216, w: 3.2, depth: 0.55}]},
      {R: 3050, W: 560, az0: 191, az1: 341, H0: 60, H1: 200, sharp: 2.0, lam: 380, relief: 0.72, peakLen: 5.0, step: 7, rows: 72, haze: 0.30, snowLine: 0.12, rock: 1.15, seed: 23,
        gaps: [{az: 268.5, w: 1.6, depth: 0.55}]},
      {R: 3950, W: 700, az0: 187, az1: 347, H0: 100, H1: 290, sharp: 2.0, lam: 480, relief: 0.66, peakLen: 6.0, step: 9, rows: 60, haze: 0.55, snowLine: 0.2, rock: 1.05, seed: 37,
        gaps: [{az: 268.8, w: 2.2, depth: 0.38}]},
      {R: 5300, W: 900, az0: 183, az1: 353, H0: 170, H1: 430, sharp: 2.0, lam: 650, relief: 0.6, peakLen: 7.5, step: 13, rows: 40, haze: 0.78, snowLine: 0.3, rock: 0.9, seed: 51},
    ],
    air: {vis: 9000, strength: 0.6, footH: 70, foot: 0.62},
    slots: [{kind: 'beacon', layer: 0, az: 252, h: 9}, {kind: 'beacon', layer: 1, az: 300, h: 11}],
  },
  distantRing: {
    center: [0, 0],
    layers: [
      {R: 6200, W: 900, az0: 0, az1: 360, H0: 30, H1: 120, sharp: 1.6, lam: 1200, relief: 0.4, peakLen: 14, step: 18, rows: 30, haze: 0.55, snowLine: 0.25, rock: 0.7, seed: 71},
    ],
    air: {vis: 12000, strength: 0.6, footH: 60, foot: 0.6},
    slots: [{kind: 'beacon', layer: 0, az: 245, h: 10}],
  },
});

const inRange = (v, [lo, hi]) => Number.isFinite(v) && v >= lo && v <= hi;
/** Normalise + validate one layer. Relative rules: W and lam scale with R and W, crest elevation <= 5 deg, step <= 0.19 deg. */
export function layerParams(l = {}, where = 'layer') {
  const L = {...LAYER_DEFAULTS, ...l, gaps: (l.gaps || []).map((g) => ({...g}))};
  for (const k of Object.keys(L)) {
    if (k === 'gaps' || k === 'az0' || k === 'az1') continue;
    if (!(k in LAYER_RANGES)) throw new RangeError(`${where}: unknown far layer parameter "${k}"`);
  }
  const rel = {W: L.W / L.R, lam: L.lam / L.W};
  for (const [k, range] of Object.entries(LAYER_RANGES)) {
    const v = k in rel ? rel[k] : L[k];
    if (!inRange(v, range)) throw new RangeError(`${where}.${k}=${L[k]} outside legal range [${range[0]}, ${range[1]}]${k in rel ? (k === 'W' ? ' x R' : ' x W') : ''}`);
  }
  if (!Number.isFinite(L.az0) || !Number.isFinite(L.az1)) throw new RangeError(`${where}: az0/az1 must be finite degrees`);
  if (!(L.H0 < L.H1)) throw new RangeError(`${where}: H0 must be below H1`);
  const elev = Math.atan2(L.H1, L.R) * 180 / Math.PI;
  if (elev > MAX_ELEVATION_DEG) throw new RangeError(`${where}: crest elevation ${elev.toFixed(2)} deg > ${MAX_ELEVATION_DEG} deg (H1 too high for R)`);
  const stepDeg = (L.step / L.R) * 180 / Math.PI;
  if (stepDeg > MAX_STEP_DEG) throw new RangeError(`${where}: step ${L.step} m = ${stepDeg.toFixed(3)} deg > ${MAX_STEP_DEG} deg (silhouette folds)`);
  L.gaps.forEach((g, i) => {
    if (!Number.isFinite(g.az) || !inRange(g.w, [0.3, 25]) || !inRange(g.depth, [0, 0.9])) throw new RangeError(`${where}.gaps[${i}]: {az, w 0.3..25 deg, depth 0..0.9} required`);
  });
  L.rows = Math.round(L.rows);
  return L;
}
function pick(defs, ranges, v, kind) {
  const out = {...defs, ...(v || {})};
  for (const [k, val] of Object.entries(out)) {
    if (!(k in ranges)) throw new RangeError(`unknown ${kind} parameter "${k}"`);
    if (!inRange(val, ranges[k])) throw new RangeError(`${kind}.${k}=${val} outside legal range [${ranges[k][0]}, ${ranges[k][1]}]`);
  }
  return out;
}
export const airParams = (v) => pick(AIR_DEFAULTS, AIR_RANGES, v, 'air');
export const lightParams = (v) => pick(LIGHT_DEFAULTS, LIGHT_RANGES, v, 'light');
export function slotParams(s, layers, i) {
  if (!s || !SLOT_KINDS.includes(s.kind)) throw new RangeError(`slots[${i}].kind must be ${SLOT_KINDS.join('|')}`);
  if (!s.pos) {
    if (!Number.isInteger(s.layer ?? 0) || !layers[s.layer ?? 0]) throw new RangeError(`slots[${i}].layer must index a layer`);
    if (!Number.isFinite(s.az)) throw new RangeError(`slots[${i}].az required (or pos)`);
  }
  if (s.h !== undefined && !inRange(s.h, [2, 40])) throw new RangeError(`slots[${i}].h 2..40 m`);
  return {...s};
}
