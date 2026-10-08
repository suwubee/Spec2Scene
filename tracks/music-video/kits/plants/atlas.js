// Author: suwubee
// plants/atlas.js — CPU-baked procedural leaf atlas (no image files). Pure JS (runs in Node too).
//
// 1024 x 1024 RGBA8, 4 x 4 tiles of 256 px.  RGB = leaf shading multiplier (the albedo colour comes from vertex /
// instance colours), A = coverage (cut-out).  Empty texels carry the tile's mean colour so mip-mapping does not
// darken the edges, and every mip level has its alpha rescaled so that the share of texels above the alpha-test
// threshold stays constant (leaves do not thin out with distance).
import { makeRng } from '../../engine/noise.js';

export const N = 256;            // tile size (px)
export const TILES = 4;          // tiles per row
export const ROWS = 8;           // tile rows
export const SIZE = N * TILES;   // atlas width
export const SIZE_H = N * ROWS;  // atlas height
export const ALPHA_TEST = 0.45;

/** tile name -> index (row-major) */
export const TILE = {
  broad: 0,       // ovate leaf sprays (camphor, osmanthus, generic)
  large: 1,       // big glossy / broad leaves (magnolia, loquat, camellia)
  fine: 2,        // many small leaflets (locust, elm, plum, azalea)
  willow: 3,      // hanging willow strands
  pine: 4,        // pine needle pad
  bamboo: 5,      // bamboo leaf spray
  banana: 6,      // banana blade (torn)
  lotus: 7,       // lotus leaf disc with radial veins and the notch
  tuft: 8,        // 沿阶草 strap-leaf tuft
  reed: 9,        // reed blades
  maple: 10,      // palmate maple leaves
  wutong: 11,     // large lobed parasol-tree leaves
  clump: 12,      // dense ragged leafy clump (LOD1 big cards)
  cypress: 13,    // scale-leaf spray (cypress / podocarpus)
  lily: 14,       // water-lily pad + a few flower petals
  petal: 15,      // lotus flower petals (white-pink gradient carried by vertex colour)
  // near-LOD sprays: fewer, bigger, crisp leaves for small cards (3-8 m viewing distance)
  broadN: 16, largeN: 17, fineN: 18, mapleN: 19, wutongN: 20, bambooN: 21, willowN: 22, pineN: 23,
  denseN: 24, denseL: 25, denseF: 26,   // near-LOD body cards: a cluster of crisp leaves on a dark ragged underlay (high fill, small leaves)
  ginkgo: 27, ginkgoN: 28, denseG: 29,  // 银杏: spurs with fan-shaped leaves (spray / near spray / dense body cluster)
  densePal: 30,                         // dense cluster of palmate (maple / plane / parasol-tree) leaves
};

/** uv rectangle of a tile [u0, v0, u1, v1] (v up, flipY = false in the texture => v measured from the top row) */
export function tileRect(name, inset = 0.5) {
  const i = TILE[name], cx = i % TILES, cy = Math.floor(i / TILES);
  const eu = inset / SIZE, ev = inset / SIZE_H;
  return [cx / TILES + eu, cy / ROWS + ev, (cx + 1) / TILES - eu, (cy + 1) / ROWS - ev];
}

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

class Tile {
  constructor() {
    this.r = new Float32Array(N * N); this.g = new Float32Array(N * N); this.b = new Float32Array(N * N); this.a = new Float32Array(N * N);
  }
  /** composite a pixel with coverage c and colour (r,g,b) over the existing content */
  put(x, y, c, r, g, b) {
    if (x < 0 || y < 0 || x >= N || y >= N || c <= 0) return;
    const i = y * N + x, da = this.a[i], oa = c + da * (1 - c);
    const k = da * (1 - c);
    this.r[i] = (r * c + this.r[i] * k) / oa; this.g[i] = (g * c + this.g[i] * k) / oa; this.b[i] = (b * c + this.b[i] * k) / oa;
    this.a[i] = oa;
  }
  /** erase (cut a hole) */
  cut(x, y, c) { if (x < 0 || y < 0 || x >= N || y >= N || c <= 0) return; const i = y * N + x; this.a[i] *= (1 - clamp(c)); }
}

// ------------------------------------------------------------------------------------------------ leaf painter
// profile(u) -> half-width factor 0..1 along the leaf (u = 0 base, 1 tip)
const PROF = {
  ovate: (u) => Math.pow(Math.sin(Math.PI * Math.pow(u, 0.72)), 0.85),
  elliptic: (u) => Math.pow(Math.sin(Math.PI * u), 0.75),
  lance: (u) => Math.pow(Math.sin(Math.PI * Math.pow(u, 0.9)), 1.0) * (1 - 0.25 * u),
  narrow: (u) => Math.sin(Math.PI * Math.pow(u, 0.8)) * (1 - 0.5 * u),
  obovate: (u) => Math.pow(Math.sin(Math.PI * Math.pow(u, 1.35)), 0.8),
  strap: (u) => Math.min(1, u * 9) * Math.min(1, (1 - u) * 5 + 0.04) ,
};

/**
 * paint one leaf. (x0, y0) = base in tile px, ang = axis direction (rad, 0 = +x, +y is DOWN in tile space),
 * L = length, Wd = half width, k = brightness multiplier, tone = [dr, dg, db] small colour drift
 */
function leaf(T, x0, y0, ang, L, Wd, prof, k, o = {}) {
  const ca = Math.cos(ang), sa = Math.sin(ang), R = Math.ceil(L + Wd) + 2;
  const veins = o.veins ?? 1, rib = o.rib ?? 1, bend = o.bend ?? 0;
  const tr = o.tone || [1, 1, 1];
  for (let py = Math.floor(y0 - R); py <= Math.ceil(y0 + R); py++) {
    for (let px = Math.floor(x0 - R); px <= Math.ceil(x0 + R); px++) {
      if (px < 0 || py < 0 || px >= N || py >= N) continue;
      const dx = px + 0.5 - x0, dy = py + 0.5 - y0;
      const along = dx * ca + dy * sa;
      if (along < -1 || along > L + 1) continue;
      let u = along / L;
      const across0 = -dx * sa + dy * ca;
      const across = across0 - bend * L * u * u;                   // curved blade
      const w = Wd * prof(clamp(u));
      if (w <= 0.05) continue;
      const d = Math.abs(across);
      const edge = Math.min(w - d, along + 0.5, L - along + 0.5);
      const cov = clamp(edge + 0.5);
      if (cov <= 0) continue;
      let lum = k * (0.78 + 0.3 * u) * (1 - 0.30 * Math.pow(d / w, 3));
      if (rib && d < 0.8 + 0.5 * (1 - u)) lum *= 1.16;
      if (veins) {
        const ph = (along - d * 0.65) / (L / 7.5);
        const vv = Math.abs(Math.sin(ph * Math.PI));
        lum *= 1 - 0.14 * Math.pow(vv, 6) * smooth(0.0, 0.5, d / w);
      }
      T.put(px, py, cov, lum * tr[0], lum * tr[1], lum * tr[2]);
    }
  }
}
/** thin line (twig / stem) with width w px, colour lum */
function line(T, x0, y0, x1, y1, w, lum, tone = [1, 0.85, 0.7]) {
  const L = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(L * 1.5) + 1;
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t, r = Math.ceil(w) + 1;
    for (let py = Math.floor(y - r); py <= Math.ceil(y + r); py++) for (let px = Math.floor(x - r); px <= Math.ceil(x + r); px++) {
      const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
      T.put(px, py, clamp(w * 0.5 - d + 0.5) * 0.9, lum * tone[0], lum * tone[1], lum * tone[2]);
    }
  }
}
function curve(T, pts, w0, w1, lum0, lum1, tone) {
  for (let i = 0; i < pts.length - 1; i++) {
    const t = i / (pts.length - 1);
    line(T, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w0 + (w1 - w0) * t, lum0 + (lum1 - lum0) * t, tone);
  }
}
const TWIG = [0.5, 0.42, 0.3];

