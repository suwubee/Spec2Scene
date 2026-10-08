// Author: suwubee
// plants/trees.js — procedural tree / shrub / bamboo / banana generators → Builder (vertex arrays).
// Every generator takes (S = species params, lod, seed): lod 0 = near (< ~16 m: skeleton + many small crisp leaf cards on solid cores),
// lod 1 = mid (skeleton + leaf sprays + clump cards), lod 2 = far-mid (trunk + main limbs + a few large "clump" cards).
// Skeletons are seeded independently of the LOD so the silhouette stays similar when the LOD switches.
import { makeRng } from '../../engine/noise.js';
import { SPECIES } from './species.js';
import { Builder, tube, card, puff, blob, lobe, V, clamp, mix, smooth, randDir, perp } from './build.js';
import { tileRect } from './atlas.js';

// near-LOD leaf sprays: fewer, bigger, crisp leaves (atlas.js) for the small cards used within ~16 m
const NEAR_TILE = { broad: 'broadN', large: 'largeN', fine: 'fineN', maple: 'mapleN', wutong: 'wutongN', bamboo: 'bambooN', willow: 'willowN', pine: 'pineN', ginkgo: 'ginkgoN' };
const nearTile = (t) => NEAR_TILE[t] || t;
const DENSE_TILE = { broad: 'denseN', bamboo: 'denseN', large: 'denseL', fine: 'denseF', maple: 'densePal', wutong: 'densePal', ginkgo: 'denseG' };

const GOLD = 2.399963;
const sub3 = V.sub, add3 = V.add, mul3 = V.mul, norm3 = V.norm;

function pathPoint(path, t) {
  const n = path.length - 1, f = clamp(t) * n, i = Math.min(n - 1, Math.floor(f)), u = f - i;
  return { p: V.lerp(path[i], path[i + 1], u), d: norm3(sub3(path[i + 1], path[i])) };
}
function crownProfile(Y) { const q = (Y - 0.42) / 0.62; return Math.max(0.28, Math.sqrt(Math.max(0, 1 - q * q))); }

function barkOpts(S, o = {}) {
  const b = S.bark;
  return { col: b.col, colTip: o.colTip || [b.col[0] * 0.92, b.col[1] * 0.92, b.col[2] * 0.92], style: b.style, uRep: b.uRep, vScale: b.vScale, ...o };
}

/** trunk centre line: returns { pts, rad } from y = -0.25 to y = h */
function trunk(S, rng, h, nSeg, tipR) {
  const az = rng() * Math.PI * 2, lean = S.lean ?? 0.04, sw = S.sweep ?? 0.2;
  const pts = [], rad = [];
  for (let k = 0; k <= nSeg; k++) {
    const t = k / nSeg, y = -0.25 + (h + 0.25) * t;
    const off = lean * y + sw * 0.5 * Math.sin(t * Math.PI * 1.2 + az) * t;
    const off2 = sw * 0.35 * Math.sin(t * Math.PI * 0.9 + az * 2) * t;
    pts.push([Math.cos(az) * off + Math.cos(az + 1.57) * off2, y, Math.sin(az) * off + Math.sin(az + 1.57) * off2]);
    const flare = 1 + 0.6 * Math.exp(-Math.max(0, y) * 2.6);
    rad.push(Math.max(tipR ?? 0.02, S.trunkR * (1 - (1 - S.taper) * t) * flare));
  }
  return { pts, rad, az };
}

