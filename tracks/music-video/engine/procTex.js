// Author: suwubee
// engine/procTex.js — deterministic procedural PBR texture baker (GPU bake passes -> cached DataTextures).
//
//   import { bake, bakeDetail, bakeVariation, TILE_GLSL } from '/src/engine/procTex.js';
//   const wood = bake(renderer, 'wood', { variant: 'hardwood', quality: 'final', seed: 3 });
//   // -> { map, normalMap, ormMap, roughnessMap, aoMap, metalnessMap, size, worldSize, heightRange, meanAlbedo, ms, key }
//
// Every texture is TILEABLE (periodic noise lattices), mip-mapped, anisotropically filtered and baked ONCE at startup
// (results are cached per renderer by (name, options)). Nothing here runs per frame.
//
// Pipeline per bake (all on the GPU, tiled into small draws so SwiftShader never runs one huge draw):
//   1. surface pass  (RGBA32F MRT x3): material GLSL `surface(uv, s)` -> albedo(linear), alpha, height(mm), roughness,
//                                      ao, metal/mask, aux (porosity or thickness)
//   2. pack pass     (RGBA8 MRT x3):   albedo -> sRGB, Sobel normal from the mm height field (physically scaled by the
//                                      texture's real size), horizon AO from the height field, ORM packing

//                                      physically plausible luminance of the exposure convention) -> DataTextures.
//
// Texture conventions
//   map         sRGB  RGB = albedo, A = opacity (gauze)            colorSpace = SRGBColorSpace
//   normalMap   lin   RGB = tangent-space normal (OpenGL, +Y = +v), A = height normalised to def.heightRange
//   ormMap      lin   R = AO, G = roughness, B = metalness (metal defs) or secondary mask (moss/dirt/crack),
//                     A = aux: porosity (wet darkening) or thickness (translucency) — see DEFS[name].aux
// UV convention: u,v in METRES (geo.js emits metric UVs); one texture tile covers `worldSize` metres.
// Detail maps (bakeDetail): RG = micro normal xy, B = albedo modulation (0.5 neutral), A = roughness modulation.
import * as THREE from './vendor/three.module.js';
import { GLSL_HASH, hashString } from './noise.js';

// ------------------------------------------------------------------------------------------------
// Colour helpers
// ------------------------------------------------------------------------------------------------
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
export function hexLin(hex) {
  const v = parseInt(String(hex).replace('#', ''), 16);
  return [s2l(((v >> 16) & 255) / 255), s2l(((v >> 8) & 255) / 255), s2l((v & 255) / 255)];
}
const lumOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const DECODE = new Float32Array(256).map((_, i) => s2l(i / 255));
const ENC_N = 8192;
const ENCODE = new Uint8Array(ENC_N + 1).map((_, i) => Math.round(Math.min(1, l2s(i / ENC_N)) * 255));
const enc = (x) => ENCODE[Math.max(0, Math.min(ENC_N, Math.round(x * ENC_N)))];

// ------------------------------------------------------------------------------------------------
// GLSL: tileable noise library (exported: other agents may reuse it for their own bakes).
// Every function takes a lattice-space point p and an integer period P (lattice cells per tile) and is exactly periodic.
// Seeds are small non-negative integers (floats).
// ------------------------------------------------------------------------------------------------
export const TILE_GLSL = GLSL_HASH + /* glsl */ `
#ifndef MV_TILE_GLSL
#define MV_TILE_GLSL
#define PI 3.14159265359
#define TAU 6.28318530718
float sat(float x) { return clamp(x, 0.0, 1.0); }
float lumi(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
ivec2 tWrap(ivec2 c, ivec2 P) { return c - P * ivec2(floor((vec2(c) + 0.5) / vec2(P))); }
uvec3 tHashU(ivec2 c, ivec2 P, float s) { ivec2 m = tWrap(c, P); return mvPcg3d(uvec3(uint(m.x), uint(m.y), uint(int(s + 0.5)))); }
float tH1(ivec2 c, ivec2 P, float s) { return float(tHashU(c, P, s).x) * MV_U2F; }
vec2  tH2(ivec2 c, ivec2 P, float s) { return vec2(tHashU(c, P, s).xy) * MV_U2F; }
vec3  tH3(ivec2 c, ivec2 P, float s) { return vec3(tHashU(c, P, s)) * MV_U2F; }
vec4  tH4(ivec2 c, ivec2 P, float s) { uvec3 h = tHashU(c, P, s); return vec4(vec3(h) * MV_U2F, float(mvPcg(h.x ^ (h.y * 747796405u) ^ h.z)) * MV_U2F); }
float hPair(float a, float b, float s) { return float(mvPcg3d(uvec3(uint(int(a * 65536.0)), uint(int(b * 65536.0)), uint(int(s + 0.5)))).x) * MV_U2F; }
// periodic gradient noise ~[-1,1]
float tNoise(vec2 p, vec2 P, float s) {
  vec2 i = floor(p); vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  ivec2 c = ivec2(i); ivec2 iP = ivec2(P + 0.5);
  float a0 = tH1(c, iP, s) * TAU, a1 = tH1(c + ivec2(1, 0), iP, s) * TAU;
  float a2 = tH1(c + ivec2(0, 1), iP, s) * TAU, a3 = tH1(c + ivec2(1, 1), iP, s) * TAU;
  float va = dot(vec2(cos(a0), sin(a0)), f);
  float vb = dot(vec2(cos(a1), sin(a1)), f - vec2(1.0, 0.0));
  float vc = dot(vec2(cos(a2), sin(a2)), f - vec2(0.0, 1.0));
  float vd = dot(vec2(cos(a3), sin(a3)), f - vec2(1.0, 1.0));
  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y) * 1.4142;
}
// periodic value noise [0,1]
float tValue(vec2 p, vec2 P, float s) {
  vec2 i = floor(p); vec2 f = p - i; vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i); ivec2 iP = ivec2(P + 0.5);
  return mix(mix(tH1(c, iP, s), tH1(c + ivec2(1, 0), iP, s), u.x), mix(tH1(c + ivec2(0, 1), iP, s), tH1(c + ivec2(1, 1), iP, s), u.x), u.y);
}
// periodic 1D gradient noise ~[-1,1]
float tNoise1(float x, float P, float s) {
  float i = floor(x); float f = x - i; float u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  int c = int(i); int iP = int(P + 0.5);
  float ga = tH1(ivec2(c, 0), ivec2(iP, 1), s) * 2.0 - 1.0;
  float gb = tH1(ivec2(c + 1, 0), ivec2(iP, 1), s) * 2.0 - 1.0;
  return mix(ga * f, gb * (f - 1.0), u) * 2.0;
}
// periodic fbm (lacunarity exactly 2 keeps every octave periodic), normalised ~[-1,1] (std ~0.35)
float tFbm(vec2 p, vec2 P, int oct, float gain, float s) {
  float sum = 0.0, amp = 1.0, nrm = 0.0;
  for (int o = 0; o < 10; o++) {
    if (o >= oct) break;
    sum += amp * tNoise(p, P, s + float(o) * 7.0);
    nrm += amp; amp *= gain; p = p * 2.0 + vec2(19.1, 7.3); P *= 2.0;
  }
  return sum / nrm;
}
float tFbm1(float x, float P, int oct, float gain, float s) {
  float sum = 0.0, amp = 1.0, nrm = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= oct) break;
    sum += amp * tNoise1(x, P, s + float(o) * 7.0);
    nrm += amp; amp *= gain; x = x * 2.0 + 3.7; P *= 2.0;
  }
  return sum / nrm;
}
// periodic ridged fbm [0,1]
float tRidged(vec2 p, vec2 P, int oct, float gain, float s) {
  float sum = 0.0, amp = 1.0, nrm = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= oct) break;
    float n = 1.0 - abs(tNoise(p, P, s + float(o) * 7.0));
    sum += amp * n * n; nrm += amp; amp *= gain; p = p * 2.0 + vec2(19.1, 7.3); P *= 2.0;
  }
  return sum / nrm;
}
// periodic Voronoi with exact border distance (Quilez) + neighbour id + border normal (lattice units)
struct Vor { float f1; float f2; float border; float id; float id2; vec2 toCenter; vec2 bnormal; };
Vor tVoronoi(vec2 p, vec2 P, float jit, float s) {
  vec2 n = floor(p); vec2 f = p - n; ivec2 iP = ivec2(P + 0.5);
  Vor v; v.f1 = 8.0; v.f2 = 8.0;
  vec2 mg = vec2(0.0), mr = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    ivec2 c = ivec2(n + g);
    vec2 o = 0.5 + jit * (tH2(c, iP, s) - 0.5);
    vec2 r = g + o - f; float d = dot(r, r);
    if (d < v.f1) { v.f2 = v.f1; v.f1 = d; mr = r; mg = g; } else if (d < v.f2) { v.f2 = d; }
  }
  v.id = tH1(ivec2(n + mg), iP, s + 101.0);
  v.toCenter = mr;
  float bd = 8.0; vec2 bn = vec2(0.0, 1.0); float id2 = v.id;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    ivec2 c = ivec2(n + g);
    vec2 o = 0.5 + jit * (tH2(c, iP, s) - 0.5);
    vec2 r = g + o - f; vec2 dr = r - mr;
    if (dot(dr, dr) > 1e-6) {
      float d = dot(0.5 * (mr + r), normalize(dr));
      if (d < bd) { bd = d; bn = normalize(dr); id2 = tH1(c, iP, s + 101.0); }
    }
  }
  v.border = bd; v.bnormal = bn; v.id2 = id2;
  v.f1 = sqrt(v.f1); v.f2 = sqrt(v.f2);
  return v;
}
#endif
`;

// Shared surface helpers (weave, fibres, scratches) used by several definitions.
const SURF_HELPERS = /* glsl */ `
// ---- plain weave (linen, gauze): height(mm), coverage, per-thread shade, which thread (0 warp,1 weft), slub ----
struct Weave { float h; float cover; float shade; float dir; float slub; float along; };
float weaveThread(float g, float gAlong, float idx, float N, float halfW, float slubAmt, float irr, float sd, out float slub, out float shade) {
  int ii = int(mod(idx, N));
  float jit = (tH1(ivec2(ii, 0), ivec2(int(N), 1), sd) - 0.5) * irr;
  float wander = tFbm(vec2(gAlong / N * 6.0, float(ii) * 0.73), vec2(6.0, 4096.0), 2, 0.5, sd + 1.0) * irr * 0.8;
  float sl = tNoise(vec2(gAlong / N * 5.0, float(ii) * 1.37), vec2(5.0, 4096.0), sd + 2.0);
  slub = smoothstep(0.25, 0.75, sl) * slubAmt;
  shade = tH1(ivec2(ii, 3), ivec2(int(N), 4), sd + 3.0);
  float hw = halfW * (1.0 + 0.6 * slub - 0.12 * smoothstep(0.1, -0.6, sl) * slubAmt);
  float c = idx + 0.5 + jit + wander;
  return (g - c) / hw;   // normalised cross-section coordinate (|x|<1 inside the thread)
}
Weave weave(vec2 uv, float N, float halfW, float und, float thick, float slubAmt, float irr, float sd) {
  vec2 g = uv * N;
  Weave W; W.h = -thick * 1.3; W.cover = 0.0; W.shade = 0.5; W.dir = 0.0; W.slub = 0.0; W.along = 0.0;
  float best = -1e3;
  for (int k = -1; k <= 1; k++) {
    // warp thread (runs along v)
    float ix = floor(g.x) + float(k);
    float sl, sh;
    float x = weaveThread(g.x, g.y, ix, N, halfW, slubAmt, irr, sd, sl, sh);
    if (abs(x) < 1.0) {
      float par = mod(ix, 2.0) < 0.5 ? 1.0 : -1.0;
      float top = und * sin(PI * g.y) * par + thick * sqrt(1.0 - x * x) * (1.0 + 0.5 * sl);
      if (top > best) { best = top; W.h = top; W.cover = 1.0; W.shade = sh; W.dir = 0.0; W.slub = sl; W.along = g.y; }
    }
    // weft thread (runs along u)
    float iy = floor(g.y) + float(k);
    float y = weaveThread(g.y, g.x, iy, N, halfW, slubAmt, irr, sd + 20.0, sl, sh);
    if (abs(y) < 1.0) {
      float par = mod(iy, 2.0) < 0.5 ? 1.0 : -1.0;
      float top = -und * sin(PI * g.x) * par + thick * sqrt(1.0 - y * y) * (1.0 + 0.5 * sl);
      if (top > best) { best = top; W.h = top; W.cover = 1.0; W.shade = sh; W.dir = 1.0; W.slub = sl; W.along = g.x; }
    }
  }
  return W;
}
// ---- random curved fibres (paper): max coverage of fibres around p. cellsN = cells per tile (integer) ----
float fibreField(vec2 uv, vec2 Wmm, vec2 cellsN, float density, float lenMM, float widMM, float curl, float sd) {
  vec2 p = uv * cellsN; vec2 n = floor(p);
  vec2 cellMM = Wmm / cellsN;
  vec2 pm = p * cellMM;
  float acc = 0.0;
  float aa = 0.6 * length(Wmm / uRes);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    ivec2 c = ivec2(n) + ivec2(i, j);
    for (int k = 0; k < 3; k++) {
      vec4 h = tH4(c, ivec2(cellsN + 0.5), sd + float(k) * 5.0);
      if (h.w > density / 3.0) continue;
      vec2 ctr = (vec2(c) + h.xy) * cellMM;
      float ang = h.z * TAU; vec2 dir = vec2(cos(ang), sin(ang));
      float L = lenMM * (0.45 + 1.1 * fract(h.x * 13.7 + h.y * 3.1));
      vec2 d = pm - ctr;
      float al = dot(d, dir); float ac = dot(d, vec2(-dir.y, dir.x));
      ac -= (fract(h.y * 7.1 + h.z) - 0.5) * curl * al * al / max(L, 1e-3);
      float t = al / (0.5 * L);
      float wd = widMM * (0.6 + 0.8 * fract(h.w * 91.3)) * (1.0 - 0.4 * t * t);
      float line = (1.0 - smoothstep(0.5 * wd, 0.5 * wd + aa, abs(ac))) * (1.0 - smoothstep(0.9, 1.0, abs(t)));
      acc = max(acc, line * (0.55 + 0.45 * fract(h.z * 31.0)));
    }
  }
  return acc;
}
// ---- sparse straight scratches: returns intensity [0,1]; widMM scratch width ----
float scratchField(vec2 uv, vec2 Wmm, vec2 cellsN, float density, float lenMM, float widMM, float dirBias, float sd) {
  vec2 p = uv * cellsN; vec2 n = floor(p);
  vec2 cellMM = Wmm / cellsN; vec2 pm = p * cellMM;
  float acc = 0.0;
  float aa = 0.6 * length(Wmm / uRes);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    ivec2 c = ivec2(n) + ivec2(i, j);
    vec4 h = tH4(c, ivec2(cellsN + 0.5), sd);
    if (h.w > density) continue;
    vec2 ctr = (vec2(c) + h.xy) * cellMM;
    float ang = mix(h.z * PI, PI * 0.5 + (h.z - 0.5) * 0.6, dirBias);
    vec2 dir = vec2(cos(ang), sin(ang));
    float L = lenMM * (0.3 + 1.2 * fract(h.x * 7.3));
    vec2 d = pm - ctr;
    float al = dot(d, dir); float ac = abs(dot(d, vec2(-dir.y, dir.x)));
    float t = abs(al) / (0.5 * L);
    float wd = widMM * (1.0 - 0.7 * t * t);
    acc = max(acc, (1.0 - smoothstep(0.5 * wd, 0.5 * wd + aa, ac)) * (1.0 - smoothstep(0.8, 1.0, t)) * (0.4 + 0.6 * fract(h.y * 17.0)));
  }
  return acc;
}
`;

