// Author: suwubee
// rock/geom.js — procedural rock base meshes (CPU, deterministic: seeded RNG + noise from src/engine/noise.js only).
//
//   blockStone(seed, kind)  黄石: convex block cut by random planes (bedded, flat top, sharp edges), per-face smooth normals
//                         kind = 'chunk' | 'slab' | 'tall' | 'block' (coursed wall stone)
//   erodedBlock(seed, kind) 湖石 bank stone / upright: plane-cut irregular solid with bites and soft normals (kind 'hblock' | 'pillar')
//   porousStone(seed, o)     湖石 with real holes: SDF of smooth-unioned ellipsoids minus capsule tunnels + wrinkles → surface nets
// Every builder returns { pos, nor, aux, idx, tris, w, h, d } with the base at y = 0, centred in xz.
//   aux = (baked ambient occlusion 0..1, height 0..1). Unit-size variants are normalised to a 1 m footprint
//   (blockStone / lumps) or to a 1 m height ('standing' peaks) — the instance scale gives the real size.
import { makeRng, snoise3 } from '../../engine/noise.js';
import { surfaceNets } from './sdf.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const fbm3 = (x, y, z, oct = 3) => { let s = 0, a = 1, n = 0; for (let i = 0; i < oct; i++) { s += a * snoise3(x, y, z); n += a; x = x * 2.03 + 17.1; y = y * 2.03 + 4.3; z = z * 2.03 + 9.7; a *= 0.5; } return s / n; };
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// ------------------------------------------------------------------------------------------------ convex solid by clipping
function newell(pts) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}
function boxFaces(h) {
  const v = (x, y, z) => [x * h, y * h, z * h];
  const f = [
    [v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1)], [v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1), v(-1, -1, -1)],
    [v(-1, 1, -1), v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1)], [v(-1, -1, 1), v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1)],
    [v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)], [v(1, -1, -1), v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1)],
  ];
  const nrm = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  return f.map((pts, i) => (dot3(newell(pts), nrm[i]) < 0 ? pts.slice().reverse() : pts));
}
/** keep n·p <= d. faces = array of polygons (arrays of [x,y,z]) of a convex solid, CCW seen from outside. */
function clipSolid(faces, n, d) {
  const out = [], cut = [], EPS = 1e-7;
  for (const poly of faces) {
    const res = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = dot3(n, a) - d, db = dot3(n, b) - d;
      if (da <= EPS) res.push(a);
      if (Math.abs(da) <= EPS) cut.push(a);
      if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
        const t = da / (da - db), p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        res.push(p); cut.push(p);
      }
    }
    if (res.length >= 3) out.push(res);
  }
  // cap polygon from the cut points (deduplicate, order CCW around n)
  const uniq = [];
  for (const p of cut) if (!uniq.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-5)) uniq.push(p);
  if (uniq.length >= 3) {
    const c = [0, 0, 0]; for (const p of uniq) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    c[0] /= uniq.length; c[1] /= uniq.length; c[2] /= uniq.length;
    const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm3(cross3(ref, n)), v = cross3(n, u);
    uniq.sort((p, q) => Math.atan2(dot3(sub3(p, c), v), dot3(sub3(p, c), u)) - Math.atan2(dot3(sub3(q, c), v), dot3(sub3(q, c), u)));
    out.push(uniq);
  }
  // drop duplicate consecutive vertices
  return out.map((poly) => poly.filter((p, i) => { const q = poly[(i + poly.length - 1) % poly.length]; return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1e-5; })).filter((p) => p.length >= 3);
}

// ------------------------------------------------------------------------------------------------ mesh accumulation
class Soup {
  constructor() { this.pos = []; this.nor = []; this.aux = []; this.idx = []; this.key = new Map(); this.vkey = []; }
  get count() { return this.pos.length / 3; }
}
const keyOf = (x, y, z) => `${Math.round(x * 2e4)},${Math.round(y * 2e4)},${Math.round(z * 2e4)}`;

