// Snow and ice on three's built-in MeshStandardMaterial (receives the engine's lights and shadows; needs no mesh UV).
//   const snow = snowMaterial(THREE, {preset: 'field', wind: [0.94, 0.34], light: moonDir});
//   const ice = iceMaterial(THREE, {preset: 'black', cover: 0.2, wind, light: moonDir});
//   setMaterialLight(snow, moonDir, moonColor);           // per shot / per frame from world.at(t); a pure function of t
// Create materials during scene construction. Program cache keys are fixed per kind so no shader variant appears mid-film.
import {materialUniforms, snowParams, iceParams} from './params.js';
import {injectMaterialLibrary} from './inject.js';

const VS_DECL = 'varying vec3 vMatW;\n';
const VS_MAIN = `{
  vec4 matWp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  matWp = instanceMatrix * matWp;
  #endif
  vMatW = (modelMatrix * matWp).xyz;
}
`;
const FS_DECL = 'varying vec3 vMatW;\nuniform vec2 uMatWind;\nuniform vec3 uMatLightDir;\nuniform vec3 uMatGlintColor;\nuniform float uMatCover;\n';
const FS_SURFACE = /* glsl */ `
vec3 matP = vMatW;
vec3 matNg = normalize(inverseTransformDirection(normal, viewMatrix));
vec3 matV = normalize(cameraPosition - matP);
vec2 matWd = normalize(uMatWind + vec2(1e-5, 0.0));
float matFp = matFootprint(matP);
vec3 matH = normalize(normalize(uMatLightDir) + matV);
float matGlint = 0.0;
#ifdef MAT_SNOW
  MatSnow matS = matSnow(matP, matNg, matV, matWd, matH, matFp, uSnowP, uSnowP2);
  diffuseColor.rgb *= matS.albK;
  normal = normalize((viewMatrix * vec4(matS.N, 0.0)).xyz);
  roughnessFactor = matS.rough;
  matGlint = matS.glint * uSnowP2.z;
#endif
#ifdef MAT_ICE
  MatIce matI = matIce(matP, matNg, matV, matWd, matFp, uIceP, uIceP2);
  #ifdef MAT_COVER_ATTR
  float matCov0 = vMatCover;
  #else
  float matCov0 = uMatCover;
  #endif
  vec2 matSv = matSnowOnIce(matP.xz, matWd, matCov0, matFp);
  float matCov = clamp(matSv.x + 0.2 * matSv.y, 0.0, 1.0);
  diffuseColor.rgb = mix(matI.alb, diffuseColor.rgb, matCov);
  normal = normalize((viewMatrix * vec4(normalize(mix(matI.N, matNg, matCov)), 0.0)).xyz);
  roughnessFactor = mix(matI.rough, 0.7, matCov);
#endif
`;
const FS_EMISSIVE = '\ntotalEmissiveRadiance += uMatGlintColor * matGlint;\n';

function surfaceMaterial(THREE, kind, opts) {
  const {snow, ice, wind = [0.94, 0.34], light = [0.4, 0.5, -0.3], glintColor = [0.7, 0.78, 0.9], cover = 0, coverAttribute = null, color, ...rest} = opts;
  if (!Array.isArray(wind) || wind.length !== 2 || !wind.every(Number.isFinite) || Math.hypot(...wind) < 1e-6) throw new TypeError('wind must be a non-zero [x, z] direction');
  if (!Number.isFinite(cover) || cover < 0 || cover > 1) throw new RangeError('cover must be 0..1');
  if (coverAttribute !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(coverAttribute)) throw new TypeError('coverAttribute must be a GLSL identifier');
  const base = color ?? (kind === 'snow' ? [0.78, 0.81, 0.87] : [0.74, 0.77, 0.83]);
  const mat = new THREE.MeshStandardMaterial({color: new THREE.Color().setRGB(...base), roughness: 0.7, metalness: 0, ...rest});
  const U = {
    ...materialUniforms(THREE, {snow, ice}),
    uMatWind: {value: new THREE.Vector2(...wind)},
    uMatLightDir: {value: new THREE.Vector3(...light).normalize()},
    uMatGlintColor: {value: new THREE.Color().setRGB(...glintColor)},
    uMatCover: {value: cover},
  };
  mat.defines = {...(mat.defines || {}), [kind === 'snow' ? 'MAT_SNOW' : 'MAT_ICE']: '', ...(coverAttribute ? {MAT_COVER_ATTR: ''} : {})};
  mat.onBeforeCompile = (shader) => {
    injectMaterialLibrary(shader, U);
    const coverVs = coverAttribute ? `attribute float ${coverAttribute};\nvarying float vMatCover;\n` : '';
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + VS_DECL + coverVs)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + VS_MAIN + (coverAttribute ? `vMatCover = ${coverAttribute};\n` : ''));
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + FS_DECL + (coverAttribute ? 'varying float vMatCover;\n' : ''))
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FS_SURFACE)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' + FS_EMISSIVE);
  };
  const key = `kits.materials.${kind}.v1${coverAttribute ? '.attr' : ''}`;
  mat.customProgramCacheKey = () => key;
  mat.userData.materialLibrary = U;
  mat.userData.materialKind = kind;
  mat.name = key;
  return mat;
}
/** Snow surface. preset: field|compacted|bank|drift|far, or params {W, ridge, grain, glint, macro, crust, glintGain}. */
export function snowMaterial(THREE, {preset = 'field', params = null, ...opts} = {}) {
  return surfaceMaterial(THREE, 'snow', {...opts, snow: params ? snowParams({...snowParams(preset), ...params}) : preset});
}
/** Bare ice with per-pixel snow-on-ice boundary. cover = macro snow cover 0..1 (or coverAttribute = per-vertex float attribute). */
// three's physically based lights need ~2x the albedo gain of a custom unlit-ish host (README "Parameters"): default gain 2.
export function iceMaterial(THREE, {preset = 'clear', params = null, snow = 'field', ...opts} = {}) {
  return surfaceMaterial(THREE, 'ice', {...opts, snow, ice: iceParams({...iceParams(preset), gain: 2.0, ...(params || {})})});
}
/** Update light direction (world, towards the light) and glint colour. Call from update(t) with values derived from t only. */
export function setMaterialLight(material, direction, color = null) {
  const U = material?.userData?.materialLibrary;
  if (!U) throw new TypeError('not a kits/materials surface material');
  U.uMatLightDir.value.set(...direction).normalize();
  if (color) U.uMatGlintColor.value.setRGB(...color);
  return material;
}
