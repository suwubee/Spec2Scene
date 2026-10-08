// Author: suwubee
// engine/geo.js — procedural geometry helpers with micro-bevels, metric UVs and realism cues.
//
// Conventions (shared with materials.js / procTex.js):
//   * UVs are in METRES (u,v = distance on the surface), so every procTex texture has its true physical scale.
//     Exceptions are documented per function (petal: 0..1 over the petal; strings: v = 0..1 around the circumference).
//   * attribute `mvEdge` (float): 1 on an edge ridge -> 0 at >= 5 cm from it (bevelBox, lattice, slats, tiles, lathe rims,
//     bamboo nodes). materials.js uses it for edge wear / node darkening. Missing attribute == 0 == "far from edges".
//   * Everything is deterministic: seeds go through noise.js makeRng / hash functions; no Math.random.
//   * Deformation (cloth wind, string vibration) is a closed-form function of t: CPU functions + identical GLSL chunks.
import * as THREE from './vendor/three.module.js';
import { mergeGeometries } from './vendor/BufferGeometryUtils.js';
import { makeRng, gnoise1, gnoise2, hashString } from './noise.js';

const TAU = Math.PI * 2;
const EDGE_RANGE = 0.05; // metres encoded by mvEdge (1 -> 0)
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const edgeAttr = (dist) => 1 - clamp(dist / EDGE_RANGE, 0, 1);

/** Build a BufferGeometry from plain arrays. */
function build({ pos, nrm, uv, edge, idx, extra }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (nrm) g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (edge) g.setAttribute('mvEdge', new THREE.Float32BufferAttribute(edge, 1));
  if (extra) for (const k of Object.keys(extra)) g.setAttribute(k, new THREE.Float32BufferAttribute(extra[k].array, extra[k].size));
  if (idx) g.setIndex(idx);
  if (!nrm) g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
/** Merge geometries, dropping attributes that are not common to all (keeps position/normal/uv/mvEdge). */
export function merge(geos) {
  const want = ['position', 'normal', 'uv', 'mvEdge'];
  const list = geos.map((g) => {
    const h = g.index ? g : g; // keep indexed
    for (const k of Object.keys(h.attributes)) if (!want.includes(k)) h.deleteAttribute(k);
    if (!h.attributes.mvEdge) h.setAttribute('mvEdge', new THREE.Float32BufferAttribute(new Float32Array(h.attributes.position.count), 1));
    if (!h.attributes.uv) h.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(h.attributes.position.count * 2), 2));
    return h;
  });
  const allIndexed = list.every((g) => g.index), noneIndexed = list.every((g) => !g.index);
  const fixed = allIndexed || noneIndexed ? list : list.map((g) => (g.index ? g.toNonIndexed() : g));
  const m = mergeGeometries(fixed, false);
  m.computeBoundingSphere();
  return m;
}

// ================================================================================================
// bevelBox — box with rounded micro-bevels (radius r, `segs` segments per 45°), metric UVs with a grain axis,
// wear-band vertex rows and the mvEdge attribute.
//   opts: { grain: 'x'|'y'|'z'|'auto' (default longest), wearBand: 0.02 (m), uvSeed: 0 (per-face UV offsets) }
// ================================================================================================
export function bevelBox(w, h, d, r = 0.002, segs = 2, opts = {}) {
  const half = [w / 2, h / 2, d / 2];
  r = Math.min(r, half[0] * 0.49, half[1] * 0.49, half[2] * 0.49);
  const inner = half.map((x) => x - r);
  const axes = ['x', 'y', 'z'];
  let grain = opts.grain || 'auto';
  if (grain === 'auto') grain = axes[[w, h, d].indexOf(Math.max(w, h, d))];
  const G = axes.indexOf(grain);
  const wear = opts.wearBand ?? 0.02;
  const rng = makeRng(hashString('bevelBox:' + (opts.uvSeed ?? 0)));
  const pos = [], nrm = [], uv = [], edge = [], idx = [];
  // coordinate samples along an axis of half-extent A (face-plane coordinate)
  const samples = (A, ri) => {
    const s = new Set();
    const t = [];
    for (let k = segs; k >= 1; k--) t.push(-(ri + r * Math.tan((k / segs) * Math.PI / 4)));
    t.push(-ri);
    if (ri - wear > 0.002) { t.push(-(ri - wear)); t.push(ri - wear); }
    t.push(ri);
    for (let k = 1; k <= segs; k++) t.push(ri + r * Math.tan((k / segs) * Math.PI / 4));
    return t.filter((v) => { const key = v.toFixed(7); if (s.has(key)) return false; s.add(key); return true; });
  };
  const faces = [ // [normal axis, sign, a axis, b axis]  (a x b = n for CCW)
    [0, 1, 1, 2], [0, -1, 2, 1], [1, 1, 2, 0], [1, -1, 0, 2], [2, 1, 0, 1], [2, -1, 1, 0],
  ];
  faces.forEach(([n, sg, a, b], fi) => {
    const sa = samples(half[a], inner[a]), sb = samples(half[b], inner[b]);
    const base = pos.length / 3;
    // UV axes: v along the grain if it lies in this face, else (a,b)
    let ua = a, va = b;
    if (G === a) { ua = b; va = a; }
    const off = [rng() * 3.7, rng() * 5.3];
    for (let j = 0; j < sb.length; j++) {
      for (let i = 0; i < sa.length; i++) {
        const p = [0, 0, 0];
        p[n] = sg * half[n]; p[a] = sa[i]; p[b] = sb[j];
        const q = p.map((v, k) => clamp(v, -inner[k], inner[k]));
        let dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
        const L = Math.hypot(dx, dy, dz) || 1;
        dx /= L; dy /= L; dz /= L;
        const f = [q[0] + dx * r, q[1] + dy * r, q[2] + dz * r];
        pos.push(f[0], f[1], f[2]);
        nrm.push(dx, dy, dz);
        uv.push(f[ua] + off[0], f[va] + off[1]);
        const dist = Math.min(half[a] - Math.abs(sa[i]), half[b] - Math.abs(sb[j]));
        edge.push(edgeAttr(Math.max(0, dist)));
      }
    }
    const nA = sa.length;
    for (let j = 0; j < sb.length - 1; j++) {
      for (let i = 0; i < nA - 1; i++) {
        const i0 = base + j * nA + i, i1 = i0 + 1, i2 = i0 + nA, i3 = i2 + 1;
        idx.push(i0, i1, i3, i0, i3, i2);
      }
    }
  });
  return build({ pos, nrm, uv, edge, idx });
}

// ================================================================================================
// Lathe helpers (cups, vases, lantern caps). Profile = [[r, y], ...] from bottom centre upward.
// UV: u = phi * uvRadius (m), v = arc length along the profile (m). Attribute mvProfile = normalised arc length (0..1).
//   opts: { segments: 64, phiStart: 0, phiLength: 2π, uvRadius (default mean radius), wobble: 0 (fractional radius noise),
//           wobbleFreq: 3, seed, edges: [arcLengthFraction...] (mvEdge ridges, e.g. the rim) }
// ================================================================================================
export function lathe(profile, opts = {}) {
  const pts = profile.map((p) => (Array.isArray(p) ? { r: p[0], y: p[1] } : { r: p.x ?? p.r, y: p.y }));
  const segs = opts.segments ?? 64;
  const phi0 = opts.phiStart ?? 0, phiL = opts.phiLength ?? TAU;
  const closed = Math.abs(phiL - TAU) < 1e-6;
  const n = pts.length;
  // arc length + 2D normals (outward) per profile point
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(pts[i].r - pts[i - 1].r, pts[i].y - pts[i - 1].y));
  const total = s[n - 1] || 1;
  const nrm2 = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tr = b.r - a.r, ty = b.y - a.y; const l = Math.hypot(tr, ty) || 1; tr /= l; ty /= l;
    return [ty, -tr]; // rotate tangent -90° -> outward for a bottom-to-top outer profile
  });
  let uvR = opts.uvRadius ?? pts.reduce((m, p) => m + p.r, 0) / n;
  // make the circumference an integer number of texture periods so closed lathes have no texture seam
  const uvP = opts.uvPeriod ?? 0.12;
  if (closed && uvP > 0) uvR = Math.max(1, Math.round((TAU * uvR) / uvP)) * uvP / TAU;
  const wob = opts.wobble ?? 0, wf = opts.wobbleFreq ?? 3;
  const seedN = (hashString('lathe:' + (opts.seed ?? 0)) % 1000) * 0.713;
  const edges = opts.edges || [];
  const pos = [], nrmA = [], uv = [], edge = [], prof = [], idx = [];
  const cols = closed ? segs + 1 : segs + 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= segs; j++) {
      const phi = phi0 + (j / segs) * phiL;
      const c = Math.cos(phi), sn = Math.sin(phi);
      // wobble: smooth periodic in phi (use integer frequencies so the seam matches)
      const wv = wob ? wob * (0.6 * Math.sin(wf * phi + seedN + pts[i].y * 9.1) + 0.4 * Math.sin((wf + 2) * phi + seedN * 2.3 + pts[i].y * 17.3)) : 0;
      const r = pts[i].r * (1 + wv);
      pos.push(r * sn, pts[i].y, r * c);
      nrmA.push(nrm2[i][0] * sn, nrm2[i][1], nrm2[i][0] * c);
      uv.push(phi * uvR, s[i]);
      prof.push(s[i] / total);
      let ed = 1e9; for (const e of edges) ed = Math.min(ed, Math.abs(s[i] - e * total));
      edge.push(edges.length ? edgeAttr(ed) : 0);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = build({ pos, nrm: nrmA, uv, edge, idx, extra: { mvProfile: { array: prof, size: 1 } } });
  if (wob) g.computeVertexNormals();
  if (closed) { // weld the seam normals (vertex j=0 and j=segs share a position)
    const N = g.attributes.normal;
    for (let i = 0; i < n; i++) {
      const a = i * cols, b = i * cols + segs;
      const x = N.getX(a) + N.getX(b), y = N.getY(a) + N.getY(b), z = N.getZ(a) + N.getZ(b), l = Math.hypot(x, y, z) || 1;
      N.setXYZ(a, x / l, y / l, z / l); N.setXYZ(b, x / l, y / l, z / l);
    }
  }
  return g;
}