// ------------------------------------------------------------------------------------------------ tiles
function tileBroad(T, rng, o = {}) {
  // fan of twigs from the bottom centre; paired ovate leaves along each twig
  const cx = 128, cy = 238, nT = o.twigs ?? 6;
  const twigs = [];
  for (let t = 0; t < nT; t++) twigs.push({ a: -Math.PI / 2 + (t / (nT - 1) - 0.5) * 1.55 + (rng() - 0.5) * 0.2, len: 100 + 30 * rng() - Math.abs(t - nT / 2 + 0.5) * 5 });
  twigs.sort((p, q) => Math.abs(q.a + Math.PI / 2) - Math.abs(p.a + Math.PI / 2));
  const Lb = o.L ?? 36, Wb = o.W ?? 15, prof = o.prof || PROF.ovate;
  let idx = 0;
  for (const tw of twigs) {
    const ex = cx + Math.cos(tw.a) * tw.len, ey = cy + Math.sin(tw.a) * tw.len;
    line(T, cx, cy, ex, ey, 2.2, 0.35, TWIG);
    const step = o.step ?? 17;
    for (let s = step * 1.2; s < tw.len; s += step) {
      const px = cx + Math.cos(tw.a) * s, py = cy + Math.sin(tw.a) * s;
      const sz = 0.7 + 0.45 * (s / tw.len) * (1 - s / tw.len) * 4 * 0.6 + 0.2 * rng();
      for (const side of [-1, 1]) {
        if (rng() < 0.12) continue;
        const a = tw.a + side * (0.85 + 0.35 * rng());
        const kk = (0.55 + 0.45 * ((idx++ % 7) / 7)) * (0.8 + 0.35 * rng());
        leaf(T, px, py, a, Lb * sz, Wb * sz, prof, kk, { tone: [1 + 0.06 * rng(), 1, 1 - 0.1 * rng()] });
      }
    }
    leaf(T, ex, ey, tw.a + (rng() - 0.5) * 0.3, Lb * 0.9, Wb * 0.9, prof, 0.95, {});
  }
}
function tileLarge(T, rng, o = {}) {
  const cx = 128, cy = 236, n = o.n ?? 7;
  const L0 = o.L ?? 100, W0 = o.W ?? 40, prof = o.prof || PROF.elliptic;
  const order = [];
  for (let i = 0; i < n; i++) order.push(-Math.PI / 2 + (i / (n - 1) - 0.5) * 1.9 + (rng() - 0.5) * 0.25);
  order.sort((a, b) => Math.abs(b + Math.PI / 2) - Math.abs(a + Math.PI / 2));
  let k = 0;
  for (const a of order) {
    const L = L0 * (0.8 + 0.3 * rng()), W = W0 * (0.85 + 0.25 * rng());
    const stem = 14 + 10 * rng(), bx = cx + (rng() - 0.5) * 30, by = cy - 4 * rng();
    const sx = bx + Math.cos(a) * stem, sy = by + Math.sin(a) * stem;
    line(T, bx, by, sx, sy, 2.4, 0.4, TWIG);
    leaf(T, sx, sy, a + (rng() - 0.5) * 0.2, L, W, prof, 0.6 + 0.4 * ((k++ % 5) / 5) + 0.15 * rng(), { bend: (rng() - 0.5) * 0.15, tone: [1 + 0.05 * rng(), 1, 1 - 0.08 * rng()] });
  }
}
function tileFine(T, rng, o = {}) {
  const cx = 128, cy = 240, nT = o.twigs ?? 8;
  for (let t = 0; t < nT; t++) {
    const a = -Math.PI / 2 + (t / (nT - 1) - 0.5) * 1.7 + (rng() - 0.5) * 0.25, len = 100 + 45 * rng();
    const ex = cx + Math.cos(a) * len, ey = cy + Math.sin(a) * len;
    line(T, cx, cy, ex, ey, 1.6, 0.35, TWIG);
    for (let s = 16; s < len; s += o.step ?? 10) {
      const px = cx + Math.cos(a) * s, py = cy + Math.sin(a) * s;
      for (const side of [-1, 1]) {
        if (rng() < 0.1) continue;
        leaf(T, px, py, a + side * (0.8 + 0.4 * rng()), (o.L ?? 22) * (0.8 + 0.4 * rng()), (o.W ?? 8.5) * (0.85 + 0.3 * rng()), PROF.elliptic, 0.55 + 0.5 * rng(), { veins: 0 });
      }
    }
    leaf(T, ex, ey, a, (o.L ?? 22), (o.W ?? 8.5), PROF.elliptic, 0.95, { veins: 0 });
  }
}
function tileWillow(T, rng) {
  // hanging strands: slender wavy threads with narrow leaves; plenty of gaps (the real curtain is see-through)
  const nS = 7;
  for (let s = 0; s < nS; s++) {
    const x0 = 28 + (s + 0.5) * (200 / nS) + (rng() - 0.5) * 12, len = N * (0.55 + 0.42 * rng()), ph = rng() * 6.28, amp = 2 + 4 * rng();
    const path = [];
    for (let y = 0; y <= len; y += 6) path.push([x0 + amp * Math.sin(y / 31 + ph) * Math.min(1, y / 30) + 2 * Math.sin(y / 11 + ph * 2), 2 + y]);
    curve(T, path, 1.5, 0.9, 0.38, 0.5, [0.55, 0.5, 0.32]);
    for (let i = 3; i < path.length; i++) {
      const [px, py] = path[i];
      for (const side of [-1, 1]) {
        if (rng() < 0.2) continue;
        const a = Math.PI / 2 + side * (0.3 + 0.5 * rng()), L = 16 + 12 * rng() + 6 * (i / path.length);
        leaf(T, px, py, a, L, 2.7 + 1.0 * rng(), PROF.lance, 0.6 + 0.45 * (i / path.length) + 0.2 * rng(), { veins: 0, tone: [1.03, 1, 0.9] });
      }
    }
    leaf(T, path[path.length - 1][0], path[path.length - 1][1], Math.PI / 2, 20, 3.0, PROF.lance, 1.0, { veins: 0 });
  }
}
function* tilePine(T, rng) {
  // side view of a needle cloud: ~80 fascicles inside a flattened ellipse; new growth (pale) on the outside
  const cx = 128, cy = 132;
  const items = [];
  for (let i = 0; i < 84; i++) {
    const a = rng() * 6.283, r = Math.sqrt(rng());
    items.push([cx + Math.cos(a) * r * 94, cy + Math.sin(a) * r * 44 + 10, r, rng()]);
  }
  items.sort((p, q) => p[1] - q[1]);
  let it = 0;
  for (const [x, y, r, u] of items) {
    if (it % 6 === 0) yield it / items.length;                         // loading progress (bakeSteps): a pause point every few fascicles — same arithmetic, same order
    it++;
    const nN = 22 + Math.floor(rng() * 12), fresh = u < 0.22 + 0.3 * r;
    const bright = (0.5 + 0.5 * clamp((y - 70) / 110) * (0.75 + 0.25 * rng()) + 0.08 * (1 - r)) * (fresh ? 1.25 : 1);
    for (let k = 0; k < nN; k++) {
      const a = -Math.PI * (rng()) + (rng() - 0.5) * 0.3, L = 19 + 14 * rng();
      leaf(T, x, y + 2, a, L, 0.9 + 0.4 * rng(), PROF.narrow, bright * (0.75 + 0.5 * rng()), { veins: 0, rib: 0, tone: fresh ? [1.12, 1.1, 0.78] : [0.95, 1.0, 0.95] });
    }
  }
}
function* tileBamboo(T, rng) {
  const nT = 5;
  for (let t = 0; t < nT; t++) {
    yield t / nT;
    const x0 = 36 + (t + 0.5) * (184 / nT) + (rng() - 0.5) * 12, y0 = 6 + rng() * 14;
    const a0 = Math.PI / 2 + (rng() - 0.5) * 0.9, len = 120 + 60 * rng();
    const path = [];
    for (let s = 0; s <= len; s += 8) { const a = a0 + 0.35 * Math.sin(s / 60 + t); path.push([x0 + Math.cos(a) * s * 0.55 + Math.sin(a0 * 3 + t) * s * 0.1, y0 + Math.sin(a) * s]); }
    curve(T, path, 1.6, 0.9, 0.4, 0.5, [0.7, 0.62, 0.4]);
    for (let i = 4; i < path.length; i += 2) {
      const [px, py] = path[i];
      const nL = 3 + (rng() < 0.5 ? 1 : 0);
      for (let q = 0; q < nL; q++) {
        const side = q % 2 ? 1 : -1, a = Math.PI / 2 + side * (0.25 + 0.5 * rng()) + (rng() - 0.5) * 0.3;
        leaf(T, px, py, a, 54 + 22 * rng(), 4.4 + 1.2 * rng(), PROF.lance, 0.55 + 0.5 * rng() + 0.2 * (i / path.length), { veins: 0, tone: [1.02, 1, 0.92] });
      }
    }
  }
}
function tileBanana(T, rng) {
  // vertical blade: base at the bottom, tip at the top; midrib x = 128; parallel veins; torn slits from the edge
  const W2 = 112;
  for (let y = 0; y < N; y++) {
    const u = 1 - y / (N - 1);                           // 0 base .. 1 tip
    const hw = W2 * Math.pow(Math.sin(Math.PI * Math.pow(clamp(u * 1.02), 0.62)), 0.7) * (0.96 + 0.04 * Math.sin(u * 30));
    for (let x = 0; x < N; x++) {
      const d = Math.abs(x + 0.5 - 128);
      const cov = clamp(hw - d + 0.5);
      if (cov <= 0) continue;
      const vein = Math.abs(Math.sin((y * 0.5 + d * 0.22) * Math.PI / 3.2));
      let lum = (0.75 + 0.3 * u) * (1 - 0.18 * Math.pow(d / hw, 3)) * (1 - 0.1 * Math.pow(vein, 5));
      if (d < 3.4) lum *= 1.22;
      T.put(x, y, cov, lum, lum * 1.0, lum * 0.92);
    }
  }
  // torn slits (follow the veins: slightly rising towards the edge)
  const nS = 9;
  for (let s = 0; s < nS; s++) {
    const side = s % 2 ? 1 : -1, y0 = 40 + rng() * 190, depth = 35 + 70 * rng(), w = 2.4 + 3.4 * rng();
    for (let k = 0; k < depth; k++) {
      const x = 128 + side * (W2 + 4 - k - 6), y = y0 - k * 0.38 * 0.9;
      for (let ox = -w; ox <= w; ox++) T.cut(Math.round(x), Math.round(y + ox * 0.2), clamp(1 - Math.abs(ox) / w + 0.35));
    }
  }
}
function tileLotus(T, rng) {
  const cx = 128, cy = 128, R = 120, notch = 0.2;
  const ph = rng() * 6.28;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, r = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
    const wav = 1 + 0.022 * Math.sin(9 * th + ph) + 0.014 * Math.sin(17 * th + 2 * ph);
    let cov = clamp((R * wav - r) + 0.5);
    const dn = Math.abs(Math.atan2(Math.sin(th - Math.PI / 2), Math.cos(th - Math.PI / 2)));   // angular distance to the notch direction (+y)
    cov *= smooth(notch * 0.55, notch * 0.8, dn) + (r < 4 ? 1 : 0);
    if (cov <= 0) continue;
    const nV = 21, vc = Math.pow(Math.abs(Math.cos(th * nV * 0.5 + ph)), 40);
    let lum = 0.86 - 0.12 * smooth(0.55, 1.0, r / R) + 0.1 * Math.exp(-r * r / 260);
    lum *= 1 + 0.16 * vc * smooth(6, 36, r) * (1 - 0.5 * smooth(0.6, 1.0, r / R));
    lum *= 0.96 + 0.06 * Math.sin(r * 0.21 + th * 2);
    const rim = smooth(0.9, 1.0, r / (R * wav));
    T.put(x, y, cov, lum * (1 + 0.1 * rim), lum * (1 + 0.1 * rim), lum * (1 - 0.1 * rim));
  }
}
function tileTuft(T, rng) {
  // 沿阶草 / 书带草: arching strap leaves from the base centre
  const cx = 128, cy = 246, nB = 46;
  const blades = [];
  for (let i = 0; i < nB; i++) blades.push({ lean: (rng() - 0.5) * 2 * (0.15 + 0.85 * rng()), len: 110 + 90 * rng() * (1 - 0.35 * Math.abs(i / nB - 0.5)), k: 0.45 + 0.5 * rng() });
  blades.sort((a, b) => Math.abs(b.lean) - Math.abs(a.lean));
  for (const b of blades) {
    const pts = [];
    for (let s = 0; s <= b.len; s += 4) {
      const t = s / b.len, ang = -Math.PI / 2 + b.lean * (0.25 + 1.1 * t * t);
      pts.push([0, 0, ang, s]);
    }
    let x = cx + (rng() - 0.5) * 22, y = cy;
    const path = [[x, y]];
    for (let i = 1; i < pts.length; i++) { const ang = pts[i][2]; x += Math.cos(ang) * 4; y += Math.sin(ang) * 4; path.push([x, y]); }
    for (let i = 0; i < path.length - 1; i++) {
      const t = i / (path.length - 1), w = (3.6 * (1 - Math.pow(t, 1.5)) + 0.5);
      line(T, path[i][0], path[i][1], path[i + 1][0], path[i + 1][1], w, b.k * (0.55 + 0.6 * t));
    }
  }
}
function tileReed(T, rng) {
  const cx = 128, cy = 254, nB = 15;
  const bl = [];
  for (let i = 0; i < nB; i++) bl.push({ lean: (rng() - 0.5) * 0.9 + (i / nB - 0.5) * 0.4, len: 190 + 60 * rng(), k: 0.5 + 0.5 * rng(), droop: 0.4 + 0.9 * rng() });
  bl.sort((a, b) => Math.abs(b.lean) - Math.abs(a.lean));
  for (const b of bl) {
    let x = cx + (rng() - 0.5) * 30, y = cy;
    const path = [[x, y]];
    for (let s = 4; s <= b.len; s += 4) {
      const t = s / b.len, ang = -Math.PI / 2 + b.lean * (0.35 + 0.65 * t) + b.droop * t * t * t * Math.sign(b.lean || 1) * 0.9;
      x += Math.cos(ang) * 4; y += Math.sin(ang) * 4; path.push([x, y]);
    }
    for (let i = 0; i < path.length - 1; i++) {
      const t = i / (path.length - 1), w = 5.2 * (1 - 0.88 * Math.pow(t, 1.7)) + 0.4;
      line(T, path[i][0], path[i][1], path[i + 1][0], path[i + 1][1], w, b.k * (0.6 + 0.5 * t));
    }
  }
}
function lobed(T, x0, y0, ang, R, lobes, k, rng, o = {}) {
  // palmate leaf: radius profile r(theta) with n lobes over a fan of `spread` radians, base at (x0, y0)
  const ca = Math.cos(ang), sa = Math.sin(ang), spread = o.spread ?? 2.9, depth = o.depth ?? 0.55, ph = o.ph ?? 0;
  const rr = Math.ceil(R * 1.2) + 2;
  for (let py = Math.floor(y0 - rr); py <= Math.ceil(y0 + rr); py++) for (let px = Math.floor(x0 - rr); px <= Math.ceil(x0 + rr); px++) {
    const dx = px + 0.5 - x0, dy = py + 0.5 - y0;
    const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;            // leaf frame: +x = leaf axis
    const r = Math.hypot(lx, ly) / R, th = Math.atan2(ly, lx);
    if (Math.abs(th) > spread / 2 + 0.2 && r > 0.1) continue;
    const q = (th / (spread / 2) + 1) * 0.5;                          // 0..1 across the fan
    const lob = 0.5 + 0.5 * Math.cos((q * lobes + ph) * Math.PI * 2 - Math.PI);       // 1 at lobe centres
    const lim = (1 - depth) + depth * Math.pow(lob, 0.7);
    const dist = (lim - r) * R * 0.85;
    const cov = clamp(dist + 0.5) * smooth(spread / 2 + 0.15, spread / 2 - 0.1, Math.abs(th));
    if (cov <= 0) continue;
    const vein = Math.abs(Math.sin(th * lobes * 2.0 * Math.PI / spread * 0.5));
    let lum = k * (0.8 + 0.25 * r) * (1 - 0.12 * Math.pow(vein, 8) * smooth(0.1, 0.5, r));
    T.put(px, py, cov, lum, lum, lum * 0.95);
  }
}
function tileMaple(T, rng) {
  const cx = 128, cy = 236, nT = 5;
  for (let t = 0; t < nT; t++) {
    const a = -Math.PI / 2 + (t / (nT - 1) - 0.5) * 2.2 + (rng() - 0.5) * 0.2, len = 100 + 50 * rng();
    const ex = cx + Math.cos(a) * len, ey = cy + Math.sin(a) * len;
    line(T, cx, cy, ex, ey, 2.0, 0.35, TWIG);
    for (let s = 40; s <= len; s += 34) {
      const px = cx + Math.cos(a) * s, py = cy + Math.sin(a) * s;
      for (const side of [-1, 1]) lobed(T, px, py, a + side * (1.0 + 0.3 * rng()), 30 + 8 * rng(), 5, 0.55 + 0.45 * rng(), rng, { depth: 0.62 });
    }
    lobed(T, ex, ey, a, 34, 5, 0.95, rng, { depth: 0.62 });
  }
}
function tileWutong(T, rng) {
  for (let i = 0; i < 4; i++) {
    const a = -Math.PI / 2 + (i - 1.5) * 0.9 + (rng() - 0.5) * 0.3;
    const x = 128 + (i - 1.5) * 8, y = 236;
    line(T, x, y, x + Math.cos(a) * 36, y + Math.sin(a) * 36, 2.4, 0.4, TWIG);
    lobed(T, x + Math.cos(a) * 36, y + Math.sin(a) * 36, a, 96 + 14 * rng(), 5, 0.55 + 0.4 * rng(), rng, { spread: 3.6, depth: 0.5 });
  }
}
function* tileClump(T, rng) {
  // dense, ragged leafy mass for LOD1 cards: many small leaves inside a lumpy silhouette with a few bites
  const items = [];
  const bites = Array.from({ length: 7 }, () => { const a = rng() * 6.283, r = 70 + 40 * rng(); return [128 + Math.cos(a) * r, 128 + Math.sin(a) * r, 10 + 14 * rng()]; });
  for (let i = 0; i < 520; i++) {
    const a = rng() * 6.283, r = Math.sqrt(rng()) * (1 - 0.0);
    const x = 128 + Math.cos(a) * r * 112, y = 128 + Math.sin(a) * r * 104;
    let bit = false; for (const b of bites) if (Math.hypot(x - b[0], y - b[1]) < b[2]) bit = true;
    if (bit) continue;
    items.push([x, y, rng() * 6.283, 0.35 + 0.65 * clamp(0.5 - (y - 128) / 210 + (rng() - 0.5) * 0.35)]);
  }
  items.sort((p, q) => p[1] - q[1]);
  let it = 0;
  for (const [x, y, a, k] of items) { if (it % 60 === 0) yield it / items.length; it++; leaf(T, x, y, a, 20 + 9 * rng(), 8 + 3 * rng(), PROF.ovate, k, { veins: 0, rib: 0 }); }
}
function tileCypress(T, rng) {
  // flat sprays of scale leaves: feathery branchlets from a central stem
  const cx = 128, cy = 240;
  const stems = 6;
  for (let t = 0; t < stems; t++) {
    const a = -Math.PI / 2 + (t / (stems - 1) - 0.5) * 2.0 + (rng() - 0.5) * 0.2, len = 120 + 60 * rng();
    const ex = cx + Math.cos(a) * len, ey = cy + Math.sin(a) * len;
    line(T, cx, cy, ex, ey, 2.0, 0.4, TWIG);
    for (let s = 14; s < len; s += 7) {
      const px = cx + Math.cos(a) * s, py = cy + Math.sin(a) * s;
      for (const side of [-1, 1]) {
        const L = (26 + 14 * rng()) * (1 - 0.5 * s / len + 0.2);
        leaf(T, px, py, a + side * (0.75 + 0.3 * rng()), L, 3.2 + rng(), PROF.lance, 0.5 + 0.5 * rng(), { veins: 0, rib: 0, tone: [0.95, 1, 1] });
      }
    }
  }
}
function tileLily(T, rng) {
  // left 2/3: lily pad (disc with a slit); right strip is unused
  const cx = 128, cy = 128, R = 118, ph = rng() * 6.28;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, r = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
    const wav = 1 + 0.012 * Math.sin(7 * th + ph);
    let cov = clamp(R * wav - r + 0.5);
    const dn = Math.abs(Math.atan2(Math.sin(th - Math.PI / 2), Math.cos(th - Math.PI / 2)));
    cov *= smooth(0.04, 0.09, dn) + (r < 3 ? 1 : 0);
    if (cov <= 0) continue;
    let lum = 0.86 - 0.12 * smooth(0.5, 1.0, r / R) + 0.05 * Math.sin(th * 15 + r * 0.05) * smooth(10, 40, r);
    T.put(x, y, cov, lum, lum, lum * 0.95);
  }
}
function tilePetal(T, rng) {
  // a petal: pointed ellipse with a faint vein structure; colour (white -> pink) comes from vertex colours
  const x0 = 128, y0 = 246, L = 232, Wd = 78;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const along = (y0 - y - 0.5) / L; if (along < 0 || along > 1) continue;
    const hw = Wd * Math.pow(Math.sin(Math.PI * Math.pow(along, 0.8)), 0.8) * (1 - 0.15 * along);
    const d = Math.abs(x + 0.5 - x0), cov = clamp(hw - d + 0.5);
    if (cov <= 0) continue;
    const vein = Math.abs(Math.sin((d / Math.max(hw, 1)) * 11));
    const lum = 0.95 - 0.12 * Math.pow(vein, 6) + 0.08 * along;
    T.put(x, y, cov, lum, lum, lum);
  }
}

