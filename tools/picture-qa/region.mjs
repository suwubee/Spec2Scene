// region.mjs — region scope and perceptual metrics for picture-qa (pure JS, no model, deterministic).
//
// Why these exist: single-sided pixel thresholds are over-satisfied ("add detail" becomes zebra stripes and pixel noise),
// coverage alone is met with random dots and hard-edged stickers, contrast-with-background is met by a black silhouette, and
// whole-frame numbers are polluted by neighbouring components. So every perceptual metric here is measured inside a named
// component mask (neighbours excluded, boundaries eroded) and judged against a PAIR of bounds.
//
// Exports (all pure; arrays are row-major, masks are Uint8Array 1 = inside):
//   masks       parseMaskDefs, regionMask, erodeMask
//   bounds      validateBounds, pairedBounds, mergeBounds, widenedBounds, SURFACE_METRICS
//   statistics  regionValues, percentiles, bimodality, highpassStd
//   morphology  findPatches, starfield, edgeSoftness, patchSizeSpread, cavityCorrelation, facetFraction
//   figure      widthProfile (silhouette structure / tent detection), facingAngle
//   surfaceMetrics(Y, w, h, region, opts) -> {metrics} used by picture-qa check ⑧ surface
//
// Scale: surface metrics are measured at the source resolution (frames wider than SURFACE_WIDTH = 1920 are first reduced to
// it). Pixel-sized quantities are expressed in 1920-wide px (edge softness, isolated points per 100×100 px) so 960 and 1920
// renders read alike; hpStd and facets depend on resolution, so acceptance frames are rendered 1920 wide.

export const SURFACE_WIDTH = 1920;
export const TILE_PX = 16;                       // one analysis tile at 960 wide (the ③ flat block); --erode N counts these

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))))];

// ------------------------------------------------------------------------------------------------ masks
const isRect = (r) => Array.isArray(r) && r.length === 4 && r.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) && r[0] < r[2] && r[1] < r[3];
/**
 * masks.json: { "<name>": [x0,y0,x1,y1] | [[x0,y0,x1,y1], ...] | "file.png" | {rects:[...], png:"file.png"}, "_why": ... }.
 * Keys starting with "_" are comments. PNG paths are relative to the masks.json directory; white (> 0.5) = inside.
 * Returns {name: {rects:[...], png:string|null}}. Throws on malformed entries.
 */
