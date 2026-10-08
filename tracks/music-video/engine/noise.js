// Author: suwubee
// engine/noise.js — seeded RNG, integer hashes, value/gradient/simplex noise, fbm, curl noise.
// CPU (JS) and GPU (GLSL chunk) implementations share the SAME algorithms (PCG integer hashes on
// lattice coordinates), so a CPU evaluation matches the GPU one up to float rounding.
// Everything is deterministic: no Math.random anywhere.

// ---------------------------------------------------------------------------------------------
// Seeds & RNG
// ---------------------------------------------------------------------------------------------

/** 32-bit FNV-1a string hash -> uint32 */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // final avalanche
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

/** normalise a seed (number | string) to uint32 */
export function seedOf(seed) {
  if (typeof seed === 'string') return hashString(seed);
  if (!Number.isFinite(seed)) return 0x9e3779b9;
  return (Math.floor(seed) >>> 0) ^ ((Math.floor(seed / 4294967296) >>> 0) * 0x9e3779b1 >>> 0);
}

/** mulberry32: tiny, fast, good enough for procedural placement. Returns ()=>[0,1) */
export function mulberry32(seed) {
  let a = seedOf(seed) >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** sfc32: small fast counter RNG (better statistical quality). Returns ()=>[0,1) */
export function sfc32(a, b, c, d) {
  a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
  const f = function () {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) f(); // warm up
  return f;
}

/**
 * makeRng(seed) -> rich deterministic RNG object.
 *   rng()              -> float [0,1)
 *   rng.float(a,b)     -> float [a,b)
 *   rng.int(a,b)       -> int  [a,b] inclusive
 *   rng.pick(arr)      -> element
 *   rng.chance(p)      -> bool
 *   rng.sign()         -> -1 | 1
 *   rng.normal(m,s)    -> gaussian (Box-Muller)
 *   rng.jitter(v, amt) -> v*(1+amt*(2u-1))
 *   rng.fork(label)    -> independent child RNG (seeded from parent seed + label, NOT from state)
 *   rng.shuffle(arr)   -> in-place Fisher-Yates
 */
export function makeRng(seed = 1) {
  const s = seedOf(seed);
  const base = sfc32(0x9e3779b9 ^ s, 0x243f6a88 + s, 0xb7e15162 ^ Math.imul(s, 0x85ebca6b), s ^ 0x3c6ef372);
  const rng = () => base();
  rng.seed = s;
  rng.float = (a = 0, b = 1) => a + (b - a) * base();
  rng.int = (a, b) => a + Math.floor(base() * (b - a + 1));
  rng.pick = (arr) => arr[Math.floor(base() * arr.length)];
  rng.chance = (p) => base() < p;
  rng.sign = () => (base() < 0.5 ? -1 : 1);
  rng.normal = (m = 0, sd = 1) => {
    const u = Math.max(base(), 1e-12), v = base();
    return m + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  rng.jitter = (v, amt) => v * (1 + amt * (2 * base() - 1));
  rng.fork = (label) => makeRng(hashString(s + ':' + label));
  rng.shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(base() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  };
  return rng;
}

// ---------------------------------------------------------------------------------------------
// Integer hashes (PCG family, Jarzynski & Olano 2020) — identical in GLSL below.
// ---------------------------------------------------------------------------------------------

/** pcg(uint) -> uint */
export function pcg(v) {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}
/** pcg2d(ux,uy) -> [ux,uy] */
export function pcg2d(x, y) {
  x = (Math.imul(x >>> 0, 1664525) + 1013904223) >>> 0;
  y = (Math.imul(y >>> 0, 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, 1664525)) >>> 0;
  y = (y + Math.imul(x, 1664525)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  x = (x + Math.imul(y, 1664525)) >>> 0;
  y = (y + Math.imul(x, 1664525)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  return [x, y];
}
/** pcg3d(ux,uy,uz) -> [ux,uy,uz] */
export function pcg3d(x, y, z) {
  x = (Math.imul(x >>> 0, 1664525) + 1013904223) >>> 0;
  y = (Math.imul(y >>> 0, 1664525) + 1013904223) >>> 0;
  z = (Math.imul(z >>> 0, 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  return [x, y, z];
}
const U2F = 1 / 4294967296;
// Float -> lattice int (same as GLSL: uint(int(floor(x))) — two's complement wrap)
const li = (x) => (Math.floor(x) | 0) >>> 0;

/** hash of integer n (+seed) -> [0,1) */
export function hash11(n, seed = 0) { return pcg((li(n) + Math.imul(seedOf(seed), 0x9e3779b9)) >>> 0) * U2F; }
/** hash of integer lattice point (x,y) -> [0,1) */
export function hash21(x, y) { return pcg2d(li(x), li(y))[0] * U2F; }
/** hash of lattice (x,y) -> [a,b] both [0,1) */
export function hash22(x, y) { const h = pcg2d(li(x), li(y)); return [h[0] * U2F, h[1] * U2F]; }
/** hash of lattice (x,y,z) -> [0,1) */
export function hash31(x, y, z) { return pcg3d(li(x), li(y), li(z))[0] * U2F; }
/** hash of lattice (x,y,z) -> [a,b,c] */
export function hash33(x, y, z) { const h = pcg3d(li(x), li(y), li(z)); return [h[0] * U2F, h[1] * U2F, h[2] * U2F]; }

// ---------------------------------------------------------------------------------------------
// Noise (all return ~[-1,1] unless noted). Quintic fade.
// ---------------------------------------------------------------------------------------------
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

/** 1D value noise in [-1,1] */
export function vnoise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i, u = fade(f);
  const s = Math.imul(seedOf(seed), 0x9e3779b9);
  const a = pcg((li(i) + s) >>> 0) * U2F, b = pcg((li(i + 1) + s) >>> 0) * U2F;
  return lerp(a, b, u) * 2 - 1;
}
/** 1D gradient noise in ~[-1,1] (smoother, zero at integers) */
export function gnoise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i, u = fade(f);
  const s = Math.imul(seedOf(seed), 0x9e3779b9);
  const ga = pcg((li(i) + s) >>> 0) * U2F * 2 - 1, gb = pcg((li(i + 1) + s) >>> 0) * U2F * 2 - 1;
  return lerp(ga * f, gb * (f - 1), u) * 2.0;
}
/** 2D value noise in [-1,1] */
export function vnoise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fade(fx), uy = fade(fy);
  const a = hash21(ix, iy), b = hash21(ix + 1, iy), c = hash21(ix, iy + 1), d = hash21(ix + 1, iy + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 2 - 1;
}
/** 3D value noise in [-1,1] */
export function vnoise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fade(fx), uy = fade(fy), uz = fade(fz);
  const n000 = hash31(ix, iy, iz), n100 = hash31(ix + 1, iy, iz), n010 = hash31(ix, iy + 1, iz), n110 = hash31(ix + 1, iy + 1, iz);
  const n001 = hash31(ix, iy, iz + 1), n101 = hash31(ix + 1, iy, iz + 1), n011 = hash31(ix, iy + 1, iz + 1), n111 = hash31(ix + 1, iy + 1, iz + 1);
  return lerp(lerp(lerp(n000, n100, ux), lerp(n010, n110, ux), uy), lerp(lerp(n001, n101, ux), lerp(n011, n111, ux), uy), uz) * 2 - 1;
}
function grad2(ix, iy, fx, fy) {
  const h = hash22(ix, iy);
  const a = h[0] * 6.283185307179586;
  return Math.cos(a) * fx + Math.sin(a) * fy;
}
/** 2D gradient (Perlin-style) noise, ~[-1,1] */
export function gnoise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fade(fx), uy = fade(fy);
  const a = grad2(ix, iy, fx, fy), b = grad2(ix + 1, iy, fx - 1, fy);
  const c = grad2(ix, iy + 1, fx, fy - 1), d = grad2(ix + 1, iy + 1, fx - 1, fy - 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 1.4142;
}
function grad3(ix, iy, iz, fx, fy, fz) {
  const h = hash33(ix, iy, iz);
  // uniform-ish direction from 3 hashes (normalised cube -> sphere)
  let gx = h[0] * 2 - 1, gy = h[1] * 2 - 1, gz = h[2] * 2 - 1;
  const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
  return (gx * fx + gy * fy + gz * fz) / l;
}
/** 3D gradient noise, ~[-1,1] */
export function gnoise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fade(fx), uy = fade(fy), uz = fade(fz);
  const n000 = grad3(ix, iy, iz, fx, fy, fz), n100 = grad3(ix + 1, iy, iz, fx - 1, fy, fz);
  const n010 = grad3(ix, iy + 1, iz, fx, fy - 1, fz), n110 = grad3(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz);
  const n001 = grad3(ix, iy, iz + 1, fx, fy, fz - 1), n101 = grad3(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1);
  const n011 = grad3(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1), n111 = grad3(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1);
  return lerp(lerp(lerp(n000, n100, ux), lerp(n010, n110, ux), uy), lerp(lerp(n001, n101, ux), lerp(n011, n111, ux), uy), uz) * 1.5;
}

// Simplex 2D / 3D with PCG-hashed gradients (same as GLSL mvSimplex2/3)
const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
/** 2D simplex noise, ~[-1,1] */
export function snoise2(x, y) {
  const s = (x + y) * F2;
  const i = Math.floor(x + s), j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t), y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  let n = 0;
  const corner = (cx, cy, dx, dy) => {
    let tt = 0.5 - dx * dx - dy * dy;
    if (tt <= 0) return 0;
    const a = hash21(cx, cy) * 6.283185307179586;
    tt *= tt;
    return tt * tt * (Math.cos(a) * dx + Math.sin(a) * dy);
  };
  n += corner(i, j, x0, y0);
  n += corner(i + i1, j + j1, x1, y1);
  n += corner(i + 1, j + 1, x2, y2);
  return 99.2 * n; // ~[-1,1]
}
/** 3D simplex noise, ~[-1,1] */
export function snoise3(x, y, z) {
  const F3 = 1 / 3, G3 = 1 / 6;
  const s = (x + y + z) * F3;
  const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
  const t = (i + j + k) * G3;
  const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }
  const corner = (ci, cj, ck, dx, dy, dz) => {
    let tt = 0.6 - dx * dx - dy * dy - dz * dz;
    if (tt <= 0) return 0;
    const h = hash33(ci, cj, ck);
    let gx = h[0] * 2 - 1, gy = h[1] * 2 - 1, gz = h[2] * 2 - 1;
    const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
    tt *= tt;
    return tt * tt * (gx * dx + gy * dy + gz * dz) / l;
  };
  let n = corner(i, j, k, x0, y0, z0);
  n += corner(i + i1, j + j1, k + k1, x0 - i1 + G3, y0 - j1 + G3, z0 - k1 + G3);
  n += corner(i + i2, j + j2, k + k2, x0 - i2 + 2 * G3, y0 - j2 + 2 * G3, z0 - k2 + 2 * G3);
  n += corner(i + 1, j + 1, k + 1, x0 - 1 + 3 * G3, y0 - 1 + 3 * G3, z0 - 1 + 3 * G3);
  return 42.5 * n;
}

