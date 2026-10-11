// Building-block "materialisation" helpers: structure for distant and middle-distance masses (flat-roofed rammed-earth
// houses, fortified walls with an arched gate, a ruined rammed tower, a clinker-planked hull). The material comes from the
// material library (rammedEarthMaterial / snowMaterial); this file only provides STRUCTURE, the thing a "6-face box + one
// colour" lacks: eaves that throw a shadow line, openings that are real holes (four reveals + a back), snow with thickness
// (heightfield cap, leeward cornice, lip), rafters, crenellations, plank laps. No layout, no place, no work-specific shape:
// every builder takes explicit dimensions.
//
//   const b = blockBatches();                                                  // {wall, snow, hole, wood, brick}
//   flatRoofHouse(b, {pos: [x, y, z], yaw, w: 7, d: 5, h: 3.2, doors: [{face: '+c', u: 3.5, w: 1.1, h: 2}],
//                     windows: [{face: '+c', u: 1.4, y: 1.1, w: 0.9, h: 0.9, lit: true}], chimney: {a: 2, c: 0.5, h: 0.9}, seed: 3}, HOLE);
//   const meshes = buildBlockMeshes(THREE, b, {wall, snow, hole, wood});      // finishBatch (winding) runs inside
//
// Conventions: local frame F = frame(origin, yaw); a = local +x, c = local +z; a wall whose outward normal is -c faces
// local -z. Batch vertex layout: position, normal, color, aMat (vec4), uv. wall: any colour (the rammed material ignores
// it); snow: colour = albedo, aMat.x = ripple strength; hole: colour = emission (warm window 1900 K x strength, dark
// opening near black); wood: aMat.w = plank id, uv.x = across-plank coordinate (plank units), uv.y = metres along the grain.
import {makeRng, gnoise1, gnoise2} from '../../engine/noise.js';

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };
const mix = (a, b, t) => a + (b - a) * t;
const WALL = [0.3, 0.25, 0.18], WM = [1, 1, 0, 0];
export const HOLE_COLORS = Object.freeze({dark: [0.004, 0.004, 0.005], door: [0.006, 0.005, 0.004], lit: [1.6, 0.62, 0.2], deep: [0.3, 0.115, 0.035]});   // deep = far end of a passage

/** Minimal geometry batch (same layout as the engine terrain Batch). */
export class GeoBatch {
  constructor() { this.p = []; this.n = []; this.c = []; this.m = []; this.uv = []; this.i = []; }
  vert(p, n, c = [1, 1, 1], m = [0, 0, 0, 0], uv = [0, 0]) { this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.c.push(c[0], c[1], c[2]); this.m.push(m[0], m[1], m[2], m[3]); this.uv.push(uv[0], uv[1]); return this.p.length / 3 - 1; }
  tri(a, b, c) { this.i.push(a, b, c); }
  get count() { return this.p.length / 3; }
  build(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.m, 4));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}
export const blockBatches = () => ({wall: new GeoBatch(), snow: new GeoBatch(), hole: new GeoBatch(), wood: new GeoBatch(), brick: new GeoBatch()});

/** Flip every triangle whose geometric normal opposes its vertex normals (E6: back-face culling eats half the faces). */
export function orientIndex(pos, nrm, idx) {
  let flipped = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const nx = nrm[a] + nrm[b] + nrm[c], ny = nrm[a + 1] + nrm[b + 1] + nrm[c + 1], nz = nrm[a + 2] + nrm[b + 2] + nrm[c + 2];
    if (gx * nx + gy * ny + gz * nz < 0) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; flipped++; }
  }
  return flipped;
}
/** Must run before build: fixes winding and replaces zero / NaN normals with +y (E5: NaN through bloom = black frame). */
export function finishBatch(b) {
  for (let k = 0; k < b.n.length; k += 3) {
    const l = Math.hypot(b.n[k], b.n[k + 1], b.n[k + 2]);
    if (!(l > 1e-9)) { b.n[k] = 0; b.n[k + 1] = 1; b.n[k + 2] = 0; } else { b.n[k] /= l; b.n[k + 1] /= l; b.n[k + 2] /= l; }
  }
  orientIndex(b.p, b.n, b.i);
  return b;
}
/** Geometry self-check (node, no browser): NaN positions, zero normals, triangles facing against their normals. */
export function inspectBatch(b) {
  let nan = 0, zeroN = 0, against = 0;
  for (const v of b.p) if (!Number.isFinite(v)) nan++;
  for (let k = 0; k < b.n.length; k += 3) if (!(Math.hypot(b.n[k], b.n[k + 1], b.n[k + 2]) > 1e-6)) zeroN++;
  const idx = b.i.slice(); against = orientIndex(b.p, b.n, idx);
  return {verts: b.count, tris: b.i.length / 3, nan, zeroNormals: zeroN, against};
}

/** Wrap a MeshStandard material (e.g. rammedEarthMaterial) with the engine atmosphere so distant masses fade with the ground
 *  (E11). Chains the previous onBeforeCompile; the program key gets a unique suffix (same key = three reuses a wrong program). */
export function withAtmosFog(mat, atmos, programKey = 'far') {
  if (!atmos || typeof atmos.glsl !== 'string') throw new TypeError('withAtmosFog needs the engine atmosphere ({glsl, uniforms})');
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(mat, sh, r);
    Object.assign(sh.uniforms, atmos.uniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vAtmW;\n')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvAtmW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vAtmW;\n' + atmos.glsl)
      .replace('#include <fog_fragment>', '{ vec4 atm = vAtmosJ(vAtmW, 0.0, vIGN(gl_FragCoord.xy)); gl_FragColor.rgb = gl_FragColor.rgb * atm.a + atm.rgb; }');
  };
  mat.customProgramCacheKey = () => prevKey + '|atm|' + programKey;
  return mat;
}