// ------------------------------------------------------------------------------------------------ near-LOD tiles
// Fewer, bigger leaves with crisp outlines: on a 0.3-0.5 m card every leaf reads as a leaf (the sprays above read as fern fronds up close).
function tileBroadN(T, rng) {
  const cx = 128, cy = 242;
  const tw = [];
  for (let t = 0; t < 3; t++) tw.push({ a: -Math.PI / 2 + (t - 1) * 0.66 + (rng() - 0.5) * 0.2, len: 108 + 26 * rng() });
  tw.sort((p, q) => Math.abs(q.a + Math.PI / 2) - Math.abs(p.a + Math.PI / 2));
  let k = 0;
  for (const t of tw) {
    const ex = cx + Math.cos(t.a) * t.len, ey = cy + Math.sin(t.a) * t.len;
    line(T, cx, cy, ex, ey, 2.6, 0.34, TWIG);
    for (let s = 38; s < t.len - 16; s += 38) {
      const px = cx + Math.cos(t.a) * s, py = cy + Math.sin(t.a) * s;
      for (const side of [-1, 1]) {
        if (rng() < 0.08) continue;
        leaf(T, px, py, t.a + side * (0.95 + 0.3 * rng()), 72 + 14 * rng(), 30 + 6 * rng(), PROF.ovate, 0.58 + 0.42 * ((k++ % 5) / 5) + 0.12 * rng(), { tone: [1 + 0.06 * rng(), 1, 1 - 0.1 * rng()] });
      }
    }
    leaf(T, ex, ey, t.a + (rng() - 0.5) * 0.3, 80, 33, PROF.ovate, 0.95, {});
  }
}
function tileLargeN(T, rng) {
  const cx = 128, cy = 240, ang = [-Math.PI / 2 - 0.62, -Math.PI / 2 + 0.55, -Math.PI / 2 + 0.04];
  let k = 0;
  for (const a of ang) {
    const L = 126 + 16 * rng(), W = 52 + 6 * rng(), stem = 16 + 8 * rng(), bx = cx + (rng() - 0.5) * 18, by = cy;
    const sx = bx + Math.cos(a) * stem, sy = by + Math.sin(a) * stem;
    line(T, bx, by, sx, sy, 2.8, 0.4, TWIG);
    leaf(T, sx, sy, a + (rng() - 0.5) * 0.12, L, W, PROF.elliptic, 0.62 + 0.38 * ((k++ % 3) / 3) + 0.12 * rng(), { bend: (rng() - 0.5) * 0.12, tone: [1 + 0.05 * rng(), 1, 1 - 0.08 * rng()] });
  }
}
function tileFineN(T, rng) {
  const cx = 128, cy = 242;
  for (let t = 0; t < 4; t++) {
    const a = -Math.PI / 2 + (t - 1.5) * 0.46 + (rng() - 0.5) * 0.16, len = 118 + 30 * rng();
    const ex = cx + Math.cos(a) * len, ey = cy + Math.sin(a) * len;
    line(T, cx, cy, ex, ey, 1.9, 0.34, TWIG);
    for (let s = 24; s < len; s += 23) {
      const px = cx + Math.cos(a) * s, py = cy + Math.sin(a) * s;
      for (const side of [-1, 1]) { if (rng() < 0.1) continue; leaf(T, px, py, a + side * (0.8 + 0.4 * rng()), 38 + 8 * rng(), 14 + 3 * rng(), PROF.elliptic, 0.55 + 0.5 * rng(), { veins: 0 }); }
    }
    leaf(T, ex, ey, a, 40, 14, PROF.elliptic, 0.95, { veins: 0 });
  }
}
function tileMapleN(T, rng) {
  const cx = 128, cy = 240, ang = [-Math.PI / 2 - 0.55, -Math.PI / 2 + 0.5, -Math.PI / 2 - 0.02];
  for (const a of ang) {
    const len = 46 + 24 * rng(), ex = cx + Math.cos(a) * len, ey = cy + Math.sin(a) * len;
    line(T, cx, cy, ex, ey, 2.2, 0.36, TWIG);
    lobed(T, ex, ey, a, 62 + 10 * rng(), 5, 0.6 + 0.4 * rng(), rng, { depth: 0.62 });
  }
}
function tileWutongN(T, rng) {
  const a1 = -Math.PI / 2 - 0.5, a2 = -Math.PI / 2 + 0.45;
  for (const a of [a1, a2]) {
    const x = 128, y = 242, len = 40 + 12 * rng();
    line(T, x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, 2.6, 0.4, TWIG);
    lobed(T, x + Math.cos(a) * len, y + Math.sin(a) * len, a, 104 + 10 * rng(), 5, 0.6 + 0.35 * rng(), rng, { spread: 3.6, depth: 0.5 });
  }
}
function* tileBambooN(T, rng) {
  for (let t = 0; t < 3; t++) {
    yield t / 3;
    const x0 = 56 + t * 72 + (rng() - 0.5) * 12, y0 = 6 + rng() * 10, a0 = Math.PI / 2 + (rng() - 0.5) * 0.5, len = 128 + 40 * rng();
    const path = [];
    for (let s = 0; s <= len; s += 8) { const a = a0 + 0.3 * Math.sin(s / 60 + t); path.push([x0 + Math.cos(a) * s * 0.5, y0 + Math.sin(a) * s]); }
    curve(T, path, 1.8, 1.0, 0.4, 0.5, [0.7, 0.62, 0.4]);
    for (let i = 3; i < path.length; i += 2) {
      const [px, py] = path[i];
      for (let q = 0; q < 2; q++) { const side = q ? 1 : -1, a = Math.PI / 2 + side * (0.25 + 0.5 * rng()); leaf(T, px, py, a, 92 + 22 * rng(), 8.6 + 1.6 * rng(), PROF.lance, 0.55 + 0.5 * rng() + 0.2 * (i / path.length), { veins: 0, tone: [1.02, 1, 0.92] }); }
    }
  }
}
function tileWillowN(T, rng) {
  const nS = 4;
  for (let s = 0; s < nS; s++) {
    const x0 = 40 + (s + 0.5) * (176 / nS) + (rng() - 0.5) * 14, len = N * (0.6 + 0.38 * rng()), ph = rng() * 6.28, amp = 2 + 4 * rng();
    const path = [];
    for (let y = 0; y <= len; y += 6) path.push([x0 + amp * Math.sin(y / 31 + ph) * Math.min(1, y / 30) + 2 * Math.sin(y / 11 + ph * 2), 2 + y]);
    curve(T, path, 2.0, 1.2, 0.38, 0.5, [0.55, 0.5, 0.32]);
    for (let i = 3; i < path.length; i += 2) {
      const [px, py] = path[i];
      for (const side of [-1, 1]) { if (rng() < 0.18) continue; const a = Math.PI / 2 + side * (0.3 + 0.5 * rng()); leaf(T, px, py, a, 34 + 12 * rng() + 8 * (i / path.length), 4.4 + 1.2 * rng(), PROF.lance, 0.6 + 0.45 * (i / path.length) + 0.2 * rng(), { veins: 0, tone: [1.03, 1, 0.9] }); }
    }
    leaf(T, path[path.length - 1][0], path[path.length - 1][1], Math.PI / 2, 38, 4.8, PROF.lance, 1.0, { veins: 0 });
  }
}
function* tilePineN(T, rng) {
  // a few clearly separate needle fascicles: fans of long needles (new growth pale)
  const cx = 128, cy = 128;
  const items = [];
  for (let i = 0; i < 20; i++) { const a = rng() * 6.283, r = Math.sqrt(rng()); items.push([cx + Math.cos(a) * r * 86, cy + Math.sin(a) * r * 54 + 18, r, rng()]); }
  items.sort((p, q) => p[1] - q[1]);
  let it = 0;
  for (const [x, y, r, u] of items) {
    if (it % 3 === 0) yield it / items.length;
    it++;
    const nN = 26 + Math.floor(rng() * 10), fresh = u < 0.25 + 0.3 * r;
    const bright = (0.5 + 0.5 * clamp((y - 70) / 110) * (0.75 + 0.25 * rng())) * (fresh ? 1.25 : 1);
    for (let k = 0; k < nN; k++) {
      const a = -Math.PI * (0.04 + 0.92 * rng()) + (rng() - 0.5) * 0.25, L = 40 + 24 * rng();
      leaf(T, x, y, a, L, 1.5 + 0.5 * rng(), PROF.narrow, bright * (0.78 + 0.45 * rng()), { veins: 0, rib: 0, tone: fresh ? [1.12, 1.1, 0.78] : [0.95, 1.0, 0.95] });
    }
  }
}

