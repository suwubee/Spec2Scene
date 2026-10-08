// Author: suwubee
// plants/batch.js — building instanced, LOD'd, wind-swayed trees from a list of sites, and the public builder `createTreeBatch(env, items, opts)`
// that other modules (e.g. the context module's street trees) use. See kits/README.md §1.
import { makeRng } from '../../engine/noise.js';
import { SPECIES, resolveSpecies } from './species.js';
import { FAR_CLASS } from './trees.js';
import { prepareKit } from './kit.js';
import { PlantSet, FarSet } from './lod.js';

const TAU = Math.PI * 2;
const r2 = (v) => Math.round(v * 100) / 100;
const mix = (a, b, t) => a + (b - a) * t;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const farEligible = (S) => S.gen !== 'shrub' && S.gen !== 'conifer' && !!FAR_CLASS[S.gen];

/** LOD tiers of a species set (distances in "tree-size units": multiplied by the tree's size factor and by `lodScale` at update time) */
export function tiersFor(kit, S, o) {
  const [D0, D1, D2] = kit.lod, shrub = S.gen === 'shrub', cull = o.maxDistance ?? 1e12;
  if (shrub) { const d = kit.Q.shrubD; return [{ kind: 'mesh', l: 0, d: d[0] }, { kind: 'mesh', l: 1, d: Math.min(d[2], cull) }]; }      // two tiers only (the 50-triangle L2 is not worth another draw call per species)
  if (!farEligible(S)) return [{ kind: 'mesh', l: 0, d: D0 }, { kind: 'mesh', l: 1, d: D1 }, { kind: 'mesh', l: 2, d: cull }];   // conifers: their far-mid crown is the far crown
  return [{ kind: 'mesh', l: 0, d: D0 }, { kind: 'mesh', l: 1, d: D1 }, { kind: 'mesh', l: 2, d: D2 }, { kind: 'far', d: o.liteFrom ?? D2 * 1.7 }, { kind: 'lite', d: cull }];
}

/**
 * Build the instanced sets for a list of sites { k (species key), x, y, z, yaw, s, sy, lean:[lx,lz], tint:[r,g,b], v (variant), provenance? }.
 * Sites are grouped by provenance (one sub-group + far set each; every mesh carries `userData.provenance`). Returns
 * { sets, fars, obstacles, bySpecies, groups } — call `update(cam, k)` every frame. A promise: with `o.progress` (env.progress) the far crowns and every species' master geometry are
 * prepared first with a pause per step (loading screen: '远景树冠 n / 5 类', '<o.label> n / m 种'); the geometries are pure functions of their keys, so nothing changes but the pauses.
 */
export async function buildTreeSets(kit, group, sites, o = {}) {
  const THREE = kit.THREE;
  const out = { sets: [], fars: [], obstacles: [], bySpecies: {}, groups: [] };
  const byProv = new Map();
  for (const t of sites) { const p = t.provenance || o.provenance || 'procedural'; if (!byProv.has(p)) byProv.set(p, []); byProv.get(p).push(t); }
  if (o.progress) {
    let anyFar = false; const keys = new Set();
    for (const list of byProv.values()) for (const t of list) { keys.add(t.k); if (farEligible(SPECIES[t.k])) anyFar = true; }
    if (anyFar) await kit.farGeomsAsync(o.progress);
    if (o.warmSpecies !== false) await kit.prepareSpecies([...keys], o.progress, o.label || '树种');
  }
  for (const [prov, list] of byProv) {
    const g = new THREE.Group(); g.name = (o.groupPrefix || 'trees-') + prov; g.userData.provenance = prov; group.add(g); out.groups.push(g);
    let nFar = 0; const bySp = {};
    for (const t of list) { (bySp[t.k] ||= []).push(t); if (farEligible(SPECIES[t.k])) nFar++; }
    const far = nFar ? new FarSet(THREE, kit.farGeoms(), kit.matMain, kit.depth, nFar + 4, g, { castShadow: o.farShadow ?? true, provenance: prov }) : null;
    if (far) out.fars.push(far);
    for (const [key, sub] of Object.entries(bySp)) {
      const S = SPECIES[key], E = kit.species(key), shrub = S.gen === 'shrub';
      const set = new PlantSet(THREE, {
        key, S, variants: E.variants, ext: E.ext, material: kit.material(S), depthMaterial: kit.depth, group: g, provenance: prov, shadow: o.shadow ?? true,
        tiers: tiersFor(kit, S, o), far: farEligible(S) ? far : null, dens: shrub ? 1 : undefined,
      });
      set.setInstances(sub);
      out.sets.push(set);
      (out.bySpecies[key] ||= []).push(...sub);
      for (const t of sub) {
        const h = E.ext.H * t.sy;
        if (shrub && h < 1.5) continue;                           // low shrubs never matter to a camera
        out.obstacles.push({ x: r2(t.x), z: r2(t.z), r: r2(E.ext.rh * t.s), h: r2(h), y0: r2(Math.max(0, E.ext.y0) * t.sy), kind: key, provenance: prov });
      }
    }
    // Viewer provenance only: homogeneous source groups keep this slot record
    // valid when LOD packing changes. Count sites once, never per LOD mesh.
    g.userData.treeSites = list.filter(t => SPECIES[t.k].gen !== 'shrub').map(t => ({ x: t.x, z: t.z, id: t.id, provenance: t.provenance || prov }));
    g.traverse(mesh => { if(mesh.isInstancedMesh)mesh.userData.instanceProvenance = Array(mesh.instanceMatrix.count).fill(prov); });
  }
  return out;
}

