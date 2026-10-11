// Far-range material: one GLSL3 ShaderMaterial for the ridge layers and the silhouette slots.
// Two atmosphere conventions (choose the one the rest of the scene uses, or the ranges jump out of the frame):
//   engine:      makeFarMaterial(THREE, {atmos}) splices the engine atmosphere (createAtmosphere: vApplyAtmos, skyAmbient,
//                skyAmbTex, vDirect) -> identical haze to the ground; lighting = engine vDirect unless update({lights}) is given.
//   stand-alone: no atmos -> own sky ambient + haze colours (opts.sky = {up, low}); lighting from update({lights}).
// Rules (README): patterns in world coordinates only, every detail octave has a footprint window, anisotropy <= 3:1, no time,
// no randomness. The haze target is the MEAN sky radiance, never the view-direction horizon colour (E3), and foot fog height
// varies in patches (E4).
import {getMaterialNoise} from '../materials/noise.js';
import {airParams, lightParams, SNOW_COLOR_DEFAULTS} from './params.js';

const VS = /* glsl */ `
in vec4 aFar;
out vec3 vFarW; out vec3 vFarN; out vec4 vFarA; out vec3 vFarC;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vFarW = w.xyz; vFarN = normalize(mat3(modelMatrix) * normal); vFarA = aFar;
#ifdef USE_COLOR
  vFarC = color;
#else
  vFarC = vec3(0.5, 0.5, 1.0);
#endif
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// Stand-alone replacements for the few engine atmosphere symbols the shader uses.
const STANDALONE = /* glsl */ `
uniform vec3 uFarSkyUp; uniform vec3 uFarSkyLow;
vec3 farSkyAmbient(vec3 N){ return mix(uFarSkyLow, uFarSkyUp, clamp(N.y * 0.5 + 0.5, 0.0, 1.0)); }
vec3 farApplyAtmos(vec3 col, vec3 W){ return col; }
vec3 farHazeTarget(){ return uFarSkyUp; }
vec3 farEngineDirect(vec3 W, vec3 N, float wrap){ return vec3(0.0); }
vec3 farEngineFlat(){ return vec3(0.0); }
`;
const ENGINE = /* glsl */ `
vec3 farSkyAmbient(vec3 N){ return skyAmbient(N) * vKey.w; }
vec3 farApplyAtmos(vec3 col, vec3 W){ return vApplyAtmos(col, W); }
vec3 farHazeTarget(){ return texelFetch(skyAmbTex, ivec2(2, 1), 0).rgb * vHazeB.x; }
vec3 farEngineDirect(vec3 W, vec3 N, float wrap){ vec3 sd; return vDirect(W, N, wrap, 0.0, 1.0, sd); }
vec3 farEngineFlat(){ return vMoonCol * max(vMoonDir.y, 0.0) * vKey.z + vSunCol * max(vSunDir.y, 0.0) * vKey.y; }
`;
/** Engine symbols the engine branch needs (checked by tests against the engine source). */
export const FAR_ENGINE_SYMBOLS = Object.freeze(['skyAmbient', 'vKey', 'vApplyAtmos', 'skyAmbTex', 'vHazeB', 'vDirect', 'vMoonCol', 'vMoonDir', 'vSunCol', 'vSunDir']);

export const FAR_FS_BODY = /* glsl */ `
in vec3 vFarW; in vec3 vFarN; in vec4 vFarA; in vec3 vFarC;
uniform sampler2D uFarNoise;
uniform vec4 uFarKeyA; uniform vec3 uFarKeyAC;     // 'three' convention: direction + on (w) / radiance I*col/pi
uniform vec4 uFarKeyB; uniform vec3 uFarKeyBC;
uniform vec4 uFarAmb;                              // x sky ambient gain, y cold snow subsurface, z moonlit air glow, w lights on
uniform vec4 uFarAir;                              // x 1/visibility (1/m), y distance haze strength, z foot fog height, w foot fog
uniform vec3 uFarSnowCol; uniform vec3 uFarRockCol;
uniform float uFarGain;
layout(location = 0) out vec4 fragColor;
#define gl_FragColor fragColor