function* tileDense(T, rng, o) {
  const cx = 128, cy = 128, ph = rng() * 6.28;
  // ragged dark underlay so the card is nearly opaque inside
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, r = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
    const edge = o.core * (1 + 0.16 * Math.sin(5 * th + ph) + 0.09 * Math.sin(11 * th + 2 * ph));
    const cov = clamp(edge - r + 0.5);
    if (cov > 0) T.put(x, y, cov, 0.44 + 0.08 * Math.sin(r * 0.2 + ph), 0.5 + 0.08 * Math.sin(r * 0.2 + ph), 0.40);
  }
  const items = [];
  for (let i = 0; i < o.n; i++) { const a = rng() * 6.283, r = Math.sqrt(rng()) * o.R; items.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, r, a]); }
  items.sort((p, q) => p[2] - q[2]);                                    // inner leaves first (dark), outer leaves on top (light)
  let it = 0;
  for (const [x, y, r, a] of items) {
    if (it % 8 === 0) yield it / items.length;
    it++;
    const ang = a + (rng() - 0.5) * 1.5, L = o.L * (0.8 + 0.4 * rng()), W = o.W * (0.85 + 0.3 * rng());
    leaf(T, x, y, ang, L, W, o.prof || PROF.ovate, 0.5 + 0.5 * clamp(r / o.R) * (0.7 + 0.3 * rng()) + 0.1 * rng(), { veins: o.veins ?? 1, tone: [1 + 0.07 * rng(), 1, 1 - 0.1 * rng()] });
  }
}

