// Author: suwubee
// plants/lod.js — instanced species sets with per-instance LOD, rebuilt from the camera position every update (a pure function of the
// camera position: no hysteresis, so seek(t) renders are history-independent).
//
// Tiers of a tree, near → far:  L0 (near) · L1 (mid) · L2 (far-mid) · FAR (shared far crown, 165–330 tris) · LITE (shared 40–90-triangle crown) · culled.
// `thr[i]` = distance (× the tree's size factor) at which tier i hands over to tier i + 1 (the last one hands over to "culled").
// Neighbouring tiers cross-fade over a ±6 % distance band: an instance inside a band is drawn twice, the outgoing tier with a screen-door
// mask `w < 0` and the incoming one with `w > 0` (complementary masks, aInst.w, see material.js), so the switch never pops.
// An instance record: { x, y, z, yaw, s, sy, lean:[lx,lz], tint:[r,g,b], v (variant), … }
import { hash11 } from '../../engine/noise.js';
import { FAR_CLASS, FAR_CLASSES, farUnit } from './trees.js';

const TAU = Math.PI * 2;
const BAND = 0.06;            // half width of a cross-fade band, relative to the switch distance
const STEPS = 6;              // fade quantisation (the buffers are rewritten only when a step changes)
const FAR = -1, LITE = -4, CULL = -3, NONE = -9;

/** a geometry that shares the vertex / index buffers of `g` (so every instanced mesh can carry its own per-instance attributes) */
export function geoView(THREE, g) {
  const n = new THREE.BufferGeometry();
  for (const k of Object.keys(g.attributes)) n.setAttribute(k, g.attributes[k]);
  if (g.index) n.setIndex(g.index);
  n.boundingSphere = g.boundingSphere; n.boundingBox = g.boundingBox;
  return n;
}