// -------------------------------------------------------------------------------------------------------------
// broadleaf (sub-crown model)
// -------------------------------------------------------------------------------------------------------------
export function genBroadleaf(S, lod, seed) {
  const rS = makeRng(seed), rF = makeRng(seed + ':f' + lod), rT = makeRng(seed + ':t');
  const B = new Builder();
  const near = lod === 0, det = lod <= 1;
  const sides = det ? 7 : 5;
  const tr = trunk(S, rS, S.trunkH, det ? 6 : 4);
  tube(B, tr.pts, tr.rad, sides, barkOpts(S, { flex0: 0, flex1: 0.04, ao: 0.95, tip: 0.8 }));
  const top = tr.pts[tr.pts.length - 1], rTop = tr.rad[tr.rad.length - 1];
  const depth = S.H - S.trunkH * 0.85;
  const crown = { c: [top[0] * 0.6, S.trunkH * 0.85 + depth * 0.5, top[2] * 0.6], R: S.R, H: S.H };
  const subs = [];
  const addSub = (c, r, k = 1) => subs.push({ c, r: r * k });
  const subR = S.R * S.subR;
  const nbL = det ? S.nb : Math.max(2, Math.ceil(S.nb * 0.6));
  for (let k = 0; k < S.leaders; k++) {
    const az = ((k + 0.5 * rS()) / S.leaders) * Math.PI * 2 + tr.az;
    const elev = (S.spread * Math.PI / 180) * (0.7 + 0.6 * rS());
    let dir = [Math.sin(elev) * Math.cos(az), Math.cos(elev), Math.sin(elev) * Math.sin(az)];
    const Ll = (S.H - S.trunkH) * S.leaderLen * (0.82 + 0.3 * rS());
    // tall-trunked species (plane, ginkgo): the leaders leave the trunk at staggered heights (the top `stagger` share of it), not all from one point
    const t0 = 1 - (S.stagger ?? 0) * ((k + 0.5) / S.leaders), top0 = S.stagger ? pathPoint(tr.pts, t0).p : top;
    const segs = det ? 5 : 3, pts = [top0.slice()], rad = [rTop * S.leaderR * (S.stagger ? 0.75 + 0.25 * t0 : 1)];
    let p = top0;
    for (let s = 1; s <= segs; s++) {
      dir = norm3(add3(add3(dir, [0, (S.apical ?? 0.8) / segs * 0.6, 0]), mul3(randDir(rS), 0.1)));
      p = add3(p, mul3(dir, Ll / segs)); pts.push(p); rad.push(rTop * S.leaderR * (1 - 0.8 * s / segs));
    }
    tube(B, pts, rad, Math.max(4, sides - 1), barkOpts(S, { flex0: 0.05, flex1: 0.35, ao: 0.9, tip: 0.8 }));
    addSub(add3(p, [0, subR * 0.25, 0]), subR, 1.05);
    for (let b = 0; b < nbL; b++) {
      const t = 0.3 + 0.68 * ((b + 0.5 + (rS() - 0.5) * 0.6) / nbL);
      const lp = pathPoint(pts, t);
      const az2 = GOLD * (b + k * 1.7) + az;
      const outH = [Math.cos(az2), 0, Math.sin(az2)];
      const Y = clamp((lp.p[1] - S.trunkH) / (S.H - S.trunkH));
      const La = S.R * S.branchLen * (0.75 + 0.5 * rS()) * crownProfile(Y) * 1.15;
      let bd = norm3(add3(add3(mul3(lp.d, 0.3), mul3(outH, 0.95)), [0, 0.15 + 0.25 * rS(), 0]));
      const bn = det ? 4 : 2, bp = [lp.p], bR = [Math.max(0.03, rad[Math.min(rad.length - 1, Math.round(t * segs))] * 0.55)];
      let q = lp.p;
      for (let s = 1; s <= bn; s++) {
        bd = norm3(add3(add3(bd, [0, -0.16 * (S.droop ?? 1) / bn * 2, 0]), mul3(randDir(rS), 0.08)));
        q = add3(q, mul3(bd, La / bn)); bp.push(q); bR.push(Math.max(0.012, bR[0] * (1 - 0.88 * s / bn)));
      }
      tube(B, bp, bR, det ? 5 : 4, barkOpts(S, { flex0: 0.2, flex1: 0.6, ao: 0.85, tip: 0.8 }));
      addSub(add3(q, [0, subR * 0.1, 0]), subR, 0.9 + 0.25 * rS());
      if (S.twigs && det) for (let w = 0; w < 2; w++) {
        const tp = pathPoint(bp, 0.5 + 0.3 * w), td = norm3(add3(add3(tp.d, mul3(randDir(rT), 0.8)), [0, 0.2, 0]));
        const te = add3(tp.p, mul3(td, La * 0.45));
        tube(B, [tp.p, add3(tp.p, mul3(td, La * 0.25)), te], [bR[1] * 0.4, bR[1] * 0.25, 0.012], 4, barkOpts(S, { flex0: 0.4, flex1: 0.8, ao: 0.8, tip: 0.8 }));
        addSub(add3(te, [0, subR * 0.1, 0]), subR, 0.6);
      }
    }
  }
  // gap fillers (no wood): keep the crown envelope full
  const ry = depth * 0.5 * (0.55 + 0.45 * S.subSquash);
  for (let f = 0; f < S.fill; f++) {
    for (let tries = 0; tries < 8; tries++) {
      const d = randDir(rT), rr = Math.cbrt(rT()) * 0.8;
      const c = [crown.c[0] + d[0] * S.R * rr, crown.c[1] + d[1] * ry * rr, crown.c[2] + d[2] * S.R * rr];
      let ok = true; for (const s of subs) if (Math.hypot(c[0] - s.c[0], c[1] - s.c[1], c[2] - s.c[2]) < subR * 0.9) { ok = false; break; }
      if (ok || tries === 7) { addSub(c, subR, 0.9); break; }
    }
  }
  if (lod === 2) {
    // far-mid (≈ 75-190 m): the L1 recipe at a coarser grain — a leaf-textured core per (enlarged) sub-crown + big clump cards on its outer shell only
    // (shell points inside a neighbouring sub-crown are skipped), so the crown keeps the ragged, leafy outline and the clumped mass of the mid LOD
    const kN = 1.14, CR2 = { c: crown.c, r: [S.R * 1.15, depth * 0.5 * (0.6 + 0.4 * S.subSquash) + 0.5, S.R * 1.15] };
    const inside = (p, s) => { for (const o of subs) { if (o === s) continue; const dx = (p[0] - o.c[0]) / (o.r * kN), dy = (p[1] - o.c[1]) / (o.r * kN * S.subSquash), dz = (p[2] - o.c[2]) / (o.r * kN); if (dx * dx + dy * dy + dz * dz < 0.72) return true; } return false; };
    for (const s of subs) {
      const rN = s.r * kN, rY = s.r * S.subSquash * kN;
      const area = 4 * Math.PI * Math.pow((Math.pow(rN, 1.6) * 2 + Math.pow(rY, 1.6)) / 3, 1 / 1.6);
      const kl = S.l2Lum ?? 1;
      lobe(B, rF, s.c, rN * 0.6, rY * 0.6, { col: [S.col[0] * 0.75 * kl, S.col[1] * 0.75 * kl, S.col[2] * 0.75 * kl], ao: 0.4, crown: CR2, nBlend: 0.5, trans: S.trans, flex: S.flex, jitter: 0.25, segs: 7, rings: 3 });
      const size = S.cardSize * 2.2, n = clamp(Math.round(0.5 * area * 3.1 / (size * size)), 8, 90);
      puff(B, rF, s.c, rN, rY, rN, n, size, crown, { tile: 'clump', col: [S.col[0] * 1.02 * kl, S.col[1] * 1.02 * kl, S.col[2] * 1.02 * kl], trans: S.trans, flex: S.flex, shell: 0.88, faceOut: S.faceOut, up: S.up ?? 0.5, colVar: 0.2, reject: (p) => inside(p, s) });
    }
    return B;
  }
  // foliage. near (< ~16 m): a solid dark core per sub-crown + two shells of small crisp leaf-spray cards (alpha-shaped leaves, no big slabs);
  // mid: dense "bulk" clump cards (the crown's body) + species sprays on the shell; far-mid: a few big clump cards only
  const cm = S.cardMul ?? 1;
  const CR2 = { c: crown.c, r: [S.R * 1.15, depth * 0.5 * (0.6 + 0.4 * S.subSquash) + 0.5, S.R * 1.15] };
  const cardN = clamp(S.cardSize * ((S.tile === 'large' || S.tile === 'wutong') ? 0.5 : 0.42), 0.3, 0.55);
  for (const s of subs) {
    const rx = s.r, ry2 = s.r * S.subSquash;
    const area = 4 * Math.PI * Math.pow((Math.pow(rx, 1.6) * 2 + Math.pow(ry2, 1.6)) / 3, 1 / 1.6);
    if (near) {
      // sub-crowns are enlarged 18 % so that neighbours merge into one leafy mass. The volume of every sub-crown is filled with dense leaf-cluster cards
      // (≈ 3 layers deep: from below, from the side and from above a view ray crosses several cards, so there are no bare pods), a small leaf-textured core
      // only prevents see-through at the very centre, species sprays sit on the outermost shell for the silhouette, plus a ragged fringe.
      const kN = 1.18, rN = rx * kN, rY = ry2 * kN;
      const inside = (p) => { for (const o of subs) { if (o === s) continue; const dx = (p[0] - o.c[0]) / (o.r * kN), dy = (p[1] - o.c[1]) / (o.r * kN * S.subSquash), dz = (p[2] - o.c[2]) / (o.r * kN); if (dx * dx + dy * dy + dz * dz < 0.45) return true; } return false; };
      blob(B, rF, s.c, rN * 0.36, rY * 0.36, rN * 0.36, 4, 8, [S.col[0] * 0.9, S.col[1] * 0.9, S.col[2] * 0.9], { lump: 0.12, ao: 0.5, trans: 0.4, flex: S.flex * 0.6, kind: 2, uvScale: [16 * rN / 2, 8 * rN / 2] });
      const cardD = clamp(S.cardSize * ((S.tile === 'large' || S.tile === 'wutong') ? 0.8 : 0.7), 0.4, 0.95), dTile = DENSE_TILE[S.tile] || 'denseN';
      const nBody = clamp(Math.round(0.5 * area * kN * kN * 3.6 * cm / (cardD * cardD)), 12, 1200);
      puff(B, rF, s.c, rN, rY, rN, nBody, cardD, crown, { tile: dTile, col: S.col, trans: S.trans, flex: S.flex, shell: 0.55, faceOut: S.faceOut, up: S.up ?? 0.5, colVar: 0.2, reject: inside });
      const nOut = clamp(Math.round(0.5 * area * kN * kN * S.density * 1.1 * cm / (cardN * cardN)), 8, 600);
      puff(B, rF, s.c, rN * 1.06, rY * 1.06, rN * 1.06, nOut, cardN, crown, { tile: nearTile(S.tile), col: S.col, trans: S.trans, flex: S.flex, shell: 0.97, faceOut: S.faceOut, up: S.up ?? 0.5, colVar: 0.2, reject: inside });
      puff(B, rF, s.c, rN * 1.22, rY * 1.22, rN * 1.22, Math.round(nOut * 0.25), cardN, crown, { tile: nearTile(S.tile), col: S.col, trans: S.trans, flex: S.flex, shell: 0.985, faceOut: S.faceOut, up: S.up ?? 0.5, colVar: 0.2, reject: inside });   // ragged fringe
      continue;
    }
    const bulkSize = S.cardSize * 1.7;
    const nBulk = clamp(Math.round(0.5 * area * 2.6 / (bulkSize * bulkSize)), 4, 200);
    puff(B, rF, s.c, rx, ry2, rx, nBulk, bulkSize, crown, { tile: 'clump', col: [S.col[0] * 0.92, S.col[1] * 0.92, S.col[2] * 0.92], trans: S.trans, flex: S.flex, shell: 0.6, faceOut: S.faceOut, up: S.up ?? 0.5, colVar: 0.2 });
    {
      const nDet = clamp(Math.round(0.5 * area * S.density * 3.4 * cm / (S.cardSize * S.cardSize)), 8, 520);
      puff(B, rF, s.c, rx * 1.02, ry2 * 1.02, rx * 1.02, nDet, S.cardSize, crown, { tile: S.tile, col: S.col, trans: S.trans, flex: S.flex, shell: 0.9, faceOut: S.faceOut, up: S.up ?? 0.5, colVar: 0.2 });
    }
  }
  if (S.fruit && det) fruits(B, rF, crown, S, S.fruit === 'orange' ? 16 : 22);
  return B;
}

