const resourceKeys = ['map', 'alphaMap', 'aoMap', 'bumpMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'displacementMap', 'emissiveMap', 'envMap', 'metalnessMap', 'normalMap', 'roughnessMap', 'sheenColorMap', 'sheenRoughnessMap', 'specularColorMap', 'transmissionMap', 'iridescenceMap', 'gradientMap'];

const addTexture = (set, value) => { if (value && typeof value.dispose === 'function') set.add(value); };
function collect(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set(), other = new Set();
  const addMaterial = material => {
    if (!material) return;
    materials.add(material);
    for (const key of resourceKeys) addTexture(textures, material[key]);
    for (const value of Object.values(material.uniforms || {})) addTexture(textures, value?.value);
  };
  root?.traverse?.(node => {
    if (node.geometry?.dispose) geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) addMaterial(material);
    const skeleton = node.skeleton;
    if (skeleton?.boneTexture?.dispose) textures.add(skeleton.boneTexture);
    if (node.renderTarget?.dispose) other.add(node.renderTarget);
  });
  return { geometries, materials, textures, other };
}

const markedShared = resource => resource?.userData?.shared === true || resource?.__shared === true;

/** Release only resources reachable from `root`, excluding an explicit cache/shared set. */
export function disposeOwned(root, { shared = [], onDispose = null } = {}) {
  const skip = new Set(shared), seen = new Set(), found = collect(root), all = [...found.geometries, ...found.materials, ...found.textures, ...found.other];
  let disposed = 0, skipped = 0;
  for (const resource of all) {
    if (skip.has(resource) || markedShared(resource)) { skipped++; continue; }
    if (seen.has(resource) || typeof resource.dispose !== 'function') continue;
    seen.add(resource); resource.dispose(); disposed++; onDispose?.(resource);
  }
  return { disposed, skipped, resources: all.length, geometry: found.geometries.size, materials: found.materials.size, textures: found.textures.size };
}

export const safeDispose = disposeOwned;
export const disposeObjectSafely = disposeOwned;
export const disposeObject = disposeOwned;
export function collectOwnedResources(root) { const f = collect(root); return new Set([...f.geometries, ...f.materials, ...f.textures, ...f.other]); }
export function resourceCount(root) { return collectOwnedResources(root).size; }

/** Explicit owner registry for caches shared by multiple scene instances. */
export function createResourceScope({ shared = [] } = {}) {
  const owned = new Set(), sharedSet = new Set(shared); let released = false;
  return { owned, shared: sharedSet, own(...resources) { resources.flat(Infinity).filter(Boolean).forEach(r => owned.add(r)); return this; }, share(...resources) { resources.flat(Infinity).filter(Boolean).forEach(r => sharedSet.add(r)); return this; }, dispose() {
    if (released) return { disposed: 0, skipped: 0 };
    released = true; let disposed = 0, skipped = 0;
    for (const resource of owned) { if (sharedSet.has(resource) || markedShared(resource)) { skipped++; continue; } if (typeof resource.dispose === 'function') { resource.dispose(); disposed++; } }
    return { disposed, skipped };
  }, get released() { return released; } };
}
