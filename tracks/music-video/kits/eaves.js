// Author: suwubee

// overlapping channel + cover tile rows near the eave (real curved tiles, merged into ONE geometry with per-tile seeds
// for the MV moss/soot/wet variation), 滴水 drip-lip tiles and 瓦当 end discs along the eave (the drips fall from the
// lips), textured tile field for the upper slope, ridge with curled ends, barge boards, and the timber structure seen
// from below: rafters (椽), roof boards (望板), round purlin (檩) + eave beam (枋) on the posts.
//
//   import { buildEaves } from './eaves.js';

//   scene.add(E.object);  E.dripPoints -> [[x,y,z], ...] (channel lips, straight part of the eave);  E.roofY(x, z)
//   E.beam: { x, y0, y1 } (the eave beam the lantern hangs from)
import * as THREE_NS from '../engine/vendor/three.module.js';
import * as G from '../engine/geo.js';
import { makeRng, hashString } from '../engine/noise.js';
import { mergeGeometries } from '../engine/vendor/BufferGeometryUtils.js';

const TAU = Math.PI * 2;
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);

export const EAVES_DEFAULTS = {
  eaveX: 2.4, eaveY: 3.0, ridgeX: 0, ridgeY: 4.3, backX: -2.4,
  z0: -3, z1: 3,
  lift: 0.34, out: 0.16, liftStart: 2,      // upturned corners (|z| > liftStart)
  pitch: 0.23, exposed: 0.082, detailRows: 9, detailZ: [-3, 3],   // real tile rows only where cameras see them
  tile: { width: 0.2, length: 0.21, thickness: 0.011, sagitta: 0.03 },
  roofDepth: 0.2,                               // tiles + bedding + boards above the rafter underside
  purlinX: 1.9, beamY0: 2.7, beamY1: 2.95, postTopY: 2.7,
  wallX: 1.5,
};

/**
 * Roof surface: s ∈ [0,1] from the eave (0) to the ridge (1) on the east slope; returns [x, y] at longitudinal z.
 * The concave profile (steep at the ridge, 13° at the eave) + corner lift/flare.
 */
export function makeRoofProfile(o) {
  const H = o.ridgeY - o.eaveY, Dx = o.eaveX - o.ridgeX;
  const e = (z) => { const a = Math.max(0, (Math.abs(z) - o.liftStart) / (Math.max(Math.abs(o.z0), Math.abs(o.z1)) - o.liftStart)); return Math.pow(Math.min(a, 1.15), 2.4); };
  const P = (z, s) => {
    const k = e(z), w = (1 - s) * (1 - s);
    return [o.eaveX - s * Dx + o.out * k * w, o.eaveY + H * (0.55 * s + 0.45 * s * s) + o.lift * k * w];
  };
  /** height of the roof surface at world x (inverse along s, straight part) */
  const yAt = (x, z = 0) => {
    const s = clamp((o.eaveX - x) / Dx, 0, 1);
    return P(z, s)[1];
  };
  // arc length along s at z (for tile rows)
  const arc = (z, s) => { let a = 0, p = P(z, 0); const n = 60; for (let i = 1; i <= n; i++) { const q = P(z, (s * i) / n); a += Math.hypot(q[0] - p[0], q[1] - p[1]); p = q; } return a; };
  const sAtArc = (z, a) => { let lo = 0, hi = 1; for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (arc(z, m) < a) lo = m; else hi = m; } return (lo + hi) / 2; };
  return { P, e, yAt, arc, sAtArc, H, Dx };
}

/** frame (origin, X across = +z, Y normal, Z downhill) of the roof at (z, s) */
function frameAt(R, z, s) {
  const h = 1e-3;
  const p = R.P(z, s), ps = R.P(z, Math.min(1, s + h)), ms = R.P(z, Math.max(0, s - h));
  const pz1 = R.P(z + h, s), pz0 = R.P(z - h, s);
  const up = new THREE_NS.Vector3(ps[0] - ms[0], ps[1] - ms[1], 0).normalize();        // uphill
  const across = new THREE_NS.Vector3(pz1[0] - pz0[0], pz1[1] - pz0[1], 2 * h).normalize();
  const n = new THREE_NS.Vector3().crossVectors(across, up).normalize();
  if (n.y < 0) n.negate();
  const down = up.clone().negate();
  return { o: new THREE_NS.Vector3(p[0], p[1], z), X: across, Y: n, Z: down };
}