function fruits(B, rng, crown, S, n) {
  const orange = S.fruit === 'orange';
  const col = orange ? [0.55, 0.20, 0.025] : [0.5, 0.28, 0.035];
  for (let i = 0; i < n; i++) {
    const d = randDir(rng); d[1] = -Math.abs(d[1]) * 0.6;
    const p = [crown.c[0] + d[0] * crown.R * 0.7, crown.c[1] + d[1] * crown.R * 0.55 + 0.1, crown.c[2] + d[2] * crown.R * 0.7];
    const k = orange ? 1 : 3 + Math.floor(rng() * 3);
    for (let j = 0; j < k; j++) {
      const o = [p[0] + (rng() - 0.5) * 0.2, p[1] + (rng() - 0.5) * 0.12, p[2] + (rng() - 0.5) * 0.2];
      const r = orange ? 0.045 : 0.032;
      blob(B, rng, o, r, r * 1.1, r, 3, 5, col, { lump: 0.05, ao: 0.8, kind: 3, flex: 0.5, trans: 0.1 });
    }
  }
}

// -------------------------------------------------------------------------------------------------------------
// weeping willow
// -------------------------------------------------------------------------------------------------------------
export function genWillow(S, lod, seed) {
  const rS = makeRng(seed), rF = makeRng(seed + ':f' + lod);
  const B = new Builder();
  const near = lod === 0, det = true;                // (the far-mid willow keeps the strand curtains: they are the species)
  const sides = det ? 7 : 5;
  const tr = trunk(S, rS, S.trunkH, det ? 5 : 3);
  tube(B, tr.pts, tr.rad, sides, barkOpts(S, { flex0: 0, flex1: 0.04, ao: 0.95, tip: 0.8 }));
  const top = tr.pts[tr.pts.length - 1], rTop = tr.rad[tr.rad.length - 1];
  const crown = { c: [top[0], S.H * 0.6, top[2]], R: S.R, H: S.H };
  const anchors = [];                                   // points along limbs where strands hang
  for (let k = 0; k < S.leaders; k++) {
    const az = ((k + 0.5 * rS()) / S.leaders) * Math.PI * 2 + tr.az;
    const reach = S.R * (0.95 + 0.25 * rS()), A = (S.H - S.trunkH) * (0.95 + 0.2 * rS()), Bd = A * 0.34;
    const nS = det ? 8 : 5, pts = [top.slice()], rad = [rTop * 0.62];
    for (let s = 1; s <= nS; s++) {                     // arching limb: rises, then bows over
      const t = s / nS;
      pts.push([top[0] + Math.cos(az) * reach * Math.pow(t, 0.85), top[1] + A * Math.sin(Math.PI * t * 0.86) - Bd * t * t, top[2] + Math.sin(az) * reach * Math.pow(t, 0.85)]);
      rad.push(Math.max(0.02, rTop * 0.62 * (1 - 0.85 * t)));
    }
    tube(B, pts, rad, det ? 5 : 4, barkOpts(S, { flex0: 0.05, flex1: 0.5, ao: 0.9, tip: 0.8 }));
    for (let s = 3; s < pts.length; s++) { anchors.push({ p: pts[s], az, t: s / nS }); if (det && s < pts.length - 1) anchors.push({ p: V.lerp(pts[s], pts[s + 1], 0.5), az, t: (s + 0.5) / nS }); }
    // short side limbs
    for (let b = 0; b < (det ? S.nb : 1); b++) {
      const lp = pathPoint(pts, 0.45 + 0.45 * rS()), az2 = az + (rS() - 0.5) * 2.2;
      const bd = norm3([Math.cos(az2) * 0.9, 0.25, Math.sin(az2) * 0.9]);
      const e = add3(lp.p, mul3(bd, S.R * 0.45));
      tube(B, [lp.p, add3(lp.p, mul3(bd, S.R * 0.22)), add3(e, [0, -0.25, 0])], [rad[2] * 0.4, rad[2] * 0.25, 0.015], 4, barkOpts(S, { flex0: 0.3, flex1: 0.7, ao: 0.85, tip: 0.8 }));
      anchors.push({ p: e, az: az2, t: 1 });
    }
  }
  // leafy twig caps (short leaf cards on top of the arches, give the crown a body)
  const capCol = [S.col[0] * 1.05, S.col[1] * 1.05, S.col[2] * 1.0];
  const nCap = near ? 150 : det ? 70 : 18, size = near ? 0.4 : det ? 0.75 : 1.9;
  for (const a of anchors.slice(0, anchors.length)) {
    const n = Math.max(1, Math.round(nCap / anchors.length));
    puff(B, rF, add3(a.p, [0, 0.25, 0]), 0.9, 0.5, 0.9, n, size, crown, { tile: near ? 'fineN' : S.capTile, col: capCol, trans: S.trans, flex: S.flex, shell: 0.6, faceOut: 0.4, up: 0.8 });
  }
  // hanging strands
  const nStr = Math.round(near ? S.strands * 1.45 : lod === 1 ? S.strands : S.strands * 0.62);
  const strandTile = near ? 'willowN' : 'willow';
  for (let i = 0; i < nStr; i++) {
    const a = anchors[Math.floor(rF() * anchors.length)];
    const jit = [(rF() - 0.5) * 1.1, (rF() - 0.5) * 0.3, (rF() - 0.5) * 1.1];
    const p = add3(a.p, jit);
    const out = norm3([p[0] - crown.c[0], 0, p[2] - crown.c[2]]);
    const h = clamp(mix(S.strandL[0], S.strandL[1], rF()) * (det ? 1 : 1.2), 0.8, Math.max(0.9, p[1] - 0.85));
    const w = S.strandW * (0.8 + 0.5 * rF()) * (near ? 0.62 : lod === 1 ? 1 : 1.35);
    const yaw0 = Math.atan2(out[2], out[0]);
    const nCross = det ? 2 : 1;
    for (let c = 0; c < nCross; c++) {
      const yaw = yaw0 + Math.PI / 2 + c * (Math.PI / 2) + (rF() - 0.5) * 0.5;
      const U = [Math.cos(yaw), 0, Math.sin(yaw)];
      const nrm = norm3([out[0] * (1 - c * 0.3) + U[0] * c * 0.3, 0.22, out[2] * (1 - c * 0.3) + U[2] * c * 0.3]);
      const lum = 0.8 + 0.4 * rF();
      card(B, add3(p, [0, -h / 2, 0]), U, [0, 1, 0], w, h, {
        tile: strandTile, nrm, col: [S.col[0] * lum, S.col[1] * lum, S.col[2] * lum], ao: 0.62 + 0.38 * clamp((p[1] - 1) / 8) + 0.08 * rF(), trans: S.trans, flexTop: 0.25, flexBot: 1.0,
        phase: rF(), hide: rF(), flutter: 0.6, flipU: rF() < 0.5,
      });
    }
  }
  return B;
}