// ------------------------------------------------------------------------------------------------ ginkgo + palmate tiles
/** ginkgo leaf: fan blade (cleft at the centre, scalloped rim, radial veins) on a petiole. (x, y) = where the petiole meets the twig, ang = leaf axis, R = blade radius */
function ginkgoLeaf(T, x, y, ang, R, k, o = {}) {
  const pet = (o.pet ?? 0.5) * R, bx = x + Math.cos(ang) * pet, by = y + Math.sin(ang) * pet;
  if (pet > 1) line(T, x, y, bx, by, Math.max(1.0, R * 0.04), 0.5 * k, [0.9, 0.95, 0.6]);
  const ca = Math.cos(ang), sa = Math.sin(ang), spread = o.spread ?? 2.45, rr = Math.ceil(R * 1.1) + 2, ph = o.ph ?? 0;
  for (let py = Math.floor(by - rr); py <= Math.ceil(by + rr); py++) for (let px = Math.floor(bx - rr); px <= Math.ceil(bx + rr); px++) {
    if (px < 0 || py < 0 || px >= N || py >= N) continue;
    const dx = px + 0.5 - bx, dy = py + 0.5 - by;
    const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
    const r = Math.hypot(lx, ly) / R, th = Math.atan2(ly, lx);
    if (Math.abs(th) > spread / 2 + 0.1 || r < 0.02) continue;
    const a = Math.abs(th);
    const notch = 1 - 0.42 * Math.pow(Math.max(0, 1 - a / 0.22), 1.6);                  // the central cleft
    const scal = 1 - 0.045 * (0.5 + 0.5 * Math.cos(th * 9 + ph));                        // scalloped rim
    const lim = notch * scal;
    const cov = clamp((lim - r) * R + 0.5) * smooth(spread / 2 + 0.05, spread / 2 - 0.12, a);
    if (cov <= 0) continue;
    const vein = Math.pow(Math.abs(Math.sin(th * 20 + ph)), 14);
    let lum = k * (0.78 + 0.28 * r) * (1 - 0.16 * vein * smooth(0.1, 0.4, r));
    T.put(px, py, cov, lum * 1.02, lum, lum * 0.9);
  }
}
function tileGinkgo(T, rng) {
  const cx = 128, cy = 240;
  const tw = [];
  for (let t = 0; t < 5; t++) tw.push({ a: -Math.PI / 2 + (t - 2) * 0.46 + (rng() - 0.5) * 0.14, len: 118 + 30 * rng() - Math.abs(t - 2) * 8 });
  tw.sort((p, q) => Math.abs(q.a + Math.PI / 2) - Math.abs(p.a + Math.PI / 2));
  let k = 0;
  for (const t of tw) {
    const ex = cx + Math.cos(t.a) * t.len, ey = cy + Math.sin(t.a) * t.len;
    line(T, cx, cy, ex, ey, 2.4, 0.34, TWIG);
    for (let s = 42; s < t.len; s += 34) {                                           // short spurs: a rosette of fans at each node
      const px = cx + Math.cos(t.a) * s, py = cy + Math.sin(t.a) * s, n = 3 + (rng() < 0.4 ? 1 : 0);
      for (let q = 0; q < n; q++) {
        const a = t.a + (q - (n - 1) / 2) * 0.85 + (rng() - 0.5) * 0.3 + (q % 2 ? 0.2 : -0.2);
        ginkgoLeaf(T, px, py, a, 27 + 6 * rng(), 0.6 + 0.4 * ((k++ % 5) / 5) + 0.12 * rng(), { ph: rng() * 6.28, pet: 0.55 });
      }
    }
    ginkgoLeaf(T, ex, ey, t.a, 30, 0.95, { ph: rng() * 6.28, pet: 0.5 });
  }
}
function tileGinkgoN(T, rng) {
  const cx = 128, cy = 244, ang = [-Math.PI / 2 - 0.62, -Math.PI / 2 + 0.55, -Math.PI / 2 - 0.02];
  let k = 0;
  for (const a of ang) ginkgoLeaf(T, cx + (rng() - 0.5) * 16, cy, a + (rng() - 0.5) * 0.12, 74 + 12 * rng(), 0.62 + 0.38 * ((k++ % 3) / 3) + 0.1 * rng(), { ph: rng() * 6.28, pet: 0.62, spread: 2.5 });
}
function tileDenseG(T, rng) {
  const cx = 128, cy = 128, ph = rng() * 6.28;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {                          // ragged underlay
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, r = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
    const edge = 66 * (1 + 0.16 * Math.sin(5 * th + ph) + 0.09 * Math.sin(11 * th + 2 * ph));
    const cov = clamp(edge - r + 0.5);
    if (cov > 0) T.put(x, y, cov, 0.46 + 0.08 * Math.sin(r * 0.2 + ph), 0.52 + 0.08 * Math.sin(r * 0.2 + ph), 0.36);
  }
  const items = [];
  for (let i = 0; i < 22; i++) { const a = rng() * 6.283, r = Math.sqrt(rng()) * 60; items.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, r, a]); }
  items.sort((p, q) => p[2] - q[2]);
  for (const [x, y, r, a] of items) ginkgoLeaf(T, x - Math.cos(a) * 8, y - Math.sin(a) * 8, a + (rng() - 0.5) * 1.2, 30 + 8 * rng(), 0.5 + 0.5 * clamp(r / 60) * (0.7 + 0.3 * rng()) + 0.1 * rng(), { ph: rng() * 6.28, pet: 0.3 });
}
function tileDensePal(T, rng) {
  const cx = 128, cy = 128, ph = rng() * 6.28;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, r = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
    const edge = 64 * (1 + 0.16 * Math.sin(5 * th + ph) + 0.09 * Math.sin(11 * th + 2 * ph));
    const cov = clamp(edge - r + 0.5);
    if (cov > 0) T.put(x, y, cov, 0.44 + 0.08 * Math.sin(r * 0.2 + ph), 0.5 + 0.08 * Math.sin(r * 0.2 + ph), 0.38);
  }
  const items = [];
  for (let i = 0; i < 16; i++) { const a = rng() * 6.283, r = Math.sqrt(rng()) * 58; items.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, r, a]); }
  items.sort((p, q) => p[2] - q[2]);
  for (const [x, y, r, a] of items) lobed(T, x, y, a + (rng() - 0.5) * 1.5, 36 + 8 * rng(), 5, 0.5 + 0.5 * clamp(r / 58) * (0.7 + 0.3 * rng()) + 0.1 * rng(), rng, { spread: 3.5, depth: 0.5, ph: rng() * 0.5 });
}