// ------------------------------------------------------------------------------------------------ writers
/** Local frame: p(a, y, c) -> world, n(na, ny, nc) -> world direction. */
export function frame(o, yaw = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return {p: (a, y, cc) => [o[0] + a * c - cc * s, o[1] + y, o[2] + a * s + cc * c], n: (na, ny, nc) => [na * c - nc * s, ny, na * s + nc * c]};
}
export function quad(b, p0, p1, p2, p3, n, col, m, uvs) {
  const u = uvs || [[0, 0], [1, 0], [1, 1], [0, 1]];
  const i0 = b.vert(p0, n, col, m, u[0]), i1 = b.vert(p1, n, col, m, u[1]), i2 = b.vert(p2, n, col, m, u[2]), i3 = b.vert(p3, n, col, m, u[3]);
  b.tri(i0, i1, i2); b.tri(i0, i2, i3);
}
/** Solid box in frame F; skip faces with 'top' | 'bottom' | '+a' | '-a' | '+c' | '-c'. */
export function boxF(b, F, a0, a1, y0, y1, c0, c1, col = WALL, m = WM, skip = []) {
  const P = F.p, N = F.n, sk = new Set(skip);
  if (!sk.has('+c')) quad(b, P(a0, y0, c1), P(a1, y0, c1), P(a1, y1, c1), P(a0, y1, c1), N(0, 0, 1), col, m, [[a0, y0], [a1, y0], [a1, y1], [a0, y1]]);
  if (!sk.has('-c')) quad(b, P(a1, y0, c0), P(a0, y0, c0), P(a0, y1, c0), P(a1, y1, c0), N(0, 0, -1), col, m, [[a1, y0], [a0, y0], [a0, y1], [a1, y1]]);
  if (!sk.has('+a')) quad(b, P(a1, y0, c1), P(a1, y0, c0), P(a1, y1, c0), P(a1, y1, c1), N(1, 0, 0), col, m, [[c1, y0], [c0, y0], [c0, y1], [c1, y1]]);
  if (!sk.has('-a')) quad(b, P(a0, y0, c0), P(a0, y0, c1), P(a0, y1, c1), P(a0, y1, c0), N(-1, 0, 0), col, m, [[c0, y0], [c1, y0], [c1, y1], [c0, y1]]);
  if (!sk.has('top')) quad(b, P(a0, y1, c1), P(a1, y1, c1), P(a1, y1, c0), P(a0, y1, c0), N(0, 1, 0), col, m, [[a0, c1], [a1, c1], [a1, c0], [a0, c0]]);
  if (!sk.has('bottom')) quad(b, P(a0, y0, c0), P(a1, y0, c0), P(a1, y0, c1), P(a0, y0, c1), N(0, -1, 0), col, m);
}

/**
 * One rectangular wall face (width W along direction (da, dc) from (a0, c0), outward normal (na, nc), height H from y0) with
 * openings cut as REAL holes: the face is split around each opening, each opening gets four reveals (wall material; the sill
 * faces up so it collects snow) and a back at `depth` (hole batch, or a plank door on the wood batch, or a cross mullion).
 * openings: [{u, y, w, h, kind: 'win'|'door', lit, depth}] in face coordinates (u from the face start, y from y0).
 */
export function wallWithOpenings(b, F, a0, c0, da, dc, na, nc, W, y0, H, openings = [], depth = 0.32, holeCol = HOLE_COLORS) {
  for (const o of openings) {
    if (!(o.u - o.w / 2 >= 0.05 && o.u + o.w / 2 <= W - 0.05 && o.y >= 0 && o.y + o.h <= H - 0.05)) throw new RangeError(`opening at u=${o.u} y=${o.y} does not fit the ${W.toFixed(2)} x ${H.toFixed(2)} m face`);
  }
  const P = (u, y, inset = 0) => F.p(a0 + da * u - na * inset, y0 + y, c0 + dc * u - nc * inset);
  const n = F.n(na, 0, nc);
  const us = [0, W];
  for (const o of openings) us.push(o.u - o.w / 2, o.u + o.w / 2);
  us.sort((p, q) => p - q);
  for (let i = 0; i < us.length - 1; i++) {
    const u0 = us[i], u1 = us[i + 1];
    if (u1 - u0 < 1e-4) continue;
    const um = (u0 + u1) / 2;
    const cut = openings.filter((o) => um > o.u - o.w / 2 && um < o.u + o.w / 2).sort((p, q) => p.y - q.y);
    let y = 0;
    for (const o of cut) { if (o.y > y) quad(b.wall, P(u0, y), P(u1, y), P(u1, o.y), P(u0, o.y), n, WALL, WM); y = o.y + o.h; }
    if (H > y) quad(b.wall, P(u0, y), P(u1, y), P(u1, H), P(u0, H), n, WALL, WM);
  }
  for (const o of openings) {
    const ua = o.u - o.w / 2, ub = o.u + o.w / 2, ya = o.y, yb = o.y + o.h, d = o.depth ?? depth;
    const t = F.n(da, 0, dc);
    quad(b.wall, P(ua, ya, 0), P(ua, ya, d), P(ua, yb, d), P(ua, yb, 0), t, WALL, WM);                          // left reveal
    quad(b.wall, P(ub, ya, d), P(ub, ya, 0), P(ub, yb, 0), P(ub, yb, d), [-t[0], 0, -t[2]], WALL, WM);         // right reveal
    quad(b.wall, P(ua, yb, 0), P(ua, yb, d), P(ub, yb, d), P(ub, yb, 0), [0, -1, 0], WALL, WM);                // lintel soffit
    quad(b.wall, P(ub, ya, 0), P(ub, ya, d), P(ua, ya, d), P(ua, ya, 0), [0, 1, 0], WALL, WM);                 // sill (faces up)
    const hc = o.lit ? holeCol.lit : o.kind === 'door' ? holeCol.door : holeCol.dark;
    if (o.kind === 'door' && b.wood && !o.lit) {
      const nb = Math.max(2, Math.round(o.w / 0.16));                                                          // 16 cm boards
      quad(b.wood, P(ua, ya, d), P(ub, ya, d), P(ub, yb, d), P(ua, yb, d), n, [0.22, 0.18, 0.14], [0.9, 1, 0, 1], [[0, 0], [nb, 0], [nb, o.h], [0, o.h]]);
    } else {
      quad(b.hole, P(ua, ya, d), P(ub, ya, d), P(ub, yb, d), P(ua, yb, d), n, hc, [1, 0, 0, 0]);
      if (o.kind === 'win' && b.wood && o.mullion !== false) {
        const cu = o.u, cy = (ya + yb) / 2, wB = 0.035, d2 = d - 0.03;
        quad(b.wood, P(cu - wB, ya, d2), P(cu + wB, ya, d2), P(cu + wB, yb, d2), P(cu - wB, yb, d2), n, [0.2, 0.16, 0.12], [0.9, 1, 0, 2], [[0, 0], [0.4, 0], [0.4, o.h], [0, o.h]]);
        quad(b.wood, P(ua, cy - wB, d2), P(ub, cy - wB, d2), P(ub, cy + wB, d2), P(ua, cy + wB, d2), n, [0.2, 0.16, 0.12], [0.9, 1, 0, 3], [[0, 0], [0.4, 0], [0.4, o.w], [0, o.w]]);
      }
    }
  }
}

/**
 * Snow cap on a flat top (local rectangle a0..a1 x c0..c1 at height y): a heightfield, thick in the middle, rounded and
 * drooping at the edges, with a leeward cornice overhanging by `cornice` m on the downwind side (windA +1 = +a, -1 = -a),
 * and a lip skirt all round so a side view shows thickness (never a box with a right-angled edge).
 */