/** Offset an outer profile inward to make a thick-walled vessel: outer (bottom->rim) + rounded lip + inner (rim->floor). */
export function thickenProfile(outer, thickness = 0.003, { lipSegs = 6, floorThickness } = {}) {
  const pts = outer.map((p) => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]));
  const n = pts.length;
  const nrmAt = (i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tr = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tr, ty) || 1;
    return [ty / l, -tr / l];
  };
  const inner = [];
  for (let i = n - 1; i >= 0; i--) {
    const [nr, ny] = nrmAt(i);
    inner.push([Math.max(0, pts[i][0] - nr * thickness), pts[i][1] - ny * thickness]);
  }
  const floorY = pts[0][1] + (floorThickness ?? thickness * 1.5);
  // drop inner points below the floor, then close at the centre
  const innerKept = inner.filter((p) => p[1] > floorY + 1e-4);
  innerKept.push([Math.max(0, (innerKept.length ? innerKept[innerKept.length - 1][0] : 0) * 0.6), floorY]);
  innerKept.push([0, floorY]);
  // lip: half circle from the outer rim to the inner rim
  const rimO = pts[n - 1], rimI = inner[0];
  const cx = (rimO[0] + rimI[0]) / 2, cy = (rimO[1] + rimI[1]) / 2, rad = Math.hypot(rimO[0] - rimI[0], rimO[1] - rimI[1]) / 2;
  const a0 = Math.atan2(rimO[1] - cy, rimO[0] - cx);
  const lip = [];
  for (let k = 1; k < lipSegs; k++) { const a = a0 + (k / lipSegs) * Math.PI; lip.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]); }
  return [...pts, ...lip, ...innerKept];
}

