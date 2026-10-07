// Author: suwubee
// ground/textures.js — CPU-baked, deterministic, tileable data textures (no image files).
//   bakeNoise()   256² RGBA8: R fine fbm, G medium fbm, B blotches, A fine grain          (grass / soil / stains / wear)
//   bakePebbles() 256² RGBA8: R pebble dome height, G / B per-pebble hashes, A gap factor   (花街铺地 pebble mosaic)
//   controlTextures(THREE, field) / heightTexture(THREE, field)
import { hash21 } from '../../engine/noise.js';

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** periodic value noise in [0,1]: lattice period `per` cells, hashed with `seed` */
function vnoiseP(x, y, per, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = fade(x - xi), fy = fade(y - yi);
  const m = (v) => ((v % per) + per) % per;
  const x0 = m(xi), x1 = m(xi + 1), y0 = m(yi), y1 = m(yi + 1);
  const h = (a, b) => hash21(a + seed * 131, b + seed * 71);
  const a = h(x0, y0), b = h(x1, y0), c = h(x0, y1), d = h(x1, y1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbmP(u, v, basePer, oct, seed, gain = 0.5) {
  let s = 0, a = 1, n = 0, per = basePer;
  for (let o = 0; o < oct; o++) { s += a * vnoiseP(u * per, v * per, per, seed + o * 17); n += a; per *= 2; a *= gain; }
  return s / n;
}

export function bakeNoise(THREE, N = 256) {
  const d = new Uint8Array(N * N * 4);
  const q = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  // contrast stretch of fbm (values cluster around 0.5)
  const st = (v) => (v - 0.5) * 1.9 + 0.5;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u = i / N, v = j / N, o = (j * N + i) * 4;
    d[o] = q(st(fbmP(u, v, 6, 5, 1)));
    d[o + 1] = q(st(fbmP(u, v, 4, 4, 2)));
    d[o + 2] = q(st(fbmP(u, v, 2, 3, 3)));
    d[o + 3] = q(st(fbmP(u, v, 48, 2, 4, 0.6)));
  }
  const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 4; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  return t;
}

/** Voronoi pebble tile: 14×14 pebbles per tile (tile = 0.64 m in the shader → ~4.6 cm pebbles). Periodic. */
export function bakePebbles(THREE, N = 256, cells = 14) {
  const d = new Uint8Array(N * N * 4);
  const pts = [];                                  // jittered feature point per cell
  for (let cy = 0; cy < cells; cy++) for (let cx = 0; cx < cells; cx++) {
    pts.push([cx + 0.18 + 0.64 * hash21(cx + 3, cy + 5), cy + 0.18 + 0.64 * hash21(cx + 31, cy + 17)]);
  }
  const q = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const px = (i + 0.5) / N * cells, py = (j + 0.5) / N * cells;
    const cx = Math.floor(px), cy = Math.floor(py);
    let f1 = 9, f2 = 9, id = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox, gy = cy + oy;
      const wx = ((gx % cells) + cells) % cells, wy = ((gy % cells) + cells) % cells;
      const p = pts[wy * cells + wx];
      const fx = p[0] + (gx - wx), fy = p[1] + (gy - wy);   // feature point in unwrapped space
      const dd = Math.hypot(px - fx, py - fy);
      if (dd < f1) { f2 = f1; f1 = dd; id = wy * cells + wx; } else if (dd < f2) f2 = dd;
    }
    const gap = Math.min(1, (f2 - f1) / 0.55);                    // 0 on the cell border, → 1 in the pebble
    const dome = Math.sqrt(Math.max(0, 1 - Math.pow(f1 / 0.62, 2))) * Math.min(1, gap * 2.2);
    const o = (j * N + i) * 4;
    d[o] = q(dome); d[o + 1] = q(hash21(id + 101, 7)); d[o + 2] = q(hash21(id + 13, 211)); d[o + 3] = q(gap);
  }
  const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 4; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  return t;
}

/** signed-distance control textures of the field: tSdf (R path, G court, B wood, A outline), tAtt (R path style, G path hash, B court hash) */