// ------------------------------------------------------------------------------------------------
// Material definitions. Each: worldSize [u,v] metres; heightRange [lo,hi] mm (for normal.a); ao {radius mm, strength};
// params (floats -> uniform p_<name>), colors (hex -> uniform vec3 c_<name>, linear); variants override both;
// calibrate {color, lum} = target mean albedo; aux = meaning of ormMap.a; metal = ORM.b is metalness.
// glsl: void surface(vec2 uv, inout Surf s)  — uv in [0,1)^2 over one tile; uWorld (m), uRes (px), uSeed available.
// ------------------------------------------------------------------------------------------------
export const DEFS = {
  // ================================================================ WOOD
  wood: {
    worldSize: [0.30, 0.90], heightRange: [-0.6, 0.6], ao: { radius: 1.2, strength: 0.7 }, aux: 'porosity',
    params: { ringWidth: 3.2, taper: 18.0, ringContrast: 0.8, latewood: 0.45, figure: 20.0, waviness: 1.6, ringPorous: 0.8, poreSize: 0.35,
      poreLen: 4.0, poreDensity: 0.55, poreDark: 0.55, fibre: 0.8, streaks: 0.35, blotch: 0.7, planeMarks: 0.6, relief: 0.05,
      scratches: 0.25, stains: 0.0, weather: 0.0, checks: 0.0, rough: 0.52, roughVar: 0.12, polish: 0.4 },
    colors: { early: '#4a3526', late: '#2c1d13', streak: '#21150e', pore: '#1a110b', grey: '#6f675d' },
    variants: {
      hardwood: { calibrate: { color: '#3b2a1e', lum: 0.050 } },
      weathered: { params: { weather: 0.75, relief: 0.35, checks: 0.6, polish: 0.0, rough: 0.72, scratches: 0.1, planeMarks: 0.2, figure: 12.0 },
        calibrate: { color: '#4a4038', lum: 0.075 } },
      paulownia: { params: { ringWidth: 7.5, taper: 6.0, ringContrast: 0.6, latewood: 0.35, figure: 5.0, waviness: 0.8, ringPorous: 1.0, poreSize: 0.45,
        poreLen: 5.0, poreDensity: 0.7, poreDark: 0.45, streaks: 0.15, blotch: 0.5, planeMarks: 0.3, relief: 0.06, scratches: 0.08,
        rough: 0.48, polish: 0.5 },
        colors: { early: '#8a6848', late: '#6a4a30', streak: '#5b3f28', pore: '#3e2a1a' },
        calibrate: { color: '#7b5a3c', lum: 0.118 } },
      rosewood: { params: { ringWidth: 1.4, taper: 30.0, ringContrast: 0.5, latewood: 0.5, figure: 28.0, waviness: 2.0, ringPorous: 0.0, poreSize: 0.16,
        poreLen: 4.0, poreDensity: 0.22, poreDark: 0.45, streaks: 0.85, blotch: 0.6, planeMarks: 0.15, relief: 0.02, scratches: 0.12,
        rough: 0.36, roughVar: 0.08, polish: 0.7 },
        colors: { early: '#5a2c1c', late: '#3e1a10', streak: '#1b0c08', pore: '#140806' },
        calibrate: { color: '#4a2418', lum: 0.040 } },
    },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  // ring phase = straight rings across (Nr, multiple of Tv) + taper along the grain (Tv) + cathedral sinusoid + warps.
  // Integer Nr/Tv and periodic warps keep the texture exactly tileable.
  float Tv = max(1.0, floor(p_taper + 0.5));
  float Nr = max(Tv, floor(Wmm.x / p_ringWidth / Tv + 0.5) * Tv);
  float mA = tFbm(vec2(uv.y * 2.0, 0.5), vec2(2.0, 1.0), 3, 0.5, sd + 1.0);
  float mB = tFbm(vec2(uv.y * 3.0, 3.5), vec2(3.0, 4.0), 3, 0.5, sd + 2.0);
  float wB = tFbm(uv * vec2(2.0, 3.0), vec2(2.0, 3.0), 4, 0.5, sd + 3.0);
  float wC = tFbm(uv * vec2(6.0, 2.0), vec2(6.0, 2.0), 4, 0.55, sd + 4.0);
  float cath = p_figure * (0.7 + 0.6 * mA) * sin(TAU * (uv.x + 0.18 * mB) + uSeed * 1.7);
  float phase = Nr * uv.x + Tv * uv.y + cath + p_waviness * (1.3 * wB + 0.5 * wC);
  // year-to-year ring width irregularity (1D noise of the phase, period Tv rings)
  float Mr = max(1.0, floor(Tv / 4.0 + 0.5));
  phase += 1.2 * tFbm1(phase / Tv * Mr, Mr, 3, 0.5, sd + 5.0);
  float ringId = floor(phase); float rp = phase - ringId;
  float rm = mod(ringId, Tv);
  float rh = tH1(ivec2(int(rm), 0), ivec2(int(Tv), 1), sd + 6.0);
  float rh2 = tH1(ivec2(int(rm), 1), ivec2(int(Tv), 2), sd + 7.0);
  float lateStart = 1.0 - p_latewood * mix(0.6, 1.35, rh);
  float late = smoothstep(lateStart - 0.16, lateStart + 0.06, rp) * (1.0 - smoothstep(0.955, 1.0, rp));
  late *= mix(0.35, 1.2, rh2 * rh2);
  // pores: ring-porous woods concentrate them in the earlywood band
  float poreZone = mix(1.0, 1.0 - smoothstep(0.05, 0.3, rp), p_ringPorous);
  float Npx = max(1.0, floor(Wmm.x / (p_poreSize * 2.4) + 0.5));
  float Npy = max(1.0, floor(Wmm.y / (p_poreSize * 2.4 * p_poreLen) + 0.5));
  Vor pv = tVoronoi(uv * vec2(Npx, Npy) + vec2(wC * 2.0, 0.0), vec2(Npx, Npy), 0.85, sd + 8.0);
  float pr = 0.3 * mix(0.55, 1.25, fract(pv.id * 17.13));
  float pore = (1.0 - smoothstep(pr * 0.5, pr, pv.f1)) * step(pv.id, p_poreDensity * poreZone);
  float Nf = max(1.0, floor(Wmm.x / 0.7 + 0.5)), Nfy = max(1.0, floor(Wmm.y / 35.0 + 0.5));
  float fib = tFbm(uv * vec2(Nf, Nfy) + vec2(wC * 3.0, 0.0), vec2(Nf, Nfy), 3, 0.5, sd + 9.0);
  float stq = tFbm(uv * vec2(9.0, 1.0) + vec2(wB * 0.5, 0.0), vec2(9.0, 1.0), 5, 0.55, sd + 10.0);
  float streak = smoothstep(0.12, 0.55, stq) * p_streaks;
  float blotch = tFbm(uv * vec2(3.0, 2.0), vec2(3.0, 2.0), 4, 0.5, sd + 11.0);
  float Npm = max(1.0, floor(Wmm.y / 26.0 + 0.5));
  float pmk = sin(TAU * (uv.y * Npm + 0.25 * tFbm(uv * vec2(4.0, 2.0), vec2(4.0, 2.0), 2, 0.5, sd + 12.0)));
  float scr = scratchField(uv, Wmm, floor(Wmm / 40.0 + 0.5), p_scratches, 30.0, 0.3, 0.0, sd + 13.0);
  float ckN = floor(Wmm.x / 9.0 + 0.5);
  float ck = tNoise(uv * vec2(ckN, 3.0) + vec2(wB, 0.0), vec2(ckN, 3.0), sd + 14.0);
  float ckMask = smoothstep(0.35, 0.6, tFbm(uv * vec2(4.0, 3.0), vec2(4.0, 3.0), 3, 0.5, sd + 15.0) + 0.25);
  float check = (1.0 - smoothstep(0.0, 0.03, abs(ck))) * ckMask * p_checks;
  float stain = 0.0;
  if (p_stains > 0.0) {
    vec2 cst = tH2(ivec2(3, 5), ivec2(64), sd + 16.0);
    vec2 dv = uv - cst; dv -= floor(dv + 0.5);
    float dmm = length(dv * Wmm);
    float R = 34.0 + 6.0 * tH1(ivec2(7, 1), ivec2(64), sd + 17.0);
    stain = p_stains * (0.8 * exp(-pow((dmm - R) / 1.2, 2.0)) + 0.25 * (1.0 - smoothstep(R - 3.0, R, dmm))) * (0.6 + 0.4 * tNoise(uv * 20.0, vec2(20.0), sd + 18.0));
  }
  vec3 col = mix(c_early, c_late, sat(late * p_ringContrast));
  col *= 1.0 + p_fibre * 0.16 * fib;
  col *= 1.0 + p_blotch * 0.28 * blotch;
  col = mix(col, c_streak, streak * 0.6);
  col = mix(col, c_pore, pore * p_poreDark);
  float wg = p_weather * (0.65 + 0.35 * sat(0.5 + wB));
  col = mix(col, c_grey * (0.75 + 0.5 * late), wg);
  col = mix(col, col * 1.6 + 0.006, scr * 0.5);
  col *= 1.0 - 0.3 * stain;
  col *= 1.0 - 0.6 * check;
  float pol = smoothstep(-0.2, 0.4, tFbm(uv * vec2(2.0, 1.0), vec2(2.0, 1.0), 3, 0.5, sd + 19.0)) * p_polish;
  float h = p_relief * (late - 0.4) - 0.05 * pore + 0.012 * fib + p_planeMarks * 0.018 * pmk - 0.03 * scr - 0.5 * check;
  h += 0.05 * tFbm(uv * vec2(6.0, 3.0), vec2(6.0, 3.0), 3, 0.5, sd + 20.0);
  s.albedo = max(col, vec3(0.0));
  s.height = h;
  s.rough = sat(p_rough + p_roughVar * (0.5 * blotch + 0.3 * fib) - 0.06 * late + 0.22 * pore + 0.15 * scr - 0.18 * pol + 0.2 * wg + 0.3 * check);
  s.aux = sat(0.3 + 0.55 * (1.0 - late) + 0.3 * pore + 0.3 * wg);
  s.mask = sat(streak + check);
}`,
  },

  // ================================================================ LACQUER (guqin 断纹)
  lacquer: {
    worldSize: [0.15, 0.30], size: 2048, heightRange: [-0.05, 0.05], ao: { radius: 0.5, strength: 0.5 }, aux: 'porosity',
    params: { spacing: 18.0, cellAspect: 6.0, jitter: 0.6, crackWidth: 0.1, crackDepth: 0.035, longit: 0.1, dome: 0.018, tilt: 0.005,
      fine: 0.18, fineX: 4.0, fineY: 120.0, wear: 0.6, rough: 0.16, roughVar: 0.08, dust: 0.12, second: 0.12 },
    colors: { base: '#2a1712', worn: '#4a2a1c', crack: '#3a2a21' },
    variants: { guqin: {} },
    calibrate: { color: '#2a1712', lum: 0.013 },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0; vec2 tmm = Wmm / uRes; float aa = 0.7 * length(tmm);
  // 蛇腹断: rows of wide cells across the qin (v = along the qin) -> mostly transverse cracks, short longitudinal links
  float Ny = max(1.0, floor(Wmm.y / p_spacing + 0.5));
  float Nx = max(1.0, floor(Wmm.x / (p_spacing * p_cellAspect) + 0.5));
  vec2 N = vec2(Nx, Ny);
  vec2 w = vec2(tFbm(uv * vec2(2.0, 4.0), vec2(2.0, 4.0), 3, 0.5, sd + 1.0), tFbm(uv * vec2(2.0, 4.0) + 3.7, vec2(2.0, 4.0), 3, 0.5, sd + 2.0));
  vec2 w2 = vec2(tFbm(uv * vec2(6.0, 24.0), vec2(6.0, 24.0), 3, 0.5, sd + 3.0), tFbm(uv * vec2(6.0, 24.0) + 1.3, vec2(6.0, 24.0), 3, 0.5, sd + 4.0));
  vec2 q = uv * N + w * vec2(0.2, 0.14) + w2 * vec2(0.02, 0.035);
  Vor v = tVoronoi(q, N, p_jitter, sd + 5.0);
  vec2 cellMM = Wmm / N;
  vec2 gB = v.bnormal / cellMM;
  float dMM = v.border / max(length(gB), 1e-5);
  float trans = abs(normalize(gB).y);
  float ph = hPair(min(v.id, v.id2), max(v.id, v.id2), sd + 9.0);
  float ph2 = hPair(max(v.id, v.id2), min(v.id, v.id2), sd + 10.0);
  float present = step(ph, mix(p_longit, 0.95, smoothstep(0.3, 0.85, trans)));
  float wmm = p_crackWidth * mix(0.5, 1.5, ph2);
  float crack = (1.0 - smoothstep(wmm * 0.5, wmm * 0.5 + aa, dMM)) * present;
  float lip = present * (1.0 - smoothstep(wmm * 0.5, wmm * 0.5 + 0.35, dMM));
  // secondary short cracks splitting some cells
  vec2 N2 = vec2(Nx * 2.0, Ny * 2.0);
  Vor v2 = tVoronoi(uv * N2 + w * vec2(0.4, 0.4) + w2 * 0.1, N2, 0.8, sd + 11.0);
  vec2 gB2 = v2.bnormal / (Wmm / N2);
  float d2 = v2.border / max(length(gB2), 1e-5);
  float pr2 = step(hPair(min(v2.id, v2.id2), max(v2.id, v2.id2), sd + 12.0), p_second * smoothstep(0.5, 0.9, abs(normalize(gB2).y)));
  float crack2 = (1.0 - smoothstep(wmm * 0.3, wmm * 0.3 + aa, d2)) * pr2 * 0.7;
  // 牛毛断 hair cracks: zero crossings of very anisotropic noise (fine, patchy)
  float fn = tNoise(uv * vec2(p_fineX, p_fineY) + w * 2.0, vec2(p_fineX, p_fineY), sd + 6.0);
  float fmask = smoothstep(0.1, 0.5, tFbm(uv * vec2(3.0, 5.0), vec2(3.0, 5.0), 3, 0.5, sd + 7.0) + 0.1);
  float fine = (1.0 - smoothstep(0.0, 0.02 + fwidth(fn), abs(fn))) * fmask * p_fine;
  // each crack-bounded "scale" is slightly domed and tilted -> its reflection breaks up at the cracks (the look of 断纹)
  vec2 tilt = (vec2(fract(v.id * 13.1), fract(v.id * 71.7)) - 0.5) * 2.0;
  float facet = dot(v.toCenter * cellMM, tilt) * p_tilt;
  float dome = p_dome * smoothstep(0.0, 0.5, v.border);
  float var = tFbm(uv * vec2(3.0, 4.0), vec2(3.0, 4.0), 5, 0.5, sd + 8.0);
  float wearM = smoothstep(0.2, 0.8, tFbm(uv * vec2(2.0, 3.0), vec2(2.0, 3.0), 4, 0.5, sd + 13.0) + 0.25) * p_wear;
  float cr = max(crack, crack2);
  vec3 col = c_base * (1.0 + 0.3 * var);
  col = mix(col, c_worn, wearM * 0.4);
  col = mix(col, c_crack, sat(cr * p_dust + 0.25 * fine * p_dust));
  vec2 Np = floor(Wmm / 2.5 + 0.5);
  float h = facet + dome - p_crackDepth * cr + p_crackDepth * 0.3 * lip * (1.0 - cr) - 0.003 * fine;
  h += 0.002 * tFbm(uv * Np, Np, 3, 0.5, sd + 14.0);
  s.albedo = max(col, vec3(0.0));
  s.height = h;
  s.rough = sat(p_rough + p_roughVar * var - 0.06 * wearM + 0.5 * cr + 0.15 * fine);
  s.aux = 0.05 + 0.6 * cr;
  s.mask = cr;
}`,
  },

  // ================================================================ CERAMIC (porcelain / celadon 粉青开片)
  ceramic: {
    worldSize: [0.12, 0.12], heightRange: [-0.02, 0.02], ao: { radius: 0.3, strength: 0.3 }, aux: 'porosity',
    params: { crackle: 0.0, cellMM: 9.0, crackWidth: 0.08, crackDark: 0.25, crackLight: 0.0, levels: 0.8, facet: 0.012, pinholes: 0.15,
      specks: 0.1, bubbles: 0.0, thickVar: 0.6, rough: 0.06, roughVar: 0.04 },
    colors: { glaze: '#f2f1ec', thick: '#dfe6e6', crack: '#6e7a72', speck: '#3a3530' },
    variants: {
      porcelain: { calibrate: { color: '#eeede8', lum: 0.80 } },
      celadon: { params: { crackle: 1.0, crackDark: 0.35, crackLight: 0.25, pinholes: 0.08, specks: 0.05, bubbles: 0.6, thickVar: 0.9,
        rough: 0.22, roughVar: 0.06 }, colors: { glaze: '#a4bfae', thick: '#86a896', crack: '#5f6f63' },
        calibrate: { color: '#9db8a8', lum: 0.44 } },
    },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0; vec2 tmm = Wmm / uRes; float aa = 0.7 * length(tmm);
  float thick = tFbm(uv * 3.0, vec2(3.0), 5, 0.5, sd + 1.0);
  vec3 col = mix(c_glaze, c_thick, sat(0.5 + thick * p_thickVar));
  vec2 Np = floor(Wmm / 1.2 + 0.5);
  float h = 0.0015 * tFbm(uv * Np, Np, 3, 0.5, sd + 2.0);
  float crackAll = 0.0, halo = 0.0, facetH = 0.0;
  if (p_crackle > 0.0) {
    for (int L = 0; L < 3; L++) {
      float cell = p_cellMM / pow(2.3, float(L));
      vec2 N = max(vec2(1.0), floor(Wmm / cell + 0.5));
      vec2 Nw = max(vec2(1.0), floor(N * 0.35 + 0.5));
      vec2 w = vec2(tFbm(uv * Nw, Nw, 3, 0.5, sd + 20.0 + float(L)), tFbm(uv * Nw + 5.1, Nw, 3, 0.5, sd + 30.0 + float(L)));
      Vor v = tVoronoi(uv * N + w * 0.3, N, 0.9, sd + 40.0 + float(L) * 7.0);
      float dMM = v.border * cell;
      float pk = hPair(min(v.id, v.id2), max(v.id, v.id2), sd + 50.0 + float(L));
      float present = L == 0 ? 1.0 : step(pk, p_levels * (L == 1 ? 0.7 : 0.4));
      float wmm = p_crackWidth * (L == 0 ? 1.0 : 0.75);
      float cr = (1.0 - smoothstep(wmm * 0.5, wmm * 0.5 + aa, dMM)) * present * (L == 0 ? 1.0 : 0.65);
      crackAll = max(crackAll, cr);
      halo = max(halo, present * (1.0 - smoothstep(wmm, wmm * 6.0, dMM)) * (1.0 - cr));
      if (L == 0) facetH = dot(v.toCenter * cell, vec2(fract(v.id * 13.1), fract(v.id * 71.7)) - 0.5) * p_facet;
    }
  }
  vec2 N3 = floor(Wmm / 3.0 + 0.5);
  Vor pv = tVoronoi(uv * N3, N3, 0.9, sd + 60.0);
  float pin = (1.0 - smoothstep(0.02, 0.04, pv.f1)) * step(pv.id, p_pinholes);
  float speck = (1.0 - smoothstep(0.015, 0.035, pv.f1)) * step(1.0 - p_specks, pv.id);
  vec2 N4 = floor(Wmm / 0.6 + 0.5);
  float bub = smoothstep(0.55, 0.8, tValue(uv * N4, N4, sd + 61.0)) * p_bubbles;
  col = mix(col, c_crack, crackAll * p_crackDark);
  col *= 1.0 + halo * p_crackLight * 0.25;
  col = mix(col, c_speck, speck * 0.8);
  col *= 1.0 + 0.06 * bub;
  h += facetH - 0.004 * crackAll - 0.01 * pin + 0.002 * speck;
  s.albedo = max(col, vec3(0.0));
  s.height = h;
  s.rough = sat(p_rough + p_roughVar * thick + 0.3 * crackAll + 0.3 * pin);
  s.aux = 0.02 + 0.3 * crackAll;
  s.mask = crackAll;
}`,
  },

  // ================================================================ PLASTER (lime whitewash)
  plaster: {
    worldSize: [2.0, 2.0], heightRange: [-1.5, 1.5], ao: { radius: 6.0, strength: 0.6 }, aux: 'porosity',
    params: { mottle: 1.0, patch: 1.0, stains: 0.5, streaks: 0.6, cracks: 0.45, flakes: 0.4, grit: 1.0, moss: 0.6, rough: 0.9 },
    colors: { base: '#dcd6c8', stain: '#b9a98e', streak: '#8e8a80', under: '#a39d90', moss: '#3f4a33' },
    variants: { whitewash: {} },
    calibrate: { color: '#d8d2c4', lum: 0.62 },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  float m1 = tFbm(uv * 4.0, vec2(4.0), 6, 0.55, sd + 1.0);
  float m2 = tFbm(uv * 16.0, vec2(16.0), 4, 0.5, sd + 2.0);
  vec3 col = c_base * (1.0 + p_mottle * (0.09 * m1 + 0.05 * m2));
  Vor pv = tVoronoi(uv * vec2(5.0, 4.0) + vec2(m1, m2) * 0.6, vec2(5.0, 4.0), 0.9, sd + 3.0);
  float patchM = step(0.55, pv.id) * smoothstep(0.0, 0.06, pv.border);
  col *= 1.0 + p_patch * (patchM * 0.07 - 0.03);
  float sn = tFbm(uv * vec2(3.0, 2.0) + vec2(0.0, m1 * 0.3), vec2(3.0, 2.0), 6, 0.55, sd + 4.0);
  float sAmt = smoothstep(-0.1, 0.5, tFbm(uv * 2.0, vec2(2.0), 3, 0.5, sd + 12.0));
  float st = smoothstep(0.12, 0.34, sn) * p_stains * (0.35 + 0.65 * sAmt);
  float rimMask = smoothstep(0.35, 0.65, tFbm(uv * 3.0 + 1.7, vec2(3.0), 3, 0.5, sd + 13.0) + 0.3);
  float rim = exp(-pow((sn - 0.2) / 0.01, 2.0)) * p_stains * rimMask * 0.6;
  col = mix(col, col * (c_stain / max(c_base, vec3(0.01))), st * 0.3 + rim * 0.35);
  float sx = tFbm(vec2(uv.x * 60.0, uv.y * 1.0), vec2(60.0, 1.0), 4, 0.6, sd + 5.0);
  float sl = tFbm(vec2(uv.x * 8.0, uv.y * 2.0), vec2(8.0, 2.0), 3, 0.5, sd + 6.0);
  float streak = smoothstep(0.1, 0.45, sx) * smoothstep(-0.05, 0.3, sl) * p_streaks;
  col = mix(col, col * (c_streak / max(c_base, vec3(0.01))), streak * 0.6);
  float cn = tNoise(uv * 7.0 + vec2(m1, m2) * 0.35, vec2(7.0), sd + 7.0);
  float cmask = smoothstep(0.2, 0.5, tFbm(uv * 3.0, vec2(3.0), 3, 0.5, sd + 8.0) + 0.2);
  float crack = (1.0 - smoothstep(0.0, 0.004 + fwidth(cn), abs(cn))) * cmask * p_cracks;
  float fl = tFbm(uv * 10.0, vec2(10.0), 5, 0.6, sd + 9.0);
  float flake = smoothstep(0.42, 0.45, fl) * p_flakes;
  float flakeEdge = (smoothstep(0.40, 0.42, fl) - smoothstep(0.42, 0.45, fl)) * p_flakes;
  col = mix(col, c_under * (1.0 + 0.12 * m2), flake);
  col *= 1.0 - 0.5 * crack;
  vec2 Ng = floor(Wmm / 2.5 + 0.5);
  float grit = tFbm(uv * Ng, Ng, 2, 0.5, sd + 10.0);
  col *= 1.0 + 0.03 * grit * p_grit;
  float mo = smoothstep(0.25, 0.6, tFbm(uv * 12.0, vec2(12.0), 5, 0.6, sd + 11.0) + 0.25 * m1) * p_moss;
  float h = 0.6 * m1 + 0.15 * m2 - 0.35 * flake + 0.1 * flakeEdge + 0.04 * grit * p_grit - 0.35 * crack;
  s.albedo = max(col, vec3(0.0));
  s.height = h;
  s.rough = sat(p_rough + 0.05 * m2 - 0.06 * streak);
  s.aux = sat(0.7 + 0.3 * streak);
  s.mask = mo;
}`,
  },

  // ================================================================ BLUESTONE PAVING
  bluestone: {
    worldSize: [2.4, 2.4], heightRange: [-10.0, 2.0], ao: { radius: 10.0, strength: 0.7 }, aux: 'porosity',
    params: { rows: 6.0, joint: 9.0, jointDepth: 8.0, dish: 2.2, tilt: 5.0, chisel: 0.45, veins: 0.5, speck: 1.0, chips: 0.6, wear: 0.8,
      rough: 0.68, roughWorn: 0.42, moss: 0.7 },
    colors: { base: '#5f696b', alt: '#6a6660', joint: '#2a2c26', vein: '#9a9e9a', moss: '#2f3a26' },
    variants: { paving: {} },
    calibrate: { color: '#5d6668', lum: 0.125 },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  float rows = p_rows;
  float ry = uv.y * rows; float ri = floor(ry); float fy = ry - ri;
  float rI = mod(ri, rows);
  float rh = tH1(ivec2(int(rI), 7), ivec2(int(rows), 8), sd);
  float nS = rh < 0.45 ? 2.0 : 3.0;
  float off = tH1(ivec2(int(rI), 3), ivec2(int(rows), 8), sd + 1.0);
  float ph = tH1(ivec2(int(rI), 4), ivec2(int(rows), 8), sd + 2.0) * TAU;
  float a = 0.22;
  float sx = nS * uv.x + off + a * sin(TAU * uv.x + ph) / TAU;
  float dsx = nS + a * cos(TAU * uv.x + ph);
  float si = floor(sx); float fx = sx - si;
  float sI = mod(si, nS);
  vec4 sh = tH4(ivec2(int(sI), int(rI)), ivec2(3, int(rows)), sd + 3.0);
  // distances to joints (mm)
  float dxl = fx / dsx * Wmm.x, dxr = (1.0 - fx) / dsx * Wmm.x;
  float slabH = Wmm.y / rows;
  float dyb = fy * slabH, dyt = (1.0 - fy) * slabH;
  float jn = 4.0 * tFbm(uv * 30.0, vec2(30.0), 3, 0.5, sd + 4.0);
  float ed = min(min(dxl, dxr), min(dyb, dyt)) + jn;
  float joint = 1.0 - smoothstep(p_joint * 0.5, p_joint * 0.5 + 1.5, ed);
  float round_ = smoothstep(p_joint * 0.5, p_joint * 0.5 + 25.0, ed);
  // chips along edges
  float chipN = tFbm(uv * 60.0, vec2(60.0), 3, 0.5, sd + 5.0);
  float chip = (1.0 - smoothstep(p_joint * 0.5 + 5.0, p_joint * 0.5 + 14.0, ed)) * smoothstep(0.25, 0.4, chipN) * p_chips;
  // slab-local coords
  vec2 lc = vec2(fx, fy);
  float bowl = (1.0 - pow(abs(2.0 * lc.x - 1.0), 2.2)) * (1.0 - pow(abs(2.0 * lc.y - 1.0), 2.2));
  float wearM = bowl * p_wear * (0.6 + 0.4 * sh.x);
  // chisel marks: parallel grooves at a per-slab angle, faded where worn
  float ang = sh.y * PI;
  vec2 pmm = uv * Wmm;
  float cl = sin(TAU * dot(pmm, vec2(cos(ang), sin(ang))) / (3.5 + 2.0 * sh.z) + 2.0 * tNoise(uv * 40.0, vec2(40.0), sd + 6.0));
  float chisel = smoothstep(0.6, 0.95, cl) * p_chisel * (1.0 - smoothstep(0.1, 0.45, wearM)) * smoothstep(0.45, 0.8, tFbm(uv * 12.0, vec2(12.0), 3, 0.5, sd + 7.0) + 0.45);
  // calcite veins
  float vn = tNoise(uv * 5.0 + vec2(tFbm(uv * 4.0, vec2(4.0), 3, 0.5, sd + 8.0)) * 0.5, vec2(5.0), sd + 9.0);
  float vein = (1.0 - smoothstep(0.0, 0.006 + fwidth(vn), abs(vn))) * smoothstep(0.55, 0.8, sh.w) * p_veins;
  vec2 Nsp = floor(Wmm / 1.5 + 0.5);
  float sp = tValue(uv * Nsp, Nsp, sd + 10.0);
  float m1 = tFbm(uv * 8.0, vec2(8.0), 5, 0.5, sd + 11.0);
  vec3 col = mix(c_base, c_alt, sat(0.35 + 0.5 * m1 + 0.6 * (sh.x - 0.5)));
  col *= 0.85 + 0.3 * sh.z;
  col *= 1.0 + p_speck * (0.12 * (sp - 0.5));
  col = mix(col, c_vein, vein * 0.7);
  col *= 1.0 + 0.1 * wearM;
  col *= 1.0 - 0.15 * chisel;
  col = mix(col, col * 0.7, chip * 0.5);
  float mossM = sat(joint * 0.8 + (1.0 - round_) * 0.3) * smoothstep(-0.1, 0.4, tFbm(uv * 20.0, vec2(20.0), 4, 0.5, sd + 12.0)) * p_moss;
  col = mix(col, c_joint, joint);
  // stains / dirt: darker blotches, dirt creeping out from the joints
  float dirt = smoothstep(0.1, 0.6, tFbm(uv * 10.0, vec2(10.0), 5, 0.55, sd + 13.0) + 0.35 * (1.0 - round_));
  col *= 1.0 - 0.18 * dirt;
  float tiltH = ((sh.x - 0.5) * (lc.x - 0.5) + (sh.w - 0.5) * (lc.y - 0.5)) * p_tilt;   // mm: slabs settle unevenly
  float h = -p_jointDepth * joint - 3.0 * (1.0 - round_) - p_dish * wearM - 0.15 * chisel - 1.5 * chip + 0.3 * m1 + 0.05 * sp + tiltH * (1.0 - joint);
  s.albedo = max(col, vec3(0.0));
  s.height = h;
  s.rough = sat(mix(p_rough, p_roughWorn, smoothstep(0.1, 0.7, wearM)) + 0.1 * chisel + 0.25 * joint + 0.08 * (sp - 0.5) + 0.1 * chip);
  s.aux = sat(0.35 + 0.65 * joint + 0.2 * chip);
  s.mask = mossM;
}`,
  },

  // ================================================================ ROOF TILE FIELD (小青瓦 rows, for distant roofs)
  roofTile: {
    worldSize: [1.0, 1.0], heightRange: [-30.0, 30.0], ao: { radius: 30.0, strength: 0.85 }, aux: 'porosity',
    params: { cols: 5.0, rows: 14.0, channelDepth: 16.0, coverHeight: 22.0, coverWidth: 0.34, lichen: 0.6, soot: 0.5, moss: 0.6, rough: 0.8, jitter: 1.0 },
    colors: { base: '#4d5459', alt: '#434a4f', lichen: '#8f9278', moss: '#394430', soot: '#222527' },
    variants: { rows: {} },
    calibrate: { color: '#4b5257', lum: 0.08 },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  float C = p_cols, R = p_rows;
  float cx = uv.x * C; float ci = floor(cx); float fx = cx - ci;
  float ry = uv.y * R; float ri = floor(ry); float fy = ry - ri;
  float cI = mod(ci, C), rI = mod(ri, R);
  vec4 th = tH4(ivec2(int(cI), int(rI)), ivec2(int(C), int(R)), sd + 1.0);
  // channel (concave) tile centred in the column
  float xs = (fx - 0.5 + (th.x - 0.5) * 0.04 * p_jitter);
  float chan = -p_channelDepth * cos(PI * clamp(xs, -0.5, 0.5));
  // tile overlap: each row's lower edge sits higher (tile laid on the one below); fy=0 lower edge
  float lap = 6.0 * (1.0 - fy) - 3.0;
  float hC = chan + lap;
  // cover (convex) tile over the column boundary
  float xb = fx < 0.5 ? fx : fx - 1.0;
  float cw = p_coverWidth * 0.5;
  float cb = sat(1.0 - pow(abs(xb) / cw, 2.0));
  vec4 th2 = tH4(ivec2(int(mod(ci + (fx < 0.5 ? 0.0 : 1.0), C)), int(rI)), ivec2(int(C), int(R)), sd + 2.0);
  float fy2 = fract(ry + 0.5 + (th2.y - 0.5) * 0.1);
  float hCov = p_coverHeight * sqrt(cb) + 6.0 * (1.0 - fy2) - 3.0 + 4.0;
  float isCov = step(0.001, cb) * step(hC, hCov);
  float h = mix(hC, hCov, isCov);
  // per-tile id (channel vs cover) for colour
  vec4 tid = mix(th, th2, isCov);
  float fyT = mix(fy, fy2, isCov);
  // drip edge shadow line below each tile's lower edge
  float edgeAO = mix(1.0, 0.55, (1.0 - smoothstep(0.0, 0.08, fyT)));
  float m1 = tFbm(uv * 6.0, vec2(6.0), 5, 0.5, sd + 3.0);
  vec2 Ns = floor(Wmm / 3.0 + 0.5);
  float spk = tValue(uv * Ns, Ns, sd + 4.0);
  vec3 col = mix(c_base, c_alt, sat(0.5 + 0.8 * (tid.z - 0.5) + 0.4 * m1));
  col *= 0.88 + 0.24 * tid.w;
  col *= 1.0 + 0.08 * (spk - 0.5);
  float lich = smoothstep(0.35, 0.6, tFbm(uv * 18.0 + tid.xy * 3.0, vec2(18.0), 4, 0.55, sd + 5.0) + 0.3 * m1) * p_lichen * (0.5 + 0.5 * isCov);
  float mossM = (1.0 - isCov) * smoothstep(0.2, 0.0, fyT) * smoothstep(0.0, 0.45, tFbm(uv * 25.0, vec2(25.0), 4, 0.5, sd + 6.0) + 0.2) * p_moss;
  float sootM = smoothstep(0.1, 0.6, tFbm(vec2(uv.x * 20.0, uv.y * 2.0), vec2(20.0, 2.0), 4, 0.5, sd + 7.0)) * p_soot * (1.0 - isCov * 0.5);
  col = mix(col, c_soot, sootM * 0.5);
  col = mix(col, c_lichen, lich * 0.55);
  col = mix(col, c_moss, mossM * 0.7);
  s.albedo = max(col, vec3(0.0));
  s.height = h + 0.4 * m1 + 0.15 * spk + 0.8 * lich;
  s.rough = sat(p_rough + 0.08 * m1 - 0.1 * mossM);
  s.ao = edgeAO;
  s.aux = sat(0.4 + 0.4 * mossM + 0.2 * lich);
  s.mask = sat(mossM + lich * 0.5);
}`,
  },

  // ================================================================ CLAY TILE SURFACE (for instanced tile geometry)
  tileClay: {
    worldSize: [0.25, 0.25], heightRange: [-0.5, 0.5], ao: { radius: 1.5, strength: 0.6 }, aux: 'porosity',
    params: { mottle: 1.0, speck: 1.0, lichen: 0.5, moss: 0.5, cracks: 0.3, rough: 0.82 },
    colors: { base: '#4f565b', alt: '#3f4549', lichen: '#8d917a', moss: '#37412e' },
    variants: { clay: {} },
    calibrate: { color: '#4b5257', lum: 0.08 },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  float m1 = tFbm(uv * 3.0, vec2(3.0), 6, 0.55, sd + 1.0);
  float m2 = tFbm(uv * 12.0, vec2(12.0), 4, 0.5, sd + 2.0);
  vec2 Ns = floor(Wmm / 0.8 + 0.5);
  float spk = tValue(uv * Ns, Ns, sd + 3.0);
  vec3 col = mix(c_base, c_alt, sat(0.5 + 0.9 * m1 * p_mottle));
  col *= 1.0 + 0.1 * m2 + p_speck * 0.1 * (spk - 0.5);
  float lich = smoothstep(0.3, 0.55, tFbm(uv * 8.0, vec2(8.0), 5, 0.55, sd + 4.0) + 0.2 * m1) * p_lichen;
  float mossM = smoothstep(0.25, 0.55, tFbm(uv * 10.0, vec2(10.0), 5, 0.55, sd + 5.0) - 0.2 * m1) * p_moss;
  float cn = tNoise(uv * 4.0 + m1 * 0.3, vec2(4.0), sd + 6.0);
  float crack = (1.0 - smoothstep(0.0, 0.006 + fwidth(cn), abs(cn))) * p_cracks * smoothstep(0.1, 0.4, m2 + 0.2);
  col = mix(col, c_lichen, lich * 0.5);
  col = mix(col, c_moss, mossM * 0.7);
  col *= 1.0 - 0.4 * crack;
  s.albedo = max(col, vec3(0.0));
  s.height = 0.15 * m1 + 0.05 * m2 + 0.02 * spk + 0.25 * lich + 0.2 * mossM - 0.2 * crack;
  s.rough = sat(p_rough + 0.06 * m2 - 0.08 * mossM);
  s.aux = sat(0.45 + 0.3 * mossM);
  s.mask = sat(mossM + 0.5 * lich);
}`,
  },

  // ================================================================ LINEN (plain weave with slubs)
  linen: {
    worldSize: [0.04, 0.04], heightRange: [-0.12, 0.15], ao: { radius: 0.2, strength: 0.7 }, aux: 'thickness',
    params: { threads: 144.0, halfW: 0.43, und: 0.02, thick: 0.06, slub: 1.2, irr: 0.28, fuzz: 0.8, rough: 0.85, soil: 0.25 },
    colors: { base: '#efeae1', slub: '#e4dccb', gap: '#b9b2a6' },
    variants: { bedding: {} },
    calibrate: { color: '#eee9e0', lum: 0.80 },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  Weave W = weave(uv, p_threads, p_halfW, p_und, p_thick, p_slub, p_irr, sd + 1.0);
  float soil = tFbm(uv * 2.0, vec2(2.0), 4, 0.5, sd + 2.0);
  vec2 Nf = floor(Wmm / 0.08 + 0.5);
  float fz = tValue(uv * Nf, Nf, sd + 3.0);
  // fibre twist striations inside threads
  float tw = sin(TAU * (W.along * 5.0 + (W.dir < 0.5 ? uv.x : uv.y) * p_threads * 1.7));
  vec3 col = mix(c_base, c_slub, sat(W.slub * 0.8));
  col *= 0.955 + 0.09 * W.shade;
  col *= 1.0 + 0.025 * tw * W.cover;
  col = mix(c_gap, col, 0.35 + 0.65 * W.cover);
  col *= 1.0 + 0.03 * p_fuzz * (fz - 0.5);
  col *= 1.0 - p_soil * 0.04 * (soil + 0.5);
  s.albedo = max(col, vec3(0.0));
  s.height = W.h + 0.008 * tw * W.cover;
  s.rough = sat(p_rough - 0.05 * W.cover + 0.1 * (1.0 - W.cover));
  s.aux = sat(W.cover * (0.75 + 0.35 * W.slub));
  s.mask = W.dir;
}`,
  },

  // ================================================================ SILK GAUZE (sheer; alpha = coverage)
  gauze: {
    worldSize: [0.02, 0.02], heightRange: [-0.08, 0.08], ao: { radius: 0.1, strength: 0.3 }, aux: 'thickness',
    params: { threads: 64.0, halfW: 0.17, und: 0.012, thick: 0.035, slub: 0.35, irr: 0.25, opacity: 0.88, rough: 0.55 },
    colors: { base: '#f1ebe1' },
    variants: { sheer: {}, fine: { params: { threads: 96.0, halfW: 0.2 } } },
    calibrate: { color: '#efe9df', lum: 0.80 },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  float sd = uSeed * 64.0;
  Weave W = weave(uv, p_threads, p_halfW, p_und, p_thick, p_slub, p_irr, sd + 1.0);
  vec3 col = c_base * (0.96 + 0.08 * W.shade) * (1.0 + 0.04 * W.slub);
  s.albedo = col;
  s.alpha = W.cover * p_opacity * (0.85 + 0.15 * W.slub);
  s.height = W.h;
  s.rough = p_rough;
  s.aux = W.cover;
  s.mask = W.dir;
}`,
  },

  // ================================================================ PAPER (rice paper 宣纸 / lantern paper 油纸)
  paper: {
    worldSize: [0.20, 0.20], heightRange: [-0.05, 0.05], ao: { radius: 0.4, strength: 0.4 }, aux: 'thickness',
    params: { fibres: 1.0, fibreLen: 3.0, formation: 1.0, laid: 0.6, chain: 0.5, specks: 0.4, oil: 0.0, wrinkle: 0.0, rough: 0.8 },
    colors: { base: '#ebe1ca', fibre: '#f4ecd8', speck: '#6b5d48', oil: '#d9b983' },
    variants: {
      rice: { calibrate: { color: '#e9dfc8', lum: 0.73 } },
      lantern: { params: { fibreLen: 4.0, laid: 0.3, chain: 0.3, specks: 0.25, oil: 0.9, wrinkle: 0.6, rough: 0.55 },
        colors: { base: '#f2d9a8', fibre: '#f7e3b8', oil: '#d8b172' }, calibrate: { color: '#f2d9a8', lum: 0.70 } },
    },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  float form = tFbm(uv * 12.0, vec2(12.0), 6, 0.6, sd + 1.0);
  float floc = tFbm(uv * 40.0, vec2(40.0), 3, 0.5, sd + 2.0);
  vec2 Nc1 = floor(Wmm / (p_fibreLen * 0.9) + 0.5);
  float f1 = fibreField(uv, Wmm, Nc1, 2.2 * p_fibres, p_fibreLen, 0.03, 0.8, sd + 3.0);
  vec2 Nc2 = floor(Wmm / (p_fibreLen * 2.5) + 0.5);
  float f2 = fibreField(uv, Wmm, Nc2, 0.7 * p_fibres, p_fibreLen * 2.8, 0.06, 0.5, sd + 4.0);
  float fib = max(f1, f2);
  // laid lines (mould screen) + chain lines: thinner paper along them
  float NL = floor(Wmm.y / 1.1 + 0.5), NC = floor(Wmm.x / 25.0 + 0.5);
  float laid = 0.5 + 0.5 * cos(TAU * uv.y * NL + 0.4 * tNoise(uv * 8.0, vec2(8.0), sd + 5.0));
  float chainL = exp(-pow(sin(PI * uv.x * NC) / 0.05, 2.0));
  vec2 Nk = floor(Wmm / 6.0 + 0.5);
  Vor kv = tVoronoi(uv * Nk, Nk, 0.9, sd + 6.0);
  float speck = (1.0 - smoothstep(0.03, 0.07, kv.f1 * (0.6 + 0.8 * fract(kv.id * 9.1)))) * step(kv.id, 0.12 * p_specks);
  float oilM = smoothstep(0.0, 0.5, tFbm(uv * 3.0, vec2(3.0), 5, 0.55, sd + 7.0) + 0.1) * p_oil;
  float wr = tRidged(uv * vec2(3.0, 5.0), vec2(3.0, 5.0), 3, 0.5, sd + 8.0);
  float thick = 1.0 + p_formation * (0.22 * form + 0.1 * floc) + 0.35 * fib - p_laid * 0.06 * laid - p_chain * 0.12 * chainL;
  vec3 col = c_base * (1.0 + 0.04 * form + 0.02 * floc);
  col = mix(col, c_fibre, fib * 0.35);
  col = mix(col, c_oil, oilM * 0.35);
  col = mix(col, c_speck, speck * 0.7);
  s.albedo = max(col, vec3(0.0));
  s.height = 0.012 * fib + 0.01 * form + 0.006 * floc + p_wrinkle * 0.04 * wr;
  s.rough = sat(p_rough + 0.05 * floc - 0.25 * oilM);
  s.aux = sat(0.5 * thick * (1.0 - 0.35 * oilM));
  s.mask = oilM;
}`,
  },

  // ================================================================ BAMBOO (aged natural; slats and rods)
  bamboo: {
    worldSize: [0.03, 0.45], heightRange: [-0.15, 0.35], ao: { radius: 0.4, strength: 0.5 }, aux: 'thickness',
    params: { striation: 0.28, spots: 0.12, nodes: 1.0, nodePos: 0.5, nodeWidth: 2.5, streaks: 0.8, rough: 0.36, age: 0.6 },
    colors: { base: '#bba268', dark: '#8a6f3e', spot: '#4a3a24', node: '#7a6034', green: '#9a9a5e' },
    variants: { slat: {}, rod: { params: { nodes: 0.0 } } },
    calibrate: { color: '#b9a066', lum: 0.36 },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  float Ns = max(1.0, floor(Wmm.x / p_striation + 0.5));
  float wv = tFbm(uv * vec2(3.0, 2.0), vec2(3.0, 2.0), 3, 0.5, sd + 1.0);
  float st = tNoise(vec2(uv.x * Ns + wv * 2.0, uv.y * 10.0), vec2(Ns, 10.0), sd + 2.0);
  float line = pow(1.0 - abs(st), 5.0);
  float st2 = tNoise(vec2(uv.x * Ns * 2.0 + wv * 3.0, uv.y * 16.0), vec2(Ns * 2.0, 16.0), sd + 3.0);
  float line2 = pow(1.0 - abs(st2), 7.0);
  float cs = tFbm(vec2(uv.x * 4.0, uv.y * 3.0), vec2(4.0, 3.0), 5, 0.55, sd + 4.0);
  float cl = tFbm(vec2(uv.x * 24.0, uv.y * 2.0), vec2(24.0, 2.0), 4, 0.5, sd + 5.0);
  vec2 Nsp = vec2(max(1.0, floor(Wmm.x / 2.5 + 0.5)), max(1.0, floor(Wmm.y / 5.0 + 0.5)));
  Vor sp = tVoronoi(uv * Nsp, Nsp, 0.9, sd + 6.0);
  float cluster = smoothstep(0.2, 0.6, tFbm(uv * vec2(3.0, 4.0), vec2(3.0, 4.0), 3, 0.5, sd + 7.0));
  float spot = (1.0 - smoothstep(0.05, 0.16, sp.f1 * (0.6 + fract(sp.id * 7.7)))) * step(sp.id, p_spots * cluster);
  float dv = (fract(uv.y - p_nodePos + 0.5) - 0.5) * Wmm.y;
  float node = exp(-dv * dv / (p_nodeWidth * p_nodeWidth)) * p_nodes;
  float scar = exp(-pow((dv - 0.8) / 0.35, 2.0)) * p_nodes;
  vec3 col = c_base * (1.0 + 0.1 * cs + 0.06 * cl);
  col = mix(col, c_green, sat(0.3 - cs) * 0.25 * (1.0 - p_age));
  col = mix(col, c_dark, sat(0.5 * cl + 0.3) * 0.35 * p_streaks);
  col *= 1.0 - 0.06 * line + 0.03 * line2;
  col = mix(col, c_node, node * 0.6);
  col = mix(col, c_spot, spot * 0.75);
  col *= 1.0 - 0.3 * scar;
  s.albedo = max(col, vec3(0.0));
  s.height = 0.012 * line + 0.006 * line2 + 0.25 * node - 0.05 * scar + 0.02 * cs;
  s.rough = sat(p_rough + 0.06 * cl + 0.15 * spot + 0.1 * node);
  s.aux = sat(0.45 + 0.2 * cs + 0.3 * node);
  s.mask = node;
}`,
  },

  // ================================================================ SILK STRING (guqin 丝弦: twisted strands, optional wrap)
  silk: {
    worldSize: [0.008, 1.0], size: 512, previewSize: 256, heightRange: [-0.05, 0.05], ao: { radius: 0.05, strength: 0.6 }, aux: 'thickness',
    params: { pitch: 2.0, strands: 3.0, wound: 0.0, windPitch: 0.25, rough: 0.55, fray: 0.4 },
    colors: { base: '#e6d9bc', dark: '#c9b690' },
    variants: { plain: {}, wound: { params: { wound: 1.0 } } },
    calibrate: { color: '#e3d6b8', lum: 0.66 },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  float Np = max(1.0, floor(Wmm.x / p_pitch + 0.5));
  float Nw = max(1.0, floor(Wmm.x / p_windPitch + 0.5));
  // strands: helix phase = u/pitch + v*strands  (u along the string, v around it)
  float phS = uv.x * Np + uv.y * p_strands;
  float fS = fract(phS);
  float prof = sqrt(sat(1.0 - pow(2.0 * fS - 1.0, 2.0)));
  float fib = tNoise(vec2(uv.x * Np * 14.0 + uv.y * p_strands * 14.0, uv.y * 6.0), vec2(Np * 14.0, 6.0), sd + 1.0);
  float phW = uv.x * Nw + uv.y;
  float wprof = sqrt(sat(1.0 - pow(2.0 * fract(phW) - 1.0, 2.0)));
  float h = mix(0.03 * prof + 0.004 * fib, 0.02 * wprof, p_wound);
  float var = tFbm(vec2(uv.x * 2.0, uv.y), vec2(2.0, 1.0), 3, 0.5, sd + 2.0);
  vec3 col = mix(c_dark, c_base, sat(0.55 + 0.5 * mix(prof, wprof, p_wound) + 0.2 * var));
  col *= 1.0 + 0.05 * fib;
  s.albedo = max(col, vec3(0.0));
  s.height = h;
  s.rough = sat(p_rough + 0.1 * (1.0 - mix(prof, wprof, p_wound)));
  s.aux = 0.7;
  s.mask = fS;
}`,
  },

  // ================================================================ METAL (strings: steel / silver / brass; brushed)
  metal: {
    worldSize: [0.01, 1.0], size: 512, previewSize: 256, heightRange: [-0.02, 0.02], ao: { radius: 0.03, strength: 0.4 }, aux: 'porosity', metal: true,
    params: { wound: 0.0, windPitch: 0.22, brushed: 1.0, tarnish: 0.2, smudge: 0.4, rough: 0.18 },
    colors: { base: '#c9cacb', tarnish: '#8d8272' },
    variants: {
      steel: { calibrate: { color: '#c3c5c7', lum: 0.55 } },
      silver: { colors: { base: '#f2efe8', tarnish: '#9a8f7c' }, calibrate: { color: '#eeebe4', lum: 0.83 } },
      brass: { colors: { base: '#e3c27a', tarnish: '#8a6a3a' }, calibrate: { color: '#dcb76e', lum: 0.50 } },
      woundSteel: { params: { wound: 1.0, tarnish: 0.12, smudge: 0.3 }, calibrate: { color: '#bfc1c3', lum: 0.52 } },
    },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  float Nw = max(1.0, floor(Wmm.x / p_windPitch + 0.5));
  float phW = uv.x * Nw + uv.y;
  float wprof = sqrt(sat(1.0 - pow(2.0 * fract(phW) - 1.0, 2.0)));
  float br = tNoise(vec2(uv.x * 3.0, uv.y * 400.0), vec2(3.0, 400.0), sd + 1.0);
  float tar = smoothstep(0.0, 0.8, tFbm(vec2(uv.x, uv.y * 2.0), vec2(1.0, 2.0), 3, 0.5, sd + 2.0) + 0.2) * p_tarnish;
  float sm = smoothstep(0.0, 0.6, tFbm(vec2(uv.x * 2.0, uv.y * 3.0), vec2(2.0, 3.0), 3, 0.5, sd + 3.0)) * p_smudge;
  vec3 col = mix(c_base, c_tarnish, tar * 0.6);
  col *= 1.0 + 0.04 * br * p_brushed;
  col *= mix(1.0, 0.8 + 0.2 * wprof, p_wound);
  s.albedo = max(col, vec3(0.0));
  s.height = mix(0.0015 * br * p_brushed, 0.012 * wprof, p_wound);
  s.rough = sat(p_rough + 0.12 * sm + 0.15 * tar + p_wound * 0.1 * (1.0 - wprof));
  s.metal = 1.0 - 0.3 * tar;
  s.aux = 0.0;
}`,
  },

  // ================================================================ MATTE BLACK IRON
  iron: {
    worldSize: [0.2, 0.2], heightRange: [-0.4, 0.4], ao: { radius: 1.0, strength: 0.6 }, aux: 'porosity', metal: true,
    params: { dents: 1.0, rust: 0.35, dust: 0.3, rough: 0.72 },
    colors: { base: '#2b2b2a', rust: '#5a3522', bare: '#6a6a68', dust: '#6b665e' },
    variants: { black: {} },
    calibrate: { color: '#2a2a29', lum: 0.035 },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  vec2 Nd = floor(Wmm / 7.0 + 0.5);
  Vor dv = tVoronoi(uv * Nd, Nd, 0.9, sd + 1.0);
  float dent = dv.f1 * dv.f1;
  float m1 = tFbm(uv * 6.0, vec2(6.0), 5, 0.5, sd + 2.0);
  vec2 Ng = floor(Wmm / 0.6 + 0.5);
  float gr = tValue(uv * Ng, Ng, sd + 3.0);
  float rustM = smoothstep(0.3, 0.65, tFbm(uv * 14.0, vec2(14.0), 5, 0.6, sd + 4.0) + 0.3 * (dent - 0.3)) * p_rust;
  float dustM = smoothstep(0.1, 0.6, m1 + 0.3) * p_dust;
  vec3 col = c_base * (1.0 + 0.15 * m1 + 0.1 * (gr - 0.5));
  col = mix(col, c_rust, rustM * 0.8);
  col = mix(col, c_dust, dustM * 0.25);
  s.albedo = max(col, vec3(0.0));
  s.height = p_dents * 0.12 * dent + 0.02 * gr + 0.05 * rustM;
  s.rough = sat(p_rough + 0.1 * m1 + 0.15 * rustM + 0.1 * dustM);
  s.metal = sat(0.25 - 0.25 * rustM - 0.2 * dustM);
  s.aux = sat(0.2 + 0.6 * rustM);
}`,
  },

  // ================================================================ PLUM PETAL (per-petal UV: u across, v base->tip)
  petal: {
    worldSize: [0.015, 0.015], size: 512, previewSize: 256, heightRange: [-0.03, 0.03], ao: { radius: 0.05, strength: 0.3 }, aux: 'thickness',
    params: { veins: 1.0, pink: 1.0, pinkReach: 0.3, edgeBrown: 0.0, rough: 0.55 },
    colors: { base: '#f6efe9', pink: '#f0c4c4', vein: '#efe2da', brown: '#b39473' },
    variants: { plum: { calibrate: { color: '#f4ece6', lum: 0.80, strength: 0.6 } }, fallen: { params: { edgeBrown: 0.6 } } },
    calibrate: { color: '#f4ece6', lum: 0.80, strength: 0.6 },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  float sd = uSeed * 64.0;
  vec2 c = uv - vec2(0.5, 0.0);
  float r = length(c); float th = atan(c.x, max(c.y, 1e-4));
  float wob = tFbm(vec2(r * 4.0, th * 2.0) + 8.0, vec2(64.0), 3, 0.5, sd + 1.0);
  float vn = sin(th * 11.0 + wob * 1.5 + r * 2.0);
  float vein = pow(1.0 - abs(vn), 8.0) * smoothstep(0.95, 0.2, r) * p_veins;
  float vn2 = sin(th * 23.0 + wob * 3.0 + r * 5.0);
  float vein2 = pow(1.0 - abs(vn2), 10.0) * smoothstep(0.9, 0.35, r) * 0.5 * p_veins;
  vec2 Nc = vec2(90.0);
  float cells = tValue(uv * Nc, Nc, sd + 2.0);
  float pinkM = (1.0 - smoothstep(0.0, p_pinkReach, r)) * p_pink;
  // bruised / browning rim of a fallen petal: follows the outline, irregular extent, soft
  float rimN = tFbm(vec2(th * 1.3 + 3.0, 0.5), vec2(64.0), 3, 0.5, sd + 3.0);
  float edge = smoothstep(0.30 + 0.08 * rimN, 0.5, r) * p_edgeBrown * (0.6 + 0.4 * smoothstep(-0.3, 0.3, rimN));
  vec3 col = mix(c_base, c_pink, pinkM);
  col = mix(col, c_vein, sat(vein + vein2) * 0.5);
  col *= 0.97 + 0.06 * cells;
  col = mix(col, c_brown, edge * 0.6);
  s.albedo = max(col, vec3(0.0));
  s.height = -0.006 * (vein + vein2) + 0.003 * cells;
  s.rough = sat(p_rough + 0.1 * cells);
  s.aux = sat(0.55 - 0.3 * r + 0.3 * (vein + vein2) + 0.2 * edge);
  s.mask = pinkM;
}`,
  },

  // ================================================================ LEAF (bamboo / willow: per-leaf UV, u across 0..1, v base->tip)
  leaf: {
    worldSize: [0.02, 0.12], size: 512, previewSize: 256, heightRange: [-0.03, 0.03], ao: { radius: 0.1, strength: 0.3 }, aux: 'thickness',
    params: { veins: 1.0, nVeins: 9.0, dry: 0.25, spots: 0.3, rough: 0.45 },
    colors: { base: '#4f6a34', light: '#7d8f4a', vein: '#9aa860', dry: '#9c8a55', spot: '#3a3a22' },
    variants: { bamboo: {}, dry: { params: { dry: 0.9, spots: 0.6 } } },
    calibrate: { color: '#5a7038', lum: 0.12, strength: 0.7 },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  float sd = uSeed * 64.0;
  float x = uv.x - 0.5;
  float mid = exp(-pow(x / 0.012, 2.0));
  float par = pow(abs(cos(PI * x * p_nVeins)), 24.0);
  float cross = pow(abs(sin(PI * uv.y * 60.0 + 3.0 * x)), 40.0) * 0.3;
  float vein = sat(mid + 0.5 * par + cross) * p_veins;
  float m1 = tFbm(uv * vec2(2.0, 6.0), vec2(2.0, 6.0), 4, 0.5, sd + 1.0);
  float dryM = smoothstep(0.75 - 0.3 * p_dry, 1.0, uv.y + 0.08 * m1) * p_dry;
  vec2 Ns = vec2(6.0, 30.0);
  Vor sv = tVoronoi(uv * Ns, Ns, 0.9, sd + 2.0);
  float spot = (1.0 - smoothstep(0.05, 0.15, sv.f1)) * step(sv.id, 0.1 * p_spots);
  vec3 col = mix(c_base, c_light, sat(0.5 + 0.8 * m1) * 0.5);
  col = mix(col, c_vein, vein * 0.35);
  col = mix(col, c_dry, dryM);
  col = mix(col, c_spot, spot * 0.7);
  s.albedo = max(col, vec3(0.0));
  s.height = -0.008 * mid + 0.003 * par;
  s.rough = sat(p_rough + 0.1 * dryM);
  s.aux = sat(0.45 + 0.4 * vein - 0.2 * dryM);
  s.mask = dryM;
}`,
  },

  // ================================================================ PLUM BARK (#2c2521 with lichen)
  bark: {
    worldSize: [0.12, 0.24], heightRange: [-3.0, 1.5], ao: { radius: 3.0, strength: 0.8 }, aux: 'porosity',
    params: { fissures: 0.9, lenticels: 0.8, lichen: 0.75, moss: 0.3, rough: 0.85 },
    colors: { base: '#2e2723', dark: '#1c1714', grey: '#4d4944', lichen: '#8e9784', lichen2: '#a8a88a', moss: '#3a4a2a', lent: '#6a5d52' },
    variants: { plum: {} },
    calibrate: { color: '#2c2521', lum: 0.030 },
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  vec2 w = vec2(tFbm(uv * vec2(4.0, 2.0), vec2(4.0, 2.0), 4, 0.5, sd + 1.0), tFbm(uv * vec2(4.0, 2.0) + 3.3, vec2(4.0, 2.0), 4, 0.5, sd + 2.0));
  float fis = tRidged(uv * vec2(9.0, 3.0) + w * vec2(0.8, 0.3), vec2(9.0, 3.0), 4, 0.55, sd + 3.0);
  float fiss = smoothstep(0.55, 0.9, fis) * p_fissures;
  float plate = tFbm(uv * vec2(14.0, 6.0) + w, vec2(14.0, 6.0), 5, 0.55, sd + 4.0);
  vec2 Nl = vec2(floor(Wmm.x / 6.0 + 0.5), floor(Wmm.y / 3.0 + 0.5));
  Vor lv = tVoronoi(uv * Nl, Nl, 0.8, sd + 5.0);
  vec2 lc = lv.toCenter * vec2(1.0, 3.5);
  float lent = (1.0 - smoothstep(0.12, 0.2, length(lc))) * step(lv.id, 0.6) * p_lenticels;
  float lich = smoothstep(0.3, 0.6, tFbm(uv * 7.0, vec2(7.0), 6, 0.6, sd + 6.0) + 0.2 * plate) * p_lichen;
  float lichT = tValue(uv * floor(Wmm / 0.8 + 0.5), floor(Wmm / 0.8 + 0.5), sd + 7.0);
  float mossM = smoothstep(0.35, 0.6, tFbm(uv * 5.0 + 7.0, vec2(5.0), 5, 0.6, sd + 8.0)) * p_moss * (1.0 - lich);
  float mott = tFbm(uv * vec2(3.0, 2.0), vec2(3.0, 2.0), 5, 0.55, sd + 9.0);
  vec3 col = mix(c_base, c_dark, sat(fiss + 0.3 * (0.5 - plate)));
  col = mix(col, c_grey, sat(0.5 + 0.9 * mott) * 0.45);
  col = mix(col, c_lent, lent * 0.6);
  col = mix(col, mix(c_lichen, c_lichen2, lichT), lich * 0.85);
  col = mix(col, c_moss, mossM * 0.8);
  s.albedo = max(col, vec3(0.0));
  s.height = -2.4 * fiss + 0.8 * plate + 0.25 * lent + lich * (0.45 + 0.35 * lichT) + 0.3 * mossM;
  s.rough = sat(p_rough + 0.08 * plate - 0.05 * lich);
  s.aux = sat(0.5 + 0.3 * fiss + 0.2 * mossM);
  s.mask = sat(lich + mossM);
}`,
  },
};

// ------------------------------------------------------------------------------------------------
// Micro-detail maps (close-range layer): surface writes albedo.r = albedo modulation (0.5 neutral), rough = roughness
// modulation (0.5 neutral), height (mm). Packed to RG normal, B albedo mod, A rough mod.
// ------------------------------------------------------------------------------------------------
export const DETAIL_DEFS = {
  woodPores: {
    worldSize: [0.02, 0.06], heightRange: [-0.05, 0.05],
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  vec2 Np = vec2(floor(Wmm.x / 0.32 + 0.5), floor(Wmm.y / 1.6 + 0.5));
  float wv = tFbm(uv * vec2(3.0, 1.0), vec2(3.0, 1.0), 3, 0.5, sd + 1.0);
  Vor pv = tVoronoi(uv * Np + vec2(wv * 3.0, 0.0), Np, 0.85, sd + 2.0);
  float pr = 0.28 * mix(0.5, 1.2, fract(pv.id * 13.7));
  float pore = (1.0 - smoothstep(pr * 0.6, pr, pv.f1)) * step(pv.id, 0.55);
  vec2 Nf = vec2(floor(Wmm.x / 0.06 + 0.5), floor(Wmm.y / 3.0 + 0.5));
  float fib = tFbm(uv * Nf + vec2(wv * 12.0, 0.0), Nf, 2, 0.5, sd + 3.0);
  s.albedo = vec3(0.5 - 0.35 * pore + 0.05 * fib);
  s.height = -0.03 * pore + 0.004 * fib;
  s.rough = 0.5 + 0.3 * pore;
}`,
  },
  grit: {
    worldSize: [0.05, 0.05], heightRange: [-0.1, 0.1],
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  vec2 N1 = floor(Wmm / 0.35 + 0.5), N2 = floor(Wmm / 1.2 + 0.5);
  Vor v = tVoronoi(uv * N1, N1, 0.9, sd + 1.0);
  float grain = sqrt(sat(1.0 - v.f1 * 1.4)) * (0.5 + fract(v.id * 11.3));
  float m = tFbm(uv * N2, N2, 3, 0.5, sd + 2.0);
  s.albedo = vec3(0.5 + 0.12 * (fract(v.id * 7.1) - 0.5) + 0.05 * m);
  s.height = 0.02 * grain + 0.015 * m;
  s.rough = 0.5 + 0.12 * (fract(v.id * 3.3) - 0.5);
}`,
  },
  glaze: {
    worldSize: [0.03, 0.03], heightRange: [-0.01, 0.01],
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  vec2 N1 = floor(Wmm / 0.9 + 0.5);
  float op = tFbm(uv * N1, N1, 3, 0.5, sd + 1.0);
  vec2 N2 = floor(Wmm / 1.5 + 0.5);
  Vor v = tVoronoi(uv * N2, N2, 0.9, sd + 2.0);
  float pin = (1.0 - smoothstep(0.03, 0.06, v.f1)) * step(v.id, 0.06);
  float scr = scratchField(uv, Wmm, floor(Wmm / 4.0 + 0.5), 0.12, 6.0, 0.02, 0.0, sd + 3.0);
  s.albedo = vec3(0.5 - 0.1 * pin);
  s.height = 0.0012 * op - 0.004 * pin - 0.0015 * scr;
  s.rough = 0.5 + 0.35 * scr + 0.3 * pin;
}`,
  },
  smudge: {
    worldSize: [0.08, 0.08], heightRange: [-0.01, 0.01],
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  float sm = tFbm(uv * 5.0, vec2(5.0), 5, 0.55, sd + 1.0);
  // fingerprint-like whorls in a few cells
  vec2 Nf = vec2(4.0);
  Vor fv = tVoronoi(uv * Nf, Nf, 0.7, sd + 2.0);
  vec2 fc = fv.toCenter * (Wmm / Nf);
  float fr = length(fc * vec2(1.0, 1.35));
  float ridges = 0.5 + 0.5 * sin(TAU * fr / 0.45 + 2.0 * tNoise(uv * 20.0, vec2(20.0), sd + 3.0));
  float fp = step(fv.id, 0.35) * (1.0 - smoothstep(6.0, 9.0, fr)) * ridges;
  float scr = scratchField(uv, Wmm, floor(Wmm / 5.0 + 0.5), 0.3, 12.0, 0.015, 0.0, sd + 4.0);
  vec2 Nd = floor(Wmm / 1.0 + 0.5);
  Vor dv = tVoronoi(uv * Nd, Nd, 0.9, sd + 5.0);
  float dust = (1.0 - smoothstep(0.02, 0.05, dv.f1)) * step(dv.id, 0.08);
  s.albedo = vec3(0.5 + 0.35 * dust + 0.03 * fp);
  s.height = -0.0012 * scr + 0.0008 * fp + 0.002 * dust;
  s.rough = sat(0.5 + 0.18 * sm + 0.25 * fp + 0.3 * scr + 0.3 * dust);
}`,
  },
  fibre: {
    worldSize: [0.02, 0.02], heightRange: [-0.02, 0.02],
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  vec2 Nc = floor(Wmm / 1.2 + 0.5);
  float f = fibreField(uv, Wmm, Nc, 2.5, 1.4, 0.02, 1.0, sd + 1.0);
  vec2 Nm = floor(Wmm / 0.3 + 0.5);
  float m = tFbm(uv * Nm, Nm, 2, 0.5, sd + 2.0);
  s.albedo = vec3(0.5 + 0.08 * f + 0.03 * m);
  s.height = 0.006 * f + 0.002 * m;
  s.rough = 0.5 - 0.05 * f;
}`,
  },
  cloth: {
    worldSize: [0.01, 0.01], heightRange: [-0.02, 0.02],
    glsl: /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  vec2 Wmm = uWorld * 1000.0; float sd = uSeed * 64.0;
  vec2 Nc = floor(Wmm / 0.8 + 0.5);
  float f = fibreField(uv, Wmm, Nc, 1.6, 0.9, 0.012, 1.5, sd + 1.0);
  s.albedo = vec3(0.5 + 0.12 * f);
  s.height = 0.004 * f;
  s.rough = 0.5 + 0.05 * f;
}`,
  },
};

// Low-frequency anti-tiling variation (4 independent periodic fields)
const VARIATION_GLSL = /* glsl */ `
void surface(vec2 uv, inout Surf s) {
  float sd = uSeed * 64.0;
  float a = tFbm(uv * 4.0, vec2(4.0), 5, 0.55, sd + 1.0);
  float b = tFbm(uv * 8.0, vec2(8.0), 4, 0.5, sd + 2.0);
  float c = tFbm(uv * 3.0, vec2(3.0), 5, 0.6, sd + 3.0);
  Vor v = tVoronoi(uv * 6.0, vec2(6.0), 0.9, sd + 4.0);
  float d = tFbm(uv * 16.0, vec2(16.0), 3, 0.5, sd + 5.0);
  s.albedo = vec3(0.5 + 0.9 * a, 0.5 + 0.9 * b, 0.5 + 0.9 * c);
  s.alpha = sat(0.5 + 0.8 * d + 0.25 * (fract(v.id * 5.3) - 0.5));
}`;

// ------------------------------------------------------------------------------------------------
// GPU plumbing
// ------------------------------------------------------------------------------------------------
const SURF_STRUCT = /* glsl */ `
struct Surf { vec3 albedo; float alpha; float height; float rough; float ao; float metal; float mask; float aux; };
`;
const VS = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
function surfaceFS(def, glsl) {
  const pu = Object.keys(def.params || {}).map((k) => `uniform float p_${k};`).join('\n');
  const cu = Object.keys(def.colors || {}).map((k) => `uniform vec3 c_${k};`).join('\n');
  return /* glsl */ `