/**
 * fbm over any noise fn: fbm(noiseFn, [x,y,(z)], {octaves, lacunarity, gain})
 * Returns roughly [-1,1] (normalised by the amplitude sum).
 */
export function fbm(fn, p, { octaves = 5, lacunarity = 2.03, gain = 0.5, shift = 17.13 } = {}) {
  let sum = 0, amp = 1, norm = 0;
  const q = p.slice();
  for (let o = 0; o < octaves; o++) {
    sum += amp * fn(...q);
    norm += amp;
    for (let k = 0; k < q.length; k++) q[k] = q[k] * lacunarity + shift * (k + 1);
    amp *= gain;
  }
  return sum / norm;
}
export const fbm1 = (x, oct = 5, gain = 0.5, seed = 0) => {
  let s = 0, a = 1, n = 0, f = 1;
  for (let o = 0; o < oct; o++) { s += a * gnoise1(x * f + o * 31.7, seed); n += a; f *= 2.03; a *= gain; }
  return s / n;
};
export const fbm2 = (x, y, oct = 5, gain = 0.5) => fbm(gnoise2, [x, y], { octaves: oct, gain });
export const fbm3 = (x, y, z, oct = 5, gain = 0.5) => fbm(gnoise3, [x, y, z], { octaves: oct, gain });