export class PlantSet {
  /**
   * @param THREE
   * @param opts { key, S, variants: [[geoLod0, geoLod1, geoLod2], …] (master geometries, shared), ext ({ rh, H, y0 } measured crown extent),
   *               material, depthMaterial, group, provenance, shadow (L0–L2 cast shadows), tiers: [{ d, kind: 'mesh'|'far'|'lite', l? }, …],
   *               far: FarSet|null, dens (instance density override) }
   */
  constructor(THREE, o) {
    this.THREE = THREE; this.key = o.key; this.S = o.S; this.o = o;
    this.meshes = [];                 // meshes[lod][variant]
    this.nLod = o.variants[0].length;
    this.counts = [];
    this.far = o.far || null;
    this.farIdx = null;
    this.tiers = o.tiers;
  }
  /** register the instances (records produced by placement) and allocate the instanced meshes */
  setInstances(sites) {
    const THREE = this.THREE, o = this.o, S = this.S;
    const n = sites.length;
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.mat = new Float32Array(n * 16);
    this.col = new Float32Array(n * 3);
    this.ai = new Float32Array(n * 4);
    this.variant = new Uint8Array(n);
    this.lodScale = new Float32Array(n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0), nrm = new THREE.Vector3();
    const ext = o.ext || { rh: (S.R ?? 2) * 1.1, H: S.H ?? 5 };            // crown extent measured from the species' own geometry (kit.js)
    for (let i = 0; i < n; i++) {
      const t = sites[i];
      qy.setFromAxisAngle(up, t.yaw);
      nrm.set(t.lean[0], 1, t.lean[1]).normalize();
      q.setFromUnitVectors(up, nrm).multiply(qy);
      p.set(t.x, t.y, t.z); sc.set(t.s, t.sy, t.s);
      m4.compose(p, q, sc).toArray(this.mat, i * 16);
      this.pos[i * 3] = t.x; this.pos[i * 3 + 1] = t.y; this.pos[i * 3 + 2] = t.z;
      this.col[i * 3] = t.tint[0]; this.col[i * 3 + 1] = t.tint[1]; this.col[i * 3 + 2] = t.tint[2];
      const h = hash11(i + Math.floor(t.x * 7) * 977 + Math.floor(t.z * 7) * 31, 'plants-phase');
      this.ai[i * 4] = h * TAU; this.ai[i * 4 + 1] = 0.8 + 0.4 * hash11(i * 3 + 1, 'plants-wind'); this.ai[i * 4 + 2] = o.dens ?? (0.8 + 0.2 * hash11(i * 5 + 2, 'plants-dens')); this.ai[i * 4 + 3] = 1;
      this.variant[i] = Math.min(o.variants.length - 1, t.v | 0);
      this.lodScale[i] = (S.lodMul ?? 1) * Math.max(0.7, Math.min(1.5, Math.sqrt(Math.max(ext.rh * t.s, 0.5 * ext.H * t.sy) / 6)));
    }
    // far-crown records (the shared FarSet draws both the FAR and the LITE tier)
    if (this.far && this.far.eligible(S)) {
      this.farIdx = new Int32Array(n);
      for (let i = 0; i < n; i++) this.farIdx[i] = this.far.register(S, sites[i], this, i, ext);
      this.farW = new Float32Array(n); this.liteW = new Float32Array(n);
    }
    // meshes
    const nv = o.variants.length;
    const perVariant = new Array(nv).fill(0);
    for (let i = 0; i < n; i++) perVariant[this.variant[i]]++;
    for (let l = 0; l < this.nLod; l++) {
      this.meshes[l] = [];
      const nvl = l >= 2 ? 1 : nv;                                  // the far-mid tier uses variant 0 only (a coarse silhouette: fewer draw calls)
      for (let v = 0; v < nvl; v++) {
        const geo = geoView(THREE, o.variants[v][l]);
        const cap = Math.max(1, l >= 2 ? n : perVariant[v]);
        const mesh = new THREE.InstancedMesh(geo, o.material, cap);
        mesh.name = `${this.key}.v${v}.lod${l}`;
        mesh.frustumCulled = false; mesh.castShadow = o.shadow ?? true; mesh.receiveShadow = true;
        if (o.provenance) mesh.userData.provenance = o.provenance;
        if (o.depthMaterial) mesh.customDepthMaterial = o.depthMaterial;
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        geo.setAttribute('aInst', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
        mesh.count = 0; mesh.visible = false;
        this.meshes[l][v] = mesh;
        o.group.add(mesh);
      }
    }
    this.counts = this.meshes.map((a) => new Int32Array(a.length));
    this.key4 = new Int32Array(n).fill(-1);
    this.tierA = new Int8Array(n); this.tierB = new Int8Array(n); this.fq = new Uint8Array(n);
  }
  /** tier index → what is drawn: a mesh LOD (0…), FAR, LITE or CULL */
  _what(i) { if (i >= this.tiers.length) return CULL; const t = this.tiers[i]; return t.kind === 'mesh' ? t.l : t.kind === 'far' ? FAR : LITE; }
  /** choose each instance's tier(s) from the camera position and refill the instance buffers when anything changed */
  update(cam, k) {
    const n = this.n; if (!n) return;
    const T = this.tiers.length;
    const thr = this.tiers.map((t) => t.d * k);
    let changed = false;
    const tA = this.tierA, tB = this.tierB, fq = this.fq, key4 = this.key4;
    for (let i = 0; i < n; i++) {
      const dx = this.pos[i * 3] - cam.x, dz = this.pos[i * 3 + 2] - cam.z, dy = this.pos[i * 3 + 1] - cam.y;
      const d = Math.sqrt(dx * dx + dz * dz + dy * dy * 0.5) / this.lodScale[i];
      let j = -1;
      for (let q = 0; q < T; q++) if (Math.abs(d - thr[q]) < BAND * thr[q]) { j = q; break; }
      let a, b = NONE, f = 0;                                         // tier A (nearer / only), tier B (farther, incoming), fade step 0…STEPS
      if (j < 0) { let m = 0; while (m < T && d >= thr[m]) m++; a = m; }
      else {
        const t = (d - thr[j] * (1 - BAND)) / (2 * BAND * thr[j]), tq = Math.round(Math.max(0, Math.min(1, t)) * STEPS);
        if (tq <= 0) a = j; else if (tq >= STEPS) a = j + 1; else { a = j; b = j + 1; f = tq; }
      }
      tA[i] = a; tB[i] = b; fq[i] = f;
      const key = a | ((b === NONE ? 15 : b) << 4) | (f << 9);
      if (key !== key4[i]) { key4[i] = key; changed = true; }
    }
    if (!changed) return;
    for (const c of this.counts) c.fill(0);
    if (this.farW) { this.farW.fill(0); this.liteW.fill(0); }
    const tmp = new Float32Array(4);
    for (let i = 0; i < n; i++) {
      const a = tA[i], b = tB[i], f = fq[i] / STEPS;
      for (let pass = 0; pass < 2; pass++) {
        const ti = pass === 0 ? a : b;
        if (ti === NONE) continue;
        const what = this._what(ti);
        if (what === CULL) continue;
        const w = b === NONE ? 1 : (pass === 0 ? -(1 - f) : f);       // outgoing: visible where dither > f; incoming: visible where dither <= f
        if (what === FAR) { if (this.farW) this.farW[i] = w; continue; }
        if (what === LITE) { if (this.liteW) this.liteW[i] = w; continue; }
        const v = what >= 2 ? 0 : this.variant[i], mesh = this.meshes[what][v], c = this.counts[what][v]++;
        mesh.instanceMatrix.array.set(this.mat.subarray(i * 16, i * 16 + 16), c * 16);
        mesh.instanceColor.array.set(this.col.subarray(i * 3, i * 3 + 3), c * 3);
        tmp[0] = this.ai[i * 4]; tmp[1] = this.ai[i * 4 + 1]; tmp[2] = this.ai[i * 4 + 2]; tmp[3] = w;
        mesh.geometry.getAttribute('aInst').array.set(tmp, c * 4);
      }
    }
    for (let l = 0; l < this.meshes.length; l++) for (let v = 0; v < this.meshes[l].length; v++) {
      const mesh = this.meshes[l][v], c = this.counts[l][v];
      mesh.count = c; mesh.visible = c > 0;
      mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
      mesh.geometry.getAttribute('aInst').needsUpdate = true;
    }
    if (this.far && this.farIdx) this.far.dirty = true;
  }
}

/**
 * Far crowns: five shared crown classes (round / willow / pine / column / bamboo, 2 variants each) for the FAR tier and a 40–90-triangle
 * version of each (LITE) for very distant trees, instanced for every tree beyond the far-mid LOD.
 */
export class FarSet {
  /** geoms: { far: { round: [geoV0, geoV1], … }, lite: { round: [geo], … } } (master geometries), o: { castShadow (far), liteShadow, provenance } */
  constructor(THREE, geoms, material, depthMaterial, capacity, group, o = {}) {
    this.THREE = THREE; this.n = 0; this.cap = capacity;
    this.mat = new Float32Array(capacity * 16); this.col = new Float32Array(capacity * 3); this.ai = new Float32Array(capacity * 4);
    this.cls = new Uint8Array(capacity); this.ver = new Uint8Array(capacity); this.local = new Int32Array(capacity); this.setOf = new Array(capacity);
    this.meshes = { far: {}, lite: {} };
    const cap1 = Math.max(1, capacity);
    for (const tier of ['far', 'lite']) {
      for (const c of FAR_CLASSES) {
        this.meshes[tier][c] = geoms[tier][c].slice(0, 1).map((g, v) => {
          const geo = geoView(THREE, g);
          const mesh = new THREE.InstancedMesh(geo, material, cap1);
          mesh.name = `${tier}.${c}.v${v}`; mesh.frustumCulled = false; mesh.castShadow = tier === 'far' ? (o.castShadow ?? true) : (o.liteShadow ?? false); mesh.receiveShadow = true;
          if (o.provenance) mesh.userData.provenance = o.provenance;
          if (depthMaterial && mesh.castShadow) mesh.customDepthMaterial = depthMaterial;
          mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap1 * 3), 3);
          geo.setAttribute('aInst', new THREE.InstancedBufferAttribute(new Float32Array(cap1 * 4), 4));
          mesh.count = 0; mesh.visible = false;
          group.add(mesh);
          return mesh;
        });
      }
    }
    this.dirty = true;
    this._m4 = new THREE.Matrix4(); this._qy = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(); this._up = new THREE.Vector3(0, 1, 0);
  }
  eligible(S) { return !!FAR_CLASS[S.gen]; }
  /** register one instance; returns its far index */
  register(S, t, set, i, ext) {
    const f = this.n++, cls = FAR_CLASS[S.gen], u = farUnit(cls);
    const sx = ext.rh * t.s / u.rh, sy = ext.H * t.sy / u.H;            // unit crown → this tree's measured extent
    this._qy.setFromAxisAngle(this._up, t.yaw);
    this._p.set(t.x, t.y, t.z); this._s.set(sx, sy, sx);
    this._m4.compose(this._p, this._qy, this._s).toArray(this.mat, f * 16);
    const k = S.farLum ?? 0.97;
    this.col[f * 3] = S.col[0] * t.tint[0] * k; this.col[f * 3 + 1] = S.col[1] * t.tint[1] * k; this.col[f * 3 + 2] = S.col[2] * t.tint[2] * k;
    this.ai[f * 4] = set.ai[i * 4]; this.ai[f * 4 + 1] = set.ai[i * 4 + 1]; this.ai[f * 4 + 2] = set.ai[i * 4 + 2]; this.ai[f * 4 + 3] = 1;
    this.cls[f] = FAR_CLASSES.indexOf(cls);
    this.ver[f] = 0;                                                    // one variant per class (200 m +: shape differences are invisible, draw calls are not)
    this.local[f] = i; this.setOf[f] = set;
    return f;
  }
  /** gather the instances whose far / lite weight is set (fully there or fading in / out) into the class meshes */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const counts = { far: {}, lite: {} };
    for (const tier of ['far', 'lite']) for (const c of FAR_CLASSES) counts[tier][c] = new Array(this.meshes[tier][c].length).fill(0);
    for (let f = 0; f < this.n; f++) {
      const set = this.setOf[f], i = this.local[f], c = FAR_CLASSES[this.cls[f]];
      for (const tier of ['far', 'lite']) {
        const w = tier === 'far' ? set.farW[i] : set.liteW[i];
        if (!w) continue;
        const v = tier === 'far' ? this.ver[f] : 0, mesh = this.meshes[tier][c][v], k = counts[tier][c][v]++;
        mesh.instanceMatrix.array.set(this.mat.subarray(f * 16, f * 16 + 16), k * 16);
        mesh.instanceColor.array.set(this.col.subarray(f * 3, f * 3 + 3), k * 3);
        const ia = mesh.geometry.getAttribute('aInst').array;
        ia[k * 4] = this.ai[f * 4]; ia[k * 4 + 1] = this.ai[f * 4 + 1]; ia[k * 4 + 2] = this.ai[f * 4 + 2]; ia[k * 4 + 3] = w;
      }
    }
    for (const tier of ['far', 'lite']) for (const c of FAR_CLASSES) for (let v = 0; v < this.meshes[tier][c].length; v++) {
      const mesh = this.meshes[tier][c][v], k = counts[tier][c][v];
      mesh.count = k; mesh.visible = k > 0;
      mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; mesh.geometry.getAttribute('aInst').needsUpdate = true;
    }
  }
}