/** Tea bowl (盏) outer profile. Defaults: Ø0.07 × H0.045 (WORLD_AND_ASSETS §5). */
export function cupProfile({ radius = 0.035, height = 0.045, footR = 0.016, footH = 0.006, flare = 0.25, n = 24 } = {}) {
  const pts = [[0, 0.0012], [footR - 0.0025, 0.0012], [footR - 0.002, 0], [footR, 0], [footR + 0.0008, footH * 0.6], [footR + 0.0006, footH]];
  // body: quadratic from foot shoulder to rim with slight eversion near the rim
  const p0 = [footR + 0.0006, footH], p1 = [radius * (0.95 + flare * 0.1), footH + height * 0.18], p2 = [radius, height];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const r = (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0];
    const y = (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1];
    pts.push([r + (t > 0.9 ? (t - 0.9) * 0.01 * flare : 0), y]);
  }
  return pts;
}
/** Meiping (梅瓶, prunus vase) outer profile: small mouth, broad shoulder, tapering body. Default H 0.28 m. */
export function vaseProfile({ height = 0.28, foot = 0.046, belly = 0.086, neck = 0.021, mouth = 0.027, n = 40 } = {}) {
  const H = height;
  const key = [[0, 0.002], [foot - 0.004, 0.002], [foot - 0.002, 0], [foot, 0.001], [foot * 1.02, H * 0.05], [belly * 0.72, H * 0.3], [belly * 0.93, H * 0.52],
    [belly, H * 0.66], [belly * 0.93, H * 0.76], [belly * 0.6, H * 0.85], [neck * 1.25, H * 0.9], [neck, H * 0.935], [neck * 1.02, H * 0.965], [mouth, H * 0.98], [mouth * 0.98, H]];
  // Catmull-Rom resample for smoothness
  const out = [];
  for (let i = 0; i < key.length - 1; i++) {
    const p0 = key[Math.max(0, i - 1)], p1 = key[i], p2 = key[i + 1], p3 = key[Math.min(key.length - 1, i + 2)];
    const m = i < 4 ? 1 : Math.max(2, Math.round(n / key.length));
    for (let k = 0; k < m; k++) {
      const t = k / m, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(key[key.length - 1]);
  return out;
}
/** Lantern cap profile (dark wood disc with rounded rim). */
export function lanternCapProfile({ radius = 0.12, height = 0.03, rim = 0.006, hole = 0.02 } = {}) {
  const pts = [[hole, height]];
  pts.push([hole, height * 0.4]);
  const n = 8;
  for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + (i / n) * Math.PI; pts.push([radius - rim + rim * Math.cos(a), height * 0.5 + rim * Math.sin(a) * 1.2]); }
  pts.push([hole * 1.6, height * 1.02]);
  return pts;
}

// ================================================================================================
// tubeAlongCurve — tube with per-position radius, metric UVs, optional caps.
//   curve: THREE.Curve (3D). radius: number | (t)=>number. UV: u = around (m), v = along the curve (m) (grain along v).
//   opts: { tubular: 64, radial: 12, closed:false, caps:true, vNormalized:false (u = 0..1 around instead of metres), uvOffset:[u,v] }
// ================================================================================================
export function tubeAlongCurve(curve, radius = 0.01, opts = {}) {
  const tub = opts.tubular ?? 64, rad = opts.radial ?? 12;
  const rf = typeof radius === 'function' ? radius : () => radius;
  const frames = curve.computeFrenetFrames(tub, !!opts.closed);
  const len = curve.getLength();
  const pos = [], nrm = [], uv = [], edge = [], idx = [];
  const P = new THREE.Vector3();
  const off = opts.uvOffset || [0, 0];
  for (let i = 0; i <= tub; i++) {
    const t = i / tub;
    curve.getPointAt(t, P);
    const N = frames.normals[i], B = frames.binormals[i];
    const r = rf(t);
    for (let j = 0; j <= rad; j++) {
      const v = (j / rad) * TAU;
      const c = -Math.cos(v), s = Math.sin(v);
      const nx = c * N.x + s * B.x, ny = c * N.y + s * B.y, nz = c * N.z + s * B.z;
      pos.push(P.x + r * nx, P.y + r * ny, P.z + r * nz);
      nrm.push(nx, ny, nz);
      uv.push((opts.vNormalized ? j / rad : (j / rad) * TAU * r) + off[0], t * len + off[1]);
      edge.push(opts.caps === false ? 0 : edgeAttr(Math.min(t, 1 - t) * len));
    }
  }
  for (let i = 0; i < tub; i++) for (let j = 0; j < rad; j++) {
    const a = i * (rad + 1) + j, b = (i + 1) * (rad + 1) + j;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  if (opts.caps !== false && !opts.closed) {
    for (const end of [0, 1]) {
      const t = end, i = end ? tub : 0;
      curve.getPointAt(t, P);
      const T = curve.getTangentAt(t).clone().multiplyScalar(end ? 1 : -1);
      const N = frames.normals[i], B = frames.binormals[i];
      const r = rf(t);
      const c0 = pos.length / 3;
      pos.push(P.x, P.y, P.z); nrm.push(T.x, T.y, T.z); uv.push(off[0], off[1] + t * len); edge.push(0.6);
      for (let j = 0; j <= rad; j++) {
        const v = (j / rad) * TAU, c = -Math.cos(v), s = Math.sin(v);
        pos.push(P.x + r * (c * N.x + s * B.x), P.y + r * (c * N.y + s * B.y), P.z + r * (c * N.z + s * B.z));
        nrm.push(T.x, T.y, T.z); uv.push(off[0] + c * r, off[1] + t * len + s * r); edge.push(1);
      }
      for (let j = 0; j < rad; j++) end ? idx.push(c0, c0 + 2 + j, c0 + 1 + j) : idx.push(c0, c0 + 1 + j, c0 + 2 + j);
    }
  }
  return build({ pos, nrm, uv, edge, idx });
}

// ================================================================================================
// bambooRod — culm along +y with node ridges, taper, gentle bend. mvEdge = node proximity (materials darken nodes).
//   opts: { length:1.2, radius:0.015, nodeSpacing:0.3, nodeJitter:0.15, taper:0.12, bend:0.01, seed:1, radial:16, perMeter:70,
//           hollow:true, wall:0.0025 }
// ================================================================================================
export function bambooRod(opts = {}) {
  const L = opts.length ?? 1.2, R0 = opts.radius ?? 0.015, sp = opts.nodeSpacing ?? 0.3;
  const rng = makeRng(hashString('bamboo:' + (opts.seed ?? 1)));
  const nodes = [];
  for (let s = sp * (0.35 + 0.4 * rng()); s < L - 0.02; s += sp * (1 + (opts.nodeJitter ?? 0.15) * (rng() * 2 - 1))) nodes.push(s);
  // sample positions: uniform + dense around nodes
  const ss = new Set();
  const perM = opts.perMeter ?? 70;
  for (let i = 0; i <= Math.ceil(L * perM); i++) ss.add(+(i / Math.ceil(L * perM) * L).toFixed(6));
  for (const nd of nodes) for (const d of [-0.012, -0.006, -0.003, -0.0015, 0, 0.0015, 0.003, 0.006, 0.012]) if (nd + d > 0 && nd + d < L) ss.add(+(nd + d).toFixed(6));
  const S = [...ss].sort((a, b) => a - b);
  const taper = opts.taper ?? 0.12, bend = opts.bend ?? 0.01, ph = rng() * TAU;
  const radAt = (s) => {
    let r = R0 * (1 - taper * s / L);
    for (const nd of nodes) {
      const d = s - nd;
      r *= 1 + 0.055 * Math.exp(-((d / 0.0025) ** 2)) + 0.025 * Math.exp(-(((d - 0.004) / 0.006) ** 2)) - 0.015 * Math.exp(-(((d + 0.01) / 0.01) ** 2));
    }
    return r;
  };
  const axis = (s) => [bend * Math.sin(Math.PI * s / L + ph) * Math.sin(ph), s, bend * Math.sin(Math.PI * s / L) * Math.cos(ph)];
  const nodeDist = (s) => nodes.reduce((m, nd) => Math.min(m, Math.abs(s - nd)), 1e9);
  const radial = opts.radial ?? 16;
  const pos = [], uv = [], edge = [], idx = [];
  for (let i = 0; i < S.length; i++) {
    const s = S[i], r = radAt(s), a = axis(s);
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * TAU;
      pos.push(a[0] + r * Math.sin(v), a[1], a[2] + r * Math.cos(v));
      uv.push(v * R0, s);
      edge.push(edgeAttr(nodeDist(s) * 5));
    }
  }
  for (let i = 0; i < S.length - 1; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = build({ pos, uv, edge, idx });
  const parts = [g];
  if (opts.hollow !== false) {
    const wall = opts.wall ?? 0.0025;
    for (const end of [0, 1]) {
      const s = end ? L : 0, r = radAt(s), a = axis(s), ri = Math.max(0.001, r - wall);
      const cap = new THREE.RingGeometry(ri, r, radial, 1);
      cap.rotateX(end ? -Math.PI / 2 : Math.PI / 2);
      cap.translate(a[0], a[1], a[2]);
      const e = new Float32Array(cap.attributes.position.count).fill(1);
      cap.setAttribute('mvEdge', new THREE.BufferAttribute(e, 1));
      parts.push(cap);
    }
  }
  const out = merge(parts);
  out.userData.nodes = nodes;
  return out;
}

// ================================================================================================
// Roof: curved (concave) slope with eave corner lift, tile instancing, ridge.
// roofSurface(opts) -> { at(s,t) -> {p, ds, dt, n}, length, opts }   s∈[0,1] across (x), t∈[0,1] eave(0) -> ridge(1)
//   opts: { width:6, depth:3 (horizontal run), rise:1.6, concavity:0.35, eaveLift:0.18, eaveOut:0.12, liftPower:3 }
// Local frame: x across, y up, +z toward the eave (downhill).
// ================================================================================================
export function roofSurface(opts = {}) {
  const o = { width: 6, depth: 3, rise: 1.6, concavity: 0.35, eaveLift: 0.18, eaveOut: 0.12, liftPower: 3, ...opts };
  const P = (s, t) => {
    const e = Math.pow(Math.abs(2 * s - 1), o.liftPower), u = (1 - t) * (1 - t);
    return new THREE.Vector3((s - 0.5) * o.width * (1 + 0.02 * e * u), o.rise * ((1 - o.concavity) * t + o.concavity * t * t) + o.eaveLift * e * u, o.depth * (1 - t) + o.eaveOut * e * u);
  };
  const at = (s, t) => {
    const p = P(s, t), h = 1e-4;
    const ds = P(Math.min(1, s + h), t).sub(P(Math.max(0, s - h), t)).normalize();
    const dt = P(s, Math.min(1, t + h)).sub(P(s, Math.max(0, t - h))).normalize();
    const n = new THREE.Vector3().crossVectors(dt, ds).normalize();
    if (n.y < 0) n.negate();
    return { p, ds, dt, n };
  };
  // arc length along t at s=0.5 (for row spacing)
  const N = 200, arc = [0];
  for (let i = 1; i <= N; i++) arc.push(arc[i - 1] + P(0.5, i / N).distanceTo(P(0.5, (i - 1) / N)));
  const tAtArc = (a) => { let i = 1; while (i < N && arc[i] < a) i++; const f = (a - arc[i - 1]) / Math.max(1e-9, arc[i] - arc[i - 1]); return (i - 1 + f) / N; };
  return { at, P, length: arc[N], tAtArc, opts: o };
}
/** Surface mesh of a roof slope (for the flat 'roofTile' texture at distance). Metric UVs (u across, v up-slope). */
export function roofMesh(surface, segS = 48, segT = 24) {
  const pos = [], uv = [], idx = [];
  const W = surface.opts.width;
  for (let j = 0; j <= segT; j++) {
    const t = j / segT;
    for (let i = 0; i <= segS; i++) {
      const s = i / segS, p = surface.P(s, t);
      pos.push(p.x, p.y, p.z);
      uv.push(s * W, surface.length * t);
    }
  }
  for (let j = 0; j < segT; j++) for (let i = 0; i < segS; i++) {
    const a = j * (segS + 1) + i, b = a + segS + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  return build({ pos, uv, idx });
}
/** One curved clay tile (cylinder-shell section), lying along +z (length), concave side +y. Metric UVs, mvEdge. */
export function curvedTile({ width = 0.2, length = 0.2, thickness = 0.011, sagitta = 0.032, taper = 0.9, arcSegs = 10, lenSegs = 3 } = {}) {
  const pos = [], uv = [], edge = [], idx = [];
  const Rw = (width * width / 4 + sagitta * sagitta) / (2 * sagitta);
  const half = Math.asin(width / 2 / Rw);
  const ring = (layer) => { // layer 0 top(concave) surface, 1 bottom
    const base = pos.length / 3;
    for (let k = 0; k <= lenSegs; k++) {
      const z = (k / lenSegs - 0.5) * length;
      const sc = 1 + (taper - 1) * (k / lenSegs);
      for (let i = 0; i <= arcSegs; i++) {
        const a = (-1 + 2 * i / arcSegs) * half;
        const R = Rw + (layer ? thickness : 0);
        const x = Math.sin(a) * R * sc, y = (Rw - Math.cos(a) * R) * sc + (layer ? 0 : 0);
        pos.push(x, y - (layer ? 0 : 0), z);
        uv.push(a * Rw, z + length / 2);
        const de = Math.min((half - Math.abs(a)) * Rw, length / 2 - Math.abs(z));
        edge.push(edgeAttr(de));
      }
    }
    for (let k = 0; k < lenSegs; k++) for (let i = 0; i < arcSegs; i++) {
      const a = base + k * (arcSegs + 1) + i, b = a + arcSegs + 1;
      layer ? idx.push(a, a + 1, b, a + 1, b + 1, b) : idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    return base;
  };
  const top = ring(0), bot = ring(1);
  const C = arcSegs + 1;
  // side walls: along the long edges (i=0, i=arcSegs) and the short ends (k=0, k=lenSegs)
  for (let k = 0; k < lenSegs; k++) {
    for (const i of [0, arcSegs]) {
      const a = top + k * C + i, b = top + (k + 1) * C + i, c = bot + k * C + i, d = bot + (k + 1) * C + i;
      i === 0 ? idx.push(a, c, b, b, c, d) : idx.push(a, b, c, b, d, c);
    }
  }
  for (const k of [0, lenSegs]) for (let i = 0; i < arcSegs; i++) {
    const a = top + k * C + i, b = a + 1, c = bot + k * C + i, d = c + 1;
    k === 0 ? idx.push(a, b, c, b, d, c) : idx.push(a, c, b, b, c, d);
  }
  const g = build({ pos, uv, edge, idx });
  g.computeVertexNormals();
  return g;
}
/**
 * instancedTiles(opts, material) -> THREE.InstancedMesh of channel (concave) + cover (convex) tiles on a roof surface.
 *   opts: { surface (roofSurface) | roof opts, pitch:0.21 (channel spacing), exposed:0.075 (row step along the slope),
 *           tile:{width,length,thickness,sagitta}, jitter:{rot:0.025 rad, pos:0.003}, seed:1, margin:0.03 }
 * Per-instance colour variation is automatic (materials.js hashes the instance position); instanceColor holds a
 * per-tile wear/value factor you may also use.
 */
export function instancedTiles(opts = {}, material = null) {
  const surf = opts.surface || roofSurface(opts.roof || {});
  const pitch = opts.pitch ?? 0.21, step = opts.exposed ?? 0.075;
  const tileOpt = { width: 0.2, length: 0.2, thickness: 0.011, sagitta: 0.032, ...(opts.tile || {}) };
  const geo = curvedTile(tileOpt);
  const rng = makeRng(hashString('tiles:' + (opts.seed ?? 1)));
  const jr = opts.jitter?.rot ?? 0.025, jp = opts.jitter?.pos ?? 0.003;
  const W = surf.opts.width, margin = opts.margin ?? 0.03;
  const cols = Math.floor((W - 2 * margin) / pitch);
  const rows = Math.floor((surf.length - tileOpt.length * 0.5) / step);
  const mats = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(1, 1, 1);
  const basis = new THREE.Matrix4();
  for (let r = 0; r < rows; r++) {
    const t = surf.tAtArc(r * step + tileOpt.length * 0.45);
    for (let c = 0; c < cols * 2 - 1; c++) {
      const cover = c % 2 === 1;
      const x = margin + pitch * 0.5 + (c * pitch) / 2;
      const s = x / W;
      const { p, ds, dt, n } = surf.at(s, t);
      // tile frame: X across (ds), Y normal, Z downhill (-dt)
      const X = ds.clone(), Y = n.clone();
      const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
      basis.makeBasis(X, Y, Z);
      q.setFromRotationMatrix(basis);
      // lie on the tile below: tilt up at the lower end
      e.set(-Math.atan2(tileOpt.thickness * 1.2, step * 2.2) + (rng() - 0.5) * jr, (rng() - 0.5) * jr, (cover ? Math.PI : 0) + (rng() - 0.5) * jr);
      const qq = new THREE.Quaternion().setFromEuler(e);
      const qt = q.clone().multiply(qq);
      const lift = cover ? tileOpt.sagitta + tileOpt.thickness * 1.5 : 0;
      const pp = p.clone().addScaledVector(Y, lift + tileOpt.thickness * 0.5).addScaledVector(X, (rng() - 0.5) * jp).addScaledVector(Z, (rng() - 0.5) * jp);
      sc.set(1 + (rng() - 0.5) * 0.03, 1, 1 + (rng() - 0.5) * 0.04);
      m.compose(pp, qt, sc);
      mats.push(m.clone());
    }
  }
  const mesh = new THREE.InstancedMesh(geo, material || new THREE.MeshStandardMaterial({ color: 0x4b5257 }), mats.length);
  const col = new THREE.Color();
  mats.forEach((mm, i) => { mesh.setMatrixAt(i, mm); const v = 0.85 + 0.3 * rng(); mesh.setColorAt(i, col.setRGB(v, v, v)); });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.userData.rows = rows; mesh.userData.cols = cols;
  return mesh;
}
/** Ridge: rounded bar along x on top of the slope pair, ends curling up (纹头脊-ish). */
export function ridgeGeometry({ length = 6.2, height = 0.14, width = 0.12, curl = 0.25, segs = 64 } = {}) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, x = (t - 0.5) * length;
    const e = Math.pow(Math.abs(2 * t - 1), 6);
    pts.push(new THREE.Vector3(x, e * curl, 0));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = tubeAlongCurve(curve, (t) => (width / 2) * (1 - 0.3 * Math.pow(Math.abs(2 * t - 1), 8)), { tubular: segs * 2, radial: 16 });
  g.scale(1, height / width, 1);
  return g;
}

// ================================================================================================
// Bamboo blind (竹帘, 半卷): slats 5 mm × 3 mm with 1.5 mm gaps; the upper part is rolled into a spiral whose size
// follows the rolled fraction (world.blindRoll), so project cues can lower the blind by any amount.
// slatArray(opts) -> data { opts, n, pitch, slatGeometry, threadGeometry, rand } (static, build once)
//   opts: { width:1.4, length:1.6 (total blind length), slatW:0.005, slatT:0.003, gap:0.0015, rolled:0.45 (default roll),
//           rollSide:1 (+z = roll in front), coreRadius:0.012, ragged:0.004, seed:1, threadX:[..] (binding x positions) }
// blindGroup(data, {slat, thread, bar}) -> THREE.Group (InstancedMesh slats + InstancedMesh thread segments + top bar)
// updateBlind(group, t, world, {roll, sway, seed}) -> closed-form placement for roll = roll ?? world.blindRoll ?? opts.rolled,
//   pendulum sway of the flat part + per-slat flutter from world.wind. Cheap (CPU matrices), deterministic in (t, world).
// Local frame: top bar at y=0, blind hanging down -y in the plane z=0, facing +z. Roll sits just under the top bar.
// ================================================================================================
export function slatArray(opts = {}) {
  const o = { width: 1.4, length: 1.6, slatW: 0.005, slatT: 0.003, gap: 0.0015, rolled: 0.45, rollSide: 1, coreRadius: 0.012, ragged: 0.004, seed: 1, threadX: null, ...opts };
  const pitch = o.slatW + o.gap;
  const n = Math.floor(o.length / pitch);
  const rng = makeRng(hashString('blind:' + o.seed));
  const rand = Array.from({ length: n }, () => [rng(), rng(), rng(), rng(), rng(), rng()]);
  const slatGeometry = bevelBox(o.width, o.slatW, o.slatT, 0.0009, 1, { grain: 'x', wearBand: 0.0 });
  const threadX = o.threadX || [-o.width * 0.42, 0, o.width * 0.42];
  // one thread segment per slat (two twined strands, front + back arcs), in slat-local space
  const r = 0.0007, amp = o.slatT * 0.5 + r;
  const strands = [1, -1].map((sg) => new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -pitch / 2, 0), new THREE.Vector3(0.0003 * sg, -pitch / 4, amp * 0.8 * sg), new THREE.Vector3(0, 0, amp * sg),
    new THREE.Vector3(-0.0003 * sg, pitch / 4, amp * 0.8 * sg), new THREE.Vector3(0, pitch / 2, 0)]));
  const threadGeometry = merge(strands.map((c) => tubeAlongCurve(c, r, { tubular: 8, radial: 5, caps: false })));
  return { opts: o, n, pitch, slatGeometry, threadGeometry, threadX, rand };
}
/** Slat matrices for a rolled fraction (0 = fully down, 1 = fully rolled). Returns { mats, flatCount, rollCenter, rollRadius }. */
export function blindPlacement(data, rolled) {
  const o = data.opts, n = data.n, pitch = data.pitch;
  const tw = o.slatT + 0.0004;
  const nRoll = Math.round(n * clamp(rolled, 0, 0.98)), nFlat = n - nRoll;
  const Rout = Math.sqrt(o.coreRadius * o.coreRadius + (nRoll * pitch * tw) / Math.PI);
  const yc = -(Rout + 0.018), zc = -o.rollSide * Rout;
  const mats = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  // slat k counts from the bottom edge (k=0 is the free lower edge) so a slat keeps its identity when the roll changes
  for (let k = 0; k < n; k++) {
    const R = data.rand[k];
    const i = nFlat - 1 - k; // index in the flat part measured from the roll downward
    if (i >= 0) {
      const y = yc - (i + 0.5) * pitch;
      const edge = k < 4 ? (4 - k) / 4 : 0; // ragged lower edge
      e.set((R[0] - 0.5) * 0.06, (R[1] - 0.5) * 0.003, (R[2] - 0.5) * 0.002 + edge * (R[3] - 0.5) * 0.012);
      q.setFromEuler(e);
      p.set((R[4] - 0.5) * 0.004 + (k === 0 ? (R[5] - 0.5) * o.ragged * 4 : 0), y + edge * (R[5] - 0.5) * o.ragged, (R[3] - 0.5) * 0.0006);
    } else {
      // rolled: arc length from the tangent point into the spiral
      const target = (-i - 0.5) * pitch;
      let phi = 0, arc = 0;
      while (arc < target) { const rr = Math.max(o.coreRadius, Rout - (tw * phi) / TAU); arc += rr * 0.004; phi += 0.004; }
      const rr = Math.max(o.coreRadius, Rout - (tw * phi) / TAU);
      e.set(-o.rollSide * phi + (R[0] - 0.5) * 0.02, 0, (R[2] - 0.5) * 0.002);
      q.setFromEuler(e);
      p.set((R[4] - 0.5) * 0.003, yc + rr * Math.sin(phi), zc + o.rollSide * rr * Math.cos(phi));
    }
    const sc = new THREE.Vector3(1, 1 + (R[1] - 0.5) * 0.16, 1 + (R[2] - 0.5) * 0.12);   // slat width/thickness tolerance
    mats.push(m.compose(p, q, sc).clone());
  }
  return { mats, flatCount: nFlat, rollCenter: [0, yc, zc], rollRadius: Rout };
}
/** Build the blind Group: InstancedMesh slats + InstancedMesh thread segments + top bar. materials: { slat, thread, bar } */
export function blindGroup(data, materials = {}) {
  const g = new THREE.Group();
  const def = new THREE.MeshStandardMaterial({ color: 0xb9a066 });
  const slats = new THREE.InstancedMesh(data.slatGeometry, materials.slat || def, data.n);
  slats.name = 'slats';
  const threads = new THREE.InstancedMesh(data.threadGeometry, materials.thread || new THREE.MeshStandardMaterial({ color: 0x3a2a1e }), data.n * data.threadX.length);
  threads.name = 'threads';
  const bar = new THREE.Mesh(bambooRod({ length: data.opts.width + 0.08, radius: 0.009, nodeSpacing: 0.35, seed: data.opts.seed, hollow: true }), materials.bar || def);
  bar.rotation.z = -Math.PI / 2; bar.position.set(-(data.opts.width + 0.08) / 2, -0.004, 0); bar.name = 'bar';
  g.add(slats, threads, bar);
  g.userData.blind = data;
  updateBlind(g, 0, null);
  return g;
}
/** Closed-form placement + sway (call per frame). */
export function updateBlind(group, t, world, { roll, sway = 1, seed = 3 } = {}) {
  const data = group.userData.blind;
  const slats = group.getObjectByName('slats'), threads = group.getObjectByName('threads');
  if (!data || !slats) return;
  const rolled = roll ?? (world && world.blindRoll !== undefined ? world.blindRoll : data.opts.rolled);
  const P = blindPlacement(data, rolled);
  const w = world ? world.wind : 0.25;
  const [, yc, zc] = P.rollCenter;
  const swing = sway * (0.012 * w + 0.002) * (0.6 * Math.sin(TAU * 0.23 * t + seed) + 0.4 * gnoise1(t * 0.7, seed));
  const m = new THREE.Matrix4(), r = new THREE.Matrix4(), tr = new THREE.Matrix4().makeTranslation(0, -yc, -zc), tb = new THREE.Matrix4().makeTranslation(0, yc, zc);
  const tx = new THREE.Matrix4(), mt = new THREE.Matrix4();
  const nT = data.threadX.length;
  for (let k = 0; k < data.n; k++) {
    let M = P.mats[k];
    const i = P.flatCount - 1 - k;
    if (i >= 0) {
      const d = (i + 0.5) * data.pitch;
      const flutter = sway * w * 0.004 * gnoise2(k * 0.37, t * 1.3 + seed) * Math.min(1, d / 0.5);
      r.makeRotationX(swing + flutter);
      M = m.multiplyMatrices(tb, r).multiply(tr).multiply(P.mats[k]);
    }
    slats.setMatrixAt(k, M);
    if (threads) for (let j = 0; j < nT; j++) { tx.makeTranslation(data.threadX[j], 0, 0); threads.setMatrixAt(k * nT + j, mt.multiplyMatrices(M, tx)); }
  }
  slats.instanceMatrix.needsUpdate = true;
  if (threads) threads.instanceMatrix.needsUpdate = true;
  slats.computeBoundingSphere(); if (threads) threads.computeBoundingSphere();
  group.userData.placement = P;
}
export const swayBlind = updateBlind;

