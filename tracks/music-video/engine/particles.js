// Author: suwubee
// engine/particles.js — deterministic particle & atmospheric FX library (rain, splashes/ripples, eave drips,
// plum petals, dust motes, tea steam, mist cards, fireflies, light shafts).
//
// Design rules (see engine/README.md):
//  * Every particle is a PURE FUNCTION of (seed, t, camera): positions are computed in the vertex shader from
//    integer hashes + closed-form motion; wrap-around volumes keep densities constant forever. No simulation
//    state, no Math.random, no accumulated time.
//  * NO instancing: SwiftShader charges ~14 µs per instance (tools/cinematic/README.md). All systems are ONE merged,
//    non-instanced draw with "vertex pulling" (gl_VertexID -> particle id + corner).
//  * Lighting follows docs/LIB_COMMON.md §2 (scene-linear HDR; moon E=0.22·moonlight, lantern 1.1 cd ...).
//    Values may exceed 1.0 near lights so bloom/streaks pick them up.
//  * Point-like sprites (rain, splash droplets, drips, dust, fireflies) defocus THEMSELVES (disc bokeh with
//    conserved energy) from ctx.uniforms.uLens (engine) — see the "DOF" section of the doc for the engine hook.
//
// Factory signature (LIB_COMMON §1):  createXxx(ctx, opts) -> { object, update(t, world, camera), dispose, ... }
//   t     = FILM time (s, absolute), world = world.at(t), camera = THREE.PerspectiveCamera (already placed).
import { GLSL_NOISE, makeRng, hashString, seedOf, mulberry32 } from './noise.js';
import {defaultEnvironment as DEFAULT_WORLD} from './world/environment.js';

// ---------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------
export const WIND_MS = 6.0;             // m/s horizontal wind at world.wind = 1
export const SHUTTER = 0.5 / 24;        // 180° shutter at 24 fps (s)
const MAX_PT = 4;                       // point lights per system
/** One immutable domain per world; CPU and shader use the same bounds. */
export function particleTimeDomain(world={}) {
  const {start=-8,end=600,step=.125}=world.particleTimeDomain||{};
  const count=Math.ceil((end-start)/step)+1;
  if(![start,end,step].every(Number.isFinite)||start>0||end<0||step<=0||count<2||count>16384||Math.abs(start/step-Math.round(start/step))>1e-7)throw new Error('invalid particle time domain (max 16384 samples; start aligned to step)');
  return {start,end:start+(count-1)*step,step,count};
}

const qScale = (ctx) => (ctx.quality === 'final' ? 1 : 0.4);
const toV3 = (THREE, a, def = [0, 0, 0]) => (a && a.isVector3 ? a.clone() : new THREE.Vector3().fromArray(a || def));
const seedNum = (s, label) => (hashString(String(seedOf(s ?? 1)) + ':' + label) & 0x7fffffff) % 1000003;

// ---------------------------------------------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------------------------------------------
const GLSL_COMMON = /* glsl */ `
precision highp float; precision highp int;
#define PI 3.14159265359
uniform float uTime;
uniform vec4 uLens;        // x focus distance (m), y CoC radius px at infinity (full render res), z near, w far
uniform vec2 uRes;         // render-target size (px)
uniform float uCocMax;     // max sprite CoC radius (px)
uniform float uGain;       // artistic brightness multiplier
uniform float uShutter;    // exposure time (s)
float cocPx(float z){ return uLens.y * (1.0 - uLens.x / max(z, 1e-3)); }
float hgPhase(float c, float g){ float g2 = g*g; return (1.0 - g2) / (4.0*PI*pow(max(1.0 + g2 - 2.0*g*c, 1e-5), 1.5)); }
float normCdf(float x){ x = clamp(x, -5.0, 5.0); return 0.5 + 0.5*tanh(0.7978845608*(x + 0.044715*x*x*x)); }
`;
const GLSL_VCOMMON = GLSL_COMMON + /* glsl */ `
float focalPx(){ return projectionMatrix[1][1] * 0.5 * uRes.y; }
`;

// light rig uniforms (directions point TO the light; colours are colour × irradiance / intensity(cd))
const GLSL_LIGHTS = /* glsl */ `
uniform vec3 uSunDir; uniform vec3 uSunCol;
uniform vec3 uMoonDir; uniform vec3 uMoonCol;
uniform vec3 uSkyCol; uniform vec3 uGndCol;     // sky / ground radiance (for ambient)
uniform vec4 uPtPos[${MAX_PT}];                   // xyz position, w = source radius (softens 1/r²)
uniform vec3 uPtCol[${MAX_PT}];                   // colour × intensity (cd)
uniform int uPtN;
#ifndef DIR_MASK
#define DIR_MASK(p) 1.0
#endif
// in-scattered radiant intensity per unit cross-section toward V (unit, particle -> camera), PHASE(c) must be defined
vec3 inscatter(vec3 p, vec3 V){
  float dm = DIR_MASK(p);
  vec3 acc = (uMoonCol * PHASE(dot(-uMoonDir, V)) + uSunCol * PHASE(dot(-uSunDir, V))) * dm;
  for (int i = 0; i < ${MAX_PT}; i++) {
    if (i >= uPtN) break;
    vec3 d = p - uPtPos[i].xyz; float r2 = dot(d, d);
    acc += uPtCol[i] * PHASE(dot(d * inversesqrt(max(r2, 1e-8)), V)) / (r2 + uPtPos[i].w * uPtPos[i].w);
  }
  return acc + (uSkyCol + uGndCol) * AMBIENT_K;
}
`;

// sprite output: premultiplied (rgb, a). Blend = ONE, ONE_MINUS_SRC_ALPHA (additive when a = 0)
// + optional post-DOF "FX pass" support: manual (soft) depth test against the scene depth texture.
const FS_HEAD = /* glsl */ `layout(location = 0) out vec4 fragColor;
uniform sampler2D uSceneDepth; uniform float uDepthOn; uniform float uSoftDepth;
float fxLinZ(float d){ float z = d * 2.0 - 1.0; return 2.0 * uLens.z * uLens.w / (uLens.w + uLens.z - z * (uLens.w - uLens.z)); }
// 1 in front of the scene, 0 behind it (soft over uSoftDepth metres). Always 1 unless the engine's FX pass enabled it.
float fxDepthFade(){
  if (uDepthOn < 0.5) return 1.0;
  float sd = texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy), 0).r;
  float zs = sd >= 1.0 ? 1e6 : fxLinZ(sd), zf = fxLinZ(gl_FragCoord.z);
  return clamp((zs - zf) / max(uSoftDepth, 1e-3), 0.0, 1.0);
}
`;
const _fxShared = new WeakMap();
/**
 * particlesFX(renderer) — shared uniforms for the engine's optional post-DOF particle pass (see engine/README.md):
 *   fx.begin(depthTexture)  → particle shaders test/fade against the scene depth (render them into a colour-only RT)
 *   fx.end()                → back to normal hardware depth testing (the default).
 *   fx.layer                → suggested THREE layer for FX objects (objects are put there when ctx.fxLayer is set).
 */
export function particlesFX(renderer, THREE) {
  let fx = _fxShared.get(renderer);
  if (fx) return fx;
  const T = THREE || (renderer && renderer.__mvTHREE);
  const dummy = new T.DataTexture(new Float32Array([1, 1, 1, 1]), 1, 1, T.RGBAFormat, T.FloatType);
  dummy.needsUpdate = true;
  fx = {
    layer: 7,
    uniforms: { uSceneDepth: { value: dummy }, uDepthOn: { value: 0 } },
    begin(depthTexture) { this.uniforms.uSceneDepth.value = depthTexture || dummy; this.uniforms.uDepthOn.value = depthTexture ? 1 : 0; },
    end() { this.uniforms.uSceneDepth.value = dummy; this.uniforms.uDepthOn.value = 0; },
  };
  _fxShared.set(renderer, fx);
  return fx;
}

// cull a vertex (outside clip volume, degenerate)
const GLSL_CULL = /* glsl */ `#define CULL { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }\n`;

// ---------------------------------------------------------------------------------------------------------------
// Shared per-renderer state (world timeline texture) and helpers
// ---------------------------------------------------------------------------------------------------------------
const _timelines = new WeakMap();
function worldFnOf(ctx, opts) {
  const w = (opts && opts.worldSource) || (ctx && ctx.world && typeof ctx.world.at === 'function' ? ctx.world : DEFAULT_WORLD);
  return w;
}
/**
 * Film timeline of slowly varying world quantities that particles need at *past* times:
 *   drift(t) = ∫ windVec dt  (m, x/z) — so gusts move rain/petals/mist correctly (w(t)·t would be wrong),
 *   petalFall(t), rain(t). Configured time domain, pure function of the world curves.
 */
export function getTimeline(THREE, worldSrc) {
  let tl = _timelines.get(worldSrc);
  if (tl) return tl;
  const {start:TL_T0,step:TL_DT,count:TL_N}=particleTimeDomain(worldSrc);
  const data = new Float32Array(TL_N * 4);
  let wx = 0, wz = 0, prev = null;
  // integrate from 0 outward in both directions so drift(0) = 0
  const i0 = Math.round(-TL_T0 / TL_DT);
  const vel = (t) => { const s = worldSrc.at(t); const d = s.windDir || [1, 0, 0]; const l = Math.hypot(d[0], d[2]) || 1; const w = (s.wind || 0) * WIND_MS; return [d[0] / l * w, d[2] / l * w, s.petalFall || 0, s.rain || 0]; };
  const samples = new Array(TL_N);
  for (let i = 0; i < TL_N; i++) samples[i] = vel(TL_T0 + i * TL_DT);
  data[i0 * 4] = 0; data[i0 * 4 + 1] = 0;
  for (let i = i0 + 1; i < TL_N; i++) { wx += 0.5 * (samples[i - 1][0] + samples[i][0]) * TL_DT; wz += 0.5 * (samples[i - 1][1] + samples[i][1]) * TL_DT; data[i * 4] = wx; data[i * 4 + 1] = wz; }
  wx = 0; wz = 0;
  for (let i = i0 - 1; i >= 0; i--) { wx -= 0.5 * (samples[i + 1][0] + samples[i][0]) * TL_DT; wz -= 0.5 * (samples[i + 1][1] + samples[i][1]) * TL_DT; data[i * 4] = wx; data[i * 4 + 1] = wz; }
  for (let i = 0; i < TL_N; i++) { data[i * 4 + 2] = samples[i][2]; data[i * 4 + 3] = samples[i][3]; }
  prev = null;
  const tex = new THREE.DataTexture(data, TL_N, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.needsUpdate = true;
  const at = (t) => {
    const f = Math.min(Math.max((t - TL_T0) / TL_DT, 0), TL_N - 1.001), i = Math.floor(f), u = f - i;
    const a = i * 4, b = (i + 1) * 4;
    return [data[a] + (data[b] - data[a]) * u, data[a + 1] + (data[b + 1] - data[a + 1]) * u, data[a + 2] + (data[b + 2] - data[a + 2]) * u, data[a + 3] + (data[b + 3] - data[a + 3]) * u];
  };
  tl = { tex, at, data, domain:[TL_T0,TL_DT,TL_N-1.001] };
  _timelines.set(worldSrc, tl);
  return tl;
}
const GLSL_TIMELINE = /* glsl */ `
uniform sampler2D uTimeline;   // x,z drift, petal/rain activity
uniform vec3 uTimelineDomain;
vec4 timelineAt(float t){
  float f = clamp((t - uTimelineDomain.x) / uTimelineDomain.y, 0.0, uTimelineDomain.z);
  float i = floor(f);
  vec4 a = texelFetch(uTimeline, ivec2(int(i), 0), 0), b = texelFetch(uTimeline, ivec2(int(i) + 1, 0), 0);
  return mix(a, b, f - i);
}
`;

/** Merged quad batch for vertex pulling: n quads = 4n vertices, indices (0,1,2)(0,2,3). */
function quadBatch(THREE, n) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(4, n * 4)), 1));
  const big = n * 4 > 65535;
  const idx = big ? new Uint32Array(n * 6) : new Uint16Array(n * 6);
  for (let i = 0; i < n; i++) { const b = i * 4, o = i * 6; idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2; idx[o + 3] = b; idx[o + 4] = b + 2; idx[o + 5] = b + 3; }
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1e5, -1e5, -1e5), new THREE.Vector3(1e5, 1e5, 1e5));
  return g;
}
/** Merged grid batch: n items of (gx × gy) vertices each (for petals / ribbons). */
function gridBatch(THREE, n, gx, gy) {
  const vpi = gx * gy, tpi = (gx - 1) * (gy - 1) * 2;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(4, n * vpi)), 1));
  const big = n * vpi > 65535;
  const idx = big ? new Uint32Array(n * tpi * 3) : new Uint16Array(n * tpi * 3);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const b = i * vpi;
    for (let y = 0; y < gy - 1; y++) for (let x = 0; x < gx - 1; x++) {
      const a = b + y * gx + x;
      idx[o++] = a; idx[o++] = a + 1; idx[o++] = a + gx + 1; idx[o++] = a; idx[o++] = a + gx + 1; idx[o++] = a + gx;
    }
  }
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1e5, -1e5, -1e5), new THREE.Vector3(1e5, 1e5, 1e5));
  g.userData.indicesPerItem = tpi * 3;
  return g;
}

function blendProps(THREE, mode) {
  const p = { transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor, blendEquationAlpha: THREE.AddEquation };
  p.blendDst = mode === 'add' ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
  return p;
}

/** Shared uniforms (lens / res) — referenced from ctx.uniforms when the engine provides them. */
function lensUniforms(THREE, ctx) {
  const U = ctx.uniforms || {};
  const own = !U.uLens;
  return {
    uLens: U.uLens || { value: new THREE.Vector4(10, 0, 0.1, 1000) },
    uRes: U.uRes || { value: new THREE.Vector2(ctx.width || 1920, ctx.height || 804) },
    _ownLens: own,
  };
}

function lightUniforms(THREE) {
  return {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Vector3() },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonCol: { value: new THREE.Vector3() },
    uSkyCol: { value: new THREE.Vector3() }, uGndCol: { value: new THREE.Vector3() },
    uPtPos: { value: Array.from({ length: MAX_PT }, () => new THREE.Vector4()) },
    uPtCol: { value: Array.from({ length: MAX_PT }, () => new THREE.Vector3()) },
    uPtN: { value: 0 },
  };
}

const _tmpV = {};
/**
 * Evaluate the light rig for (t, world) into the uniforms U.
 * opts.lights: array of point lights: THREE.PointLight | {pos,color,intensity,radius} | (t,world)=>{...}
 * opts.moon / opts.sun: false | THREE.DirectionalLight | {dir,color,intensity}; default from world (LIB_COMMON §2)
 * opts.sky: [r,g,b] radiance override; opts.moonGain / sunGain / pointGain / skyGain multipliers.
 */
export function evalLights(THREE, U, t, w, opts = {}) {
  const V = _tmpV.v || (_tmpV.v = new THREE.Vector3()), V2 = _tmpV.v2 || (_tmpV.v2 = new THREE.Vector3());
  // --- moon ---
  const setDir = (dirU, colU, spec, defDir, defCol, gain) => {
    if (spec === false) { colU.value.set(0, 0, 0); dirU.value.set(0, 1, 0); return; }
    if (spec && spec.isDirectionalLight) {
      spec.getWorldPosition(V); spec.target.getWorldPosition(V2);
      dirU.value.copy(V).sub(V2).normalize();
      colU.value.set(spec.color.r, spec.color.g, spec.color.b).multiplyScalar(spec.intensity * gain);
      return;
    }
    if (spec && typeof spec === 'object') {
      const d = spec.dir || defDir; dirU.value.set(d[0], d[1], d[2]).normalize();
      const c = spec.color || defCol; colU.value.set(c[0], c[1], c[2]).multiplyScalar((spec.intensity ?? 1) * gain);
      return;
    }
    dirU.value.set(defDir[0], defDir[1], defDir[2]).normalize();
    colU.value.set(defCol[0], defCol[1], defCol[2]).multiplyScalar(gain);
  };
  const moonI = 0.22 * (w.moonlight ?? 0);
  setDir(U.uMoonDir, U.uMoonCol, opts.moon, w.moonDir || [0, 1, 0], [0.62 * moonI, 0.74 * moonI, 0.98 * moonI], opts.moonGain ?? 1);
  // sun: white-ish high, golden low (LIB_COMMON §2), fades below the horizon
  const se = w.sunElev ?? -30;
  const up = Math.min(1, Math.max(0, (se + 1.5) / 4));
  const g = Math.min(1, Math.max(0, (se - 3) / 14));
  const sunI = up * (4.4 + (7.9 - 4.4) * g);
  const sc = [1.0, 0.68 + (0.95 - 0.68) * g, 0.36 + (0.86 - 0.36) * g];
  setDir(U.uSunDir, U.uSunCol, opts.sun, w.sunDir || [0, -1, 0], [sc[0] * sunI, sc[1] * sunI, sc[2] * sunI], opts.sunGain ?? 1);
  // --- ambient sky / ground radiance ---
  let sky;
  if (opts.sky) sky = opts.sky;
  else {
    const day = w.day ?? 0, tw = w.twilight ?? 0, ml = w.moonlight ?? 0;
    const n = [0.0035 + 0.004 * ml, 0.0060 + 0.006 * ml, 0.0110 + 0.009 * ml];
    sky = [n[0] + (0.30 - n[0]) * day + 0.05 * tw, n[1] + (0.40 - n[1]) * day + 0.035 * tw, n[2] + (0.62 - n[2]) * day + 0.04 * tw];
  }
  const sg = opts.skyGain ?? 1;
  U.uSkyCol.value.set(sky[0] * sg, sky[1] * sg, sky[2] * sg);
  const gnd = opts.ground || [sky[0] * 0.25, sky[1] * 0.25, sky[2] * 0.22];
  U.uGndCol.value.set(gnd[0] * sg, gnd[1] * sg, gnd[2] * sg);
  // --- point lights ---
  const lights = typeof opts.lights === 'function' ? opts.lights(t, w) : (opts.lights || []);
  let n = 0;
  const pg = opts.pointGain ?? 1;
  for (let i = 0; i < lights.length && n < MAX_PT; i++) {
    let L = lights[i];
    if (typeof L === 'function') L = L(t, w);
    if (!L) continue;
    if (L.isLight) {
      if (!L.visible) continue;
      L.getWorldPosition(V);
      const r = L.userData && L.userData.radius != null ? L.userData.radius : 0.15;
      U.uPtPos.value[n].set(V.x, V.y, V.z, r);
      U.uPtCol.value[n].set(L.color.r, L.color.g, L.color.b).multiplyScalar(L.intensity * pg);
    } else {
      const p = L.pos || L.position || [0, 0, 0];
      const px = p.isVector3 ? p.x : p[0], py = p.isVector3 ? p.y : p[1], pz = p.isVector3 ? p.z : p[2];
      U.uPtPos.value[n].set(px, py, pz, L.radius ?? 0.15);
      const c = L.color || [1, 0.62, 0.3];
      U.uPtCol.value[n].set(c[0], c[1], c[2]).multiplyScalar((L.intensity ?? 1.1) * pg);
    }
    n++;
  }
  U.uPtN.value = n;
}

/** Compute the engine-compatible lens vector (focus, CoC px radius at ∞, near, far) — only used standalone. */
export function lensVector(camera, lens, resY, sensorWidth = 24.89) {
  const aspect = camera.aspect || 2.388;
  const sensorH = sensorWidth / aspect;
  const focal = lens.focal ?? (sensorH / 2) / Math.tan((camera.fov * Math.PI) / 360);
  const N = Math.max(0.7, lens.fstop ?? 2.8);
  const S1 = Math.max((lens.distance ?? 10) * 1000, focal * 1.05);
  const coc = ((focal * focal) / (N * (S1 - focal)) / sensorH) * resY * 0.5 * (lens.dofScale ?? 1);
  return [lens.distance ?? 10, coc, camera.near, camera.far];
}

/** Tag a system's object: userData.mvParticles = {kind, fx}; FX objects go to ctx.fxLayer when the engine defines it. */
function tagFX(ctx, object, kind, fx = true) {
  object.userData.mvParticles = { kind, fx };
  object.traverse((o) => { o.userData.mvParticles = { kind, fx }; if (fx && Number.isInteger(ctx.fxLayer)) o.layers.set(ctx.fxLayer); });
  return object;
}

function commonUniforms(THREE, ctx, opts, extra = {}) {
  const L = lensUniforms(THREE, ctx);
  const tl = getTimeline(THREE, worldFnOf(ctx, opts));
  const fx = particlesFX(ctx.renderer || ctx, THREE);
  return Object.assign({
    uSceneDepth: fx.uniforms.uSceneDepth, uDepthOn: fx.uniforms.uDepthOn, uSoftDepth: { value: opts.softDepth ?? 0.05 },
    uTime: { value: 0 }, uLens: L.uLens, uRes: L.uRes,
    uCocMax: { value: 40 }, uGain: { value: opts.gain ?? 1 }, uShutter: { value: opts.shutter ?? SHUTTER },
    uTimeline: { value: tl.tex }, uTimelineDomain: {value:new THREE.Vector3(...tl.domain)},
  }, lightUniforms(THREE), extra);
}

/** Per-frame common update: time, lens fallback (standalone), CoC cap, lights. */
function updateCommon(THREE, ctx, U, own, t, w, camera, opts) {
  U.uTime.value = t;
  if (own._ownLens && camera) {
    const lens = (camera.userData && (camera.userData.lens || camera.userData.focus)) || opts.lens || { distance: 10, fstop: 2.8 };
    const v = lensVector(camera, lens, U.uRes.value.y);
    U.uLens.value.set(v[0], v[1], v[2], v[3]);
  }
  U.uCocMax.value = (opts.cocMax ?? 40) * U.uRes.value.y / 804;
  evalLights(THREE, U, t, w, opts);
}

// ---------------------------------------------------------------------------------------------------------------
// Region masks (rain / splashes): world box with ragged (noisy) boundary + exclusion boxes (roofs) + floor
// ---------------------------------------------------------------------------------------------------------------
const GLSL_REGION = /* glsl */ `
uniform vec3 uRegMin; uniform vec3 uRegMax; uniform float uRagged; uniform float uRagScale; uniform float uFloorY;
uniform vec3 uExMin[4]; uniform vec3 uExMax[4]; uniform int uExN;
float regionMask(vec3 p){
  vec3 a = p - uRegMin, b = uRegMax - p;
  float e = min(min(a.x, b.x), min(a.z, b.z));
  float m;
  if (uRagged > 0.0) {
    float n = 0.5 + 0.5 * (0.65 * mvValue(p.xz * uRagScale + 17.3) + 0.35 * mvValue(p.xz * uRagScale * 3.7 - 5.1));
    m = smoothstep(-0.2, 0.2, e - uRagged * n);
  } else m = step(0.0, e);
  m *= step(uFloorY, p.y) * step(p.y, uRegMax.y) * step(uRegMin.y, p.y);
  for (int i = 0; i < 4; i++) {
    if (i >= uExN) break;
    vec3 u = p - uExMin[i], v = uExMax[i] - p;
    float inside = min(min(min(u.x, v.x), min(u.y, v.y)), min(u.z, v.z));
    m *= 1.0 - smoothstep(-0.03, 0.03, inside);
  }
  return m;
}
`;
function regionUniforms(THREE, region = {}) {
  const box = region.box || {};
  const min = box.min || [-1e5, -1e5, -1e5], max = box.max || [1e5, 1e5, 1e5];
  const ex = (region.exclude || []).slice(0, 4);
  return {
    uRegMin: { value: new THREE.Vector3().fromArray(min) }, uRegMax: { value: new THREE.Vector3().fromArray(max) },
    uRagged: { value: region.ragged ?? 0 }, uRagScale: { value: region.raggedScale ?? 0.18 },
    uFloorY: { value: region.floorY ?? -1e5 },
    uExMin: { value: Array.from({ length: 4 }, (_, i) => new THREE.Vector3().fromArray(ex[i] ? ex[i].min : [0, 0, 0])) },
    uExMax: { value: Array.from({ length: 4 }, (_, i) => new THREE.Vector3().fromArray(ex[i] ? ex[i].max : [0, 0, 0])) },
    uExN: { value: ex.length },
  };
}
/** JS version of the region's horizontal extent test for column culling. */
function regionXZIntersects(region, x0, x1, z0, z1) {
  if (!region || !region.box) return true;
  const r = (region.ragged || 0) + 0.5;
  const mn = region.box.min || [-1e5, -1e5, -1e5], mx = region.box.max || [1e5, 1e5, 1e5];
  return !(x1 < mn[0] - r || x0 > mx[0] + r || z1 < mn[2] - r || z0 > mx[2] + r);
}