// -------------------------------------------------------------------------------------------------------------
// black pine: crooked trunk, layered branches ending in flat needle pads (云片)
// -------------------------------------------------------------------------------------------------------------
export function genPine(S, lod, seed) {
  const rS = makeRng(seed), rF = makeRng(seed + ':f' + lod);
  const B = new Builder();
  const near = lod === 0, det = lod <= 1;
  const sides = det ? 7 : 5;
  const tr = trunk(S, rS, S.H * 0.98, det ? 8 : 5, 0.03);
  tube(B, tr.pts, tr.rad, sides, barkOpts(S, { flex0: 0, flex1: 0.12, ao: 0.95, tip: 1 }));
  const crown = { c: [0, mix(S.trunkH, S.H, 0.5), 0], R: S.R, H: S.H };
  // a needle "cloud": 2-3 crossing vertical cards (side views of the pad) + one near-horizontal card (view from above)
  const pad = (p, outDir, sz) => {
    const nrmUp = norm3([outDir[0] * 0.3, 1, outDir[2] * 0.3]);
    const lum = 0.85 + 0.3 * rF();
    const col = [S.col[0] * lum, S.col[1] * lum, S.col[2] * lum];
    const o = { tile: near ? 'pineN' : 'pine', col, trans: S.trans, flex: S.flex, phase: rF(), flutter: 1 };
    const nV = det ? 3 : 2, yaw0 = rF() * Math.PI;
    for (let q = 0; q < nV; q++) {
      const yaw = yaw0 + q * (Math.PI / nV);
      const ao = 0.62 + 0.38 * rF();
      card(B, add3(p, [(rF() - 0.5) * sz * 0.3, sz * (0.12 + 0.1 * rF()), (rF() - 0.5) * sz * 0.3]), [Math.cos(yaw), 0, Math.sin(yaw)], [0, 1, 0], sz * 1.25, sz * 0.62, { ...o, nrm: nrmUp, ao, hide: rF(), flipU: rF() < 0.5 });
    }
    if (det) card(B, add3(p, [0, sz * 0.22, 0]), [Math.cos(yaw0), 0, Math.sin(yaw0)], [-Math.sin(yaw0), 0, Math.cos(yaw0)], sz * 1.1, sz * 1.0, { ...o, nrm: nrmUp, ao: 0.95, hide: rF() * 0.6 });
  };
  const sz0 = S.padSize * (near ? 0.6 : det ? 1 : 1.5);
  const nW = det ? S.whorls : Math.ceil(S.whorls * 0.7);
  for (let i = 0; i < nW; i++) {
    const t = nW > 1 ? i / (nW - 1) : 0;
    const y = mix(S.trunkH * 0.9, S.H * 0.92, t);
    const tp = pathPoint(tr.pts, clamp((y + 0.25) / (S.H * 0.98 + 0.25)));
    const nb = det ? (t < 0.5 ? 3 : 2) : 2;
    for (let b = 0; b < nb; b++) {
      const az = GOLD * (i * 2.3 + b * 1.9) + rS();
      const len = S.branchLenMax * (1 - 0.72 * Math.pow(t, 1.1)) * (0.7 + 0.5 * rS());
      let d = norm3([Math.cos(az), 0.12 + 0.28 * t + 0.1 * rS(), Math.sin(az)]);
      const bn = det ? 4 : 2, pts = [tp.p], rad = [Math.max(0.03, tr.rad[Math.min(tr.rad.length - 1, Math.round(t * tr.rad.length))] * 0.45 + 0.02)];
      let q = tp.p;
      for (let s = 1; s <= bn; s++) {
        d = norm3(add3(add3(d, [0, 0.07 + 0.1 * (s / bn), 0]), mul3(randDir(rS), 0.1)));
        q = add3(q, mul3(d, len / bn)); pts.push(q); rad.push(Math.max(0.015, rad[0] * (1 - 0.85 * s / bn)));
      }
      tube(B, pts, rad, det ? 5 : 3, barkOpts(S, { flex0: 0.12, flex1: 0.5, ao: 0.9, tip: 0.8 }));
      const outDir = norm3([d[0], 0, d[2]]);
      const nP = near ? Math.max(5, Math.round(len / 0.45)) : det ? Math.max(3, Math.round(len / 0.75)) : 3;
      for (let k = 0; k < nP; k++) {
        const u = nP === 1 ? 1 : 0.4 + 0.6 * (k / (nP - 1));
        pad(add3(pathPoint(pts, u).p, [0, 0.12, 0]), outDir, sz0 * (0.55 + 0.5 * u) * (0.8 + 0.4 * rF()) * (0.6 + 0.4 * (len / S.branchLenMax)));
      }
    }
  }
  const topP = tr.pts[tr.pts.length - 1];
  pad(add3(topP, [0, -0.25, 0]), [1, 0, 0], sz0 * 0.6);
  pad(add3(topP, [0.5, -1.0, 0.3]), [0, 0, 1], sz0 * 0.65);
  pad(add3(topP, [-0.5, -1.3, -0.3]), [0, 0, 1], sz0 * 0.65);
  return B;
}

// -------------------------------------------------------------------------------------------------------------
// columnar / dome conifers (cypress, podocarpus): cards on an ellipsoid shell around a dark core
// -------------------------------------------------------------------------------------------------------------
export function genConifer(S, lod, seed) {
  if (lod === 2) {                                   // far-mid: the stacked-lobe crown (leafy alpha-cut shading), scaled to this species
    const eu = farUnit('column');
    return genFarCrown('column', 0, S.col).scaled(S.R * 1.12 / eu.rh, S.H / eu.H, S.R * 1.12 / eu.rh);
  }
  const rS = makeRng(seed), rF = makeRng(seed + ':f' + lod);
  const B = new Builder();
  const near = lod === 0, det = lod <= 1;
  const tr = trunk({ ...S, taper: 0.6, sweep: 0.1 }, rS, S.H * 0.55, det ? 5 : 3, 0.03);
  tube(B, tr.pts, tr.rad, det ? 6 : 4, barkOpts(S, { flex0: 0, flex1: 0.05, ao: 0.9, tip: 0.8 }));
  const hc = (S.H - S.trunkH) * 0.5, cy = S.trunkH + hc;
  const crown = { c: [0, cy, 0], R: Math.max(S.R, hc * 0.7), H: S.H };
  // dark core (hides the see-through between cards)
  blob(B, rS, [0, cy, 0], S.R * 0.42, hc * 0.8, S.R * 0.42, 4, 7, [S.col[0] * 0.7, S.col[1] * 0.7, S.col[2] * 0.7], { lump: 0.08, ao: 0.4, trans: 0.1, flex: 0.2, kind: 2 });
  const area = 4 * Math.PI * Math.pow((Math.pow(S.R, 1.6) * 2 + Math.pow(hc, 1.6)) / 3, 1 / 1.6);
  const bulk = S.cardSize * (near ? 0.9 : det ? 1.3 : 2.4);
  puff(B, rF, [0, cy, 0], S.R, hc, S.R, Math.round(clamp(0.5 * area * (near ? 1.6 : 2.8) / (bulk * bulk), 8, near ? 300 : 200)), bulk, crown, { tile: 'clump', col: [S.col[0] * 0.9, S.col[1] * 0.9, S.col[2] * 0.9], trans: S.trans, flex: S.flex, shell: 0.8, faceOut: 0.8, up: 0.9, colVar: 0.14 });
  if (det) {
    const cs = near ? S.cardSize * 0.55 : S.cardSize;
    puff(B, rF, [0, cy, 0], S.R * 1.02, hc * 1.02, S.R * 1.02, Math.round(clamp(0.5 * area * S.density * (near ? 3.0 : 3.4) / (cs * cs), 20, 1100)), cs, crown, { tile: S.tile, col: S.col, trans: S.trans, flex: S.flex, shell: 0.92, faceOut: 0.8, up: 0.9, colVar: 0.16 });
  }
  return B;
}

// -------------------------------------------------------------------------------------------------------------
// banana (芭蕉): pseudostem + large arching blades
// -------------------------------------------------------------------------------------------------------------
export function genBanana(S, lod, seed) {
  const rS = makeRng(seed), rF = makeRng(seed + ':f' + lod);
  const B = new Builder();
  const near = lod === 0, det = lod <= 1;
  const stemTop = [0.05, S.stem, -0.04];
  tube(B, [[0, -0.1, 0], [0.02, S.stem * 0.5, 0], stemTop], [0.12, 0.10, 0.075], det ? 7 : 5, { col: [0.11, 0.18, 0.07], colTip: [0.10, 0.20, 0.06], style: 1, uRep: 1, vScale: 0.3, flex0: 0, flex1: 0.1, ao: 0.8, tip: 0.5 });
  const [rect] = [tileRect('banana', 0.5)];
  const nB = det ? S.blades : Math.max(4, S.blades - 2);
  const rows = det ? 8 : 5;
  const crown = { c: [0, S.stem + 0.6, 0], R: S.R, H: S.H };
  for (let i = 0; i < nB; i++) {
    const az = i * GOLD + rS() * 0.3, f = i / (nB - 1);
    const L = mix(S.bladeL[0], S.bladeL[1], 0.4 + 0.6 * rS()), W = S.bladeW * (0.9 + 0.2 * rS());
    const elev0 = mix(0.25, 1.15, f) + (rS() - 0.5) * 0.2;                    // young central blades are upright, old outer ones lean out
    const out = [Math.cos(az), 0, Math.sin(az)], side = [-Math.sin(az), 0, Math.cos(az)];
    let d = norm3(add3(mul3(out, Math.sin(elev0)), [0, Math.cos(elev0), 0]));
    const base = add3(stemTop, add3(mul3(out, 0.04), [0, 0.0, 0]));
    const pts = [base];
    let q = base;
    const droop = 0.25 + 0.75 * f;
    for (let r = 1; r <= rows; r++) {
      d = norm3(add3(d, [0, -droop * 0.22 * (r / rows) * 2.2 / rows * rows * 0.35, 0]));
      d = norm3(add3(d, mul3(out, 0.05)));
      q = add3(q, mul3(d, L / rows)); pts.push(q);
    }
    const ids = [];
    const lum = 0.85 + 0.3 * rS();
    const col = [S.col[0] * lum, S.col[1] * lum, S.col[2] * lum];
    for (let r = 0; r <= rows; r++) {
      const t = r / rows, T = norm3(sub3(pts[Math.min(rows, r + 1)], pts[Math.max(0, r - 1)]));
      const Nn = norm3(V.cross(side, T));
      const nUp = Nn[1] < 0 ? mul3(Nn, -1) : Nn;
      const wv = W * (0.5 + 0.5 * Math.min(1, t * 6));
      for (let k = 0; k < 3; k++) {
        const sx = (k - 1) * 0.5;
        const p = add3(add3(pts[r], mul3(side, sx * wv * 1.0)), mul3(nUp, -Math.abs(sx) * wv * 0.28));
        const nn = norm3(add3(nUp, mul3(side, sx * 0.7)));
        ids.push(B.vert(p, nn, [rect[0] + (rect[2] - rect[0]) * (k * 0.5), rect[3] + (rect[1] - rect[3]) * t], col, [0.7 + 0.3 * t, S.trans, S.flex * (0.3 + 0.7 * t), 1], [t, rF(), rS() * 0 + 0, 1]));
      }
    }
    for (let r = 0; r < rows; r++) for (let k = 0; k < 2; k++) {
      const a = ids[r * 3 + k], b = ids[r * 3 + k + 1], c = ids[(r + 1) * 3 + k + 1], d2 = ids[(r + 1) * 3 + k];
      B.tri(a, b, c); B.tri(a, c, d2);
    }
  }
  return B;
}