/** frame update for a built batch */
export function updateTreeSets(built, cam, k = 1) {
  for (const s of built.sets) s.update(cam, k);
  for (const f of built.fars) f.flush();
}

/** triangles / draw calls of the visible meshes under `group` */
export function countGroup(group) {
  let tri = 0, calls = 0;
  group.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const g = o.geometry, per = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    if (o.isInstancedMesh) { if (o.count > 0) { calls++; tri += per * o.count; } } else { calls++; tri += per; }
  });
  return { triangles: Math.round(tri), drawCalls: calls };
}

const HINT_SPECIES = { conifer: 'pine', weeping: 'willow', bamboo: 'bamboo', broadleaf: 'camphor' };

/** the species key of an item (the same rule resolveItems uses) */
export const speciesKeyOf = (it, o = {}) => resolveSpecies(it.species ?? it.kind ?? (it.hint ? (o.hintSpecies && o.hintSpecies[it.hint]) || HINT_SPECIES[it.hint] : null), o.defaultSpecies || 'broadleaf');

/** items → sites (species key, scale from h / r, seeded jitter, ground height). o.index0 = the index of items[0] in the full list (the default seed uses the position in the list) */
export function resolveItems(env, kit, items, o = {}) {
  const ground = env.ground, sites = [], i0 = o.index0 | 0;
  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    const key = speciesKeyOf(it, o);
    const S = SPECIES[key], E = kit.species(key), ext = E.ext;
    const rng = makeRng(String(it.seed ?? `${key}:${(+it.x).toFixed(2)},${(+it.z).toFixed(2)}:${(n + i0) % 7}`));
    const hasR = it.r != null && it.r > 0, hasH = it.h != null && it.h > 0;
    // r = visible crown radius (area-equivalent: what a crown traced from imagery measures) → horizontal scale; h = total height → vertical scale
    let sxz, sy;
    if (hasR && hasH) { sxz = it.r / ext.rEq; sy = it.h / ext.H; }
    else if (hasR) { sxz = it.r / ext.rEq; sy = Math.pow(sxz, 0.88) * mix(0.92, 1.08, rng()); }   // crowns widen faster than they grow tall
    else if (hasH) { sy = it.h / ext.H; sxz = Math.pow(sy, 1 / 0.88) * mix(0.92, 1.08, rng()); }
    else { const s = mix(S.scale[0], S.scale[1], rng()); sxz = s * mix(0.9, 1.1, rng()); sy = s * mix(0.92, 1.12, rng()); }
    sxz = clamp(sxz, 0.3, 4); sy = clamp(sy, 0.3, 4);
    let y = it.y;
    if (y == null) y = o.groundY != null ? o.groundY : ground && ground.heightAt ? ground.heightAt(it.x, it.z) : 0;
    const lum = it.tint ? 1 : 0.9 + 0.22 * rng(), hue = (rng() - 0.5) * 0.18;
    sites.push({
      k: key, x: +it.x, y: y - 0.06, z: +it.z, yaw: it.yaw ?? rng() * TAU, s: sxz, sy,
      lean: it.lean || [0, 0], tint: it.tint || [lum * (1 + hue), lum, lum * (1 - hue * 1.3)],
      v: it.variant != null ? it.variant % S.variants : Math.floor(rng() * S.variants), provenance: it.provenance || o.provenance || 'procedural', id: it.id,
    });
  }
  return sites;
}