// ================================================================================================
// latticeFrame(cols, rows, opts) — 井字格 window: frame + (cols-1) vertical + (rows-1) horizontal bars, bevelled,
// grain along every member. Default 5×6 cells, 1.4 × 1.5 m, frame 4.5 cm, bars 2.5 cm.
//   opts: { width:1.4, height:1.5, frameW:0.045, barW:0.025, depth:0.04, barDepth:0.028, bevel:0.004, barBevel:0.0025, seed:1 }
// Frame lies in the xy plane centred at the origin, facing +z.
// ================================================================================================
export function latticeFrame(cols = 5, rows = 6, opts = {}) {
  const o = { width: 1.4, height: 1.5, frameW: 0.045, barW: 0.025, depth: 0.04, barDepth: 0.028, bevel: 0.004, barBevel: 0.0025, seed: 1, ...opts };
  const parts = [];
  let k = 0;
  const add = (w, h, d, x, y, r, grain) => { const g = bevelBox(w, h, d, r, 2, { grain, uvSeed: o.seed * 100 + k++ }); g.translate(x, y, 0); parts.push(g); };
  const W = o.width, H = o.height, F = o.frameW;
  add(W, F, o.depth, 0, H / 2 - F / 2, o.bevel, 'x');
  add(W, F, o.depth, 0, -H / 2 + F / 2, o.bevel, 'x');
  add(F, H - 2 * F, o.depth, -W / 2 + F / 2, 0, o.bevel, 'y');
  add(F, H - 2 * F, o.depth, W / 2 - F / 2, 0, o.bevel, 'y');
  const iw = W - 2 * F, ih = H - 2 * F;
  for (let i = 1; i < cols; i++) add(o.barW, ih + 0.004, o.barDepth, -iw / 2 + (i * iw) / cols, 0, o.barBevel, 'y');
  for (let j = 1; j < rows; j++) add(iw + 0.004, o.barW, o.barDepth * 0.96, 0, -ih / 2 + (j * ih) / rows, o.barBevel, 'x');
  return merge(parts);
}