/**
 * pink1(t, seed, {octaves, fmin}) — 1/f ("pink") noise of time, ~[-1,1].
 * Octave amplitudes fall as f^-0.5 (power ∝ 1/f) — use for flicker, handheld, wind gusts.
 */
export function pink1(t, seed = 0, { octaves = 6, fmin = 0.25, lacunarity = 2.0 } = {}) {
  let s = 0, n = 0, f = fmin, a = 1;
  const sd = seedOf(seed);
  for (let o = 0; o < octaves; o++) {
    s += a * gnoise1(t * f + o * 13.37, sd + o * 7919);
    n += a * a;
    f *= lacunarity;
    a *= 0.70710678;
  }
  return s / Math.sqrt(n) * 0.9;
}

/** 2D curl of a scalar simplex potential -> [vx, vy] (divergence free) */
export function curl2(x, y, eps = 1e-3) {
  const dx = (snoise2(x + eps, y) - snoise2(x - eps, y)) / (2 * eps);
  const dy = (snoise2(x, y + eps) - snoise2(x, y - eps)) / (2 * eps);
  return [dy, -dx];
}
/** 3D curl noise of a vector potential (3 offset simplex fields) -> [vx,vy,vz] */
export function curl3(x, y, z, eps = 1e-3) {
  const P = (a, b, c) => [snoise3(a, b, c), snoise3(a + 31.416, b - 47.853, c + 12.793), snoise3(a - 91.537, b + 23.19, c - 67.41)];
  const px0 = P(x - eps, y, z), px1 = P(x + eps, y, z);
  const py0 = P(x, y - eps, z), py1 = P(x, y + eps, z);
  const pz0 = P(x, y, z - eps), pz1 = P(x, y, z + eps);
  const i2 = 1 / (2 * eps);
  const cx = ((py1[2] - py0[2]) - (pz1[1] - pz0[1])) * i2;
  const cy = ((pz1[0] - pz0[0]) - (px1[2] - px0[2])) * i2;
  const cz = ((px1[1] - px0[1]) - (py1[0] - py0[0])) * i2;
  return [cx, cy, cz];
}