/**
 * createTreeBatch(env, items, opts) → { group, update(t, camera), obstacles, stats, items }
 *
 * items: [{ x, z, species, h?, r?, seed?, y?, yaw?, lean?: [lx, lz], variant?, tint?: [r, g, b], provenance?, id?, hint? }]
 *   species   a key (camphor plane ginkgo willow pine broadleaf maple wutong cypress bamboo …) or a Chinese / English alias (悬铃木, 银杏, 垂柳, 'london plane' …);
 *             unknown → opts.defaultSpecies ('broadleaf'). `kind` is accepted as a synonym. Without `species`, `hint` (conifer | weeping | bamboo | broadleaf) picks one.
 *   h, r      total height (m) and crown radius (m): the instance is scaled so its measured extent matches; one of them alone keeps the species' proportions (±8 %);
 *             none → the species' nominal size × a seeded jitter
 *   seed      anything; makes the variant / yaw / tint / jitter reproducible (default: derived from species + position)
 *   y         ground height (default: opts.groundY, else env.ground.heightAt(x, z))
 *   lean      [lx, lz] tilt of the trunk axis (e.g. a canal willow leaning over the water: ≈ 0.12 towards the water)
 * opts: { name, provenance ('procedural'), groundY, defaultSpecies, hintSpecies, lodScale (1), maxDistance (cull beyond, m; default none),
 *         liteFrom (size units; beyond it the 40–90-triangle far crowns replace the 165–330-triangle ones; default 1.7 × the far-mid distance ≈ 330 m for a 15 m tree),
 *         shadow (L0–L2 cast shadows, true), farShadow (far crowns cast shadows, false in batches) }
 * Returns the group (add it to your scene / group), `update(t, camera)` (call every frame: wind + LOD), `obstacles` ([{ x, z, r, h, y0, kind, provenance }]),
 * `stats` ({ items, byKind, quality, buildMs, triangles, drawCalls, recount() }) and `items` (the resolved placement: species key, position, scale, variant …).
 */
export async function createTreeBatch(env, items, opts = {}) {
  const t0 = performance.now();                                    // build statistics only
  const THREE = env.THREE, kit = await prepareKit(env);            // (the first user of the kit bakes the leaf atlas here, with a pause per tile)
  const P = typeof env.progress === 'function' ? env.progress : null, label = opts.label || '树木';
  let sites;
  if (P && (items || []).length) {
    // the species of the batch first (one pause per species), then the items in slices (loading screen: '<label> n / m 株'); the slices keep the global index, so the result is identical
    await kit.prepareSpecies([...new Set(items.map((it) => speciesKeyOf(it, opts)))], P, label);
    sites = [];
    const step = Math.max(32, Math.ceil(items.length / 40));
    for (let a = 0; a < items.length; a += step) {
      for (const s of resolveItems(env, kit, items.slice(a, a + step), { ...opts, index0: a })) sites.push(s);
      const w = P(Math.min(items.length, a + step), items.length, '株', label); if (w) await w;
    }
  } else sites = resolveItems(env, kit, items || [], opts);
  const group = new THREE.Group(); group.name = opts.name || 'tree-batch';
  const built = await buildTreeSets(kit, group, sites, { ...opts, farShadow: opts.farShadow ?? false, progress: P, label, warmSpecies: false });
  const stats = { items: sites.length, byKind: {}, quality: kit.qName, buildMs: 0, triangles: 0, drawCalls: 0 };
  for (const t of sites) stats.byKind[t.k] = (stats.byKind[t.k] || 0) + 1;
  stats.recount = () => { const c = countGroup(group); stats.triangles = c.triangles; stats.drawCalls = c.drawCalls; };
  const _p = new THREE.Vector3(), scale = opts.lodScale ?? 1;
  const update = (t, camera) => {
    kit.U.uTime.value = t;
    if (camera) { camera.getWorldPosition(_p); updateTreeSets(built, _p, scale); }
  };
  if (env.camera) update(0, env.camera);
  stats.recount(); stats.buildMs = Math.round(performance.now() - t0);
  return {
    group, update, obstacles: built.obstacles, stats,
    items: sites.map((t) => ({ species: t.k, x: t.x, z: t.z, y: t.y + 0.06, scale: [t.s, t.sy], variant: t.v, provenance: t.provenance, id: t.id })),
  };
}