// ================================================================================================
// Cloth (gauze curtain): clothPlane + closed-form wind deformation (CPU + identical GLSL chunk).
// clothPlane(w, h, segs, opts): hangs from y=0 down to y=-h in the xy plane, facing +z, with rest folds.
//   Attribute mvCloth = (a across 0..1, b down 0..1). opts: { folds:6, foldDepth:0.025, seed:1, segsY }
// ================================================================================================
export function clothPlane(w = 1.5, h = 1.5, segs = 48, opts = {}) {
  const sx = segs, sy = opts.segsY ?? Math.max(8, Math.round(segs * h / w));
  const nF = opts.folds ?? 6, fd = opts.foldDepth ?? 0.025;
  const rng = makeRng(hashString('cloth:' + (opts.seed ?? 1)));
  const fk = [], fp = [], fa = [];
  for (let i = 0; i < 4; i++) { fk.push(nF * (0.6 + 0.5 * i) + rng()); fp.push(rng() * TAU); fa.push(1 / (1 + i * 0.8)); }
  const pos = [], uv = [], cl = [], idx = [];
  for (let j = 0; j <= sy; j++) {
    const b = j / sy;
    for (let i = 0; i <= sx; i++) {
      const a = i / sx, x = (a - 0.5) * w, y = -b * h;
      let z = 0;
      for (let k = 0; k < 4; k++) z += fa[k] * Math.sin(TAU * a * fk[k] / 2 + fp[k] + b * 0.6 * k);
      z *= fd * (0.8 + 0.3 * b) / 1.9;
      pos.push(x, y, z); uv.push(a * w, b * h); cl.push(a, b);
    }
  }
  for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) {
    const p = j * (sx + 1) + i, q2 = p + sx + 1;
    idx.push(p, q2, p + 1, p + 1, q2, q2 + 1);
  }
  const g = build({ pos, uv, idx, extra: { mvCloth: { array: cl, size: 2 } } });
  g.userData.cloth = { w, h, rest: Float32Array.from(pos) };
  return g;
}
/** Cloth displacement (object space) for rest point (x,y,z) with across/down params (a,b). Identical to GLSL mvClothDisp. */
export function clothDisp(a, b, t, P) {
  // P: { wind (0..1), dirN (wind component along +z normal), dirT (along +x), amp (m), freq (Hz), idle (m), h (m) }
  const wgt = Math.pow(b, 1.35);
  const f = P.freq;
  const ph1 = TAU * (f * t - 1.1 * b - 0.9 * a) + 1.3;
  const ph2 = TAU * (f * 2.3 * t - 2.3 * b + 1.7 * a) + 4.1;
  const ph3 = TAU * (f * 4.1 * t - 3.9 * b - 3.1 * a) + 2.2;
  const nn = 0.55 * Math.sin(ph1) + 0.3 * Math.sin(ph2) + 0.15 * Math.sin(ph3);
  const push = P.wind * P.amp * (0.62 + 0.38 * nn);
  const dz = wgt * (push * P.dirN + P.idle * nn);
  const dx = wgt * (P.wind * P.amp * 0.22 * Math.cos(ph2) + push * P.dirT * 0.5);
  const L = Math.max(b * P.h, 0.03);
  const dy = (dz * dz + dx * dx) / (2 * L);
  return [dx, dy, dz];
}
/** clothDeform(t, world, opts) -> (a, b) => [dx, dy, dz]: the closed-form displacement function at time t (CPU mirror of CLOTH_GLSL).
 *  opts as clothParams (+ object3D). */
