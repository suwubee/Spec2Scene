// Rammed earth (layered construction) material: parameterised CPU bake + world-space projection (no mesh UV).
//   const wall = new THREE.Mesh(geometry, rammedEarthMaterial(THREE, {quality, groundY: 0, top: 6, layer: 0.12, footSnow: 0.25}));
//   wall.material.userData.materialLibrary.uRamFootDamp.value.set(footSnow, damp, dampK, topSnow);   // per shot
// Physical basis: courses 8-15 cm with dark seams and slightly convex bodies; a construction seam every 4 courses; course colour
// random (never alternating: alternation reads as a radiator) and drifting along the wall; vertical wind-erosion gullies strongest
// 1-2 m under the top; 0.5-0.8 m damp band at the foot (capillary rise + splash); foot snow with varying height; snow cap on top.
// Walls of any orientation are projected along the horizontal tangent of their normal, so slopes never stretch the texture (R1).
// The courses are a designed regular texture: declare them in the picture-qa shot config (allowStripes + why).
import {makeRng, gnoise2} from '../../engine/noise.js';
import {injectMaterialLibrary} from './inject.js';
import {materialUniforms} from './params.js';

export const RAMMED_RANGES = Object.freeze({layer: [0.08, 0.15], layerContrast: [0.15, 0.3], erosion: [0, 2], damp: [0, 1.5], dampK: [0, 0.6], footSnow: [0, 1], topSnow: [0, 1], tileU: [1, 16], tileV: [1, 16]});
function validateRammed(P) {
  for (const [k, [lo, hi]] of Object.entries(RAMMED_RANGES)) if (!Number.isFinite(P[k]) || P[k] < lo || P[k] > hi) throw new RangeError(`rammed.${k}=${P[k]} outside legal range [${lo}, ${hi}]`);
  if (!['preview', 'final'].includes(P.quality)) throw new RangeError('rammed.quality must be preview|final');
  if (!Array.isArray(P.color) || P.color.length !== 3 || !P.color.every((c) => Number.isFinite(c) && c >= 0 && c <= 1)) throw new RangeError('rammed.color must be linear [r,g,b] 0..1');
}

export const RAMMED_DEFAULTS = {
  color: [0.30, 0.245, 0.175],    // 夯土底色（linear）
  layer: 0.12,                    // 版筑层厚 m（规范 0.08–0.15）
  layerContrast: 0.18,            // 邻层明暗差（≥0.15 才读得出层理）
  erosion: 1.0,                   // 风蚀竖沟强度（0..2）
  top: 6.0,                       // 墙顶高度（相对 groundY；风蚀从这里往下最强）
  groundY: 0.0,                   // 墙脚地面高度（世界 y）
  damp: 0.75,                     // 返潮暗带高度 m（0 = 无）
  dampK: 0.40,                    // 返潮压暗量
  footSnow: 0.22,                 // 墙脚积雪平均高度 m（0 = 无）
  topSnow: 1.0,                   // 顶面雪盖（0..1）
  tileU: 4.0, tileV: 6.0,         // 烘焙平铺（米）
  seed: 'rammed',
  quality: 'preview',
};

