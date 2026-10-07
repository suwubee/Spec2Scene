// Author: suwubee
// rock/material.js — procedural rock shader (MeshStandardMaterial patched with onBeforeCompile, BatchedMesh-aware).
// No image files: one tiny CPU-baked seeded tileable noise texture (256², 4 channels) sampled triplanar in
// instance-scaled object space; everything else (strata, pits, wrinkles, moss, lichen, wet line, stains) is analytic.
//   RK_KIND 0 = 黄石 (warm ochre / rust / grey, horizontal bedding, crisp seams)
//   RK_KIND 1 = 湖石 / 太湖石 (pale blue-grey, eroded pits and folds, dark algae streaks)
// Per-instance data comes from BatchedMesh.setColorAt: r = seed, g = moss bias, b = tint / age.
// Per-vertex data (uv attribute): x = baked ambient occlusion, y = height 0..1 of the piece.
import { hash21, hash22, GLSL_HASH } from '../../engine/noise.js';

// ------------------------------------------------------------------------------------------------ baked noise (tileable)
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
function vtile(x, y, per, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fade(fx), v = fade(fy);
  const w = (i) => ((i % per) + per) % per, S = seed * 131;
  const a = hash21(w(ix) + S, w(iy)), b = hash21(w(ix + 1) + S, w(iy)), c = hash21(w(ix) + S, w(iy + 1)), d = hash21(w(ix + 1) + S, w(iy + 1));
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
function fbmTile(u, v, per0, oct, seed) {
  let s = 0, a = 1, n = 0, per = per0;
  for (let o = 0; o < oct; o++) { s += a * vtile(u * per, v * per, per, seed + o * 7); n += a; per *= 2; a *= 0.5; }
  return s / n;
}
function worleyTile(u, v, N, seed) {
  const px = u * N, py = v * N, cx = Math.floor(px), cy = Math.floor(py);
  let d1 = 9;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const gx = cx + i, gy = cy + j, wx = ((gx % N) + N) % N, wy = ((gy % N) + N) % N;
    const h = hash22(wx + seed * 57, wy + seed * 13);
    const dx = gx + h[0] - px, dy = gy + h[1] - py, d = dx * dx + dy * dy;
    if (d < d1) d1 = d;
  }
  return Math.min(1, Math.sqrt(d1) / 0.85);
}
export function bakeRockNoise(THREE, size = 256) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size, v = (y + 0.5) / size, o = (y * size + x) * 4;
    const r = fbmTile(u, v, 3, 5, 1), g = fbmTile(u, v, 5, 5, 11), rb = fbmTile(u, v, 4, 4, 23);
    const ridge = 1 - Math.abs(rb * 2 - 1);                          // crease lines
    const b = Math.min(1, ridge * ridge * 1.15);
    const a = worleyTile(u, v, 10, 3) * 0.75 + 0.25 * worleyTile(u, v, 19, 5);
    const stretch = (t) => Math.max(0, Math.min(1, (t - 0.5) * 1.5 + 0.5));      // fbm sits around 0.5: widen the contrast
    data[o] = Math.round(255 * stretch(r)); data[o + 1] = Math.round(255 * stretch(g)); data[o + 2] = Math.round(255 * b); data[o + 3] = Math.round(255 * a);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true; tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace; tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------------------------------------ GLSL
