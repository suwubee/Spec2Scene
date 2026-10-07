// Author: suwubee
// engine/util.js — small, pure math / easing / color helpers shared by the engine and Sets.
// Everything here is side-effect free.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, x) => (b === a ? 0 : (x - a) / (b - a));
export const remap = (x, a0, a1, b0, b1, doClamp = true) => {
  let u = invLerp(a0, a1, x);
  if (doClamp) u = saturate(u);
  return b0 + (b1 - b0) * u;
};
export const fract = (x) => x - Math.floor(x);
export const mod = (x, m) => ((x % m) + m) % m;
export const smoothstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const smootherstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * t * (t * (t * 6 - 15) + 10); };
/** 0→1→0 window: rises over [a,b], holds, falls over [c,d] */
export const window4 = (x, a, b, c, d) => smoothstep(a, b, x) * (1 - smoothstep(c, d, x));
/** smooth bump centred at c with half-width w (C1, compact) */
export const bump = (x, c, w) => { const u = saturate(1 - Math.abs(x - c) / w); return u * u * (3 - 2 * u); };
export const lerpVec = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// ---------------------------------------------------------------------------------------------
// Easing — "real" camera moves accelerate and decelerate; never linear.
// ---------------------------------------------------------------------------------------------
export const ease = {
  linear: (t) => t,
  inSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  outSine: (t) => Math.sin((t * Math.PI) / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutQuint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  smooth: (t) => t * t * (3 - 2 * t),
  smoother: (t) => t * t * t * (t * (t * 6 - 15) + 10),
  /** long gentle tails — the default "operator" ease for dolly/crane moves */
  cine: (t) => {
    // blend of sine and quintic: soft start, confident middle, long settle
    const a = -(Math.cos(Math.PI * t) - 1) / 2;
    const b = t * t * t * (t * (t * 6 - 15) + 10);
    return a * 0.55 + b * 0.45;
  },
};
/** resolve an ease by name / function / undefined (default 'cine') */
export function getEase(e) {
  if (typeof e === 'function') return e;
  if (!e) return ease.cine;
  const f = ease[e];
  if (!f) throw new Error(`unknown ease '${e}'`);
  return f;
}
/** eased interpolation over a time window: u(t) in [0,1] */
export const easeWindow = (t, t0, t1, e) => getEase(e)(saturate((t - t0) / Math.max(1e-9, t1 - t0)));

// ---------------------------------------------------------------------------------------------
// Binary search / interpolation of sampled data
// ---------------------------------------------------------------------------------------------
/** index of last element with key(arr[i]) <= x, or -1 */
export function lastIndexLE(arr, x, key = (v) => v) {
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (key(arr[m]) <= x) { r = m; lo = m + 1; } else hi = m - 1;
  }
  return r;
}
/** linear sample of a uniformly sampled array at fractional index */
export function sampleArray(arr, fi) {
  if (!arr || !arr.length) return 0;
  if (fi <= 0) return arr[0];
  const n = arr.length - 1;
  if (fi >= n) return arr[n];
  const i = Math.floor(fi), f = fi - i;
  return arr[i] + (arr[i + 1] - arr[i]) * f;
}
/** Catmull-Rom (uniform) sample of a uniformly sampled array — smooth energy curves */
export function sampleArrayCR(arr, fi) {
  if (!arr || !arr.length) return 0;
  const n = arr.length - 1;
  if (fi <= 0) return arr[0];
  if (fi >= n) return arr[n];
  const i = Math.floor(fi), f = fi - i;
  const p0 = arr[Math.max(0, i - 1)], p1 = arr[i], p2 = arr[Math.min(n, i + 1)], p3 = arr[Math.min(n, i + 2)];
  const f2 = f * f, f3 = f2 * f;
  return 0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
}

/**
 * Monotone cubic (Fritsch–Carlson) interpolation through points xs[] -> ys[].
 * endSlope: 'zero' (ease in/out at the ends) | 'free'. Returns f(x).
 */
export function monotoneCubic(xs, ys, { endSlope = 'zero' } = {}) {
  const n = xs.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => ys[0];
  const d = new Array(n - 1), m = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]);
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  m[0] = endSlope === 'zero' ? 0 : d[0];
  m[n - 1] = endSlope === 'zero' ? 0 : d[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); m[i] = tau * a * d[i]; m[i + 1] = tau * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = lastIndexLE(xs, x);
    if (i >= n - 1) i = n - 2;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/** centripetal Catmull-Rom through points pts[] (arrays of equal length) at parameter s in [0, n-1] */