// ------------------------------------------------------------------------------------------------ bake
const ATTACH = { willow: 't', willowN: 't', tuft: 'b', reed: 'b', banana: 'b' };   // tile edges where the plant is attached (no feathering)
/**
 * The bake as a generator: it yields [done, total, unit, label] after every tile (and a few times inside the heavy ones) and after every mip level, and returns
 * { size (width), height, data (Uint8 RGBA, level 0), mips: [{data,width,height}…] (levels 1…), tiles }. `bakeAtlas()` runs it to the end (same bytes as always),
 * `bakeAtlasAsync()` lets the caller await between the steps (the loading screen: env.progress). The arithmetic and its order never depend on how it is driven.
 */
export function* bakeSteps(seed = 'zzy-plants-atlas-v2') {
  const rng = makeRng(seed);
  const makers = {
    broad: (T, r) => tileBroad(T, r),
    large: (T, r) => tileLarge(T, r),
    fine: (T, r) => tileFine(T, r),
    willow: tileWillow, pine: tilePine, bamboo: tileBamboo, banana: tileBanana, lotus: tileLotus, tuft: tileTuft, reed: tileReed,
    maple: tileMaple, wutong: tileWutong, clump: tileClump, cypress: tileCypress, lily: tileLily, petal: tilePetal,
    denseN: (T, r) => tileDense(T, r, { core: 66, n: 34, R: 66, L: 56, W: 24 }),
    denseL: (T, r) => tileDense(T, r, { core: 52, n: 12, R: 38, L: 84, W: 34, prof: PROF.elliptic }),
    denseF: (T, r) => tileDense(T, r, { core: 64, n: 84, R: 74, L: 32, W: 11, prof: PROF.elliptic, veins: 0 }),
    ginkgo: tileGinkgo, ginkgoN: tileGinkgoN, denseG: tileDenseG, densePal: tileDensePal,
    broadN: tileBroadN, largeN: tileLargeN, fineN: tileFineN, mapleN: tileMapleN, wutongN: tileWutongN, bambooN: tileBambooN, willowN: tileWillowN, pineN: tilePineN,
  };
  const L0 = new Uint8Array(SIZE * SIZE_H * 4);
  const names = Object.keys(TILE), total = names.length + 1;           // 31 tiles + the mip chain
  let tilesDone = 0;
  for (const name of names) {
    const T = new Tile();
    const maker = makers[name](T, rng.fork(name));
    if (maker && typeof maker.next === 'function') for (const f of maker) yield [tilesDone + f, total, '张', '树叶贴图'];
    // feather the borders (cards must not show straight cut edges); the attachment edge of a tile stays solid
    const keep = ATTACH[name] || '';
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fl = keep.includes('l') ? 1 : smooth(0, 5, x), fr = keep.includes('r') ? 1 : smooth(0, 5, N - 1 - x);
      const ft = keep.includes('t') ? 1 : smooth(0, 5, y), fb = keep.includes('b') ? 1 : smooth(0, 5, N - 1 - y);
      T.a[y * N + x] *= fl * fr * ft * fb;
    }
    // mean colour of covered texels (fills empty texels so mips do not darken the edges)
    let sr = 0, sg = 0, sb = 0, sw = 0;
    for (let i = 0; i < N * N; i++) { const a = T.a[i]; sr += T.r[i] * a; sg += T.g[i] * a; sb += T.b[i] * a; sw += a; }
    const mr = sw ? sr / sw : 0.7, mg = sw ? sg / sw : 0.7, mb = sw ? sb / sw : 0.7;
    const ti = TILE[name], ox = (ti % TILES) * N, oy = Math.floor(ti / TILES) * N;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x, a = T.a[i], o = ((oy + y) * SIZE + ox + x) * 4;
      const e = a > 0.02 ? 1 : 0;
      L0[o] = Math.round(clamp(e ? T.r[i] : mr, 0, 1.2) / 1.2 * 255);       // stored /1.2 so values up to 1.2 survive (shader multiplies by 1.2)
      L0[o + 1] = Math.round(clamp(e ? T.g[i] : mg, 0, 1.2) / 1.2 * 255);
      L0[o + 2] = Math.round(clamp(e ? T.b[i] : mb, 0, 1.2) / 1.2 * 255);
      L0[o + 3] = Math.round(clamp(a) * 255);
    }
    tilesDone++;
    yield [tilesDone, total, '张', '树叶贴图'];
  }
  // mip chain with coverage-preserving alpha
  const mips = [];
  let prev = L0, w = SIZE, h = SIZE_H;
  const nLev = Math.ceil(Math.log2(Math.max(SIZE, SIZE_H)));
  const cov0 = coverage(L0, w * h, ALPHA_TEST);
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), nxt = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0, ws = 0, cnt = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = Math.min(w - 1, 2 * x + dx), sy = Math.min(h - 1, 2 * y + dy);
        const o = (sy * w + sx) * 4, aa = prev[o + 3] / 255 + 1e-3;
        r += prev[o] * aa; g += prev[o + 1] * aa; b += prev[o + 2] * aa; a += prev[o + 3]; ws += aa; cnt++;
      }
      const o = (y * nw + x) * 4;
      nxt[o] = r / ws; nxt[o + 1] = g / ws; nxt[o + 2] = b / ws; nxt[o + 3] = a / cnt;
    }
    // rescale alpha so that the share above the threshold equals the level-0 coverage
    if (nw >= 4 && nh >= 4) {
      let lo = 0.6, hi = 8;
      for (let it = 0; it < 14; it++) { const mid = (lo + hi) / 2; if (coverage(nxt, nw * nh, ALPHA_TEST, mid) < cov0) lo = mid; else hi = mid; }
      const sc = (lo + hi) / 2;
      for (let i = 3; i < nxt.length; i += 4) nxt[i] = Math.min(255, nxt[i] * sc);
    }
    mips.push({ data: nxt, width: nw, height: nh });
    prev = nxt; w = nw; h = nh;
    yield [names.length + Math.min(1, mips.length / nLev), total, '张', '树叶贴图'];
  }
  return { size: SIZE, height: SIZE_H, data: L0, mips, tiles: TILE };
}
/** the whole atlas at once (Node tests, tools, the plants gallery) */
export function bakeAtlas(seed) {
  const g = bakeSteps(seed);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}