// ---------------------------------------------------------------------------------------------
// GLSL chunk — concatenate into any ShaderMaterial (GLSL ES 3.00; three.js always compiles
// WebGL2 shaders as #version 300 es, so uint ops are available). Include-guarded, so it is safe
// to concatenate several times. All names are prefixed `mv` to avoid collisions.
// ---------------------------------------------------------------------------------------------
export const GLSL_HASH = /* glsl */ `
#ifndef MV_HASH_GLSL
#define MV_HASH_GLSL
uint mvPcg(uint v){ uint state = v * 747796405u + 2891336453u; uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u; return (word >> 22u) ^ word; }
uvec2 mvPcg2d(uvec2 v){ v = v * 1664525u + 1013904223u; v.x += v.y * 1664525u; v.y += v.x * 1664525u; v = v ^ (v >> 16u); v.x += v.y * 1664525u; v.y += v.x * 1664525u; v = v ^ (v >> 16u); return v; }
uvec3 mvPcg3d(uvec3 v){ v = v * 1664525u + 1013904223u; v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y; v ^= v >> 16u; v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y; return v; }
const float MV_U2F = 1.0/4294967296.0;
// lattice hashes: arguments are floored to ints (two's complement wrap like the JS version)
float mvHash11(float n){ return float(mvPcg(uint(int(floor(n))))) * MV_U2F; }
float mvHash21(vec2 p){ return float(mvPcg2d(uvec2(ivec2(floor(p)))).x) * MV_U2F; }
vec2  mvHash22(vec2 p){ return vec2(mvPcg2d(uvec2(ivec2(floor(p))))) * MV_U2F; }
float mvHash31(vec3 p){ return float(mvPcg3d(uvec3(ivec3(floor(p)))).x) * MV_U2F; }
vec3  mvHash33(vec3 p){ return vec3(mvPcg3d(uvec3(ivec3(floor(p))))) * MV_U2F; }
// pixel/frame hash for dithering & grain: (integer pixel, integer frame) -> [0,1)^3
vec3  mvHashPixel(ivec2 px, int frame){ return vec3(mvPcg3d(uvec3(uint(px.x), uint(px.y), uint(frame)))) * MV_U2F; }
// interleaved gradient noise (Jimenez) — cheap per-pixel blue-ish noise
float mvIGN(vec2 px){ return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
#endif
`;