// ---------------------------------------------------------------------------------------------------------------
// Column selection: world-stable vertical columns (in a frame drifting with the wind) that intersect the camera
// sub-frustum [zNear, zFar]. Each column holds K particles with a vertical wrap window of height H centred on
// what the camera sees at that distance. Pure function of (camera, drift).
// ---------------------------------------------------------------------------------------------------------------
function makeColumnSelector(THREE, { cell, H, maxCols, zNear, zFar, margin = 0.08, floorY = -1e5, ceilY = 1e5, region = null }) {
  const data = new Float32Array(maxCols * 4);
  const tex = new THREE.DataTexture(data, maxCols, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.needsUpdate = true;
  const cullCam = new THREE.PerspectiveCamera();
  const frustum = new THREE.Frustum(), m4 = new THREE.Matrix4(), box = new THREE.Box3();
  const corners = Array.from({ length: 8 }, () => new THREE.Vector3());
  const fwd = new THREE.Vector3(), cpos = new THREE.Vector3();
  const cand = [];
  return {
    tex, data, count: 0,
    update(camera, driftX, driftZ) {
      camera.updateMatrixWorld();
      cullCam.copy(camera, false);
      const tanY = Math.tan((camera.fov * Math.PI) / 360) * (1 + margin) + margin * 0.5;
      cullCam.fov = (Math.atan(tanY) * 360) / Math.PI;
      cullCam.near = Math.max(0.01, zNear); cullCam.far = zFar;
      cullCam.updateProjectionMatrix();
      cullCam.matrixWorld.copy(camera.matrixWorld); cullCam.matrixWorldInverse.copy(camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(m4.multiplyMatrices(cullCam.projectionMatrix, cullCam.matrixWorldInverse));
      const tanX = tanY * cullCam.aspect;
      let k = 0;
      for (const z of [cullCam.near, zFar]) for (const sy of [-1, 1]) for (const sx of [-1, 1]) corners[k++].set(sx * z * tanX, sy * z * tanY, -z).applyMatrix4(camera.matrixWorld);
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const c of corners) { x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); z0 = Math.min(z0, c.z); z1 = Math.max(z1, c.z); }
      const i0 = Math.floor((x0 - driftX) / cell) - 1, i1 = Math.floor((x1 - driftX) / cell) + 1;
      const j0 = Math.floor((z0 - driftZ) / cell) - 1, j1 = Math.floor((z1 - driftZ) / cell) + 1;
      camera.getWorldPosition(cpos); camera.getWorldDirection(fwd);
      const fh = Math.max(1e-3, Math.hypot(fwd.x, fwd.z));
      const pitch = Math.atan2(fwd.y, fh);
      const hv = (camera.fov * Math.PI) / 360 * (1 + margin);
      const lim = 1.3;
      const tUp = Math.tan(Math.min(lim, pitch + hv)), tDn = Math.tan(Math.max(-lim, pitch - hv));
      cand.length = 0;
      const nI = i1 - i0 + 1, nJ = j1 - j0 + 1;
      if (nI * nJ > 200000) { this.count = 0; tex.needsUpdate = true; return 0; }
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const wx0 = i * cell + driftX, wz0 = j * cell + driftZ;
        if (!regionXZIntersects(region, wx0, wx0 + cell, wz0, wz0 + cell)) continue;
        const cx = wx0 + cell * 0.5 - cpos.x, cz = wz0 + cell * 0.5 - cpos.z;
        const df = Math.max(0, (cx * fwd.x + cz * fwd.z) / fh);
        let yc = cpos.y + df * 0.5 * (tUp + tDn);
        yc = Math.max(yc, floorY - 0.25 + H * 0.5);
        yc = Math.min(yc, ceilY + 0.25 - H * 0.5);
        box.min.set(wx0, yc - H * 0.5, wz0); box.max.set(wx0 + cell, yc + H * 0.5, wz0 + cell);
        if (!frustum.intersectsBox(box)) continue;
        cand.push({ i, j, yc, d: cx * cx + cz * cz });
      }
      if (cand.length > maxCols) cand.sort((a, b) => a.d - b.d || a.i - b.i || a.j - b.j);
      const n = Math.min(maxCols, cand.length);
      for (let c = 0; c < n; c++) { const o = c * 4; data[o] = cand[c].i; data[o + 1] = cand[c].j; data[o + 2] = cand[c].yc; data[o + 3] = 1; }
      for (let c = n; c < maxCols; c++) data[c * 4 + 3] = 0;
      tex.needsUpdate = true;
      this.count = n;
      return n;
    },
    dispose() { tex.dispose(); },
  };
}

// ===============================================================================================================
// 1. RAIN
// ===============================================================================================================
const RAIN_LAYERS = {
  //        view-depth window (m)          column  wrap H  drops/m³  drop Ø (mm)   max columns
  near: { z: [0.10, 0.22, 1.5, 2.6], cell: 0.7, H: 3.4, density: 40, D: [1.8, 3.8], maxCols: 110 },
  mid: { z: [1.5, 2.6, 7.5, 11.0], cell: 1.6, H: 10.5, density: 22, D: [1.0, 2.8], maxCols: 180 },
  far: { z: [7.5, 11.0, 32, 48], cell: 4.0, H: 38, density: 0.45, D: [0.5, 1.5], maxCols: 200, rep: 2 },
  // importance-sampled dense volume around each practical light (only drops near lights are ever visible)
  halo: { radius: 2.2, density: 150, D: [1.2, 3.2] },
};

// water drop: broad refracted lobe + back-refraction + ~6% isotropic surface reflection + faint rainbow bump (138°)
const GLSL_DROP_PHASE = /* glsl */ `
#define PHASE(c) (0.50*hgPhase(c, 0.78) + 0.36*hgPhase(c, 0.30) + 0.07/(4.0*PI) + 0.02*exp(-400.0*((c) + 0.743)*((c) + 0.743)))
#define AMBIENT_K 0.5
`;
// Shared streak emitter (rain, splash droplets, falling drips). Needs GLSL_VCOMMON + GLSL_LIGHTS (+PHASE).
const GLSL_STREAK = /* glsl */ `
uniform float uCull, uMoonBoost, uDebug, uRep;
uniform vec4 uZWin;
out vec4 vA;   // s (px from tail), x (px across), L (px), gaussian sigma (px)
out vec4 vB;   // chord radius (px), gaussian->disc mix, bead phase, bead cycles
out vec3 vC;   // total flux (px units)
out vec3 vD;   // big drops: x = drop radius (px), y = specular-line offset (px, signed across the streak), z = CoC (px)
// One corner of a motion-blurred, light-catching, self-defocusing water-drop streak.
// head/tail = positions at shutter close/open, Dmm = drop diameter (mm), w = weight, bead = random [0,1)
bool emitStreak(vec3 head, vec3 tail, float Dmm, float w, float bead, int corner){
  vec4 vh = viewMatrix * vec4(head, 1.0);
  float z = -vh.z;
  if (z < 0.06) return false;
  w *= smoothstep(uZWin.x, uZWin.y, z) * (1.0 - smoothstep(uZWin.z, uZWin.w, z));
  if (w <= 0.0) return false;
  vec4 vt = viewMatrix * vec4(tail, 1.0);
  if (-vt.z < 0.03) { tail = head; vt = vh; }
  vec4 ch = projectionMatrix * vh, ct = projectionMatrix * vt;
  vec2 sh = (ch.xy / ch.w * 0.5 + 0.5) * uRes, st = (ct.xy / ct.w * 0.5 + 0.5) * uRes;
  vec2 d = sh - st; float L = length(d);
  vec2 dir = L > 1e-4 ? d / L : vec2(0.0, 1.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float fpx = focalPx();
  float rd = 0.5e-3 * Dmm * fpx / z;
  float R = min(abs(cocPx(z)), uCocMax);
  float sig = sqrt(0.28 + 0.25 * rd * rd + 0.25 * R * R);
  float rc = sqrt(R * R + rd * rd + 0.6);
  float mixc = smoothstep(1.6, 4.0, R);
  // lighting: radiant intensity toward the camera -> total image-plane flux Q (sum of pixel values)
  vec3 V = normalize(cameraPosition - head);
  vec3 E = inscatter(head, V);
  E += uMoonCol * (uMoonBoost - 1.0) * PHASE(dot(-uMoonDir, V)) * DIR_MASK(head);
  float sigma = 0.785398 * Dmm * Dmm * 1e-6;
  vec3 Q = E * sigma * fpx * fpx / (z * z) * w * uGain * uRep;
  if (uDebug > 0.0) Q = vec3(uDebug) * w;
  if (uDebug < 0.0) Q = E * (-uDebug) * w;
  float area = L * 2.0 * mix(sig * 1.25, rc, mixc) + PI * mix(sig * sig * 1.6, rc * rc, mixc);
  float peak = max(max(Q.r, Q.g), Q.b) / max(area, 1.0);
  if (peak < uCull) return false;
  float ext = mix(2.8 * sig, rc + 0.75, mixc);
  float along = (corner == 1 || corner == 2) ? 1.0 : 0.0;
  float side = corner >= 2 ? 1.0 : -1.0;
  vec2 P = mix(st, sh, along) + dir * (along * 2.0 - 1.0) * ext + nrm * side * ext;
  vA = vec4(along * L + (along * 2.0 - 1.0) * ext, side * ext, L, sig);
  vB = vec4(rc, mixc, bead * 6.2831853, 1.0 + 2.5 * fract(bead * 7.13));
  vC = Q;
  // glassy look for drops several px wide: specular line on the side facing the brightest practical
  float side2 = 1.0;
  if (uPtN > 0) { vec4 cl = projectionMatrix * viewMatrix * vec4(uPtPos[0].xyz, 1.0); vec2 sl = (cl.xy / max(cl.w, 1e-3) * 0.5 + 0.5) * uRes; side2 = dot(sl - sh, nrm) >= 0.0 ? 1.0 : -1.0; }
  vD = vec3(rd, 0.38 * rd * side2, R);
  vec2 ndc = P / uRes * 2.0 - 1.0;
  gl_Position = vec4(ndc * ch.w, ch.z, ch.w);
  return true;
}
`;
function streakUniforms(opts, extra = {}) {
  return Object.assign({
    uCull: { value: opts.cull ?? 2e-4 }, uMoonBoost: { value: opts.moonBoost ?? 25 }, uDebug: { value: opts.debug ?? 0 }, uRep: { value: 1 },
    uZWin: { value: null },
  }, extra);
}

const RAIN_VS = GLSL_VCOMMON + GLSL_NOISE + GLSL_CULL + GLSL_DROP_PHASE + GLSL_LIGHTS + GLSL_REGION + GLSL_STREAK + /* glsl */ `
uniform sampler2D uCols;
uniform float uCell, uH, uK, uSeed, uAmount;
uniform vec3 uDrift, uWindVel;
uniform vec2 uDRange;
uniform vec4 uHalo;        // HALO layer: xyz centre (light position), w radius (m)
void main(){
  int vid = gl_VertexID; int q = vid >> 2; int corner = vid & 3;
#ifdef HALO
  // dense world-stable wrap volume (2R)³ around a practical light; radial falloff hides the box
  uvec3 h1 = mvPcg3d(uvec3(uint(q), uint(uSeed), 0x51ed27u));
  vec3 r1 = vec3(h1) * MV_U2F;
  vec3 r2 = vec3(mvPcg3d(h1 ^ uvec3(0x9e3779b9u, 0x85ebca6bu, 0xc2b2ae35u))) * MV_U2F;
  float act = clamp((uAmount - r2.x) * 14.0, 0.0, 1.0);
  if (act <= 0.0) CULL
  float Dmm = mix(uDRange.x, uDRange.y, pow(r2.y, 1.7));
  float vT = 9.65 - 10.3 * exp(-0.6 * Dmm);
  float S = 2.0 * uHalo.w;
  vec3 bmin = uHalo.xyz - vec3(uHalo.w);
  vec3 head = bmin + mod(r1 * S + uDrift - vec3(0.0, vT * uTime, 0.0) - bmin, vec3(S));
  float we = smoothstep(1.0, 0.55, length(head - uHalo.xyz) / uHalo.w);
#else
  int K = int(uK + 0.5);
  int slot = q / K; int k = q - slot * K;
  vec4 col = texelFetch(uCols, ivec2(slot, 0), 0);
  if (col.w < 0.5) CULL
  uvec3 h1 = mvPcg3d(uvec3(uint(int(col.x) + 32768), uint(int(col.y) + 32768), uint(k) * 7919u + uint(uSeed)));
  vec3 r1 = vec3(h1) * MV_U2F;
  vec3 r2 = vec3(mvPcg3d(h1 ^ uvec3(0x9e3779b9u, 0x85ebca6bu, 0xc2b2ae35u))) * MV_U2F;
  float act = clamp((uAmount - r2.x) * 14.0, 0.0, 1.0);
  if (act <= 0.0) CULL
  float Dmm = mix(uDRange.x, uDRange.y, pow(r2.y, 1.7));
  float vT = 9.65 - 10.3 * exp(-0.6 * Dmm);                    // terminal velocity (Atlas 1973)
  float yb = col.z - 0.5 * uH;
  vec3 head = vec3((col.x + r1.x) * uCell + uDrift.x, 0.0, (col.y + r1.y) * uCell + uDrift.z);
  head.y = yb + mod(r1.z * uH - vT * uTime - yb, uH);
  float yr = (head.y - yb) / uH;
  float we = smoothstep(0.0, 0.03, yr) * smoothstep(1.0, 0.97, yr);
#endif
  float m = regionMask(head);
  if (m <= 0.0) CULL
  vec3 vel = vec3(uWindVel.x, -vT, uWindVel.z);
  float bright = 0.35 + 0.55 * r2.z + 2.2 * pow(r2.z, 8.0);    // per-drop glint variation (rare bright glints)
  if (!emitStreak(head, head - vel * uShutter, Dmm, act * m * we * bright, fract(r2.z * 13.7 + r1.y), corner)) CULL
}`;

const RAIN_FS = GLSL_COMMON + FS_HEAD + /* glsl */ `
in vec4 vA; in vec4 vB; in vec3 vC; in vec3 vD;
// motion-blurred gaussian dot (in focus) or segment ⊗ disc (defocused, "chord" profile) — both unit-mass
float gaussSeg(float s, float x, float L, float sg){
  float a = L > 0.3 ? (normCdf((L - s) / sg) - normCdf(-s / sg)) / L : exp(-0.5 * s * s / (sg * sg)) * 0.39894228 / sg;
  return a * exp(-0.5 * x * x / (sg * sg)) * 0.39894228 / sg;
}
float chordSeg(float s, float x, float L, float rc){
  float h = sqrt(max(rc * rc - x * x, 0.0));
  float Lc = max(L, 1e-3);
  return max(0.0, min(Lc, s + h) - max(0.0, s - h)) / (Lc * PI * rc * rc);
}
void main(){
  float s = vA.x, x = vA.y, L = vA.z;
  float m = vB.y, v;
  if (m < 0.002) v = gaussSeg(s, x, L, vA.w);
  else if (m > 0.998) v = chordSeg(s, x, L, vB.x);
  else v = mix(gaussSeg(s, x, L, vA.w), chordSeg(s, x, L, vB.x), m);
  float rd = vD.x, Rc = vD.z;
  float gl = smoothstep(2.5, 6.0, rd);
  if (gl > 0.0) {
    // resolved drop = transparent water column: thin specular line + Fresnel edges + faint body (unit mass
    // across x), each widened by the defocus radius
    float s1 = sqrt(max(0.06 * rd, 0.6) * max(0.06 * rd, 0.6) + 0.25 * Rc * Rc), s2 = sqrt(max(0.05 * rd, 0.6) * max(0.05 * rd, 0.6) + 0.25 * Rc * Rc);
    float along = L > 0.3 ? (normCdf((L - s) / s1) - normCdf(-s / s1)) / L : exp(-0.5 * s * s / (s1 * s1)) * 0.39894228 / s1;
    float xl = x - vD.y;
    float cr = 0.78 * exp(-0.5 * xl * xl / (s1 * s1)) * 0.39894228 / s1
             + 0.08 * (exp(-0.5 * (x - 0.88 * rd) * (x - 0.88 * rd) / (s2 * s2)) + exp(-0.5 * (x + 0.88 * rd) * (x + 0.88 * rd) / (s2 * s2))) * 0.39894228 / s2
             + 0.06 * smoothstep(rd + 0.5 * Rc, 0.8 * rd - 0.5 * Rc, abs(x)) / (1.8 * rd);
    v = mix(v, along * cr, gl) * mix(1.0, 0.3, gl);   // resolved drops: less artistic boost
  }
  // oscillating drops glint unevenly along the exposure
  float u = clamp(s / max(L, 1.0), 0.0, 1.0);
  v *= 1.0 + 0.22 * (1.0 - m) * sin(u * vB.w * 6.2831853 + vB.z);
  fragColor = vec4(vC * v * fxDepthFade(), 0.0);
}`;