// -------------------------------------------------------------------------------------------------------------
// bamboo clump (淡竹)
// -------------------------------------------------------------------------------------------------------------
export function genBamboo(S, lod, seed) {
  const rS = makeRng(seed), rF = makeRng(seed + ':f' + lod);
  const B = new Builder();
  const near = lod === 0, det = lod <= 1;
  const nC = det ? S.culms : Math.ceil(S.culms * 0.55);
  const crown = { c: [0, S.H * 0.7, 0], R: S.R, H: S.H };
  for (let c = 0; c < nC; c++) {
    const rr = S.R * 0.55 * Math.sqrt(rS()), a0 = rS() * Math.PI * 2;
    const base = [Math.cos(a0) * rr, -0.1, Math.sin(a0) * rr];
    const h = mix(S.culmH[0], S.culmH[1], rS());
    const lean = 0.06 + 0.17 * rS() + 0.12 * (rr / S.R), az = a0 + (rS() - 0.5) * 1.0;
    const bendAz = az + (rS() - 0.5) * 0.8;
    const nS = det ? 7 : 4, pts = [], rad = [];
    const r0 = mix(S.culmR[0], S.culmR[1], rS());
    for (let s = 0; s <= nS; s++) {
      const t = s / nS, y = h * t;
      const off = lean * y + 0.45 * Math.pow(t, 2.4) * h * 0.12 * (0.6 + rS() * 0);
      pts.push([base[0] + Math.cos(az) * lean * y + Math.cos(bendAz) * Math.pow(t, 2.6) * 0.9, base[1] + y * (1 - 0.05 * t * t), base[2] + Math.sin(az) * lean * y + Math.sin(bendAz) * Math.pow(t, 2.6) * 0.9]);
      rad.push(Math.max(0.008, r0 * (1 - 0.62 * t)));
    }
    tube(B, pts, rad, det ? 5 : 3, { col: S.bark.col, colTip: [S.bark.col[0] * 0.85, S.bark.col[1] * 0.95, S.bark.col[2] * 0.8], style: 3, uRep: 1, vScale: 1, flex0: 0.05, flex1: 0.7, ao: 0.9, nodes: det ? 0.32 : 0, tip: 0.8 });
    // leaf sprays on the upper half
    const nL = near ? 15 : det ? 9 : 4;
    for (let k = 0; k < nL; k++) {
      const t = 0.5 + 0.5 * ((k + rF() * 0.6) / nL), lp = pathPoint(pts, t);
      const ang = rF() * Math.PI * 2, out = [Math.cos(ang), 0, Math.sin(ang)];
      const sz = (near ? 0.85 : det ? 1.4 : 2.2) * (0.8 + 0.5 * rF()) * (0.7 + 0.5 * (1 - Math.abs(t - 0.78) * 2));
      const p = add3(lp.p, mul3(out, sz * 0.32));
      const lum = 0.8 + 0.4 * rF();
      const col = [S.col[0] * lum, S.col[1] * lum, S.col[2] * lum];
      const nCross = det ? 2 : 1;
      for (let q = 0; q < nCross; q++) {
        const yaw = ang + Math.PI / 2 + q * 1.1;
        card(B, add3(p, [0, -sz * 0.36, 0]), [Math.cos(yaw), 0, Math.sin(yaw)], [0, 1, 0], sz, sz * 0.95, {
          tile: near ? 'bambooN' : 'bamboo', nrm: norm3([out[0] * 0.8, 0.5 + 0.3 * q, out[2] * 0.8]), col, ao: 0.55 + 0.45 * t, trans: S.trans, flexTop: 0.5, flexBot: 1.0, phase: rF(), hide: rF(), flutter: 0.8, flipU: rF() < 0.5,
        });
      }
    }
  }
  return B;
}

// -------------------------------------------------------------------------------------------------------------
// shrub: a mound of leaf cards (+ a dark core)
// -------------------------------------------------------------------------------------------------------------
export function genShrub(S, lod, seed) {
  const rF = makeRng(seed + ':f' + lod);
  const B = new Builder();
  const near = lod === 0, det = lod <= 1;
  const crown = { c: [0, S.H * 0.5, 0], R: Math.max(S.R, S.H * 0.5), H: S.H };
  const ball = S.shape === 'ball';
  const n = Math.round(S.cards * (near ? 2.2 : det ? 1 : 0.4));
  const size = S.cardSize * (near ? 0.6 : det ? 1 : 1.9);
  blob(B, rF, [0, S.H * 0.5, 0], S.R * 0.5, S.H * 0.38, S.R * 0.5, 3, 6, [S.col[0] * 0.6, S.col[1] * 0.6, S.col[2] * 0.6], { lump: 0.05, ao: 0.4, trans: 0.1, flex: 0.2, kind: 2 });
  if (det) puff(B, rF, [0, S.H * 0.5, 0], S.R, S.H * 0.5, S.R, Math.round(n * 0.45), size * (near ? 1.4 : 1.7), crown, { tile: 'clump', col: [S.col[0] * 0.9, S.col[1] * 0.9, S.col[2] * 0.9], trans: S.trans, flex: S.flex, shell: 0.7, faceOut: 0.6, up: S.up ?? 0.5, colVar: 0.2 });
  puff(B, rF, [0, S.H * 0.5, 0], S.R, S.H * 0.5, S.R, det ? n : n, size, crown, { tile: near ? nearTile(S.tile) : det ? S.tile : 'clump', col: S.col, trans: S.trans, flex: S.flex, shell: ball ? 0.95 : 0.8, faceOut: 0.6, up: S.up ?? 0.5, colVar: 0.2 });
  return B;
}

// -------------------------------------------------------------------------------------------------------------
// ground cover and small plants
// -------------------------------------------------------------------------------------------------------------
/** 沿阶草 tuft: two crossing upright cards + one low cap */
export function genTuft(lod = 0) {
  const B = new Builder();
  const col = [0.034, 0.088, 0.030];
  const o = { tile: 'tuft', col, trans: 0.4, flex: 0.45, ao: 0.8, anchor: 'b', hide: 0, flutter: 1 };
  card(B, [0, 0, 0], [1, 0, 0], [0, 1, 0], 0.56, 0.46, { ...o, nrm: norm3([0, 1, 0.3]) });
  card(B, [0, 0, 0], [0.5, 0, 0.866], [0, 1, 0], 0.56, 0.46, { ...o, nrm: norm3([0.3, 1, 0]), phase: 0.3 });
  card(B, [0, 0.07, 0], [0.5, 0, -0.866], [0, 1, 0], 0.56, 0.46, { ...o, nrm: norm3([-0.3, 1, 0]), phase: 0.6 });
  return B;
}
export function genReed() {
  const B = new Builder();
  const col = [0.095, 0.165, 0.050];
  for (let i = 0; i < 3; i++) {
    const yaw = i * (Math.PI / 3) + 0.2;
    card(B, [0, 0, 0], [Math.cos(yaw), 0, Math.sin(yaw)], [0, 1, 0], 1.0, 2.1, { tile: 'reed', col, nrm: norm3([Math.sin(yaw) * 0.3, 1, -Math.cos(yaw) * 0.3]), ao: 0.8, trans: 0.7, flexBot: 0.0, flexTop: 1.0, anchor: 'b', flutter: 1, phase: i * 0.31, hide: 0 });
  }
  return B;
}