export function snowCap(bSnow, F, a0, a1, c0, c1, y, opts = {}) {
  const T = opts.thick ?? 0.26, corn = opts.cornice ?? 0.35, drape = opts.drape ?? 0.12, seed = opts.seed ?? 1, wa = opts.windA ?? 1;
  if (!(T > 0 && T <= 1.2) || !(corn >= 0 && corn <= 1.5)) throw new RangeError('snowCap: thick 0..1.2 m, cornice 0..1.5 m');
  const A0 = a0 - (wa < 0 ? corn : 0.06), A1 = a1 + (wa > 0 ? corn : 0.06), C0 = c0 - 0.06, C1 = c1 + 0.06;
  const na = Math.max(4, Math.ceil((A1 - A0) / 0.45)), nc = Math.max(3, Math.ceil((C1 - C0) / 0.45));
  const col = opts.col || [0.86, 0.88, 0.92], m = [opts.ridge ?? 0.5, 1, 0, 0];
  const H = (a, c) => {
    const e = Math.min(a - a0, a1 - a, c - c0, c1 - c);
    let h = T * (0.86 + 0.14 * gnoise2(a * 0.7 + seed, c * 0.7 - seed)) * smooth(-0.02, 0.45, e);
    const over = wa > 0 ? a - a1 : a0 - a;
    if (over > 0) h = T * 0.9 * (1 - Math.pow(clamp(over / corn), 2.2)) - drape * Math.pow(clamp(over / corn), 1.5);
    else if (e < 0) h = -drape * clamp(-e / 0.06);
    return h;
  };
  const vid = [], e = 0.05;
  for (let j = 0; j <= nc; j++) for (let i = 0; i <= na; i++) {
    const a = mix(A0, A1, i / na), c = mix(C0, C1, j / nc), h = H(a, c);
    const dha = (H(a + e, c) - H(a - e, c)) / (2 * e), dhc = (H(a, c + e) - H(a, c - e)) / (2 * e);
    let n = F.n(-dha, 1, -dhc); const l = Math.hypot(...n); n = n.map((v) => v / l);
    vid.push(bSnow.vert(F.p(a, y + h, c), n, col, m, [a, c]));
  }
  for (let j = 0; j < nc; j++) for (let i = 0; i < na; i++) {
    const k = j * (na + 1) + i;
    bSnow.tri(vid[k], vid[k + na + 1], vid[k + 1]); bSnow.tri(vid[k + 1], vid[k + na + 1], vid[k + na + 2]);
  }
  const ring = [];
  for (let i = 0; i <= na; i++) ring.push([mix(A0, A1, i / na), C0, 0, -1]);
  for (let j = 0; j <= nc; j++) ring.push([A1, mix(C0, C1, j / nc), 1, 0]);
  for (let i = na; i >= 0; i--) ring.push([mix(A0, A1, i / na), C1, 0, 1]);
  for (let j = nc; j >= 0; j--) ring.push([A0, mix(C0, C1, j / nc), -1, 0]);
  const lip = opts.lip ?? 0.08;
  for (let k = 0; k < ring.length - 1; k++) {
    const [aA, cA, nA1, nC1] = ring[k], [aB, cB] = ring[k + 1];
    const hA = H(aA, cA), hB = H(aB, cB);
    quad(bSnow, F.p(aA, y + hA - lip - drape, cA), F.p(aB, y + hB - lip - drape, cB), F.p(aB, y + hB, cB), F.p(aA, y + hA, cA), F.n(nA1, 0.2, nC1), col, m);
  }
}

/**
 * flatRoofHouse(b, spec, holeCol) — rammed-earth flat-roofed house: walls with real openings, roof slab with overhang,
 * rafter ends (jittered, some missing — an evenly spaced row reads as a stripe pattern), snow cap with leeward cornice,
 * optional chimney and yard wall. spec: {pos (wall-foot centre on the ground), yaw, w, d, h, eave 0.35, roofT 0.22,
 * wind +1|-1 (local a), doors/windows:[{face:'+c'|'-c'|'+a'|'-a', u, y, w, h, lit}], chimney:{a, c, h, s}, yard:{segs|len, h},
 * snowT, cornice, rafters, seed}. The wall foot is buried 0.4 m (uneven ground).
 */
export function flatRoofHouse(b, spec, holeCol = HOLE_COLORS) {
  const {pos, yaw = 0, w, d, h} = spec;
  if (!(w >= 2 && w <= 40 && d >= 2 && d <= 40 && h >= 1.8 && h <= 12)) throw new RangeError('flatRoofHouse: w, d 2..40 m and h 1.8..12 m');
  const F = frame(pos, yaw), seed = spec.seed ?? 1, rng = makeRng('house:' + seed);
  const eave = spec.eave ?? 0.35, roofT = spec.roofT ?? 0.22, depth = spec.holeDepth ?? 0.32;
  const a0 = -w / 2, a1 = w / 2, c0 = -d / 2, c1 = d / 2, yb = -0.4;
  const ops = (face) => [...(spec.doors || []).filter((o) => o.face === face).map((o) => ({...o, kind: 'door', y: (o.y ?? 0) - yb})),
    ...(spec.windows || []).filter((o) => o.face === face).map((o) => ({...o, kind: 'win', y: o.y - yb}))];
  const H = h - yb;
  wallWithOpenings(b, F, a0, c0, 1, 0, 0, -1, w, yb, H, ops('-c'), depth, holeCol);
  wallWithOpenings(b, F, a1, c0, 0, 1, 1, 0, d, yb, H, ops('+a'), depth, holeCol);
  wallWithOpenings(b, F, a1, c1, -1, 0, 0, 1, w, yb, H, ops('+c'), depth, holeCol);
  wallWithOpenings(b, F, a0, c1, 0, -1, -1, 0, d, yb, H, ops('-a'), depth, holeCol);
  boxF(b.wall, F, a0 - eave, a1 + eave, h, h + roofT, c0 - eave, c1 + eave, WALL, WM, ['bottom']);
  quad(b.wall, F.p(a0 - eave, h, c0 - eave), F.p(a1 + eave, h, c0 - eave), F.p(a1 + eave, h, c1 + eave), F.p(a0 - eave, h, c1 + eave), F.n(0, -1, 0), WALL, WM);
  if (b.wood && spec.rafters !== false) {
    const rr = 0.06;
    for (const [c, sgn] of [[c0, -1], [c1, 1]]) {
      let a = a0 + 0.2 + 0.1 * rng();
      while (a <= a1 - 0.2) {
        const out = eave * (0.5 + 0.22 * rng()) / 0.35 * 0.35;
        if (rng() > 0.12) boxF(b.wood, F, a - rr, a + rr, h - 0.13, h - 0.01, sgn < 0 ? c - out : c, sgn > 0 ? c + out : c, [0.2, 0.16, 0.12], [0.9, 1, 0, 4 + a], ['top']);
        a += 0.42 + (rng() - 0.5) * 0.32;
      }
    }
  }
  snowCap(b.snow, F, a0 - eave, a1 + eave, c0 - eave, c1 + eave, h + roofT, {thick: spec.snowT ?? 0.28, cornice: spec.cornice ?? 0.4, windA: spec.wind ?? 1, seed});
  if (spec.chimney) {
    const C = spec.chimney, s = C.s ?? 0.55;
    boxF(b.wall, F, C.a - s / 2, C.a + s / 2, h, h + roofT + C.h, C.c - s / 2, C.c + s / 2, WALL, WM, ['bottom']);
    snowCap(b.snow, F, C.a - s / 2, C.a + s / 2, C.c - s / 2, C.c + s / 2, h + roofT + C.h, {thick: 0.12, cornice: 0.12, windA: spec.wind ?? 1, drape: 0.05, lip: 0.04, seed: seed + 7});
  }
  if (spec.yard) {
    const Y = spec.yard, t = 0.45, hh = Y.h ?? 1.9;
    for (const [sa0, sc0, sa1, sc1] of Y.segs || [[a0, c1 + 0.2, a1 + (Y.len ?? 6), c1 + 0.2 + t]]) {
      boxF(b.wall, F, sa0, sa1, yb, hh, sc0, sc1, WALL, WM, ['bottom']);
      snowCap(b.snow, F, sa0, sa1, sc0, sc1, hh, {thick: 0.16, cornice: 0.12, windA: spec.wind ?? 1, drape: 0.06, lip: 0.05, seed: seed + 13});
    }
  }
  return {chimneyTop: spec.chimney ? F.p(spec.chimney.a, h + roofT + spec.chimney.h, spec.chimney.c) : null};
}