// distant rain curtains (40–600 m): camera-facing sheets with a fast-scrolling anisotropic streak texture
const CURTAIN_VS = /* glsl */ `
uniform vec3 uC; uniform vec2 uHalf;
out vec2 vUv; out vec3 vW;
void main(){
  vec3 toC = cameraPosition - uC; toC.y = 0.0;
  vec3 f = normalize(toC + vec3(1e-5, 0.0, 0.0));
  vec3 ax = normalize(cross(vec3(0.0, 1.0, 0.0), f));
  vec3 w = uC + position.x * ax * uHalf.x + vec3(0.0, (position.y * 0.5 + 0.5) * uHalf.y * 2.0, 0.0);
  vUv = position.xy; vW = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
const CURTAIN_FS = GLSL_COMMON + GLSL_NOISE + GLSL_DROP_PHASE + GLSL_LIGHTS + GLSL_REGION + FS_HEAD + /* glsl */ `
in vec2 vUv; in vec3 vW;
uniform sampler2D uNoiseTex; uniform float uAmount, uDens, uNear, uFar, uSlant, uSeedOff, uMoonBoost;
uniform vec2 uHalf;
void main(){
  float m = regionMask(vec3(vW.x, max(vW.y, uFloorY + 0.01), vW.z));
  if (m <= 0.0) discard;
  float dc = length(cameraPosition - vW);
  float fd = smoothstep(uNear, uNear * 1.6, dc) * (1.0 - smoothstep(uFar * 0.6, uFar, dc));
  float e = smoothstep(1.0, 0.45, abs(vUv.x)) * smoothstep(1.0, 0.1, vUv.y) * smoothstep(-1.0, -0.9, vUv.y);  // long soft top, soft sides/bottom
  float x = vUv.x * uHalf.x;                                                     // metres across the sheet
  // rain shafts: large-scale density variation drifting with the wind, slowly descending
  float sh = texture(uNoiseTex, vec2(x / 55.0 + uSeedOff, vW.y / 38.0 + uTime * 0.02) ).r;
  float veil = 0.45 + 0.9 * smoothstep(0.3, 0.75, sh);
  // faint unresolved streak texture (hash columns ~0.25 m, segments falling at 7 m/s)
  float col = floor(x / 0.25);
  float yy = vW.y + uTime * 7.0 + mvHash11(col + uSeedOff * 131.0) * 20.0 + x * uSlant;
  float cell = floor(yy / 1.3);
  vec2 hh = mvHash22(vec2(col, cell));
  float fy = fract(yy / 1.3);
  float stk = step(0.55, hh.x) * smoothstep(0.0, 0.08, fy - hh.y * 0.6) * smoothstep(0.25, 0.1, fy - hh.y * 0.6);
  float tex = 1.0 + 0.25 * (stk - 0.2);
  vec3 V = normalize(cameraPosition - vW);
  vec3 E = inscatter(vW, V) + uMoonCol * (uMoonBoost - 1.0) * PHASE(dot(-uMoonDir, V));
  float k = uAmount * uDens * m * fd * e * veil * tex;
  fragColor = vec4(E * k * 0.012 * uGain * fxDepthFade(), 0.0);
}`;

/**
 * createRain(ctx, opts) — 3 depth layers of motion-blurred, light-catching rain streaks around the camera.
 * opts:
 *   seed, scale=1 (× world.rain), gain=1, moonBoost=6 (artistic extra silver on moon-backlit streaks),
 *   lights: [...] (see evalLights; e.g. the lantern PointLight with userData.radius=0.3), moon/sun/sky overrides,
 *   region: { box:{min,max}, ragged (m), raggedScale, floorY, exclude:[{min,max}...] (roofs) },
 *   layers: { near:{...}, mid:{...}, far:{...} } overrides of RAIN_LAYERS (false disables a layer),
 *   density=1 (× all layer densities), windScale=1, cull=2e-4 (min peak pixel value to rasterise),
 *   dirMask: GLSL expression body 'float f(vec3 p)' for moon/sun visibility (e.g. under a roof = 0).
 */
export function createRain(ctx, opts = {}) {
  const THREE = ctx.THREE;
  opts = Object.assign({ pointGain: 40 }, opts);
  const group = new THREE.Group();
  group.name = 'mvRain';
  const q = qScale(ctx);
  const worldSrc = worldFnOf(ctx, opts);
  const tl = getTimeline(THREE, worldSrc);
  const layers = [];
  const baseSeed = seedNum(opts.seed ?? 'rain', 'rain');
  const dirMaskDef = opts.dirMask ? `float dirMaskFn(vec3 p){ ${opts.dirMask} }\n#define DIR_MASK(p) dirMaskFn(p)\n` : '';
  for (const name of ['far', 'mid', 'near']) {
    const ov = opts.layers && opts.layers[name];
    if (ov === false) continue;
    const cfg = Object.assign({}, RAIN_LAYERS[name], ov || {});
    const K = Math.max(1, Math.round(cfg.density * (opts.density ?? 1) * q * cfg.cell * cfg.cell * cfg.H));
    const maxCols = Math.max(4, Math.round(cfg.maxCols));
    const sel = makeColumnSelector(THREE, { cell: cfg.cell, H: cfg.H, maxCols, zNear: cfg.z[0], zFar: cfg.z[3], floorY: opts.region?.floorY ?? -1e5, region: opts.region });
    const U = commonUniforms(THREE, ctx, opts, Object.assign({
      uCols: { value: sel.tex }, uCell: { value: cfg.cell }, uH: { value: cfg.H }, uK: { value: K },
      uSeed: { value: (baseSeed + name.length * 7717) % 1000003 }, uAmount: { value: 0 },
      uDrift: { value: new THREE.Vector3() }, uWindVel: { value: new THREE.Vector3() },
      uDRange: { value: new THREE.Vector2(cfg.D[0], cfg.D[1]) },
      uHalo: { value: new THREE.Vector4() },
    }, streakUniforms(opts, { uRep: { value: cfg.rep ?? 1 }, uZWin: { value: new THREE.Vector4().fromArray(cfg.z) } }), regionUniforms(THREE, opts.region)));
    const geo = quadBatch(THREE, maxCols * K);
    const mat = new THREE.ShaderMaterial(Object.assign({
      name: 'mvRain_' + name, glslVersion: THREE.GLSL3, uniforms: U,
      vertexShader: dirMaskDef + RAIN_VS, fragmentShader: RAIN_FS,
      depthWrite: false, depthTest: true, side: THREE.DoubleSide, toneMapped: false, fog: false,
    }, blendProps(THREE, 'add')));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.name = 'mvRain_' + name;
    mesh.renderOrder = 10;
    group.add(mesh);
    layers.push({ name, cfg, K, sel, U, mesh, geo, mat });
  }
  // light-halo layers (one per point light, up to opts.haloLights = 2)
  const hcfg = Object.assign({}, RAIN_LAYERS.halo, (opts.layers && opts.layers.halo) || {});
  const nHalo = (opts.layers && opts.layers.halo === false) ? 0 : Math.min(opts.haloLights ?? 2, MAX_PT);
  for (let hi = 0; hi < nHalo; hi++) {
    const S = 2 * hcfg.radius;
    const count = Math.max(16, Math.round(hcfg.density * (opts.density ?? 1) * q * S * S * S));
    const U = commonUniforms(THREE, ctx, opts, Object.assign({
      uCols: { value: null }, uCell: { value: 1 }, uH: { value: 1 }, uK: { value: 1 },
      uSeed: { value: (baseSeed + 101 * (hi + 1)) % 1000003 }, uAmount: { value: 0 },
      uDrift: { value: new THREE.Vector3() }, uWindVel: { value: new THREE.Vector3() },
      uDRange: { value: new THREE.Vector2(hcfg.D[0], hcfg.D[1]) },
      uHalo: { value: new THREE.Vector4(0, -1e4, 0, hcfg.radius) },
    }, streakUniforms(opts, { uZWin: { value: new THREE.Vector4(0.08, 0.2, 1e4, 1e5) } }), regionUniforms(THREE, opts.region)));
    const geo = quadBatch(THREE, count);
    const mat = new THREE.ShaderMaterial(Object.assign({
      name: 'mvRain_halo' + hi, glslVersion: THREE.GLSL3, uniforms: U, defines: { HALO: 1 },
      vertexShader: dirMaskDef + RAIN_VS, fragmentShader: RAIN_FS,
      depthWrite: false, depthTest: true, side: THREE.DoubleSide, toneMapped: false, fog: false,
    }, blendProps(THREE, 'add')));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.name = 'mvRain_halo' + hi; mesh.renderOrder = 10;
    group.add(mesh);
    layers.push({ name: 'halo' + hi, halo: hi, cfg: hcfg, K: count, sel: null, U, mesh, geo, mat });
  }
  
  const curtains = [];
  if (opts.curtain) {
    const cfg = Object.assign({ count: ctx.quality === 'final' ? 10 : 6, near: 40, far: 700, width: 90, height: 110, density: 1 }, typeof opts.curtain === 'object' ? opts.curtain : {});
    const rb = (opts.region && opts.region.box) || { min: [-300, 0, -300], max: [300, 60, 300] };
    const Rc = makeRng((opts.seed ?? 'rain') + ':curtain');
    const qg = new THREE.PlaneGeometry(2, 2);
    const cx0 = Math.max(rb.min[0], -2000), cx1 = Math.min(rb.max[0], 2000), cz0 = Math.max(rb.min[2], -2000), cz1 = Math.min(rb.max[2], 2000);
    const baseY = opts.region?.floorY ?? rb.min[1] ?? 0;
    for (let i = 0; i < cfg.count; i++) {
      const c = [cx0 + (cx1 - cx0) * Rc(), Math.max(baseY, -1000), cz0 + (cz1 - cz0) * Rc()];
      const U = commonUniforms(THREE, ctx, opts, Object.assign({
        uC: { value: new THREE.Vector3().fromArray(c) }, uHalf: { value: new THREE.Vector2(cfg.width * (0.7 + 0.6 * Rc()) / 2, cfg.height * (0.8 + 0.4 * Rc()) / 2) },
        uNoiseTex: { value: getNoiseTexture(THREE) }, uAmount: { value: 0 }, uDens: { value: cfg.density }, uNear: { value: cfg.near }, uFar: { value: cfg.far },
        uSlant: { value: 0 }, uSeedOff: { value: Rc() * 10 }, uMoonBoost: { value: opts.moonBoost ?? 25 },
      }, regionUniforms(THREE, opts.region)));
      const mat = new THREE.ShaderMaterial(Object.assign({ name: 'mvRainCurtain' + i, glslVersion: THREE.GLSL3, uniforms: U, vertexShader: CURTAIN_VS, fragmentShader: CURTAIN_FS, depthWrite: false, depthTest: true, side: THREE.DoubleSide }, blendProps(THREE, 'add')));
      const mesh = new THREE.Mesh(qg, mat); mesh.frustumCulled = false; mesh.name = 'mvRainCurtain' + i; mesh.renderOrder = 8;
      mesh.position.fromArray(c);
      group.add(mesh);
      curtains.push({ U, mesh, mat });
    }
  }
  const own = lensUniforms(THREE, ctx);
  tagFX(ctx, group, 'rain');
  return {
    object: group, layers,
    update(t, w, camera) {
      const amount = Math.min(1, Math.max(0, (w.rain ?? 0) * (opts.scale ?? 1)));
      const dr = tl.at(t);
      const ws = opts.windScale ?? 1;
      const wv = (() => { const d = w.windDir || [1, 0, 0]; const l = Math.hypot(d[0], d[2]) || 1; const s = (w.wind || 0) * WIND_MS * ws; return [d[0] / l * s, d[2] / l * s]; })();
      let active = 0;
      for (const L of layers) {
        updateCommon(THREE, ctx, L.U, own, t, w, camera, opts);
        L.U.uAmount.value = amount;
        L.U.uDrift.value.set(dr[0] * ws, 0, dr[1] * ws);
        L.U.uWindVel.value.set(wv[0], 0, wv[1]);
        if (L.halo !== undefined) {
          const on = amount > 0 && L.halo < L.U.uPtN.value;
          if (on) { const p = L.U.uPtPos.value[L.halo]; L.U.uHalo.value.set(p.x, p.y, p.z, L.cfg.radius); }
          L.mesh.visible = on;
          active += on ? L.K : 0;
          continue;
        }
        const n = amount > 0 ? L.sel.update(camera, dr[0] * ws, dr[1] * ws) : 0;
        L.geo.setDrawRange(0, n * L.K * 6);
        L.mesh.visible = n > 0;
        active += n * L.K;
      }
      for (const C of curtains) {
        updateCommon(THREE, ctx, C.U, own, t, w, camera, opts);
        C.U.uAmount.value = amount;
        C.U.uSlant.value = (wv[0] + wv[1]) * 0.08;
        C.mesh.visible = amount > 0;
      }
      this.activeCount = active;
    },
    activeCount: 0,
    dispose() { for (const L of layers) { L.geo.dispose(); L.mat.dispose(); if (L.sel) L.sel.dispose(); } for (const C of curtains) C.mat.dispose(); },
  };
}

// ===============================================================================================================
// 2. SPLASHES, RING RIPPLES & the ripple function/texture for water shaders
// ===============================================================================================================
/**
 * GLSL_RIPPLES — closed-form rain ring ripples on a horizontal surface (water, puddles). Prepend GLSL_HASH/NOISE.
 *   vec3 mvRainRipples(vec2 p, float t, float amount, float seed, float tileCells)
 *     p: world xz (m), t: film time (s), amount: 0..1 (world.rain × wetness), seed: any float,
 *     tileCells: 0 = infinite plane, N > 0 = periodic with period N·MVR_CELL (for tiling textures).
 *     returns vec3(dh/dx, dh/dz, h): surface slopes and height (m). Perturb a normal with
 *     n = normalize(vec3(-r.x, 1.0, -r.y)) (optionally scaled by a strength / distance fade).
 *   Each 0.2 m cell holds 3 impact "slots"; slot k emits ring n at t = (n - φ)·P (P ∈ [0.5,1.0] s) if
 *   hash(n) < amount — so rain density, ring radius and fade are all pure functions of t.
 *   vec3 mvRing(vec2 dp, float age, float amp): one ring (used for eave-drip impacts);
 *   vec3 mvRingScaled(vec2 dp, float age, float amp, float scale): same, `scale`× larger & √scale× faster.
 */
export const GLSL_RIPPLES = /* glsl */ `
#ifndef MV_RIPPLES_GLSL
#define MV_RIPPLES_GLSL
const float MVR_CELL = 0.20;
const float MVR_V = 0.24;
const float MVR_LIFE = 0.8;
vec3 mvRing(vec2 dp, float a, float amp){
  float d = length(dp);
  float r = 0.003 + MVR_V * a;
  float lam = 0.016 + 0.012 * a;
  float k = 6.2831853 / lam;
  float w = 0.55 * lam + 0.012 * a;
  float x = d - r;
  // wave packet: leading crest + 1-2 trailing rings inside
  float env = exp(-(x * x) / (w * w)) + 0.45 * exp(-((x + 1.6 * lam) * (x + 1.6 * lam)) / (w * w));
  float denv = -2.0 * x / (w * w) * exp(-(x * x) / (w * w)) - 0.9 * (x + 1.6 * lam) / (w * w) * exp(-((x + 1.6 * lam) * (x + 1.6 * lam)) / (w * w));
  float A = amp * 0.00045 * exp(-a / 0.30) / sqrt(1.0 + r / 0.012) * smoothstep(0.0, 0.02, a);
  float c = cos(k * x), sn = sin(k * x);
  float h = A * env * c;
  float dh = A * (denv * c - env * k * sn);
  vec2 g = d > 1e-6 ? dp / d * dh : vec2(0.0);
  return vec3(g, h);
}
// ring scaled by s (> 1 = larger, faster: deep-water dispersion c ∝ √λ); slopes are scale-invariant
vec3 mvRingScaled(vec2 dp, float a, float amp, float s){ vec3 r = mvRing(dp / s, a / sqrt(s), amp); return vec3(r.xy, r.z * s); }
vec3 mvRainRipples(vec2 p, float t, float amount, float seed, float tileCells){
  vec2 cp = floor(p / MVR_CELL);
  vec3 acc = vec3(0.0);
  if (amount <= 0.0) return acc;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = cp + vec2(float(i), float(j));
    vec2 cw = tileCells > 0.0 ? mod(c, tileCells) : c;
    for (int k = 0; k < 3; k++) {
      uvec3 hh = mvPcg3d(uvec3(uint(int(cw.x) + 40000), uint(int(cw.y) + 40000), uint(k) + uint(seed) * 16u));
      vec3 r = vec3(hh) * MV_U2F;
      float P = mix(0.5, 1.0, r.x);
      float ph = t / P + r.y;
      float n = floor(ph);
      float a = (ph - n) * P;
      if (a > MVR_LIFE) continue;
      vec3 e = vec3(mvPcg3d(hh ^ uvec3(uint(int(n) + 1000000), 0x9e3779b9u, 0x7f4a7c15u))) * MV_U2F;
      if (e.z > amount) continue;
      vec2 ctr = (c + 0.08 + 0.84 * e.xy) * MVR_CELL;
      acc += mvRing(p - ctr, a, 0.55 + 0.9 * r.z);
    }
  }
  return acc;
}
#endif
`;

const RIPPLE_TEX_FS = GLSL_NOISE + GLSL_RIPPLES + /* glsl */ `
precision highp float;
uniform float uTime, uAmount, uSeed, uTileCells;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
void main(){
  vec2 p = vUv * uTileCells * MVR_CELL;
  vec3 r = mvRainRipples(p, uTime, uAmount, uSeed, uTileCells);
  fragColor = vec4(r.xy, r.z * 1000.0, 1.0);
}`;

/**
 * createRippleTexture(ctx, {tileCells=10 (→ 2 m tile), res=384, seed, scale=1})
 *   -> { texture, tileSize (m), update(t, world), dispose }
 * A seamlessly tiling HalfFloat texture of the rain-ripple field at time t, rendered in update() with the
 * passed renderer (pure function of t and world.rain). Channels: r,g = dh/dx, dh/dz (slopes), b = height (mm).
 * Water shader:  vec4 R = texture(tRipple, worldPos.xz / tileSize);
 *                vec3 n = normalize(vec3(-R.x * k, 1.0, -R.y * k));   // k ~ 1, fade with distance
 */