/** 滴水 drip-lip tile end: curved plate hanging down with a pointed (如意-like) lower outline */
function dripLipGeometry(w = 0.2, h = 0.075, t = 0.012, sag = 0.03) {
  const pos = [], idx = [], uv = [];
  const nA = 12, nH = 5;
  const Rw = (w * w / 4 + sag * sag) / (2 * sag), half = Math.asin(w / 2 / Rw);
  const outline = (u) => { const a = Math.abs(u); return h * (0.55 + 0.45 * Math.pow(1 - a, 1.6)) - 0.012 * Math.cos(u * Math.PI * 3) * (1 - a); };
  for (const layer of [0, 1]) {
    for (let j = 0; j <= nH; j++) for (let i = 0; i <= nA; i++) {
      const u = -1 + 2 * i / nA, ang = u * half;
      const x = Math.sin(ang) * Rw, yArc = Rw - Math.cos(ang) * Rw;
      const hh = outline(u) * (j / nH);
      pos.push(x, yArc - hh, layer * t); uv.push(x, hh + layer * 0.3);
    }
  }
  const C = nA + 1, Lb = (nH + 1) * C;
  for (let j = 0; j < nH; j++) for (let i = 0; i < nA; i++) {
    const a = j * C + i, b = a + 1, c = a + C, d = c + 1;
    idx.push(a, c, b, b, c, d);
    idx.push(Lb + a, Lb + b, Lb + c, Lb + b, Lb + d, Lb + c);
  }
  // rim (lower outline + sides)
  for (let i = 0; i < nA; i++) { const a = nH * C + i, b = a + 1; idx.push(a, b, Lb + a, b, Lb + b, Lb + a); }
  for (const i of [0, nA]) for (let j = 0; j < nH; j++) { const a = j * C + i, c = a + C; if (i === 0) idx.push(a, Lb + a, c, c, Lb + a, Lb + c); else idx.push(a, c, Lb + a, c, Lb + c, Lb + a); }
  const g = new THREE_NS.BufferGeometry();
  g.setAttribute('position', new THREE_NS.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE_NS.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/** 瓦当: round end disc with a raised rim and a central boss (faces +z local) */
function tileEndGeometry(r = 0.066, t = 0.014) {
  const prof = [[0, t + 0.004], [0.012, t + 0.004], [0.016, t + 0.002], [0.02, t], [r - 0.012, t], [r - 0.009, t + 0.0035], [r - 0.004, t + 0.0035], [r, t], [r, 0], [0, 0]];
  const g = G.lathe(prof.slice().reverse(), { segments: 24, edges: [0.1, 0.5] });
  g.rotateX(Math.PI / 2);              // axis +y -> +z
  return g;
}

/** merge keeping exactly `keep` attributes (missing ones zero-filled), all converted to non-indexed */
export function mergeKeep(geos, keep = ['position', 'normal', 'uv', 'mvEdge', 'mvSeed']) {
  const sizes = { position: 3, normal: 3, uv: 2, mvEdge: 1, mvSeed: 1 };
  const list = geos.map((g0) => {
    const g = g0.index ? g0.toNonIndexed() : g0;
    for (const k of Object.keys(g.attributes)) if (!keep.includes(k)) g.deleteAttribute(k);
    for (const k of keep) if (!g.attributes[k]) g.setAttribute(k, new THREE_NS.Float32BufferAttribute(new Float32Array(g.attributes.position.count * (sizes[k] || 1)), sizes[k] || 1));
    return g;
  });
  const m = mergeGeometries(list, false);
  m.computeBoundingSphere();
  return m;
}

/**
 * buildEaves(ctx, M, opts) -> { object, dripPoints, roofY(x,z), profile, beam, materials, dispose }
 */
export function buildEaves(ctx, M, opts = {}) {
  const THREE = ctx.THREE || THREE_NS;
  const o = { ...EAVES_DEFAULTS, ...opts, tile: { ...EAVES_DEFAULTS.tile, ...(opts.tile || {}) } };
  const R = makeRoofProfile(o);
  const rng = makeRng(hashString('eaves:' + (o.seed ?? 1)));
  const root = new THREE.Group(); root.name = 'eaves';
  const geos = { tiles: [], lips: [], ends: [], wood: [], boards: [], field: [] };

  // ---------------- tiles (detailed rows near the eave) ----------------
  const tileMat = M.tileClay({ seed: 5, wet: 0.6 });
  const base = G.curvedTile({ ...o.tile, arcSegs: 4, lenSegs: 1 });
  const cover = G.curvedTile({ ...o.tile, width: o.tile.width * 0.78, sagitta: o.tile.sagitta * 0.85, arcSegs: 4, lenSegs: 1 });
  const cols = Math.floor((o.z1 - o.z0 - 0.06) / o.pitch);
  const zStart = (o.z0 + o.z1) / 2 - (cols - 1) * o.pitch / 2;
  const channelZ = [];
  for (let c = 0; c < cols; c++) channelZ.push(zStart + c * o.pitch);
  const mats = { ch: [], cv: [] };
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(1, 1, 1);
  const B = new THREE.Matrix4();
  const place = (z, a, cov, list, dz = 0) => {
    const s = R.sAtArc(z, a);
    const F = frameAt(R, z, s);
    B.makeBasis(F.X, F.Y, F.Z);
    q.setFromRotationMatrix(B);
    e.set(-Math.atan2(o.tile.thickness * 1.25, o.exposed * 2.2) + (rng() - 0.5) * 0.03, (rng() - 0.5) * 0.02, (cov ? Math.PI : 0) + (rng() - 0.5) * 0.03);
    q.multiply(new THREE.Quaternion().setFromEuler(e));
    const lift = cov ? o.tile.sagitta * 0.9 + o.tile.thickness * 1.4 : 0;
    const p = F.o.clone().addScaledVector(F.Y, lift + o.tile.thickness * 0.5).addScaledVector(F.X, (rng() - 0.5) * 0.004 + dz).addScaledVector(F.Z, (rng() - 0.5) * 0.004);
    sc.set(1 + (rng() - 0.5) * 0.04, 1, 1 + (rng() - 0.5) * 0.05);
    m4.compose(p, q, sc);
    list.push(m4.clone());
    return F;
  };
  const inDetail = (z) => z >= o.detailZ[0] && z <= o.detailZ[1];
  for (let r = 0; r < o.detailRows; r++) {
    const a = r * o.exposed + o.tile.length * 0.42;
    for (const z of channelZ) if (inDetail(z)) place(z, a, false, mats.ch);
    for (let c = 0; c < cols - 1; c++) if (inDetail(channelZ[c] + o.pitch / 2)) place(channelZ[c] + o.pitch / 2, a + 0.012, true, mats.cv);
  }
  const mergeFrom = (geo, list) => {
    const im = new THREE.InstancedMesh(geo, tileMat, list.length);
    list.forEach((m, i) => im.setMatrixAt(i, m));
    const g = G.mergeInstanced(im);
    im.dispose();
    return g;
  };
  // drip lips (滴水) under each channel's first tile, and 瓦当 on each first-row cover tile
  const lipGeo = dripLipGeometry(o.tile.width * 1.02, 0.07, 0.012, o.tile.sagitta);
  const endGeo = tileEndGeometry(0.064, 0.014);
  const lipMats = [], endMats = [];
  const dripPoints = [], lipPoints = [];
  for (const z of channelZ) {
    const F = frameAt(R, z, 0);
    // the lip hangs from the lower end of the first channel tile, turned down ~70° from the tile plane
    const tip = F.o.clone().addScaledVector(F.Z, 0.035).addScaledVector(F.Y, o.tile.thickness * 0.2);
    B.makeBasis(F.X, F.Y, F.Z); q.setFromRotationMatrix(B);
    q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.42 + (rng() - 0.5) * 0.06, 0, (rng() - 0.5) * 0.04)));
    m4.compose(tip, q, new THREE.Vector3(1, 1, 1));
    lipMats.push(m4.clone());
    // the lowest point of the lip = the drip point (a few mm under the pointed tip)
    const low = new THREE.Vector3(0, -0.07, 0.006).applyMatrix4(m4);
    lipPoints.push([low.x, low.y - 0.003, low.z]);
    if (Math.abs(z) <= o.liftStart + 0.05) dripPoints.push([low.x, low.y - 0.003, low.z]);
  }
  for (let c = 0; c < cols - 1; c++) {
    const z = channelZ[c] + o.pitch / 2;
    const F = frameAt(R, z, 0);
    const p = F.o.clone().addScaledVector(F.Z, 0.028).addScaledVector(F.Y, o.tile.sagitta * 0.55 + 0.012);
    B.makeBasis(F.X, F.Y, F.Z); q.setFromRotationMatrix(B);
    q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12 + (rng() - 0.5) * 0.05, 0, (rng() - 0.5) * 0.05)));
    m4.compose(p, q, new THREE.Vector3(1, 1, 1));
    endMats.push(m4.clone());
  }
  if (!lipGeo.attributes.mvEdge) lipGeo.setAttribute('mvEdge', new THREE.Float32BufferAttribute(new Float32Array(lipGeo.attributes.position.count).fill(0.5), 1));
  const tilesGeo = mergeKeep([mergeFrom(base, mats.ch), mergeFrom(cover, mats.cv), mergeFrom(lipGeo, lipMats), mergeFrom(endGeo, endMats)]);
  const tiles = new THREE.Mesh(tilesGeo, tileMat); tiles.name = 'eaves.tiles';
  tiles.castShadow = true; tiles.receiveShadow = true;
  root.add(tiles);

  // ---------------- tile field (upper slope, textured) + west slope + ridge ----------------
  const fieldMat = M.roofTile({ seed: 3, wet: 0.6 });
  const aDetail = o.detailRows * o.exposed + o.tile.length * 0.2;
  const fieldGeo = (() => {
    const pos = [], uv = [], idx = [];
    const nz = 64, ns = 26;
    for (let j = 0; j <= ns; j++) {
      for (let i = 0; i <= nz; i++) {
        const z = o.z0 + (o.z1 - o.z0) * (i / nz);
        // outside the detailed span the textured field reaches down to the lip row
        const kd = Math.min(1, Math.max(0, (z - (o.detailZ[0] - 0.35)) / 0.35)) * Math.min(1, Math.max(0, ((o.detailZ[1] + 0.35) - z) / 0.35));
        const s0 = R.sAtArc(z, 0.02 + (aDetail - 0.14) * kd);
        const s = s0 + (1 - s0) * (j / ns);
        const p = R.P(z, s);
        pos.push(p[0], p[1] + 0.028, z); uv.push(z, R.arc(z, s));
      }
    }
    for (let j = 0; j < ns; j++) for (let i = 0; i < nz; i++) { const a = j * (nz + 1) + i, b = a + 1, c = a + nz + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    // west slope (mirror across the ridge, down to backX), coarse
    const off = pos.length / 3;
    const Dw = o.ridgeX - o.backX;
    for (let j = 0; j <= 10; j++) for (let i = 0; i <= 16; i++) {
      const z = o.z0 + (o.z1 - o.z0) * (i / 16), s = j / 10;
      const ss = 1 - s;                                              // 1 at ridge .. 0 at the back eave
      const H = o.ridgeY - o.eaveY;
      const xx = o.ridgeX - (1 - ss) * Dw, yy = o.eaveY + H * (0.55 * ss + 0.45 * ss * ss) + o.lift * R.e(z) * (1 - ss) * (1 - ss);
      pos.push(xx, yy + 0.028, z); uv.push(z, (1 - ss) * 8.4);
    }
    for (let j = 0; j < 10; j++) for (let i = 0; i < 16; i++) { const a = off + j * 17 + i, b = a + 1, c = a + 17, d = c + 1; idx.push(a, b, c, b, d, c); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  })();
  const field = new THREE.Mesh(fieldGeo, fieldMat); field.name = 'eaves.field';
  field.castShadow = true; field.receiveShadow = true;
  root.add(field);
  // ridge: rounded bar along z with curled ends (纹头脊)
  const ridge = G.ridgeGeometry({ length: o.z1 - o.z0 + 0.5, height: 0.3, width: 0.26, curl: 0.42, segs: 64 });
  ridge.rotateY(Math.PI / 2); ridge.translate(o.ridgeX, o.ridgeY + 0.1, (o.z0 + o.z1) / 2);
  const ridgeMesh = new THREE.Mesh(ridge, M.tileClay({ seed: 8, wet: 0.5, color: new THREE.Color().setRGB(0.85, 0.85, 0.85) }));
  ridgeMesh.name = 'eaves.ridge'; ridgeMesh.castShadow = true; root.add(ridgeMesh);

  // ---------------- timber under the roof: rafters, boards, purlin, beam, eave board, barge boards ----------------
  const woodMat = M.wood({ variant: 'hardwood', seed: 21, edgeWear: 0.35, color: new THREE.Color().setRGB(0.8, 0.78, 0.76) });
  const boardMat = M.wood({ variant: 'weathered', seed: 22, color: new THREE.Color().setRGB(0.55, 0.5, 0.46) });
  const wood = [];
  const yU = (x, z) => R.P(z, clamp((o.eaveX - x) / R.Dx, 0, 1))[1] - o.roofDepth;   // rafter top line (under the boards)
  const rafterW = 0.07, rafterH = 0.078;
  const xTip = o.eaveX + 0.015;
  for (let z = o.z0 + 0.17; z <= o.z1 - 0.1; z += 0.26) {
    const zz = z + (rng() - 0.5) * 0.012;
    // two straight pieces: wall -> purlin, purlin -> tip (following the roof line at the joints)
    const pts = [[o.wallX, yU(o.wallX, zz)], [o.purlinX, yU(o.purlinX, zz)], [xTip, yU(xTip, zz) + 0.01]];
    for (let k = 0; k < 2; k++) {
      const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
      const len = Math.hypot(x1 - x0, y1 - y0) + (k === 0 ? 0.02 : 0);
      const g = G.bevelBox(len, rafterH, rafterW, 0.006, 2, { grain: 'x', uvSeed: Math.floor(rng() * 1000) });
      g.translate(len / 2, -rafterH / 2, 0);
      g.rotateZ(Math.atan2(y1 - y0, x1 - x0) + (rng() - 0.5) * 0.004);
      g.translate(x0, y0, zz);
      wood.push(g);
    }
  }
  // purlin (round, along z) and the eave beam (枋) under it; small filler board between
  const pur = G.lathe([[0, 0], [0.1, 0], [0.1, o.z1 - o.z0 + 0.3], [0, o.z1 - o.z0 + 0.3]], { segments: 20 });
  pur.rotateX(Math.PI / 2); pur.translate(o.purlinX, yU(o.purlinX, 0) - 0.1, o.z0 - 0.15);
  wood.push(pur);
  const beamLen = o.z1 - o.z0 + 0.2;
  const beam = G.bevelBox(0.17, o.beamY1 - o.beamY0, beamLen, 0.008, 2, { grain: 'z' }); beam.translate(o.purlinX, (o.beamY0 + o.beamY1) / 2, (o.z0 + o.z1) / 2);
  wood.push(beam);
  const filler = G.bevelBox(0.05, yU(o.purlinX, 0) - 0.18 - o.beamY1, beamLen, 0.004, 1, { grain: 'z' });
  filler.translate(o.purlinX, (o.beamY1 + yU(o.purlinX, 0) - 0.18) / 2, (o.z0 + o.z1) / 2);
  wood.push(filler);
  // eave board (连檐) on top of the rafter tips, and fascia (封檐板) along the tips
  const fas = G.bevelBox(0.03, 0.12, o.z1 - o.z0, 0.004, 1, { grain: 'z' });
  fas.rotateZ(-0.22); fas.translate(xTip + 0.012, yU(xTip, 0) + 0.02, (o.z0 + o.z1) / 2);
  wood.push(fas);
  // barge boards (博风) along both gable edges, following the slope from the eave corner to the ridge
  for (const zE of [o.z0 - 0.02, o.z1 + 0.02]) {
    const n = 24;
    for (let k = 0; k < n; k++) {
      const s0 = k / n, s1 = (k + 1) / n;
      const p0 = R.P(zE, s0), p1 = R.P(zE, s1);
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + 0.004;
      const g = G.bevelBox(len, 0.28, 0.035, 0.006, 1, { grain: 'x' });
      g.translate(len / 2, -0.1, 0); g.rotateZ(Math.atan2(p1[1] - p0[1], p1[0] - p0[0])); g.translate(p0[0], p0[1], zE);
      wood.push(g);
    }
  }
  const woodMesh = new THREE.Mesh(G.merge(wood), woodMat); woodMesh.name = 'eaves.timber';
  woodMesh.castShadow = true; woodMesh.receiveShadow = true;
  root.add(woodMesh);
  // roof boards (望板) seen between the rafters: a continuous surface just above the rafters, boards along z
  const boardsGeo = (() => {
    const pos = [], uv = [], idx = [];
    const nx = 30, nz = 8;
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = o.wallX + (xTip + 0.02 - o.wallX) * (i / nx), z = o.z0 + (o.z1 - o.z0) * (j / nz);
      pos.push(x, yU(x, z) + 0.002, z); uv.push(x * 1.0, z);
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1; idx.push(a, b, c, b, d, c); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  })();
  const boards = new THREE.Mesh(boardsGeo, boardMat); boards.name = 'eaves.boards';
  boards.castShadow = true; boards.receiveShadow = true;
  root.add(boards);

  return {
    object: root, profile: R, dripPoints, lipPoints, channelZ,
    roofY: (x, z = 0) => R.P(z, clamp((o.eaveX - x) / R.Dx, 0, 1))[1],
    rafterY: yU,
    beam: { x: o.purlinX, y0: o.beamY0, y1: o.beamY1 },
    materials: { tileMat, fieldMat, woodMat, boardMat },
    meshes: { tiles, field, ridge: ridgeMesh, timber: woodMesh, boards },
    dispose() { root.traverse((m) => { if (m.geometry) m.geometry.dispose(); }); },
  };
}