/** finish a Soup: smooth normals (within face groups, optionally blended with position-welded normals), normalise, centre. */
function finish(g, { widthNorm = true, heightNorm = false, beta = 0 } = {}) {
  const n = g.pos.length / 3;
  // bounding box → base at y = 0, centred in xz, scaled
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < n; i++) {
    const x = g.pos[i * 3], y = g.pos[i * 3 + 1], z = g.pos[i * 3 + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const sc = heightNorm ? 1 / (y1 - y0) : widthNorm ? 1 / Math.max(x1 - x0, z1 - z0) : 1;
  const pos = new Float32Array(n * 3), aux = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (g.pos[i * 3] - cx) * sc; pos[i * 3 + 1] = (g.pos[i * 3 + 1] - y0) * sc; pos[i * 3 + 2] = (g.pos[i * 3 + 2] - cz) * sc;
    aux[i * 2] = g.aux[i * 2]; aux[i * 2 + 1] = (g.pos[i * 3 + 1] - y0) / Math.max(1e-6, y1 - y0);
  }
  const nor = g.nor ? Float32Array.from(g.nor) : new Float32Array(n * 3);
  return { pos, nor, aux, idx: g.idx.length && n > 65535 ? Uint32Array.from(g.idx) : Uint16Array.from(g.idx), tris: g.idx.length / 3, w: (x1 - x0) * sc, h: (y1 - y0) * sc, d: (z1 - z0) * sc };
}

// ------------------------------------------------------------------------------------------------ 黄石 / 湖石 blocks
// A convex solid = big cube clipped by planes (random leaning sides, tilted top / bottom, chamfers). Faces are fan-triangulated from a displaced
// centre (detail 1 adds edge midpoints); a position-based vector noise roughens the corners; 湖石 pieces additionally get inward "bites" (窝) and
// smoother normals so they read as eroded, irregular stones — never as spheres.
const STYLE = {
  chunk: { amp: 0.032, bulge: 1.8, beta: 0.14, bites: 0 },    // boulder, flat-ish top (hill outcrops, the entrance screen)
  slab: { amp: 0.014, bulge: 1.8, beta: 0.14, bites: 0 },     // flat laid stone (steps, plinths)
  tall: { amp: 0.032, bulge: 1.8, beta: 0.14, bites: 0 },     // upright stele
  block: { amp: 0.018, bulge: 1.4, beta: 0.10, bites: 0 },    // coursed wall stone: boxy plan, near-horizontal top and bed
  hblock: { amp: 0.045, bulge: 2.0, beta: 0.55, bites: 3 },   // 湖石 bank stone
  pillar: { amp: 0.045, bulge: 2.0, beta: 0.55, bites: 4 },   // 湖石 upright
};

/**
 * 黄石 block. kind: 'chunk' (boulder), 'slab' (flat laid stone), 'tall' (upright stele), 'block' (coursed wall stone).
 * detail 0 = centre fan per face, 1 = centre + edge midpoints (about twice the triangles).
 */
export function blockStone(seed, kind = 'chunk', detail = 0) { return planeSolid(`blockStone:${kind}:${seed}`, kind, detail); }
/** 湖石 stone: kind 'hblock' (squat / bank stone) or 'pillar' (upright). */
export function erodedBlock(seed, kind = 'hblock', detail = 0) { return planeSolid(`hushi:${kind}:${seed}`, kind, detail); }