const VERT_PARS = /* glsl */ `
varying vec3 vRkO;      // instance-scaled object-space position (metres, unrotated) — noise domain
varying vec3 vRkN;      // object-space normal
varying vec3 vRkW;      // world position
varying vec3 vRkI;      // per-instance data (seed, moss, tint)
varying float vRkA;     // baked AO
varying vec2 vRkL;      // (local x of the unit variant, height 0..1 of the piece)
`;
const VERT_MAIN = /* glsl */ `
  vRkN = normal; vRkA = uv.x; vRkL = vec2(position.x, uv.y);
  #ifdef USE_BATCHING
    vec3 rkS = vec3(length(batchingMatrix[0].xyz), length(batchingMatrix[1].xyz), length(batchingMatrix[2].xyz));
    vRkO = transformed * rkS;
    vRkW = (modelMatrix * batchingMatrix * vec4(transformed, 1.0)).xyz;
    #ifdef USE_BATCHING_COLOR
      vRkI = getBatchingColor(getIndirectIndex(gl_DrawID)).rgb;
    #else
      vRkI = vec3(0.5);
    #endif
  #else
    vRkO = transformed; vRkW = (modelMatrix * vec4(transformed, 1.0)).xyz; vRkI = vec3(0.5);
  #endif
`;
const FRAG_PARS = GLSL_HASH + /* glsl */ `
uniform sampler2D tRkNoise;
uniform float uRkWaterY;
uniform float uRkDetail;
varying vec3 vRkO; varying vec3 vRkN; varying vec3 vRkW; varying vec3 vRkI; varying float vRkA; varying vec2 vRkL;
vec4 rkTri(vec3 p, vec3 w, float s){
  return texture2D(tRkNoise, p.zy * s) * w.x + texture2D(tRkNoise, p.xz * s) * w.y + texture2D(tRkNoise, p.xy * s) * w.z;
}
float rkHash(float n){ return mvHash11(n*8192.0); }
vec3 rkPerturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir){
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  vec3 R1 = cross(sy, surfNorm), R2 = cross(surfNorm, sx);
  float det = dot(sx, R1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(det) * surfNorm - grad);
}
`;
const FRAG_MAIN = /* glsl */ `
  float rkSeed = vRkI.x, rkMossB = vRkI.y;
  float rkFlag = floor(vRkI.z * 0.5 + 0.001), rkTint = vRkI.z - 2.0 * rkFlag;      // flag 1 = revetment stone (dark joints), 2 = display piece (paler)
  vec3 rkP = vRkO + vec3(rkSeed * 91.7, rkSeed * 53.3, rkSeed * 27.1);
  vec3 rkNo = normalize(vRkN);
  vec3 rkWt = pow(abs(rkNo), vec3(4.0)); rkWt /= (rkWt.x + rkWt.y + rkWt.z);
  vec3 rkWN = inverseTransformDirection(normalize(vNormal), viewMatrix);
  float rkPx = max(length(dFdx(vRkW)), length(dFdy(vRkW)));                   // pixel footprint (m)
  float rkFine = (1.0 - smoothstep(0.006, 0.05, rkPx)) * uRkDetail;           // fine detail fades with distance
  vec4 c1 = rkTri(rkP, rkWt, 0.55);
  vec4 c2 = rkTri(rkP, rkWt, 1.7);
  vec4 c3 = rkTri(rkP, rkWt, 5.6);
  vec4 c4 = rkTri(rkP, rkWt, 17.0);
  float rkDy = vRkW.y - uRkWaterY;
  float rkAO = clamp(vRkA, 0.0, 1.0);
  float rkJoint = 0.0;
  if (rkFlag > 0.5 && rkFlag < 1.5) {                                          // wall stone: shadowed joints at its ends (next stone) and underside (course below)
    float ex = smoothstep(0.38, 0.5, abs(vRkL.x)), eb = 1.0 - smoothstep(0.0, 0.16, vRkL.y);
    rkJoint = clamp(ex * 0.9 + eb * 0.85, 0.0, 1.0);
    rkAO *= 1.0 - 0.72 * rkJoint;
  }
  float rkH = 0.0;
  vec3 col;
  float pitL = 0.0, pitS = 0.0, rkBaseRough;
  #if RK_KIND == 0
    rkBaseRough = 0.90;
    // ---- 黄石: horizontal bedding with seams, ochre / rust / grey
    float sy = rkP.y * 6.5 + (c1.g - 0.5) * 0.55 + (c2.r - 0.5) * 0.22;
    float bandId = floor(sy), bandF = fract(sy);
    float bandR = rkHash(bandId + rkSeed * 17.0);
    float seam = 1.0 - smoothstep(0.0, 0.13, bandF) * (1.0 - smoothstep(0.88, 1.0, bandF));
    vec3 ochre = vec3(0.285, 0.205, 0.104), rust = vec3(0.232, 0.138, 0.068), grey = vec3(0.212, 0.194, 0.164);
    col = mix(ochre, rust, smoothstep(0.40, 0.85, c1.r * 0.7 + (bandR - 0.5) * 0.5 + (rkTint - 0.5) * 0.4));
    col = mix(col, grey, smoothstep(0.30, 0.78, c2.g * 0.65 + c1.b * 0.35 - 0.12 + (0.5 - rkTint) * 0.35));
    col *= 0.80 + 0.40 * bandR * 0.7 + 0.12 * (c3.r - 0.5);
    col *= 1.0 - 0.16 * seam * (0.4 + 0.6 * c2.b);
    col *= 1.0 - 0.18 * smoothstep(0.62, 0.9, c1.b) * (0.5 + 0.5 * c3.g);          // fracture lines
    rkH = 0.028 * (c1.g - 0.5) + 0.014 * (c2.r - 0.5) + rkFine * (0.006 * (c3.g - 0.5) + 0.0028 * (c4.b - 0.5)) - 0.010 * seam;
    float lich = smoothstep(0.64, 0.74, c2.b * 0.55 + c3.a * 0.55 - 0.18);
    col = mix(col, vec3(0.46, 0.46, 0.33), lich * 0.42);
  #else
    rkBaseRough = 0.80;
    // ---- 湖石: pale blue-grey limestone, pits (透/漏), folds (皱), dirty streaks
    vec3 pale = vec3(0.292, 0.268, 0.236), cool = vec3(0.218, 0.226, 0.232), warm = vec3(0.330, 0.286, 0.224);
    float m = c1.r * 0.55 + c2.g * 0.45;
    col = mix(cool, pale, smoothstep(0.28, 0.72, m + (rkTint - 0.5) * 0.3));
    col = mix(col, warm, smoothstep(0.55, 0.88, c1.g) * 0.42);
    pitL = (1.0 - smoothstep(0.08, 0.30, c1.a)) * smoothstep(0.30, 0.68, c2.g);   // big hollows (窝), sparse: about 20 cm across
    pitS = (1.0 - smoothstep(0.12, 0.34, c3.a)) * rkFine * 0.5;                 // pores
    float fold = smoothstep(0.55, 0.95, c1.b) * 0.7 + smoothstep(0.6, 0.95, c2.b) * 0.5;
    col *= 1.0 - 0.34 * pitL - 0.07 * pitS - 0.10 * fold;
    vec2 sp = vec2(rkP.x * 0.6 + rkP.z * 0.5, rkP.y * 0.13) * vec2(3.2, 1.0);
    float streak = texture2D(tRkNoise, sp).g;
    col *= 1.0 - 0.24 * smoothstep(0.52, 0.82, streak) * (1.0 - abs(rkWN.y)) * (0.6 + 0.4 * c1.r);
    rkH = -0.045 * pitL - 0.006 * pitS + 0.020 * (c1.g - 0.5) + 0.016 * (c2.r - 0.5) + 0.014 * fold + rkFine * (0.006 * (c3.b - 0.5) + 0.0025 * (c4.g - 0.5));
    rkAO *= 1.0 - 0.32 * pitL;
    if (rkFlag > 1.5) col *= 1.22;                                              // display pieces (缀云峰, 立峰) are paler than bank stones
  #endif
  // ---- waterline: dark, glossy wet band soaked ≈ 0.12–0.26 m above the surface, faint damp halo, algae line at the surface, silt below it
  float jag = (c1.g - 0.5) * 0.07 + (c2.b - 0.5) * 0.035 + (c3.r - 0.5) * 0.02;
  float wet = 1.0 - smoothstep(0.12 + jag, 0.26 + jag, rkDy);
  float damp = (1.0 - smoothstep(0.20 + jag, 0.65 + jag, rkDy)) * (1.0 - wet);
  float line = smoothstep(-0.10, -0.01, rkDy - jag) * (1.0 - smoothstep(0.03, 0.14, rkDy - jag));
  float under = 1.0 - smoothstep(-0.30, -0.02, rkDy);
  col = mix(col, col * vec3(0.36, 0.34, 0.30), wet * 0.90);
  rkH *= mix(1.0, 0.45, wet);
  col *= 1.0 - 0.14 * damp;
  col = mix(col, vec3(0.040, 0.062, 0.022) * (0.7 + 0.6 * c3.g), line * 0.55 * (0.4 + 0.6 * c2.r));
  col = mix(col, vec3(0.045, 0.060, 0.034), under * 0.55);
  // ---- moss in crevices, on top faces and near the water; always some on the damp lower part
  float up = clamp(rkWN.y, 0.0, 1.0), crev = 1.0 - rkAO, hum = 1.0 - smoothstep(0.10, 1.2, rkDy);
  float mn = c1.b * 0.35 + c2.r * 0.35 + c3.g * 0.30;
  float ms = mn + 0.38 * up + 0.85 * crev + 0.22 * hum + 0.80 * (rkMossB - 0.5) - 1.26 + (c4.r - 0.5) * 0.2 * rkFine;
  float mossM = smoothstep(0.0, 0.20, ms);
  vec3 mossC = mix(vec3(0.040, 0.078, 0.020), vec3(0.115, 0.165, 0.042), c3.b) * (0.75 + 0.5 * c4.r);
  col = mix(col, mossC, mossM);
  rkH += mossM * rkFine * 0.010 * (c4.g - 0.3);
  col *= (0.9 + 0.1 * rkAO) * (1.0 - 0.5 * rkJoint);
  #if RK_KIND == 1
    col = mix(col, vec3(0.185, 0.222, 0.272), clamp((1.0 - rkAO) * 0.42, 0.0, 0.5));   // blue-grey shadows (sky-lit cavities)
  #endif
  diffuseColor = vec4(col, 1.0);
  float rkRough = mix(rkBaseRough, 0.97, mossM);
  rkRough = mix(rkRough, 0.26, wet * 0.92 * (1.0 - mossM));
  rkAO = mix(rkAO, rkAO * 0.8, mossM);
`;

function patch(shader, U) {
  Object.assign(shader.uniforms, U);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_MAIN}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
    .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_MAIN}`)
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rkRough;')
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n  normal = rkPerturb(-vViewPosition, normal, vec2(dFdx(rkH), dFdy(rkH)), faceDirection);`)
    .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n  reflectedLight.indirectDiffuse *= rkAO;\n  reflectedLight.indirectSpecular *= mix(1.0, rkAO, 0.8);\n  reflectedLight.directDiffuse *= mix(1.0, rkAO, 0.45);`);
}

/** kind: 0 = 黄石, 1 = 湖石. opts: { waterY, detail } */
export function makeRockMaterial(THREE, noiseTex, kind, opts = {}) {
  const U = { tRkNoise: { value: noiseTex }, uRkWaterY: { value: opts.waterY ?? -0.55 }, uRkDetail: { value: opts.detail ?? 1.0 } };
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  m.name = kind === 0 ? 'rock-huangshi' : 'rock-hushi';
  m.defines = { RK_KIND: kind };
  m.onBeforeCompile = (sh) => patch(sh, U);
  m.customProgramCacheKey = () => `garden-rock-v1-${kind}`;
  m.userData.uniforms = U;
  return m;
}
