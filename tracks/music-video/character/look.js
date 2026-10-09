import * as THREE from '../engine/vendor/three.module.js';

/** Linear-light default for a readable, low-reflectance silhouette. */
export const WOOL_ALBEDO = Object.freeze([0.045, 0.046, 0.05]);
export const WOOL = WOOL_ALBEDO;
export const RIM_COLOR = Object.freeze([0.62, 0.72, 0.9]);

const luminance = color => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
const asMaterials = material => Array.isArray(material) ? material : [material];
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

/**
 * Make the material used by imported characters and garment shells.  External
 * GLBs often arrive with MeshStandardMaterial; setting roughness alone leaves
 * its grazing-angle Fresnel highlight visible inside a backlit silhouette.
 * MeshPhysicalMaterial exposes an explicit zero specular term and keeps a
 * stable shader signature for every character instance.
 */
export function createSilhouetteMaterial(source = {}, { color = WOOL_ALBEDO, preserveMap = false } = {}) {
  const sourceColor = source?.color?.isColor ? source.color : new THREE.Color(...color);
  const material = new THREE.MeshPhysicalMaterial({
    color: sourceColor.clone(),
    map: preserveMap ? (source.map || null) : null,
    alphaMap: preserveMap ? (source.alphaMap || null) : null,
    alphaTest: Number.isFinite(source.alphaTest) ? source.alphaTest : 0,
    transparent: Boolean(source.transparent),
    opacity: Number.isFinite(source.opacity) ? source.opacity : 1,
    side: source.side ?? THREE.FrontSide,
    shadowSide: source.shadowSide ?? source.side ?? THREE.FrontSide,
    roughness: 1,
    metalness: 0,
    specularIntensity: 0,
    envMapIntensity: 0,
    clearcoat: 0,
    sheen: 0,
  });
  material.name = source.name ? `${source.name}:silhouette` : 'character-silhouette';
  material.userData.spec2sceneSilhouette = true;
  return material;
}

/** Return a stable distance based rim strength for a shot or a scene preset. */
export function rimIntensityForShot(shot = {}, { far = 0.28, medium = 0.2, near = 0.12 } = {}) {
  const distance = Number(shot.distance ?? shot.subjectDistance ?? shot.scale);
  if (!Number.isFinite(distance)) return far;
  if (distance < 3) return near;
  if (distance < 10) return medium;
  return far;
}

function darkenMaterial(material, target, { hair = false } = {}) {
  if (!material || material.__spec2sceneLook) return;
  material.__spec2sceneLook = true;
  const color = new THREE.Color(...target);
  if (material.color?.isColor) {
    // Keep already darker materials dark while moving bright costume/skin colors
    // into the same silhouette family.
    const current = luminance(material.color);
    const wanted = luminance(color);
    if (current > wanted) material.color.copy(color).multiplyScalar(wanted / Math.max(current, 1e-6));
    else material.color.copy(color).multiplyScalar(Math.max(current, 1e-6) / Math.max(wanted, 1e-6));
  }
  if ('roughness' in material) material.roughness = 1;
  if ('metalness' in material) material.metalness = 0;
  if ('clearcoat' in material) material.clearcoat = 0;
  if ('clearcoatRoughness' in material) material.clearcoatRoughness = 1;
  if ('sheen' in material) material.sheen = 0;
  if ('sheenIntensity' in material) material.sheenIntensity = 0;
  if ('specularIntensity' in material) material.specularIntensity = 0;
  if ('envMapIntensity' in material) material.envMapIntensity = 0;
  if (material.emissive?.isColor) material.emissive.setRGB(0, 0, 0);
  if (hair && material.vertexColors) material.vertexColors = false;
  material.needsUpdate = true;
}

/** Whether an actor already has the look marker applied. */
export function hasCharacterLook(actor) { return Boolean(actor?.__spec2sceneLook); }
export const hasRim = hasCharacterLook;

/**
 * Apply the reusable silhouette look to an actor. The function only mutates
 * materials owned by the actor and is idempotent. `rim: null` disables the
 * optional light; a number supplies its base intensity.
 */
export function applyCharacterLook(actor, { albedo = WOOL_ALBEDO, rim = 0.2, color = RIM_COLOR } = {}) {
  if (!actor?.object?.traverse) throw new TypeError('actor.object with traverse() is required');
  if (hasCharacterLook(actor)) return actor.__spec2sceneLook;
  const base = [...albedo].map(Number);
  if (base.length !== 3 || base.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new TypeError('finite albedo required');
  actor.object.traverse(node => {
    if (!node.isMesh || !node.material) return;
    const name = String(node.name || '').toLowerCase();
    const hair = /hair|scalp|ponytail|bun/.test(name);
    for (const material of asMaterials(node.material)) darkenMaterial(material, base, { hair });
  });
  let rimLight = null;
  if (rim !== null) {
    rimLight = new THREE.DirectionalLight(new THREE.Color(...color), Math.max(0, finite(rim, 0.2)));
    rimLight.name = 'character-cold-rim';
    rimLight.userData.spec2sceneOwned = true;
    rimLight.position.set(-2, 3, 3);
    actor.object.add(rimLight, rimLight.target);
  }
  const api = {
    rim: rimLight,
    update(camera, moonDirection, strength = rim, shot = {}) {
      if (!rimLight) return api;
      const value = Math.max(0, finite(strength, rimIntensityForShot(shot)));
      rimLight.intensity = value;
      if (moonDirection && Array.isArray(moonDirection) && moonDirection.length >= 3) {
        rimLight.position.set(-moonDirection[0], -moonDirection[1], -moonDirection[2]).normalize().multiplyScalar(4);
      }
      if (camera?.position) rimLight.target.position.copy(camera.position);
    },
    dispose() {
      if (!rimLight) return;
      rimLight.parent?.remove(rimLight);
      rimLight.target.parent?.remove(rimLight.target);
      rimLight.dispose?.();
      rimLight = null;
    },
  };
  actor.__spec2sceneLook = api;
  return api;
}

export const updateCharacterLook = (look, camera, moonDirection, strength, shot) => look?.update(camera, moonDirection, strength, shot);