function planeSolid(label, kind, detail) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const rng = makeRng(`${label}:${attempt}`);
    const planes = [];
    let H, W = 1.0, D;
    if (kind === 'slab') { H = rng.float(0.24, 0.38); D = rng.float(0.6, 0.8); }
    else if (kind === 'tall') { H = rng.float(1.3, 1.85); W = rng.float(0.5, 0.62); D = rng.float(0.42, 0.56); }
    else if (kind === 'block') { H = rng.float(0.34, 0.6); D = rng.float(0.62, 0.9); }
    else if (kind === 'hblock') { H = rng.float(0.45, 0.85); D = rng.float(0.65, 1.0); }
    else if (kind === 'pillar') { H = rng.float(1.5, 2.3); W = rng.float(0.8, 1.0); D = rng.float(0.55, 0.85); }
    else { H = rng.float(0.55, 0.9); D = rng.float(0.62, 0.95); }
    const rx = W / 2, rz = D / 2;
    if (kind === 'block') {                                  // rectangular plan, sides within ±12° of the axes
      const a0 = rng.float(-0.2, 0.2);
      for (let k = 0; k < 4; k++) {
        const a = a0 + k * Math.PI / 2 + rng.float(-0.2, 0.2), lean = rng.float(-0.12, 0.08), n = norm3([Math.cos(a), -lean, Math.sin(a)]);
        planes.push([n, (k % 2 === 0 ? rx : rz) * rng.float(0.9, 1.02)]);
      }
      planes.push([norm3([rng.float(-0.05, 0.05), 1, rng.float(-0.05, 0.05)]), H / 2]);
      planes.push([norm3([rng.float(-0.06, 0.06), -1, rng.float(-0.06, 0.06)]), H / 2 * rng.float(0.9, 1.0)]);
      const nc = rng.int(2, 4);
      for (let j = 0; j < nc; j++) {
        const e = rng.float(0.35, 1.0) * (rng.chance(0.75) ? 1 : -1), a = rng.float(0, Math.PI * 2), n = [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
        planes.push([n, (Math.abs(n[0]) * rx + Math.abs(n[1]) * H / 2 + Math.abs(n[2]) * rz) * rng.float(0.8, 0.93)]);
      }
    } else {
      const ns = kind === 'hblock' ? rng.int(5, 7) : kind === 'pillar' ? rng.int(5, 6) : rng.int(4, kind === 'tall' ? 5 : 6), a0 = rng.float(0, Math.PI * 2);
      const jit = (kind === 'hblock' || kind === 'pillar') ? 0.4 : 0.35;
      for (let k = 0; k < ns; k++) {
        const a = a0 + (k + rng.float(-jit, jit)) * Math.PI * 2 / ns;
        const lean = kind === 'hblock' ? rng.float(-0.3, 0.2) : kind === 'pillar' ? rng.float(-0.14, 0.12) : rng.float(-0.26, 0.14);
        const n = norm3([Math.cos(a), -lean, Math.sin(a)]);
        const rr = 1 / Math.sqrt((Math.cos(a) / rx) ** 2 + (Math.sin(a) / rz) ** 2);
        planes.push([n, rr * rng.float(kind === 'hblock' || kind === 'pillar' ? 0.76 : 0.8, 1.02)]);
      }
      const tt = kind === 'slab' ? 0.07 : (kind === 'hblock' || kind === 'pillar') ? 0.24 : 0.2;
      planes.push([norm3([rng.float(-tt, tt), 1, rng.float(-tt, tt)]), H / 2]);
      planes.push([norm3([rng.float(-0.18, 0.18), -1, rng.float(-0.18, 0.18)]), H / 2 * rng.float(0.88, 1.0)]);
      const nc = kind === 'hblock' ? rng.int(6, 9) : kind === 'pillar' ? rng.int(6, 8) : rng.int(4, kind === 'slab' ? 5 : 7);
      for (let j = 0; j < nc; j++) {
        const e = rng.float(0.25, 1.2) * (rng.chance(0.66) ? 1 : -1), a = rng.float(0, Math.PI * 2);
        const n = [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
        planes.push([n, (Math.abs(n[0]) * rx + Math.abs(n[1]) * H / 2 + Math.abs(n[2]) * rz) * rng.float(kind === 'hblock' || kind === 'pillar' ? 0.6 : 0.62, kind === 'hblock' || kind === 'pillar' ? 0.88 : 0.9)]);
      }
    }
    let faces = boxFaces(3);
    for (const [n, d] of planes) faces = clipSolid(faces, n, d);
    if (faces.length < 6) continue;
    let vol = 0;                                             // signed volume sanity (divergence theorem)
    for (const f of faces) { const c = f[0]; for (let i = 1; i < f.length - 1; i++) vol += dot3(c, cross3(f[i], f[i + 1])) / 6; }
    if (!(vol > 0.03)) continue;
    return meshFromFaces(faces, rng, detail, STYLE[kind] || STYLE.chunk);
  }
  throw new Error('rock block: could not build ' + label);
}

