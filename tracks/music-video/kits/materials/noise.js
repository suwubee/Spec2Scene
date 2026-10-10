// Shared material noise: one 256² RGBA8 tileable texture, baked once on the CPU (deterministic, no Math.random).
//   R = 5-octave value fbm (periods 4..64 per tile)      macro/meso variation, wind-ridge field
//   G = decorrelated second fbm                          domain warp, second layer
//   B = per-texel white-noise hash                        presence of glints/bubbles (read only with texelFetch level 0)
//   A = Worley F2−F1 (16×16 cells per tile, ×2 clipped)   ice crack network, crust plate borders
// Rule (README §Rules R1): every spatial pattern samples this texture with WORLD coordinates (or triplanar), never mesh UV
// or screen coordinates. The texture never changes with time.
import {makeRng} from '../../engine/noise.js';

export const MATERIAL_NOISE_SIZE = 256;

/** Pure bake: returns the RGBA8 data (Uint8Array, N*N*4). Same output on every call. */
export function bakeMaterialNoise(N = MATERIAL_NOISE_SIZE) {
  if (!Number.isInteger(N) || N < 64 || N > 1024 || (N & (N - 1))) throw new RangeError('noise size must be a power of two 64..1024');
  const data = new Uint8Array(N * N * 4);
  const fade = (t) => t * t * (3 - 2 * t);
  const lat = (P, s) => { const a = new Float32Array(P * P), r = makeRng('matlib:' + s + ':' + P); for (let i = 0; i < a.length; i++) a[i] = r(); return a; };
  const vn = (L, P, x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = fade(x - xi), fy = fade(y - yi);
    const i0 = ((xi % P) + P) % P, j0 = ((yi % P) + P) % P, i1 = (i0 + 1) % P, j1 = (j0 + 1) % P;
    const a = L[j0 * P + i0], b = L[j0 * P + i1], c = L[j1 * P + i0], d = L[j1 * P + i1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  const oct = (ch) => [4, 8, 16, 32, 64].map((P, k) => ({P, L: lat(P, ch + k), a: Math.pow(0.5, k)}));
  const O = [oct('r'), oct('g')];
  const raw = [new Float32Array(N * N), new Float32Array(N * N)];
  for (let c = 0; c < 2; c++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let s = 0, n = 0;
    for (const o of O[c]) { s += o.a * vn(o.L, o.P, (i / N) * o.P, (j / N) * o.P); n += o.a; }
    raw[c][j * N + i] = s / n;
  }
  // fbm averaging squeezes the range (~0.2..0.8): stretch by measured percentiles so thresholds keep their meaning
  for (let c = 0; c < 2; c++) {
    const sorted = Float32Array.from(raw[c]).sort();
    const lo = sorted[Math.floor(sorted.length * 0.005)], hi = sorted[Math.floor(sorted.length * 0.995)];
    for (let k = 0; k < N * N; k++) data[k * 4 + c] = Math.round(255 * Math.min(1, Math.max(0, (raw[c][k] - lo) / (hi - lo))));
  }
  const rw = makeRng('matlib:white');
  for (let k = 0; k < N * N; k++) data[k * 4 + 2] = Math.floor(rw() * 256) & 255;
  const C = 16, cs = N / C, rp = makeRng('matlib:worley'), pts = new Float32Array(C * C * 2);
  for (let k = 0; k < C * C; k++) { pts[k * 2] = 0.12 + 0.76 * rp(); pts[k * 2 + 1] = 0.12 + 0.76 * rp(); }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const gx = (i + 0.5) / cs, gy = (j + 0.5) / cs, cx = Math.floor(gx), cy = Math.floor(gy);
    let f1 = 1e9, f2 = 1e9;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const qx = cx + dx, qy = cy + dy, wx = ((qx % C) + C) % C, wy = ((qy % C) + C) % C;
      const d = Math.hypot(qx + pts[(wy * C + wx) * 2] - gx, qy + pts[(wy * C + wx) * 2 + 1] - gy);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    data[(j * N + i) * 4 + 3] = Math.round(255 * Math.min(1, (f2 - f1) * 2));
  }
  return data;
}

// One texture per THREE module instance, created at scene construction (never lazily inside update/render).
const cache = new WeakMap();
/** Shared noise texture. Materials never dispose it; call disposeMaterialNoise(THREE) when the whole film is torn down. */
export function getMaterialNoise(THREE) {
  if (!THREE?.DataTexture) throw new TypeError('THREE namespace required');
  if (cache.has(THREE)) return cache.get(THREE);
  const N = MATERIAL_NOISE_SIZE, tex = new THREE.DataTexture(bakeMaterialNoise(N), N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace; tex.name = 'kits.materials.noise'; tex.needsUpdate = true;
  cache.set(THREE, tex);
  return tex;
}
export function disposeMaterialNoise(THREE) { const t = cache.get(THREE); if (t) { t.dispose(); cache.delete(THREE); } }
