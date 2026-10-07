// Author: suwubee
// plants/build.js — geometry writer + primitives (tube, card, puff) shared by all plant generators. Pure JS (no three.js
// until toGeometry()).  Vertex layout (all float32):
//   position(3) normal(3) uv(2) color(3)  aA(4) = [ao, translucency, flex(wind sway weight 0..1), kind]
//                                         aB(4) = [flutter(leaf tip weight), phase(0..1), hide(0..1), style]
//   kind: 0 bark · 1 leaf card (atlas, cut-out) · 2 solid blob (LOD far crowns, no cut-out) · 3 smooth petal / fruit
//   style (bark): 0 fissured, 1 smooth, 2 scaly plates (pine), 3 bamboo (nodes + streaks)
import { tileRect } from './atlas.js';

export const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  mad: (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
};
export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const mix = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** random unit vector */
export function randDir(rng) {
  const z = rng() * 2 - 1, a = rng() * Math.PI * 2, r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), z, r * Math.sin(a)];
}
/** any unit vector perpendicular to t */
export function perp(t) {
  const r = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return V.norm(V.cross(t, r));
}

export class Builder {
  constructor() { this.p = []; this.n = []; this.uv = []; this.c = []; this.a = []; this.b = []; this.i = []; }
  get count() { return this.p.length / 3; }
  get tris() { return this.i.length / 3; }
  vert(p, n, uv, col, a, b) {
    this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.uv.push(uv[0], uv[1]);
    this.c.push(col[0], col[1], col[2]); this.a.push(a[0], a[1], a[2], a[3]); this.b.push(b[0], b[1], b[2], b[3]);
    return this.p.length / 3 - 1;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  /** append another builder, optionally transformed by (position offset, uniform scale, yaw) */
  append(o, off = [0, 0, 0], s = 1, yaw = 0) {
    const base = this.count, cy = Math.cos(yaw), sy = Math.sin(yaw);
    for (let k = 0; k < o.p.length; k += 3) {
      const x = o.p[k] * s, y = o.p[k + 1] * s, z = o.p[k + 2] * s;
      this.p.push(x * cy + z * sy + off[0], y + off[1], -x * sy + z * cy + off[2]);
      const nx = o.n[k], nz = o.n[k + 2];
      this.n.push(nx * cy + nz * sy, o.n[k + 1], -nx * sy + nz * cy);
    }
    for (let k = 0; k < o.uv.length; k++) this.uv.push(o.uv[k]);
    for (let k = 0; k < o.c.length; k++) this.c.push(o.c[k]);
    for (let k = 0; k < o.a.length; k++) this.a.push(o.a[k]);
    for (let k = 0; k < o.b.length; k++) this.b.push(o.b[k]);
    for (let k = 0; k < o.i.length; k++) this.i.push(o.i[k] + base);
  }
  /**
   * crown extent: rh = 92nd percentile of the horizontal distance (from the y axis) of foliage vertices (kind != bark), rEq = area-equivalent radius of the crown's ground
   * footprint (what a crown traced from satellite imagery measures), H = top, y0 = lowest foliage
   */
  extent() {
    const rs = []; let H = -1e9, y0 = 1e9;
    for (let i = 0; i < this.p.length / 3; i++) {
      const y = this.p[i * 3 + 1]; if (y > H) H = y;
      if (this.a[i * 4 + 3] !== 0) { rs.push(Math.hypot(this.p[i * 3], this.p[i * 3 + 2])); if (y < y0) y0 = y; }
    }
    rs.sort((a, b) => a - b);
    // ground footprint of the foliage triangles (point-sampled raster, 0.4 m) → area-equivalent radius
    const CELL = 0.4, filled = new Set(), P = this.p, I = this.i;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      if (this.a[a * 4 + 3] === 0) continue;
      const ax = P[a * 3], az = P[a * 3 + 2], bx = P[b * 3], bz = P[b * 3 + 2], cx = P[c * 3], cz = P[c * 3 + 2];
      const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(den) < 1e-9) continue;
      const i0 = Math.floor(Math.min(ax, bx, cx) / CELL), i1 = Math.floor(Math.max(ax, bx, cx) / CELL), j0 = Math.floor(Math.min(az, bz, cz) / CELL), j1 = Math.floor(Math.max(az, bz, cz) / CELL);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = (i + 0.5) * CELL, pz = (j + 0.5) * CELL;
        const u = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den, v = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den, w = 1 - u - v;
        if (u >= -0.02 && v >= -0.02 && w >= -0.02) filled.add((i + 4096) * 8192 + (j + 4096));
      }
    }
    const rh = rs.length ? rs[Math.min(rs.length - 1, Math.floor(rs.length * 0.92))] : 1;
    // (vertical cards — willow curtains, bamboo sprays — have almost no ground projection: never less than 80 % of the radial extent)
    return { rh, rEq: Math.max(Math.sqrt(filled.size * CELL * CELL / Math.PI) || 0, 0.8 * rh), H, y0 };
  }
  /** a copy with anisotropic scale (sx, sy, sz) then an offset (ox, oy, oz); normals are corrected */
  scaled(sx, sy, sz, ox = 0, oy = 0, oz = 0) {
    const o = new Builder();
    for (let k = 0; k < this.p.length; k += 3) {
      o.p.push(this.p[k] * sx + ox, this.p[k + 1] * sy + oy, this.p[k + 2] * sz + oz);
      const nx = this.n[k] / sx, ny = this.n[k + 1] / sy, nz = this.n[k + 2] / sz, l = Math.hypot(nx, ny, nz) || 1;
      o.n.push(nx / l, ny / l, nz / l);
    }
    o.uv = this.uv.slice(); o.c = this.c.slice(); o.a = this.a.slice(); o.b = this.b.slice(); o.i = this.i.slice();
    return o;
  }
  /** local bounding box [minx,miny,minz,maxx,maxy,maxz] */
  bbox() {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = 0; k < this.p.length; k += 3) for (let j = 0; j < 3; j++) { const v = this.p[k + j]; if (v < b[j]) b[j] = v; if (v > b[j + 3]) b[j + 3] = v; }
    return b;
  }
  toGeometry(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aA', new THREE.Float32BufferAttribute(this.a, 4));
    g.setAttribute('aB', new THREE.Float32BufferAttribute(this.b, 4));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

/**
 * Sweep a circle along `path` (array of [x,y,z]) with per-point radii. Parallel-transport frames; closed with a cone tip.
 * o: { col, colTip, ao, flex0, flex1, style, uRep, vScale, tip (cone length factor, 0 = no cap), phase, hide, nodes (bamboo node ridges every `nodes` m) }
 */
export function tube(B, path, radii, sides, o = {}) {
  const n = path.length;
  const col0 = o.col || [0.08, 0.06, 0.045], col1 = o.colTip || col0;
  const flex0 = o.flex0 ?? 0, flex1 = o.flex1 ?? 0.5, uRep = o.uRep ?? 1, vScale = o.vScale ?? 1, ao = o.ao ?? 0.9;
  const T = [];
  for (let i = 0; i < n; i++) T.push(V.norm(V.sub(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)])));
  let N = perp(T[0]);
  const rings = [];
  let cum = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) { cum += V.len(V.sub(path[i], path[i - 1])); N = V.norm(V.sub(N, V.mul(T[i], V.dot(N, T[i])))); }
    const Bn = V.cross(T[i], N);
    const t = n > 1 ? i / (n - 1) : 0;
    const col = [mix(col0[0], col1[0], t), mix(col0[1], col1[1], t), mix(col0[2], col1[2], t)];
    const dr = i < n - 1 ? (radii[i + 1] - radii[i]) / Math.max(1e-4, V.len(V.sub(path[i + 1], path[i]))) : (i > 0 ? (radii[i] - radii[i - 1]) / Math.max(1e-4, V.len(V.sub(path[i], path[i - 1]))) : 0);
    const ids = [];
    const fl = mix(flex0, flex1, t);
    for (let j = 0; j <= sides; j++) {
      const an = (j / sides) * Math.PI * 2, c = Math.cos(an), s = Math.sin(an);
      const dir = [N[0] * c + Bn[0] * s, N[1] * c + Bn[1] * s, N[2] * c + Bn[2] * s];
      let r = radii[i];
      if (o.nodes) { const f = (cum % o.nodes) / o.nodes; r *= 1 + 0.16 * Math.exp(-Math.pow((f - 0.02) * 16, 2)) + 0.05 * Math.exp(-Math.pow((f - 0.12) * 12, 2)); }
      const nn = V.norm(V.mad(dir, T[i], -dr));
      ids.push(B.vert(V.mad(path[i], dir, r), nn, [(j / sides) * uRep, cum * vScale], col, [ao, 0, fl, 0], [0, o.phase ?? 0, o.hide ?? 0, o.style ?? 0]));
    }
    rings.push(ids);
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < sides; j++) {
    const a = rings[i][j], b = rings[i][j + 1], c = rings[i + 1][j + 1], d = rings[i + 1][j];
    B.tri(a, d, c); B.tri(a, c, b);
  }
  if ((o.tip ?? 1) > 0 && radii[n - 1] > 0.004) {
    const e = path[n - 1], tip = V.mad(e, T[n - 1], radii[n - 1] * 1.2 * (o.tip ?? 1));
    const tv = B.vert(tip, T[n - 1], [0.5 * uRep, cum * vScale], col1, [ao, 0, flex1, 0], [0, o.phase ?? 0, o.hide ?? 0, o.style ?? 0]);
    for (let j = 0; j < sides; j++) B.tri(rings[n - 1][j], tv, rings[n - 1][j + 1]);
  }
  return { cum };
}