function meshFromFaces(faces, rng, detail, style) {
  const g = new Soup(), off = rng.float(0, 100);
  const amp = style.amp, bulgeAmp = amp * style.bulge;
  let ymin = 1e9, ymax = -1e9; const C = [0, 0, 0]; let nC = 0;
  for (const f of faces) for (const p of f) { ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); C[0] += p[0]; C[1] += p[1]; C[2] += p[2]; nC++; }
  C[0] /= nC; C[1] /= nC; C[2] /= nC;
  // inward bites (窝): gaussian dents toward the centroid, centred on the surface along random directions
  const bites = [];
  for (let i = 0; i < style.bites; i++) {
    const u = norm3([rng.float(-1, 1), rng.float(-0.5, 0.9), rng.float(-1, 1)]);
    let sup = 0; for (const f of faces) for (const p of f) sup = Math.max(sup, dot3(sub3(p, C), u));
    bites.push({ c: [C[0] + u[0] * sup * 0.92, C[1] + u[1] * sup * 0.92, C[2] + u[2] * sup * 0.92], r: rng.float(0.16, 0.3), d: rng.float(0.06, 0.13) });
  }
  const dent = (p) => {                                       // returns [dx,dy,dz,weight]
    let w = 0, dx = 0, dy = 0, dz = 0;
    for (const b of bites) {
      const d2 = (p[0] - b.c[0]) ** 2 + (p[1] - b.c[1]) ** 2 + (p[2] - b.c[2]) ** 2, k = Math.exp(-d2 / (b.r * b.r));
      if (k < 0.02) continue;
      const v = norm3(sub3(C, p)); dx += v[0] * b.d * k; dy += v[1] * b.d * k; dz += v[2] * b.d * k; w += k;
    }
    return [dx, dy, dz, Math.min(1, w)];
  };
  const disp = (p) => {
    const q = dent(p);
    return [amp * snoise3(p[0] * 2.3 + off, p[1] * 2.3, p[2] * 2.3) + q[0], amp * 0.6 * snoise3(p[0] * 2.3 + 31, p[1] * 2.3 + off, p[2] * 2.3) + q[1], amp * snoise3(p[0] * 2.3, p[1] * 2.3 + 57, p[2] * 2.3 + off) + q[2], q[3]];
  };
  const tris = [];
  for (let fi = 0; fi < faces.length; fi++) {
    const poly = faces[fi];
    const fn = norm3(newell(poly));
    const c = [0, 0, 0]; for (const p of poly) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    c[0] /= poly.length; c[1] /= poly.length; c[2] /= poly.length;
    const bulge = bulgeAmp * snoise3(c[0] * 3.1 + off, c[1] * 3.1, c[2] * 3.1);
    const dc = dent(c);
    const pc = [c[0] + fn[0] * bulge + dc[0], c[1] + fn[1] * bulge + dc[1], c[2] + fn[2] * bulge + dc[2]];
    const add = (p, aoExtra, bw) => {
      g.pos.push(p[0], p[1], p[2]);
      const y01 = (p[1] - ymin) / Math.max(1e-6, ymax - ymin);
      g.aux.push(clamp(0.58 + 0.42 * smoothstep(0.0, 0.32, y01) + aoExtra - 0.38 * bw, 0.2, 1), 0);
      g.vkey.push(keyOf(p[0], p[1], p[2]));
      return g.count - 1;
    };
    const corner = poly.map((p) => { const d = disp(p); return [p[0] + d[0], p[1] + d[1], p[2] + d[2], d[3]]; });
    const iCorner = corner.map((p) => add(p, 0, p[3]));
    const iCentre = add(pc, bulge < 0 ? bulge * 3 : 0, dc[3]);
    if (detail >= 1) {
      const iMid = corner.map((p, i) => { const q = corner[(i + 1) % corner.length], m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]; const d = disp(m); return add([m[0] + d[0] * 0.5, m[1] + d[1] * 0.5, m[2] + d[2] * 0.5], 0, d[3]); });
      for (let i = 0; i < corner.length; i++) {
        const j = (i + 1) % corner.length;
        tris.push([iCorner[i], iMid[i], iCentre, fi], [iMid[i], iCorner[j], iCentre, fi]);
      }
    } else {
      for (let i = 0; i < corner.length; i++) tris.push([iCorner[i], iCorner[(i + 1) % corner.length], iCentre, fi]);
    }
  }
  // normals: area-weighted within each face (local smoothing), blended with the position-welded normals by style.beta
  const n = g.count, nl = new Float64Array(n * 3), ng = new Map();
  for (const t of tris) {
    const [a, b, c] = t, pa = [g.pos[a * 3], g.pos[a * 3 + 1], g.pos[a * 3 + 2]], pb = [g.pos[b * 3], g.pos[b * 3 + 1], g.pos[b * 3 + 2]], pc2 = [g.pos[c * 3], g.pos[c * 3 + 1], g.pos[c * 3 + 2]];
    const fnv = cross3(sub3(pb, pa), sub3(pc2, pa));
    for (const v of [a, b, c]) { nl[v * 3] += fnv[0]; nl[v * 3 + 1] += fnv[1]; nl[v * 3 + 2] += fnv[2]; const k = g.vkey[v]; const o = ng.get(k) || [0, 0, 0]; o[0] += fnv[0]; o[1] += fnv[1]; o[2] += fnv[2]; ng.set(k, o); }
  }
  const beta = style.beta;
  g.nor = new Array(n * 3);
  for (let v = 0; v < n; v++) {
    const l = norm3([nl[v * 3], nl[v * 3 + 1], nl[v * 3 + 2]]), gk = norm3(ng.get(g.vkey[v]));
    const m = norm3([l[0] * (1 - beta) + gk[0] * beta, l[1] * (1 - beta) + gk[1] * beta, l[2] * (1 - beta) + gk[2] * beta]);
    g.nor[v * 3] = m[0]; g.nor[v * 3 + 1] = m[1]; g.nor[v * 3 + 2] = m[2];
  }
  for (const t of tris) g.idx.push(t[0], t[1], t[2]);
  return finish(g, { widthNorm: true });
}