float farFp(vec3 P){ return max(length(dFdx(P)), length(dFdy(P))) + 1e-4; }
float farWin(float lam, float fp){ return smoothstep(2.5, 6.0, lam / fp); }   // fade a pattern below ~3 px

void main(){
  vec3 V = normalize(cameraPosition - vFarW);
  float D = length(cameraPosition - vFarW);
  vec3 Ng = normalize(vFarN);
  float fp = farFp(vFarW);
  float kind = vFarA.w;
  vec3 N = Ng, alb;
  float snowK = 1.0;
  if (kind < 0.5) {
    // ridges: gullies / rock ribs in a slope frame (contour T x fall line F), stretched 3:1 down the fall line, warped
    vec3 T = normalize(cross(Ng, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
    vec3 F = normalize(cross(T, Ng));
    vec2 q = vec2(dot(vFarW, T), dot(vFarW, F));
    q.x += 56.0 * (texture(uFarNoise, vFarW.xz / 400.0 + 0.21).r - 0.5);
    float w1 = farWin(90.0, fp), w2 = farWin(30.0, fp), w3 = farWin(10.0, fp);
    float g1 = texture(uFarNoise, q / vec2(90.0, 200.0) + vec2(0.13, 0.71)).r;
    float g2 = texture(uFarNoise, q / vec2(30.0, 66.0) + vec2(0.57, 0.29)).g;
    float g3 = texture(uFarNoise, q / vec2(10.0, 22.0) + vec2(0.91, 0.43)).r;
    float gully = (g1 - 0.5) * w1 + 0.6 * (g2 - 0.5) * w2 + 0.35 * (g3 - 0.5) * w3;   // > 0 rib, < 0 gully (snow)
    float dg = (texture(uFarNoise, (q + vec2(6.0, 0.0)) / vec2(90.0, 200.0) + vec2(0.13, 0.71)).r - g1) * w1
             + 0.6 * (texture(uFarNoise, (q + vec2(2.0, 0.0)) / vec2(30.0, 66.0) + vec2(0.57, 0.29)).g - g2) * w2;
    N = normalize(Ng - T * dg * 1.3);
    // shading relief fades with the pixel footprint: at grazing views of distant ranges every ridge's lit/shaded pair collapses
    // into a 2-4 px horizontal line and the stack reads as stripes (README E4); far ranges read as tone, not relief
    N = normalize(mix(vec3(0.0, 1.0, 0.0), N, 0.35 + 0.65 * smoothstep(10.0, 40.0, 220.0 / fp)));
    // snow vs bare rock: rock only on steep slopes, scoured crests, ribs above the snow line and in patches; gullies stay white
    float alt = vFarA.x, crest = vFarC.r, macro = vFarC.g, rockAmt = vFarC.b;
    float steep = 1.0 - smoothstep(0.58 + 0.08 * macro, 0.86, Ng.y);
    float blot = texture(uFarNoise, vFarW.xz / 140.0 + vec2(0.37, 0.11)).g;
    float scour = smoothstep(0.45, 0.85, crest + 0.2 * (g1 - 0.5)) * (0.4 + 0.6 * alt) * smoothstep(0.35, 0.62, blot);
    float rib = smoothstep(0.04, 0.24, gully) * (0.2 + 0.8 * alt);
    float blot2 = texture(uFarNoise, vFarW.xz / 330.0 + vec2(0.71, 0.29)).r;
    float spots = smoothstep(0.60, 0.78, blot) * 0.55 * w1 + smoothstep(0.58, 0.74, blot2) * 0.45 * (0.4 + 0.6 * alt);
    // crest scour and ribs are LINE features: seen from the front every ridge line becomes a horizontal stroke, so they only
    // nudge the patchy terms (rock comes out in patches, not lines: README E15)
    float rock = clamp(steep * (0.25 + 0.65 * smoothstep(0.3, 0.62, blot)) + scour * 0.2 + rib * 0.18 + spots * 1.25, 0.0, 1.0) * rockAmt;
    rock *= smoothstep(-0.10, 0.06, gully + 0.06 * alt);
    rock = smoothstep(0.28, 0.74, rock);
    // rock patches fade with the pixel footprint: at wide focal lengths / grazing views a 100 m patch is squeezed into a 2-4 px
    // stroke, and dark strokes under every snow crest read as horizontal brush marks with bright outlines (README E15)
    rock *= 0.25 + 0.75 * smoothstep(14.0, 48.0, 160.0 / fp);
    snowK = 1.0 - rock;
    vec3 snow = uFarSnowCol * (0.88 + 0.16 * macro + 0.08 * (g2 - 0.5) * w2 - 0.10 * scour);
    vec3 rk = uFarRockCol * (0.7 + 0.6 * g3 * w3 + 0.3 * (1.0 - w3)) * (0.8 + 0.4 * macro);
    rk = mix(rk, snow * 0.6, 0.22);                       // rime and drift dusting: winter rock faces are never black
    alb = mix(rk, snow, snowK);
  } else {
    alb = kind > 1.5 ? uFarSnowCol * vFarC.r : vFarC;     // slot walls = vertex colour (earth), tops (kind 2) = snow
    snowK = kind > 1.5 ? 1.0 : 0.0;
  }
  float wrap = mix(0.12, 0.38, snowK);                  // snow scatters light round the terminator; rock keeps a hard one
  vec3 E = uFarAmb.w > 0.5
    ? uFarKeyAC * max((dot(N, uFarKeyA.xyz) + wrap) / (1.0 + wrap), 0.0) * uFarKeyA.w + uFarKeyBC * max((dot(N, uFarKeyB.xyz) + wrap) / (1.0 + wrap), 0.0) * uFarKeyB.w
    : farEngineDirect(vFarW, N, wrap);
  vec3 amb = farSkyAmbient(N) * uFarAmb.x;
  vec3 col = alb * (E + amb);
  col += alb * snowK * vec3(0.55, 0.75, 1.0) * dot(amb, vec3(0.333)) * uFarAmb.y;   // cold subsurface: shaded slopes never dead black
  col *= uFarGain;
  col = farApplyAtmos(col, vFarW);
  // haze target: mean sky radiance (isotropic) or the moonlit air glow, whichever is brighter -> far layers paler than near
  vec3 Eflat = uFarAmb.w > 0.5 ? uFarKeyAC * max(uFarKeyA.y, 0.0) * uFarKeyA.w + uFarKeyBC * max(uFarKeyB.y, 0.0) * uFarKeyB.w : farEngineFlat();
  vec3 ambUp = farSkyAmbient(vec3(0.0, 1.0, 0.0));
  vec3 glow = uFarSnowCol * (Eflat * 0.22 + ambUp * uFarAmb.x * 0.8) * uFarGain;
  vec3 hz = max(farHazeTarget(), glow * uFarAmb.z);
  float air = (1.0 - exp(-D * uFarAir.x)) * uFarAir.y * (1.0 + 1.6 * vFarA.z) + 0.55 * vFarA.z;
  // foot fog in patches (lambda ~700 m): equal-height fog bands stacked layer over layer read as horizontal stripes (E4)
  float fogVar = texture(uFarNoise, vFarW.xz / 700.0 + vec2(0.17, 0.53)).r;
  float foot = uFarAir.w * (0.45 + 0.9 * fogVar) * exp(-max(vFarW.y - vFarA.y, 0.0) / max(uFarAir.z * (0.5 + fogVar), 1.0));
  col = mix(col, hz, clamp(air + foot * (1.0 - air), 0.0, 0.96));
  fragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * makeFarMaterial(THREE, {atmos?, air, snow, light, sky}) -> ShaderMaterial; material.userData.farUpdate(extra) writes uniforms.
 * Program cache key is fixed per convention ('kits.far.v1.engine' / 'kits.far.v1.standalone').
 */
export function makeFarMaterial(THREE, opts = {}) {
  const atmos = opts.atmos || null;
  if (atmos && (typeof atmos.glsl !== 'string' || !atmos.uniforms)) throw new TypeError('atmos must be the engine atmosphere ({glsl, uniforms})');
  const air = airParams(opts.air), light = lightParams(opts.light), snow = {...SNOW_COLOR_DEFAULTS, ...(opts.snow || {})};
  const sky = {up: [0.035, 0.05, 0.085], low: [0.012, 0.014, 0.02], ...(opts.sky || {})};
  const U = {
    uFarNoise: {value: getMaterialNoise(THREE)},
    uFarKeyA: {value: new THREE.Vector4(0, 1, 0, 0)}, uFarKeyAC: {value: new THREE.Vector3()},
    uFarKeyB: {value: new THREE.Vector4(0, 1, 0, 0)}, uFarKeyBC: {value: new THREE.Vector3()},
    uFarAmb: {value: new THREE.Vector4(light.ambient, light.subsurface, light.airGlow, 0)},
    uFarAir: {value: new THREE.Vector4(1 / air.vis, air.strength, air.footH, air.foot)},
    uFarSnowCol: {value: new THREE.Vector3(...snow.col)}, uFarRockCol: {value: new THREE.Vector3(...snow.rockCol)},
    uFarGain: {value: light.gain},
    ...(atmos ? {} : {uFarSkyUp: {value: new THREE.Vector3(...sky.up)}, uFarSkyLow: {value: new THREE.Vector3(...sky.low)}}),
  };
  const mat = new THREE.ShaderMaterial({
    name: atmos ? 'kits.far.v1.engine' : 'kits.far.v1.standalone', glslVersion: THREE.GLSL3,
    vertexShader: VS, fragmentShader: (atmos ? atmos.glsl + ENGINE : STANDALONE) + FAR_FS_BODY,
    uniforms: {...(atmos ? atmos.uniforms : {}), ...U}, vertexColors: true,
  });
  mat.customProgramCacheKey = () => mat.name;
  const dirV = new THREE.Vector3(), tgt = new THREE.Vector3();
  mat.userData.farUniforms = U;
  mat.userData.farUpdate = (extra = {}) => {
    const L = extra.lights || null;
    U.uFarAmb.value.w = L ? 1 : 0;
    const set = (key, keyC, l) => {
      if (!l || !(l.intensity > 0)) { key.value.w = 0; keyC.value.set(0, 0, 0); return; }
      l.updateMatrixWorld?.(); l.target?.updateMatrixWorld?.();
      dirV.setFromMatrixPosition(l.matrixWorld).sub(tgt.setFromMatrixPosition(l.target.matrixWorld)).normalize();
      key.value.set(dirV.x, dirV.y, dirV.z, 1);
      keyC.value.set(l.color.r, l.color.g, l.color.b).multiplyScalar(l.intensity / Math.PI);
    };
    if (L) { set(U.uFarKeyA, U.uFarKeyAC, L[0]); set(U.uFarKeyB, U.uFarKeyBC, L[1]); }
    else if (!atmos) { U.uFarKeyA.value.w = 0; U.uFarKeyB.value.w = 0; }
    if (extra.gain !== undefined || extra.ambient !== undefined || extra.airGlow !== undefined) {
      const lp = lightParams({gain: extra.gain ?? U.uFarGain.value, ambient: extra.ambient ?? U.uFarAmb.value.x, subsurface: U.uFarAmb.value.y, airGlow: extra.airGlow ?? U.uFarAmb.value.z});
      U.uFarGain.value = lp.gain; U.uFarAmb.value.x = lp.ambient; U.uFarAmb.value.z = lp.airGlow;
    }
    if (extra.air) { const a = airParams({vis: 1 / U.uFarAir.value.x, strength: U.uFarAir.value.y, footH: U.uFarAir.value.z, foot: U.uFarAir.value.w, ...extra.air}); U.uFarAir.value.set(1 / a.vis, a.strength, a.footH, a.foot); }
    if (extra.sky && !atmos) { if (extra.sky.up) U.uFarSkyUp.value.set(...extra.sky.up); if (extra.sky.low) U.uFarSkyLow.value.set(...extra.sky.low); }
  };
  return mat;
}