export function clothDeform(t, world, opts = {}) {
  const P = clothParams(world, opts.object3D || null, opts);
  return (a, b) => clothDisp(a, b, t, P);
}
/** Wind params for a cloth object from the world state (object orientation taken into account). */
export function clothParams(world, object3D = null, { amp = 0.12, freq = 0.32, idle = 0.004, h = 1.5 } = {}) {
  const wd = new THREE.Vector3(...(world?.windDir || [0.9, 0, 0.12])).normalize();
  if (object3D) { const q = new THREE.Quaternion(); object3D.getWorldQuaternion(q); wd.applyQuaternion(q.invert()); }
  return { wind: world ? world.wind : 0.25, dirN: wd.z, dirT: wd.x, amp, freq, idle, h };
}
/** CPU deformation: rewrite positions/normals of a clothPlane geometry for time t (deterministic, no accumulation). */
export function deformCloth(geometry, t, P) {
  const cd = geometry.userData.cloth; const rest = cd.rest;
  const pa = geometry.attributes.position, cl = geometry.attributes.mvCloth;
  for (let i = 0; i < pa.count; i++) {
    const d = clothDisp(cl.getX(i), cl.getY(i), t, P);
    pa.setXYZ(i, rest[i * 3] + d[0], rest[i * 3 + 1] + d[1], rest[i * 3 + 2] + d[2]);
  }
  pa.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
}
/** GLSL: vertex deformation for cloth (used by materials.js when a material is given `cloth`). */
export const CLOTH_GLSL = /* glsl */ `
#ifdef MV_CLOTH
attribute vec2 mvCloth;
uniform float mvClothT;
uniform vec4 mvClothW;   // wind, dirN, dirT, idle
uniform vec4 mvClothP;   // amp, freq, h, width
vec3 mvClothDisp(float a, float b) {
  float wgt = pow(max(b, 0.0), 1.35);
  float f = mvClothP.y, t = mvClothT;
  float ph1 = 6.2831853 * (f * t - 1.1 * b - 0.9 * a) + 1.3;
  float ph2 = 6.2831853 * (f * 2.3 * t - 2.3 * b + 1.7 * a) + 4.1;
  float ph3 = 6.2831853 * (f * 4.1 * t - 3.9 * b - 3.1 * a) + 2.2;
  float nn = 0.55 * sin(ph1) + 0.3 * sin(ph2) + 0.15 * sin(ph3);
  float push = mvClothW.x * mvClothP.x * (0.62 + 0.38 * nn);
  float dz = wgt * (push * mvClothW.y + mvClothW.w * nn);
  float dx = wgt * (mvClothW.x * mvClothP.x * 0.22 * cos(ph2) + push * mvClothW.z * 0.5);
  float L = max(b * mvClothP.z, 0.03);
  return vec3(dx, (dz * dz + dx * dx) / (2.0 * L), dz);
}
void mvDeform(vec3 p, vec3 n, vec2 uvIn, out vec3 disp, out vec3 nOut) {
  disp = mvClothDisp(mvCloth.x, mvCloth.y);
  float ea = 0.01 / max(mvClothP.w, 0.01), eb = 0.01 / max(mvClothP.z, 0.01);
  vec3 dA = mvClothDisp(mvCloth.x + ea, mvCloth.y) - disp;
  vec3 dB = mvClothDisp(mvCloth.x, mvCloth.y + eb) - disp;
  // rest tangents: +x per unit a, -y per unit b (plus rest folds carried by n)
  vec3 tA = vec3(0.01, 0.0, 0.0) + dA, tB = vec3(0.0, -0.01, 0.0) + dB;
  vec3 nd = normalize(cross(tB, tA));
  vec3 n0 = normalize(cross(vec3(0.0, -0.01, 0.0), vec3(0.01, 0.0, 0.0)));
  nOut = normalize(n + (nd - n0));
}
#endif
`;

