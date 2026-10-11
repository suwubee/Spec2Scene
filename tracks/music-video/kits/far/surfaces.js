// Materials for the block batches: walls and snow come from the material library (never a new snow / rammed shader here);
// this file only adds the two things the library does not have: weathered plank wood (per-plank tone, lap seams, low-contrast
// grain, all from the batch attributes, no image) and openings (emissive by vertex colour: near-black holes, warm windows).
import {rammedEarthMaterial} from '../materials/rammed.js';
import {snowMaterial} from '../materials/surfaces.js';

/** Weathered plank wood. With the batch vertex colours (x1.6-2.0) albedo is ~0.12-0.17: weathered grey timber. E12: 0.02 reads as a
 *  black hole; under a warm lamp keep it near 0.1 or the lit boards exceed the warm budget. */
export function plankWoodMaterial(THREE, {color = [0.085, 0.066, 0.048], seam = 0.55, grain = 0.12, plankVar = 0.22} = {}) {
  if (!(seam >= 0 && seam <= 0.9 && grain >= 0 && grain <= 0.3 && plankVar >= 0 && plankVar <= 0.4)) throw new RangeError('plankWoodMaterial: seam 0..0.9, grain 0..0.3, plankVar 0..0.4');
  const mat = new THREE.MeshStandardMaterial({color: new THREE.Color().setRGB(...color), roughness: 0.9, metalness: 0, vertexColors: true});
  const U = {uPlank: {value: new THREE.Vector3(seam, grain, plankVar)}};
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aMat;\nvarying vec4 vPlankM;\nvarying vec2 vPlankUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPlankM = aMat; vPlankUv = uv;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uPlank;\nvarying vec4 vPlankM;\nvarying vec2 vPlankUv;\nfloat plankHash(float n){ return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }')
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        float id = floor(vPlankM.w + 0.5);
        float tone = 1.0 + uPlank.z * (plankHash(id) - 0.5) * 2.0;
        float across = fract(vPlankUv.x);
        float fw = max(fwidth(vPlankUv.x), 1e-4);
        float edge = min(across, 1.0 - across);
        float seamK = 1.0 - uPlank.x * (1.0 - smoothstep(0.0, 0.04 + 1.5 * fw, edge));       // lap seam, widened when tiny on screen
        float g = sin(vPlankUv.y * 9.0 + plankHash(id + 7.0) * 30.0 + 2.0 * sin(vPlankUv.y * 1.3 + id)) * 0.5 + 0.5;
        float gK = 1.0 - uPlank.y * g * (1.0 - smoothstep(0.02, 0.12, fwidth(vPlankUv.y)));    // grain fades before it aliases
        diffuseColor.rgb *= tone * seamK * gK;
      }`);
  };
  mat.customProgramCacheKey = () => 'kits.far.plankWood.v1';
  mat.userData.plank = U; mat.name = 'kits.far.plankWood.v1';
  return mat;
}
/** Openings: emission = vertex colour (warm lit window or near-black hole); fog-aware so distant windows sink into haze. */
export function openingMaterial(THREE, {gain = 1} = {}) {
  const mat = new THREE.MeshBasicMaterial({vertexColors: true, color: new THREE.Color(gain, gain, gain)});
  mat.name = 'kits.far.opening.v1';
  return mat;
}
/** Convenience set for blockBatches(): {wall, brick, snow, hole, wood}. Wall/brick heights feed the rammed foot/top snow. */
export function blockMaterials(THREE, {quality = 'final', groundY = 0, top = 8, wind = [0.94, 0.34], light = [0.4, 0.4, 0.8], wall = {}, brick = {}, snow = {}, wood = {}} = {}) {
  return {
    wall: rammedEarthMaterial(THREE, {quality, groundY, top, layer: 0.12, footSnow: 0.25, ...wall}),
    brick: rammedEarthMaterial(THREE, {quality, groundY, top, layer: 0.08, layerContrast: 0.18, color: [0.16, 0.16, 0.17], ...brick}),
    snow: snowMaterial(THREE, {preset: 'drift', wind, light, ...snow}),
    hole: openingMaterial(THREE),
    wood: plankWoodMaterial(THREE, wood),
  };
}