export function parseMaskDefs(json, where = 'masks.json') {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${where}: must be a JSON object of region name -> rect | [rects] | "file.png" | {rects, png}`);
  const out = {};
  for (const [name, v] of Object.entries(json)) {
    if (name.startsWith('_')) continue;
    let rects = [], png = null;
    if (isRect(v)) rects = [v];
    else if (Array.isArray(v) && v.length && v.every(isRect)) rects = v;
    else if (typeof v === 'string' && /\.png$/i.test(v)) png = v;
    else if (v && typeof v === 'object' && !Array.isArray(v) && (v.rects || v.png)) {
      if (v.rects !== undefined) { if (!Array.isArray(v.rects) || !v.rects.every(isRect)) throw new Error(`${where}.${name}.rects: normalised [x0,y0,x1,y1] list required`); rects = v.rects; }
      if (v.png !== undefined) { if (typeof v.png !== 'string' || !/\.png$/i.test(v.png)) throw new Error(`${where}.${name}.png: PNG path required`); png = v.png; }
    } else throw new Error(`${where}.${name}: rect [x0,y0,x1,y1] (normalised 0..1), list of rects, "file.png" or {rects, png} required`);
    out[name] = {rects, png};
  }
  return out;
}
/** Binary erosion with a (2r+1)² square (separable running min). r <= 0 returns a copy. */
export function erodeMask(m, w, h, r) {
  const out = Uint8Array.from(m);
  if (!(r > 0)) return out;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {                     // horizontal: inside only if all of [x-r, x+r] inside (outside frame = outside)
    let run = 0; const row = y * w, last = new Int32Array(w);
    for (let x = 0; x < w; x++) { run = m[row + x] ? run + 1 : 0; last[x] = run; }
    for (let x = 0; x < w; x++) { const xe = x + r; tmp[row + x] = xe < w && last[xe] >= 2 * r + 1 ? 1 : 0; }
  }
  for (let x = 0; x < w; x++) {
    let run = 0; const col = new Int32Array(h);
    for (let y = 0; y < h; y++) { run = tmp[y * w + x] ? run + 1 : 0; col[y] = run; }
    for (let y = 0; y < h; y++) { const ye = y + r; out[y * w + x] = ye < h && col[ye] >= 2 * r + 1 ? 1 : 0; }
  }
  return out;
}
function dilateMask(m, w, h, r) {                  // dilation = complement of erosion of the complement (frame edge = inside)
  const c = new Uint8Array(w * h); for (let i = 0; i < c.length; i++) c[i] = m[i] ? 0 : 1;
  const pad = new Uint8Array(w * h); const e = erodeMaskOpen(c, w, h, r); for (let i = 0; i < pad.length; i++) pad[i] = e[i] ? 0 : 1; return pad;
}
function erodeMaskOpen(m, w, h, r) {               // erosion where outside-the-frame counts as inside (for dilation)
  const out = new Uint8Array(w * h), tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let ok = 1; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (!m[y * w + k]) { ok = 0; break; } tmp[y * w + x] = ok; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let ok = 1; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (!tmp[k * w + x]) { ok = 0; break; } out[y * w + x] = ok; }
  return out;
}
/**
 * Region mask at w×h: union of `names` minus union of `exclude`, eroded by `erode` tiles (TILE_PX at 960 wide, scaled to w).
 * defs from parseMaskDefs; loadPng(path) -> {w,h,R} at the same size as w×h (the caller crops/resamples like the frame).
 */
export function regionMask(defs, names, {w, h, exclude = [], erode = 0, loadPng = null} = {}) {
  const one = (name) => {
    const d = defs[name];
    if (!d) throw new Error(`unknown mask "${name}" (available: ${Object.keys(defs).join(', ') || 'none'})`);
    const m = new Uint8Array(w * h);
    for (const r of d.rects) { const x0 = Math.round(r[0] * w), x1 = Math.round(r[2] * w), y0 = Math.round(r[1] * h), y1 = Math.round(r[3] * h); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1; }
    if (d.png) {
      if (!loadPng) throw new Error(`mask "${name}" is a PNG but no loader was given`);
      const P = loadPng(d.png);
      if (P.w !== w || P.h !== h) throw new Error(`mask "${name}" (${d.png}) is ${P.w}x${P.h}, expected ${w}x${h}`);
      for (let i = 0; i < w * h; i++) if (P.R[i] > 0.5) m[i] = 1;
    }
    return m;
  };
  if (!names || !names.length) throw new Error('regionMask: at least one region name required');
  const m = new Uint8Array(w * h);
  for (const n of names) { const a = one(n); for (let i = 0; i < a.length; i++) m[i] |= a[i]; }
  for (const n of exclude) { const a = one(n); for (let i = 0; i < a.length; i++) if (a[i]) m[i] = 0; }
  const r = Math.round(erode * TILE_PX * w / 960);
  const out = erodeMask(m, w, h, r);
  let n = 0; for (const v of out) n += v;
  if (!n) throw new Error(`region ${names.join('+')}${exclude.length ? ' minus ' + exclude.join('+') : ''}${erode ? ` eroded by ${erode} tiles` : ''} is empty`);
  return out;
}

// ------------------------------------------------------------------------------------------------ paired bounds
/** Metrics the ⑧ surface check can measure. Each is judged against [lo, hi]. */
export const SURFACE_METRICS = Object.freeze({
  mean: 'mean encoded luma in the region',
  p01: 'luma 1st percentile', p10: 'luma 10th percentile', p50: 'luma median', p90: 'luma 90th percentile', p99: 'luma 99th percentile',
  ratio: 'p90 / p10 (contrast; zebra or cartoon when high, grey card when low)',
  midFrac: 'share of pixels in the middle 50% of the p10–p90 span (bimodality: zebra stripes pile up at both ends)',
  hpStd: '3×3 high-pass standard deviation (pixel-level noise / grain baked into albedo)',
  stars: 'isolated bright points per 100×100 px at 1920 wide (starfield)',
  coverage: 'patch pixels / region pixels (patches: bright|dark deviations from the local median)',
  softPx: 'median patch edge transition width in px at 1920 wide (hard-edged stickers are ~1 px)',
  sizeCV: 'coefficient of variation of patch areas (uniform dots are low)',
  cavity: 'share of patch pixels inside the top 30% of the cavity map (needs a cavity map)',
  facets: 'share of region pixels on straight luminance steps (flat-shaded polygon facets)',
});
const SURFACE_KEYS = new Set(['bounds', 'oneSided', 'patches', 'patchDelta', 'cavity', 'notes']);
/**
 * Validate a surface spec {bounds:{metric:[lo,hi]}, oneSided:{metric:why}, patches:'bright'|'dark'|'both', patchDelta, cavity}.
 * Paired-bound rule: every metric needs both lo and hi; a null side is allowed only with oneSided[metric] = reason (>= 8 chars).
 * Returns a list of error strings (empty = valid).
 */
export function validateBounds(spec, where = 'surface') {
  const errs = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return [`${where}: object {bounds, oneSided?, patches?, patchDelta?, cavity?} required`];
  for (const k of Object.keys(spec)) if (!k.startsWith('_') && !SURFACE_KEYS.has(k)) errs.push(`${where}: unknown key "${k}"`);
  const B = spec.bounds, O = spec.oneSided || {};
  if (!B || typeof B !== 'object' || Array.isArray(B) || !Object.keys(B).length) errs.push(`${where}.bounds: {metric: [lo, hi]} required`);
  else for (const [m, v] of Object.entries(B)) {
    if (!(m in SURFACE_METRICS)) { errs.push(`${where}.bounds.${m}: unknown metric (known: ${Object.keys(SURFACE_METRICS).join(', ')})`); continue; }
    if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => x === null || Number.isFinite(x))) { errs.push(`${where}.bounds.${m}: [lo, hi] required (numbers; null only for a declared one-sided bound)`); continue; }
    if (v[0] === null && v[1] === null) { errs.push(`${where}.bounds.${m}: both sides null`); continue; }
    if (v[0] !== null && v[1] !== null && v[0] > v[1]) errs.push(`${where}.bounds.${m}: lo ${v[0]} > hi ${v[1]}`);
    if ((v[0] === null || v[1] === null) && !(typeof O[m] === 'string' && O[m].trim().length >= 8)) errs.push(`${where}.bounds.${m}: one-sided bound needs oneSided.${m} = reason — single-sided perceptual bounds get over-satisfied; give the ${v[0] === null ? 'lower' : 'upper'} bound too`);
  }
  if (spec.oneSided !== undefined && (typeof spec.oneSided !== 'object' || Array.isArray(spec.oneSided))) errs.push(`${where}.oneSided: {metric: reason} required`);
  if (spec.patches !== undefined && !['bright', 'dark', 'both'].includes(spec.patches)) errs.push(`${where}.patches: "bright" | "dark" | "both"`);
  if (spec.patchDelta !== undefined && !(Number.isFinite(spec.patchDelta) && spec.patchDelta > 0 && spec.patchDelta < 1)) errs.push(`${where}.patchDelta: number in (0,1)`);
  if (spec.cavity !== undefined && !(typeof spec.cavity === 'string' && /\.png$/i.test(spec.cavity))) errs.push(`${where}.cavity: PNG path relative to the frame directory (white = deepest cavity); default sidecar <frame>_cavity.png`);
  return errs;
}
/** Evaluate measured values against paired bounds. -> {pass, rows:[{metric, value, lo, hi, pass, side}]} (value null = not measurable = FAIL). */
export function pairedBounds(values, bounds) {
  const rows = [];
  for (const [metric, [lo, hi]] of Object.entries(bounds)) {
    const v = values[metric];
    if (v === null || v === undefined || !Number.isFinite(v)) { rows.push({metric, value: null, lo, hi, pass: false, side: 'unmeasured'}); continue; }
    const low = lo !== null && v < lo, high = hi !== null && v > hi;
    rows.push({metric, value: r4(v), lo, hi, pass: !low && !high, side: low ? 'low' : high ? 'high' : null});
  }
  return {pass: rows.every((r) => r.pass), rows};
}
/** Merge surface specs across config layers: later layers override metric by metric. */
export function mergeBounds(...specs) {
  const out = {bounds: {}, oneSided: {}};
  for (const s of specs) {
    if (!s) continue;
    Object.assign(out.bounds, s.bounds || {}); Object.assign(out.oneSided, s.oneSided || {});
    for (const k of ['patches', 'patchDelta', 'cavity']) if (s[k] !== undefined) out[k] = s[k];
  }
  return Object.keys(out.bounds).length ? out : null;
}
/** Bounds in `next` that are looser than in `base` (lo lowered, hi raised, a side dropped, or a metric removed). */
export function widenedBounds(base, next) {
  const a = (base && base.bounds) || {}, b = (next && next.bounds) || {}, out = [];
  for (const [m, [lo, hi]] of Object.entries(a)) {
    if (!b[m]) { out.push({metric: m, from: [lo, hi], to: null, note: 'bound removed'}); continue; }
    const [lo2, hi2] = b[m];
    if ((lo !== null && (lo2 === null || lo2 < lo)) || (hi !== null && (hi2 === null || hi2 > hi))) out.push({metric: m, from: [lo, hi], to: [lo2, hi2], note: 'bound widened'});
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ statistics
export function regionValues(Y, mask) {
  if (!mask) return Float32Array.from(Y);
  let n = 0; for (const v of mask) n += v;
  const out = new Float32Array(n); let k = 0;
  for (let i = 0; i < Y.length; i++) if (mask[i]) out[k++] = Y[i];
  return out;
}
export function percentiles(values) {
  const s = Float32Array.from(values).sort();
  let sum = 0; for (const v of s) sum += v;
  return {n: s.length, mean: sum / Math.max(1, s.length), p01: q(s, 0.01), p10: q(s, 0.1), p50: q(s, 0.5), p90: q(s, 0.9), p99: q(s, 0.99)};
}
/**
 * Distribution shape. midFrac = share of values inside the middle 50% of the [p10, p90] span: a smooth unimodal distribution
 * gives ~0.45–0.5, a uniform one 0.4, zebra/two-tone surfaces pile up at both ends and drop towards 0. Also Sarle's
 * bimodality coefficient bc (> 0.555 suggests two modes) for reference.
 */
export function bimodality(values) {
  const s = Float32Array.from(values).sort(), n = s.length;
  if (n < 16) return {midFrac: null, bc: null, p10: null, p90: null, ratio: null};
  const p10 = q(s, 0.1), p90 = q(s, 0.9), span = p90 - p10, lo = p10 + 0.25 * span, hi = p90 - 0.25 * span;
  let mid = 0, m = 0; for (const v of s) { m += v; if (v >= lo && v <= hi) mid++; }
  m /= n;
  let m2 = 0, m3 = 0, m4 = 0; for (const v of s) { const d = v - m; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; }
  m2 /= n; m3 /= n; m4 /= n;
  const skew = m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0, exk = m2 > 0 ? m4 / (m2 * m2) - 3 : 0;
  const bc = (skew * skew + 1) / (exk + 3 * (n - 1) ** 2 / ((n - 2) * (n - 3)));
  return {midFrac: span > 1e-6 ? mid / n : 1, bc, p10, p90, ratio: p90 / Math.max(1e-4, p10)};
}
function box3(Y, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, y - 1); j <= Math.min(h - 1, y + 1); j++) for (let i = Math.max(0, x - 1); i <= Math.min(w - 1, x + 1); i++) { s += Y[j * w + i]; c++; }
    out[y * w + x] = s / c;
  }
  return out;
}
/** Standard deviation of Y − 3×3 mean inside the region (eroded by 1 px so the region edge does not count). */
export function highpassStd(Y, w, h, mask = null) {
  const b = box3(Y, w, h), m = mask ? erodeMask(mask, w, h, 1) : null;
  let n = 0, s = 0, s2 = 0;
  for (let i = 0; i < Y.length; i++) { if (m && !m[i]) continue; const d = Y[i] - b[i]; s += d; s2 += d * d; n++; }
  if (!n) return null;
  const mu = s / n; return Math.sqrt(Math.max(0, s2 / n - mu * mu));
}

// ------------------------------------------------------------------------------------------------ morphology
function boxMean(Y, w, h, r) {                     // separable box mean, edge-clamped window
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { let s = 0, c = 0; const row = y * w; for (let x = 0; x < Math.min(w, r + 1); x++) { s += Y[row + x]; c++; }
    for (let x = 0; x < w; x++) { tmp[row + x] = s / c; const a = x + r + 1, b = x - r; if (a < w) { s += Y[row + a]; c++; } if (b >= 0) { s -= Y[row + b]; c--; } } }
  for (let x = 0; x < w; x++) { let s = 0, c = 0; for (let y = 0; y < Math.min(h, r + 1); y++) { s += tmp[y * w + x]; c++; }
    for (let y = 0; y < h; y++) { out[y * w + x] = s / c; const a = y + r + 1, b = y - r; if (a < h) { s += tmp[a * w + x]; c++; } if (b >= 0) { s -= tmp[b * w + x]; c--; } } }
  return out;
}
function components(mask, w, h) {
  const lab = new Int32Array(w * h).fill(-1), comps = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i] >= 0) continue;
    const c = {n: 0, idx: [], x0: w, y0: h, x1: -1, y1: -1}, st = [i]; lab[i] = comps.length;
    while (st.length) {
      const k = st.pop(), x = k % w, y = (k / w) | 0; c.n++; c.idx.push(k);
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if ((dx || dy) && xx >= 0 && yy >= 0 && xx < w && yy < h) { const j = yy * w + xx; if (mask[j] && lab[j] < 0) { lab[j] = comps.length; st.push(j); } }
      }
    }
    comps.push(c);
  }
  return {comps, lab};
}
/**
 * Surface patches (lichen, salt, stains): pixels deviating from the local median-ish background (box mean, radius 24 px at
 * 1920) by more than `delta`, kind 'bright' | 'dark' | 'both', inside the region. Returns a Uint8Array mask.
 */
export function findPatches(Y, w, h, mask = null, {kind = 'bright', delta = 0.03, radius = 24} = {}) {
  const bg = boxMean(Y, w, h, radius), P = new Uint8Array(w * h);
  for (let i = 0; i < Y.length; i++) {
    if (mask && !mask[i]) continue;
    const d = Y[i] - bg[i];
    if ((kind !== 'dark' && d > delta) || (kind !== 'bright' && d < -delta)) P[i] = 1;
  }
  return P;
}
/**
 * Isolated bright points ("starfield" on a rock face): 3×3 local maxima exceeding the mean of the surrounding 5×5 ring by
 * more than `delta` while every ring pixel is at least delta/2 darker (corners of bright bands are not points). Density = points per 100×100 px of region area (at the measured resolution).
 */
export function starfield(Y, w, h, mask = null, {delta = 0.08, tile = 100} = {}) {
  let n = 0, area = 0; const pts = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mask && !mask[i]) continue;
    area++;
    if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) continue;
    const v = Y[i]; let isMax = true;
    for (let dy = -1; dy <= 1 && isMax; dy++) for (let dx = -1; dx <= 1; dx++) {    // ties: the first pixel in raster order wins
      if (!dx && !dy) continue; const u = Y[i + dy * w + dx];
      if (u > v || (u === v && (dy < 0 || (dy === 0 && dx < 0)))) { isMax = false; break; }
    }
    if (!isMax) continue;
    let s = 0, mx = 0;
    for (let k = -2; k <= 2; k++) { const r = [Y[i - 2 * w + k], Y[i + 2 * w + k]]; if (k > -2 && k < 2) r.push(Y[i + k * w - 2], Y[i + k * w + 2]); for (const u of r) { s += u; if (u > mx) mx = u; } }
    if (v - s / 16 > delta && v - mx > delta / 2) { n++; if (pts.length < 50) pts.push([x, y]); }   // isolated: the whole ring is darker
  }
  return {count: n, area, density: area ? n / (area / (tile * tile)) : null, points: pts};
}
/**
 * Patch edge softness: for each patch (area >= minArea) build the mean luminance profile against the signed distance to the
 * patch boundary (chamfer distance, −R..+R px; averaging over the whole outline removes texture noise) and report the
 * 10–90% transition width of that profile. A hard-edged "sticker" reads ~0.8 px, a linear ramp of W px ~0.8 W.
 * Returns the median width (px at the measured resolution) over patches whose profile contrast >= minContrast.
 */
export function edgeSoftness(Y, w, h, patches, {minArea = 24, minContrast = 0.02, R = 12, region = null} = {}) {
  const {comps} = components(patches, w, h), widths = [];
  const SQ2 = Math.SQRT2;
  for (const c of comps) {
    if (c.n < minArea) continue;
    const pad = R + 2, x0 = Math.max(0, c.x0 - pad), y0 = Math.max(0, c.y0 - pad), x1 = Math.min(w - 1, c.x1 + pad), y1 = Math.min(h - 1, c.y1 + pad);
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, m = new Uint8Array(bw * bh);
    for (const k of c.idx) { const x = k % w, y = (k / w) | 0; m[(y - y0) * bw + (x - x0)] = 1; }
    const dist = (inside) => {                          // chamfer distance to the nearest pixel of the other class
      const d = new Float32Array(bw * bh);
      for (let i = 0; i < d.length; i++) d[i] = (m[i] === 1) === inside ? 1e9 : 0;
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const i = y * bw + x; let v = d[i]; if (x > 0) v = Math.min(v, d[i - 1] + 1); if (y > 0) { v = Math.min(v, d[i - bw] + 1); if (x > 0) v = Math.min(v, d[i - bw - 1] + SQ2); if (x < bw - 1) v = Math.min(v, d[i - bw + 1] + SQ2); } d[i] = v; }
      for (let y = bh - 1; y >= 0; y--) for (let x = bw - 1; x >= 0; x--) { const i = y * bw + x; let v = d[i]; if (x < bw - 1) v = Math.min(v, d[i + 1] + 1); if (y < bh - 1) { v = Math.min(v, d[i + bw] + 1); if (x < bw - 1) v = Math.min(v, d[i + bw + 1] + SQ2); if (x > 0) v = Math.min(v, d[i + bw - 1] + SQ2); } d[i] = v; }
      return d;
    };
    const din = dist(true), dout = dist(false), sum = new Float64Array(2 * R + 1), cnt = new Float64Array(2 * R + 1);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const i = y * bw + x, gi = (y + y0) * w + (x + x0);
      if (region && !region[gi]) continue;
      if (!m[i] && patches[gi]) continue;                // another patch inside the window
      const sd = m[i] ? din[i] - 0.5 : -(dout[i] - 0.5);
      const b = Math.round(sd) + R; if (b < 0 || b > 2 * R) continue;
      sum[b] += Y[gi]; cnt[b]++;
    }
    const prof = []; for (let b = 0; b <= 2 * R; b++) prof.push(cnt[b] >= 3 ? sum[b] / cnt[b] : null);
    const outer = prof.slice(0, 3).filter((v) => v !== null), core = prof.slice(R).filter((v) => v !== null);
    if (!outer.length || !core.length) continue;
    const lo = outer.reduce((a, b) => a + b, 0) / outer.length, hi = Math.max(...core), A = hi - lo;
    if (Math.abs(A) < minContrast) continue;
    const cross = (f) => { const t = lo + f * A; let prev = null; for (let b = 0; b <= 2 * R; b++) { const v = prof[b]; if (v === null) continue; if (prev && (v - t) * Math.sign(A) >= 0) { const [pb, pv] = prev; return pb + (t - pv) / ((v - pv) || 1e-9) * (b - pb); } if ((v - t) * Math.sign(A) < 0) prev = [b, v]; else if (!prev) return b; } return null; };
    const a10 = cross(0.1), a90 = cross(0.9);
    if (a10 === null || a90 === null) continue;
    widths.push(Math.max(0.5, a90 - a10));
  }
  widths.sort((a, b) => a - b);
  return {patches: widths.length, medianPx: widths.length ? q(widths, 0.5) : null, p10Px: widths.length ? q(widths, 0.1) : null};
}
/** Patch area spread: coefficient of variation of component areas (>= minArea px). Uniform dots -> low CV. */
export function patchSizeSpread(patches, w, h, {minArea = 6} = {}) {
  const areas = components(patches, w, h).comps.map((c) => c.n).filter((n) => n >= minArea).sort((a, b) => a - b);
  if (areas.length < 3) return {count: areas.length, cv: null};
  const m = areas.reduce((a, b) => a + b, 0) / areas.length, sd = Math.sqrt(areas.reduce((a, b) => a + (b - m) ** 2, 0) / areas.length);
  return {count: areas.length, cv: sd / m, p10: q(areas, 0.1), p50: q(areas, 0.5), p90: q(areas, 0.9)};
}
/** Share of patch pixels whose cavity value is in the region's top `top` fraction (cavity map: high = deep/occluded). */
export function cavityCorrelation(patches, cavity, mask = null, {top = 0.3} = {}) {
  const vals = []; for (let i = 0; i < cavity.length; i++) if (!mask || mask[i]) vals.push(cavity[i]);
  if (!vals.length) return {share: null};
  vals.sort((a, b) => a - b);
  const th = q(vals, 1 - top);
  let n = 0, inC = 0; for (let i = 0; i < patches.length; i++) if (patches[i] && (!mask || mask[i])) { n++; if (cavity[i] >= th) inC++; }
  return {share: n ? inC / n : null, patchPx: n, threshold: th};
}
/**
 * Flat-shaded facets: a pixel is a facet step when (a) a neighbour differs by more than `step`, (b) both sides of the step are
 * locally flat (the luminance 2 and 3 px away along the step normal changes by < step/2 on each side — texture is not flat),
 * and (c) the step continues straight: at least 70% of the positions ±1..±`run` px along the edge tangent are also steps
 * with the same orientation (±22.5°). Returns the share of region pixels on such straight steps (polygon facets / visible
 * mesh edges under flat normals). Natural texture fails (b), curved soft shading fails (a).
 */
export function facetFraction(Y, w, h, mask = null, {step = 0.04, run = 5} = {}) {
  const S = new Int8Array(w * h).fill(-1); let area = 0;
  const at = (x, y) => Y[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; if (mask && !mask[i]) continue;
    const v = Y[i];
    if (!(Math.abs(Y[i + 1] - v) > step || Math.abs(Y[i + w] - v) > step || Math.abs(Y[i - 1] - v) > step || Math.abs(Y[i - w] - v) > step)) continue;
    const gx = Y[i + 1] - Y[i - 1], gy = Y[i + w] - Y[i - w], g = Math.hypot(gx, gy);
    if (g < 1e-6) continue;
    const nx = gx / g, ny = gy / g;
    const P = (k) => at(Math.round(x - k * nx), Math.round(y - k * ny)), Q = (k) => at(Math.round(x + k * nx), Math.round(y + k * ny));
    if (Math.abs(P(2) - P(3)) >= step / 2 || Math.abs(Q(2) - Q(3)) >= step / 2 || Math.abs(Q(2) - P(2)) <= step) continue;
    S[i] = Math.round(((Math.atan2(ny, nx) + Math.PI) % Math.PI) / (Math.PI / 8)) % 8;
  }
  let on = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (mask && !mask[i]) continue; area++;
    const o = S[i]; if (o < 0) continue;
    const th = o * Math.PI / 8, tx = -Math.sin(th), ty = Math.cos(th);
    let hit = 0;
    for (let k = -run; k <= run; k++) {
      if (!k) continue;
      let found = false;
      for (let d = -1; d <= 1 && !found; d++) {                  // allow 1 px lateral jitter of a rasterised line
        const xx = Math.round(x + k * tx - d * ty), yy = Math.round(y + k * ty + d * tx);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const so = S[yy * w + xx]; if (so >= 0 && (so === o || (so + 1) % 8 === o || (o + 1) % 8 === so)) found = true;
      }
      if (found) hit++;
    }
    if (hit >= 0.7 * 2 * run) on++;
  }
  return {share: area ? on / area : null, steps: on};
}

// ------------------------------------------------------------------------------------------------ figure structure
/**
 * Silhouette width profile from a binary figure mask (largest component). Per row: the run containing the body axis (torso
 * run) and any separate runs (limbs). shoulder = widest torso run in shoulderBand, hem = widest in hemBand, waist = narrowest
 * between the shoulder row and the hem row (bands are fractions of the figure height from the top).
 * tent  = waist >= shoulder × (1 − tol): the outline only widens from shoulder to hem (a cone/cloak, no body).
 * FAIL  when tent, waist/hem > maxWaistHem, or (requireLimb) no separate limb run >= limbMin × torso width in limbBand.
 */
export function widthProfile(mask, w, h, {shoulderBand = [0.12, 0.32], hemBand = [0.5, 0.9], limbBand = [0.2, 0.62], tol = 0.03, maxWaistHem = 0.75, limbMin = 0.15, minRows = 60, requireLimb = true} = {}) {
  const {comps, lab} = components(mask, w, h);
  if (!comps.length) return {pass: false, fails: ['figure mask is empty']};
  let best = 0; for (let i = 1; i < comps.length; i++) if (comps[i].n > comps[best].n) best = i;
  const C = comps[best], H = C.y1 - C.y0 + 1;
  if (H < minRows) return {pass: false, heightPx: H, fails: [`figure is ${H} px tall (< ${minRows}): structure cannot be measured — use a lab view where the figure fills the frame height`]};
  let cx = 0; for (const k of C.idx) cx += k % w; cx = Math.round(cx / C.n);
  const rows = [];
  for (let y = C.y0; y <= C.y1; y++) {
    const runs = []; let s = -1;                    // runs over every mask pixel: a hand may be detached
    for (let x = 0; x <= w; x++) { const on = x < w && mask[y * w + x] > 0; if (on && s < 0) s = x; if (!on && s >= 0) { runs.push([s, x - 1]); s = -1; } }
    let ti = runs.findIndex((r) => r[0] <= cx && r[1] >= cx);
    if (ti < 0 && runs.length) { let bd = 1e9; runs.forEach((r, i) => { const d = Math.min(Math.abs(r[0] - cx), Math.abs(r[1] - cx)); if (d < bd) { bd = d; ti = i; } }); }
    const torso = ti >= 0 ? runs[ti][1] - runs[ti][0] + 1 : 0;
    rows.push({f: (y - C.y0) / H, torso, side: runs.filter((_, i) => i !== ti).map((r) => r[1] - r[0] + 1)});
  }
  const band = ([a, b]) => rows.filter((r) => r.f >= a && r.f <= b);
  const sm = rows.map((r, i) => { let s = 0, c = 0; for (let k = Math.max(0, i - 2); k <= Math.min(rows.length - 1, i + 2); k++) { s += rows[k].torso; c++; } return s / c; });   // 5-row smoothing
  const argmax = (a, b) => { let bi = -1, bv = -1; rows.forEach((r, i) => { if (r.f >= a && r.f <= b && sm[i] > bv) { bv = sm[i]; bi = i; } }); return bi; };
  const si = argmax(...shoulderBand), hi = argmax(...hemBand);
  const shoulder = sm[si], hem = sm[hi];
  let waist = Infinity; for (let i = si; i <= hi; i++) waist = Math.min(waist, sm[i]);
  const tent = waist >= shoulder * (1 - tol);
  const torsoRef = Math.max(1, waist);
  let limbRows = 0, limbMax = 0;
  for (const r of band(limbBand)) { const m = Math.max(0, ...r.side); if (m >= limbMin * torsoRef) limbRows++; limbMax = Math.max(limbMax, m); }
  const limbSeparated = limbRows >= Math.max(2, Math.round(0.03 * H));
  const fails = [];
  if (tent) fails.push(`tent: torso width never narrows between shoulder (${shoulder.toFixed(1)} px) and hem (${hem.toFixed(1)} px); waist ${waist.toFixed(1)} px`);
  if (hem > 0 && waist / hem > maxWaistHem) fails.push(`waist/hem ${(waist / hem).toFixed(2)} > ${maxWaistHem}`);
  if (requireLimb && !limbSeparated) fails.push(`no separated limb: no run >= ${Math.round(limbMin * 100)}% of torso width beside the torso in ${limbBand.join('–')} of the height`);
  const profile = []; for (let k = 0; k < 20; k++) { const i = Math.min(rows.length - 1, Math.round((k + 0.5) / 20 * rows.length)); profile.push(r4(sm[i] / Math.max(1, shoulder))); }
  return {pass: !fails.length, fails, heightPx: H, shoulder: r4(shoulder), waist: r4(waist), hem: r4(hem), shoulderAt: r4(rows[si].f), hemAt: r4(rows[hi].f),
    waistHem: r4(waist / Math.max(1, hem)), shoulderWaist: r4(shoulder / Math.max(1, waist)), tent, limbSeparated, limbRows, limbMaxFrac: r4(limbMax / torsoRef), profile};
}
/**
 * Figure facing angle in degrees, on the ground plane (x, z): the angle between the figure's heading and the vector FROM the
 * figure TO the camera. 0° = facing the camera, 90° = profile, 180° = back to the camera; a back view needs >= 120°.
 * heading: direction vector [x, z] or [x, y, z] (never a bare yaw: yaw conventions differ between rigs). Positions [x, y, z]
 * or [x, z]. Throws on degenerate input.
 */
export function facingAngle(heading, figurePos, cameraPos) {
  const xz = (v, what) => {
    if (!Array.isArray(v) || !(v.length === 2 || v.length === 3) || !v.every(Number.isFinite)) throw new TypeError(`${what}: [x, z] or [x, y, z] required${what === 'heading' ? ' (a direction vector, not a yaw angle)' : ''}`);
    return v.length === 3 ? [v[0], v[2]] : [v[0], v[1]];
  };
  const hv = xz(heading, 'heading'), f = xz(figurePos, 'figurePos'), c = xz(cameraPos, 'cameraPos');
  const tx = c[0] - f[0], tz = c[1] - f[1], lh = Math.hypot(hv[0], hv[1]), lt = Math.hypot(tx, tz);
  if (lh < 1e-9) throw new RangeError('heading has zero length on the ground plane');
  if (lt < 1e-9) throw new RangeError('camera is directly above/at the figure: facing is undefined');
  const cos = Math.max(-1, Math.min(1, (hv[0] * tx + hv[1] * tz) / (lh * lt)));
  return Math.acos(cos) * 180 / Math.PI;
}

// ------------------------------------------------------------------------------------------------ ⑧ surface (all metrics)
/** Measure the metrics named in `want` (Set) inside `region` on a w×h luma frame (normally 1920 wide). */
export function surfaceMetrics(Y, w, h, region, {want = new Set(Object.keys(SURFACE_METRICS)), patches: kind = 'bright', patchDelta = 0.03, cavity = null, scale = SURFACE_WIDTH / w} = {}) {
  // scale = 1920-reference px per measured px: windows are sized in 1920 px, softPx and stars are reported in 1920 px.
  const out = {};
  const needs = (...k) => k.some((x) => want.has(x));
  if (needs('mean', 'p01', 'p10', 'p50', 'p90', 'p99', 'ratio', 'midFrac')) {
    const vals = regionValues(Y, region), p = percentiles(vals), b = bimodality(vals);
    Object.assign(out, {mean: p.mean, p01: p.p01, p10: p.p10, p50: p.p50, p90: p.p90, p99: p.p99, ratio: b.ratio, midFrac: b.midFrac, bc: b.bc === null ? null : r4(b.bc)});
  }
  if (needs('hpStd')) out.hpStd = highpassStd(Y, w, h, region);
  if (needs('stars')) out.stars = starfield(Y, w, h, region, {tile: 100 / scale}).density;
  if (needs('coverage', 'softPx', 'sizeCV', 'cavity')) {
    const P = findPatches(Y, w, h, region, {kind, delta: patchDelta, radius: Math.max(4, Math.round(24 / scale))});
    let n = 0, a = 0; for (let i = 0; i < P.length; i++) { if (!region || region[i]) a++; n += P[i]; }
    out.coverage = a ? n / a : null;
    if (needs('softPx')) { const e = edgeSoftness(Y, w, h, P, {region, minArea: Math.max(6, Math.round(24 / (scale * scale))), R: Math.max(4, Math.round(12 / scale))}); out.softPx = e.medianPx === null ? null : e.medianPx * scale; }
    if (needs('sizeCV')) out.sizeCV = patchSizeSpread(P, w, h, {minArea: Math.max(2, Math.round(6 / (scale * scale)))}).cv;
    if (needs('cavity')) out.cavity = cavity ? cavityCorrelation(P, cavity, region).share : null;
  }
  if (needs('facets')) out.facets = facetFraction(Y, w, h, region).share;
  for (const k of Object.keys(out)) if (Number.isFinite(out[k])) out[k] = r4(out[k]);
  return out;
}