// ================================================================================================
// Plum petal & flower
// petalGeometry(seed, opts): cupped, veined (texture), irregular round petal. UV: u across (0..1), v base(0)->tip(1).
//   opts: { length:0.0135, width:0.0125, cup:0.35, curl:0.12, irregular:0.07, rings:7, segs:20 }
// Petal local frame: base at origin, length along +y, cupped toward +z (inner face).
// ================================================================================================
export function petalGeometry(seed = 1, opts = {}) {
  const o = { length: 0.0135, width: 0.013, cup: 0.3, curl: 0.1, irregular: 0.03, rings: 8, segs: 28, ...opts };
  const rng = makeRng(hashString('petal:' + seed));
  const L = o.length * (0.92 + 0.16 * rng()), W = o.width * (0.9 + 0.2 * rng());
  const cy = L * 0.5;
  const ph = [rng() * TAU, rng() * TAU, rng() * TAU];
  const Rt = (th) => {
    const c = Math.cos(th), s = Math.sin(th);
    const ry = s >= 0 ? L - cy : cy;
    let r = 1 / Math.sqrt((c / (W / 2)) ** 2 + (s / ry) ** 2);
    const d = Math.abs(th + Math.PI / 2), claw = Math.exp(-((d / 0.5) ** 2));
    r *= 1 - 0.12 * claw * (1 - claw) * 4;   // slight waist above the claw (obovate)
    r *= 1 + o.irregular * (0.5 * Math.sin(2 * th + ph[0]) + 0.3 * Math.sin(3 * th + ph[1]) + 0.2 * Math.sin(5 * th + ph[2])) * (1 - claw);
    return r;
  };
  const zOf = (x, y, rho, th) => o.cup * L * 0.45 * (x / (W / 2)) ** 2 + o.curl * L * (y / L) ** 2 + 0.012 * L * Math.sin(3 * th + ph[1]) * rho ** 3;
  const pos = [], uv = [], idx = [];
  pos.push(0, cy, zOf(0, cy, 0, 0)); uv.push(0.5, cy / L);
  for (let i = 1; i <= o.rings; i++) {
    const rho = i / o.rings;
    for (let j = 0; j < o.segs; j++) {
      const th = (j / o.segs) * TAU - Math.PI / 2;
      const r = Rt(th) * rho;
      const x = Math.cos(th) * r, y = cy + Math.sin(th) * r;
      pos.push(x, y, zOf(x, y, rho, th)); uv.push(0.5 + x / W, y / L);
    }
  }
  for (let j = 0; j < o.segs; j++) idx.push(0, 1 + j, 1 + ((j + 1) % o.segs));
  for (let i = 1; i < o.rings; i++) for (let j = 0; j < o.segs; j++) {
    const a = 1 + (i - 1) * o.segs + j, b = 1 + (i - 1) * o.segs + ((j + 1) % o.segs);
    const c = a + o.segs, d = b + o.segs;
    idx.push(a, c, b, b, c, d);
  }
  const g = build({ pos, uv, idx });
  g.computeVertexNormals();
  return g;
}
function orient(geo, { tilt = 0, yaw = 0, roll = 0, pos = [0, 0, 0] }) {
  const m = new THREE.Matrix4().makeRotationY(yaw).multiply(new THREE.Matrix4().makeRotationX(-tilt)).multiply(new THREE.Matrix4().makeRotationZ(roll));
  geo.applyMatrix4(m); geo.translate(pos[0], pos[1], pos[2]);
  return geo;
}
/** Build one flower (axis +y) at bloom state `open` (0 bud -> 1 open). Returns {petals, filaments, anthers, calyx} geometries. */
function flowerParts(open, seed, o) {
  const rng = makeRng(hashString('flower:' + seed));
  const petals = [], fil = [], anth = [], cal = [];
  const np = o.petals, ns = o.stamens;
  const tilt = (1 - open) * 0.25 + open * 1.32; // from axis (radians)
  for (let i = 0; i < np; i++) {
    const yaw = (i / np) * TAU + (rng() - 0.5) * 0.25;
    const g = petalGeometry(seed * 31 + i, { cup: 0.22 + (1 - open) * 0.7, curl: 0.08 + (1 - open) * 0.35 });
    // petal local: length +y, cup +z (inner). Rotate so the inner face looks toward the axis/up.
    g.rotateX(-Math.PI / 2); // length -> -z ... then -z -> outward after yaw
    g.rotateY(Math.PI);      // length -> +z (outward along +z), inner face (+z before) -> +y (up)
    const tl = tilt + (rng() - 0.5) * 0.15;
    const m = new THREE.Matrix4().makeRotationY(yaw).multiply(new THREE.Matrix4().makeRotationX(-(Math.PI / 2 - tl)));
    g.applyMatrix4(m);
    g.translate(Math.sin(yaw) * 0.0012, 0.0006, Math.cos(yaw) * 0.0012);
    petals.push(g);
  }
  for (let i = 0; i < ns; i++) {
    const yaw = rng() * TAU, r0 = 0.0008 + 0.0014 * Math.sqrt(rng());
    const len = (0.0045 + 0.0035 * rng()) * (0.35 + 0.65 * open);
    const spread = (0.15 + 0.55 * open) * (0.6 + 0.5 * rng());
    const p0 = new THREE.Vector3(Math.sin(yaw) * r0, 0.0005, Math.cos(yaw) * r0);
    const dir = new THREE.Vector3(Math.sin(yaw) * Math.sin(spread), Math.cos(spread), Math.cos(yaw) * Math.sin(spread));
    const p2 = p0.clone().addScaledVector(dir, len);
    const p1 = p0.clone().addScaledVector(dir, len * 0.5).add(new THREE.Vector3(0, len * 0.08, 0));
    const curve = new THREE.QuadraticBezierCurve3(p0, p1, p2);
    fil.push(tubeAlongCurve(curve, 0.00009, { tubular: 5, radial: 4, caps: false, vNormalized: true }));
    const a = new THREE.SphereGeometry(0.00032, 6, 4);
    a.scale(1, 0.7, 1.4);
    a.lookAt(dir);
    a.translate(p2.x, p2.y, p2.z);
    anth.push(a);
  }
  // pistil
  {
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0.0005, 0), new THREE.Vector3(0.0002, 0.004, 0), new THREE.Vector3(0.0003, (0.006 + 0.002 * open), 0.0002));
    fil.push(tubeAlongCurve(curve, 0.00012, { tubular: 5, radial: 4, caps: false, vNormalized: true }));
  }
  // calyx: 5 sepals + receptacle
  for (let i = 0; i < 5; i++) {
    const yaw = ((i + 0.5) / 5) * TAU;
    const g = petalGeometry(seed * 17 + i, { length: 0.0042, width: 0.0038, cup: 0.4, curl: 0.05, rings: 3, segs: 12, irregular: 0.02 });
    g.rotateX(-Math.PI / 2); g.rotateY(Math.PI);
    const tl = 1.0 + open * 0.9;
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw).multiply(new THREE.Matrix4().makeRotationX(-(Math.PI / 2 - tl))));
    g.translate(0, -0.0006, 0);
    cal.push(g);
  }
  const rec = lathe([[0, -0.003], [0.0012, -0.0025], [0.0018, -0.001], [0.0016, 0.0004], [0, 0.0006]], { segments: 12 });
  cal.push(rec);
  return { petals: merge(petals), filaments: merge(fil), anthers: merge(anth), calyx: merge(cal) };
}
/**
 * flowerGeometry(opts) -> BufferGeometry with groups [0 petals, 1 filaments+pistil, 2 anthers, 3 calyx] (use a material array).
 *   opts: { open:1, seed:1, petals:5, stamens:25, morph:false }. With morph:true the base is the bud (open 0) and
 *   morphAttributes.position = [open 0.5, open 1] (drive mesh.morphTargetInfluences from world.bloomAmount, see bloomInfluences).
 */
export function flowerGeometry(opts = {}) {
  const o = { open: 1, seed: 1, petals: 5, stamens: 25, morph: false, ...opts };
  const build1 = (open) => {
    const p = flowerParts(open, o.seed, o);
    const list = [p.petals, p.filaments, p.anthers, p.calyx];
    const g = mergeGeometries(list.map((x) => { for (const k of Object.keys(x.attributes)) if (!['position', 'normal', 'uv'].includes(k)) x.deleteAttribute(k); return x; }), true);
    return g;
  };
  const g = build1(o.morph ? 0 : o.open);
  if (o.morph) {
    const a = build1(0.5), b = build1(1);
    g.morphAttributes.position = [a.attributes.position, b.attributes.position];
    g.morphAttributes.normal = [a.attributes.normal, b.attributes.normal];
    g.morphTargetsRelative = false;
  }
  g.computeBoundingSphere();
  return g;
}
/** morphTargetInfluences for a morph flower at bloom b (0..1): piecewise-linear bud -> half -> open. */
export function bloomInfluences(b) {
  b = clamp(b, 0, 1);
  return b < 0.5 ? [b * 2, 0] : [2 - b * 2, b * 2 - 1];
}

// ================================================================================================
// Strings (guzheng / guqin): thin cylinder along +x (0..length) + closed-form vibration chunk.
// stringLine(opts) -> geometry. UV: u = x (m), v = 0..1 around. opts: { length:1.0, radius:0.0005, radial:6, segs:96 }
// ================================================================================================
export function stringLine(opts = {}) {
  const L = opts.length ?? 1.0, r = opts.radius ?? 0.0005, rad = opts.radial ?? 6, segs = opts.segs ?? 96;
  const pos = [], nrm = [], uv = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const x = (i / segs) * L;
    for (let j = 0; j <= rad; j++) {
      const a = (j / rad) * TAU, c = Math.cos(a), s = Math.sin(a);
      pos.push(x, r * c, r * s); nrm.push(0, c, s); uv.push(x, j / rad);
    }
  }
  for (let i = 0; i < segs; i++) for (let j = 0; j < rad; j++) {
    const a = i * (rad + 1) + j, b = a + rad + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = build({ pos, nrm, uv, idx });
  g.userData.string = { length: L, radius: r };
  return g;
}
export const STRING_MAX_NOTES = 8;
/** GLSL chunk: string vibration. mvStrNotes[k] = (startTime, amplitude m, pluckPos 0..1, decay s). */
export const STRING_GLSL = /* glsl */ `
#ifdef MV_STRING
uniform vec4 mvStrNotes[${STRING_MAX_NOTES}];
uniform float mvStrT;
uniform vec4 mvStrP;     // length (m), visual freq (Hz), mode (0 wave, 1 blur), radius (m)
uniform vec3 mvStrDir;   // vibration direction (object space, unit)
varying float vMvStrCov;
varying float vMvStrSide;
void mvStrEval(float s, out float y, out float env) {
  y = 0.0; env = 0.0;
  for (int k = 0; k < ${STRING_MAX_NOTES}; k++) {
    vec4 nt = mvStrNotes[k];
    float age = mvStrT - nt.x;
    if (age < 0.0 || nt.y <= 0.0) continue;
    float a = nt.y * exp(-age / max(nt.w, 0.01)) * (1.0 - exp(-age / 0.004));
    for (int n = 1; n <= 3; n++) {
      float fn = float(n);
      float md = sin(fn * 3.14159265 * nt.z) * sin(fn * 3.14159265 * s) / (fn * fn);
      float dec = exp(-age * (fn - 1.0) * 0.9);
      float amp = a * md * dec;
      y += amp * cos(6.2831853 * fn * mvStrP.y * age);
      env += amp * amp;
    }
  }
  env = sqrt(env) * 1.41421;
}
void mvDeform(vec3 p, vec3 n, vec2 uvIn, out vec3 disp, out vec3 nOut) {
  float s = clamp(p.x / max(mvStrP.x, 1e-4), 0.0, 1.0);
  float y, env; mvStrEval(s, y, env);
  nOut = n;
  if (mvStrP.z < 0.5) { disp = mvStrDir * y; vMvStrCov = 1.0; vMvStrSide = 0.0; }
  else {
    float side = dot(n, mvStrDir);
    float sg = side > 0.2 ? 1.0 : (side < -0.2 ? -1.0 : 0.0);
    disp = mvStrDir * sg * env;
    vMvStrCov = mvStrP.w / (mvStrP.w + env);
    vMvStrSide = sg;
  }
}
#endif
`;
/** CPU mirror of the string displacement (wave mode) — for placing effects (light glints, particles). */
export function stringDisp(s, t, notes, { freq = 6, length = 1 } = {}) {
  let y = 0, env = 0;
  for (const nt of notes) {
    const age = t - nt[0]; if (age < 0 || nt[1] <= 0) continue;
    const a = nt[1] * Math.exp(-age / Math.max(nt[3], 0.01)) * (1 - Math.exp(-age / 0.004));
    for (let n = 1; n <= 3; n++) {
      const md = Math.sin(n * Math.PI * nt[2]) * Math.sin(n * Math.PI * s) / (n * n);
      const amp = a * md * Math.exp(-age * (n - 1) * 0.9);
      y += amp * Math.cos(TAU * n * freq * age); env += amp * amp;
    }
  }
  return { y, env: Math.sqrt(env) * Math.SQRT2 };
}
/**
 * Pick the recent notes that drive one string at time t -> fills uniform array mvStrNotes (Vector4[]).
 *   notes: [{t, vel, dur, midi}] already filtered for this string. opts: { amp:0.0012 (m at vel 1), pluck:0.18, decay:1.4, window:8 }
 */
