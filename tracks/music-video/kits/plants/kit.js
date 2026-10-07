// Author: suwubee
// plants/kit.js — resources shared by every tree batch of a session: the baked leaf atlas, the foliage materials, the master geometries of
// each species (3 LODs × variants + the measured crown extent) and of the far crowns. One kit per renderer, created lazily by whoever asks first
// (the garden's plants module, or `createTreeBatch()` called by another module), so the atlas is baked and each species is generated once.
import { bakeAtlas, bakeAtlasAsync, SIZE, SIZE_H } from './atlas.js';
import { SPECIES, LOD_DIST } from './species.js';
import { genSpecies, genFarCrown, farUnit, measureSpecies, FAR_CLASSES } from './trees.js';
import { createUniforms, createFoliageMaterial, createDepthMaterial } from './material.js';

/** per-preset numbers (garden thinning, shrub / tuft distances …) */
export const QP = {
  high:   { thin: 1.0,  tuft: 1.0,  shrub: 1.0, aqua: 1.0, tuftD: 60, shrubD: [9, 26, 62] },
  medium: { thin: 0.9,  tuft: 0.7,  shrub: 0.8, aqua: 1.0, tuftD: 46, shrubD: [7, 20, 50] },
  low:    { thin: 0.78, tuft: 0.42, shrub: 0.6, aqua: 0.9, tuftD: 34, shrubD: [5, 14, 38] },
};

export function makeAtlasTexture(THREE, renderer, baked = null) {
  const at = baked || bakeAtlas();
  const tex = new THREE.DataTexture(at.data, SIZE, SIZE_H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = [{ data: at.data, width: SIZE, height: SIZE_H }, ...at.mips];
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace; tex.flipY = false;
  const maxA = renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 4;
  tex.anisotropy = Math.min(8, maxA || 4);
  tex.needsUpdate = true;
  return tex;
}

export class Kit {
  /** baked: an atlas baked beforehand (prepareKit: with loading progress); without it the constructor bakes it itself */
  constructor(env, baked = null) {
    const THREE = this.THREE = env.THREE;
    this.qName = QP[env.quality] ? env.quality : 'high';
    this.Q = QP[this.qName];
    this.lod = LOD_DIST[this.qName];
    this.tex = makeAtlasTexture(THREE, env.renderer, baked);
    this.U = createUniforms(THREE, this.tex);
    this.matMain = createFoliageMaterial(THREE, this.U, { name: 'foliage', roughness: 0.68 });
    this.matGloss = createFoliageMaterial(THREE, this.U, { name: 'glossy', roughness: 0.52, spec: 0.4 });
    this.depth = createDepthMaterial(THREE, this.U);
    this._species = new Map();
    this._far = null;
  }
  material(S) { return S.rough && S.rough < 0.6 ? this.matGloss : this.matMain; }
  /** master geometries { variants: [[lod0, lod1, lod2] × S.variants], ext: { rh, H, y0 } (extent of the mid LOD of variant 0) } — built on first use */
  species(key) {
    let e = this._species.get(key);
    if (e) return e;
    const S = SPECIES[key];
    const variants = [];
    for (let v = 0; v < S.variants; v++) variants.push([0, 1, 2].map((l) => genSpecies(key, S, v, l).toGeometry(this.THREE)));
    e = { variants, ext: measureSpecies(key) };
    this._species.set(key, e);
    return e;
  }
  /** master far crowns { far: { cls: [v0, v1] }, lite: { cls: [geo] } } (the lite crowns are scaled to the extent of the far unit crowns) */
  farGeoms() {
    if (this._far) return this._far;
    const far = {}, lite = {};
    for (const c of FAR_CLASSES) {
      far[c] = [0, 1].map((v) => genFarCrown(c, v).toGeometry(this.THREE));
      const L = genFarCrown(c, 0, [1, 1, 1], { lite: true }), el = L.extent(), u = farUnit(c);
      lite[c] = [L.scaled(u.rh / el.rh, u.H / el.H, u.rh / el.rh).toGeometry(this.THREE)];
    }
    return (this._far = { far, lite });
  }
  /** farGeoms() with a pause between the crown classes (loading progress: P(done, total, unit, label) may return a promise) */
  async farGeomsAsync(P) {
    if (this._far || !P) return this.farGeoms();
    const far = {}, lite = {};
    let k = 0;
    for (const c of FAR_CLASSES) {
      far[c] = [0, 1].map((v) => genFarCrown(c, v).toGeometry(this.THREE));
      const L = genFarCrown(c, 0, [1, 1, 1], { lite: true }), el = L.extent(), u = farUnit(c);
      lite[c] = [L.scaled(u.rh / el.rh, u.H / el.H, u.rh / el.rh).toGeometry(this.THREE)];
      const w = P(++k, FAR_CLASSES.length, '类', '远景树冠'); if (w) await w;
    }
    return (this._far = { far, lite });
  }
  /** species(key) for a list of keys with a pause between the species (loading progress) */
  async prepareSpecies(keys, P, label = '树种') {
    let k = 0;
    for (const key of keys) { this.species(key); const w = P ? P(++k, keys.length, '种', label) : null; if (w) await w; }
  }
}

const KITS = new WeakMap(), PENDING = new WeakMap();
/** the session's kit (one per renderer); bakes the atlas synchronously when it does not exist yet */
export function getKit(env) {
  const key = env.renderer || env.scene || env;
  let kit = KITS.get(key);
  if (!kit) { kit = new Kit(env); KITS.set(key, kit); }
  return kit;
}
/**
 * The session's kit, created with a pause between the atlas tiles (loading screen: env.progress(done, total, unit, label) → '树叶贴图 n / 32 张'). The resulting kit is the same
 * object / bytes getKit() would make; callers that are already async (create, createTreeBatch) use this first so the first user of the kit does not freeze the page for the whole bake.
 */
export async function prepareKit(env) {
  const key = env.renderer || env.scene || env;
  let kit = KITS.get(key);
  if (kit) return kit;
  let p = PENDING.get(key);
  if (!p) {
    const P = typeof env.progress === 'function' ? env.progress : null;
    p = bakeAtlasAsync(undefined, P).then((baked) => { let k = KITS.get(key); if (!k) { k = new Kit(env, baked); KITS.set(key, k); } PENDING.delete(key); return k; },
      (e) => { PENDING.delete(key); throw e; });
    PENDING.set(key, p);
  }
  return p;
}