/** Pure CPU bake: {albedo (RGBA8, x2 encoded multiplier), normal (RGBA8), width, height}. Deterministic. */
export function bakeRammedEarth(o = {}) {
  const P = { ...RAMMED_DEFAULTS, ...o };
  validateRammed(P);
  const N = P.quality === 'final' ? 1024 : 512, NH = Math.round(N * P.tileV / P.tileU);
  const L = P.layer, rng = makeRng('rammed:' + P.seed);
  const nb = Math.ceil(P.tileV / L) + 1, jit = [], tint = [];
  for (let b = 0; b < nb; b++) {
    jit.push(1 + P.layerContrast * (rng() - 0.5) * 2.2);              // 每层随机明暗（不交替——交替会读成"暖气片"）
    tint.push(1 + (b % 2 === 0 ? -0.04 : 0.045) + (rng() - 0.5) * 0.04);
  }
  const gu = [0.85, 2.03, 3.21].map((x) => x + (rng() - 0.5) * 0.3);           // 贯穿主冲沟
  const alb = new Uint8Array(N * NH * 4), hgt = new Float32Array(N * NH);
  const du = P.tileU / N, dv = P.tileV / NH;
  for (let y = 0; y < NH; y++) {
    const v = y * dv;                                                        // 0 = 墙脚
    const fromTop = Math.max(0, P.top - v);
    const eroK = P.erosion * (0.35 + 0.65 * Math.exp(-fromTop / 2.0));      // 檐下最强、往下渐弱但不消失
    for (let x = 0; x < N; x++) {
      const u = x * du;
      const band = (v % L) / L, seamD = L - (v % L);
      const gD = L * 4 - (v % (L * 4));
      const bi = Math.floor(v / L) % nb, gi = Math.floor(v / (L * 4)) % 5;
      // 高度场：层内微凸 − 层缝 − 组缝 − 风蚀沟 + 颗粒
      const gn = 0.5 + 0.5 * gnoise2(u * 6.0 + 9.9 + 0.15 * gnoise2(v * 2.0, u), v * 0.7 - 3.3);
      const gul = (gn - 0.55 > 0 ? Math.min(1, (gn - 0.55) / 0.25) : 0) * (0.3 + 0.7 * (0.5 + 0.5 * gnoise2(u * 1.3 + 4.4, v * 0.5 - 2.2)));   // 窄竖沟（断续成组）
      let master = 0; for (const g of gu) master += Math.exp(-Math.pow((u - g - 0.2 * Math.sin(v * 1.1 + g * 4.7)) / 0.02, 2)) * Math.exp(-fromTop / 3.0);
      const h = 0.14 * Math.sin(band * Math.PI) - 0.8 * Math.exp(-Math.pow(seamD / 0.016, 2)) - 0.5 * Math.exp(-Math.pow(gD / 0.03, 2))
        - 1.2 * gul * eroK - 0.25 * master * P.erosion + 0.07 * gnoise2(u * 26, v * 26);
      hgt[y * N + x] = h;
      // 反照
      let c = jit[bi] * (1 + (gi - 2) * 0.04) * (1 + 0.08 * gnoise2(u * 0.6 + bi * 3.7, bi * 1.3));   // 层色沿墙缓变
      c *= 1 + 0.07 * gnoise2(u * 3.0, v * 22.0 + 4.4);                     // 层内水平条痕
      c *= 1 - 0.26 * Math.exp(-Math.pow(seamD / 0.022, 2));                // 层缝暗（过深会读成"暖气片"）
      c *= 1 - 0.26 * Math.exp(-Math.pow(gD / 0.034, 2));                   // 组缝暗
      c *= 1 - 0.32 * gul * eroK;                                           // 冲沟（断续成组）
      c *= 1 + 0.12 * gnoise2(u * 0.7 + 3.1, v * 0.9 - 1.7) + 0.06 * gnoise2(u * 2.3, v * 1.9 + 5.5);   // 米级色斑（土料批次/修补/风化不均）
      c *= 1 - 0.12 * master * P.erosion;
      c *= 1 + 0.10 * eroK * (0.5 + 0.5 * gnoise2(u * 2.0 + 7.0, v * 0.6));  // 风蚀褪色（上部偏浅）
      const sp = gnoise2(u * 0.9 + 11.0, v * 0.9 - 6.0); if (sp > 0.42) c *= 1 - 0.13 * Math.min(1, (sp - 0.42) / 0.16);   // 剥落
      const t = tint[bi] * (1 + (gi - 2) * 0.025);
      const i = (y * N + x) * 4;
      alb[i] = Math.round(Math.min(1, c * t * 0.5) * 255); alb[i + 1] = Math.round(Math.min(1, c * 0.5) * 255); alb[i + 2] = Math.round(Math.min(1, c * (2 - t) * 0.5) * 255); alb[i + 3] = 255;
    }
  }
  const nrm = new Uint8Array(N * NH * 4), H = (x, y) => hgt[((y + NH) % NH) * N + ((x + N) % N)], S = 0.011 * N / P.tileU;
  for (let y = 0; y < NH; y++) for (let x = 0; x < N; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * S, dy = (H(x, y + 1) - H(x, y - 1)) * S, l = Math.hypot(dx, 1, dy), i = (y * N + x) * 4;
    nrm[i] = Math.round((-dx / l * 0.5 + 0.5) * 255); nrm[i + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255); nrm[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255); nrm[i + 3] = 255;
  }
  return { albedo: alb, normal: nrm, width: N, height: NH };
}
/** Textures for the bake (owned by the material that uses them). */
export function bakeRammedEarthTextures(THREE, o = {}) {
  const b = bakeRammedEarth(o);
  const mk = (data) => { const t = new THREE.DataTexture(data, b.width, b.height); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; return t; };
  return { map: mk(b.albedo), normalMap: mk(b.normal) };
}