precision highp float; precision highp int;
uniform vec2 uRes; uniform vec2 uWorld; uniform float uSeed;
${pu}
${cu}
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
${TILE_GLSL}
${SURF_STRUCT}
${SURF_HELPERS}
${glsl}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  Surf s = Surf(vec3(0.5), 1.0, 0.0, 0.5, 1.0, 0.0, 0.0, 0.5);
  surface(uv, s);
  o0 = vec4(s.albedo, s.height);
  o1 = vec4(s.rough, s.ao, s.metal, s.aux);
  o2 = vec4(s.alpha, s.mask, 0.0, 1.0);
}`;
}
const PACK_FS = /* glsl */ `
precision highp float; precision highp int;
uniform highp sampler2D tA; uniform highp sampler2D tB; uniform highp sampler2D tC;
uniform vec2 uTexelMM; uniform vec2 uHeightRange; uniform vec2 uAO; uniform int uSize; uniform int uMetal;
layout(location = 0) out vec4 oAlb;
layout(location = 1) out vec4 oNrm;
layout(location = 2) out vec4 oOrm;
ivec2 W(ivec2 p) { return (p + uSize * 64) % uSize; }
float H(ivec2 p) { return texelFetch(tA, W(p), 0).a; }
vec3 toSRGB(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 A = texelFetch(tA, p, 0), B = texelFetch(tB, p, 0), C = texelFetch(tC, p, 0);
  float hl = H(p + ivec2(-1, 0)), hr = H(p + ivec2(1, 0)), hd = H(p + ivec2(0, -1)), hu = H(p + ivec2(0, 1));
  float hld = H(p + ivec2(-1, -1)), hlu = H(p + ivec2(-1, 1)), hrd = H(p + ivec2(1, -1)), hru = H(p + ivec2(1, 1));
  float dx = ((hru + 2.0 * hr + hrd) - (hlu + 2.0 * hl + hld)) / (8.0 * uTexelMM.x);
  float dy = ((hlu + 2.0 * hu + hru) - (hld + 2.0 * hd + hrd)) / (8.0 * uTexelMM.y);
  vec3 n = normalize(vec3(-dx, -dy, 1.0));
  float h0 = A.a; float occ = 0.0;
  for (int d = 0; d < 8; d++) {
    float ang = (float(d) + 0.5) * 0.78539816;
    vec2 dir = vec2(cos(ang), sin(ang));
    float mx = 0.0;
    for (int k = 1; k <= 4; k++) {
      vec2 offMM = dir * uAO.x * float(k) / 4.0;
      ivec2 q = p + ivec2(round(offMM / uTexelMM));
      mx = max(mx, (H(q) - h0) / max(length(offMM), 1e-4));
    }
    occ += mx / sqrt(1.0 + mx * mx);
  }
  float ao = clamp((1.0 - uAO.y * occ / 8.0) * B.g, 0.0, 1.0);
  float hn = clamp((h0 - uHeightRange.x) / (uHeightRange.y - uHeightRange.x), 0.0, 1.0);
#ifdef DETAIL
  oAlb = vec4(n.xy * 0.5 + 0.5, clamp(A.r, 0.0, 1.0), clamp(B.r, 0.0, 1.0));
  oNrm = vec4(0.0); oOrm = vec4(0.0);
#elif defined(VARIATION)
  oAlb = clamp(vec4(A.rgb, C.r), 0.0, 1.0);
  oNrm = vec4(0.0); oOrm = vec4(0.0);
#else
  oAlb = vec4(toSRGB(A.rgb), clamp(C.r, 0.0, 1.0));
  oNrm = vec4(n * 0.5 + 0.5, hn);
  oOrm = vec4(ao, clamp(B.r, 0.0, 1.0), clamp(uMetal == 1 ? B.b : C.g, 0.0, 1.0), clamp(B.a, 0.0, 1.0));
#endif
}`;

const _ctx = new WeakMap(); // renderer -> { cache: Map, programs: Map, quad, cam, scene, stats: [] }
function ctxOf(renderer) {
  let c = _ctx.get(renderer);
  if (!c) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const mesh = new THREE.Mesh(geo, null); mesh.frustumCulled = false;
    const scene = new THREE.Scene(); scene.add(mesh);
    c = { cache: new Map(), programs: new Map(), mesh, scene, cam: new THREE.Camera(), stats: [] };
    _ctx.set(renderer, c);
  }
  return c;
}
function program(c, key, make) {
  let m = c.programs.get(key);
  if (!m) { m = make(); c.programs.set(key, m); }
  return m;
}
const nowMs = () => (globalThis.performance ? globalThis.performance.now() : Date.now());

function stableKey(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(stableKey).join(',') + ']';
  return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableKey(o[k])).join(',') + '}';
}

function maxAniso(renderer) { try { return renderer.capabilities.getMaxAnisotropy(); } catch { return 1; } }

/** Render a full-screen pass into `rt` in tiles (keeps each SwiftShader draw short). */
function drawTiled(renderer, c, mat, rt, tile = 256) {
  c.mesh.material = mat;
  const W = rt.width, H = rt.height;
  const prevRT = renderer.getRenderTarget();
  const gl = renderer.getContext();
  for (let y = 0; y < H; y += tile) {
    for (let x = 0; x < W; x += tile) {
      rt.scissor.set(x, y, Math.min(tile, W - x), Math.min(tile, H - y));
      rt.scissorTest = true;
      rt.viewport.set(0, 0, W, H);
      renderer.setRenderTarget(rt);
      renderer.render(c.scene, c.cam);
      gl.flush();
    }
  }
  rt.scissorTest = false;
  renderer.setRenderTarget(prevRT);
}

function resolve(def, variantName, opts) {
  const v = (def.variants && variantName && def.variants[variantName]) || {};
  const params = { ...(def.params || {}), ...(v.params || {}), ...(opts.params || {}) };
  const colors = { ...(def.colors || {}), ...(v.colors || {}), ...(opts.colors || {}) };
  const calibrate = opts.calibrate === false ? null : { ...(def.calibrate || {}), ...(v.calibrate || {}), ...(opts.calibrate || {}) };
  return { params, colors, calibrate: calibrate && calibrate.color ? calibrate : null };
}

function makeDataTex(data, size, { srgb = false, aniso = 1, mips = true }) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mips;
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** Force the mean linear albedo to a target colour (keeps the texture's relative variation). */
function calibrateAlbedo(buf, target, lum, strength = 1) {
  const n = buf.length / 4;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < buf.length; i += 4) { r += DECODE[buf[i]]; g += DECODE[buf[i + 1]]; b += DECODE[buf[i + 2]]; }
  const mean = [r / n, g / n, b / n];
  let tgt = hexLin(target);
  if (lum) { const L = lumOf(tgt); tgt = tgt.map((x) => x * lum / Math.max(L, 1e-6)); }
  const k = tgt.map((x, i) => Math.pow(x / Math.max(mean[i], 1e-6), strength));
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = enc(Math.min(0.95, DECODE[buf[i]] * k[0]));
    buf[i + 1] = enc(Math.min(0.95, DECODE[buf[i + 1]] * k[1]));
    buf[i + 2] = enc(Math.min(0.95, DECODE[buf[i + 2]] * k[2]));
  }
  return { before: mean, after: mean.map((m, i) => m * k[i]), lum: lumOf(mean.map((m, i) => m * k[i])) };
}

function runSurface(renderer, c, def, glsl, progKey, size, worldSize, seed, params, colors) {
  const mat = program(c, 'surf:' + progKey, () => {
    const uniforms = { uRes: { value: new THREE.Vector2() }, uWorld: { value: new THREE.Vector2() }, uSeed: { value: 0 } };
    for (const k of Object.keys(def.params || {})) uniforms['p_' + k] = { value: 0 };
    for (const k of Object.keys(def.colors || {})) uniforms['c_' + k] = { value: new THREE.Vector3() };
    return new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: surfaceFS(def, glsl), uniforms, depthTest: false, depthWrite: false });
  });
  const u = mat.uniforms;
  u.uRes.value.set(size, size); u.uWorld.value.set(worldSize[0], worldSize[1]); u.uSeed.value = seed >>> 0 & 0xffff;
  for (const k of Object.keys(params)) if (u['p_' + k]) u['p_' + k].value = params[k];
  for (const k of Object.keys(colors)) if (u['c_' + k]) u['c_' + k].value.fromArray(hexLin(colors[k]));
  const rt = new THREE.WebGLRenderTarget(size, size, { count: 3, type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
  drawTiled(renderer, c, mat, rt);
  return rt;
}

function runPack(renderer, c, srcRT, size, worldSize, def, mode) {
  const mat = program(c, 'pack:' + mode, () => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: (mode === 'detail' ? '#define DETAIL\n' : mode === 'variation' ? '#define VARIATION\n' : '') + PACK_FS,
    uniforms: { tA: { value: null }, tB: { value: null }, tC: { value: null }, uTexelMM: { value: new THREE.Vector2() }, uHeightRange: { value: new THREE.Vector2() },
      uAO: { value: new THREE.Vector2() }, uSize: { value: 0 }, uMetal: { value: 0 } },
    depthTest: false, depthWrite: false,
  }));
  const u = mat.uniforms;
  u.tA.value = srcRT.textures[0]; u.tB.value = srcRT.textures[1]; u.tC.value = srcRT.textures[2];
  u.uTexelMM.value.set(worldSize[0] * 1000 / size, worldSize[1] * 1000 / size);
  u.uHeightRange.value.fromArray(def.heightRange || [-1, 1]);
  u.uAO.value.set((def.ao && def.ao.radius) || 1, (def.ao && def.ao.strength) || 0);
  u.uSize.value = size; u.uMetal.value = def.metal ? 1 : 0;
  const rt = new THREE.WebGLRenderTarget(size, size, { count: 3, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
  drawTiled(renderer, c, mat, rt);
  const out = [];
  const n = mode === 'material' ? 3 : 1;
  for (let i = 0; i < n; i++) {
    const buf = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf, undefined, i);
    out.push(buf);
  }
  rt.dispose();
  return out;
}

function sizeFor(def, opts) {
  if (opts.size) return opts.size;
  const q = opts.quality || 'final';
  if (q === 'preview') return def.previewSize || Math.min(512, (def.size || 1024) / 2);
  return def.size || 1024;
}

/**
 * bake(renderer, name, opts) -> textures for a material definition (cached).
 * opts: { variant, quality:'final'|'preview', size, seed, params:{}, colors:{}, calibrate:false|{color,lum,strength},
 *         anisotropy (default: max, <=16), worldSize:[u,v] }
 */
export function bake(renderer, name, opts = {}) {
  const def = DEFS[name];
  if (!def) throw new Error(`procTex.bake: unknown material '${name}' (have: ${Object.keys(DEFS).join(', ')})`);
  const c = ctxOf(renderer);
  const variant = opts.variant || (def.variants ? Object.keys(def.variants)[0] : null);
  const { params, colors, calibrate } = resolve(def, variant, opts);
  const size = sizeFor(def, opts);
  const seed = typeof opts.seed === 'string' ? hashString(opts.seed) & 0xffff : (opts.seed ?? 1);
  const worldSize = opts.worldSize || def.worldSize;
  const aniso = Math.min(opts.anisotropy ?? 16, maxAniso(renderer));
  const key = 'mat:' + name + stableKey({ variant, params, colors, calibrate, size, seed, worldSize, aniso });
  const hit = c.cache.get(key);
  if (hit) return hit;
  const t0 = nowMs();
  const srt = runSurface(renderer, c, def, def.glsl, name, size, worldSize, seed, params, colors);
  const [alb, nrm, orm] = runPack(renderer, c, srt, size, worldSize, def, 'material');
  srt.dispose();
  const cal = calibrate ? calibrateAlbedo(alb, calibrate.color, calibrate.lum, calibrate.strength ?? 1) : null;
  const map = makeDataTex(alb, size, { srgb: true, aniso });
  const normalMap = makeDataTex(nrm, size, { aniso });
  const ormMap = makeDataTex(orm, size, { aniso: Math.min(aniso, 4) });
  for (const t of [map, normalMap, ormMap]) t.name = `${name}:${variant}`;
  const res = {
    name, variant, key, size, worldSize: worldSize.slice(), heightRange: (def.heightRange || [-1, 1]).slice(), aux: def.aux || 'porosity', metal: !!def.metal,
    map, normalMap, ormMap, roughnessMap: ormMap, aoMap: ormMap, metalnessMap: ormMap,
    meanAlbedo: cal ? cal.after : null, meanLum: cal ? cal.lum : null, ms: nowMs() - t0,
  };
  c.cache.set(key, res);
  c.stats.push({ key: `${name}:${variant}`, size, ms: res.ms });
  return res;
}

/** bakeDetail(renderer, name, opts) -> { map (RG normal, B albedo mod, A rough mod), size, worldSize } */
export function bakeDetail(renderer, name, opts = {}) {
  const def = DETAIL_DEFS[name];
  if (!def) throw new Error(`procTex.bakeDetail: unknown detail '${name}' (have: ${Object.keys(DETAIL_DEFS).join(', ')})`);
  const c = ctxOf(renderer);
  const q = opts.quality || 'final';
  const size = opts.size || (q === 'preview' ? 256 : 512);
  const seed = opts.seed ?? 7;
  const worldSize = opts.worldSize || def.worldSize;
  const aniso = Math.min(opts.anisotropy ?? 8, maxAniso(renderer));
  const key = 'det:' + name + stableKey({ size, seed, worldSize, aniso });
  const hit = c.cache.get(key);
  if (hit) return hit;
  const t0 = nowMs();
  const srt = runSurface(renderer, c, { params: {}, colors: {} }, def.glsl, 'detail:' + name, size, worldSize, seed, {}, {});
  const [buf] = runPack(renderer, c, srt, size, worldSize, def, 'detail');
  srt.dispose();
  const map = makeDataTex(buf, size, { aniso });
  map.name = 'detail:' + name;
  const res = { name, key, size, worldSize: worldSize.slice(), map, ms: nowMs() - t0 };
  c.cache.set(key, res);
  c.stats.push({ key: 'detail:' + name, size, ms: res.ms });
  return res;
}

/** bakeVariation(renderer, opts) -> low-frequency RGBA variation texture (bilinear, no mips needed) */
export function bakeVariation(renderer, opts = {}) {
  const c = ctxOf(renderer);
  const size = opts.size || 256, seed = opts.seed ?? 11;
  const key = 'var:' + stableKey({ size, seed });
  const hit = c.cache.get(key);
  if (hit) return hit;
  const t0 = nowMs();
  const srt = runSurface(renderer, c, { params: {}, colors: {} }, VARIATION_GLSL, 'variation', size, [1, 1], seed, {}, {});
  const [buf] = runPack(renderer, c, srt, size, [1, 1], { heightRange: [-1, 1] }, 'variation');
  srt.dispose();
  const map = makeDataTex(buf, size, { aniso: 1, mips: true });
  map.name = 'variation';
  const res = { key, size, map, ms: nowMs() - t0 };
  c.cache.set(key, res);
  c.stats.push({ key: 'variation', size, ms: res.ms });
  return res;
}

/** Bake stats of this renderer: [{key, size, ms}] in bake order. */
export function bakeStats(renderer) { return ctxOf(renderer).stats.slice(); }
export function listMaterials() { return Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, Object.keys(d.variants || {})])); }
/** Dispose every cached texture + bake programs of this renderer. */
export function disposeAll(renderer) {
  const c = _ctx.get(renderer); if (!c) return;
  for (const r of c.cache.values()) for (const k of ['map', 'normalMap', 'ormMap']) if (r[k]) r[k].dispose();
  for (const m of c.programs.values()) m.dispose();
  _ctx.delete(renderer);
}