export const GLSL_NOISE = GLSL_HASH + /* glsl */ `
#ifndef MV_NOISE_GLSL
#define MV_NOISE_GLSL
float mvFade(float t){ return t*t*t*(t*(t*6.0-15.0)+10.0); }
vec2  mvFade(vec2 t){ return t*t*t*(t*(t*6.0-15.0)+10.0); }
vec3  mvFade(vec3 t){ return t*t*t*(t*(t*6.0-15.0)+10.0); }
// value noise [-1,1]
float mvValue(vec2 p){ vec2 i = floor(p), f = p - i, u = mvFade(f);
  float a = mvHash21(i), b = mvHash21(i+vec2(1,0)), c = mvHash21(i+vec2(0,1)), d = mvHash21(i+vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y)*2.0-1.0; }
float mvValue(vec3 p){ vec3 i = floor(p), f = p - i, u = mvFade(f);
  float n000=mvHash31(i), n100=mvHash31(i+vec3(1,0,0)), n010=mvHash31(i+vec3(0,1,0)), n110=mvHash31(i+vec3(1,1,0));
  float n001=mvHash31(i+vec3(0,0,1)), n101=mvHash31(i+vec3(1,0,1)), n011=mvHash31(i+vec3(0,1,1)), n111=mvHash31(i+vec3(1,1,1));
  return mix(mix(mix(n000,n100,u.x),mix(n010,n110,u.x),u.y), mix(mix(n001,n101,u.x),mix(n011,n111,u.x),u.y), u.z)*2.0-1.0; }
// gradient noise ~[-1,1]
float mvGrad2(vec2 i, vec2 f){ float a = mvHash22(i).x*6.283185307179586; return cos(a)*f.x + sin(a)*f.y; }
float mvGradient(vec2 p){ vec2 i = floor(p), f = p - i, u = mvFade(f);
  float a = mvGrad2(i,f), b = mvGrad2(i+vec2(1,0), f-vec2(1,0)), c = mvGrad2(i+vec2(0,1), f-vec2(0,1)), d = mvGrad2(i+vec2(1,1), f-vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y)*1.4142; }
float mvGrad3(vec3 i, vec3 f){ vec3 g = mvHash33(i)*2.0-1.0; float l = length(g); return dot(g,f)/(l > 0.0 ? l : 1.0); }
float mvGradient(vec3 p){ vec3 i = floor(p), f = p - i, u = mvFade(f);
  float n000=mvGrad3(i,f), n100=mvGrad3(i+vec3(1,0,0),f-vec3(1,0,0)), n010=mvGrad3(i+vec3(0,1,0),f-vec3(0,1,0)), n110=mvGrad3(i+vec3(1,1,0),f-vec3(1,1,0));
  float n001=mvGrad3(i+vec3(0,0,1),f-vec3(0,0,1)), n101=mvGrad3(i+vec3(1,0,1),f-vec3(1,0,1)), n011=mvGrad3(i+vec3(0,1,1),f-vec3(0,1,1)), n111=mvGrad3(i+vec3(1,1,1),f-vec3(1,1,1));
  return mix(mix(mix(n000,n100,u.x),mix(n010,n110,u.x),u.y), mix(mix(n001,n101,u.x),mix(n011,n111,u.x),u.y), u.z)*1.5; }
// simplex noise ~[-1,1]
float mvSimplex(vec2 p){
  const float F2 = 0.36602540378, G2 = 0.21132486540;
  vec2 i = floor(p + (p.x+p.y)*F2); vec2 x0 = p - (i - (i.x+i.y)*G2);
  vec2 i1 = (x0.x > x0.y) ? vec2(1,0) : vec2(0,1);
  vec2 x1 = x0 - i1 + G2, x2 = x0 - 1.0 + 2.0*G2;
  float n = 0.0; float t; float a;
  t = 0.5 - dot(x0,x0); if(t > 0.0){ a = mvHash21(i)*6.283185307179586; t*=t; n += t*t*dot(vec2(cos(a),sin(a)), x0); }
  t = 0.5 - dot(x1,x1); if(t > 0.0){ a = mvHash21(i+i1)*6.283185307179586; t*=t; n += t*t*dot(vec2(cos(a),sin(a)), x1); }
  t = 0.5 - dot(x2,x2); if(t > 0.0){ a = mvHash21(i+1.0)*6.283185307179586; t*=t; n += t*t*dot(vec2(cos(a),sin(a)), x2); }
  return 99.2*n; }
float mvSimplexCorner(vec3 c, vec3 d){ float t = 0.6 - dot(d,d); if(t <= 0.0) return 0.0; vec3 g = mvHash33(c)*2.0-1.0; float l = length(g); t*=t; return t*t*dot(g,d)/(l > 0.0 ? l : 1.0); }
float mvSimplex(vec3 p){
  const float F3 = 1.0/3.0, G3 = 1.0/6.0;
  vec3 i = floor(p + dot(p, vec3(F3))); vec3 x0 = p - (i - dot(i, vec3(G3)));
  // tie-break identical to the JS version (x>=y, y>=z, x>=z)
  vec3 i1, i2;
  if (x0.x >= x0.y) { if (x0.y >= x0.z) { i1=vec3(1,0,0); i2=vec3(1,1,0);} else if (x0.x >= x0.z) { i1=vec3(1,0,0); i2=vec3(1,0,1);} else { i1=vec3(0,0,1); i2=vec3(1,0,1);} }
  else { if (x0.y < x0.z) { i1=vec3(0,0,1); i2=vec3(0,1,1);} else if (x0.x < x0.z) { i1=vec3(0,1,0); i2=vec3(0,1,1);} else { i1=vec3(0,1,0); i2=vec3(1,1,0);} }
  float n = mvSimplexCorner(i, x0);
  n += mvSimplexCorner(i+i1, x0 - i1 + G3);
  n += mvSimplexCorner(i+i2, x0 - i2 + 2.0*G3);
  n += mvSimplexCorner(i+1.0, x0 - 1.0 + 3.0*G3);
  return 42.5*n; }
// fbm (gradient noise), normalised ~[-1,1]
float mvFbm(vec2 p, int oct){ float s=0.0, a=1.0, n=0.0; for(int o=0;o<12;o++){ if(o>=oct) break; s+=a*mvGradient(p); n+=a; p=p*2.03+vec2(17.13,34.26); a*=0.5; } return s/n; }
float mvFbm(vec3 p, int oct){ float s=0.0, a=1.0, n=0.0; for(int o=0;o<12;o++){ if(o>=oct) break; s+=a*mvGradient(p); n+=a; p=p*2.03+vec3(17.13,34.26,51.39); a*=0.5; } return s/n; }
// value-noise fbm (cheaper, slightly blockier)
float mvFbmV(vec2 p, int oct){ float s=0.0, a=1.0, n=0.0; for(int o=0;o<12;o++){ if(o>=oct) break; s+=a*mvValue(p); n+=a; p=p*2.03+vec2(17.13,34.26); a*=0.5; } return s/n; }
float mvFbmV(vec3 p, int oct){ float s=0.0, a=1.0, n=0.0; for(int o=0;o<12;o++){ if(o>=oct) break; s+=a*mvValue(p); n+=a; p=p*2.03+vec3(17.13,34.26,51.39); a*=0.5; } return s/n; }
// ridged fbm [0,1]
float mvRidged(vec2 p, int oct){ float s=0.0, a=0.5, n=0.0; for(int o=0;o<12;o++){ if(o>=oct) break; float r = 1.0-abs(mvGradient(p)); s+=a*r*r; n+=a; p=p*2.03+vec2(17.13,34.26); a*=0.5; } return s/n; }
// curl noise (divergence-free) of a simplex potential
vec2 mvCurl(vec2 p){ const float e = 1e-3; float dx = (mvSimplex(p+vec2(e,0))-mvSimplex(p-vec2(e,0)))/(2.0*e); float dy = (mvSimplex(p+vec2(0,e))-mvSimplex(p-vec2(0,e)))/(2.0*e); return vec2(dy,-dx); }
vec3 mvPot3(vec3 p){ return vec3(mvSimplex(p), mvSimplex(p+vec3(31.416,-47.853,12.793)), mvSimplex(p+vec3(-91.537,23.19,-67.41))); }
vec3 mvCurl(vec3 p){ const float e = 1e-3;
  vec3 px0 = mvPot3(p-vec3(e,0,0)), px1 = mvPot3(p+vec3(e,0,0));
  vec3 py0 = mvPot3(p-vec3(0,e,0)), py1 = mvPot3(p+vec3(0,e,0));
  vec3 pz0 = mvPot3(p-vec3(0,0,e)), pz1 = mvPot3(p+vec3(0,0,e));
  return vec3((py1.z-py0.z)-(pz1.y-pz0.y), (pz1.x-pz0.x)-(px1.z-px0.z), (px1.y-px0.y)-(py1.x-py0.x))/(2.0*e); }
// 1D gradient noise, identical to JS gnoise1(x, seed) for integer seeds
float mvGradient1(float x, uint seed){ float i = floor(x), f = x - i, u = mvFade(f); uint s = seed * 0x9e3779b9u;
  float ga = float(mvPcg(uint(int(i)) + s))*MV_U2F*2.0-1.0, gb = float(mvPcg(uint(int(i)+1) + s))*MV_U2F*2.0-1.0;
  return mix(ga*f, gb*(f-1.0), u)*2.0; }
// 1/f ("pink") noise of time, identical to JS pink1(t, seed) with default options (6 octaves, fmin 0.25)
float mvPink(float t, uint seed){ float s=0.0, n=0.0, f=0.25, a=1.0; for(int o=0;o<6;o++){ s += a*mvGradient1(t*f + float(o)*13.37, seed + uint(o)*7919u); n += a*a; f*=2.0; a*=0.70710678; } return s/sqrt(n)*0.9; }
#endif
`;

/** Everything (hash + noise). `import { GLSL_NOISE } from '../engine/noise.js'` and prepend to your shader. */
export const GLSL = GLSL_NOISE;