const VS_PARS = 'varying vec3 vRamW; varying vec3 vRamN;\n';
const VS_MAIN = 'vRamW = (modelMatrix * vec4(transformed, 1.0)).xyz; vRamN = normalize(mat3(modelMatrix) * objectNormal);\n';
const FS_PARS = /* glsl */ `
varying vec3 vRamW; varying vec3 vRamN;
uniform sampler2D uRamMap, uRamNrm;
uniform vec4 uRamTile;      // x tileU, y tileV, z groundY, w top
uniform vec4 uRamFootDamp;  // x footSnow m, y damp m, z dampK, w topSnow
uniform vec3 uRamSnowCol;
`;
// 反照：墙面按法线水平方向取 (u = 沿墙水平米数, v = 离地高)；顶面 → 雪
const FS_ALBEDO = /* glsl */ `
vec3 ramNw = normalize(vRamN);
float ramWall = 1.0 - smoothstep(0.55, 0.75, abs(ramNw.y));
vec2 ramT = normalize(vec2(-ramNw.z, ramNw.x) + vec2(1e-5, 0.0));
float ramU = dot(vRamW.xz, ramT), ramV = vRamW.y - uRamTile.z;
vec2 ramUV = vec2(ramU / uRamTile.x, ramV / uRamTile.y);
vec3 ramA = texture(uRamMap, ramUV).rgb * 2.0;
float ramFp = matFootprint(vRamW);
// 墙脚积雪：高度沿墙随噪声起伏（0.4–1.6×），顶边软 2–3 cm；其上返潮暗带（顶边也起伏）
float ramN1 = texture(uMatNoise, vec2(ramU * 0.11, 0.37)).r, ramN2 = texture(uMatNoise, vec2(ramU * 0.23, 0.71)).g;
float ramSnowH = uRamFootDamp.x * (0.4 + 1.2 * ramN1);
float ramSnow = (1.0 - smoothstep(ramSnowH - 0.02, ramSnowH + 0.02 + ramFp, ramV)) * step(0.001, uRamFootDamp.x);
float ramDamp = (1.0 - smoothstep(ramSnowH, ramSnowH + uRamFootDamp.y * (0.6 + 0.8 * ramN2), ramV)) * (1.0 - ramSnow);
vec3 ramWallCol = ramA * (1.0 - uRamFootDamp.z * ramDamp);
// 顶面雪盖（法线朝上）：雪反照 + 轻微颗粒；墙面/顶面按法线混合
float ramTop = smoothstep(0.6, 0.85, ramNw.y) * uRamFootDamp.w;
vec3 ramSnowC = uRamSnowCol * (0.92 + 0.16 * texture(uMatNoise, vRamW.xz * 0.6).r);
diffuseColor.rgb *= mix(ramWallCol, vec3(1.0), ramTop);
diffuseColor.rgb = mix(diffuseColor.rgb, ramSnowC, max(ramSnow * ramWall, ramTop));
`;
const FS_NORMAL = /* glsl */ `
{
  vec3 tn = texture(uRamNrm, ramUV).xyz * 2.0 - 1.0;
  vec3 T3 = vec3(ramT.x, 0.0, ramT.y);
  vec3 nW = normalize(T3 * tn.x + vec3(0.0, 1.0, 0.0) * tn.y + ramNw * tn.z);
  nW = normalize(mix(ramNw, nW, ramWall * (1.0 - ramSnow) * (1.0 - smoothstep(0.02, 0.08, ramFp))));   // 远处法线细节淡出（抗闪）
  nW = normalize(nW + vec3(0.0, 0.5, 0.0) * ramSnow * ramWall);                                      // 墙脚雪面朝上
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}
roughnessFactor = mix(roughnessFactor, 0.72, max(ramSnow * ramWall, ramTop));
roughnessFactor *= 1.0 - 0.15 * ramDamp;
`;

/** Rammed-earth material (MeshStandardMaterial; receives three shadows; any geometry, no UV needed). */
export function rammedEarthMaterial(THREE, o = {}) {
  const P = { ...RAMMED_DEFAULTS, ...o };
  const tex = bakeRammedEarthTextures(THREE, P);
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...P.color), roughness: 0.92, metalness: 0 });
  validateRammed(P);
  const U = {
    uRamMap: { value: tex.map }, uRamNrm: { value: tex.normalMap },
    uRamTile: { value: new THREE.Vector4(P.tileU, P.tileV, P.groundY, P.top) },
    uRamFootDamp: { value: new THREE.Vector4(P.footSnow, P.damp, P.dampK, P.topSnow) },
    uRamSnowCol: { value: new THREE.Color().setRGB(0.80, 0.82, 0.88) },
  };
  const libU = materialUniforms(THREE, {});
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    injectMaterialLibrary(sh, libU);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + VS_PARS)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + VS_MAIN);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + FS_PARS)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + FS_ALBEDO)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FS_NORMAL);
  };
  mat.customProgramCacheKey = () => 'kits.materials.rammed.v1';
  mat.userData.materialLibrary = U;
  mat.userData.materialKind = 'rammed';
  mat.name = 'kits.materials.rammed.v1';
  const dispose = mat.dispose.bind(mat);
  mat.dispose = () => { tex.map.dispose(); tex.normalMap.dispose(); dispose(); };
  return mat;
}
