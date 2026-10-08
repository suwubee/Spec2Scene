// Author: suwubee
// engine/water.js — the river surface (y = 0): calm, misty night river with
//   * analytic dispersive wind waves + a slow swell (closed form in t) and a baked tileable ripple texture (2 taps),
//     all filtered by pixel footprint (lost slope variance goes into the glitter roughness — LEAN-style),
//   * Fresnel sky reflection (sky lib map) + a planar reflection pass (banks, houses, bridge, lights; mirrored camera
//     with an oblique clip plane) distorted by the waves,

//     bridge lamps -> vertical shimmering streaks),
//   * dark teal-green body colour, valley mist/haze (shared atmosphere), rain ripples on the west half (particles lib
//     ripple texture), and up to 48 closed-form expanding ring waves (guzheng / guqin notes, drops).
// Everything is a pure function of (t, world, rings list). See engine/README.md.
//
//   const water = createWater(ctx, { atmos, sky });
//   scene.add(water.object);
//   // per frame, after the camera is final:
//   water.setRings([{ x, z, t0, amp, speed, lambda, life }, ...]);   // ≤ 48, pure function of t (see ringsFromNotes)
//   water.update(t, world, camera, { renderer, scene, lights, rainEdge });  // also renders the reflection pass
import { makeRng } from './noise.js';
import { createRippleTexture } from './particles.js';

export const MAX_RINGS = 48;
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);