// ------------------------------------------------------------------------------------------------ 湖石 SDF pieces
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a, b, k) => -smin(-a, -b, k);
function capsuleSdf(px, py, pz, ax, ay, az, bx, by, bz, r) {
  const pax = px - ax, pay = py - ay, paz = pz - az, bax = bx - ax, bay = by - ay, baz = bz - az;
  const h = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r;
}

/**
 * Field of a perforated 太湖石 piece. o = { W (widest radius), H, blobs, holes, scoops, sway, crown, wrinkle, warp, smooth, profile }.
 * Origin at the base centre, +y up, flat base at y = 0.  "瘦 皱 漏 透": slender, folded, hollowed, perforated.
 */
export function porousField(seed, o = {}) {
  const rng = makeRng(`taihu:${seed}`);
  const W = o.W ?? 0.5, H = o.H ?? 1.6, nb = o.blobs ?? 7, nh = o.holes ?? 4, ns = o.scoops ?? 0, sway = o.sway ?? 0.18, crown = o.crown ?? 0.0, wr = o.wrinkle ?? 0.05, warp = o.warp ?? 0;
  const blobs = [];
  const ph = rng.float(0, 6.28), ph2 = rng.float(0, 6.28);
  const profile = o.profile || ((t) => { const wq = (t - 0.3) / 0.14; return mix(0.85, 1.0, Math.sin(t * 3.1 + ph) * 0.5 + 0.5) * (1 - 0.35 * Math.exp(-(wq * wq))) * (1 + crown * smoothstep(0.55, 0.85, t)) * (1 - 0.55 * smoothstep(0.88, 1.0, t)); });
  for (let i = 0; i < nb; i++) {
    const t = (i + 0.5) / nb, r = W * profile(t);
    const zig = o.zig ?? 0.6;
    const cx = Math.sin(t * 4.1 + ph) * sway * W + (i % 2 ? 1 : -1) * rng.float(0.05, 0.3) * W * zig, cz = Math.cos(t * 3.3 + ph2) * sway * W + rng.float(-0.25, 0.25) * W * zig;
    const ryy = o.stack ? (H / nb) * rng.float(0.8, 1.25) : r * rng.float(0.85, 1.5);
    blobs.push({ x: cx, y: t * H, z: cz, rx: r * rng.float(0.8, 1.15), ry: ryy, rz: r * rng.float(0.8, 1.15) });
    if (rng.chance(0.5 + crown * 0.3)) blobs.push({ x: cx + rng.sign() * r * rng.float(0.5, 0.95), y: t * H + rng.float(-0.05, 0.1) * H, z: cz + rng.sign() * r * rng.float(0.2, 0.8), rx: r * rng.float(0.45, 0.7), ry: r * rng.float(0.5, 0.9), rz: r * rng.float(0.45, 0.7) });
  }
  const holes = [];
  for (let i = 0; i < nh; i++) {
    const b = blobs[rng.int(0, blobs.length - 1)];
    const a = rng.float(0, Math.PI * 2), e = rng.float(-0.45, 0.45), L = W * (o.holeReach ?? 1.7);
    const dx = Math.cos(a) * Math.cos(e), dy = Math.sin(e), dz = Math.sin(a) * Math.cos(e);
    holes.push({ ax: b.x - dx * L + rng.float(-0.1, 0.1) * W, ay: b.y - dy * L, az: b.z - dz * L, bx: b.x + dx * L, by: b.y + dy * L, bz: b.z + dz * L, r: W * (o.holeR ?? 1) * rng.float(0.09, 0.2) * (0.6 + 0.4 * (1 - Math.abs(b.y / H - 0.5))) });
  }
  const scoops = [];
  for (let i = 0; i < ns; i++) {                       // 窝: round pockets bitten into the surface
    const b = blobs[rng.int(0, blobs.length - 1)], a = rng.float(0, Math.PI * 2), e = rng.float(-0.5, 0.5), rr = W * rng.float(0.16, 0.36);
    scoops.push({ x: b.x + Math.cos(a) * Math.cos(e) * b.rx * 0.95, y: b.y + Math.sin(e) * b.ry * 0.9, z: b.z + Math.sin(a) * Math.cos(e) * b.rz * 0.95, r: rr });
  }
  const k = o.smooth ?? W * 0.28, off = rng.float(0, 100);
  const reach = blobs.map((b) => Math.max(b.rx, b.ry, b.rz) + k * 2.5);
  const sc = 1 / Math.max(0.2, W), wrp = warp * W;
  const base = (x, y, z) => {
    if (wrp > 0) { x += wrp * snoise3(x * sc * 0.8 + off, y * sc * 0.8, z * sc * 0.8); z += wrp * snoise3(x * sc * 0.8 + off + 41, y * sc * 0.8 + 7, z * sc * 0.8); }
    let f = 1e9;
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i], dx = x - b.x, dy = y - b.y, dz = z - b.z;
      if (Math.abs(dx) > reach[i] + 4 * W || Math.abs(dy) > reach[i] + 4 * W || Math.abs(dz) > reach[i] + 4 * W) continue;
      const q = Math.hypot(dx / b.rx, dy / b.ry, dz / b.rz);
      f = smin(f, (q - 1) * Math.min(b.rx, b.ry, b.rz), k);
    }
    for (let i = 0; i < scoops.length; i++) { const c = scoops[i]; f = smax(f, -(Math.hypot(x - c.x, y - c.y, z - c.z) - c.r), W * 0.09); }
    for (let i = 0; i < holes.length; i++) { const h = holes[i]; f = smax(f, -capsuleSdf(x, y, z, h.ax, h.ay, h.az, h.bx, h.by, h.bz, h.r), W * 0.07); }
    return smax(f, -y, W * 0.04);          // flat base at y = 0
  };
  const f = (x, y, z) => {
    const b = base(x, y, z);
    if (Math.abs(b) > wr * W * 2.6 + 0.02) return b;
    const n1 = fbm3(x * sc * 1.9 + off, y * sc * 1.9, z * sc * 1.9, 3), n2 = 1 - Math.abs(snoise3(x * sc * 3.3 + off + 9, y * sc * 3.3, z * sc * 3.3));
    const n3 = 1 - Math.abs(snoise3(x * sc * 7.1 + off + 5, y * sc * 4.0, z * sc * 7.1));       // fine vertical-ish creases
    return b + W * wr * (0.7 * n1 + 0.55 * (n2 - 0.6) + 0.25 * (n3 - 0.6));
  };
  return { f, W, H, bound: [W * 2.6, H + W * 0.5, W * 2.6], blobs };
}

/** 湖石 piece with holes, built by surface nets. res = lattice cells across the width. */
export function porousStone(seed, o = {}, cellDiv = 24) {
  const T = porousField(seed, o);
  const W = T.W, b = T.bound;
  const cell = (W * 2) / cellDiv;
  const sn = surfaceNets(T.f, [-b[0] * 0.9, -cell * 0.5, -b[2] * 0.9], [b[0] * 0.9, b[1], b[2] * 0.9], cell, { aoStrength: 0.8 });
  const aux = new Float32Array(sn.vertexCount * 2);
  const g = { pos: Array.from(sn.pos), nor: Array.from(sn.nor), aux: Array.from(aux), idx: Array.from(sn.idx) };
  for (let i = 0; i < sn.vertexCount; i++) g.aux[i * 2] = clamp(sn.ao[i] * (0.75 + 0.25 * smoothstep(0, W * 0.4, sn.pos[i * 3 + 1])), 0.2, 1);
  return finish(g, { widthNorm: !o.standing, heightNorm: !!o.standing });
}