/**
 * fortWall(b, spec, holeCol) — a battered rammed wall run with walkway snow, crenellations (each merlon with a snow cap), end
 * faces, an optional brick-arched gate passage (arch ring, deep passage, one warm point inside), an optional gate house and a
 * foot drift along the outside (needs spec.gY ground function). spec: {pos (gate centre on the ground), yaw (wall along local a,
 * outside = -c), len 160, h 8, base 5.5, top 3.8, gate:{w 4.2, h 5.4}|false, merlon:[w, h, t], tower:true, gY, seed}.
 */
export function fortWall(b, spec, holeCol = HOLE_COLORS) {
  const {pos, yaw = 0} = spec;
  const F = frame(pos, yaw);
  const L = spec.len ?? 160, H = spec.h ?? 8, B = spec.base ?? 5.5, Tt = spec.top ?? 3.8, seed = spec.seed ?? 1;
  if (!(L >= 8 && H >= 3 && H <= 20 && B > Tt && Tt >= 1)) throw new RangeError('fortWall: len >= 8, h 3..20, base > top >= 1');
  const hasGate = spec.gate !== false;
  const G = {w: hasGate ? 4.2 : 0, h: 5.4, ...(hasGate && spec.gate ? spec.gate : {})};
  const yb = -1.0, P = (a, y, c) => F.p(a, y, c);
  const segs = hasGate ? [[-L / 2, -G.w / 2], [G.w / 2, L / 2]] : [[-L / 2, L / 2]];
  const outC = (y) => -mix(B / 2, Tt / 2, clamp((y - yb) / (H - yb)));
  const [mw, mh, mt] = spec.merlon || [1.6, 0.9, 0.7];
  for (const [s0, s1] of segs) {
    quad(b.wall, P(s1, yb, outC(yb)), P(s0, yb, outC(yb)), P(s0, H, outC(H)), P(s1, H, outC(H)), F.n(0, (B - Tt) / 2 / (H - yb), -1), WALL, WM);
    quad(b.wall, P(s0, yb, Tt / 2), P(s1, yb, Tt / 2), P(s1, H, Tt / 2), P(s0, H, Tt / 2), F.n(0, 0, 1), WALL, WM);
    snowCap(b.snow, F, s0, s1, outC(H) + 0.55, Tt / 2, H, {thick: 0.22, cornice: 0.1, windA: 1, drape: 0.08, seed: seed + s0});
    for (let a = s0 + 0.4; a + mw <= s1 - 0.2; a += mw + 0.85) {
      const cOut = outC(H);
      boxF(b.wall, F, a, a + mw, H, H + mh, cOut, cOut + mt, WALL, WM, ['bottom']);
      snowCap(b.snow, F, a, a + mw, cOut, cOut + mt, H + mh, {thick: 0.14, cornice: 0.05, windA: 1, drape: 0.05, lip: 0.04, seed: seed + a});
    }
    for (const a of [s0, s1]) {
      const sg = a === s0 ? -1 : 1;
      if ((sg < 0 && Math.abs(s0 + L / 2) < 1e-3) || (sg > 0 && Math.abs(s1 - L / 2) < 1e-3)) quad(b.wall, P(a, yb, outC(yb)), P(a, yb, Tt / 2), P(a, H, Tt / 2), P(a, H, outC(H)), F.n(sg, 0, 0), WALL, WM);
    }
    if (spec.gY) {                                             // outside foot drift: a bright band the wall stands in
      const na = Math.max(8, Math.ceil((s1 - s0) / 1.5)), nc = 6, base = [];
      for (let j = 0; j <= nc; j++) for (let i = 0; i <= na; i++) {
        const a = mix(s0, s1, i / na), u = j / nc, c = outC(0) - 0.15 - u * 3.2, wp = F.p(a, 0, c);
        const n1 = 0.5 + 0.5 * gnoise1(a * 0.11 + seed * 3.3, 4), end = smooth(0, 2.5, Math.min(a - s0, s1 - a));
        const hh = (0.8 + 0.6 * n1) * Math.pow(1 - u, 1.6) * end, nn = F.n(0, 1, -0.45 * (0.8 + 0.6 * n1) * end), l = Math.hypot(...nn);
        base.push(b.snow.vert([wp[0], spec.gY(wp[0], wp[2]) + hh - 0.12, wp[2]], nn.map((v) => v / l), [0.84, 0.86, 0.9], [0.7, 1, 0, 0], [a, c]));
      }
      for (let j = 0; j < nc; j++) for (let i = 0; i < na; i++) { const k = j * (na + 1) + i; b.snow.tri(base[k], base[k + na + 1], base[k + 1]); b.snow.tri(base[k + 1], base[k + na + 1], base[k + na + 2]); }
    }
  }
  if (!hasGate) return {};
  const bb = b.brick || b.wall, gw = G.w / 2, gh = G.h, ns = 9;
  const arcY = (k) => gh - gw + Math.sin(Math.PI * k / ns) * gw, arcA = (k) => -Math.cos(Math.PI * k / ns) * gw;
  const cA = outC(0) - 0.05, cB = Tt / 2 + 0.05;
  quad(bb, P(-gw, yb, cB), P(-gw, yb, cA), P(-gw, gh - gw, cA), P(-gw, gh - gw, cB), F.n(1, 0, 0), WALL, WM);
  quad(bb, P(gw, yb, cA), P(gw, yb, cB), P(gw, gh - gw, cB), P(gw, gh - gw, cA), F.n(-1, 0, 0), WALL, WM);
  for (let k = 0; k < ns; k++) {
    const a0 = arcA(k), a1 = arcA(k + 1), y0 = arcY(k), y1 = arcY(k + 1), nx = -(a0 + a1) / 2, ny = -((y0 + y1) / 2 - (gh - gw)), l = Math.hypot(nx, ny) || 1;
    quad(bb, P(a0, y0, cA), P(a1, y1, cA), P(a1, y1, cB), P(a0, y0, cB), F.n(nx / l, ny / l, 0), WALL, WM);
  }
  for (let k = 0; k < ns; k++) {                               // 0.62 m brick arch ring on the outer face
    const t0 = Math.PI * k / ns, t1 = Math.PI * (k + 1) / ns, R0 = gw, R1 = gw + 0.62;
    const pA = (t, R) => P(-Math.cos(t) * R, gh - gw + Math.sin(t) * R, cA + 0.02);
    quad(bb, pA(t1, R0), pA(t0, R0), pA(t0, R1), pA(t1, R1), F.n(0, 0, -1), WALL, WM);
  }
  for (let k = 0; k < ns; k++) {                               // wall above and beside the arch inside the passage span
    const s = 1 + 0.62 / gw, a0 = clamp(arcA(k) * s, -gw, gw), a1 = clamp(arcA(k + 1) * s, -gw, gw);
    const y0 = gh - gw + (arcY(k) - (gh - gw)) * s, y1 = gh - gw + (arcY(k + 1) - (gh - gw)) * s;
    quad(b.wall, P(a1, Math.max(y1, 0), outC(H) - 0.01), P(a0, Math.max(y0, 0), outC(H) - 0.01), P(a0, H, outC(H) - 0.01), P(a1, H, outC(H) - 0.01), F.n(0, 0, -1), WALL, WM);
  }
  snowCap(b.snow, F, -gw, gw, outC(H) + 0.55, Tt / 2, H, {thick: 0.22, cornice: 0.1, windA: 1, drape: 0.08, seed: seed + 99});
  quad(b.hole, P(-gw * 0.8, yb, Tt / 2 - 0.4), P(gw * 0.8, yb, Tt / 2 - 0.4), P(gw * 0.8, gh - gw * 0.9, Tt / 2 - 0.4), P(-gw * 0.8, gh - gw * 0.9, Tt / 2 - 0.4), F.n(0, 0, -1), holeCol.deep || holeCol.lit, [1, 0, 0, 0]);   // one dim warm point deep in the passage
  if (spec.tower !== false) {
    const tw = G.w + 6.5, td = Tt - 0.4, Ft = frame(F.p(0, H, (outC(H) + Tt / 2) / 2), yaw);
    flatRoofHouse(b, {pos: Ft.p(0, 0, 0), yaw, w: tw, d: td, h: 4.2, eave: 0.45, roofT: 0.25, wind: 1, seed: seed + 31,
      windows: [{face: '-c', u: tw * 0.28, y: 1.5, w: 0.9, h: 1.1}, {face: '-c', u: tw * 0.72, y: 1.5, w: 0.9, h: 1.1}]}, holeCol);
  }
  return {};
}