// ---------------------------------------------------------------------------------------------------------------
// Tileable ripple slope texture (CPU bake, once): sum of integer-wavevector sinusoids => perfectly periodic
// ---------------------------------------------------------------------------------------------------------------
function bakeRippleTexture(THREE, N = 256, seed = 'water-ripples') {
  const rng = makeRng(seed);
  const waves = [];
  for (let i = 0; i < 90; i++) {
    const k = 2 + Math.pow(rng(), 1.6) * 30;                  // cycles per tile
    const th = (rng() - 0.5) * Math.PI * 1.6 + (rng() < 0.25 ? Math.PI : 0);
    const kx = Math.round(Math.cos(th) * k), ky = Math.round(Math.sin(th) * k);
    if (!kx && !ky) continue;
    const kk = Math.hypot(kx, ky);
    waves.push({ kx, ky, a: Math.pow(kk, -1.9) * (0.6 + 0.8 * rng()), ph: rng() * Math.PI * 2 });
  }
  const sx = new Float32Array(N * N), sy = new Float32Array(N * N);
  let s2 = 0;
  const TAU = Math.PI * 2;
  for (const w of waves) {
    const cx = new Float32Array(N), sxn = new Float32Array(N), cy = new Float32Array(N), syn = new Float32Array(N);
    for (let i = 0; i < N; i++) { const a = TAU * w.kx * i / N; cx[i] = Math.cos(a); sxn[i] = Math.sin(a); const b = TAU * w.ky * i / N + w.ph; cy[i] = Math.cos(b); syn[i] = Math.sin(b); }
    const gx = w.a * TAU * w.kx, gy = w.a * TAU * w.ky;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const c = cx[i] * cy[j] - sxn[i] * syn[j];                // cos(a + b)
      const k = j * N + i;
      sx[k] += gx * c; sy[k] += gy * c;
    }
  }
  for (let k = 0; k < N * N; k++) s2 += sx[k] * sx[k] + sy[k] * sy[k];
  const rms = Math.sqrt(s2 / (N * N) / 2) || 1;
  const data = new Uint8Array(N * N * 4);
  for (let k = 0; k < N * N; k++) {
    data[k * 4] = Math.round(clamp(sx[k] / rms * 0.22 + 0.5) * 255);
    data[k * 4 + 1] = Math.round(clamp(sy[k] / rms * 0.22 + 0.5) * 255);
    data[k * 4 + 2] = 128; data[k * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace; tex.needsUpdate = true;
  return { tex, scale: 1 / 0.22 };   // texture value (v - 0.5) * scale = slope in units of the RMS slope
}

// analytic wind waves: direction (deg from +x toward +z), wavelength (m), amplitude (m), phase.
// 12 components with a wide directional spread (short-crested sea); each is modulated in the shader by a drifting
// group envelope, and the short ones by wind 'cat's-paw' patches (glassy lanes between rippled patches).
const NWAVE = 12;
function makeWaves(seed = 'water-waves-2') {
  const rng = makeRng(seed);
  const W = [];
  for (let i = 0; i < NWAVE; i++) {
    const lam = 7.2 * Math.pow(0.5 / 7.2, i / (NWAVE - 1)) * (0.9 + 0.2 * rng());      // 7.2 m … 0.5 m
    const counter = i % 4 === 3;
    const dir = (rng() - 0.5) * 110 + (counter ? 180 : 0) + 8;                            // ±55° about the wind
    const amp = 0.0036 * Math.pow(lam, 0.95) * (0.7 + 0.6 * rng()) * (counter ? 0.6 : 1);
    W.push({ dir, lam, amp, ph: rng() * Math.PI * 2 });
  }
  return W;
}

const VS = /* glsl */ `
out vec3 vW;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FS = (atmosGLSL, ripGLSL) => /* glsl */ `
${atmosGLSL}
${ripGLSL}
#define NWAVE 12
#define NRING ${MAX_RINGS}
in vec3 vW;
layout(location = 0) out vec4 fragColor;
uniform vec4 uWave[NWAVE];        // (kx, kz) rad/m, amplitude (m), phase(t) rad (CPU: phase0 - omega*t)
uniform float uWaveGain;          // wind response
uniform sampler2D uRipTex; uniform vec4 uRip;      // x slope scale, y tile (m), z strength, w unused
uniform vec4 uRipScroll;          // two scroll offsets (m): (x1, z1, x2, z2)
uniform vec4 uRing[NRING];        // x, z, age (s), amplitude (m)
uniform vec4 uRingS[NRING];       // speed (m/s), wavelength (m), r_lo^2, r_hi^2  (CPU-precomputed rejection band)
uniform int uRingN;
uniform sampler2D uRainTex; uniform vec4 uRain;     // x amount (west), y tile size (m), z edge x (m), w strength
uniform sampler2D uReflTex; uniform mat4 uReflMat; uniform float uReflOn;
uniform vec3 uBody;               // body (upwelling) albedo
uniform vec4 uSpec;               // x base roughness, y glitter gain (moon/sun), z point-light spec gain, w distortion
uniform vec4 uCamD;               // x px per rad (focal px) for footprint
uniform vec4 uEnv;                // wave-group envelopes: x 1/tile (m^-1), y 1/tile 2, zw drift (m)
uniform float uMoonTmin;          // story: the moon seen through the cloud gap (lower bound of the sky map's cloud T)
uniform vec4 uPaw;                // cat's-paw patches: x 1/tile, yz drift (m), w contrast

vec3 waveSlopes(vec2 p, float fp, out float lostVar, out float paw){
  // group envelopes (short-crested waves) + wind patches: 3 taps of the shared noise texture
  vec2 e1 = texture(vNoiseTex, (p + uEnv.zw) * uEnv.x).rg;
  vec2 e2 = texture(vNoiseTex, (vec2(p.y, -p.x) + uEnv.zw * 0.7) * uEnv.y + 0.31).rg;
  float pw = texture(vNoiseTex, (p + uPaw.yz) * uPaw.x + 0.57).g;
  paw = mix(1.0, 0.18 + 1.7 * smoothstep(0.36, 0.76, pw), uPaw.w);
  float E[4] = float[4](e1.x, e1.y, e2.x, e2.y);
  vec2 s = vec2(0.0);
  lostVar = 0.0;
  for (int i = 0; i < NWAVE; i++) {
    vec4 w = uWave[i];
    float kk = length(w.xy);
    // fade a component when its wavelength spans < ~3 pixel footprints
    float lam = 6.2831853 / kk;
    float f = smoothstep(1.5 * fp, 4.0 * fp, lam);
    float env = 0.12 + 1.75 * smoothstep(0.3, 0.8, E[i - 4 * (i / 4)]);
    float sh = float(i) / float(NWAVE - 1);                   // 0 long … 1 short: short ones follow the wind patches
    float a = w.z * uWaveGain * env * mix(1.0, paw, 0.35 + 0.65 * sh);
    float ph = dot(w.xy, p) + w.w;
    s += w.xy * (a * cos(ph)) * f;
    lostVar += (1.0 - f) * 0.5 * (a * kk) * (a * kk);
  }
  return vec3(s, 0.0);
}
vec2 ringSlopes(vec2 p){
  vec2 s = vec2(0.0);
  for (int i = 0; i < NRING; i++) {
    if (i >= uRingN) break;
    vec4 R = uRing[i], S = uRingS[i];
    vec2 dp = p - R.xy;
    float r2 = dot(dp, dp);
    if (r2 > S.w || r2 < S.z) continue;
    float r = sqrt(r2) + 1e-4;
    float age = R.z;
    float front = S.x * age;
    float lam = S.y * (1.0 + 0.25 * age);
    float wdt = 0.55 * lam + 0.08 * S.x * age;
    float x = r - front;
    float k = 6.2831853 / lam;
    float e1 = exp(-(x * x) / (wdt * wdt));
    float x2 = x + 1.3 * lam;
    float e2 = 0.55 * exp(-(x2 * x2) / (wdt * wdt));
    float env = e1 + e2;
    float denv = -2.0 * x / (wdt * wdt) * e1 - 2.0 * x2 / (wdt * wdt) * e2;
    float A = R.w / sqrt(1.0 + r / max(lam, 0.05));
    float dh = A * (denv * cos(k * x) - env * k * sin(k * x));
    s += dp / r * dh;
  }
  return s;
}

void main(){
  vec3 V = normalize(vCam - vW);
  float dist = length(vCam - vW);
  vec2 p = vW.xz;
  // pixel footprint (m) along the surface (grazing views stretch it)
  vec2 dpx = fwidth(p);
  float fp = max(mix(min(dpx.x, dpx.y), max(dpx.x, dpx.y), 0.3), 1e-4);
  // ---- slopes ----
  float lost, paw;
  vec3 ws = waveSlopes(p, fp, lost, paw);
  vec2 slope = ws.xy;
  // fine ripples: 2 taps of the baked tileable slope texture, scrolled in two directions
  float fr = 1.0 - smoothstep(0.06, 0.3, fp);   // mips filter the rest
  vec2 r1 = (texture(uRipTex, (p + uRipScroll.xy) / uRip.y).rg - 0.5) * uRip.x;
  vec2 r2 = (texture(uRipTex, (p * 1.7 + uRipScroll.zw) / uRip.y + 0.37).rg - 0.5) * uRip.x;
  vec2 rip = (r1 + r2 * 0.7) * uRip.z * uWaveGain * paw;
  slope += rip * fr;
  float rs = uRip.x * 0.22 * uRip.z * uWaveGain * paw;      // RMS slope per component of the ripple layer
  lost += (1.0 - fr * 0.7) * rs * rs * 1.5;
  // note rings
  slope += ringSlopes(p);
  // rain ripples (west half), from the particles lib's tiling ripple texture
  if (uRain.x > 0.001) {
    float west = smoothstep(uRain.z + 6.0, uRain.z - 6.0, p.x + 5.0 * sin(p.y * 0.027 + 1.3));
    if (west > 0.0) {
      float near = 1.0 - smoothstep(0.012, 0.05, fp);
      vec4 R = texture(uRainTex, p / uRain.y);
      vec4 R2 = texture(uRainTex, p.yx / uRain.y * 0.77 + 0.31);
      slope += (R.xy + R2.xy * 0.8) * uRain.w * west * near;
      lost += west * uRain.x * 0.012 * (1.0 - near);
    }
  }
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  float nv = max(dot(N, V), 1e-3);
  float F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  // ---- reflection: sky + planar (banks/houses/bridge/lights) ----
  vec3 Rd = reflect(-V, N);
  Rd.y = abs(Rd.y) + 0.002;
  vec3 refl = skyMap(Rd);
  vec4 prDbg = vec4(0.0);
  if (uReflOn > 0.5) {
    vec2 dist2 = slope * uSpec.w / (1.0 + dist * 0.0015);
    vec4 rc = uReflMat * vec4(vW.x + dist2.x, 0.0, vW.z + dist2.y, 1.0);
    vec2 ruv = rc.xy / rc.w;
    vec4 pr = texture(uReflTex, ruv);
    prDbg = vec4(pr.rgb, pr.a);
    refl = mix(refl, pr.rgb / max(pr.a, 1e-3), clamp(pr.a, 0.0, 1.0));
  }
  // ---- glitter: moon & sun discs (GGX with unresolved slope variance), practical lights ----
  float a0 = uSpec.x;
  float a2 = a0 * a0 + 2.0 * lost;
  float alpha = sqrt(a2);
  vec3 spec = vec3(0.0);
  {
    float Om = 3.14159 * skyDiscA.w * skyDiscA.w;
    // × vKey.z: the moon's visibility over the terrain skyline (no glitter while it is behind the hills; fades in as it rises)
    vec3 Em = skyMoonDisc * Om * max(skyCloudT(skyMoonDir), uMoonTmin) * mix(1.0, vMoonShadow(vW), vKey.x) * vKey.z;
    if (skyMoonDir.y > -0.01) spec += Em * vGGX(N, V, skyMoonDir, alpha) / max(dot(N, skyMoonDir), 1e-3) * uSpec.y;
    float Os = 3.14159 * skyDiscA.z * skyDiscA.z;
    vec3 Es = skySunDisc * Os * skyCloudT(skySunDir);
    if (skySunDir.y > -0.01) spec += Es * vGGX(N, V, skySunDir, alpha) / max(dot(N, skySunDir), 1e-3) * uSpec.y;
  }
  for (int i = 0; i < VNPL; i++) {
    if (i >= vPLn) break;
    vec3 L = vPL[i].xyz - vW; float d2 = dot(L, L);
    vec3 l = L * inversesqrt(d2);
    // point light seen through the lens as a small disc: widen the lobe by its angular size
    float al = sqrt(a2 + vPL[i].w * vPL[i].w / d2);
    spec += vPLc[i] * 3.14159 * vGGX(N, V, l, al) / max(dot(N, l), 1e-3) / d2 * uSpec.z;
  }
  spec *= F;   // vGGX has no Fresnel term
  // soft knee on single-pixel glints: a glint far above the post's streak threshold in one frame flashed a full-width
  // anamorphic streak for that frame only (1-frame pops); highlights below the knee are untouched
  {
    float sl = max(max(spec.r, spec.g), spec.b), knee = 4.0;
    if (sl > knee) spec *= (knee + (sl - knee) / (1.0 + (sl - knee) / knee)) / sl;
  }
  // ---- body: dark teal-green upwelling, lit by sky ambient and a little direct light ----
  vec3 ambUp = texelFetch(skyAmbTex, ivec2(2, 1), 0).rgb;
  float ks = vKeyShadow(vW);
  vec3 body = uBody * (ambUp * 0.6 + vMoonCol * max(vMoonDir.y, 0.0) * 0.25 * vKey.z * mix(1.0, ks, vKey.x) + vSunCol * max(vSunDir.y, 0.0) * 0.25 * vKey.y * mix(ks, 1.0, vKey.x));
  vec3 col = mix(body, refl, F) + spec;
  if (vDebug == 4) { fragColor = vec4(prDbg.rgb * 4.0 + vec3(0.0, 0.0, prDbg.a * 0.02), 1.0); return; }
  if (vDebug == 5) { fragColor = vec4(spec, 1.0); return; }
  if (vDebug == 6) { fragColor = vec4(vec3(F) * 0.2, 1.0); return; }
  col = vApplyAtmos(col, vW);
  fragColor = vec4(col, 1.0);
}`;

/**
 * createWater(ctx, { atmos, sky, size, reflection:true, reflScale, rain:true })
 *   update(t, world, camera, { renderer, scene, mirrorLayer }) — sets uniforms and renders the planar reflection.
 */
export function createWater(ctx, opts = {}) {
  const { THREE } = ctx;
  const atmos = opts.atmos;
  const sky = opts.sky || atmos.sky;
  const size = opts.size || 24000;
  const geo = new THREE.PlaneGeometry(size, size, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const rip = bakeRippleTexture(THREE);
  const waves = makeWaves();
  const rainTex = opts.rain === false ? null : createRippleTexture(ctx, { tileCells: 10, res: ctx.quality === 'final' ? 256 : 160, seed: 'valley-river' });
  const blackTex = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); blackTex.needsUpdate = true;
  const V4 = () => new THREE.Vector4();
  const U = {
    uWave: { value: Array.from({ length: NWAVE }, () => V4()) }, uWaveGain: { value: 1 },
    uEnv: { value: V4() }, uPaw: { value: V4() }, uMoonTmin: { value: 0 },
    uRipTex: { value: rip.tex }, uRip: { value: new THREE.Vector4(rip.scale * 0.035, 2.3, 1, 0) }, uRipScroll: { value: V4() },
    uRing: { value: Array.from({ length: MAX_RINGS }, () => V4()) }, uRingS: { value: Array.from({ length: MAX_RINGS }, () => V4()) }, uRingN: { value: 0 },
    uRainTex: { value: rainTex ? rainTex.texture : blackTex }, uRain: { value: V4() },
    uReflTex: { value: blackTex }, uReflMat: { value: new THREE.Matrix4() }, uReflOn: { value: 0 },
    uBody: { value: new THREE.Vector3(0.018, 0.04, 0.036) },
    uSpec: { value: new THREE.Vector4(0.035, 1.0, 1.0, 24.0) },
    uCamD: { value: V4() },
  };
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS(atmos.glsl, ''),
    uniforms: { ...atmos.uniforms, ...U },
  });
  mat.name = 'valley.water';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'valley.water';
  mesh.frustumCulled = false;
  mesh.renderOrder = opts.renderOrder ?? 150;

  // ---- planar reflection ----
  const reflOn = opts.reflection !== false;
  const reflScale = opts.reflScale ?? (ctx.quality === 'final' ? 0.4 : 0.5);
  let reflRT = null;
  const mirrorCam = new THREE.PerspectiveCamera();
  const _v = new THREE.Vector3(), _t = new THREE.Vector3(), _up = new THREE.Vector3(), _q = new THREE.Quaternion();
  const _plane = new THREE.Plane(), _clip = new THREE.Vector4(), _qv = new THREE.Vector4();
  const layer = opts.mirrorLayer ?? 2;
  mirrorCam.layers.set(layer);
  function ensureRT(w, h) {
    if (reflRT && reflRT.width === w && reflRT.height === h) return;
    if (reflRT) reflRT.dispose();
    reflRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    U.uReflTex.value = reflRT.texture;
  }
  function renderReflection(renderer, scene, camera) {
    const res = ctx.uniforms && ctx.uniforms.uRes ? ctx.uniforms.uRes.value : { x: ctx.width, y: ctx.pictureHeight || ctx.height };
    ensureRT(Math.max(16, Math.round(res.x * reflScale)), Math.max(8, Math.round(res.y * reflScale)));
    camera.updateMatrixWorld();
    // Mirror about the explicit water elevation (default ground plane).
    const planeY=opts.planeY??0;
    const cp = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    _up.set(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(_q));
    mirrorCam.position.set(cp.x, 2*planeY-cp.y, cp.z);
    _t.copy(cp).add(dir); _t.y = 2*planeY-_t.y;
    mirrorCam.up.set(_up.x, -_up.y, _up.z);
    mirrorCam.lookAt(_t);
    mirrorCam.fov = camera.fov; mirrorCam.aspect = camera.aspect; mirrorCam.near = camera.near; mirrorCam.far = camera.far;
    mirrorCam.updateProjectionMatrix(); mirrorCam.updateMatrixWorld();
    mirrorCam.matrixWorldInverse.copy(mirrorCam.matrixWorld).invert();
    // oblique near plane = water plane (Lengyel), clip everything below y = 0
    _plane.set(new THREE.Vector3(0, 1, 0), -(planeY+0.02)).applyMatrix4(mirrorCam.matrixWorldInverse);
    _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
    const P = mirrorCam.projectionMatrix, e = P.elements;
    _qv.x = (Math.sign(_clip.x) + e[8]) / e[0];
    _qv.y = (Math.sign(_clip.y) + e[9]) / e[5];
    _qv.z = -1.0;
    _qv.w = (1.0 + e[10]) / e[14];
    _clip.multiplyScalar(2.0 / _clip.dot(_qv));
    e[2] = _clip.x; e[6] = _clip.y; e[10] = _clip.z + 1.0; e[14] = _clip.w;
    mirrorCam.projectionMatrixInverse.copy(P).invert();
    // texture matrix: world -> reflection uv
    U.uReflMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(mirrorCam.projectionMatrix).multiply(mirrorCam.matrixWorldInverse);
    // render with the atmosphere in mirror mode (camera = mirrored camera, density mirrored)
    const prevCam = atmos.uniforms.vCam.value.clone();
    atmos.uniforms.vCam.value.copy(mirrorCam.position);
    atmos.setMirror(true);
    // the reflection keeps the river a dark mirror: no distant valley fog / moonbeam volume in the mirrored view
    // (their in-scatter is already in front of the water in the main view; reflected again it read as a bright sheet)
    const AU = atmos.uniforms;
    const fogX = AU.vFogV ? AU.vFogV.value.x : 0, beamX = AU.vBeam ? AU.vBeam.value.x : 0, beamW = AU.vBeam ? AU.vBeam.value.w : 0;
    if (AU.vFogV) AU.vFogV.value.x = fogX * (opts.mirrorFog ?? 0.25);
    if (AU.vBeam) { AU.vBeam.value.x = beamX * (opts.mirrorBeam ?? 0.2); }
    const prevRT = renderer.getRenderTarget(), prevAC = renderer.autoClear;
    const prevCC = renderer.getClearColor(new THREE.Color()), prevCA = renderer.getClearAlpha();
    renderer.setRenderTarget(reflRT);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.clear(true, true, false);
    renderer.render(scene, mirrorCam);
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevCC, prevCA);
    renderer.autoClear = prevAC;
    atmos.setMirror(false);
    if (AU.vFogV) AU.vFogV.value.x = fogX;
    if (AU.vBeam) { AU.vBeam.value.x = beamX; AU.vBeam.value.w = beamW; }
    atmos.uniforms.vCam.value.copy(prevCam);
    U.uReflOn.value = 1;
  }

  let rings = [];
  let lastReflKey = null;   // cache key of the reflection texture (pure function of the key's inputs)
  function setRings(list) { rings = list || []; }

  function update(t, w, camera, x = {}) {
    // waves: phase(t) = ph0 - omega t, omega from the dispersion relation (gravity + capillary), drift with the current
    const wind = w.wind ?? 0.3;
    U.uWaveGain.value = (0.35 + 1.5 * wind) * (x.waveGain ?? 1);
    const cur = [0.0, 0.22];   // river current (m/s, flowing south)
    for (let i = 0; i < waves.length; i++) {
      const W = waves[i];
      const k = (Math.PI * 2) / W.lam, a = (W.dir * Math.PI) / 180;
      const kx = Math.cos(a) * k, kz = Math.sin(a) * k;
      const om = Math.sqrt(9.81 * k + 0.0728 / 1000 * k * k * k) + (kx * cur[0] + kz * cur[1]);
      U.uWave.value[i].set(kx, kz, W.amp, W.ph - om * t);
    }
    // group envelopes drift at ~ group speed, wind patches (cat's-paws) run with the wind (closed form in t)
    const wd = w.windDir || [0.9, 0, 0.12];
    U.uEnv.value.set(1 / 64, 1 / 27, -wd[0] * 0.45 * t, -wd[2] * 0.45 * t - cur[1] * t);
    U.uPaw.value.set(1 / 260, -wd[0] * (0.6 + 2.2 * wind) * t, -wd[2] * (0.6 + 2.2 * wind) * t - cur[1] * t, x.patches ?? 0.85);
    const sp = 0.16 + 0.35 * wind;
    U.uRipScroll.value.set(-wd[0] * sp * t, -wd[2] * sp * t - cur[1] * t, -(wd[2] * 0.6 - 0.3) * 0.11 * t, (wd[0] * 0.6) * 0.11 * t - cur[1] * t);
    U.uRip.value.z = 0.85 + 0.6 * wind;
    // rain ripples on the west half
    const rain = w.rain ?? 0;
    if (rainTex && rain > 0.001) {
      rainTex.update(t, w);
      U.uRain.value.set(rain, rainTex.tileSize, x.rainEdge ?? -4, 1.0);
    } else U.uRain.value.set(0, 2, 0, 0);
    // rings (CPU: age & rejection band)
    let n = 0;
    for (const r of rings) {
      if (n >= MAX_RINGS) break;
      const age = t - r.t0, life = r.life ?? 6;
      if (age <= 0 || age > life) continue;
      const fade = Math.exp(-age / (r.decay ?? life * 0.45)) * clamp(age / 0.06);
      const speed = r.speed ?? 1.2, lam = r.lambda ?? 0.35;
      const lamA = lam * (1 + 0.25 * age), wdt = 0.55 * lamA + 0.08 * speed * age;
      const front = speed * age;
      const lo = Math.max(0, front - 1.3 * lamA - 3 * wdt), hi = front + 3 * wdt;
      U.uRing.value[n].set(r.x, r.z, age, (r.amp ?? 0.01) * fade);
      U.uRingS.value[n].set(speed, lam, lo * lo, hi * hi);
      n++;
    }
    U.uRingN.value = n;
    U.uSpec.value.set(x.roughness ?? 0.035, x.glitter ?? 1.0, x.pointSpec ?? 1.0, x.distortion ?? 24.0);
    U.uMoonTmin.value = x.moonT ?? 0;
    // planar reflection
    if (reflOn && x.renderer && x.scene && camera && x.reflection !== false) {
      // once per frame: shutter sub-samples pass the same reflKey (+ the frame-centre camera) -> reuse the texture
      if (!x.reflKey || x.reflKey !== lastReflKey) {
        mesh.visible = false;
        renderReflection(x.renderer, x.scene, x.reflCam || camera);
        mesh.visible = true;
        lastReflKey = x.reflKey || null;
      }
      U.uReflOn.value = 1;
    } else { U.uReflOn.value = 0; lastReflKey = null; }
  }
  return {
    object: mesh, material: mat, uniforms: U, update, setRings, renderReflection, mirrorLayer: layer,
    get reflectionTarget() { return reflRT; },
    dispose() { geo.dispose(); mat.dispose(); rip.tex.dispose(); if (rainTex) rainTex.dispose(); if (reflRT) reflRT.dispose(); blackTex.dispose(); },
  };
}

/**
 * Rings from song notes (pure function of t): notes started in [t - life, t] of the given instruments.
 *   placement(note, i) -> {x, z, amp, speed, lambda, life}
 */
export function ringsFromNotes(audio, t, specs) {
  const out = [];
  for (const s of specs) {
    const life = s.life ?? 6;
    const notes = audio.notes(s.inst, t - life, t + 1e-6);
    let lastT = -1e9;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (s.merge !== false && n.t - lastT < 0.03) continue;   // chords -> one ring
      lastT = n.t;
      const p = s.place(n, i);
      if (p) out.push({ t0: n.t, life, ...p });
    }
  }
  out.sort((a, b) => b.t0 - a.t0);
  return out.slice(0, MAX_RINGS);
}