export function createRippleTexture(ctx, opts = {}) {
  const THREE = ctx.THREE;
  const tileCells = opts.tileCells ?? 10;
  const res = opts.res ?? (ctx.quality === 'final' ? 384 : 192);
  const rt = new THREE.WebGLRenderTarget(res, res, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
  rt.texture.wrapS = rt.texture.wrapT = THREE.RepeatWrapping;
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
    uniforms: { uTime: { value: 0 }, uAmount: { value: 0 }, uSeed: { value: seedNum(opts.seed ?? 'ripple', 'r') % 997 }, uTileCells: { value: tileCells } },
    vertexShader: 'out vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: RIPPLE_TEX_FS,
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(geo, mat); quad.frustumCulled = false;
  const sc = new THREE.Scene(); sc.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  let lastKey = null;
  return {
    texture: rt.texture, tileSize: tileCells * 0.2, target: rt,
    update(t, w) {
      const amount = Math.min(1, Math.max(0, (w.rain ?? 0) * (opts.scale ?? 1)));
      const key = t + ':' + amount;
      if (key === lastKey) return;
      lastKey = key;
      mat.uniforms.uTime.value = t; mat.uniforms.uAmount.value = amount;
      const prev = ctx.renderer.getRenderTarget();
      ctx.renderer.setRenderTarget(rt); ctx.renderer.render(sc, cam); ctx.renderer.setRenderTarget(prev);
    },
    dispose() { rt.dispose(); mat.dispose(); geo.dispose(); },
  };
}

/**
 * createRingEvents(ctx, {events:[{t, x, z, amp=1, scale=1}], max=24, life=3})
 *   Music-driven ring ripples for water shaders (music-driven rings crossing water): pass note events
 *   (e.g. from ctx.audio / song.json notes) with a world position; update(t) publishes the ≤ max most recent live rings.
 *   -> { uniforms (merge by reference into the water material), glsl (GLSL_RIPPLES + vec3 mvEventRipples(vec2 xz)),
 *        update(t), activeCount }.   Water shader: n = normalize(n + vec3(-r.x, 0.0, -r.y) * k) with r = mvEventRipples(p.xz).
 */
export function createRingEvents(ctx, opts = {}) {
  const THREE = ctx.THREE;
  const max = Math.min(opts.max ?? 24, 48);
  const ev = (opts.events || []).slice().sort((a, b) => a.t - b.t);
  const U = {
    uEvRings: { value: Array.from({ length: max }, () => new THREE.Vector4(0, 0, -1, 0)) },
    uEvScale: { value: new Array(max).fill(1) },
    uEvN: { value: 0 },
  };
  const glsl = GLSL_RIPPLES + `
uniform vec4 uEvRings[${max}]; uniform float uEvScale[${max}]; uniform int uEvN;
vec3 mvEventRipples(vec2 p){ vec3 acc = vec3(0.0);
  for (int i = 0; i < ${max}; i++) { if (i >= uEvN) break; acc += mvRingScaled(p - uEvRings[i].xy, uEvRings[i].z, uEvRings[i].w, uEvScale[i]); }
  return acc; }
`;
  const api = {
    uniforms: U, glsl, activeCount: 0,
    update(t) {
      let n = 0;
      for (let i = ev.length - 1; i >= 0 && n < max; i--) {
        const e = ev[i], sc = e.scale ?? 1, age = t - e.t;
        if (age < 0) continue;
        if (age > (opts.life ?? 3) * Math.sqrt(sc)) break;
        U.uEvRings.value[n].set(e.x, e.z, age, e.amp ?? 1); U.uEvScale.value[n] = sc; n++;
      }
      U.uEvN.value = n; api.activeCount = n;
    },
  };
  return api;
}

// ---- splash droplets (crowns): each impact slot throws M droplets ballistically; lit like rain ----
const SPLASH_VS = GLSL_VCOMMON + GLSL_NOISE + GLSL_CULL + GLSL_DROP_PHASE + GLSL_LIGHTS + GLSL_REGION + GLSL_STREAK + /* glsl */ `
uniform vec3 uOrigin;       // area min corner (x, y=surface, z)
uniform vec2 uCells;        // cells in x,z
uniform float uCellSize, uSlots, uDrops, uSeed, uAmount, uSpeed;
void main(){
  int vid = gl_VertexID; int q = vid >> 2; int corner = vid & 3;
  int M = int(uDrops + 0.5), KS = int(uSlots + 0.5);
  int ev = q / M, m = q - ev * M;
  int cellI = ev / KS, k = ev - cellI * KS;
  int cx = cellI % int(uCells.x), cz = cellI / int(uCells.x);
  uvec3 hh = mvPcg3d(uvec3(uint(cx + 7), uint(cz + 131), uint(k) + uint(uSeed) * 8u));
  vec3 r = vec3(hh) * MV_U2F;
  float P = mix(0.28, 0.55, r.x);
  float ph = uTime / P + r.y;
  float n = floor(ph);
  float a = (ph - n) * P;
  vec3 e = vec3(mvPcg3d(hh ^ uvec3(uint(int(n) + 1000000), 0x2545f491u, 0x9e3779b9u))) * MV_U2F;
  if (e.z > uAmount) CULL
  vec3 ctr = uOrigin + vec3((float(cx) + 0.05 + 0.9 * e.x) * uCellSize, 0.0, (float(cz) + 0.05 + 0.9 * e.y) * uCellSize);
  if (regionMask(ctr + vec3(0.0, 0.01, 0.0)) <= 0.0) CULL
  // droplet m of the crown
  vec3 d = vec3(mvPcg3d(uvec3(hh.x ^ uint(m * 977 + 3), uint(int(n) + 7), hh.z))) * MV_U2F;
  float ang = 6.2831853 * (float(m) + 0.6 * d.x) / float(M) + e.x * 6.28;
  float big = step(0.82, e.x * 0.5 + d.z * 0.5);                // a few bigger impacts throw higher
  float vr = uSpeed * mix(0.25, 1.0, d.y) * (1.0 + 0.5 * big);
  float vy = uSpeed * mix(0.35, 0.95, d.z * d.z) * (1.0 + 0.45 * big);   // crowns rise 1-6 cm
  float g = 9.81;
  float tland = 2.0 * vy / g;
  if (a > tland) CULL
  vec3 v0 = vec3(cos(ang) * vr, vy, sin(ang) * vr);
  vec3 head = ctr + v0 * a + vec3(0.0, -0.5 * g * a * a, 0.0);
  float a0 = max(0.0, a - uShutter);
  vec3 tail = ctr + v0 * a0 + vec3(0.0, -0.5 * g * a0 * a0, 0.0);
  float Dmm = mix(0.4, 1.2, d.x * d.y) * (1.0 + 0.4 * big);
  float fade = smoothstep(tland, tland * 0.8, a);
  if (!emitStreak(head, tail, Dmm, fade * (0.6 + 0.8 * d.z), d.x, corner)) CULL
}`;

// ---- ring overlay for small puddles: specular glints of the lights on each ring's slopes ----
const RING_VS = GLSL_VCOMMON + GLSL_NOISE + GLSL_CULL + GLSL_RIPPLES + /* glsl */ `
uniform vec3 uOrigin; uniform vec2 uCells; uniform float uSeed, uAmount;
uniform vec4 uPtPos[${MAX_PT}]; uniform vec3 uPtCol[${MAX_PT}]; uniform int uPtN;
uniform vec3 uMoonDir; uniform vec3 uMoonCol;
out vec3 vW; out vec3 vCtr; out float vAge; out float vAmp;
void main(){
  int vid = gl_VertexID; int q = vid >> 2; int corner = vid & 3;
  int cellI = q / 3, k = q - cellI * 3;
  int cx = cellI % int(uCells.x), cz = cellI / int(uCells.x);
  // identical event logic to mvRainRipples (absolute cell index)
  vec2 c = floor(uOrigin.xz / MVR_CELL) + vec2(float(cx), float(cz));
  uvec3 hh = mvPcg3d(uvec3(uint(int(c.x) + 40000), uint(int(c.y) + 40000), uint(k) + uint(uSeed) * 16u));
  vec3 r = vec3(hh) * MV_U2F;
  float P = mix(0.5, 1.0, r.x);
  float ph = uTime / P + r.y;
  float n = floor(ph);
  float a = (ph - n) * P;
  if (a > MVR_LIFE) CULL
  vec3 e = vec3(mvPcg3d(hh ^ uvec3(uint(int(n) + 1000000), 0x9e3779b9u, 0x7f4a7c15u))) * MV_U2F;
  if (e.z > uAmount) CULL
  vec2 ctr = (c + 0.08 + 0.84 * e.xy) * MVR_CELL;
  float R = 0.003 + MVR_V * a + 0.05;
  vec3 C = vec3(ctr.x, uOrigin.y, ctr.y);
  // only rings near a light's mirror point can glint: skip the rest (saves fill)
  vec3 V = normalize(cameraPosition - C);
  float best = 0.0;
  for (int i = 0; i < ${MAX_PT}; i++) { if (i >= uPtN) break; vec3 Ld = normalize(uPtPos[i].xyz - C); vec3 H = normalize(Ld + V); best = max(best, H.y); }
  { vec3 H = normalize(uMoonDir + V); best = max(best, H.y * step(0.001, dot(uMoonCol, vec3(1.0)))); }
  if (best < 0.93) CULL
  vec2 off = vec2(corner == 1 || corner == 2 ? 1.0 : -1.0, corner >= 2 ? 1.0 : -1.0) * R;
  vec3 W = C + vec3(off.x, 0.0015, off.y);
  vW = W; vCtr = C; vAge = a; vAmp = 0.55 + 0.9 * r.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(W, 1.0);
}`;
const RING_FS = GLSL_COMMON + GLSL_NOISE + GLSL_RIPPLES + FS_HEAD + /* glsl */ `
uniform vec4 uPtPos[${MAX_PT}]; uniform vec3 uPtCol[${MAX_PT}]; uniform int uPtN;
uniform vec3 uMoonDir; uniform vec3 uMoonCol; uniform float uRough;
in vec3 vW; in vec3 vCtr; in float vAge; in float vAmp;
float ggx(float nh, float a){ float a2 = a * a; float d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float specL(vec3 n, vec3 V, vec3 L){ vec3 H = normalize(L + V); float nl = max(dot(n, L), 0.0), nv = max(dot(n, V), 0.02);
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0); return ggx(max(dot(n, H), 0.0), uRough) * F * nl / (4.0 * nl * nv + 1e-4) ; }
void main(){
  vec3 rr = mvRing(vW.xz - vCtr.xz, vAge, vAmp);
  vec3 n = normalize(vec3(-rr.x, 1.0, -rr.y));
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 V = normalize(cameraPosition - vW);
  vec3 c = vec3(0.0);
  for (int i = 0; i < ${MAX_PT}; i++) {
    if (i >= uPtN) break;
    vec3 d = uPtPos[i].xyz - vW; float r2 = dot(d, d); vec3 L = d * inversesqrt(r2);
    vec3 E = uPtCol[i] / (r2 + uPtPos[i].w * uPtPos[i].w);
    c += E * max(specL(n, V, L) - specL(up, V, L), 0.0);
  }
  c += uMoonCol * max(specL(n, V, uMoonDir) - specL(up, V, uMoonDir), 0.0);
  fragColor = vec4(c * uGain * fxDepthFade(), 0.0);
}`;

/**
 * createSplashes(ctx, opts) — rain impacts on a horizontal patch.
 * opts: area:{center:[x,y,z] (y = surface height), size:[w,d]}, surface:'stone'|'puddle'|'water',
 *       crowns (default: stone/puddle true), rings (default puddle/water true; small patches only — for big water
 *       surfaces use GLSL_RIPPLES / createRippleTexture in the water shader), density=1, scale=1 (× world.rain),
 *       speed=1 (crown launch speed), lights/moon/sun (as rain), pointGain (default 40 like rain), region.
 * Returns { object, update, dispose, ripple: createRippleTexture(...) handle if opts.rippleTexture }.
 */
export function createSplashes(ctx, opts = {}) {
  const THREE = ctx.THREE;
  opts = Object.assign({ pointGain: 300, moonBoost: 60 }, opts);
  const group = new THREE.Group(); group.name = 'mvSplashes';
  const q = qScale(ctx);
  const surface = opts.surface || 'stone';
  const area = opts.area || { center: [0, 0, 0], size: [4, 4] };
  const [cxw, cyw, czw] = area.center, [sw, sd] = area.size;
  const seed = seedNum(opts.seed ?? 'splash', 's') % 99991;
  const parts = [];
  const own = lensUniforms(THREE, ctx);
  if (opts.crowns ?? (surface !== 'water')) {
    const cell = (opts.crownCell ?? 0.22) / Math.sqrt(Math.max(0.05, (opts.density ?? 1) * q));
    const nx = Math.max(1, Math.round(sw / cell)), nz = Math.max(1, Math.round(sd / cell));
    const slots = 3, drops = surface === 'puddle' ? 4 : 6;
    const U = commonUniforms(THREE, ctx, opts, Object.assign({
      uOrigin: { value: new THREE.Vector3(cxw - sw / 2, cyw, czw - sd / 2) }, uCells: { value: new THREE.Vector2(nx, nz) },
      uCellSize: { value: sw / nx }, uSlots: { value: slots }, uDrops: { value: drops }, uSeed: { value: seed }, uAmount: { value: 0 },
      uSpeed: { value: (opts.speed ?? 1) * (surface === 'puddle' ? 0.8 : 1.0) },
    }, streakUniforms(opts, { uZWin: { value: new THREE.Vector4(0.05, 0.12, 1e4, 1e5) } }), regionUniforms(THREE, opts.region)));
    const n = nx * nz * slots * drops;
    const geo = quadBatch(THREE, n);
    const mat = new THREE.ShaderMaterial(Object.assign({ name: 'mvSplashCrowns', glslVersion: THREE.GLSL3, uniforms: U, vertexShader: SPLASH_VS, fragmentShader: RAIN_FS, depthWrite: false, depthTest: true, side: THREE.DoubleSide }, blendProps(THREE, 'add')));
    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 11; mesh.name = 'mvSplashCrowns';
    geo.boundingSphere.center.set(cxw, cyw, czw);
    group.add(mesh);
    parts.push({ U, mesh, geo, mat, count: n });
  }
  if (opts.rings ?? (surface !== 'stone')) {
    const c0x = Math.floor((cxw - sw / 2) / 0.2), c0z = Math.floor((czw - sd / 2) / 0.2);
    const nx = Math.max(1, Math.ceil(sw / 0.2)), nz = Math.max(1, Math.ceil(sd / 0.2));
    const U = commonUniforms(THREE, ctx, opts, {
      uOrigin: { value: new THREE.Vector3(c0x * 0.2 + 0.1, cyw, c0z * 0.2 + 0.1) }, uCells: { value: new THREE.Vector2(nx, nz) },
      uSeed: { value: seedNum(opts.seed ?? 'splash', 'rings') % 997 }, uAmount: { value: 0 }, uRough: { value: opts.roughness ?? 0.07 },
    });
    U.uGain.value = opts.ringGain ?? 1;
    const n = nx * nz * 3;
    const geo = quadBatch(THREE, n);
    const mat = new THREE.ShaderMaterial(Object.assign({ name: 'mvSplashRings', glslVersion: THREE.GLSL3, uniforms: U, vertexShader: RING_VS, fragmentShader: RING_FS, depthWrite: false, depthTest: true, side: THREE.DoubleSide }, blendProps(THREE, 'add')));
    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 9; mesh.name = 'mvSplashRings';
    geo.boundingSphere.center.set(cxw, cyw, czw);
    group.add(mesh);
    parts.push({ U, mesh, geo, mat, count: n, rings: true });
  }
  const ripple = opts.rippleTexture ? createRippleTexture(ctx, { seed: opts.seed, ...(typeof opts.rippleTexture === 'object' ? opts.rippleTexture : {}) }) : null;
  tagFX(ctx, group, 'splashes');
  return {
    object: group, ripple, GLSL: GLSL_RIPPLES,
    update(t, w, camera) {
      const amount = Math.min(1, Math.max(0, (w.rain ?? 0) * (opts.scale ?? 1)));
      for (const P of parts) {
        updateCommon(THREE, ctx, P.U, own, t, w, camera, P.rings ? Object.assign({}, opts, { pointGain: opts.ringPointGain ?? 1 }) : opts);
        P.U.uAmount.value = amount;
        P.mesh.visible = amount > 0;
      }
      if (ripple) ripple.update(t, w);
      this.activeCount = parts.reduce((a, P) => a + (P.mesh.visible ? P.count : 0), 0);
    },
    activeCount: 0,
    dispose() { for (const P of parts) { P.geo.dispose(); P.mat.dispose(); } if (ripple) ripple.dispose(); },
  };
}

// ===============================================================================================================
// 3. EAVE DRIP LINE
// ===============================================================================================================
const MAXD = 40;          // drip points per line
const DRIP_SLOTS = 6;     // drops in flight per point
const _dripTL = new WeakMap();
/** drip rate timeline: lagged rain (eaves keep dripping ~40 s after the rain stops) and its integral Φ(t). */
function getDripTimeline(worldSrc) {
  let d = _dripTL.get(worldSrc);
  if (d) return d;
  const {start:TL_T0,step:dt,count:N}=particleTimeDomain(worldSrc);
  const rain = new Float32Array(N), lag = new Float32Array(N), phi = new Float64Array(N);
  for (let i = 0; i < N; i++) rain[i] = worldSrc.at(TL_T0 + i * dt).rain || 0;
  const tau = 14; // s, drain time constant of the roof
  let acc = 0;
  for (let i = 0; i < N; i++) { acc = Math.max(rain[i], acc * Math.exp(-dt / tau)); lag[i] = acc; }
  const rate = (l) => (l < 0.004 ? 0 : 0.22 + 5.2 * l * l) * Math.min(1, l / 0.03); // drips / s / point
  const i0 = Math.round(-TL_T0 / dt);
  phi[i0] = 0;
  for (let i = i0 + 1; i < N; i++) phi[i] = phi[i - 1] + 0.5 * (rate(lag[i - 1]) + rate(lag[i])) * dt;
  for (let i = i0 - 1; i >= 0; i--) phi[i] = phi[i + 1] - 0.5 * (rate(lag[i + 1]) + rate(lag[i])) * dt;
  const at = (t) => {
    const f = Math.min(Math.max((t - TL_T0) / dt, 0), N - 1.001), i = Math.floor(f), u = f - i;
    return { phi: phi[i] + (phi[i + 1] - phi[i]) * u, rate: rate(lag[i] + (lag[i + 1] - lag[i]) * u), lag: lag[i] + (lag[i + 1] - lag[i]) * u };
  };
  d = { at };
  _dripTL.set(worldSrc, d);
  return d;
}

const GLSL_DRIP_UNI = /* glsl */ `
uniform vec4 uDP[${MAXD}];    // drip point: xyz tip position, w = detach velocity (m/s, thread flow)
uniform vec4 uDS[${MAXD}];    // state: x = cycle fraction, y = drops/s, z = thread length (m), w = event index (mod 4096)
uniform int uDN;
uniform float uLandY, uSeed, uBeadR;
`;

const DRIP_FALL_VS = GLSL_VCOMMON + GLSL_NOISE + GLSL_CULL + GLSL_DROP_PHASE + GLSL_LIGHTS + GLSL_DRIP_UNI + GLSL_STREAK + /* glsl */ `
void main(){
  int vid = gl_VertexID; int q = vid >> 2; int corner = vid & 3;
  int i = q / ${DRIP_SLOTS + 1}, m = q - i * ${DRIP_SLOTS + 1};
  if (i >= uDN) CULL
  vec4 P = uDP[i], S = uDS[i];
  float g = 9.81;
  float rnd = mvHash31(vec3(float(i),S.w,float(m)));
  if (m == ${DRIP_SLOTS}) {
    // continuous thread from the tile edge (heavy flow): a thin glinting column that wobbles
    if (S.z < 0.004) CULL
    vec3 top = P.xyz;
    vec3 bot = P.xyz + vec3(0.002 * sin(uTime * 23.0 + float(i)), -S.z, 0.002 * cos(uTime * 19.0 + float(i) * 1.7));
    if (!emitStreak(bot, top, 1.0, 0.35 * S.z / 0.05, rnd, corner)) CULL
    return;
  }
  if (S.y <= 0.0) CULL
  float a = (S.x + float(m)) / S.y;                // time since this drop detached
  float v0 = P.w;
  float y0 = P.y - S.z;
  float h = y0 - uLandY;
  float tl = (-v0 + sqrt(v0 * v0 + 2.0 * g * max(h, 0.0))) / g;
  if (a > tl || h <= 0.0) CULL
  float a0 = max(0.0, a - uShutter);
  vec3 head = vec3(P.x, y0 - v0 * a - 0.5 * g * a * a, P.z);
  vec3 tail = vec3(P.x, y0 - v0 * a0 - 0.5 * g * a0 * a0, P.z);
  float Dmm = mix(3.4, 4.6, rnd);
  if (!emitStreak(head, tail, Dmm, 1.0, rnd, corner)) CULL
}`;

// landing crowns: droplets thrown by each drop that landed < 0.35 s ago
const DRIP_CROWN_VS = GLSL_VCOMMON + GLSL_NOISE + GLSL_CULL + GLSL_DROP_PHASE + GLSL_LIGHTS + GLSL_DRIP_UNI + GLSL_STREAK + /* glsl */ `
uniform float uWaterLand;
void main(){
  int vid = gl_VertexID; int q = vid >> 2; int corner = vid & 3;
  int NDR = 8;
  int ev = q / NDR, k = q - ev * NDR;
  int i = ev / ${DRIP_SLOTS}, m = ev - i * ${DRIP_SLOTS};
  if (i >= uDN) CULL
  vec4 P = uDP[i], S = uDS[i];
  if (S.y <= 0.0) CULL
  float g = 9.81;
  float a = (S.x + float(m)) / S.y;
  float v0 = P.w; float y0 = P.y - S.z; float h = y0 - uLandY;
  float tl = (-v0 + sqrt(v0 * v0 + 2.0 * g * max(h, 0.0))) / g;
  float al = a - tl;
  if (al < 0.0 || al > 0.4) CULL
  float ev_id = S.w - float(m);
  vec3 d = vec3(mvPcg3d(uvec3(uint(i * 131 + k), uint(int(ev_id) + 4096), uint(uSeed)))) * MV_U2F;
  float vimp = v0 + g * tl;                                  // impact speed
  float ang = 6.2831853 * (float(k) + 0.7 * d.x) / float(NDR);
  float vr = mix(0.25, 0.9, d.y) * (0.5 + 0.12 * vimp);
  float vy = mix(0.5, 1.25, d.z) * (0.45 + 0.1 * vimp) * (uWaterLand > 0.5 && k == 0 ? 2.2 : 1.0);   // on water: a Worthington jet
  if (uWaterLand > 0.5 && k == 0) vr = 0.02;
  float tf = 2.0 * vy / g;
  if (al > tf) CULL
  vec3 c = vec3(P.x, uLandY, P.z);
  vec3 v = vec3(cos(ang) * vr, vy, sin(ang) * vr);
  float a0 = max(0.0, al - uShutter);
  vec3 head = c + v * al + vec3(0.0, -0.5 * g * al * al, 0.0);
  vec3 tail = c + v * a0 + vec3(0.0, -0.5 * g * a0 * a0, 0.0);
  float Dmm = (uWaterLand > 0.5 && k == 0) ? 2.2 : mix(0.5, 1.5, d.x);
  if (!emitStreak(head, tail, Dmm, smoothstep(tf, tf * 0.75, al), d.y, corner)) CULL
}`;

// rings where drops land on water (big, several wavelets): same shading as puddle rings
const DRIP_RING_VS = GLSL_VCOMMON + GLSL_NOISE + GLSL_CULL + GLSL_RIPPLES + GLSL_DRIP_UNI + /* glsl */ `
uniform vec4 uPtPos[${MAX_PT}]; uniform vec3 uPtCol[${MAX_PT}]; uniform int uPtN;
out vec3 vW; out vec3 vCtr; out float vAge; out float vAmp;
void main(){
  int vid = gl_VertexID; int q = vid >> 2; int corner = vid & 3;
  int i = q / ${DRIP_SLOTS}, m = q - i * ${DRIP_SLOTS};
  if (i >= uDN) CULL
  vec4 P = uDP[i], S = uDS[i];
  if (S.y <= 0.0) CULL
  float g = 9.81;
  float a = (S.x + float(m)) / S.y;
  float v0 = P.w; float y0 = P.y - S.z; float h = y0 - uLandY;
  float tl = (-v0 + sqrt(v0 * v0 + 2.0 * g * max(h, 0.0))) / g;
  float al = (a - tl) * 0.75;                             // big drops: slower-decaying, larger rings
  if (al < 0.0 || al > 1.1) CULL
  vec3 C = vec3(P.x, uLandY, P.z);
  float R = 0.003 + MVR_V * al + 0.07;
  vec2 off = vec2(corner == 1 || corner == 2 ? 1.0 : -1.0, corner >= 2 ? 1.0 : -1.0) * R;
  vec3 W = C + vec3(off.x, 0.0015, off.y);
  vW = W; vCtr = C; vAge = al; vAmp = 2.6;
  gl_Position = projectionMatrix * viewMatrix * vec4(W, 1.0);
}`;

// hanging bead at the tile edge: refractive sphere impostor (reflection + ball-lens image of the lights),
// self-defocusing to a bokeh disc of the same flux.
const DRIP_BEAD_VS = GLSL_VCOMMON + GLSL_NOISE + GLSL_CULL + GLSL_DROP_PHASE + GLSL_LIGHTS + GLSL_DRIP_UNI + /* glsl */ `
out vec2 vP;        // pixel offset from bead centre
out vec4 vS;        // x r_px, y stretch, z CoC px, w bokeh mix
out vec3 vC;        // world centre
out vec3 vQ;        // bokeh flux (px units)
void main(){
  int vid = gl_VertexID; int i = vid >> 2; int corner = vid & 3;
  if (i >= uDN) CULL
  vec4 P = uDP[i], S = uDS[i];
  if (S.y <= 0.0 && S.x <= 0.0) CULL
  float f = S.x;
  float r = uBeadR * pow(clamp(f, 0.02, 1.0), 0.333);                 // volume grows linearly
  if (S.z > 0.004) r *= 0.75;                                         // thread end: smaller beads
  float stretch = 1.0 + 0.55 * smoothstep(0.75, 1.0, f);              // pendant elongation before detaching
  vec3 C = P.xyz - vec3(0.0, S.z + r * stretch * 0.95, 0.0);
  C.x += 0.00025 * sin(uTime * 31.0 + float(i) * 2.1) * f;             // tremble
  vec4 vc = viewMatrix * vec4(C, 1.0);
  float z = -vc.z;
  if (z < 0.03) CULL
  float fpx = focalPx();
  float rpx = max(r * fpx / z, 0.35);
  float R = min(abs(cocPx(z)), uCocMax);
  float bm = smoothstep(0.25, 1.0, R / max(rpx, 0.5));
  vec3 V = normalize(cameraPosition - C);
  float sigma = PI * r * r;
  vec3 Q = inscatter(C, V) * sigma * fpx * fpx / (z * z) * uGain;
  float ext = max(rpx * stretch, rpx) + R + 1.5;
  vec2 off = vec2(corner == 1 || corner == 2 ? 1.0 : -1.0, corner >= 2 ? 1.0 : -1.0) * ext;
  vec4 cc = projectionMatrix * vc;
  vP = off; vS = vec4(rpx, stretch, R, bm); vC = C; vQ = Q;
  gl_Position = cc + vec4(off / uRes * 2.0 * cc.w, 0.0, 0.0);
}`;
const DRIP_BEAD_FS = GLSL_COMMON + GLSL_LIGHTS.replace(/vec3 inscatter[\s\S]*$/, '') + FS_HEAD + /* glsl */ `
in vec2 vP; in vec4 vS; in vec3 vC; in vec3 vQ;
uniform float uImgGain;   // 1/pointGain: the drop's mirror/lens images use the lights' physical radiance
vec3 env(vec3 d){ // night environment seen in / through the drop: dim sky above, darker ground below
  vec3 c = mix(uGndCol, uSkyCol, smoothstep(-0.15, 0.25, d.y));
  for (int i = 0; i < 4; i++) {           // surroundings lit by the practicals (eaves, haze, wet wood) glow around them
    if (i >= uPtN) break;
    vec3 L = uPtPos[i].xyz - vC; float dist = length(L);
    c += uPtCol[i] * uImgGain * (0.3 * pow(max(dot(d, L / dist), 0.0), 4.0) + 0.02) / (1.0 + 0.3 * dist * dist);
  }
  float mc = dot(d, uMoonDir);
  c += uMoonCol * 120.0 * smoothstep(0.99990, 0.99998, mc) + uMoonCol * 0.8 * pow(max(mc, 0.0), 60.0);
  c += uSunCol * 50.0 * smoothstep(0.99985, 0.99995, dot(d, uSunDir));
  return c;
}
vec3 lightsAlong(vec3 p, vec3 d){ // radiance of practical lights seen along direction d (lanterns as glowing discs)
  vec3 c = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (i >= uPtN) break;
    vec3 L = uPtPos[i].xyz - p; float dist = length(L); L /= dist;
    float rad = max(uPtPos[i].w, 0.05) * 0.7;
    float ca = cos(atan(rad / dist));
    float disc = smoothstep(ca - (1.0 - ca) * 0.6, ca + (1.0 - ca) * 0.3, dot(d, L));
    c += uPtCol[i] * uImgGain / (PI * rad * rad) * disc;
  }
  return c;
}
void main(){
  float rpx = vS.x, st = vS.y, R = vS.z, bm = vS.w;
  vec2 p = vP / rpx;
  p.y = (p.y + (st - 1.0) * 0.35) / st;           // pendant: longer, centre of mass lower
  float rr = dot(p, p);
  vec4 sharp = vec4(0.0);
  if (bm < 0.999 && rr < 1.0) {
    vec3 nv = vec3(p, sqrt(1.0 - rr));
    mat3 iv = transpose(mat3(viewMatrix));
    vec3 N = normalize(iv * nv);
    vec3 V = normalize(cameraPosition - vC);
    vec3 I = -V;
    float cosi = max(dot(N, V), 0.0);
    float F = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);
    vec3 Rr = reflect(I, N);
    vec3 refl = env(Rr) + lightsAlong(vC, Rr);
    // ball lens: refract in, cross the sphere, refract out
    vec3 d1 = refract(I, N, 0.75);
    vec3 P2 = -dot(d1, N) * 2.0 * d1 + N;            // exit point on unit sphere (relative to centre)
    vec3 N2 = normalize(P2);
    vec3 d2 = refract(d1, -N2, 1.333);
    if (dot(d2, d2) < 0.5) d2 = reflect(d1, -N2);
    vec3 tran = env(d2) + lightsAlong(vC, d2);
    vec3 col = F * refl + (1.0 - F) * 0.92 * tran;
    float edge = smoothstep(1.0, 0.86, rr);
    float a = mix(1.0, 0.72, edge) * smoothstep(1.0, 0.94, rr);
    sharp = vec4(col * uGain * smoothstep(1.0, 0.94, rr), a);
  }
  // defocused: uniform disc with the drop's scattered flux
  float Rb = sqrt(rpx * rpx + R * R);
  float dd = length(vP) / Rb;
  vec4 bok = vec4(vQ / (PI * Rb * Rb) * smoothstep(1.0, 0.92, dd) * (1.0 + 0.12 * smoothstep(0.6, 0.97, dd)), 0.0);
  fragColor = mix(sharp, bok, bm) * fxDepthFade();
}`;

/**
 * createDripLine(ctx, opts) — a row of drips falling from a tile edge.
 * opts: start:[x,y,z], end:[x,y,z] (the drip edge), count (default length/0.21 m), seed,
 *   landingY (surface height below), landing:'stone'|'water' (crowns, + rings/jet on water),
 *   lights (lantern!), rate=1 (× drip rate), beadRadius=0.0023 (m), gain, pointGain (default 40),
 *   jitter=0.02 (m, irregular tile ends).
 * Drip rate follows a lagged world.rain (eaves keep dripping ~40 s after the rain stops).
 * Extras for water shaders (the landing rings on a basin / river surface):
 *   rippleGLSL (includes GLSL_RIPPLES + `uniform vec4 uDripImp[16]; uniform int uDripImpN;` and
 *   `vec3 mvDripRipples(vec2 p)` -> (dh/dx, dh/dz, h)); rippleUniforms (merge into the water material's uniforms —
 *   shared objects, refreshed by update()); points: drip positions.
 */
export function createDripLine(ctx, opts = {}) {
  const THREE = ctx.THREE;
  opts = Object.assign({ pointGain: 40, moonBoost: 25 }, opts);
  const group = new THREE.Group(); group.name = 'mvDripLine';
  const a = new THREE.Vector3().fromArray(opts.start || [-1, 2.6, 0]), b = new THREE.Vector3().fromArray(opts.end || [1, 2.6, 0]);
  const len = a.distanceTo(b);
  const n = Math.min(MAXD, Math.max(1, opts.count ?? Math.round(len / 0.21) + 1));
  const R = makeRng(opts.seed ?? 'drip');
  const pts = [];
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0.5 : i / (n - 1);
    const j = opts.jitter ?? 0.02;
    const p = a.clone().lerp(b, u);
    p.x += (R() - 0.5) * j; p.z += (R() - 0.5) * j; p.y += (R() - 0.5) * j * 0.5;
    pts.push({ p, k: 0.55 + 0.9 * R() * R() + 0.2 * R(), ph: R(), thread: R() });
  }
  const landingY = opts.landingY ?? 0;
  const water = (opts.landing || 'stone') === 'water';
  const worldSrc = worldFnOf(ctx, opts);
  const dtl = getDripTimeline(worldSrc);
  const seed = seedNum(opts.seed ?? 'drip', 'd') % 9973;
  const base = () => ({
    uDP: { value: Array.from({ length: MAXD }, () => new THREE.Vector4()) },
    uDS: { value: Array.from({ length: MAXD }, () => new THREE.Vector4()) },
    uDN: { value: 0 }, uLandY: { value: landingY }, uSeed: { value: seed }, uBeadR: { value: opts.beadRadius ?? 0.0026 },
  });
  const shared = base();
  const parts = [];
  const own = lensUniforms(THREE, ctx);
  const mk = (name, vs, fs, count, blend, extra = {}, ro = 12) => {
    const U = commonUniforms(THREE, ctx, opts, Object.assign({}, shared, extra));
    const geo = quadBatch(THREE, count);
    geo.boundingSphere.center.copy(a).lerp(b, 0.5);
    const mat = new THREE.ShaderMaterial(Object.assign({ name, glslVersion: THREE.GLSL3, uniforms: U, vertexShader: vs, fragmentShader: fs, depthWrite: false, depthTest: true, side: THREE.DoubleSide }, blendProps(THREE, blend)));
    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = ro; mesh.name = name;
    group.add(mesh); parts.push({ U, mesh, geo, mat });
    return U;
  };
  mk('mvDripFall', DRIP_FALL_VS, RAIN_FS, n * (DRIP_SLOTS + 1), 'add', streakUniforms(opts, { uZWin: { value: new THREE.Vector4(0.02, 0.05, 1e4, 1e5) } }));
  mk('mvDripCrown', DRIP_CROWN_VS, RAIN_FS, n * DRIP_SLOTS * 8, 'add', Object.assign(streakUniforms(Object.assign({}, opts, { pointGain: opts.crownGain ?? 300 }), { uZWin: { value: new THREE.Vector4(0.02, 0.05, 1e4, 1e5) } }), { uWaterLand: { value: water ? 1 : 0 } }));
  if (water) { const U = mk('mvDripRings', DRIP_RING_VS, RING_FS, n * DRIP_SLOTS, 'add', { uRough: { value: opts.roughness ?? 0.06 } }, 9); U.uGain.value = opts.ringGain ?? 1; }
  mk('mvDripBeads', DRIP_BEAD_VS, DRIP_BEAD_FS, n, 'premul', { uImgGain: { value: 1 / (opts.pointGain || 1) } }, 13);
  const impU = { uDripImp: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) }, uDripImpN: { value: 0 } };
  const g = 9.81;
  const state = (t) => {
    const d = dtl.at(t);
    const out = [];
    for (let i = 0; i < n; i++) {
      const P = pts[i];
      const rate = d.rate * P.k * (opts.rate ?? 1);
      const ph = d.phi * P.k * (opts.rate ?? 1) + P.ph;
      const idx = Math.floor(ph);
      const thread = rate > 2.4 ? (0.02 + 0.16 * Math.min(1, (rate - 2.4) / 3.5)) * (0.6 + 0.8 * P.thread) : 0;
      const v0 = thread > 0 ? Math.sqrt(2 * g * thread) * 0.8 : 0;
      out.push({ frac: ph - idx, rate, thread, v0, idx });
    }
    return out;
  };
  tagFX(ctx, group, 'drips');
  return {
    object: group, points: pts.map((P) => P.p.toArray()),
    update(t, w, camera) {
      const st = state(t);
      for (const Pt of parts) {
        updateCommon(THREE, ctx, Pt.U, own, t, w, camera, Pt.mat.name === 'mvDripCrown' ? Object.assign({}, opts, { pointGain: opts.crownGain ?? 300 }) : Pt.mat.name === 'mvDripRings' ? Object.assign({}, opts, { pointGain: opts.ringPointGain ?? 1 }) : opts);
      }
      for (let i = 0; i < n; i++) {
        const P = pts[i].p, S = st[i];
        shared.uDP.value[i].set(P.x, P.y, P.z, S.v0);
        shared.uDS.value[i].set(S.rate > 0 ? S.frac : 0, S.rate, S.thread, S.idx % 4096);
      }
      shared.uDN.value = n;
      // recent impacts for water shaders
      let k = 0;
      for (let i = 0; i < n && k < 16; i++) {
        const S = st[i]; if (S.rate <= 0) continue;
        const y0 = pts[i].p.y - S.thread, h = y0 - landingY;
        const tl = (-S.v0 + Math.sqrt(S.v0 * S.v0 + 2 * g * Math.max(h, 0))) / g;
        for (let m = 0; m < DRIP_SLOTS && k < 16; m++) {
          const age = (S.frac + m) / S.rate - tl;
          if (age >= 0 && age < 1.4) impU.uDripImp.value[k++].set(pts[i].p.x, pts[i].p.z, age * 0.75, 2.6);
        }
      }
      impU.uDripImpN.value = k;
      this.activeCount = n;
    },
    activeCount: 0,
    rippleUniforms: impU,
    rippleGLSL: GLSL_RIPPLES + /* glsl */ `
uniform vec4 uDripImp[16]; uniform int uDripImpN;
vec3 mvDripRipples(vec2 p){ vec3 acc = vec3(0.0); for (int i = 0; i < 16; i++) { if (i >= uDripImpN) break; acc += mvRing(p - uDripImp[i].xy, uDripImp[i].z, uDripImp[i].w); } return acc; }
`,
    dispose() { for (const Pt of parts) { Pt.geo.dispose(); Pt.mat.dispose(); } },
  };
}