/**
 * rammedTowerGeometry(opts) — ruined rammed-earth tower as one continuous surface (azimuth x height grid) + a dished top +
 * optional rubble heaps: super-ellipse section rounding upward, lift joints every `lift` m with +-3 cm set-backs and staggered
 * 1.8 m form blocks, windward vertical gullies (deeper higher up), 2-3 m weathering bulges, spall pits, a scoured foot groove,
 * V-shaped collapses bitten from the top (no stair steps inside a collapse), chipped corners. Normals from the grid; AO from
 * concavity; the innermost top ring keeps 4% radius (no degenerate fan, E5). Returns world-space arrays {pos, nrm, ao, idx, y0}.
 * opts: {center:[x,z], groundY, base 6, top 4, h 7, lift 0.5, yaw, wind:[x,z], seed, corners:[4 losses m],
 *        collapses:[{az deg, w m, depth m, bite m}], rubble:[{az, r, h}], cols, rows}
 */
export function rammedTowerGeometry(o) {
  const cx = o.center[0], cz = o.center[1], gY = o.groundY || (() => 0);
  const base = o.base ?? 6, top = o.top ?? 4, Ht = o.h ?? 7, lift = o.lift ?? 0.5, yaw = o.yaw ?? 0;
  if (!(base >= 1.5 && base <= 30 && top > 0.3 && top <= base && Ht >= 1.5 && Ht <= 40 && lift >= 0.2 && lift <= 1.2)) throw new RangeError('rammedTowerGeometry: base 1.5..30, top <= base, h 1.5..40, lift 0.2..1.2 m');
  const wind = o.wind || [0.94, 0.34], wl = Math.hypot(wind[0], wind[1]) || 1, wx = wind[0] / wl, wz = wind[1] / wl;
  const seed = o.seed ?? 7, rng = makeRng('tower:' + seed);
  const NA = o.cols ?? 176, NV = o.rows ?? Math.round(Ht / 0.09);
  const y0 = Math.min(gY(cx - base, cz - base), gY(cx + base, cz - base), gY(cx - base, cz + base), gY(cx + base, cz + base), gY(cx, cz)) - 0.35;
  const liftJit = []; for (let k = 0; k < 40; k++) liftJit.push((rng() - 0.5) * 0.07);
  const cornerLoss = o.corners || [0.4, 1.9, 0.9, 0.2], collapses = o.collapses || [];
  const superR = (th, p) => 1 / Math.pow(Math.pow(Math.abs(Math.cos(th)), p) + Math.pow(Math.abs(Math.sin(th)), p), 1 / p);
  const angD = (a, b) => { let d = a - b; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI)); return d; };
  const topAt = (th) => {
    let h = Ht;
    for (let k = 0; k < 4; k++) h -= cornerLoss[k] * Math.exp(-Math.pow(angD(th, Math.PI / 4 + k * Math.PI / 2) / 0.42, 2));
    for (const C of collapses) h -= C.depth * Math.exp(-Math.pow(angD(th, C.az * Math.PI / 180) / (C.w / (base * 0.42)), 2) * 1.6);
    return h + 0.14 * gnoise1(th * 3.1 + seed, seed) + 0.06 * gnoise1(th * 11.3 - seed, seed + 3);
  };
  const rad = (th, y) => {
    const f = clamp(y / Ht), w = mix(base / 2, top / 2, f), p = mix(9.0, 3.6, Math.pow(f, 1.3));
    let r = w * superR(th, p);
    const wa = th + yaw, windward = clamp(-(Math.cos(wa) * wx + Math.sin(wa) * wz) * 0.8 + 0.35);
    let notch = 0;
    for (const C of collapses) notch = Math.max(notch, Math.exp(-Math.pow(angD(th, C.az * Math.PI / 180) / (C.w / (base * 0.42)), 2) * 1.6) * smooth(C.depth + 1.4, C.depth * 0.3, Ht - y));
    const lk = 1 - 0.85 * notch;                                          // no lift steps inside a collapse ("a stack of pages")
    const li = Math.floor(y / lift), lu = (y - li * lift) / lift;
    r += liftJit[li % 40] * 0.85 * (1 - 0.4 * f) * lk;
    r -= (0.03 * Math.exp(-Math.pow((1 - lu) / 0.07, 2)) + 0.015 * Math.exp(-Math.pow(lu / 0.05, 2))) * lk;
    r += 0.01 * Math.sin(lu * Math.PI) * lk;
    const s = th * w, pu = (s + (li % 2) * 0.9 + liftJit[(li + 7) % 40] * 6) / 1.8, pf = pu - Math.floor(pu);
    r -= 0.03 * Math.exp(-Math.pow(Math.min(pf, 1 - pf) / 0.025, 2)) * lk;
    r += 0.015 * Math.sin(pf * Math.PI) * Math.sin(lu * Math.PI) * lk;
    r -= notch * 0.12 * (0.5 + 0.5 * gnoise2(s * 2.3 + 1.1, y * 2.3 - 4.4));
    const g = 1 - Math.abs(gnoise2(s * 1.05 + 0.35 * gnoise1(y * 0.9 + seed, seed + 5) + seed * 3.1, y * 0.11 + seed));
    r -= Math.pow(clamp((g - 0.52) / 0.48), 1.5) * (0.08 + 0.34 * f) * (0.9 + 0.5 * windward);
    r += 0.2 * gnoise2(s * 0.42 + seed * 0.7, y * 0.33 - seed) * (0.4 + 0.6 * f) * (1 - 0.6 * notch);
    r -= 0.14 * smooth(0.40, 0.55, gnoise2(s * 0.55 + 7.7, y * 0.75 - 3.3)) * (0.5 + 0.5 * f);
    r -= (0.10 + 0.12 * windward) * Math.exp(-Math.pow((y - (gY(cx, cz) - y0 + 0.75)) / 0.42, 2));
    for (const C of collapses) {
      const across = Math.exp(-Math.pow(angD(th, C.az * Math.PI / 180) / (C.w / (base * 0.42)), 2) * 1.6);
      r -= (C.bite ?? 1.4) * across * smooth(C.depth + 1.2, C.depth * 0.35, Ht - y);
    }
    return Math.max(0.3, r);
  };
  const pos = [], nrm = [], ao = [], idx = [], G = [];
  for (let j = 0; j <= NV; j++) {
    const row = [];
    for (let i = 0; i < NA; i++) {
      const th = (i / NA) * Math.PI * 2, yTop = topAt(th) - y0 + gY(cx, cz), y = (j / NV) * yTop, yy = y - (gY(cx, cz) - y0);
      const r = rad(th, Math.max(0, yy) + 1e-3), wa = th + yaw;
      row.push([cx + Math.cos(wa) * r, y0 + y, cz + Math.sin(wa) * r, r]);
    }
    G.push(row);
  }
  const idxOf = (j, i) => j * NA + ((i + NA) % NA);
  for (let j = 0; j <= NV; j++) for (let i = 0; i < NA; i++) {
    const p = G[j][i], pa = G[j][(i + 1) % NA], pb = G[j][(i - 1 + NA) % NA], pc = G[Math.min(NV, j + 1)][i], pd = G[Math.max(0, j - 1)][i];
    const ex = [pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]], ey = [pc[0] - pd[0], pc[1] - pd[1], pc[2] - pd[2]];
    let n = [ey[1] * ex[2] - ey[2] * ex[1], ey[2] * ex[0] - ey[0] * ex[2], ey[0] * ex[1] - ey[1] * ex[0]];
    if (n[0] * (p[0] - cx) + n[2] * (p[2] - cz) < 0) n = [-n[0], -n[1], -n[2]];
    const l = Math.hypot(...n); n = l > 1e-9 ? n.map((v) => v / l) : [0, 1, 0];
    pos.push(p[0], p[1], p[2]); nrm.push(n[0], n[1], n[2]);
    const rAvg = (pa[3] + pb[3] + pc[3] + pd[3]) / 4, hy = p[1] - y0;
    ao.push(clamp((0.82 - 2.2 * (rAvg - p[3]) + 0.1 * clamp(hy / Ht)) * (0.7 + 0.3 * smooth(0.0, 1.0, hy - 0.35)), 0.32, 1.0));
  }
  for (let j = 0; j < NV; j++) for (let i = 0; i < NA; i++) { const a = idxOf(j, i), b2 = idxOf(j, i + 1), c = idxOf(j + 1, i), d = idxOf(j + 1, i + 1); idx.push(a, b2, c, b2, d, c); }
  const ringTop = G[NV], base0 = pos.length / 3, NR = 5;
  const medTop = ringTop.map((p) => p[1]).sort((p, q) => p - q)[Math.floor(NA * 0.5)], ctrY = medTop - 0.25, topIdx = [];
  for (let k = 0; k <= NR; k++) {
    const f = Math.max(0.04, 1 - k / NR), row = [];                       // innermost ring keeps 4% radius: no degenerate fan
    for (let i = 0; i < NA; i++) {
      const p = ringTop[i], x = cx + (p[0] - cx) * f, z = cz + (p[2] - cz) * f;
      // inner rings do not follow the collapse dips ray by ray (a radial fan of stripes); they form a slightly dished table
      const y = k === 0 ? p[1] : Math.min(mix(ctrY, medTop, Math.pow(f, 0.6)), p[1] + (1 - f) * 2.2) + 0.05 * gnoise2(x * 1.3 + seed, z * 1.3);
      row.push(pos.length / 3); pos.push(x, y, z); nrm.push(0, 1, 0); ao.push(k === 0 ? 0.8 : 0.95);
    }
    topIdx.push(row);
  }
  for (let k = 0; k < NR; k++) for (let i = 0; i < NA; i++) { const a = topIdx[k][i], b2 = topIdx[k][(i + 1) % NA], c = topIdx[k + 1][i], d = topIdx[k + 1][(i + 1) % NA]; idx.push(a, c, b2, b2, c, d); }
  const acc = new Float64Array((pos.length / 3 - base0) * 3);
  for (let k = 0; k < NR; k++) for (let i = 0; i < NA; i++) {
    for (const [A, B, Cc] of [[topIdx[k][i], topIdx[k + 1][i], topIdx[k][(i + 1) % NA]], [topIdx[k][(i + 1) % NA], topIdx[k + 1][i], topIdx[k + 1][(i + 1) % NA]]]) {
      const u = [pos[B * 3] - pos[A * 3], pos[B * 3 + 1] - pos[A * 3 + 1], pos[B * 3 + 2] - pos[A * 3 + 2]], v = [pos[Cc * 3] - pos[A * 3], pos[Cc * 3 + 1] - pos[A * 3 + 1], pos[Cc * 3 + 2] - pos[A * 3 + 2]];
      let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if (n[1] < 0) n = n.map((q) => -q);
      for (const X of [A, B, Cc]) { const q = (X - base0) * 3; acc[q] += n[0]; acc[q + 1] += n[1]; acc[q + 2] += n[2]; }
    }
  }
  for (let q = 0; q < acc.length / 3; q++) {
    const l = Math.hypot(acc[q * 3], acc[q * 3 + 1], acc[q * 3 + 2]), X = (base0 + q) * 3;
    if (l < 1e-9) { nrm[X] = 0; nrm[X + 1] = 1; nrm[X + 2] = 0; continue; }
    nrm[X] = acc[q * 3] / l; nrm[X + 1] = acc[q * 3 + 1] / l; nrm[X + 2] = acc[q * 3 + 2] / l;
  }
  for (const Rb of o.rubble || []) {
    const th = Rb.az * Math.PI / 180 + yaw, R = Rb.r ?? 1.6, Hh = Rb.h ?? 1.0, n = 22, r0 = rad(Rb.az * Math.PI / 180, 0.5) + R * 0.55;
    const mx = cx + Math.cos(th) * r0, mz = cz + Math.sin(th) * r0, vid = [];
    const hAt = (u, v) => { const d = Math.hypot(u, v) / R; return Hh * Math.max(0, 1 - d * d) * (0.75 + 0.5 * gnoise2(u * 1.7 + seed, v * 1.7 - seed)) + 0.18 * Math.max(0, 1 - d) * (1 - Math.abs(gnoise2(u * 3.3 - seed, v * 3.3 + 2.0))) - 0.12; };
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const u = mix(-R * 1.15, R * 1.15, i / n), v = mix(-R * 1.15, R * 1.15, j / n), x = mx + u, z = mz + v, e = 0.06, h = hAt(u, v);
      const dhx = (hAt(u + e, v) - hAt(u - e, v)) / (2 * e), dhz = (hAt(u, v + e) - hAt(u, v - e)) / (2 * e), l = Math.hypot(dhx, 1, dhz);
      vid.push(pos.length / 3); pos.push(x, gY(x, z) + h, z); nrm.push(-dhx / l, 1 / l, -dhz / l); ao.push(0.7 + 0.3 * clamp(h / Hh));
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = j * (n + 1) + i; idx.push(vid[k], vid[k + n + 1], vid[k + 1], vid[k + 1], vid[k + n + 1], vid[k + n + 2]); }
  }
  orientIndex(pos, nrm, idx);
  return {pos, nrm, ao, idx, y0};
}