/**
 * One foliage card. c = centre, U = unit across, V = unit up (tile "up" = top of the tile), w × h metres.
 * o: { tile (name | rect), nrm | nrmFn(p), col, ao, trans, flex, phase, hide, anchor ('c' | 'b': c is the BOTTOM centre), bend, flipU, kind, rows }
 * UV: tile top row = v0 → mapped to the card's top.
 */
export function card(B, c, U, Vv, w, h, o) {
  const rect = Array.isArray(o.tile) ? o.tile : tileRect(o.tile);
  const [u0, v0, u1, v1] = rect;
  const base = o.anchor === 'b' ? V.mad(c, Vv, h / 2) : c;
  const flipU = o.flipU ? 1 : 0;
  const rows = o.rows ?? (o.bend ? 3 : 2);
  const faceN = V.norm(V.cross(U, Vv));
  const ids = [];
  const col = o.col || [0.08, 0.17, 0.045];
  const kind = o.kind ?? 1;
  for (let r = 0; r < rows; r++) {
    const f = r / (rows - 1);                           // 0 bottom .. 1 top
    for (let k = 0; k < 2; k++) {
      const sx = k ? 0.5 : -0.5;
      let p = V.mad(V.mad(base, U, sx * w), Vv, (f - 0.5) * h);
      if (o.bend) p = V.mad(p, faceN, o.bend * h * Math.sin(f * Math.PI) * 0.5 - o.bend * h * 0.15 * f);
      if (o.droop) p = V.mad(p, [0, -1, 0], o.droop * h * f * f);
      const nrm = o.nrmFn ? o.nrmFn(p) : (o.nrm || faceN);
      const uu = flipU ? (k ? u0 : u1) : (k ? u1 : u0);
      const vv = v1 + (v0 - v1) * f;
      const fl = (o.flutter ?? 1) * f;
      const aoV = o.aoFn ? o.aoFn(p) : (o.ao ?? 0.8);
      const fx = o.flexBot !== undefined ? mix(o.flexBot, o.flexTop ?? o.flex ?? 0.5, f) : (o.flex ?? 0.5);
      ids.push(B.vert(p, nrm, [uu, vv], col, [aoV, o.trans ?? 0.5, fx, kind], [fl, o.phase ?? 0, o.hide ?? 0, o.twoSided ? 1 : 0]));
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    const a = ids[r * 2], b = ids[r * 2 + 1], c2 = ids[r * 2 + 3], d = ids[r * 2 + 2];
    B.tri(a, b, c2); B.tri(a, c2, d);
  }
}

/**
 * A cluster of leaf cards inside / on an ellipsoid ("sub-crown"): centre c, radii (rx, ry, rz); n cards of size s.
 * crown = { c:[x,y,z], R } of the whole tree for outward normals + ao.
 * o: { tile, col, colVar, trans, flex, shell (0..1: 1 = only on the outer shell), up (card up bias), aspect, nrmMix }
 */
export function puff(B, rng, c, rx, ry, rz, n, size, crown, o) {
  const col0 = o.col, shell = o.shell ?? 0.65, aspect = o.aspect ?? 1, nrmMix = o.nrmMix ?? 0.75;
  for (let k = 0; k < n; k++) {
    // point inside the ellipsoid, biased towards the shell
    const d = randDir(rng), rr = Math.pow(rng(), 1 / 3) * (1 - shell) + shell * (0.78 + 0.22 * rng());
    const off = [d[0] * rx * rr, d[1] * ry * rr, d[2] * rz * rr];
    const p = V.add(c, off);
    if (o.reject && o.reject(p)) continue;
    // outward = blend of the sub-crown radial direction and the whole-crown radial direction
    const rad1 = V.norm([off[0] / rx, off[1] / ry * 1.1 + 0.15, off[2] / rz]);
    const rad2 = V.norm(V.sub(p, crown.c));
    const out = V.norm(V.add(V.mul(rad1, 0.6), V.mul(rad2, 0.4)));
    // card orientation: face normal random but biased outward; "up" of the card points outward/up
    let nc = V.norm(V.add(V.mul(randDir(rng), 1 - (o.faceOut ?? 0.45)), V.mul(out, (o.faceOut ?? 0.45) * 1.6)));
    let v0 = V.norm(V.add(V.add(V.mul(out, 0.6), [0, (o.up ?? 0.5), 0]), V.mul(randDir(rng), 0.35)));
    let Vv = V.sub(v0, V.mul(nc, V.dot(v0, nc)));
    if (V.len(Vv) < 0.05) Vv = perp(nc);
    Vv = V.norm(Vv);
    const U = V.norm(V.cross(Vv, nc));
    const sz = size * (0.75 + 0.5 * rng());
    // brightness: outer / upper cards lighter, inner darker (self-shadow); small random hue drift
    const radial = clamp(V.len(V.sub(p, crown.c)) / crown.R);
    if (o.minRadial && radial < o.minRadial) continue;
    const upF = 0.5 + 0.5 * out[1];
    const ao = clamp(0.38 + 0.62 * Math.pow(radial, 0.9)) * (0.78 + 0.22 * upF);
    const lum = (0.82 + 0.34 * rng()) * (0.88 + 0.2 * upF);
    const hue = (rng() - 0.5) * (o.colVar ?? 0.18);
    const col = [col0[0] * lum * (1 + hue), col0[1] * lum, col0[2] * lum * (1 - hue * 1.4)];
    const nrm = V.norm(V.add(V.mul(out, nrmMix), V.mul(nc, 1 - nrmMix)));
    card(B, p, U, Vv, sz, sz * aspect, {
      tile: o.tile, nrm: V.dot(nrm, out) < 0 ? V.mul(nrm, -1) : nrm, col, ao, trans: o.trans ?? 0.55, flex: (o.flex ?? 0.6) * (0.5 + 0.5 * clamp(p[1] / (crown.H || 8))),
      phase: rng(), hide: rng(), anchor: 'c', bend: o.bend, flipU: rng() < 0.5, flutter: o.flutter ?? 1,
    });
  }
}

/** low-poly lumpy ellipsoid (far LOD crowns, shrubs' cores): `rings` latitudes × `segs` meridians, noise via rng */
export function blob(B, rng, c, rx, ry, rz, rings, segs, col, o = {}) {
  const lump = o.lump ?? 0.18, ao0 = o.ao ?? 0.5;
  const ph = rng() * 10, ids = [];
  const top = (rr, kk) => [c[0], c[1] + ry * kk, c[2]];
  const rowStart = [];
  const nrm = (p) => V.norm([(p[0] - c[0]) / (rx * rx), (p[1] - c[1]) / (ry * ry) * 1.0 + 0.0, (p[2] - c[2]) / (rz * rz)]);
  const kind = o.kind ?? 2;
  const idxTop = B.vert(top(0, 1 + lump * 0.3 * (rng() - 0.5)), [0, 1, 0], [0.5, 0.5], col, [1, o.trans ?? 0.4, o.flex ?? 0.5, kind], [0, rng(), 0, 0]);
  for (let r = 1; r < rings; r++) {
    const el = Math.PI / 2 - (r / rings) * Math.PI * (o.flatBottom ? 0.82 : 1);
    const row = [];
    for (let s = 0; s <= segs; s++) {
      const a = ((s % segs) / segs) * Math.PI * 2 + (r % 2) * (Math.PI / segs);
      const k = 1 + lump * (Math.sin(a * 3 + ph + r * 1.7) * 0.5 + (rng() - 0.5) * 0.7);
      const p = [c[0] + Math.cos(a) * Math.cos(el) * rx * k, c[1] + Math.sin(el) * ry * k, c[2] + Math.sin(a) * Math.cos(el) * rz * k];
      const nn = nrm(p);
      const lum = 0.85 + 0.3 * rng();
      row.push(B.vert(p, nn, [(s / segs) * (o.uvScale ? o.uvScale[0] : 3), r / rings * (o.uvScale ? o.uvScale[1] : 3)], [col[0] * lum, col[1] * lum, col[2] * lum], [clamp(ao0 + (1 - ao0) * (0.5 + 0.5 * nn[1])), o.trans ?? 0.4, o.flex ?? 0.5, kind], [0, rng(), 0, 0]));
    }
    rowStart.push(row);
  }
  const idxBot = B.vert([c[0], c[1] - ry * (o.flatBottom ? 0.7 : 1), c[2]], [0, -1, 0], [0.5, 0.5], [col[0] * 0.6, col[1] * 0.6, col[2] * 0.6], [ao0, 0.2, o.flex ?? 0.5, kind], [0, 0, 0, 0]);
  for (let s = 0; s < segs; s++) B.tri(idxTop, rowStart[0][s + 1], rowStart[0][s]);
  for (let r = 0; r < rowStart.length - 1; r++) for (let s = 0; s < segs; s++) {
    const a = rowStart[r][s], b = rowStart[r][s + 1], d = rowStart[r + 1][s], e = rowStart[r + 1][s + 1];
    B.tri(a, b, e); B.tri(a, e, d);
  }
  const last = rowStart[rowStart.length - 1];
  for (let s = 0; s < segs; s++) B.tri(idxBot, last[s], last[s + 1]);
  return ids;
}

/**
 * Far-LOD lobe: a low-poly lump (segs × rings lat-long) with kind 4 (clumped-foliage shading + alpha-cut in the shader).
 * c = centre, rh / rv = horizontal / vertical radius, o: { col, ao (base ambient at the crown bottom), hide (0..1 instance-density threshold), trans, flex,
 *   jitter (radial noise), segs, rings, tilt: [dx, dz], crown: { c: [x, y, z], r: [rx, ry, rz] } (normals / ambient follow the whole crown ellipsoid so it
 *   shades as one mass), nBlend (weight of the crown normal, 0.55) }
 */
export function lobe(B, rng, c, rh, rv, o = {}) {
  const segs = o.segs ?? 7, rings = o.rings ?? 3, jit = o.jitter ?? 0.16, ao0 = o.ao ?? 0.55, col = o.col || [1, 1, 1];
  const trans = o.trans ?? 0.4, flex = o.flex ?? 0.35, hide = o.hide ?? 0, phase = rng();
  const ph = rng() * 10, tilt = o.tilt || [0, 0], cr = o.crown, nb = o.nBlend ?? 0.55;
  const nrmL = (p) => V.norm([(p[0] - c[0]) / (rh * rh), (p[1] - c[1]) / (rv * rv), (p[2] - c[2]) / (rh * rh)]);
  const mk = (p, ll) => {
    let nn = nrmL(p), ao;
    if (cr) {
      const nc = V.norm([(p[0] - cr.c[0]) / (cr.r[0] * cr.r[0]), (p[1] - cr.c[1]) / (cr.r[1] * cr.r[1]), (p[2] - cr.c[2]) / (cr.r[2] * cr.r[2])]);
      nn = V.norm(V.add(V.mul(nn, 1 - nb), V.mul(nc, nb)));
      ao = clamp(ao0 + (1 - ao0) * smooth(cr.c[1] - cr.r[1], cr.c[1] + cr.r[1] * 0.9, p[1])) * (0.88 + 0.12 * (0.5 + 0.5 * nn[1]));
    } else ao = clamp(ao0 + (1 - ao0) * (0.5 + 0.5 * nn[1]));
    return B.vert(p, nn, [0, 0], [col[0] * ll, col[1] * ll, col[2] * ll], [ao, trans, flex, 4], [0, phase, hide, 0]);
  };
  const topP = [c[0] + tilt[0] * rv, c[1] + rv * (1 + jit * 0.3 * (rng() - 0.5)), c[2] + tilt[1] * rv];
  const idxTop = mk(topP, 1.1);
  const rows = [];
  for (let r = 1; r < rings; r++) {
    const el = Math.PI / 2 - (r / rings) * Math.PI, row = [];
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2 + (r % 2) * (Math.PI / segs);
      const k = 1 + jit * (Math.sin(a * 3 + ph + r * 1.7) * 0.5 + (rng() - 0.5) * 0.9);
      const p = [c[0] + Math.cos(a) * Math.cos(el) * rh * k + tilt[0] * rv * Math.sin(el), c[1] + Math.sin(el) * rv * k, c[2] + Math.sin(a) * Math.cos(el) * rh * k + tilt[1] * rv * Math.sin(el)];
      row.push(mk(p, 0.88 + 0.24 * rng()));
    }
    rows.push(row);
  }
  const idxBot = mk([c[0], c[1] - rv * 0.9, c[2]], 0.75);
  for (let s = 0; s < segs; s++) B.tri(idxTop, rows[0][(s + 1) % segs], rows[0][s]);
  for (let r = 0; r < rows.length - 1; r++) for (let s = 0; s < segs; s++) {
    const a = rows[r][s], b = rows[r][(s + 1) % segs], d = rows[r + 1][s], e = rows[r + 1][(s + 1) % segs];
    B.tri(a, b, e); B.tri(a, e, d);
  }
  const last = rows[rows.length - 1];
  for (let s = 0; s < segs; s++) B.tri(idxBot, last[s], last[(s + 1) % segs]);
}