/** the atlas with a pause between the steps: `onStep(done, total, unit, label)` may return a promise (env.progress); without it this is just bakeAtlas() */
export async function bakeAtlasAsync(seed, onStep) {
  const g = bakeSteps(seed);
  let r = g.next();
  while (!r.done) { if (onStep) { const w = onStep(r.value[0], r.value[1], r.value[2], r.value[3]); if (w) await w; } r = g.next(); }
  return r.value;
}
function coverage(d, n, thr, scale = 1) {
  let c = 0; const t = thr * 255;
  for (let i = 0; i < n; i++) if (d[i * 4 + 3] * scale > t) c++;
  return c / n;
}

/** Node helper: dump the atlas as an RGBA preview (alpha shown as checker-blend) */
export function atlasPreview(atlas) {
  const W = atlas.size, H = atlas.height, out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4, a = atlas.data[o + 3] / 255, chk = ((x >> 4) + (y >> 4)) & 1 ? 0.34 : 0.42;
    out[o] = Math.min(255, (atlas.data[o] * 1.2 * 0.35 * 1.0) * a + chk * 255 * (1 - a) + 0);
    out[o + 1] = Math.min(255, (atlas.data[o + 1] * 1.2) * a * 0.9 + chk * 255 * (1 - a));
    out[o + 2] = Math.min(255, (atlas.data[o + 2] * 1.2) * a * 0.35 + chk * 255 * (1 - a));
    out[o + 3] = 255;
  }
  return out;
}