// ===============================================================================================================
// 4. PLUM PETALS (falling / lifting / resting)
// ===============================================================================================================
const PG = 5;                         // petal grid (PG × PG vertices)
const PETAL_COMMON = /* glsl */ `
uniform float uSeed, uAmount, uWindResp, uMB;
uniform vec3 uBoxMin, uBoxSize;         // wrap volume (world)
uniform vec3 uDrift;                    // wind drift at t
uniform vec3 uDriftPrev;                // wind drift at t - shutter
uniform vec4 uLift;                     // x t0, y duration, z height, w radius   (lift gust; y <= 0 = off)
uniform vec4 uLiftC;                    // xyz centre, w swirl (rad)
uniform float uLiftSpin;
out vec2 vPU;       // petal-local (along 0..1, across -0.5..0.5)
out vec3 vPW;       // world position
out vec3 vPN;       // world normal (front side)
out vec4 vPP;       // x pinkness, y brightness, z seed, w alpha factor
out vec2 vPS;       // petal length / width (m)
mat3 rotAxis(vec3 a, float ang){ float c = cos(ang), s = sin(ang), t = 1.0 - c;
  return mat3(t*a.x*a.x + c, t*a.x*a.y + s*a.z, t*a.x*a.z - s*a.y,  t*a.x*a.y - s*a.z, t*a.y*a.y + c, t*a.y*a.z + s*a.x,  t*a.x*a.z + s*a.y, t*a.y*a.z - s*a.x, t*a.z*a.z + c); }
float n1(float x, float s){ return mvGradient1(x, uint(s)); }
// cupped petal surface: local (along X, across Y, up Z) for grid coords (a, b)
float gFold = 0.0, gWave = 0.0, gWaveP = 0.0;
vec3 petalLocal(float a, float b, float L, float W, float cup, float curl){
  float X = (a - 0.5) * L, Y = b * W;
  float r2 = (X * X) / (0.25 * L * L) + (Y * Y) / (0.25 * W * W);
  float Z = cup * L * r2 + curl * L * pow(max(a - 0.72, 0.0) / 0.28, 2.0) - 0.04 * L * sin(3.14159 * a);
  Z += gFold * L * abs(b) * smoothstep(0.05, 0.4, a);                                 // midrib crease (V)
  Z += gWave * L * sin(6.2831853 * (a * 1.3 + b * 0.9) + gWaveP) * (b * b * 4.0) * a;   // wavy margin
  return vec3(X, Y, Z);
}
vec3 petalNormal(float a, float b, float L, float W, float cup, float curl){
  float e = 0.02;
  vec3 p0 = petalLocal(a, b, L, W, cup, curl);
  vec3 pa = petalLocal(a + e, b, L, W, cup, curl) - petalLocal(a - e, b, L, W, cup, curl);
  vec3 pb = petalLocal(a, b + e, L, W, cup, curl) - petalLocal(a, b - e, L, W, cup, curl);
  return normalize(cross(pa, pb));
}
`;