/** floating lotus leaf: 10-gon fan lying on the water, slightly dished; the tile supplies the notch + veins */
export function genLotusFloat(rim = 10) {
  const B = new Builder();
  const [u0, v0, u1, v1] = tileRect('lotus', 0.5);
  const col = [0.070, 0.165, 0.052];
  const mk = (x, y, z, uu, vv, n) => B.vert([x, y, z], n, [u0 + (u1 - u0) * uu, v0 + (v1 - v0) * vv], col, [0.95, 0.4, 0.0, 1], [0, 0.5, 0, 1]);
  const c = mk(0, -0.012, 0, 0.5, 0.5, [0, 1, 0]);
  const ids = [];
  const R = 0.5;
  for (let k = 0; k < rim; k++) {
    const a = (k / rim) * Math.PI * 2;
    const x = Math.cos(a), z = Math.sin(a);
    ids.push(mk(x * R, 0.03 + 0.012 * Math.sin(a * 3), z * R, 0.5 + 0.5 * 0.94 * x, 0.5 + 0.5 * 0.94 * z, norm3([x * 0.25, 1, z * 0.25])));
  }
  for (let k = 0; k < rim; k++) B.tri(c, ids[(k + 1) % rim], ids[k]);
  return B;
}
/** raised lotus leaf on a stalk: cupped 2-ring leaf, stalk 1 m tall (instance scale y adjusts the height) */
export function genLotusRaised() {
  const B = new Builder();
  const [u0, v0, u1, v1] = tileRect('lotus', 0.5);
  const col = [0.070, 0.165, 0.052], stalkCol = [0.10, 0.16, 0.06];
  tube(B, [[0, -0.3, 0], [0.02, 0.35, 0.0], [0.0, 0.7, 0.03]], [0.014, 0.011, 0.009], 4, { col: stalkCol, style: 1, uRep: 1, vScale: 2, flex0: 0.1, flex1: 0.7, ao: 0.9, tip: 0 });
  const mk = (p, uu, vv, n, fl) => B.vert(p, n, [u0 + (u1 - u0) * uu, v0 + (v1 - v0) * vv], col, [0.95, 0.45, 0.8 + fl * 0.2, 1], [0.3 * fl, 0.5, 0, 1]);
  const R = 0.34, cy = 0.7, rim = 10;
  const c = mk([0, cy - 0.05, 0.03], 0.5, 0.5, [0, 1, 0], 0);
  const r1 = [], r2 = [];
  for (let k = 0; k < rim; k++) {
    const a = (k / rim) * Math.PI * 2, x = Math.cos(a), z = Math.sin(a);
    r1.push(mk([x * R * 0.55, cy + 0.0, 0.03 + z * R * 0.55], 0.5 + 0.5 * 0.5 * x, 0.5 + 0.5 * 0.5 * z, norm3([x * 0.2, 1, z * 0.2]), 0.4));
    r2.push(mk([x * R, cy + 0.07 + 0.015 * Math.sin(a * 3), 0.03 + z * R], 0.5 + 0.5 * 0.94 * x, 0.5 + 0.5 * 0.94 * z, norm3([-x * 0.45, 1, -z * 0.45]), 1));
  }
  for (let k = 0; k < rim; k++) {
    const k1 = (k + 1) % rim;
    B.tri(c, r1[k1], r1[k]);
    B.tri(r1[k], r1[k1], r2[k1]); B.tri(r1[k], r2[k1], r2[k]);
  }
  return B;
}
/** lotus flower (open) on a stalk; kind: 'open' | 'bud' */
export function genLotusFlower(open = true) {
  const B = new Builder();
  const stalkCol = [0.10, 0.16, 0.06];
  tube(B, [[0, -0.3, 0], [0.03, 0.55, 0], [0.0, 1.05, 0.03]], [0.014, 0.012, 0.010], 4, { col: stalkCol, style: 1, uRep: 1, vScale: 2, flex0: 0.1, flex1: 0.8, ao: 0.9, tip: 0 });
  const rect = tileRect('petal', 0.5);
  const cy = 1.05, white = [0.88, 0.86, 0.84], pink = [0.78, 0.30, 0.42];
  const nR = open ? 3 : 2, per = open ? [6, 7, 5] : [6, 5];
  for (let r = 0; r < nR; r++) for (let k = 0; k < per[r]; k++) {
    const a = (k / per[r]) * Math.PI * 2 + r * 0.4;
    const spread = open ? [0.85, 0.55, 0.28][r] : [0.30, 0.12][r];
    const L = open ? [0.17, 0.16, 0.13][r] : [0.16, 0.13][r], W = L * 0.8;
    const dir = [Math.cos(a) * Math.sin(spread), Math.cos(spread), Math.sin(a) * Math.sin(spread)];
    const U = norm3(V.cross(dir, [0, 1, 0].map((v, i) => (Math.abs(dir[1]) > 0.97 ? [1, 0, 0][i] : v))));
    const base = [0, cy, 0.0];
    const mid = V.mad(base, dir, L * 0.5);
    const tipCol = r === 0 ? pink : [mix(white[0], pink[0], 0.6 - r * 0.2), mix(white[1], pink[1], 0.6 - r * 0.2), mix(white[2], pink[2], 0.6 - r * 0.2)];
    const nrm = norm3(V.add(V.mul(dir, 0.5), [0, 0.8, 0]));
    // two-row petal card: base white → tip pink
    const ids = [];
    for (let row = 0; row < 3; row++) {
      const f = row / 2, p0 = V.mad(base, dir, L * f), ww = W * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, f * 0.9 + 0.1)));
      const col = [mix(white[0], tipCol[0], f * f), mix(white[1], tipCol[1], f * f), mix(white[2], tipCol[2], f * f)];
      for (let s = 0; s < 2; s++) {
        const q = V.mad(p0, U, (s ? 0.5 : -0.5) * ww);
        ids.push(B.vert(q, nrm, [s ? rect[2] : rect[0], rect[3] + (rect[1] - rect[3]) * f], col, [0.95, 0.6, 0.8, 1], [0.5 * f, 0.5, 0, 1]));
      }
    }
    for (let row = 0; row < 2; row++) { const a0 = ids[row * 2], b0 = ids[row * 2 + 1], c0 = ids[row * 2 + 3], d0 = ids[row * 2 + 2]; B.tri(a0, b0, c0); B.tri(a0, c0, d0); }
  }
  // yellow receptacle
  blob(B, makeRng('lotus-seedpod'), [0, cy + 0.03, 0], 0.035, 0.025, 0.035, 2, 6, [0.55, 0.42, 0.06], { lump: 0.02, ao: 0.9, kind: 3, trans: 0.1 });
  return B;
}
export function genLily() {
  const B = new Builder();
  const [u0, v0, u1, v1] = tileRect('lily', 0.5);
  const col = [0.060, 0.150, 0.050], rim = 9;
  const mk = (x, y, z, uu, vv, n) => B.vert([x, y, z], n, [u0 + (u1 - u0) * uu, v0 + (v1 - v0) * vv], col, [0.95, 0.35, 0.0, 1], [0, 0.5, 0, 1]);
  const c = mk(0, 0, 0, 0.5, 0.5, [0, 1, 0]);
  const ids = [];
  for (let k = 0; k < rim; k++) { const a = (k / rim) * Math.PI * 2, x = Math.cos(a), z = Math.sin(a); ids.push(mk(x * 0.5, 0.008, z * 0.5, 0.5 + 0.47 * x, 0.5 + 0.47 * z, norm3([x * 0.1, 1, z * 0.1]))); }
  for (let k = 0; k < rim; k++) B.tri(c, ids[(k + 1) % rim], ids[k]);
  return B;
}