export function stringNotesAt(notes, t, opts = {}) {
  const amp = opts.amp ?? 0.0012, pluck = opts.pluck ?? 0.18, decay = opts.decay ?? 1.4, win = opts.window ?? 8;
  const out = [];
  // binary search last note <= t
  let lo = 0, hi = notes.length - 1, last = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (notes[m].t <= t) { last = m; lo = m + 1; } else hi = m - 1; }
  for (let i = last; i >= 0 && out.length < STRING_MAX_NOTES; i--) {
    const n = notes[i];
    if (t - n.t > win) break;
    out.push([n.t, amp * (n.vel ?? 0.7), pluck, decay]);
  }
  while (out.length < STRING_MAX_NOTES) out.push([0, 0, 0.5, 1]);
  return out;
}

// ================================================================================================
// pillowGeometry — rounded linen pillow (0.55 × 0.32 × ~0.11) with seam flange and soft wrinkles (bonus helper).
//   opts: { width:0.55, depth:0.32, height:0.11, segs:[56,36], wrinkles:0.0035, dent:0.25, seed:1 }
// Lies on y=0 (bottom), centred in xz. Metric UVs.
// ================================================================================================
export function pillowGeometry(opts = {}) {
  const o = { width: 0.55, depth: 0.32, height: 0.11, segs: [56, 36], wrinkles: 0.0035, dent: 0.25, seed: 1, ...opts };
  const [nx, nz] = o.segs;
  const rng = makeRng(hashString('pillow:' + o.seed));
  const off = [rng() * 10, rng() * 10];
  const prof = (s) => Math.pow(Math.max(0, 1 - Math.pow(Math.abs(s), 3.2)), 0.45);
  const creases = [];
  for (let k = 0; k < (o.creases ?? 9); k++) {
    const side = Math.floor(rng() * 4), t0 = rng() * 1.6 - 0.8;
    const p0 = side === 0 ? [-1, t0] : side === 1 ? [1, t0] : side === 2 ? [t0, -1] : [t0, 1];
    const ang = Math.atan2(-p0[1], -p0[0]) + (rng() - 0.5) * 1.1;
    creases.push({ p0, d: [Math.cos(ang), Math.sin(ang)], len: 0.35 + 0.5 * rng(), w: 0.035 + 0.05 * rng(), a: (rng() < 0.6 ? -1 : 1) * (0.002 + 0.004 * rng()) });
  }
  const creaseAt = (u, v) => {
    let h = 0;
    for (const c of creases) {
      const du = u - c.p0[0], dv = v - c.p0[1];
      const al = du * c.d[0] + dv * c.d[1], ac = -du * c.d[1] + dv * c.d[0];
      if (al < 0 || al > c.len) continue;
      h += c.a * Math.exp(-((ac / c.w) ** 2)) * Math.sin(Math.PI * al / c.len) * (1 - al / c.len * 0.5);
    }
    return h;
  };
  const parts = [];
  for (const side of [1, -1]) {
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= nz; j++) {
      const v = -1 + 2 * j / nz;
      for (let i = 0; i <= nx; i++) {
        const u = -1 + 2 * i / nx;
        // corner "ears": the seam pulls in at the middle of each edge
        const x = u * o.width / 2 * (1 - 0.03 * (1 - v * v) * u * u), z = v * o.depth / 2 * (1 - 0.05 * (1 - u * u) * v * v);
        let hgt = prof(u) * prof(v);
        const dent = o.dent * Math.exp(-((u + 0.15) ** 2 / 0.18 + (v - 0.05) ** 2 / 0.25)) * (side > 0 ? 1 : 0);
        hgt *= 1 - dent * 0.35;
        const edgeW = 1 - hgt;
        const wr = o.wrinkles * (gnoise2(u * 3 + off[0], v * 5 + off[1]) * 0.6 + gnoise2(u * 9 + off[1], v * 7 - off[0]) * 0.4) * (0.4 + 1.6 * edgeW)
          + creaseAt(u, v) * (side > 0 ? 1 : 0.6) * Math.min(1, hgt * 3);
        const y = side > 0 ? o.height * 0.55 * hgt + wr : -o.height * 0.45 * hgt * 0.85 + wr * (1 - 0.5 * hgt);
        pos.push(x, y + o.height * 0.45 * 0.85 * 1.0, z);
        uv.push(x + o.width / 2 + (side < 0 ? 1.3 : 0), z + o.depth / 2);
      }
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + nx + 1;
      side > 0 ? idx.push(a, b, a + 1, a + 1, b, b + 1) : idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
    parts.push(build({ pos, uv, idx }));
  }
  const g = merge(parts);
  g.computeVertexNormals();
  return g;
}

// ================================================================================================
// paperSheet — a sheet of paper (letter 信笺) lying on y=0: optional soft fold crease, curled edges, slight waviness.
//   opts: { width:0.18, depth:0.26, segs:[36,52], fold:0.5 (crease position along depth, null = none), foldLift:0.006,
//           curl:0.004, wave:0.0012, seed:1 }. Metric UVs (u across, v along depth). Use with M.ricePaper().
// ================================================================================================
export function paperSheet(opts = {}) {
  const o = { width: 0.18, depth: 0.26, segs: [36, 52], fold: 0.5, foldLift: 0.006, curl: 0.004, wave: 0.0012, seed: 1, ...opts };
  const [nx, nz] = o.segs;
  const rng = makeRng(hashString('paper:' + o.seed));
  const ph = [rng() * 10, rng() * 10, rng() * 6];
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= nz; j++) {
    const v = j / nz;
    for (let i = 0; i <= nx; i++) {
      const u = i / nx;
      let y = 0;
      if (o.fold !== null && o.fold !== undefined) { const d = Math.abs(v - o.fold) * o.depth; y += o.foldLift * Math.exp(-d / 0.012) * (0.8 + 0.2 * Math.sin(u * 7 + ph[2])); }
      const eu = Math.min(u, 1 - u) * o.width, ev = Math.min(v, 1 - v) * o.depth;
      y += o.curl * (Math.exp(-eu / 0.012) * (0.6 + 0.4 * gnoise1(v * 4 + ph[0], 3)) + Math.exp(-ev / 0.015) * (0.5 + 0.5 * gnoise1(u * 4 + ph[1], 5)));
      y += o.wave * gnoise2(u * 3 + ph[0], v * 3 + ph[1]);
      pos.push((u - 0.5) * o.width, Math.max(0, y) + 0.0002, (v - 0.5) * o.depth);
      uv.push(u * o.width, v * o.depth);
    }
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + nx + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = build({ pos, uv, idx });
  g.computeVertexNormals();
  return g;
}

/**
 * mergeInstanced(instancedMesh) -> BufferGeometry: bakes an InstancedMesh (tiles, slats) into ONE static geometry
 * (SwiftShader costs ~14 µs per instance, see tools/cinematic/README.md). Adds a per-vertex `mvSeed` (instance index + 1) so the
 * MV materials keep their per-instance colour / UV jitter. Use with a regular THREE.Mesh.
 */
export function mergeInstanced(im) {
  const base = im.geometry.index ? im.geometry.toNonIndexed() : im.geometry;
  const n = im.count, vc = base.attributes.position.count;
  const out = [];
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    im.getMatrixAt(i, m);
    const g = base.clone();
    g.applyMatrix4(m);
    g.setAttribute('mvSeed', new THREE.Float32BufferAttribute(new Float32Array(vc).fill(i + 1), 1));
    out.push(g);
  }
  const keep = ['position', 'normal', 'uv', 'mvEdge', 'mvSeed'];
  for (const g of out) for (const k of Object.keys(g.attributes)) if (!keep.includes(k)) g.deleteAttribute(k);
  const merged = mergeGeometries(out, false);
  merged.computeBoundingSphere();
  return merged;
}