const PETAL_VS = GLSL_VCOMMON + GLSL_NOISE + GLSL_CULL + GLSL_TIMELINE + PETAL_COMMON + /* glsl */ `
// closed-form falling petal: wind drift + flutter (zigzag) + helix + 1/f turbulence + tumble/rock rotation
struct PState { vec3 p; mat3 R; };
PState petalAt(float t, vec3 r1, vec3 r2, vec3 r3, vec3 drift, float L){
  PState st;
  float vf = mix(0.45, 1.05, r1.y);                    // terminal velocity (m/s)
  float wf = mix(2.2, 4.8, r1.z);                       // flutter angular frequency
  float Af = mix(0.015, 0.07, r2.x);
  float ph = r2.y * 6.2831853;
  vec2 dA = vec2(cos(r2.z * 6.28), sin(r2.z * 6.28));
  float hr = mix(0.0, 0.12, r3.x * r3.x), hw = mix(0.8, 2.2, r3.y);
  vec3 turb = 0.45 * vec3(n1(t * 0.21 + r1.x * 50.0, 11.0 + uSeed), 0.4 * n1(t * 0.17 + r1.y * 50.0, 23.0 + uSeed), n1(t * 0.19 + r1.z * 50.0, 37.0 + uSeed));
  vec3 base = r1 * uBoxSize + uBoxMin + drift * uWindResp + vec3(0.0, -vf * t, 0.0) + turb
    + vec3(dA.x, 0.0, dA.y) * (Af * sin(wf * t + ph)) + vec3(cos(hw * t + ph), 0.0, sin(hw * t + ph)) * hr;
  st.p = uBoxMin + mod(base - uBoxMin, uBoxSize);
  // rotation: slow yaw spin + rocking coupled to the zigzag, or full tumbling for ~40 % of petals
  float tumbler = step(0.6, r3.z);
  float yaw = r3.y * 6.28 + mix(-1.2, 1.2, r1.x) * t;
  float rock = mix(0.5, 1.1, r2.x) * cos(wf * t + ph);
  float tumble = r3.x * 6.28 + mix(2.0, 7.0, r2.z) * t * (r1.z > 0.5 ? 1.0 : -1.0);
  float pitch = mix(rock, tumble, tumbler) + 0.35;
  float roll = 0.5 * sin(wf * 0.63 * t + r3.y * 6.0);
  st.R = rotAxis(vec3(0.0, 1.0, 0.0), yaw) * rotAxis(vec3(1.0, 0.0, 0.0), pitch) * rotAxis(vec3(0.0, 0.0, 1.0), roll);
  return st;
}
void main(){
  int vid = gl_VertexID; int pid = vid / ${PG * PG}; int k = vid - pid * ${PG * PG};
  int gx = k % ${PG}, gy = k / ${PG};
  float a = float(gy) / ${(PG - 1).toFixed(1)}, b = float(gx) / ${(PG - 1).toFixed(1)} - 0.5;
  uvec3 h = mvPcg3d(uvec3(uint(pid), uint(uSeed), 0xa511e9b3u));
  vec3 r1 = vec3(h) * MV_U2F;
  vec3 r2 = vec3(mvPcg3d(h ^ uvec3(0x68e31da4u, 0xb5297a4du, 0x1b56c4e9u))) * MV_U2F;
  vec3 r3 = vec3(mvPcg3d(h ^ uvec3(0x7fb5d329u, 0x2c1b3c6du, 0x297a2d39u))) * MV_U2F;
  float act = clamp((uAmount - r3.z * 0.999) * 25.0, 0.0, 1.0);
  if (act <= 0.0) CULL
  float L = mix(0.012, 0.015, r2.x), W = L * mix(0.86, 1.0, r1.y);
  float cup = mix(0.10, 0.26, r2.y), curl = mix(-0.08, 0.12, r3.y);
  gFold = mix(-0.05, 0.16, r3.y * r1.z); gWave = mix(0.01, 0.045, r2.z); gWaveP = r1.x * 6.28;
  PState s1 = petalAt(uTime, r1, r2, r3, uDrift, L);
  vec3 lp = petalLocal(a, b, L, W, cup, curl);
  vec3 wp = s1.p + s1.R * lp;
  vec3 N = s1.R * petalNormal(a, b, L, W, cup, curl);
  // lift gust (closed form): rise + swirl around a vertical axis, delayed by distance
  float liftFade = 1.0;
  if (uLift.y > 0.0) {
    vec3 d = s1.p - uLiftC.xyz;
    float dist = length(d.xz);
    float fr = smoothstep(uLift.w, 0.0, dist);
    float fall = smoothstep(r2.y * 0.85, r2.y * 0.85 + 0.12, fr);      // each petal is either caught by the gust or not
    float ul = (uTime - uLift.x - 0.35 * dist / max(uLift.w, 1e-3)) / uLift.y;
    float u = clamp(ul, 0.0, 1.0);
    float e = u * u * (3.0 - 2.0 * u) + 0.8 * max(ul - 1.0, 0.0);      // keeps rising after the gust
    liftFade = 1.0 - fall * smoothstep(1.8, 3.2, ul);                   // ... and fades out up there
    float ang = uLiftC.w * e * fall;
    mat3 Ry = rotAxis(vec3(0.0, 1.0, 0.0), ang);
    vec3 spin = rotAxis(normalize(vec3(r1.x - 0.5, 0.3, r2.z - 0.5)), uLiftSpin * e * fall * (0.5 + r3.x)) * (wp - s1.p);
    wp = uLiftC.xyz + Ry * (s1.p - uLiftC.xyz) + vec3(0.0, uLift.z * e * fall * (0.6 + 0.8 * r2.y), 0.0) + spin + normalize(vec3(d.x, 0.0, d.z) + 1e-4) * 0.3 * e * fall;
    N = rotAxis(normalize(vec3(r1.x - 0.5, 0.3, r2.z - 0.5)), uLiftSpin * e * fall * (0.5 + r3.x)) * N;
  }
  // box-face fade (wrap happens there)
  vec3 q = (s1.p - uBoxMin) / uBoxSize;
  vec3 fq = smoothstep(vec3(0.0), vec3(0.04), q) * smoothstep(vec3(1.0), vec3(0.96), q);
  float fade = fq.x * fq.y * fq.z * act * liftFade;
  if (fade <= 0.0) CULL
  // 24 fps motion blur: stretch trailing vertices back to the shutter-open pose, thin out alpha
  float alphaMB = 1.0;
  if (uMB > 0.0) {
    PState s0 = petalAt(uTime - uShutter, r1, r2, r3, uDriftPrev, L);
    vec3 dp = s1.p - s0.p;
    float dl = length(dp);
    if (dl < 0.5) {
      vec3 wp0 = s0.p + s0.R * lp;
      float w = smoothstep(-0.3, 0.3, dot(wp - s1.p, dp) / max(dl * 0.5 * L, 1e-6));
      wp = mix(wp0 + (wp - (s1.p + s1.R * lp)), wp, w);
      alphaMB = L / (L + dl * uMB);
    }
  }
  vPU = vec2(a, b); vPW = wp; vPN = N; vPS = vec2(L, W);
  vPP = vec4(r2.z * r2.z, mix(0.92, 1.04, r1.x), r3.x * 97.0 + float(pid % 911), fade * alphaMB);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

// burst petals: released at cue times from a source (branch shaken by a gust / a guqin pulse)
const PETAL_BURST_VS = GLSL_VCOMMON + GLSL_NOISE + GLSL_CULL + GLSL_TIMELINE + PETAL_COMMON + /* glsl */ `
uniform sampler2D uBurst;     // texel 2i: (x, y, z, tRelease), 2i+1: (vx, vy, vz, life)
uniform float uFloorY;
struct PState { vec3 p; mat3 R; };
PState burstAt(float a, float tRel, vec3 src, vec3 v0, vec3 r1, vec3 r2, vec3 r3){
  PState st;
  float vf = mix(0.45, 1.05, r1.y), wf = mix(2.2, 4.8, r1.z), Af = mix(0.015, 0.07, r2.x), ph = r2.y * 6.2831853;
  vec2 dA = vec2(cos(r2.z * 6.28), sin(r2.z * 6.28));
  float k = 1.0 - exp(-a / 0.6);
  vec3 kick = v0 * 0.6 * k;                                           // the shake's initial velocity relaxes
  float fy = -vf * (a - 0.6 * k);                                      // ... into the terminal fall
  vec4 d1 = timelineAt(tRel + a), d0 = timelineAt(tRel);
  vec3 drift = vec3(d1.x - d0.x, 0.0, d1.y - d0.y) * uWindResp;
  float s = r1.x * 50.0;
  vec3 turb = 0.35 * vec3(n1(a * 0.21 + s, 11.0) - n1(s, 11.0), 0.4 * (n1(a * 0.17 + s, 23.0) - n1(s, 23.0)), n1(a * 0.19 + s, 37.0) - n1(s, 37.0));
  st.p = src + kick + vec3(0.0, fy, 0.0) + drift + turb + vec3(dA.x, 0.0, dA.y) * (Af * sin(wf * a + ph) * smoothstep(0.0, 0.5, a));
  float tumbler = step(0.6, r3.z);
  float yaw = r3.y * 6.28 + mix(-1.2, 1.2, r1.x) * a;
  float rock = mix(0.5, 1.1, r2.x) * cos(wf * a + ph);
  float tumble = r3.x * 6.28 + mix(2.0, 7.0, r2.z) * a * (r1.z > 0.5 ? 1.0 : -1.0);
  st.R = rotAxis(vec3(0.0, 1.0, 0.0), yaw) * rotAxis(vec3(1.0, 0.0, 0.0), mix(rock, tumble, tumbler) + 0.35) * rotAxis(vec3(0.0, 0.0, 1.0), 0.5 * sin(wf * 0.63 * a + r3.y * 6.0));
  return st;
}
void main(){
  int vid = gl_VertexID; int pid = vid / ${PG * PG}; int k = vid - pid * ${PG * PG};
  int gx = k % ${PG}, gy = k / ${PG};
  float a0 = float(gy) / ${(PG - 1).toFixed(1)}, b = float(gx) / ${(PG - 1).toFixed(1)} - 0.5;
  vec4 A = texelFetch(uBurst, ivec2(2 * pid, 0), 0), B = texelFetch(uBurst, ivec2(2 * pid + 1, 0), 0);
  float age = uTime - A.w;
  if (age < 0.0 || age > B.w) CULL
  uvec3 h = mvPcg3d(uvec3(uint(pid), uint(uSeed), 0xb0a57u));
  vec3 r1 = vec3(h) * MV_U2F;
  vec3 r2 = vec3(mvPcg3d(h ^ uvec3(0x68e31da4u, 0xb5297a4du, 0x1b56c4e9u))) * MV_U2F;
  vec3 r3 = vec3(mvPcg3d(h ^ uvec3(0x7fb5d329u, 0x2c1b3c6du, 0x297a2d39u))) * MV_U2F;
  float L = mix(0.012, 0.015, r2.x), W = L * mix(0.86, 1.0, r1.y);
  float cup = mix(0.10, 0.26, r2.y), curl = mix(-0.08, 0.12, r3.y);
  gFold = mix(-0.05, 0.16, r3.y * r1.z); gWave = mix(0.01, 0.045, r2.z); gWaveP = r1.x * 6.28;
  PState s1 = burstAt(age, A.w, A.xyz, B.xyz, r1, r2, r3);
  if (s1.p.y < uFloorY - 0.03) CULL
  vec3 lp = petalLocal(a0, b, L, W, cup, curl);
  vec3 wp = s1.p + s1.R * lp;
  vec3 N = s1.R * petalNormal(a0, b, L, W, cup, curl);
  float fade = smoothstep(0.0, 0.08, age) * smoothstep(B.w, B.w - 1.0, age) * smoothstep(uFloorY - 0.03, uFloorY + 0.02, s1.p.y);
  float alphaMB = 1.0;
  if (uMB > 0.0 && age > uShutter) {
    PState s0 = burstAt(age - uShutter, A.w, A.xyz, B.xyz, r1, r2, r3);
    vec3 dp = s1.p - s0.p; float dl = length(dp);
    if (dl < 0.5) {
      vec3 wp0 = s0.p + s0.R * lp;
      float w = smoothstep(-0.3, 0.3, dot(wp - s1.p, dp) / max(dl * 0.5 * L, 1e-6));
      wp = mix(wp0, wp, w);
      alphaMB = L / (L + dl * uMB);
    }
  }
  vPU = vec2(a0, b); vPW = wp; vPN = N; vPS = vec2(L, W);
  vPP = vec4(r2.z * r2.z, mix(0.92, 1.04, r1.x), r3.x * 97.0 + float(pid % 911), fade * alphaMB);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

// resting petals: static on a surface, optional drop-in schedule and lift gust
const PETAL_REST_VS = GLSL_VCOMMON + GLSL_NOISE + GLSL_CULL + GLSL_TIMELINE + PETAL_COMMON + /* glsl */ `
uniform sampler2D uRest;      // per petal: texel 2i = (x, y, z, yaw), 2i+1 = (nx, ny, nz, appearT)
uniform float uAppearDur, uDropH, uFloat;
void main(){
  int vid = gl_VertexID; int pid = vid / ${PG * PG}; int k = vid - pid * ${PG * PG};
  int gx = k % ${PG}, gy = k / ${PG};
  float a = float(gy) / ${(PG - 1).toFixed(1)}, b = float(gx) / ${(PG - 1).toFixed(1)} - 0.5;
  vec4 A = texelFetch(uRest, ivec2(2 * pid, 0), 0), B = texelFetch(uRest, ivec2(2 * pid + 1, 0), 0);
  if (A.w < -900.0) CULL
  uvec3 h = mvPcg3d(uvec3(uint(pid), uint(uSeed), 0x51a3e9b3u));
  vec3 r1 = vec3(h) * MV_U2F;
  vec3 r2 = vec3(mvPcg3d(h ^ uvec3(0x68e31da4u, 0xb5297a4du, 0x1b56c4e9u))) * MV_U2F;
  float L = mix(0.012, 0.015, r2.x), W = L * mix(0.86, 1.0, r1.y);
  float flip = step(0.8, r1.z);                         // ~20 % lie upside down (cup facing down)
  float cup = mix(0.06, 0.2, r2.y) * (flip > 0.5 ? -1.0 : 1.0), curl = mix(-0.05, 0.1, r2.z);
  gFold = mix(-0.04, 0.14, r1.y * r2.x); gWave = mix(0.01, 0.04, r1.x); gWaveP = r2.y * 6.28;
  float appear = B.w;
  float u = clamp((uTime - (appear - uAppearDur)) / uAppearDur, 0.0, 1.0);
  if (uTime < appear - uAppearDur) CULL
  vec3 n = normalize(B.xyz);
  vec3 tx = normalize(cross(abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), n));
  vec3 ty = cross(n, tx);
  float yaw = A.w;
  vec3 ex = tx * cos(yaw) + ty * sin(yaw), ey = -tx * sin(yaw) + ty * cos(yaw);
  float tilt = (r1.x - 0.5) * 0.35;                      // small random tilt (resting on a neighbour / fold)
  mat3 R = mat3(ex, ey, n) * rotAxis(vec3(1.0, 0.0, 0.0), tilt);
  // drop-in: falls the last few cm with a flutter, settles
  float e = 1.0 - u;
  // drop-in from uDropH above with a falling-leaf zig-zag whose amplitude scales with the height
  float nz = 2.0 + 6.0 * sqrt(uDropH);
  vec3 off = n * (uDropH * e * (0.75 + 0.25 * e)) + ex * (0.17 * uDropH * sin(e * nz * 3.1 + r2.x * 6.0) * e) + ey * (0.08 * uDropH * cos(e * nz * 2.3 + r1.x * 6.0) * e);
  mat3 Rf = rotAxis(ex, 1.2 * e * sin(e * nz * 2.5 + r1.y * 5.0));
  if (uFloat > 0.0 && u >= 1.0) {   // floating on tea / water: slow drift-rotation + tiny bob
    float ta = uTime - appear;
    off += n * (0.0004 * sin(ta * 7.5 + r1.x * 6.0) * exp(-ta * 0.6) + 0.00015 * sin(ta * 1.9 + r2.y * 5.0));
    Rf = rotAxis(n, 0.04 * sin(ta * 0.35 + r1.z * 6.0) + 0.02 * ta * (r1.y - 0.5));
  }
  vec3 lp = petalLocal(a, b, L, W, cup, curl);
  vec3 wp = A.xyz + n * 0.0012 + off + Rf * R * lp;
  vec3 N = Rf * R * petalNormal(a, b, L, W, cup, curl);
  float liftFade = 1.0;
  if (uLift.y > 0.0) {
    vec3 d = A.xyz - uLiftC.xyz; float dist = length(d.xz);
    float fall = smoothstep(r1.z * 0.85, r1.z * 0.85 + 0.12, smoothstep(uLift.w, 0.0, dist));
    float ul = (uTime - uLift.x - 0.35 * dist / max(uLift.w, 1e-3)) / uLift.y;
    float uu = clamp(ul, 0.0, 1.0);
    float ee = uu * uu * (3.0 - 2.0 * uu) + 0.8 * max(ul - 1.0, 0.0);
    liftFade = 1.0 - fall * smoothstep(1.8, 3.2, ul);
    mat3 Ry = rotAxis(vec3(0.0, 1.0, 0.0), uLiftC.w * ee * fall);
    mat3 Rs = rotAxis(normalize(vec3(r1.x - 0.5, 0.4, r2.z - 0.5)), uLiftSpin * ee * fall * (0.5 + r2.y));
    vec3 c = A.xyz;
    wp = uLiftC.xyz + Ry * (c - uLiftC.xyz) + vec3(0.0, uLift.z * ee * fall * (0.5 + r2.y), 0.0) + Rs * (wp - c) + normalize(vec3(d.x, 0.0, d.z) + 1e-4) * 0.25 * ee * fall;
    N = Rs * N;
  }
  vPU = vec2(a, b); vPW = wp; vPN = N; vPS = vec2(L, W);
  if (liftFade <= 0.0) CULL
  vPP = vec4(r2.z * r2.z, mix(0.92, 1.04, r1.x), r2.y * 97.0 + float(pid % 911), smoothstep(0.0, 0.15, u) * liftFade);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const PETAL_FS = GLSL_COMMON + GLSL_NOISE + GLSL_LIGHTS.replace(/vec3 inscatter[\s\S]*$/, '') + FS_HEAD + /* glsl */ `
#ifndef DIR_MASK
#define DIR_MASK(p) 1.0
#endif
in vec2 vPU; in vec3 vPW; in vec3 vPN; in vec4 vPP; in vec2 vPS;
uniform float uTrans;
const vec3 WHITE = vec3(0.905, 0.839, 0.791);   // #f4ece6
const vec3 PINK  = vec3(0.871, 0.584, 0.584);   // #f0c9c9
// petal outline: obovate/orbicular blade (widest ~62 % toward the apex) tapering into a short claw, shallow
// apex notch, irregular margin (1-D noise along the edge). u = X/L in [0,1]; returns signed distance (m).
float petalHalfWidth(float u, float W, float sd){
  // egg / obovate: widest at 58 % of the length, rounded apex, cuneate base tapering into a short claw
  float x = u > 0.58 ? (u - 0.58) / 0.42 : (0.58 - u) / 0.58;
  x = clamp(x, 0.0, 1.0);
  float f = u > 0.58 ? sqrt(max(1.0 - x * x, 0.0)) : pow(max(1.0 - pow(x, 1.6), 0.0), 0.8);
  f = max(f, 0.07 * smoothstep(0.2, 0.02, u) * step(0.0, u));
  f *= 1.0 + 0.05 * mvGradient1(u * 5.0 + sd, 7u) + 0.022 * mvGradient1(u * 14.0 + sd * 1.3, 11u);
  return 0.465 * W * f;
}
float petalSDF(vec2 P, float L, float W, float sd){
  float u = P.x / L;
  float hw = petalHalfWidth(u, W, sd);
  float d = abs(P.y) - hw;
  // apex notch: the tip dips back a little at the midline
  float notch = 0.028 * L * exp(-(P.y * P.y) / (0.02 * W * W));
  d = max(d, P.x - (L * 0.985 - notch));
  d = max(d, -P.x);
  return d;
}
void main(){
  float L = vPS.x, W = vPS.y;
  vec2 P = vec2(vPU.x * L, vPU.y * W);
  float sd = vPP.z;
  float dist = petalSDF(P, L, W, sd);
  float aa = max(fwidth(dist), 1e-6);
  float cov = smoothstep(0.8 * aa, -0.8 * aa, dist);
  float alpha = cov * vPP.w;
  if (alpha < 0.003) discard;
  float u = vPU.x;
  float hw = petalHalfWidth(u, W, sd);
  float across = clamp(abs(P.y) / max(hw, 1e-5), 0.0, 1.0);           // 0 midline .. 1 margin
  // veins: ~13 fine veins fanning from the claw, following the blade's width profile
  float vcoord = P.y / max(hw, 1e-5) * 10.0 + 0.5 * mvGradient1(u * 4.0 + sd, 3u) + 0.25 * mvGradient1(u * 11.0 + sd * 2.0, 5u);
  float vl = abs(fract(vcoord) - 0.5);
  float vein = (1.0 - smoothstep(0.02, 0.11, vl)) * smoothstep(0.05, 0.25, u) * (1.0 - 0.7 * smoothstep(0.6, 1.0, u)) * (0.6 + 0.4 * mvValue(vec2(vcoord * 1.7, u * 3.0) + sd));
  float papillae = mvValue(P * vec2(2600.0, 2600.0) + sd) * 0.5 + 0.5;  // velvet micro-texture
  float thick = (1.0 - across * across) * (1.0 - 0.5 * u) ;             // thicker at the base & midline
  // colour: white blade, pink flush at the base that bleeds up the veins, per-petal pinkness / brightness
  float pinkM = smoothstep(0.5, 0.02, u) * (0.6 + 0.4 * vPP.x) + 0.25 * vPP.x * smoothstep(0.9, 0.3, u) + 0.25 * vein * smoothstep(0.7, 0.2, u);
  vec3 alb = mix(WHITE, PINK, clamp(pinkM, 0.0, 1.0)) * vPP.y;
  alb = mix(alb, vec3(0.55, 0.60, 0.30), 0.45 * smoothstep(0.08, 0.0, u));        // green-yellow claw
  alb *= 0.96 + 0.05 * papillae - 0.03 * vein;
  // lighting: two-sided wrap diffuse + thickness-dependent back-lit transmission (warm/pink) + velvet sheen
  vec3 V = normalize(cameraPosition - vPW);
  vec3 N = normalize(vPN);
  // micro-wrinkles along the veins perturb the shading normal (screen-space derivative bump)
  float bump = 0.00004 * (mvValue(vec2(P.x * 700.0, P.y / max(hw, 1e-5) * 7.0) + sd) + 0.5 * vein);
  vec3 dpx = dFdx(vPW), dpy = dFdy(vPW);
  float bx = dFdx(bump), by = dFdy(bump);
  vec3 r1v = cross(dpy, N), r2v = cross(N, dpx);
  float det = dot(dpx, r1v);
  if (abs(det) > 1e-14) N = normalize(abs(det) * N - sign(det) * (bx * r1v + by * r2v));
  if (dot(N, V) < 0.0) N = -N;
  vec3 T = alb * (0.7 + 0.3 * alb) * vec3(1.0, 0.92, 0.86);
  float tr = uTrans * (1.25 - 0.7 * thick) * (1.0 + 0.4 * vein);
  float ao = 0.88 + 0.12 * across;                                      // cupped centre is a little shaded
  vec3 col = vec3(0.0);
  float dm = DIR_MASK(vPW);
  float nv = max(dot(N, V), 0.0);
  float sheen = 0.06 * pow(1.0 - nv, 4.0) * (0.6 + 0.4 * papillae);
  for (int i = 0; i < 2; i++) {
    vec3 Ld = i == 0 ? uMoonDir : uSunDir; vec3 E = (i == 0 ? uMoonCol : uSunCol) * dm;
    float nl = dot(N, Ld);
    col += E * (alb * ao * max(0.0, (nl + 0.25) / 1.25) + T * tr * pow(max(-nl, 0.0), 0.7) + sheen * max(nl + 0.4, 0.0)) / PI;
  }
  for (int i = 0; i < ${MAX_PT}; i++) {
    if (i >= uPtN) break;
    vec3 d = uPtPos[i].xyz - vPW; float r2 = dot(d, d); vec3 Ld = d * inversesqrt(r2);
    vec3 E = uPtCol[i] / (r2 + uPtPos[i].w * uPtPos[i].w);
    float nl = dot(N, Ld);
    col += E * (alb * ao * max(0.0, (nl + 0.25) / 1.25) + T * tr * pow(max(-nl, 0.0), 0.7) + sheen * max(nl + 0.4, 0.0)) / PI;
  }
  col += alb * ao * (uSkyCol * (0.55 + 0.45 * N.y) + uGndCol * (0.45 - 0.45 * N.y)) * 0.9 + T * tr * 0.3 * (uSkyCol + uGndCol);
  fragColor = vec4(col * uGain * alpha, alpha);
}`;

// soft contact shadow under resting petals (premultiplied black ellipse on the support surface)
const PETAL_SHADOW_VS = GLSL_VCOMMON + GLSL_CULL + /* glsl */ `
uniform sampler2D uRest; uniform float uAppearDur; uniform vec4 uLift; uniform float uShadowSize;
out vec2 vQ; out float vA;
void main(){
  int vid = gl_VertexID; int pid = vid >> 2; int corner = vid & 3;
  vec4 A = texelFetch(uRest, ivec2(2 * pid, 0), 0), B = texelFetch(uRest, ivec2(2 * pid + 1, 0), 0);
  if (uTime < B.w) CULL
  float u = clamp((uTime - B.w) / 0.3, 0.0, 1.0);
  if (uLift.y > 0.0) u *= 1.0 - clamp((uTime - uLift.x) / (0.3 * uLift.y), 0.0, 1.0);
  if (u <= 0.0) CULL
  vec3 n = normalize(B.xyz);
  vec3 tx = normalize(cross(abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), n)), ty = cross(n, tx);
  vec3 ex = tx * cos(A.w) + ty * sin(A.w), ey = -tx * sin(A.w) + ty * cos(A.w);
  vec2 c = vec2(corner == 1 || corner == 2 ? 1.0 : -1.0, corner >= 2 ? 1.0 : -1.0);
  vec3 wp = A.xyz + n * 0.0004 + ex * (c.x * 0.6 + 0.08) * uShadowSize + ey * c.y * 0.55 * uShadowSize;
  vQ = c; vA = u;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const PETAL_SHADOW_FS = GLSL_COMMON + FS_HEAD + /* glsl */ `
in vec2 vQ; in float vA; uniform float uShadowK;
void main(){ float r = dot(vQ, vQ); float a = uShadowK * vA * exp(-3.2 * r) * (1.0 - smoothstep(0.8, 1.0, r)); fragColor = vec4(0.0, 0.0, 0.0, a); }`;

function petalUniforms(THREE, ctx, opts, extra = {}) {
  return commonUniforms(THREE, ctx, opts, Object.assign({
    uSeed: { value: seedNum(opts.seed ?? 'petal', 'p') % 65521 }, uAmount: { value: 1 }, uWindResp: { value: opts.windResponse ?? 0.35 },
    uMB: { value: opts.motionBlur ?? 1 }, uTrans: { value: opts.translucency ?? 0.55 },
    uBoxMin: { value: new THREE.Vector3() }, uBoxSize: { value: new THREE.Vector3(1, 1, 1) },
    uDrift: { value: new THREE.Vector3() }, uDriftPrev: { value: new THREE.Vector3() },
    uLift: { value: new THREE.Vector4(0, 0, 0, 1) }, uLiftC: { value: new THREE.Vector4() }, uLiftSpin: { value: 8 },
  }, extra));
}
function setLift(U, lift) {
  if (!lift) { U.uLift.value.set(0, 0, 0, 1); return; }
  const c = lift.center || [0, 0, 0];
  U.uLift.value.set(lift.t0 ?? 0, lift.duration ?? 3, lift.height ?? 1.5, lift.radius ?? 1.5);
  U.uLiftC.value.set(c[0], c[1], c[2], lift.swirl ?? 2.5);
  U.uLiftSpin.value = lift.spin ?? 8;
}
function petalMaterial(THREE, name, vs, U, opts) {
  let dirMaskDef = opts.dirMask ? `float dirMaskFn(vec3 p){ ${opts.dirMask} }\n#define DIR_MASK(p) dirMaskFn(p)\n` : '';
  if (opts.shaft) {   
    Object.assign(U, opts.shaft.maskUniforms);
    dirMaskDef = `#define DIR_MASK(p) ${opts.shaft.maskName}(p)\n`;
    return new THREE.ShaderMaterial(Object.assign({
      name, glslVersion: THREE.GLSL3, uniforms: U, vertexShader: vs,
      fragmentShader: dirMaskDef + PETAL_FS.replace('#ifndef DIR_MASK', opts.shaft.maskGLSL + '\n#ifndef DIR_MASK'),
      depthWrite: opts.depthWrite ?? true, depthTest: true, side: THREE.DoubleSide, toneMapped: false,
    }, blendProps(THREE, 'premul')));
  }
  return new THREE.ShaderMaterial(Object.assign({
    name, glslVersion: THREE.GLSL3, uniforms: U, vertexShader: vs, fragmentShader: dirMaskDef + PETAL_FS,
    depthWrite: opts.depthWrite ?? true, depthTest: true, side: THREE.DoubleSide, toneMapped: false,
  }, blendProps(THREE, 'premul')));
}

/**
 * createPetals(ctx, opts) — falling plum petals (12–15 mm), closed-form flutter/tumble/spiral in the wind.
 * opts: seed, density (petals / m³ at petalFall = 1; default 3), scale (× world.petalFall), windResponse=0.9,
 *   windResponse=0.35 (fraction of world wind speed; sheltered courtyard breeze),
 *   box: { center:[x,y,z], size:[w,h,d] } (world-fixed wrap volume) | { follow:true, size, ahead } (camera-following),
 *   lift: { t0, duration, center, radius, height, swirl, spin } (petals rise and swirl on a gust/cue),
 *   lights / moon / sun / sky (see evalLights), translucency=0.55, motionBlur=1, depthWrite=true (engine DOF),
 *   dirMask: GLSL body 'float f(vec3 p)' restricting moon/sun; shaft: a createLightShaft (moon/sun only in the beam),
 *   bursts: [{ t, count=30, center:[x,y,z], radius=0.4, speed=0.35, dir:[vx,vy,vz], spread=0.35 s, life=9 s }]
 *     extra petals released at cue times (e.g. project note cues) from a source (the branch); floorY (m) where
 *     they vanish on landing.
 * Returns { object, update, dispose, restingPetals(surface, opts) }.
 */
export function createPetals(ctx, opts = {}) {
  const THREE = ctx.THREE;
  const q = qScale(ctx);
  const box = opts.box || { follow: true, size: [8, 5, 10] };
  const size = box.size || [8, 5, 10];
  const vol = size[0] * size[1] * size[2];
  const maxN = Math.min(opts.maxCount ?? 6000, Math.max(1, Math.round((opts.density ?? 3) * vol * q)));
  const U = petalUniforms(THREE, ctx, opts);
  U.uBoxSize.value.fromArray(size);
  const geo = gridBatch(THREE, maxN, PG, PG);
  const mat = petalMaterial(THREE, 'mvPetals', PETAL_VS, U, opts);
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.name = 'mvPetals'; mesh.renderOrder = 5;
  const worldSrc = worldFnOf(ctx, opts);
  const tl = getTimeline(THREE, worldSrc);
  const own = lensUniforms(THREE, ctx);
  const fwd = new THREE.Vector3(), cp = new THREE.Vector3();
  setLift(U, opts.lift);
  // optional bursts at cue times (a separate mesh; each burst petal has a release time and a source point)
  let object = mesh, burst = null;
  if (opts.bursts && opts.bursts.length) {
    const Rb = makeRng((opts.seed ?? 'petal') + ':burst');
    const list = [];
    for (const bu of opts.bursts) {
      const cnt = Math.max(1, Math.round((bu.count ?? 30) * (ctx.quality === 'final' ? 1 : 0.6)));
      const c = bu.center || [0, 2, 0], rad = bu.radius ?? 0.4, sp = bu.speed ?? 0.35;
      for (let i = 0; i < cnt; i++) {
        const u = Rb(), v = Rb(), w = Math.cbrt(Rb());
        const th = u * Math.PI * 2, ph = Math.acos(2 * v - 1);
        const dx = Math.sin(ph) * Math.cos(th), dy = Math.cos(ph), dz = Math.sin(ph) * Math.sin(th);
        const dir = bu.dir || [0, 0, 0];
        list.push([c[0] + dx * rad * w, c[1] + dy * rad * w * 0.6, c[2] + dz * rad * w, bu.t + Rb() * (bu.spread ?? 0.35),
          dx * sp * Rb() + dir[0], Math.abs(dy) * sp * 0.3 * Rb() + dir[1], dz * sp * Rb() + dir[2], bu.life ?? 9]);
      }
    }
    const nb = Math.min(list.length, 4000);
    const bdata = new Float32Array(nb * 8);
    for (let i = 0; i < nb; i++) bdata.set(list[i], i * 8);
    const btex = new THREE.DataTexture(bdata, nb * 2, 1, THREE.RGBAFormat, THREE.FloatType);
    btex.minFilter = btex.magFilter = THREE.NearestFilter; btex.needsUpdate = true;
    const BU = petalUniforms(THREE, ctx, opts, { uBurst: { value: btex }, uFloorY: { value: opts.floorY ?? -1e4 } });
    const bgeo = gridBatch(THREE, nb, PG, PG);
    const bmat = petalMaterial(THREE, 'mvPetalBursts', PETAL_BURST_VS, BU, opts);
    const bmesh = new THREE.Mesh(bgeo, bmat); bmesh.frustumCulled = false; bmesh.name = 'mvPetalBursts'; bmesh.renderOrder = 5;
    object = new THREE.Group(); object.name = 'mvPetalsGroup'; object.add(mesh, bmesh);
    burst = { U: BU, geo: bgeo, mat: bmat, tex: btex, n: nb, times: list.slice(0, nb).map((r) => [r[3], r[3] + r[7]]) };
  }
  tagFX(ctx, object, 'petals', false);
  const api = {
    object, count: maxN, burstCount: burst ? burst.n : 0,
    update(t, w, camera) {
      updateCommon(THREE, ctx, U, own, t, w, camera, opts);
      const amount = Math.min(1, Math.max(0, (w.petalFall ?? 0) * (opts.scale ?? 1)));
      U.uAmount.value = amount;
      if (box.follow && camera) {
        camera.getWorldPosition(cp); camera.getWorldDirection(fwd);
        const ahead = box.ahead ?? size[2] * 0.45;
        U.uBoxMin.value.set(cp.x + fwd.x * ahead - size[0] / 2, cp.y + fwd.y * ahead - size[1] / 2, cp.z + fwd.z * ahead - size[2] / 2);
      } else {
        const c = box.center || [0, 0, 0];
        U.uBoxMin.value.set(c[0] - size[0] / 2, c[1] - size[1] / 2, c[2] - size[2] / 2);
      }
      const ws = opts.windScale ?? 1;
      const d1 = tl.at(t), d0 = tl.at(t - SHUTTER);
      U.uDrift.value.set(d1[0] * ws, 0, d1[1] * ws); U.uDriftPrev.value.set(d0[0] * ws, 0, d0[1] * ws);
      // every petal slot is processed; inactive ones (hash > petalFall) are culled in the vertex shader
      mesh.visible = amount > 0;
      geo.setDrawRange(0, maxN * geo.userData.indicesPerItem);
      api.activeCount = Math.round(maxN * amount);
      if (burst) {
        updateCommon(THREE, ctx, burst.U, own, t, w, camera, opts);
        const live = burst.times.some(([a, b]) => t >= a && t <= b);
        object.children[1].visible = live;
        if (live) api.activeCount += burst.n;
      }
    },
    activeCount: 0,
    setLift(l) { setLift(U, l); },
    restingPetals(surface, o = {}) { return restingPetals(ctx, surface, Object.assign({}, opts, o)); },
    dispose() { geo.dispose(); mat.dispose(); if (burst) { burst.geo.dispose(); burst.mat.dispose(); burst.tex.dispose(); } },
  };
  return api;
}

/**
 * restingPetals(ctx, surface, opts) — static petals lying on a surface (pillow / floor / table / tea).
 * surface: { center:[x,y,z], size:[w,d], normal:[0,1,0] } plane patch, or { points:[{pos:[..], normal:[..]}] }
 *   (e.g. raycast onto the pillow mesh), or { heightAt:(x,z)=>y, normalAt?:(x,z)=>[nx,ny,nz], center, size }.
 * opts: count (default 30), seed, appear:[t0,t1] (petal i lands at t0+(t1-t0)·i/N with a 0.45 s drop-in),
 *   dropHeight=0.07 m + appearDuration=0.45 s (e.g. one petal, points:[tea surface], appear:[t,t], dropHeight 0.45,
 *   appearDuration 2.4, float:true → falls into the cup and floats), float (bob/rotate on liquid),
 *   lift (gust, see createPetals), lights etc. Returns { object, update, dispose, positions }.
 */
export function restingPetals(ctx, surface = {}, opts = {}) {
  const THREE = ctx.THREE;
  const R = makeRng(opts.seed ?? 'rest');
  const pts = [];
  const n = surface.points ? surface.points.length : (opts.count ?? 30);
  const nrm0 = surface.normal || [0, 1, 0];
  for (let i = 0; i < n; i++) {
    if (surface.points) { const P = surface.points[i]; pts.push({ p: P.pos, n: P.normal || nrm0 }); continue; }
    const c = surface.center || [0, 0, 0], s = surface.size || [0.5, 0.4];
    // clustered scatter: most petals in a few clumps + some loners
    let x, z;
    if (R() < 0.7) { const cl = Math.floor(R() * 3); const cx = (mulberry32(cl * 77 + (opts.clusterSeed ?? 3))() - 0.5) * s[0] * 0.6, cz = (mulberry32(cl * 91 + 5)() - 0.5) * s[1] * 0.6; x = cx + R.normal(0, s[0] * 0.12); z = cz + R.normal(0, s[1] * 0.12); }
    else { x = (R() - 0.5) * s[0]; z = (R() - 0.5) * s[1]; }
    x = Math.max(-s[0] / 2, Math.min(s[0] / 2, x)); z = Math.max(-s[1] / 2, Math.min(s[1] / 2, z));
    // plane frame from the normal
    const N = new THREE.Vector3().fromArray(nrm0).normalize();
    const T = new THREE.Vector3().crossVectors(Math.abs(N.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0), N).normalize();
    const B = new THREE.Vector3().crossVectors(N, T);
    const p = new THREE.Vector3().fromArray(c).addScaledVector(T, x).addScaledVector(B, z);
    let nn = N.toArray();
    if (surface.heightAt) { p.y = surface.heightAt(p.x, p.z); if (surface.normalAt) nn = surface.normalAt(p.x, p.z); }
    pts.push({ p: p.toArray(), n: nn });
  }
  const data = new Float32Array(Math.max(1, n) * 8);
  const [a0, a1] = opts.appear || [-1e4, -1e4];
  for (let i = 0; i < n; i++) {
    const at = a0 + (a1 - a0) * ((i + 0.5) / n) + (R() - 0.5) * (a1 - a0) / n * 0.8;
    data.set([pts[i].p[0], pts[i].p[1], pts[i].p[2], R() * Math.PI * 2, pts[i].n[0], pts[i].n[1], pts[i].n[2], at], i * 8);
  }
  const tex = new THREE.DataTexture(data, Math.max(1, n) * 2, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.needsUpdate = true;
  const U = petalUniforms(THREE, ctx, opts, { uRest: { value: tex }, uAppearDur: { value: opts.appearDuration ?? 0.45 }, uDropH: { value: opts.dropHeight ?? 0.07 }, uFloat: { value: opts.float ? 1 : 0 } });
  const geo = gridBatch(THREE, n, PG, PG);
  const mat = petalMaterial(THREE, 'mvRestingPetals', PETAL_REST_VS, U, opts);
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.name = 'mvRestingPetals'; mesh.renderOrder = 5;
  const group = new THREE.Group(); group.name = 'mvRestingPetalsGroup';
  let sgeo = null, smat = null;
  if (opts.contactShadow !== false) {
    sgeo = quadBatch(THREE, n);
    smat = new THREE.ShaderMaterial(Object.assign({ name: 'mvPetalShadows', glslVersion: THREE.GLSL3, uniforms: { uTime: U.uTime, uLens: U.uLens, uRes: U.uRes, uCocMax: U.uCocMax, uGain: U.uGain, uShutter: U.uShutter,
      uSceneDepth: U.uSceneDepth, uDepthOn: U.uDepthOn, uSoftDepth: U.uSoftDepth,
      uRest: { value: tex }, uAppearDur: U.uAppearDur, uLift: U.uLift, uShadowSize: { value: 0.0135 }, uShadowK: { value: opts.shadowStrength ?? 0.45 } },
      vertexShader: PETAL_SHADOW_VS, fragmentShader: PETAL_SHADOW_FS, depthWrite: false, depthTest: true }, blendProps(THREE, 'premul')));
    const sm = new THREE.Mesh(sgeo, smat); sm.frustumCulled = false; sm.renderOrder = 4; sm.name = 'mvPetalShadows';
    group.add(sm);
  }
  group.add(mesh);
  const own = lensUniforms(THREE, ctx);
  setLift(U, opts.lift);
  tagFX(ctx, group, 'restingPetals', false);
  return {
    object: group, positions: pts,
    update(t, w, camera) { updateCommon(THREE, ctx, U, own, t, w, camera, opts); this.activeCount = n; },
    activeCount: 0,
    setLift(l) { setLift(U, l); },
    dispose() { geo.dispose(); mat.dispose(); tex.dispose(); if (sgeo) { sgeo.dispose(); smat.dispose(); } },
  };
}

// ===============================================================================================================
// 5. LIGHT SHAFTS (window moonbeams, moon-gap shafts) + shared shaftMask()
// ===============================================================================================================
let _shaftId = 0;
/** GLSL for a shaft mask with uniform suffix `sfx`: defines float shaftMask<sfx>(vec3 p) (0..1 light in the beam). */
function shaftMaskGLSL(sfx) {
  return /* glsl */ `
uniform vec3 uSO${sfx}; uniform mat3 uSInv${sfx}; uniform vec4 uSP${sfx}; uniform vec4 uSQ${sfx};
// beam-local coords: xy in [-1,1] across the aperture, z in [0,1] along the beam
vec3 shaftLocal${sfx}(vec3 p){ return uSInv${sfx} * (p - uSO${sfx}); }
float shaftMaskL${sfx}(vec3 l){
  if (l.z < 0.0 || l.z > 1.0) return 0.0;
  float soft = uSQ${sfx}.x + uSQ${sfx}.y * l.z;
  float m = uSP${sfx}.x < 0.5 ? smoothstep(1.0, 1.0 - soft, abs(l.x)) * smoothstep(1.0, 1.0 - soft, abs(l.y))
                              : smoothstep(1.0, 1.0 - soft, length(l.xy));
  if (uSP${sfx}.y > 0.5) {  // lattice bars (window 窗棂): shadows soften with distance from the window
    vec2 g = (l.xy * 0.5 + 0.5) * uSP${sfx}.yz;
    vec2 dl = min(fract(g), 1.0 - fract(g));
    vec2 hb = 0.5 * uSP${sfx}.w * uSP${sfx}.yz;                // half bar width in cells
    vec2 sb = hb * 0.3 + uSQ${sfx}.z * l.z * uSP${sfx}.yz;       // penumbra (cells)
    m *= smoothstep(hb.x - sb.x, hb.x + sb.x, dl.x) * smoothstep(hb.y - sb.y, hb.y + sb.y, dl.y);
  }
  return m * smoothstep(0.0, 0.02, l.z) * (1.0 - uSQ${sfx}.w * smoothstep(0.7, 1.0, l.z));
}
float shaftMask${sfx}(vec3 p){ return shaftMaskL${sfx}(shaftLocal${sfx}(p)); }
`;
}

const SHAFT_VS = /* glsl */ `
uniform vec3 uSOv; uniform vec3 uSUv; uniform vec3 uSVv; uniform vec3 uSDv;
out vec3 vW;
void main(){
  vec3 c = position;   // unit cube corners in [-1,1]² × [0,1]
  vec3 w = uSOv + c.x * uSUv + c.y * uSVv + c.z * uSDv;
  vW = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
const SHAFT_FS = (sfx) => GLSL_COMMON + GLSL_NOISE + shaftMaskGLSL(sfx) + FS_HEAD + /* glsl */ `
in vec3 vW;
uniform vec3 uCol;          // light colour × irradiance
uniform float uDens, uG, uSteps, uNoise, uInside;
uniform sampler2D uNoiseTex;
uniform vec3 uSDn;          // unit beam direction
void main(){
  vec3 ro = cameraPosition, rd = normalize(vW - cameraPosition);
  // ray / beam slab intersection in beam-local coordinates (affine: parameter t is shared)
  vec3 lo = shaftLocal${sfx}(ro), ld = uSInv${sfx} * rd;
  vec3 inv = 1.0 / (abs(ld) + 1e-9) * sign(ld + 1e-12);
  vec3 t0 = (vec3(-1.0, -1.0, 0.0) - lo) * inv, t1 = (vec3(1.0, 1.0, 1.0) - lo) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float ta = max(max(tmin.x, tmin.y), max(tmin.z, 0.0)), tb = min(min(tmax.x, tmax.y), tmax.z);
  if (uDepthOn > 0.5) {   // FX pass: stop the beam at the scene surface
    float sd = texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy), 0).r;
    vec3 fwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
    if (sd < 1.0) tb = min(tb, fxLinZ(sd) / max(dot(rd, fwd), 1e-3));
  }
  if (tb <= ta) discard;
  int N = int(uSteps);
  float dt = (tb - ta) / float(N);
  float jit = mvIGN(gl_FragCoord.xy);
  float acc = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= N) break;
    float t = ta + (float(i) + jit) * dt;
    vec3 l = lo + ld * t;
    acc += shaftMaskL${sfx}(l);
  }
  acc *= dt;
  // slowly drifting haze density (2 taps of a tiling noise, evaluated at the segment midpoint)
  vec3 lm = lo + ld * (0.5 * (ta + tb));
  vec2 nuv = lm.xy * vec2(0.9, 0.7) + vec2(lm.z * 1.3, uTime * 0.013);
  float n = texture(uNoiseTex, nuv).r * 0.65 + texture(uNoiseTex, nuv * 3.1 + vec2(0.37, uTime * 0.021)).r * 0.35;
  float haze = mix(1.0, 0.35 + 1.3 * n, uNoise);
  float ph = hgPhase(dot(uSDn, -rd), uG) * 0.85 + 0.15 / (4.0 * PI);
  vec3 c = uCol * uDens * acc * haze * ph * uGain;
  fragColor = vec4(c, 0.0);
}`;

let _noiseTex = null;
/** Small tiling noise texture (R = 4-octave periodic value noise, G = decorrelated copy), generated once (CPU, deterministic). */
export function getNoiseTexture(THREE, size = 128) {
  if (_noiseTex) return _noiseTex;
  const N = size, data = new Uint8Array(N * N * 4);
  const lat = (period, seed) => { const g = new Float32Array(period * period); const r = mulberry32(seed); for (let i = 0; i < g.length; i++) g[i] = r(); return g; };
  const octs = [[4, 11], [8, 23], [16, 37], [32, 51]];
  const grids = octs.map(([p, sd]) => ({ p, g: lat(p, sd), g2: lat(p, sd + 1000) }));
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = 0, v2 = 0, amp = 1, norm = 0;
    for (const { p, g, g2 } of grids) {
      const fx = x / N * p, fy = y / N * p, ix = Math.floor(fx), iy = Math.floor(fy), ux = fade(fx - ix), uy = fade(fy - iy);
      const i00 = (iy % p) * p + (ix % p), i10 = (iy % p) * p + ((ix + 1) % p), i01 = ((iy + 1) % p) * p + (ix % p), i11 = ((iy + 1) % p) * p + ((ix + 1) % p);
      const s = (G) => (G[i00] * (1 - ux) + G[i10] * ux) * (1 - uy) + (G[i01] * (1 - ux) + G[i11] * ux) * uy;
      v += amp * s(g); v2 += amp * s(g2); norm += amp; amp *= 0.5;
    }
    const o = (y * N + x) * 4;
    data[o] = Math.round(255 * v / norm); data[o + 1] = Math.round(255 * v2 / norm); data[o + 2] = 0; data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.needsUpdate = true;
  _noiseTex = tex;
  return tex;
}

/**
 * createLightShaft(ctx, opts) — cheap analytic volumetric beam (additive), view-dependent (HG phase).
 * opts: kind 'box' (window: width, height) | 'cylinder' (radius); origin:[x,y,z] (aperture centre),
 *   dir:[x,y,z] (propagation) or follow:'moon'|'sun' (dir = -world.moonDir / -sunDir each frame),
 *   up:[x,y,z] aperture 'height' axis (box; default world up projected), across:[x,y,z] optional width axis
 *   (e.g. the window plane's horizontal axis — then the box is a sheared prism of the real window),
 *   length (m), color [r,g,b] & intensity (default moon colour × 0.22 × world.moonlight or sun), density=0.6 (1/m, haze),
 *   g=0.55 (phase anisotropy), lattice:[cols, rows] + bar (m) for 窗棂 shadows, penumbra=0.009 (rad, moon/sun size),
 *   steps (default 10 final / 6 preview), noise=1, fadeEnd=1.
 * Returns { object, update, dispose, maskGLSL, maskUniforms, maskName, mask(p) (JS), local(p) } — pass the shaft
 * to createDust({shaft}) / createPetals({shaft}) so motes/petals are lit only inside the beam.
 */
export function createLightShaft(ctx, opts = {}) {
  const THREE = ctx.THREE;
  const sfx = 'S' + (++_shaftId);
  const geo = new THREE.BoxGeometry(2, 2, 1);
  geo.translate(0, 0, 0.5);
  const maskU = {
    [`uSO${sfx}`]: { value: new THREE.Vector3() }, [`uSInv${sfx}`]: { value: new THREE.Matrix3() },
    [`uSP${sfx}`]: { value: new THREE.Vector4() }, [`uSQ${sfx}`]: { value: new THREE.Vector4() },
  };
  const U = commonUniforms(THREE, ctx, opts, Object.assign({
    uSOv: { value: new THREE.Vector3() }, uSUv: { value: new THREE.Vector3() }, uSVv: { value: new THREE.Vector3() }, uSDv: { value: new THREE.Vector3() },
    uCol: { value: new THREE.Vector3() }, uDens: { value: opts.density ?? 0.6 }, uG: { value: opts.g ?? 0.55 },
    uSteps: { value: opts.steps ?? (ctx.quality === 'final' ? 10 : 6) }, uNoise: { value: opts.noise ?? 1 }, uInside: { value: 0 },
    uNoiseTex: { value: getNoiseTexture(THREE) }, uSDn: { value: new THREE.Vector3() },
  }, maskU));
  const mat = new THREE.ShaderMaterial(Object.assign({
    name: 'mvLightShaft', glslVersion: THREE.GLSL3, uniforms: U, vertexShader: SHAFT_VS, fragmentShader: SHAFT_FS(sfx),
    depthWrite: false, depthTest: true, side: THREE.FrontSide,
  }, blendProps(THREE, 'add')));
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.name = 'mvLightShaft'; mesh.renderOrder = 20;
  const own = lensUniforms(THREE, ctx);
  const O = new THREE.Vector3(), Uv = new THREE.Vector3(), Vv = new THREE.Vector3(), Dv = new THREE.Vector3(), M = new THREE.Matrix3(), tmp = new THREE.Vector3(), cam = new THREE.Vector3();
  const setGeom = (w) => {
    O.fromArray(opts.origin || [0, 2, 0]);
    let d;
    if (opts.follow === 'moon' && w && w.moonDir) d = new THREE.Vector3().fromArray(w.moonDir).negate();
    else if (opts.follow === 'sun' && w && w.sunDir) d = new THREE.Vector3().fromArray(w.sunDir).negate();
    else d = new THREE.Vector3().fromArray(opts.dir || [0, -1, 0]);
    d.normalize();
    const L = opts.length ?? 4;
    Dv.copy(d).multiplyScalar(L);
    if (opts.kind === 'cylinder') {
      const r = opts.radius ?? 0.5;
      const a = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      Uv.crossVectors(d, a).normalize().multiplyScalar(r); Vv.crossVectors(d, Uv).normalize().multiplyScalar(r);
    } else {
      const across = opts.across ? new THREE.Vector3().fromArray(opts.across).normalize() : null;
      const up = new THREE.Vector3().fromArray(opts.up || [0, 1, 0]).normalize();
      if (across) { Uv.copy(across); Vv.copy(up); }
      else { Uv.crossVectors(up, d).normalize(); Vv.crossVectors(d, Uv).normalize(); }
      Uv.multiplyScalar((opts.width ?? 1) / 2); Vv.multiplyScalar((opts.height ?? 1) / 2);
    }
    M.set(Uv.x, Vv.x, Dv.x, Uv.y, Vv.y, Dv.y, Uv.z, Vv.z, Dv.z).invert();
    maskU[`uSO${sfx}`].value.copy(O); maskU[`uSInv${sfx}`].value.copy(M);
    const lat = opts.lattice || [0, 0];
    const cellW = (opts.width ?? 1) / Math.max(1, lat[0] || 1);
    maskU[`uSP${sfx}`].value.set(opts.kind === 'cylinder' ? 1 : 0, lat[0] || 0, lat[1] || 0, (opts.bar ?? 0.025) / cellW);
    const pen = (opts.penumbra ?? 0.009) * L / Math.max(opts.width ?? 1, 0.1);
    maskU[`uSQ${sfx}`].value.set(opts.edge ?? 0.04, pen * 2, pen * 0.5, opts.fadeEnd ?? 1);
    U.uSOv.value.copy(O); U.uSUv.value.copy(Uv); U.uSVv.value.copy(Vv); U.uSDv.value.copy(Dv); U.uSDn.value.copy(d);
  };
  setGeom(null);
  tagFX(ctx, mesh, 'lightShaft');
  const api = {
    object: mesh, maskName: `shaftMask${sfx}`, maskGLSL: shaftMaskGLSL(sfx), maskUniforms: maskU, uniforms: U,
    /** JS mirror of the mask's geometry: beam-local coords of a world point */
    local(p) { tmp.fromArray(p.isVector3 ? p.toArray() : p).sub(O).applyMatrix3(M); return tmp.toArray(); },
    lightColor: new THREE.Vector3(),
    update(t, w, camera) {
      updateCommon(THREE, ctx, U, own, t, w, camera, opts);
      setGeom(w);
      let col;
      if (opts.color) { const k = opts.intensity ?? 1; col = [opts.color[0] * k, opts.color[1] * k, opts.color[2] * k]; }
      else if (opts.follow === 'sun') col = U.uSunCol.value.toArray().map((v) => v * (opts.intensity ?? 1));
      else col = U.uMoonCol.value.toArray().map((v) => v * (opts.intensity ?? 1));
      if (typeof opts.intensityAt === 'function') { const k = opts.intensityAt(t, w); col = col.map((v) => v * k); }
      U.uCol.value.fromArray(col); api.lightColor.fromArray(col);
      // camera inside the beam: draw back faces without depth test so the beam still surrounds the camera
      camera.getWorldPosition(cam);
      const l = api.local(cam);
      const inside = l[2] > -0.02 && l[2] < 1.02 && Math.abs(l[0]) < 1.02 && Math.abs(l[1]) < 1.02;
      mat.side = inside ? THREE.BackSide : THREE.FrontSide; mat.depthTest = !inside;
      mesh.visible = col[0] + col[1] + col[2] > 1e-6;
      this.activeCount = 1;
    },
    activeCount: 0,
    dispose() { geo.dispose(); mat.dispose(); },
  };
  return api;
}

// ===============================================================================================================
// 6. BOKEH SPRITES: dust motes & fireflies (self-defocusing discs with conserved energy)
// ===============================================================================================================
const SPRITE_FS = GLSL_COMMON + FS_HEAD + /* glsl */ `
in vec2 vO; in vec4 vS; in vec3 vQ;   // vO px offset, vS: x core sigma px, y disc radius px, z mix(0 dot..1 disc), w halo
void main(){
  float r = length(vO);
  float sg = vS.x, R = vS.y;
  float dot_ = exp(-0.5 * r * r / (sg * sg)) / (2.0 * PI * sg * sg);
  float e = smoothstep(R, R - max(1.0, 0.08 * R), r);
  float disc = e * (0.9 + 0.2 * smoothstep(0.55 * R, R, r)) / (PI * R * R * 0.97);     // slight rim (real bokeh)
  float v = mix(dot_, disc, vS.z);
  if (vS.w > 0.0) v = v * (1.0 - vS.w) + vS.w * exp(-r * r / (2.0 * 9.0 * sg * sg + 0.5 * R * R)) / (PI * (2.0 * 9.0 * sg * sg + 0.5 * R * R));
  fragColor = vec4(vQ * v * fxDepthFade(), 0.0);
}`;
const GLSL_SPRITE_EMIT = /* glsl */ `
out vec2 vO; out vec4 vS; out vec3 vQ;
// emit one corner of a self-defocusing point sprite with total flux Q (px units) at world p
bool emitSprite(vec3 p, vec3 Q, int corner, float halo){
  vec4 vp = viewMatrix * vec4(p, 1.0);
  float z = -vp.z;
  if (z < 0.05) return false;
  float R = min(abs(cocPx(z)), uCocMax);
  float sg = 0.65;
  float m = smoothstep(0.9, 2.2, R);
  float Rd = max(R, 1.0);
  float peak = max(max(Q.r, Q.g), Q.b) / mix(2.0 * PI * sg * sg, PI * Rd * Rd, m);
  if (peak < uCull) return false;
  float ext = max(mix(3.0 * sg, Rd + 1.0, m), halo > 0.0 ? 3.0 * 3.0 * sg + Rd : 0.0);
  vec2 off = vec2(corner == 1 || corner == 2 ? 1.0 : -1.0, corner >= 2 ? 1.0 : -1.0) * ext;
  vec4 c = projectionMatrix * vp;
  vO = off; vS = vec4(sg, Rd, m, halo); vQ = Q;
  gl_Position = c + vec4(off / uRes * 2.0 * c.w, 0.0, 0.0);
  return true;
}
`;

const DUST_VS = (maskGLSL, maskName) => GLSL_VCOMMON + GLSL_NOISE + GLSL_CULL + maskGLSL + /* glsl */ `
uniform float uSeed, uCull, uAmount;
uniform vec3 uBoxMin, uBoxSize;
uniform vec3 uLCol;       // beam light colour × irradiance
uniform vec3 uLDir;       // beam propagation direction
uniform vec4 uFlash[16];  // x time, y mote index, z strength
uniform int uFlashN;
uniform float uNMotes;
` + GLSL_SPRITE_EMIT + /* glsl */ `
float n1(float x, float s){ return mvGradient1(x, uint(s)); }
void main(){
  int vid = gl_VertexID; int id = vid >> 2; int corner = vid & 3;
  uvec3 h = mvPcg3d(uvec3(uint(id), uint(uSeed), 0xd05u));
  vec3 r = vec3(h) * MV_U2F;
  vec3 r2 = vec3(mvPcg3d(h ^ uvec3(0x3c6ef372u, 0xa54ff53au, 0x510e527fu))) * MV_U2F;
  if (r2.z > uAmount) CULL
  // slow convection drift + lazy wander (1/f) + Brownian jitter
  vec3 drift = vec3(0.006, 0.012, -0.004) * (r2 - 0.3) * 2.0 * uTime;
  vec3 wander = 0.05 * vec3(n1(uTime * 0.11 + r.x * 40.0, 3.0 + uSeed), n1(uTime * 0.09 + r.y * 40.0, 5.0 + uSeed), n1(uTime * 0.1 + r.z * 40.0, 7.0 + uSeed));
  vec3 jit = 0.0025 * vec3(n1(uTime * 1.9 + r.y * 90.0, 11.0), n1(uTime * 2.3 + r.z * 90.0, 13.0), n1(uTime * 2.1 + r.x * 90.0, 17.0));
  vec3 p = uBoxMin + mod(r * uBoxSize + drift + wander + jit - uBoxMin, uBoxSize);
  float m = ${maskName}(p);
  if (m <= 0.002) CULL
  vec3 V = normalize(cameraPosition - p);
  float ph = hgPhase(dot(uLDir, V), 0.72) + 0.02;
  // flakes tumble: scintillating glints
  float w = mix(1.5, 7.0, r2.x);
  float tw = 0.18 + 0.82 * pow(0.5 + 0.5 * sin(w * uTime + r.z * 40.0), 6.0);
  float fl = 0.0;
  for (int i = 0; i < 16; i++) { if (i >= uFlashN) break; if (abs(uFlash[i].y - float(id)) < 0.5) { float a = uTime - uFlash[i].x; fl += uFlash[i].z * step(0.0, a) * exp(-a / 0.35); } }
  float size = 0.25 + 0.6 * r2.y * r2.y + 1.6 * pow(r2.y, 12.0);
  vec4 vp = viewMatrix * vec4(p, 1.0);
  float z = -vp.z;
  float fpx = focalPx();
  vec3 Q = uLCol * m * ph * (tw + 6.0 * fl) * size * 1.6e-4 * fpx * fpx / (z * z) * uGain;
  if (!emitSprite(p, Q, corner, 0.0)) CULL
}`;

/**
 * createDust(ctx, opts) — dust motes that only sparkle inside a light beam.
 * opts: shaft (a createLightShaft result: motes use its mask, direction and colour) OR
 *       mask: { glsl, name, uniforms } generic mask(pos) + lightDir/lightColor,
 *   box: {center, size} (default: the shaft's bounding box), density (motes / m³, default 400), seed,
 *   gain=1, flashes: [{t, strength}] (e.g. guzheng tremolo notes → a mote flashes), cull.
 */
export function createDust(ctx, opts = {}) {
  const THREE = ctx.THREE;
  const q = qScale(ctx);
  const shaft = opts.shaft;
  const maskGLSL = shaft ? shaft.maskGLSL : (opts.mask ? opts.mask.glsl : 'float dustMaskAll(vec3 p){ return 1.0; }\n');
  const maskName = shaft ? shaft.maskName : (opts.mask ? opts.mask.name : 'dustMaskAll');
  let bmin, bsize;
  if (opts.box) { bsize = opts.box.size; bmin = opts.box.center.map((c, i) => c - bsize[i] / 2); }
  else if (shaft) {
    const O = shaft.uniforms.uSOv.value, Uv = shaft.uniforms.uSUv.value, Vv = shaft.uniforms.uSVv.value, Dv = shaft.uniforms.uSDv.value;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [0, 1]) {
      const pp = [O.x + a * Uv.x + b * Vv.x + c * Dv.x, O.y + a * Uv.y + b * Vv.y + c * Dv.y, O.z + a * Uv.z + b * Vv.z + c * Dv.z];
      for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], pp[i]); hi[i] = Math.max(hi[i], pp[i]); }
    }
    bmin = lo; bsize = hi.map((v, i) => v - lo[i]);
  } else { bsize = [3, 3, 3]; bmin = [-1.5, 0, -1.5]; }
  // motes fill the whole (wrap) box uniformly; only those inside the beam are rasterised
  const boxVol = bsize[0] * bsize[1] * bsize[2];
  const n = Math.min(opts.maxCount ?? 12000, Math.max(8, Math.round((opts.density ?? 400) * q * boxVol)));
  const U = commonUniforms(THREE, ctx, opts, Object.assign({
    uSeed: { value: seedNum(opts.seed ?? 'dust', 'd') % 65521 }, uCull: { value: opts.cull ?? 1.5e-4 }, uAmount: { value: 1 },
    uBoxMin: { value: new THREE.Vector3().fromArray(bmin) }, uBoxSize: { value: new THREE.Vector3().fromArray(bsize) },
    uLCol: { value: new THREE.Vector3() }, uLDir: { value: new THREE.Vector3(0, -1, 0) },
    uFlash: { value: Array.from({ length: 16 }, () => new THREE.Vector4(-1e4, -1, 0, 0)) }, uFlashN: { value: 0 }, uNMotes: { value: n },
  }, shaft ? shaft.maskUniforms : (opts.mask ? opts.mask.uniforms || {} : {})));
  const geo = quadBatch(THREE, n);
  const mat = new THREE.ShaderMaterial(Object.assign({ name: 'mvDust', glslVersion: THREE.GLSL3, uniforms: U, vertexShader: DUST_VS(maskGLSL, maskName), fragmentShader: SPRITE_FS, depthWrite: false, depthTest: true }, blendProps(THREE, 'add')));
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.name = 'mvDust'; mesh.renderOrder = 21;
  const own = lensUniforms(THREE, ctx);
  const flashes = (opts.flashes || []).slice().sort((a, b) => a.t - b.t);
  tagFX(ctx, mesh, 'dust');
  return {
    object: mesh, count: n,
    update(t, w, camera) {
      updateCommon(THREE, ctx, U, own, t, w, camera, opts);
      if (shaft) { U.uLCol.value.copy(shaft.lightColor); U.uLDir.value.copy(shaft.uniforms.uSDn.value); }
      else { U.uLCol.value.fromArray(opts.lightColor || [0.14, 0.16, 0.2]); U.uLDir.value.fromArray(opts.lightDir || [0, -1, 0]).normalize(); }
      U.uAmount.value = Math.min(1, Math.max(0, opts.amount ?? 1));
      let k = 0;
      for (let i = 0; i < flashes.length && k < 16; i++) {
        const a = t - flashes[i].t;
        if (a < 0 || a > 2) continue;
        const idx = Math.floor(mulberry32(Math.floor(flashes[i].t * 1000) + 7)() * n);
        U.uFlash.value[k++].set(flashes[i].t, idx, flashes[i].strength ?? 1, 0);
      }
      U.uFlashN.value = k;
      this.activeCount = n;
    },
    activeCount: 0,
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

const FIREFLY_VS = GLSL_VCOMMON + GLSL_NOISE + GLSL_CULL + /* glsl */ `
uniform float uSeed, uCull, uAmount, uIntensity;
uniform vec3 uBoxMin, uBoxSize, uColor;
` + GLSL_SPRITE_EMIT + /* glsl */ `
float n1(float x, float s){ return mvGradient1(x, uint(s)); }
void main(){
  int vid = gl_VertexID; int id = vid >> 2; int corner = vid & 3;
  uvec3 h = mvPcg3d(uvec3(uint(id), uint(uSeed), 0xf1e5u));
  vec3 r = vec3(h) * MV_U2F;
  vec3 r2 = vec3(mvPcg3d(h ^ uvec3(0x3c6ef372u, 0xa54ff53au, 0x510e527fu))) * MV_U2F;
  if (r2.z > uAmount) CULL
  // lazy wandering path (1/f), slow bobbing; wraps inside the box
  vec3 home = uBoxMin + r * uBoxSize;
  vec3 wav = vec3(0.9 * n1(uTime * 0.07 + r.x * 30.0, 3.0 + uSeed) + 0.3 * n1(uTime * 0.23 + r.y * 30.0, 4.0),
                  0.35 * n1(uTime * 0.09 + r.y * 30.0, 5.0 + uSeed) + 0.08 * sin(uTime * mix(0.8, 1.6, r2.x) + r.z * 9.0),
                  0.9 * n1(uTime * 0.08 + r.z * 30.0, 7.0 + uSeed) + 0.3 * n1(uTime * 0.21 + r.x * 30.0, 8.0));
  vec3 p = uBoxMin + mod(home + wav - uBoxMin, uBoxSize);
  vec3 q = (p - uBoxMin) / uBoxSize;
  vec3 fq = smoothstep(vec3(0.0), vec3(0.06), q) * smoothstep(vec3(1.0), vec3(0.94), q);
  // slow blink: glow ~0.6-1.2 s every 2.5-6 s, smooth rise/fall; a few steady dim ones
  float per = mix(2.5, 6.0, r2.x), dur = mix(0.6, 1.2, r2.y);
  float ph = fract(uTime / per + r.z) * per;
  float blink = smoothstep(0.0, 0.35 * dur, ph) * smoothstep(dur, 0.45 * dur, ph);
  blink = max(blink, 0.04 * step(0.85, r.x));
  float fpx = focalPx();
  vec4 vp = viewMatrix * vec4(p, 1.0);
  float z = -vp.z;
  vec3 Q = uColor * uIntensity * blink * fq.x * fq.y * fq.z * mix(0.6, 1.2, r2.y) * 4.0e-4 * fpx * fpx / (z * z) * uGain;
  if (!emitSprite(p, Q, corner, 0.3)) CULL
}`;

/**
 * createFireflies(ctx, opts) — soft glowing points, lazy wandering paths, slow blink (dream shots).
 * opts: box:{center,size}, count (default 120), color (default yellow-green [0.72,1.0,0.28]), intensity=1,
 *   amount=1 (fraction visible), seed, gain. HDR cores (> 1) so bloom/halation pick them up.
 */
export function createFireflies(ctx, opts = {}) {
  const THREE = ctx.THREE;
  const q = qScale(ctx);
  const box = opts.box || { center: [0, 1.2, 0], size: [8, 2.5, 8] };
  const n = Math.max(1, Math.round((opts.count ?? 120) * (ctx.quality === 'final' ? 1 : 0.6)));
  const U = commonUniforms(THREE, ctx, opts, {
    uSeed: { value: seedNum(opts.seed ?? 'ff', 'f') % 65521 }, uCull: { value: opts.cull ?? 1e-4 }, uAmount: { value: opts.amount ?? 1 },
    uIntensity: { value: opts.intensity ?? 1 },
    uBoxMin: { value: new THREE.Vector3().fromArray(box.center.map((c, i) => c - box.size[i] / 2)) }, uBoxSize: { value: new THREE.Vector3().fromArray(box.size) },
    uColor: { value: new THREE.Vector3().fromArray(opts.color || [0.72, 1.0, 0.28]) },
  });
  const geo = quadBatch(THREE, n);
  const mat = new THREE.ShaderMaterial(Object.assign({ name: 'mvFireflies', glslVersion: THREE.GLSL3, uniforms: U, vertexShader: FIREFLY_VS, fragmentShader: SPRITE_FS, depthWrite: false, depthTest: true }, blendProps(THREE, 'add')));
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.name = 'mvFireflies'; mesh.renderOrder = 22;
  const own = lensUniforms(THREE, ctx);
  tagFX(ctx, mesh, 'fireflies');
  return {
    object: mesh, count: n,
    update(t, w, camera) {
      updateCommon(THREE, ctx, U, own, t, w, camera, opts);
      U.uAmount.value = typeof opts.amountAt === 'function' ? opts.amountAt(t, w) : (opts.amount ?? 1);
      this.activeCount = n;
    },
    activeCount: 0,
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

// ===============================================================================================================
// 7. TEA STEAM — thin translucent ribbons that rise, twist, curl and dissolve (strongly forward-scattering)
// ===============================================================================================================
const STEAM_SEG = 40;
const STEAM_VS = GLSL_VCOMMON + GLSL_NOISE + GLSL_CULL + /* glsl */ `
uniform vec3 uOrigin; uniform float uRadius, uHeight, uAmount, uSeed, uRise, uWidth, uCurl;
uniform vec3 uDraft;          // gentle room draft (m/s)
out vec2 vX;                  // x across (-1..1), y = s (0 bottom .. 1 top)
out vec4 vK;                  // x density, y advected coordinate, z ribbon seed, w twist factor
out vec3 vW;
float n1(float x, float s){ return mvGradient1(x, uint(s)); }
vec3 flow(float h, float t, float sd, float A){
  // lateral displacement of the parcel now at height h: noise advected upward with the plume + evolving in t
  float a = h * 11.0 - t * uRise * 11.0;
  vec3 o = vec3(n1(a + sd, 3.0) + 0.5 * n1(a * 2.3 + sd * 1.7 + t * 0.4, 5.0), 0.0,
                n1(a + sd * 2.1 + 17.0, 7.0) + 0.5 * n1(a * 2.1 + sd * 0.7 - t * 0.35, 9.0)) * A;
  // curls: a rotating component whose radius grows with height (vortex roll-up)
  float w = h * 42.0 - t * 3.1 + sd;
  o += vec3(cos(w), 0.0, sin(w)) * uCurl * A * smoothstep(0.02, 0.12, h);
  return o;
}
void main(){
  int vid = gl_VertexID; int rib = vid / ${STEAM_SEG * 2}; int k = vid - rib * ${STEAM_SEG * 2};
  int j = k / 2, side = k - j * 2;
  float s = float(j) / ${(STEAM_SEG - 1).toFixed(1)};
  vec3 r = vec3(mvPcg3d(uvec3(uint(rib), uint(uSeed), 0x57ea3u))) * MV_U2F;
  // each ribbon lives for a few seconds, then re-emerges elsewhere on the tea surface (overlapping cycles)
  float P = mix(3.5, 6.5, r.x);
  float cyc = uTime / P + r.y;
  float cn = floor(cyc), cu = cyc - cn;
  vec3 rc = vec3(mvPcg3d(uvec3(uint(rib), uint(int(cn) + 7919), uint(uSeed) ^ 0x9e37u))) * MV_U2F;
  float life = smoothstep(0.0, 0.25, cu) * smoothstep(1.0, 0.7, cu);
  float act = step(r.z, uAmount * 1.05) * life;
  if (act <= 0.001) CULL
  float ang = rc.x * 6.2831853, rad = uRadius * mix(0.15, 0.85, sqrt(rc.y));
  vec3 base = uOrigin + vec3(cos(ang) * rad, 0.0, sin(ang) * rad);
  float H = uHeight * mix(0.6, 1.1, rc.z);
  float h = s * H;
  float A = 0.03 * pow(s, 1.35) * mix(0.7, 1.3, r.y);
  float sd = rc.z * 57.0 + float(rib) * 13.0;
  vec3 c = base + vec3(0.0, h, 0.0) + flow(h, uTime, sd, A) + uDraft * (h / uRise) * s;
  vec3 c2 = base + vec3(0.0, h + 0.004, 0.0) + flow(h + 0.004, uTime, sd, 0.022 * pow(min(s + 0.004 / H, 1.0), 1.25) * mix(0.7, 1.3, r.y)) + uDraft * ((h + 0.004) / uRise) * s;
  vec3 T = normalize(c2 - c);
  vec3 V = normalize(cameraPosition - c);
  vec3 across = normalize(cross(T, V));
  // the sheet twists as it rises: apparent width ∝ |cos(twist)|, edge-on sheets look denser
  float tw = n1(h * 9.0 - uTime * uRise * 9.0 + sd, 13.0) * 2.2 + r.x * 3.0;
  float ct = abs(cos(tw));
  float w = uWidth * (0.35 + 3.2 * s) * mix(0.7, 1.3, rc.x) * max(ct, 0.18);
  vec3 wp = c + across * w * (side == 0 ? -1.0 : 1.0);
  float dens = act * smoothstep(0.0, 0.07, s) * pow(1.0 - s, 1.4) / max(ct, 0.28) * mix(0.6, 1.0, rc.y);
  vX = vec2(side == 0 ? -1.0 : 1.0, s);
  vK = vec4(dens, h / H - uTime * uRise / H, sd, ct);
  vW = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const STEAM_FS = GLSL_COMMON + GLSL_NOISE + GLSL_LIGHTS.replace(/vec3 inscatter[\s\S]*$/, '') + FS_HEAD + /* glsl */ `
in vec2 vX; in vec4 vK; in vec3 vW;
uniform float uOpacity, uG;
float n1(float x, float s){ return mvGradient1(x, uint(s)); }
void main(){
  float x = vX.x, s = vX.y;
  float prof = pow(max(1.0 - x * x, 0.0), 1.5);
  // fine filaments stretched along the flow + breakup that increases with height
  float fil = 0.55 + 0.45 * mvValue(vec2(x * 2.6 + vK.z, vK.y * 7.0));
  float brk = mvValue(vec2(x * 1.3 + vK.z * 1.7, vK.y * 3.0 + 5.0)) * 0.5 + 0.5;
  float thr = mix(0.05, 0.62, s);
  float keep = smoothstep(thr - 0.18, thr + 0.18, brk);
  float d = vK.x * prof * fil * keep;
  float tau = d * uOpacity * 0.07;                 // thin steam: optical depth ~0.01–0.1
  if (tau < 0.0002) discard;
  vec3 V = normalize(cameraPosition - vW);
  // tiny water droplets: strong forward (Mie-like) lobe + weak side scatter
  #define SPH(c) (0.8 * hgPhase(c, uG) + 0.2 / (4.0 * PI))
  vec3 L = (uMoonCol * SPH(dot(-uMoonDir, V)) + uSunCol * SPH(dot(-uSunDir, V)));
  for (int i = 0; i < ${MAX_PT}; i++) {
    if (i >= uPtN) break;
    vec3 dd = vW - uPtPos[i].xyz; float r2 = dot(dd, dd);
    L += uPtCol[i] * SPH(dot(dd * inversesqrt(r2), V)) / (r2 + uPtPos[i].w * uPtPos[i].w);
  }
  L += (uSkyCol + uGndCol) * 0.5;
  // single scattering (albedo ~1): radiance = L·(1 - e^-τ) ≈ L·τ; the background is barely attenuated
  float a = 1.0 - exp(-tau);
  float fd = fxDepthFade();
  fragColor = vec4(L * a * uGain, a * 0.08) * fd;
}`;

/**
 * createSteam(ctx, opts) — tea steam above a cup.
 * opts: origin:[x,y,z] (tea surface centre), radius (m, default 0.03), height (default 0.16 m),
 *   ribbons (default 12 final / 7 preview), rise (m/s, default 0.12), width (default 0.0035 m at the base),
 *   curl=0.6, opacity=1, g=0.72 (forward scattering: backlit steam glows), draft [x,y,z] m/s,
 *   lights (e.g. the low sun through the window as a point/dir light), scale (× world.steam).
 */
export function createSteam(ctx, opts = {}) {
  const THREE = ctx.THREE;
  const nR = opts.ribbons ?? (ctx.quality === 'final' ? 12 : 7);
  const U = commonUniforms(THREE, ctx, opts, {
    uOrigin: { value: new THREE.Vector3().fromArray(opts.origin || [0, 0, 0]) }, uRadius: { value: opts.radius ?? 0.03 },
    uHeight: { value: opts.height ?? 0.16 }, uAmount: { value: 1 }, uSeed: { value: seedNum(opts.seed ?? 'steam', 'st') % 65521 },
    uRise: { value: opts.rise ?? 0.12 }, uWidth: { value: opts.width ?? 0.0035 }, uCurl: { value: opts.curl ?? 0.6 },
    uDraft: { value: new THREE.Vector3().fromArray(opts.draft || [0.004, 0, -0.002]) },
    uOpacity: { value: opts.opacity ?? 1 }, uG: { value: opts.g ?? 0.72 },
  });
  const geo = gridBatch(THREE, nR, 2, STEAM_SEG);
  geo.boundingSphere.center.fromArray(opts.origin || [0, 0, 0]);
  geo.boundingSphere.radius = 0.5;
  const mat = new THREE.ShaderMaterial(Object.assign({ name: 'mvSteam', glslVersion: THREE.GLSL3, uniforms: U, vertexShader: STEAM_VS, fragmentShader: STEAM_FS, depthWrite: false, depthTest: true, side: THREE.DoubleSide }, blendProps(THREE, 'premul')));
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.name = 'mvSteam'; mesh.renderOrder = 15;
  const own = lensUniforms(THREE, ctx);
  tagFX(ctx, mesh, 'steam');
  return {
    object: mesh,
    update(t, w, camera) {
      updateCommon(THREE, ctx, U, own, t, w, camera, opts);
      const a = Math.min(1, Math.max(0, (w.steam ?? 0) * (opts.scale ?? 1)));
      U.uAmount.value = a;
      mesh.visible = a > 0.001;
      this.activeCount = Math.round(nR * a);
    },
    activeCount: 0,
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

// ===============================================================================================================
// 8. MIST CARDS / GROUND FOG — large soft noise layers (ground-aligned or camera-facing), lit by the rig
// ===============================================================================================================
const MIST_VS = /* glsl */ `
uniform vec3 uC; uniform vec3 uAx; uniform vec3 uAy;     // card centre, half-axis vectors (world)
uniform float uBill;                                      // 1 = rotate around Y to face the camera
out vec2 vUv; out vec3 vW;
void main(){
  vec2 c = position.xy;   // [-1,1]²
  vec3 ax = uAx, ay = uAy;
  if (uBill > 0.5) {
    vec3 toC = cameraPosition - uC; toC.y = 0.0;
    vec3 f = normalize(toC + vec3(1e-5, 0.0, 0.0));
    ax = normalize(cross(vec3(0.0, 1.0, 0.0), f)) * length(uAx);
    ay = vec3(0.0, length(uAy), 0.0);
  }
  vec3 w = uC + c.x * ax + c.y * ay;
  vUv = c; vW = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
const MIST_FS = GLSL_COMMON + GLSL_LIGHTS.replace(/vec3 inscatter[\s\S]*$/, '') + FS_HEAD + /* glsl */ `
in vec2 vUv; in vec3 vW;
uniform sampler2D uNoiseTex;
uniform float uDens, uScale, uSeedOff, uBill, uG, uNearFade;
uniform vec2 uDriftM;       // metres of drift (wind)
uniform vec3 uTint;
void main(){
  // soft card edge (elliptical), fade near the camera
  float e = 1.0 - smoothstep(0.55, 1.0, length(vUv));
  float dc = length(cameraPosition - vW);
  float nf = smoothstep(uNearFade * 0.4, uNearFade, dc);
  vec2 P = uBill > 0.5 ? vec2(vUv.x * 7.0 + uSeedOff, vW.y * 0.7) : vW.xz;
  vec2 uv = (P + uDriftM) / uScale;
  float n1 = texture(uNoiseTex, uv + uSeedOff * 0.37).r;
  float n2 = texture(uNoiseTex, uv * 2.7 - uDriftM / uScale * 0.6 + 0.19).g;
  float n = (n1 * 0.65 + n2 * 0.35 - 0.5) * 2.4 + 0.5;
  float bil = smoothstep(0.3, 0.8, n);
  float d = (0.25 + 0.75 * bil * bil) * e * nf * uDens;
  // planar ground layers look thicker at grazing angles (longer path), capped
  if (uBill < 0.5) { vec3 V = normalize(cameraPosition - vW); d *= min(1.0 / max(abs(V.y), 0.05), 3.0) * 0.4; }
  float a = 1.0 - exp(-d);
  if (a < 0.002) discard;
  vec3 V = normalize(cameraPosition - vW);
  #define MPH(c) (0.7 * hgPhase(c, uG) + 0.3 / (4.0 * PI))
  vec3 L = uMoonCol * MPH(dot(-uMoonDir, V)) + uSunCol * MPH(dot(-uSunDir, V));
  for (int i = 0; i < ${MAX_PT}; i++) {
    if (i >= uPtN) break;
    vec3 dd = vW - uPtPos[i].xyz; float r2 = dot(dd, dd);
    L += uPtCol[i] * MPH(dot(dd * inversesqrt(r2), V)) / (r2 + uPtPos[i].w * uPtPos[i].w);
  }
  L += (uSkyCol + uGndCol) * 0.5;
  // fog radiance: single scattering E·p plus a multiple-scattering allowance (albedo ~0.9)
  vec3 col = L * 2.4 * uTint;
  float fd = fxDepthFade();
  fragColor = vec4(col * a * uGain, a) * fd;
}`;

/**
 * createMistCards(ctx, opts) — layered soft mist: ground-aligned sheets and camera-facing veils.
 * opts: cards: [{ center:[x,y,z], size:[w,d|h], type:'ground'|'billboard', density, scale }] explicit list, or
 *   region: { center, size:[w,h,d] } + count (auto: ~60 % ground layers stacked low, 40 % veils at depth),
 *   density=1 (× world.mist), scale (noise feature size m, default 6), windScale=0.15 (mist drifts slower than wind),
 *   lights/moon/sun/sky (lantern → warm glow in the mist), tint [r,g,b] (e.g. grey-green #6f8582 bias), g=0.35,
 *   nearFade=2 m. Each card is its own mesh (three sorts them back-to-front; premultiplied blending).
 */
export function createMistCards(ctx, opts = {}) {
  const THREE = ctx.THREE;
  const group = new THREE.Group(); group.name = 'mvMistCards';
  const R = makeRng(opts.seed ?? 'mist');
  let cards = opts.cards;
  if (!cards) {
    const reg = opts.region || { center: [0, 1, -30], size: [60, 3, 40] };
    const n = opts.count ?? (ctx.quality === 'final' ? 7 : 5);
    cards = [];
    for (let i = 0; i < n; i++) {
      const ground = i < Math.ceil(n * 0.6);
      const c = reg.center, sz = reg.size;
      if (ground) cards.push({ type: 'ground', center: [c[0] + (R() - 0.5) * sz[0] * 0.3, c[1] - sz[1] / 2 + sz[1] * (i + 0.5) / Math.ceil(n * 0.6) * 0.6, c[2] + (R() - 0.5) * sz[2] * 0.3], size: [sz[0] * (0.8 + 0.3 * R()), sz[2] * (0.8 + 0.3 * R())], density: 0.5 + 0.5 * R() });
      else cards.push({ type: 'billboard', center: [c[0] + (R() - 0.5) * sz[0] * 0.7, c[1] - sz[1] / 2 + sz[1] * 0.45, c[2] + (R() - 0.5) * sz[2] * 0.8], size: [sz[0] * (0.25 + 0.2 * R()), sz[1] * 0.75], density: 0.35 + 0.4 * R() });
    }
  }
  const tex = getNoiseTexture(THREE);
  const worldSrc = worldFnOf(ctx, opts);
  const tl = getTimeline(THREE, worldSrc);
  const own = lensUniforms(THREE, ctx);
  const qgeo = new THREE.PlaneGeometry(2, 2);
  const parts = cards.map((cd, i) => {
    const bill = cd.type === 'billboard';
    const ax = bill ? new THREE.Vector3(cd.size[0] / 2, 0, 0) : new THREE.Vector3(cd.size[0] / 2, 0, 0);
    const ay = bill ? new THREE.Vector3(0, cd.size[1] / 2, 0) : new THREE.Vector3(0, 0, -cd.size[1] / 2);
    const U = commonUniforms(THREE, ctx, opts, {
      uC: { value: new THREE.Vector3().fromArray(cd.center) }, uAx: { value: ax }, uAy: { value: ay }, uBill: { value: bill ? 1 : 0 },
      uNoiseTex: { value: tex }, uDens: { value: 1 }, uScale: { value: cd.scale ?? opts.scale ?? 6 }, uSeedOff: { value: R() * 10 },
      uDriftM: { value: new THREE.Vector2() }, uTint: { value: new THREE.Vector3().fromArray(opts.tint || [1, 1, 1]) },
      uG: { value: opts.g ?? 0.35 }, uNearFade: { value: opts.nearFade ?? 2 },
    });
    U.uSoftDepth.value = opts.softDepth ?? 1.2;
    const mat = new THREE.ShaderMaterial(Object.assign({ name: 'mvMist' + i, glslVersion: THREE.GLSL3, uniforms: U, vertexShader: MIST_VS, fragmentShader: MIST_FS, depthWrite: false, depthTest: true, side: THREE.DoubleSide }, blendProps(THREE, 'premul')));
    const mesh = new THREE.Mesh(qgeo, mat); mesh.frustumCulled = false; mesh.name = 'mvMist' + i;
    mesh.position.fromArray(cd.center);   // for three's back-to-front sorting (the shader ignores modelMatrix)
    group.add(mesh);
    return { cd, U, mesh, mat };
  });
  tagFX(ctx, group, 'mist');
  return {
    object: group, cards,
    update(t, w, camera) {
      const amount = Math.min(1, Math.max(0, (w.mist ?? 0) * (opts.density ?? 1)));
      const dr = tl.at(t), ws = opts.windScale ?? 0.15;
      for (const P of parts) {
        updateCommon(THREE, ctx, P.U, own, t, w, camera, opts);
        P.U.uDens.value = amount * (P.cd.density ?? 1) * 0.9;
        P.U.uDriftM.value.set(-dr[0] * ws, -dr[1] * ws);
        P.mesh.visible = amount > 0.002;
      }
      this.activeCount = parts.length;
    },
    activeCount: 0,
    dispose() { qgeo.dispose(); for (const P of parts) P.mat.dispose(); },
  };
}

export const _internals = { getTimeline, quadBatch, gridBatch, makeColumnSelector, GLSL_COMMON, GLSL_LIGHTS, GLSL_REGION, GLSL_TIMELINE, blendProps, commonUniforms, updateCommon, lensUniforms };