// -------------------------------------------------------------------------------------------------------------
// far LOD (beyond ~100 m): five shared "crown classes" in unit space (height 1, horizontal radius ~1 — scaled per instance to the crown extent
// measured from the species' own mid LOD, so the switch keeps size and mass). Each is a handful of low-poly lobes (kind 4) whose surface is
// shaded as clumped foliage in the fragment shader (Worley clumps: lit domes, dark creases, ragged alpha-cut silhouette, gaps that show the dark
// inside) + a trunk and limb stubs; willow curtains, pine tiers, a stacked column, bamboo sprays. Per-instance density drops some lobes.
// -------------------------------------------------------------------------------------------------------------
export const FAR_CLASS = { broadleaf: 'round', willow: 'willow', pine: 'pine', conifer: 'column', bamboo: 'bamboo' };
export const FAR_CLASSES = ['round', 'willow', 'pine', 'column', 'bamboo'];
const FAR_BARK = [0.085, 0.068, 0.056];         // absolute bark colour (the instance colour is the leaf colour and is ignored for bark)
const _farUnit = {};
/** unit extent { rh, H, y0 } of a crown class (cached) */
export function farUnit(cls) { return _farUnit[cls] || (_farUnit[cls] = genFarCrown(cls, 0).extent()); }

export function genFarCrown(cls, variant = 0, colMul = [1, 1, 1], opts = {}) {
  const rng = makeRng('zzy-far:' + cls + ':' + variant);
  const B = new Builder();
  const hideV = (p) => (rng() < p ? 0.8 + 0.2 * rng() : 0);       // lobes that some instances drop (instance density 0.8-1.0)
  const bark = (pts, rad, hide = 0, col = FAR_BARK, sides = 3) => opts.noTrunk && cls !== 'bamboo' ? null : tube(B, pts, rad, sides, { col, colTip: col, style: cls === 'bamboo' ? 3 : 0, uRep: 1, vScale: 1, ao: 0.8, flex0: 0, flex1: 0.15, tip: 0.8, hide });
  const cm = (l) => [colMul[0] * l, colMul[1] * l, colMul[2] * l];
  // a dark leaf-textured core (hides the sky between cards) + big clump cards on the shell: the same recipe as the near LODs at a coarser grain
  const shell = (c, rx, ry, rz, n, w, aspect, tile, lum, o = {}) => {
    const crown = { c, R: Math.max(rx, rz), H: 1 };
    puff(B, rng, c, rx, ry, rz, n, w, crown, { tile, col: cm(lum), trans: o.trans ?? 0.5, flex: o.flex ?? 0.6, shell: o.shell ?? 0.9, faceOut: o.faceOut ?? 0.5, up: o.up ?? 0.5, colVar: 0.2, aspect });
  };
  if (opts.lite) {
    // LITE (very distant trees, 40–90 triangles): a bare-bones version of the same crown — one dark core + a handful of big cards
    const L = (cx, cy, cz, rx, ry, rz, n, w, aspect, tile, lum, o = {}) => shell([cx, cy, cz], rx, ry, rz, n, w * 1.7, aspect, tile, lum, o);
    const trunk = (pts, rad) => tube(B, pts, rad, 3, { col: FAR_BARK, colTip: FAR_BARK, style: 0, uRep: 1, vScale: 1, ao: 0.8, flex0: 0, flex1: 0.15, tip: 0 });
    const core = (x, y, z, r, rv, l = 0.72) => lobe(B, rng, [x, y, z], r, rv, { col: cm(l), ao: 0.35, nBlend: 0.5, jitter: 0.2, segs: 5, rings: 2 });
    if (cls === 'round') { trunk([[0, -0.02, 0], [0.02, 0.4, 0]], [0.075, 0.04]); core(0, 0.62, 0, 0.4, 0.3); L(0, 0.64, 0, 0.98, 0.36, 0.98, 20, 0.34, 0.7, 'clump', 1.0); }
    else if (cls === 'willow') { trunk([[0, -0.02, 0], [0.01, 0.56, 0]], [0.075, 0.04]); core(0, 0.72, 0, 0.5, 0.26, 0.75); L(0, 0.68, 0, 1.0, 0.34, 1.0, 14, 0.34, 0.72, 'clump', 1.3, { up: 0.7 });
      for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2 + (rng() - 0.5) * 0.3, r = 0.45 + 0.55 * rng(), top = 0.84 - 0.2 * smooth(0.3, 1.0, r), h = 0.32 + 0.1 * rng(); card(B, [Math.cos(a) * r, top - h / 2, Math.sin(a) * r], [-Math.sin(a), 0, Math.cos(a)], [0, 1, 0], 0.5, h, { tile: 'willow', nrm: V.norm([Math.cos(a), 0.25, Math.sin(a)]), col: cm(0.85 + 0.3 * rng()), ao: 0.8, trans: 0.85, flexTop: 0.2, flexBot: 0.9, hide: hideV(0.3), flutter: 0.3, phase: rng() }); } }
    else if (cls === 'pine') { trunk([[0, -0.02, 0], [0.02, 0.86, 0]], [0.07, 0.02]);
      [[0.4, 0.95], [0.55, 0.8], [0.7, 0.58], [0.84, 0.32]].forEach(([y, rh], k) => { for (let q = 0; q < 2; q++) { const a = rng() * 6.28, r = rh * (0.2 + 0.5 * rng()), sz = 0.8 + 0.3 * rh, yaw = rng() * Math.PI; card(B, [Math.cos(a) * r, y, Math.sin(a) * r], [Math.cos(yaw), 0, Math.sin(yaw)], [0, 1, 0], sz * 1.2, sz * 0.6, { tile: 'pine', nrm: V.norm([0, 1, 0]), col: cm(0.95), ao: 0.7, trans: 0.28, flex: 0.5, hide: 0, phase: rng() }); card(B, [Math.cos(a) * r, y + 0.04, Math.sin(a) * r], [Math.cos(yaw), 0, Math.sin(yaw)], [-Math.sin(yaw), 0, Math.cos(yaw)], sz * 1.1, sz * 1.0, { tile: 'pine', nrm: V.norm([0, 1, 0]), col: cm(0.95), ao: 0.95, trans: 0.28, flex: 0.5, hide: 0, phase: rng() }); } }); }
    else if (cls === 'column') { trunk([[0, -0.02, 0], [0.01, 0.2, 0]], [0.08, 0.05]); core(0, 0.52, 0, 0.5, 0.42, 0.7); L(0, 0.55, 0, 0.62, 0.38, 0.62, 12, 0.3, 0.8, 'cypress', 1.0, { shell: 0.95, faceOut: 0.85, up: 0.7 }); }
    else if (cls === 'bamboo') { for (let i = 0; i < 3; i++) { const a = (i / 3) * 6.28 + rng(), r0 = 0.12, lean = 0.2 + 0.2 * rng(); trunk([[Math.cos(a) * r0, -0.02, Math.sin(a) * r0], [Math.cos(a) * (r0 + lean), 0.88, Math.sin(a) * (r0 + lean)]], [0.026, 0.012]); }
      for (let i = 0; i < 14; i++) { const a = i * GOLD, hh = 0.35 + 0.65 * ((i * 0.61803) % 1), r = (0.16 + 0.5 * smooth(0.3, 1.0, hh)) * (0.6 + 0.5 * rng()), h = 0.4; card(B, [Math.cos(a) * r, hh - h * 0.35, Math.sin(a) * r], [-Math.sin(a), 0, Math.cos(a)], [0.18 * Math.cos(a), 1, 0.18 * Math.sin(a)], 1.0, h, { tile: 'bamboo', nrm: V.norm([Math.cos(a) * 0.8, 0.5, Math.sin(a) * 0.8]), col: cm(0.85 + 0.3 * rng()), ao: 0.55 + 0.4 * hh, trans: 0.8, flexTop: 0.5, flexBot: 1.0, hide: 0, phase: rng() }); } }
    return B;
  }
  if (cls === 'round') {
    const cy = 0.64, trunkTop = [0.02, 0.44, -0.01];
    bark([[0, -0.02, 0], [0.02, 0.2, 0.01], trunkTop], [0.075, 0.056, 0.034]);
    [[0.0, 0.0, 0.34], [0.22, -0.04, 0.26], [-0.2, 0.05, 0.26]].forEach(([x, z, r], k) => lobe(B, rng, [x, cy - 0.03 + 0.05 * k, z], r, r * 0.8, { col: cm(0.72), ao: 0.35, nBlend: 0.5, jitter: 0.25, segs: 7, rings: 3 }));
    shell([0, cy, 0], 0.98, 0.36, 0.98, 70, 0.34, 0.7, 'clump', 1.0, { shell: 0.9 });
    shell([0, cy + 0.05, 0], 0.7, 0.3, 0.7, 24, 0.32, 0.7, 'clump', 1.06, { shell: 0.7 });
    for (let i = 0; i < 5; i++) { const a = i * GOLD + variant, r = 0.4 + 0.2 * rng(); bark([[0, 0.44, 0], [Math.cos(a) * r * 0.5, 0.52, Math.sin(a) * r * 0.5]], [0.016, 0.006], 0); }   // limb stubs
  } else if (cls === 'willow') {
    // a weeping dome: clump cards on the dome, curtains hanging from its lower rim and shoulders
    bark([[0, -0.02, 0], [0.02, 0.3, 0.01], [0.01, 0.56, 0]], [0.075, 0.056, 0.034]);
    lobe(B, rng, [0, 0.72, 0], 0.5, 0.26, { col: cm(0.75), ao: 0.4, nBlend: 0.5, jitter: 0.22, segs: 8, rings: 3 });
    shell([0, 0.68, 0], 1.02, 0.34, 1.02, 52, 0.34, 0.72, 'clump', 1.3, { shell: 0.9, up: 0.7 });
    const nC = 34;
    for (let i = 0; i < nC; i++) {
      const a = (i / nC) * Math.PI * 2 + variant * 0.4 + (rng() - 0.5) * 0.3, r = 0.4 + 0.65 * rng(), top = 0.84 - 0.2 * smooth(0.3, 1.0, r), h = 0.3 + 0.12 * rng(), w = 0.3;
      const c = [Math.cos(a) * r, top - h / 2, Math.sin(a) * r], lum = 0.85 + 0.3 * rng();
      card(B, c, [-Math.sin(a), 0, Math.cos(a)], [0, 1, 0], w, h, { tile: 'willow', nrm: V.norm([Math.cos(a), 0.25, Math.sin(a)]), col: cm(lum), ao: 0.7 + 0.2 * rng(), trans: 0.85, flexTop: 0.2, flexBot: 0.9, hide: hideV(0.3), flutter: 0.4, phase: rng(), flipU: rng() < 0.5 });
    }
  } else if (cls === 'pine') {
    bark([[0, -0.02, 0], [0.03, 0.25, 0.01], [0.0, 0.52, 0.03], [0.02, 0.86, -0.01]], [0.07, 0.05, 0.034, 0.012]);
    const T = [[0.36, 0.98], [0.46, 0.9], [0.56, 0.78], [0.66, 0.62], [0.77, 0.44], [0.88, 0.26]];
    T.forEach(([y, rh], k) => {                                   // layered cloud pads: crossing vertical cards + one near-horizontal card each
      const nP = 7 + (k < 3 ? 2 : 0);
      for (let q = 0; q < nP; q++) {
        const a = rng() * 6.28 + q * 1.3, r = rh * (0.15 + 0.75 * rng()), sz = 0.42 + 0.26 * rh, lum = 0.9 + 0.2 * rng();
        const p = [Math.cos(a) * r, y + 0.02 * rng(), Math.sin(a) * r], yaw = rng() * Math.PI, hv = hideV(k > 0 ? 0.25 : 0);
        const nrm = V.norm([Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3]);
        for (let c = 0; c < 2; c++) card(B, V.add(p, [0, sz * 0.1, 0]), [Math.cos(yaw + c * 1.57), 0, Math.sin(yaw + c * 1.57)], [0, 1, 0], sz * 1.2, sz * 0.6, { tile: 'pine', nrm, col: cm(lum), ao: 0.68 + 0.06 * k + 0.2 * rng(), trans: 0.28, flex: 0.5, hide: hv, flutter: 0.6, phase: rng(), flipU: rng() < 0.5 });
        card(B, V.add(p, [0, sz * 0.18, 0]), [Math.cos(yaw), 0, Math.sin(yaw)], [-Math.sin(yaw), 0, Math.cos(yaw)], sz * 1.1, sz * 1.0, { tile: 'pine', nrm, col: cm(lum), ao: 0.95, trans: 0.28, flex: 0.5, hide: hv, flutter: 0.6, phase: rng() });
      }
    });
  } else if (cls === 'column') {
    // dark core + cypress sprays on a cone (圆柏 / 罗汉松)
    bark([[0, -0.02, 0], [0.01, 0.2, 0]], [0.08, 0.05]);
    lobe(B, rng, [0, 0.52, 0], 0.5, 0.42, { col: cm(0.7), ao: 0.35, nBlend: 0.5, jitter: 0.22, segs: 8, rings: 4 });
    lobe(B, rng, [0, 0.8, 0], 0.3, 0.2, { col: cm(0.7), ao: 0.4, nBlend: 0.5, jitter: 0.22, segs: 7, rings: 3 });
    for (let k = 0; k < 4; k++) {
      const t0 = 0.2 + k * 0.19, rr = 0.95 * Math.pow(1 - (t0 - 0.2) / 0.78, 0.9) + 0.12;
      shell([0, t0 + 0.1, 0], rr * 0.82, 0.13, rr * 0.82, Math.round(14 * rr + 5), 0.3, 0.8, 'cypress', 1.0, { shell: 0.95, faceOut: 0.85, up: 0.7 });
    }
  } else if (cls === 'bamboo') {
    const BC = [0.11, 0.16, 0.075];                                                          // culm colour: green
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * 6.28 + rng(), r0 = 0.1 + 0.15 * rng(), lean = 0.18 + 0.28 * rng();
      bark([[Math.cos(a) * r0, -0.02, Math.sin(a) * r0], [Math.cos(a) * (r0 + lean * 0.5), 0.42, Math.sin(a) * (r0 + lean * 0.5)], [Math.cos(a) * (r0 + lean), 0.88, Math.sin(a) * (r0 + lean)]], [0.026, 0.02, 0.01], 0, BC);
    }
    const nC = 42;
    for (let i = 0; i < nC; i++) {                                                           // sprays all along the culms (vase shape)
      const a = i * GOLD + variant * 0.5, hh = 0.3 + 0.7 * ((i * 0.61803) % 1), r = (0.16 + 0.5 * smooth(0.3, 1.0, hh)) * (0.6 + 0.5 * rng()), h = 0.36 + 0.12 * rng(), lum = 0.85 + 0.3 * rng();
      card(B, [Math.cos(a) * r, hh - h * 0.35, Math.sin(a) * r], [-Math.sin(a), 0, Math.cos(a)], [0.18 * Math.cos(a), 1, 0.18 * Math.sin(a)], 0.85, h, { tile: 'bamboo', nrm: V.norm([Math.cos(a) * 0.8, 0.5, Math.sin(a) * 0.8]), col: cm(lum), ao: 0.55 + 0.4 * hh, trans: 0.8, flexTop: 0.5, flexBot: 1.0, hide: hideV(0.3), flutter: 0.6, phase: rng(), flipU: rng() < 0.5 });
    }
  }
  return B;
}

const _measured = {};
/** crown extent { rh, rEq, H, y0 } of a species, measured from its mid-LOD geometry (variant 0): pure JS, cached — placement (Node), the kit and createTreeBatch use the same numbers */
export function measureSpecies(key) {
  return _measured[key] || (_measured[key] = genSpecies(key, SPECIES[key], 0, 1).extent());
}

export function genSpecies(key, S, variant, lod) {
  const seed = 'zzy:' + key + ':' + variant;
  switch (S.gen) {
    case 'broadleaf': return genBroadleaf(S, lod, seed);
    case 'willow': return genWillow(S, lod, seed);
    case 'pine': return genPine(S, lod, seed);
    case 'conifer': return genConifer(S, lod, seed);
    case 'banana': return genBanana(S, lod, seed);
    case 'bamboo': return genBamboo(S, lod, seed);
    case 'shrub': return genShrub(S, lod, seed);
    default: throw new Error('unknown generator ' + S.gen);
  }
}