/**
 * plankHull(b, spec) — flat-bottomed, square-ended plank hull on the wood batch: flared sides of `strakes` clinker strakes
 * (each lower edge laps outward by `lap` m and shows a dark seam), inner skin, gunwale capping rail following the sheer, raked
 * transoms with cross seams and a capping strip, inner ribs and thwarts, optional drifted snow in the bottom (snow depth m). Nothing is a box with one colour: every plank has its
 * own id (aMat.w) so the wood material can vary tone per plank. spec: {pos (keel centre at y = bottom), yaw, len 8, beam 2.2,
 * flare 0.17 (extra half beam at the top), depth 0.61, strakes 4, lap 0.012, sheer 0.06, rake 0.12, ribs 7, thwarts:[a...], segs 24, snow 0}.
 * Returns {gunwaleY(a), halfBeam(y)} in local coordinates for snow / props placement.
 */
export function plankHull(b, spec) {
  const len = spec.len ?? 8, beam = spec.beam ?? 2.2, flare = spec.flare ?? 0.17, depth = spec.depth ?? 0.61, NS = spec.strakes ?? 4;
  const lap = spec.lap ?? 0.012, sheerH = spec.sheer ?? 0.06, rake = spec.rake ?? 0.12, NA = spec.segs ?? 24;
  if (!(len >= 2 && len <= 40 && beam >= 0.8 && beam <= 10 && depth >= 0.2 && depth <= 3 && NS >= 2 && NS <= 12)) throw new RangeError('plankHull: len 2..40, beam 0.8..10, depth 0.2..3 m, strakes 2..12');
  const F = frame(spec.pos, spec.yaw ?? 0), wb = b.wood || b;
  const Y0 = 0, YT = depth, half = len / 2;
  const hw = (y) => mix(beam / 2 - flare / 2, beam / 2 + flare / 2, clamp((y - Y0) / (YT - Y0)));
  const sheer = (a) => sheerH * Math.pow(a / half, 2);
  const aEnd = (y) => half + rake * clamp((y - Y0) / (YT - Y0));
  const yAt = (a, f) => Y0 + (YT + sheer(a) - Y0) * f;
  const wc = spec.color || [1.6, 1.75, 2.0], inner = [0.95, 1.05, 1.25], rail = [1.6, 1.7, 1.9];
  const tilt = -flare / (YT - Y0);
  for (const sg of [-1, 1]) {
    for (let k = 0; k < NS; k++) {
      const f0 = k / NS, f1 = (k + 1) / NS;
      for (let i = 0; i < NA; i++) {
        const A0 = mix(-aEnd(yAt(0, f0)), aEnd(yAt(0, f0)), i / NA), A1 = mix(-aEnd(yAt(0, f0)), aEnd(yAt(0, f0)), (i + 1) / NA);
        const pt = (a, f, lp, inset) => { const y = yAt(a, f); return F.p(a, y, sg * (hw(y) + lp - inset)); };
        const n0 = F.n(0, tilt, sg), nl = Math.hypot(...n0), no = n0.map((v) => v / nl);
        const id = k + (sg > 0 ? 10 : 20);
        quad(wb, pt(A0, f0, lap, 0), pt(A1, f0, lap, 0), pt(A1, f1, 0, 0), pt(A0, f1, 0, 0), no, wc, [0.9, 1, 0, id], [[k + 0.02, A0], [k + 0.02, A1], [k + 0.98, A1], [k + 0.98, A0]]);
        quad(wb, pt(A0, f0, 0, 0), pt(A1, f0, 0, 0), pt(A1, f0, lap, 0), pt(A0, f0, lap, 0), F.n(0, -1, 0), wc, [0.9, 1, 0, id], [[k, A0], [k, A1], [k + 0.05, A1], [k + 0.05, A0]]);
        quad(wb, pt(A1, f0, 0, 0.045), pt(A0, f0, 0, 0.045), pt(A0, f1, 0, 0.045), pt(A1, f1, 0, 0.045), [-no[0], no[1], -no[2]], inner, [0.9, 1, 0, id + 30], [[k + 0.02, A1], [k + 0.02, A0], [k + 0.98, A0], [k + 0.98, A1]]);
      }
    }
    for (let i = 0; i < NA; i++) {                               // gunwale capping rail (5 cm x 8 cm) along the sheer
      const a0 = mix(-half - rake, half + rake, i / NA), a1 = mix(-half - rake, half + rake, (i + 1) / NA);
      const y0 = YT + sheer(a0), y1 = YT + sheer(a1), cI = sg * (hw(YT) - 0.055), cO = sg * (hw(YT) + 0.03), P = F.p;
      const lo = Math.min(cI, cO), hi = Math.max(cI, cO);
      quad(wb, P(a0, y0 + 0.05, lo), P(a1, y1 + 0.05, lo), P(a1, y1 + 0.05, hi), P(a0, y0 + 0.05, hi), F.n(0, 1, 0), rail, [0.9, 1, 0, 40 + sg], [[0.1, a0], [0.1, a1], [0.9, a1], [0.9, a0]]);
      quad(wb, P(a0, y0 - 0.02, cO), P(a1, y1 - 0.02, cO), P(a1, y1 + 0.05, cO), P(a0, y0 + 0.05, cO), F.n(0, 0, sg), rail, [0.9, 1, 0, 42 + sg], [[0.1, a0], [0.1, a1], [0.9, a1], [0.9, a0]]);
      quad(wb, P(a1, y1 - 0.02, cI), P(a0, y0 - 0.02, cI), P(a0, y0 + 0.05, cI), P(a1, y1 + 0.05, cI), F.n(0, 0, -sg), rail, [0.9, 1, 0, 44 + sg], [[0.1, a1], [0.1, a0], [0.9, a0], [0.9, a1]]);
    }
    const nr = spec.ribs ?? 7;
    for (let r = 0; r < nr; r++) {                               // inner ribs
      const a = mix(-half * 0.75, half * 0.75, nr > 1 ? r / (nr - 1) : 0.5), yb2 = Y0 + 0.05, yt2 = YT + sheer(a) - 0.03;
      const cB = sg * (hw(yt2) - 0.05) - sg * 0.045, cA2 = sg * (hw(yb2) - 0.05) - sg * 0.045, cBo = sg * (hw(yt2) - 0.05), P = F.p;
      quad(wb, P(a - 0.03, yb2, cA2), P(a + 0.03, yb2, cA2), P(a + 0.03, yt2, cB), P(a - 0.03, yt2, cB), F.n(0, 0, -sg), [1.1, 1.2, 1.35], [0.9, 1, 0, 50 + r], [[0.2, 0], [0.8, 0], [0.8, 0.6], [0.2, 0.6]]);
      quad(wb, P(a - 0.03, yt2, cB), P(a + 0.03, yt2, cB), P(a + 0.03, yt2, cBo), P(a - 0.03, yt2, cBo), F.n(0, 1, 0), [1.1, 1.2, 1.35], [0.9, 1, 0, 50 + r]);
    }
  }
  for (const se of [-1, 1]) {                                    // raked transoms (outer + inner face, cross seams)
    for (let k = 0; k < NS; k++) {
      const y0 = yAt(half, k / NS), y1 = yAt(half, (k + 1) / NS), P = (y, c, inset) => F.p(se * (aEnd(y) - inset), y, c);
      quad(wb, P(y0, -hw(y0), 0), P(y0, hw(y0), 0), P(y1, hw(y1), 0), P(y1, -hw(y1), 0), F.n(se, rake / depth, 0), wc, [0.9, 1, 0, 60 + k + se * 5], [[k + 0.02, -beam / 2], [k + 0.02, beam / 2], [k + 0.98, beam / 2], [k + 0.98, -beam / 2]]);
      quad(wb, P(y0, hw(y0) - 0.04, 0.045), P(y0, -hw(y0) + 0.04, 0.045), P(y1, -hw(y1) + 0.04, 0.045), P(y1, hw(y1) - 0.04, 0.045), F.n(-se, rake / depth, 0), inner, [0.9, 1, 0, 70 + k], [[k + 0.02, beam / 2], [k + 0.02, -beam / 2], [k + 0.98, -beam / 2], [k + 0.98, beam / 2]]);
    }
    const yT = YT + sheer(half);
    boxF(wb, F, se > 0 ? aEnd(yT) - 0.07 : -aEnd(yT) - 0.02, se > 0 ? aEnd(yT) + 0.02 : -aEnd(yT) + 0.07, yT - 0.02, yT + 0.05, -hw(yT) - 0.02, hw(yT) + 0.02, rail, [0.9, 1, 0, 80 + se], ['bottom']);
  }
  quad(wb, F.p(-half, Y0 + 0.02, -hw(Y0) + 0.05), F.p(half, Y0 + 0.02, -hw(Y0) + 0.05), F.p(half, Y0 + 0.02, hw(Y0) - 0.05), F.p(-half, Y0 + 0.02, hw(Y0) - 0.05), F.n(0, 1, 0), inner, [0.9, 1, 0, 85], [[0, -half], [0, half], [6, half], [6, -half]]);
  if (spec.snow && b.snow) {                                      // drifted snow in the bottom: a heightfield, deeper downwind (+a)
    const sd = spec.snow, na = Math.max(8, Math.ceil(len / 0.25)), nc = Math.max(4, Math.ceil(beam / 0.25)), vid = [];
    if (!(sd > 0 && sd <= depth * 0.9)) throw new RangeError('plankHull: snow depth must be in (0, 0.9 x depth]');
    const H = (a, u) => { const side = Math.pow(Math.abs(u), 6); return sd * (0.55 + 0.45 * smooth(-half, half, a)) * (0.85 + 0.15 * gnoise2(a * 1.7 + 3.1, u * 2.3)) + 0.12 * sd * side; };
    for (let j = 0; j <= nc; j++) for (let i = 0; i <= na; i++) {
      const a = mix(-half + 0.08, half - 0.08, i / na), u = mix(-1, 1, j / nc), y = Y0 + 0.02 + H(a, u), c = u * (hw(y) - 0.07);
      const e = 0.04, dha = (H(a + e, u) - H(a - e, u)) / (2 * e), dhc = (H(a, Math.min(1, u + 0.05)) - H(a, Math.max(-1, u - 0.05))) / (0.1 * (hw(y) - 0.07) || 1);
      let n = F.n(-dha, 1, -dhc); const l = Math.hypot(...n); n = n.map((v) => v / l);
      vid.push(b.snow.vert(F.p(a, y, c), n, [0.86, 0.88, 0.92], [0.4, 1, 0, 0], [a, c]));
    }
    for (let j = 0; j < nc; j++) for (let i = 0; i < na; i++) { const k = j * (na + 1) + i; b.snow.tri(vid[k], vid[k + na + 1], vid[k + 1]); b.snow.tri(vid[k + 1], vid[k + na + 1], vid[k + na + 2]); }
  }
  for (const a of spec.thwarts || [-len * 0.21, len * 0.21]) boxF(wb, F, a - 0.13, a + 0.13, YT * 0.72, YT * 0.72 + 0.045, -hw(YT * 0.72) + 0.06, hw(YT * 0.72) - 0.06, [1.5, 1.65, 1.85], [0.9, 1, 0, 90 + a], ['bottom']);
  return {gunwaleY: (a) => YT + sheer(a) + 0.05, halfBeam: hw};
}

/** Build meshes from batches (finishBatch first). mats: {wall, snow, hole, wood, brick?}; empty batches are skipped. */
export function buildBlockMeshes(THREE, b, mats) {
  const out = {};
  for (const k of Object.keys(b)) {
    if (!b[k].count) continue;
    const mat = mats[k] || (k === 'brick' ? mats.wall : null);
    if (!mat) throw new Error(`buildBlockMeshes: no material for batch "${k}"`);
    finishBatch(b[k]);
    const mesh = new THREE.Mesh(b[k].build(THREE), mat); mesh.name = 'kits.far.' + k; mesh.castShadow = mesh.receiveShadow = k !== 'hole';
    out[k] = mesh;
  }
  return out;
}