export function catmullRom(pts, s, alpha = 0.5) {
  const n = pts.length;
  if (n === 1) return pts[0].slice();
  s = clamp(s, 0, n - 1);
  let i = Math.min(Math.floor(s), n - 2);
  const u = s - i;
  const p1 = pts[i], p2 = pts[i + 1];
  const p0 = i > 0 ? pts[i - 1] : p1.map((v, k) => 2 * v - p2[k]);
  const p3 = i + 2 < n ? pts[i + 2] : p2.map((v, k) => 2 * v - p1[k]);
  const dist = (a, b) => Math.sqrt(a.reduce((acc, v, k) => acc + (v - b[k]) ** 2, 0));
  const t0 = 0;
  const t1 = t0 + Math.max(1e-6, Math.pow(dist(p0, p1), alpha));
  const t2 = t1 + Math.max(1e-6, Math.pow(dist(p1, p2), alpha));
  const t3 = t2 + Math.max(1e-6, Math.pow(dist(p2, p3), alpha));
  const t = t1 + (t2 - t1) * u;
  const out = new Array(p1.length);
  for (let k = 0; k < p1.length; k++) {
    const A1 = ((t1 - t) * p0[k] + (t - t0) * p1[k]) / (t1 - t0);
    const A2 = ((t2 - t) * p1[k] + (t - t1) * p2[k]) / (t2 - t1);
    const A3 = ((t3 - t) * p2[k] + (t - t2) * p3[k]) / (t3 - t2);
    const B1 = ((t2 - t) * A1 + (t - t0) * A2) / (t2 - t0);
    const B2 = ((t3 - t) * A2 + (t - t1) * A3) / (t3 - t1);
    out[k] = ((t2 - t) * B1 + (t - t1) * B2) / (t2 - t1);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------------------------
export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
/** '#ffb35a' -> [r,g,b] LINEAR */
export function hexToLinear(hex) {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [srgbToLinear(((v >> 16) & 255) / 255), srgbToLinear(((v >> 8) & 255) / 255), srgbToLinear((v & 255) / 255)];
}
export const luminance = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

/**
 * Blackbody colour of temperature K as LINEAR sRGB, normalised to luminance 1.
 * (Planck spectrum integrated against CIE 1931 CMFs via a compact analytic fit — Kang et al. 2002
 *  for chromaticity, then XYZ->linear sRGB.) Valid ~1000K–25000K.
 */
export function kelvinToLinear(K) {
  K = clamp(K, 1000, 25000);
  let x;
  const K2 = K * K, K3 = K2 * K;
  if (K <= 4000) x = -0.2661239e9 / K3 - 0.2343589e6 / K2 + 0.8776956e3 / K + 0.17991;
  else x = -3.0258469e9 / K3 + 2.1070379e6 / K2 + 0.2226347e3 / K + 0.24039;
  const x2 = x * x, x3 = x2 * x;
  let y;
  if (K <= 2222) y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683;
  else if (K <= 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  const Y = 1, X = (x / y) * Y, Z = ((1 - x - y) / y) * Y;
  let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let g = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  let b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b || 1;
  return [r / L, g / L, b / L];
}
/**
 * White-balance gains (linear multipliers) that make a light of temperature `K` look neutral,
 * relative to D65 (6504K). E.g. whiteBalance(3200) cools the image (tungsten-balanced stock).
 * `tint` > 0 adds magenta, < 0 green.
 */
export function whiteBalance(K = 6504, tint = 0) {
  const src = kelvinToLinear(K), ref = kelvinToLinear(6504);
  const g = [ref[0] / src[0], ref[1] / src[1], ref[2] / src[2]];
  g[1] *= 1 - tint * 0.1;
  const L = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
  return [g[0] / L, g[1] / L, g[2] / L];
}

// ---------------------------------------------------------------------------------------------
// Objects / params
// ---------------------------------------------------------------------------------------------
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** deep merge (right wins); arrays replaced, not merged; returns new object */
export function deepMerge(...objs) {
  const out = {};
  for (const o of objs) {
    if (!isObj(o)) continue;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
      else if (isObj(v)) out[k] = deepMerge(v);
      else if (Array.isArray(v)) out[k] = v.slice();
      else if (v !== undefined) out[k] = v;
    }
  }
  return out;
}
/** interpolate two param trees (numbers & numeric arrays lerp; others switch at t=0.5) */
export function lerpParams(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((v, i) => lerpParams(v, b[i], t));
  if (isObj(a) && isObj(b)) {
    const out = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) out[k] = b[k];
      else if (!(k in b)) out[k] = a[k];
      else out[k] = lerpParams(a[k], b[k], t);
    }
    return out;
  }
  return t < 0.5 ? a : b;
}
/** Evaluate a "number or keyframes" spec at t: 3 | [[t,v],[t,v],...] | {keys:[[t,v]...], ease} */
export function evalCurve(spec, t, def = 0) {
  if (spec === undefined || spec === null) return def;
  if (typeof spec === 'number') return spec;
  if (typeof spec === 'function') return spec(t);
  const keys = Array.isArray(spec) ? spec : spec.keys;
  if (!keys || !keys.length) return def;
  const e = getEase(Array.isArray(spec) ? 'smooth' : spec.ease || 'smooth');
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last[1];
  const i = lastIndexLE(keys, t, (k) => k[0]);
  const k0 = keys[i], k1 = keys[i + 1];
  const u = e((t - k0[0]) / Math.max(1e-9, k1[0] - k0[0]));
  if (Array.isArray(k0[1])) return k0[1].map((v, j) => v + (k1[1][j] - v) * u);
  return k0[1] + (k1[1] - k0[1]) * u;
}
