import {fogTerrain} from './fog-terrain.js';
import { gnoise1, gnoise2, makeRng, hash21, GLSL_NOISE } from './noise.js';
/** Independent terrain/atmosphere configuration; no project layout is bundled. */
export function createTerrainLibrary(config = {}) {
// Author: suwubee
// engine/terrain.js — the valley: river channel + embanked near banks, fields, layered far ridges (400 m → 3.3 km),
// ridge-crest tree crowns, bank trees, reeds, rocks — plus the SHARED VALLEY ATMOSPHERE (lighting + fog/mist GLSL)
// used by every valley material (terrain, houses, bridge, water, foliage). See engine/README.md.
//
//   import { createAtmosphere, createTerrain, heightAt, VALLEY } from '/src/engine/terrain.js';
//   const atmos = createAtmosphere(ctx, { sky });          // sky = createSky(...) instance (or null → stub values)
//   const terrain = createTerrain(ctx, { atmos });          // { object, update(t, world, camera), heightAt, dispose }
//   scene.add(terrain.object);
//   // per frame (after placing the camera):  atmos.update(t, world, camera, extras); terrain.update(t, world, camera);
//


// Everything is a pure function of (t, world, seed). Geometry is generated once at start-up (JS, deterministic).


const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };
const mix = (a, b, t) => a + (b - a) * t;
const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------------------------------------------
// The documented positions (other Sets look at these): keep in sync with engine/README.md
// ---------------------------------------------------------------------------------------------------------------
const VALLEY = Object.freeze({riverHalfWidth:60, westBankY:1.2, eastBankY:1.0, ...config.banks});
const layout = {lights:[], exclusions:[], bamboo:[], trees:[], plums:[], beamOrigin:[0,0,0], embankments:[], ...config.layout};
// ---------------------------------------------------------------------------------------------------------------
// Height function (JS, CPU) — also used for placement, camera paths and skyline checks.
// ---------------------------------------------------------------------------------------------------------------
/** river centre-line x(z): straight in the central reach, gentle bends far up/down stream */
function riverCenter(z) {
  const n = smooth(420, 2600, -z), s = smooth(450, 2800, z);
  return 240 * n - 320 * s + 60 * Math.sin(z / 760 + 0.4) * smooth(700, 1600, Math.abs(z));
}
function riverHalfWidth(z) { return VALLEY.riverHalfWidth + 9 * smooth(420, 1400, Math.abs(z)) * Math.sin(z / 470 + 1.3); }

// Far hills: domain-warped ridged multifractal under a distance envelope (low near the river, 500 m+ mountains at
// 3–4 km), optional low corridors are supplied by the caller:


const EZ = config.stretch || 1.6;   // valley ellipse: stretched along the river (z)
const GAPS = config.gaps || [];
function azOf(x, z) { let a = Math.atan2(x, -z) / D2R; if (a < 0) a += 360; return a; }
function angDiff(a, b) { let d = a - b; d -= 360 * Math.round(d / 360); return d; }
function gapFactor(x, z, rho) {
  const az = azOf(x, z);
  let g = 1;
  for (const G of GAPS) {
    const r = Math.max(rho, 1);
    // meandering corridor: lateral wander (m) along the corridor -> angle seen from the valley centre
    const lat = G.mAmp * Math.sin(r / G.mLen + G.ph) * smooth(350, 1400, r) + 45 * gnoise1(r / 260, 31);
    const c = G.az + Math.atan(lat / r) / D2R;
    const half = Math.atan((G.w0 + G.w1 * r) * (1 + 0.28 * gnoise1(r / 330 + G.az, 41)) / r) / D2R;
    const d = angDiff(az, c) / half;
    g *= 1 - G.depth * Math.exp(-0.5 * d * d * (0.6 + 0.4 * d * d));
  }
  return g;
}
/** far hills only (m) */
function hillsAt(x, z) {
  const rho = Math.hypot(x, z / EZ);
  if (rho < 140) return 0;
  // domain warp (large, lazy folds)
  const wx = x + 330 * gnoise2(x / 1700 + 3.1, z / 1700 - 7.2) + 90 * gnoise2(x / 520 - 1.3, z / 520 + 4.4);
  const wz = z + 330 * gnoise2(x / 1700 - 5.3, z / 1700 + 1.9) + 90 * gnoise2(x / 520 + 6.1, z / 520 - 2.8);
  // ridged multifractal: sharp crests, rounded valleys; later octaves weighted by the previous (erosion-like)
  let sum = 0, amp = 1, f = 1 / 820, norm = 0, wgt = 1;
  for (let o = 0; o < 5; o++) {
    let n = 1 - Math.abs(gnoise2(wx * f + o * 17.31, wz * f - o * 9.17));
    n *= n;
    sum += n * amp * wgt;
    norm += amp;
    wgt = clamp(n * 1.35, 0.15, 1);
    amp *= 0.47; f *= 2.11;
  }
  const R = sum / norm;                                   // ~[0, 0.9]
  const env = smooth(170, 4200, rho);
  const A = 36 + 600 * Math.pow(env, 1.15);
  const h = A * (0.12 + 1.05 * R) * smooth(140, 520, rho) * gapFactor(x, z, rho);
  return Math.max(0, h);
}
/** terrain height (m) at world (x, z) */
function heightAt(x, z) {
  const cx = riverCenter(z), hw = riverHalfWidth(z);
  const s = x - cx, d = Math.abs(s), west = s < 0;
  const az = Math.abs(z);
  // Explicit embankment spans; the default natural banks contain no site layout
  const emb = layout.embankments.reduce((v,b)=>Math.max(v,1-smooth(b.length,b.length+b.fade,Math.abs(z-b.z))),0);
  const topE = west ? VALLEY.westBankY : VALLEY.eastBankY;
  const inland = west ? 0.4 : 0.3;
  let yEmb;
  if (d < hw - 0.02) yEmb = -2.3 + 0.8 * smooth(hw - 12, hw - 0.5, d);
  else yEmb = topE + inland * smooth(hw + 0.5, hw + 7, d);
  // natural bank: mud/grass slope with a reed shelf
  const yNat = -2.4 + 2.55 * smooth(hw - 16, hw + 1, d) + 0.75 * smooth(hw - 1, hw + 9, d) + 0.25 * gnoise2(x / 23, z / 23) * smooth(hw - 3, hw + 4, d);
  let y = mix(yNat, yEmb, emb);
  // valley floor beyond the banks (fields, garden terraces), rising gently
  const beyond = Math.max(0, d - hw - 8);
  y += Math.min(beyond, 700) * 0.011 + 2.2 * smooth(150, 420, d) + 0.35 * gnoise2(x / 61 + 3.1, z / 61 - 1.7) * smooth(hw + 6, hw + 30, d);
  // gentle undulation of the valley floor (flattened only inside caller-supplied exclusions)
  const flatMask = layout.exclusions.reduce((v,b)=>Math.max(v,1-smooth(b.radius,b.radius*2,Math.hypot(x-b.x,z-b.z))),0);
  const und = (1.2 * gnoise2(x / 230 + 5.3, z / 230 - 1.7) + 0.5 * gnoise2(x / 90 - 2.9, z / 90 + 4.1)) * smooth(hw + 14, hw + 60, d) * (1 - flatMask) ;
  y += und;
  // hills, kept away from the river corridor
  const hills = hillsAt(x, z);
  y += hills * smooth(hw + 25, hw + 150, d);
  return y;
}
/** x of the field-plot column boundary k on a side (−1 west, +1 east) at z (mirror of vPlot() in the ground shader) */
function plotColumnX(side, k, z) {
  // solve u + 9 sin(u/57 + side) = 30k − 6 sin(z/140 + 1.3 side) (monotonic) by Newton
  const target = 30 * k - 6 * Math.sin(z / 140 + side * 1.3);
  let u = target;
  for (let i = 0; i < 6; i++) { const f = u + 9 * Math.sin(u / 57 + side) - target, df = 1 + (9 / 57) * Math.cos(u / 57 + side); u -= f / df; }
  return riverCenter(z) + side * (u + riverHalfWidth(z) + 14);
}

/** max elevation angle (deg) of the terrain seen from (x,y,z) toward azimuth az (deg, from north clockwise) */
function horizonElevation(x, y, z, az, maxDist = 9000, step0 = 4) {
  const dx = Math.sin(az * D2R), dz = -Math.cos(az * D2R);
  let best = -90, t = step0;
  while (t < maxDist) {
    const h = heightAt(x + dx * t, z + dz * t);
    const e = Math.atan2(h - y, t) / D2R;
    if (e > best) best = e;
    t *= 1.035; t += 0.5;
  }
  return best;
}

/** skyline elevation (deg) toward azimuth az seen from p, cached per (rounded) query — used for sun/moon visibility */
const _skyCache = new Map();
function skylineAt(p, az) {
  const qx = Math.round(p[0] / 4), qy = Math.round(p[1] / 2), qz = Math.round(p[2] / 4), qa = Math.round(az * 5);
  const k = `${qx},${qy},${qz},${qa}`;
  let v = _skyCache.get(k);
  if (v === undefined) {
    // evaluated at the bucket centre: a pure function of the key (no dependence on which query filled the cache)
    v = horizonElevation(qx * 4, qy * 2, qz * 4, qa / 5, 9000, 6);
    if (_skyCache.size > 20000) _skyCache.clear();
    _skyCache.set(k, v);
  }
  return v;
}

// ===============================================================================================================
// SHARED VALLEY ATMOSPHERE — lighting + fog/mist/glow/rain-veil/moonbeam GLSL, used by all valley materials.
// ===============================================================================================================
const NPL = 5;   // surface point lights
const NGL = 6;   // mist glow sources
const VALLEY_GLSL = /* glsl */ `
#ifndef MV_VALLEY_GLSL
#define MV_VALLEY_GLSL
#define VNPL ${NPL}
#define VNGL ${NGL}
uniform vec3 vCam;
uniform float vTime;
uniform vec3 vMoonDir; uniform vec3 vMoonCol;     // white-Lambert radiance per unit cos (I/pi * colour), no cloud shadow
uniform vec3 vSunDir;  uniform vec3 vSunCol;
uniform vec4 vKey;                                // x: moon is key (cloud-shadowed), y: sun terrain-visibility, z: moon terrain-visibility, w: ambient gain
uniform vec4 vHaze;                               // x haze sigma0 (1/m), y haze scale height (m), z mist sigma0 (1/m), w mist scale height (m)
uniform vec4 vMistN;                              // x noise amount, y 1/tile (1/m), z,w drift (m)
uniform vec4 vMistB;                              // x mist top (m), y single-scatter albedo, z phase g, w in-scatter gain
uniform sampler2D vNoiseTex;                      // RG tileable fbm (value noise), linear, repeat
uniform vec4 vPL[VNPL]; uniform vec3 vPLc[VNPL]; uniform int vPLn;   // surface lights: pos, soft radius | colour*I/pi
uniform vec4 vGL[VNGL]; uniform vec4 vGLc[VNGL]; uniform int vGLn;   // mist glows: pos, soft radius | colour*gain, range (m)
uniform vec4 vRain;                               // x amount, y edge x (m), z veil sigma (1/m, at amount 1), w streak gain
uniform vec4 vBeam;                               // x gain, y max dist (m), z haze boost, w steps on (0/1)
uniform float vMirror;                            // 1 in the planar-reflection pass (density mirrored about y = 0)
uniform vec3 vAmbMist;                            // (unused, kept for API stability)
uniform int vDebug;                               // 1: key-light cloud shadow, 2: lit surface only (no fog), 3: fog only
uniform vec4 vMoonSh;                             
uniform vec4 vMoonSh2;                            // x noise scale (1/m), y,z drift (m), w beam soft edge (m)
uniform vec3 vBeamO;                              
uniform vec4 vHazeB;                              // x: night aerial-haze brightness boost
uniform float vEastSh;                            
uniform vec2 vWet;                                // x: west-bank wetness (world.wetness), y: east-bank dew
uniform sampler2D vGroundMap; uniform vec4 vGroundBounds; uniform float vCustomGround; uniform float vWaterMistEnabled;
vec2 vGround(vec3 p){return texture(vGroundMap, (p.xz-vGroundBounds.xy)/vGroundBounds.zw).rg;}
uniform vec4 vFogV;                               // valley fog pooled low in the distance: x sigma0 (1/m), y scale height (m), z start distance (m), w gain

const float V_PI = 3.14159265358979;
float vHG(float c, float g){ float g2 = g * g; return (1.0 - g2) / (4.0 * V_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
float vPhase(float c){ return mix(vHG(c, vMistB.z), vHG(c, -0.3), 0.3); }
float vIGN(vec2 px){ return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }

// optical depth of sig0*exp(-y/H) along y(t) = y0 + dy*t, t in [0, D]
// (difference-of-exponentials form: no overflow for long steep rays through a thin layer — the product form
//  e0 * (1 - exp(-x)) / a gave 0 * inf = NaN from high cameras)
float vExpOD(float y0, float dy, float D, float sig0, float H){
  float ya = max(y0, -40.0), yb = max(y0 + dy * D, -40.0);
  float e0 = exp(-ya / H);
  if (abs(dy * D) < 1e-3 * H) return sig0 * e0 * D;
  return max(sig0 * H * (e0 - exp(-yb / H)) / dy, 0.0);
}
// same with the density mirrored about y = 0 (reflection pass: the path starts below the water plane)
float vExpODm(float y0, float dy, float D, float sig0, float H){
  if (vMirror < 0.5 || y0 >= 0.0) return vExpOD(max(y0, 0.0), dy, D, sig0, H);
  float tc = dy > 1e-6 ? min(-y0 / dy, D) : D;
  float od = vExpOD(-y0, -dy, tc, sig0, H);
  if (tc < D) od += vExpOD(0.0, dy, D - tc, sig0, H);
  return od;
}
float vRainEdge(float z){ return vRain.y + 7.0 * sin(z * 0.027 + 1.3) + 3.5 * sin(z * 0.083 + 0.4) + 1.6 * sin(z * 0.21); }
// river centre-line and half width (mirror of riverCenter / riverHalfWidth in JS)
float vRiverCX(float z){ return 240.0 * smoothstep(420.0, 2600.0, -z) - 320.0 * smoothstep(450.0, 2800.0, z) + 60.0 * sin(z / 760.0 + 0.4) * smoothstep(700.0, 1600.0, abs(z)); }
float vRiverHW(float z){ return ${Number(VALLEY.riverHalfWidth).toFixed(3)} + 9.0 * smoothstep(420.0, 1400.0, abs(z)) * sin(z / 470.0 + 1.3); }
// mist over the open water is thinner than over the banks and fields (end-point factor, continuous across the bank)
// valley-floor field plots (mirror of plotAt() in JS): vec4(hash, u in cell, v in cell, distance to the plot edge m)
vec4 vPlot(vec3 P, out float Lp){
  float cx = vRiverCX(P.z), hw = vRiverHW(P.z);
  float s = P.x - cx; float side = s < 0.0 ? -1.0 : 1.0;
  float u = abs(s) - hw - 14.0;
  float uu = u + 6.0 * sin(P.z / 140.0 + side * 1.3) + 9.0 * sin(u / 57.0 + side);
  float col = floor(uu / 30.0);
  float L = 30.0 + 14.0 * mvHash21(vec2(col,side));
  float vv = P.z + 17.0 * col + 8.0 * sin(u / 90.0) + side * 11.0;
  float row = floor(vv / L);
  float h = mvHash31(vec3(col,row,side));
  vec2 f = vec2(uu / 30.0 - col, vv / L - row);
  float e = min(min(f.x, 1.0 - f.x) * 30.0, min(f.y, 1.0 - f.y) * L);
  Lp = L;
  return vec4(h, f, e);
}
float vWaterMist(vec3 P){ if(vWaterMistEnabled < 0.5)return 1.0; if(vCustomGround>0.5)return mix(1.0,0.22,vGround(P).y); float hw = vRiverHW(P.z); return mix(0.22, 1.0, smoothstep(hw - 36.0, hw + 16.0, abs(P.x - vRiverCX(P.z)))); }
float vMistNoise(vec2 xz){
  vec2 n = texture(vNoiseTex, (xz + vMistN.zw) * vMistN.y).rg;
  float v = n.r * 0.6 + n.g * 0.4;
  return mix(1.0, 2.7 * smoothstep(0.34, 0.9, v) + 0.03, vMistN.x);
}

// ---- lighting ----------------------------------------------------------------------------------------------


float vMoonShadow(vec3 P){
  float edge = vRainEdge(P.z) + 14.0 + P.y * 0.6;
  float west = smoothstep(edge + 22.0, edge - 22.0, P.x);
  float s = 1.0 - vMoonSh.x * west - vEastSh * (1.0 - west);
  vec3 q = P - vBeamO;
  float along = dot(q, vMoonDir);
  float r = length(q - along * vMoonDir);
  float beam = vMoonSh.z * (1.0 - smoothstep(vMoonSh.y - vMoonSh2.w, vMoonSh.y + vMoonSh2.w, r)) * smoothstep(-60.0, -30.0, along);
  s = max(s, beam);
  if (vMoonSh.w > 0.0) {
    vec2 cxz = (P.xz + vMoonDir.xz * ((600.0 - P.y) / max(vMoonDir.y, 0.15)) + vMoonSh2.yz) * vMoonSh2.x;
    float n = texture(vNoiseTex, cxz).r;
    s *= 1.0 - vMoonSh.w * smoothstep(0.48, 0.78, n);
  }
  return s;
}
float vKeyShadow(vec3 P){ return vKey.x > 0.5 ? vMoonShadow(P) : skyCloudShadow(P); }
// the gap beam alone (0..1): the lit shaft for the in-scatter march (the rest of the moonlit air is in haze / mist)
float vBeamMask(vec3 P){
  vec3 q = P - vBeamO;
  float along = dot(q, vMoonDir);
  vec3 qp = q - along * vMoonDir;
  float r = length(qp);
  float m = vMoonSh.z * (1.0 - smoothstep(vMoonSh.y - vMoonSh2.w, vMoonSh.y + vMoonSh2.w, r)) * smoothstep(-60.0, -30.0, along);
  if (vMoonSh.w > 0.0 && m > 0.0) {
    vec2 cxz = (P.xz + vMoonDir.xz * ((600.0 - P.y) / max(vMoonDir.y, 0.15)) + vMoonSh2.yz) * vMoonSh2.x;
    m *= 1.0 - vMoonSh.w * smoothstep(0.48, 0.78, texture(vNoiseTex, cxz).r);
  }
  return m;
}
// crepuscular streaks as seen along view direction d: the shafts are parallel to the moon direction, so in the image
// they radiate from the moon — a function of the angle of d around the moon axis (smooth near the moon itself)
float vBeamRays(vec3 d){
  vec3 e1 = normalize(cross(vMoonDir, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0)); vec3 e2 = cross(e1, vMoonDir);
  float phi = atan(dot(d, e2), dot(d, e1)) * 0.15915494 + 0.5;          // 0..1 around the moon
  float n1 = texture(vNoiseTex, vec2(phi * 7.0 + vTime * 0.004, 0.37)).r;
  float n2 = texture(vNoiseTex, vec2(phi * 19.0 - vTime * 0.003, 0.71)).g;
  float rays = 0.3 + 1.45 * smoothstep(0.34, 0.74, n1 * 0.65 + n2 * 0.35);
  // the shafts live below the cloud gap: streaks fan downward and sideways from the moon, faint above it
  vec3 dp = d - dot(d, vMoonDir) * vMoonDir;
  float down = smoothstep(0.3, -0.4, dot(dp, vec3(0.0, 1.0, 0.0)) / max(length(dp), 1e-4));
  return mix(1.0, rays, smoothstep(0.004, 0.06, 1.0 - dot(d, vMoonDir))) * mix(0.35, 1.0, down);
}
// direct light (moon + sun + point lights) + ambient for a surface; wrap in [0,1] softens the terminator
vec3 vDirect(vec3 P, vec3 N, float wrap, float trans, float shadowKey, out vec3 specDirs){
  float cs = vKeyShadow(P);
  float mv = mix(1.0, cs, vKey.x) * vKey.z;
  float sv = mix(cs, 1.0, vKey.x) * vKey.y;
  mv *= mix(1.0, shadowKey, vKey.x); sv *= mix(shadowKey, 1.0, vKey.x);
  float nm = dot(N, vMoonDir), ns = dot(N, vSunDir);
  vec3 E = vMoonCol * (max((nm + wrap) / (1.0 + wrap), 0.0) + trans * max(-nm, 0.0)) * mv
         + vSunCol * (max((ns + wrap) / (1.0 + wrap), 0.0) + trans * max(-ns, 0.0)) * sv;
  specDirs = vec3(mv, sv, 0.0);
  return E;
}
vec3 vPoint(vec3 P, vec3 N, float wrap){
  vec3 E = vec3(0.0);
#ifdef NO_POINT_LIGHTS
  return E;
#endif
  for (int i = 0; i < VNPL; i++) {
    if (i >= vPLn) break;
    vec3 L = vPL[i].xyz - P; float d2 = dot(L, L);
    vec3 l = L * inversesqrt(max(d2, 1e-6));
    E += vPLc[i] * max((dot(N, l) + wrap) / (1.0 + wrap), 0.0) / (d2 + vPL[i].w * vPL[i].w);
  }
  return E;
}
float vGGX(vec3 N, vec3 V, vec3 L, float a){
  vec3 H = normalize(V + L); float nh = max(dot(N, H), 0.0), nl = max(dot(N, L), 0.0), nv = max(dot(N, V), 1e-3);
  float a2 = a * a; float dd = nh * nh * (a2 - 1.0) + 1.0;
  float D = a2 / (V_PI * dd * dd);
  float k = a * 0.5; float G = nl / (nl * (1.0 - k) + k) / (nv * (1.0 - k) + k);
  return D * G * 0.25 * nl;
}
// full surface shading: albedo, roughness, F0 (spec), ao, wrap, transmission, key-light shadow (shadow map / 1)
vec3 vShade(vec3 P, vec3 N, vec3 V, vec3 alb, float rough, float f0, float ao, float wrap, float trans, float shadowKey){
  vec3 sd;
  vec3 E = vDirect(P, N, wrap, trans, shadowKey, sd);
  vec3 Ep = vPoint(P, N, wrap);
  vec3 amb = skyAmbient(N) * ao * vKey.w;
  vec3 col = alb * (E + Ep + amb);
  if (f0 > 0.0) {
    float a = max(rough * rough, 0.002);
    float fr = f0 + (1.0 - f0) * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    vec3 s = vMoonCol * V_PI * vGGX(N, V, vMoonDir, a) * sd.x + vSunCol * V_PI * vGGX(N, V, vSunDir, a) * sd.y;
    for (int i = 0; i < VNPL; i++) {
      if (i >= vPLn) break;
      vec3 L = vPL[i].xyz - P; float d2 = dot(L, L);
      s += vPLc[i] * V_PI * vGGX(N, V, L * inversesqrt(max(d2, 1e-6)), a) / (d2 + vPL[i].w * vPL[i].w);
    }
    col += s * fr + skyRadiance(reflect(-V, N)) * fr * ao * 0.35 * (1.0 - rough);
  }
  return col;
}

// ---- atmosphere ------------------------------------------------------------------------------------------
// in-scatter of the analytic point glows (airlight, single scattering) for the segment [0, D] of ray (o, d)
vec3 vGlows(vec3 o, vec3 d, float D, float densK){
  vec3 acc = vec3(0.0);
  for (int i = 0; i < VNGL; i++) {
    if (i >= vGLn) break;
    vec3 gp = vGL[i].xyz; if (vMirror > 0.5) gp.y = -gp.y;       // mirrored light in the reflection pass
    vec3 q = gp - o;
    float t0 = dot(q, d);
    float h2 = max(dot(q, q) - t0 * t0, 0.0) + vGL[i].w * vGL[i].w;
    float h = sqrt(h2);
    if (h > 10.0 * vGLc[i].w) continue;                  // ray passes far from this light: exp(-10) ≈ 0
    float a = (atan((D - t0) / h) - atan(-t0 / h)) / h;
    float yc = abs(o.y + d.y * clamp(t0, 0.0, D));
    float dens = vHaze.x * exp(-yc / vHaze.y) + vHaze.z * exp(-yc / vHaze.w) * densK;
    acc += vGLc[i].rgb * (a * dens * exp(-h / vGLc[i].w));
  }
  return acc * (1.0 / (4.0 * V_PI));
}
// cheap version of the sky lib's skyHazeColor(): horizon radiance in the view azimuth + ambient + forward glow
vec3 vHazeColor(vec3 d, vec3 ambUp){
  // the horizon radiance of the view azimuth, blurred over ±16° of azimuth (5 taps): a single tap put every cloud
  // sitting on the horizon into the haze of the whole terrain column below it (vertical bands); at night it is
  // sampled a little higher (vHazeB.y) so a bright band right at the horizon does not light the whole distant valley
  float hy = max(d.y, 0.0) * 0.35 + 0.035 + vHazeB.y;
  vec2 hxz = normalize(vec2(d.x, d.z) + vec2(1e-5, 0.0));
  vec3 hor = vec3(0.0);
  for (int k = -2; k <= 2; k++) {
    float a = float(k) * 0.14, ca = cos(a), sa = sin(a);
    vec2 r = vec2(hxz.x * ca - hxz.y * sa, hxz.x * sa + hxz.y * ca);
    hor += texture(skyMapTex, skyEquirectUv(normalize(vec3(r.x, hy, r.y)))).rgb * (3.0 - abs(float(k)));
  }
  hor *= 1.0 / 9.0;
  float c = dot(d, skyKeyDir);
  vec3 h = mix(ambUp, hor, 0.62) + skyHazeKeyCol * (skyHazeA.x * skyHazeA.z * skyHG(c, skyHazeA.y));
  // never brighter than the horizon sky itself: distant ridges converge to it (layers separate by distance)
  return min(h * vHazeB.x, hor * 1.05 + 1e-4);
}
// moonbeam in-scatter along [0, min(D, maxDist)] of ray (o, d): 6-step march of the story moon shadow
vec3 vBeamIn(vec3 o, vec3 d, float D, float jit){
#ifdef MV_VERTEX_STAGE
  const int NB = 2;
#else
  const int NB = 3;
#endif
  // march only the part of the ray inside the beam cylinder (analytic ray–cylinder intersection): no undersampling of
  // the dense near part (near objects must never receive more in-scatter than the terrain behind them)
  float tmax = min(D, vBeam.y);
  vec3 ob = (vMirror > 0.5 ? vec3(o.x, -o.y, o.z) : o) - vBeamO;
  vec3 dd = vMirror > 0.5 ? vec3(d.x, -d.y, d.z) : d;
  vec3 a = dd - dot(dd, vMoonDir) * vMoonDir, b = ob - dot(ob, vMoonDir) * vMoonDir;
  float Ro = vMoonSh.y + vMoonSh2.w;
  float A = dot(a, a), B = 2.0 * dot(a, b), C = dot(b, b) - Ro * Ro;
  float t0 = 0.0, t1 = tmax;
  if (A > 1e-8) {
    float disc = B * B - 4.0 * A * C;
    if (disc <= 0.0) return vec3(0.0);
    float sq = sqrt(disc);
    t0 = max((-B - sq) / (2.0 * A), 0.0); t1 = min((-B + sq) / (2.0 * A), tmax);
  } else if (C > 0.0) return vec3(0.0);
  if (t1 <= t0) return vec3(0.0);
  float dt = (t1 - t0) / float(NB), acc = 0.0;
  for (int i = 0; i < NB; i++) {
    float t = t0 + (float(i) + jit) * dt;
    vec3 p = ob + vBeamO + dd * t;                       // real (un-mirrored) point
    float den = vHaze.x * vBeam.z * exp(-max(p.y, 0.0) / 180.0) + vRain.x * vRain.z * 3.0 * step(p.x, vRainEdge(p.z) + 30.0);
    acc += vBeamMask(p) * den * dt;
  }
  return vMoonCol * V_PI * vPhase(dot(dd, vMoonDir)) * acc * vBeam.x * vKey.z * vBeamRays(dd);
}
// returns vec4(inscatter rgb, transmittance) for the ray camera -> P (isSky: to "infinity")
vec4 vAtmosJ(vec3 P, float isSky, float jit){
  vec3 o = vCam;
  vec3 dv = P - o; float D = length(dv); vec3 d = dv / max(D, 1e-4);
  if (isSky > 0.5) D = 60000.0;
  vec3 ambUp = texelFetch(skyAmbTex, ivec2(2, 1), 0).rgb, ambDn = texelFetch(skyAmbTex, ivec2(3, 1), 0).rgb;
  // reflection pass: the mirrored camera looks down through the mirrored world; phases, sky colours and shadow
  // lookups must use the REAL (reflected) ray and points
  vec3 dR = vMirror > 0.5 ? vec3(d.x, -d.y, d.z) : d;
  // 1) large-scale haze (not for sky pixels: the sky already contains its own aerial perspective)
  float tauH = isSky > 0.5 ? 0.0 : vExpODm(o.y, d.y, D, vHaze.x, vHaze.y);
  vec3 hazeCol = vHazeColor(dR, ambUp);
  // 2) ground mist: 3 slabs, noise sampled inside each slab (layered sheets), one cloud-shadow lookup
  vec3 Lm = vec3(0.0); float Tm = 1.0, nAvg = 0.0, nW = 0.0;
  float phM = vPhase(dot(dR, vMoonDir)), phS = vPhase(dot(dR, vSunDir));
  vec3 Jamb = 0.5 * (ambUp + ambDn) * vKey.w;
  float Dm = min(D, 7000.0);
  float wf = isSky > 0.5 ? 1.0 : vWaterMist(P);
  if (vMirror > 0.5) {
    float od = vExpODm(o.y, d.y, Dm, vHaze.z, vHaze.w) * wf;
    Tm = exp(-od);
    vec3 pm = o + d * min(Dm, 400.0) * 0.5; pm.y = abs(pm.y);
    float cs = vKeyShadow(pm);
    Lm = (Jamb + vMoonCol * V_PI * phM * mix(1.0, cs, vKey.x) * vKey.z + vSunCol * V_PI * phS * mix(cs, 1.0, vKey.x) * vKey.y) * vMistB.y * vMistB.w * (1.0 - Tm);
    nAvg = 1.0; nW = 1.0;
  } else {
    float slabs[4] = float[4](0.0, 1.3, 3.6, 1.0);
    slabs[3] = vMistB.x;
    vec3 Jd = vec3(0.0); bool haveJ = false;
    for (int k = 0; k < 3; k++) {
      int i = d.y < 0.0 ? 2 - k : k;
      float a = slabs[i], b = slabs[i + 1];
      float tin, tout;
      if (abs(d.y) < 1e-5) { if (o.y < a || o.y > b) continue; tin = 0.0; tout = Dm; }
      else { float ta = (a - o.y) / d.y, tb = (b - o.y) / d.y; tin = max(min(ta, tb), 0.0); tout = min(max(ta, tb), Dm); }
      if (tout <= tin) continue;
      float tm = mix(tin, tout, 0.3 + 0.4 * jit);
      vec3 p = o + d * tm;
#ifdef MV_VERTEX_STAGE
      float n = 1.0;                         // vertex stage: smooth fog only (noise would alias along long triangles)
#else
      float n = vMistNoise(p.xz * (1.0 + 0.17 * float(i)) + vec2(float(i) * 37.0, float(i) * -21.0));
#endif
      float od = vExpOD(o.y + d.y * tin, d.y, tout - tin, vHaze.z, vHaze.w) * n * wf;
      if (!haveJ) {
        float cs = vKeyShadow(p);
        Jd = vMoonCol * V_PI * phM * mix(1.0, cs, vKey.x) * vKey.z + vSunCol * V_PI * phS * mix(cs, 1.0, vKey.x) * vKey.y;
        haveJ = true;
      }
      float tr = exp(-od);
      Lm += Tm * (1.0 - tr) * (Jamb + Jd) * vMistB.y * vMistB.w;
      Tm *= tr;
      nAvg += n * od; nW += od;
    }
  }
  float densK = nW > 1e-5 ? nAvg / nW : 1.0;
  
  vec3 Lg = vGlows(o, d, min(D, 3000.0), densK);
  // 4) rain veil over the west half (x < ragged edge): haze + falling streak texture at the curtain face
  vec3 Lr = vec3(0.0); float Tr = 1.0;
  if (vRain.x > 0.002) {
    float xeC = vRainEdge(o.z);
    float tin = 0.0, tout = min(D, 2500.0);
    bool inside = o.x < xeC;
    float te = abs(d.x) > 1e-5 ? (xeC - o.x) / d.x : 1e9;
    if (te > 0.0 && te < 1e8) { float ze = o.z + d.z * te; te = (vRainEdge(ze) - o.x) / d.x; }
    if (inside) { if (d.x > 0.0) tout = min(tout, te); }
    else { if (d.x < 0.0 && te > 0.0) tin = te; else tout = 0.0; }
    // rain exists below the cloud base (~450 m): clip the segment
    if (d.y > 1e-4) tout = min(tout, (450.0 - o.y) / d.y);
    else if (d.y < -1e-4 && o.y > 450.0) tin = max(tin, (450.0 - o.y) / d.y);
    // soft curtain edge: the rain thins over ~250 m past the ragged edge (a sharp plane seen end-on read as a wall)
    float fringe = 0.0;
    if (abs(d.x) > 1e-4) {
      float fw = min(250.0 / abs(d.x), min(D, 2500.0));
      if (inside && d.x > 0.0 && tout < min(D, 2500.0)) fringe = min(fw, min(D, 2500.0) - tout) * 0.5;
      if (!inside && d.x < 0.0 && te > 0.0) fringe = min(fw, te) * 0.5;
    }
    if (tout > tin || fringe > 0.0) {
      float len = max(tout - tin, 0.0) + fringe;
      if (tout <= tin) tin = max(te - fringe, 0.0);
      vec3 pe = o + d * tin;
      float od = vRain.x * vRain.z * len;
      float fall = vTime * 7.5;
      vec2 su = vec2(pe.z * 0.9 + pe.y * 0.07, (pe.y + fall) * 0.045);
#ifdef MV_VERTEX_STAGE
      float st = 0.6;
#else
      float st = texture(vNoiseTex, su).r;
#endif
      float graze = 1.0 - smoothstep(0.12, 0.4, abs(d.y));
      float streak = mix(1.0, smoothstep(0.42, 0.9, st) * 2.4, (inside ? 0.12 : 0.6) * graze) * vRain.w;
      vec3 pm = o + d * mix(tin, tout, 0.3); pm.y = abs(pm.y);
      float cs = vKeyShadow(pm);
      vec3 J = (Jamb * 0.8 + vMoonCol * V_PI * vHG(dot(dR, vMoonDir), 0.6) * mix(1.0, cs, vKey.x) * vKey.z) * streak;
      Tr = exp(-od);
      Lr = J * (1.0 - Tr);
    }
  }
  // 5) moonbeam through the cloud gap (sparse march of the cloud-shadow map through the air)
  vec3 Lb = vec3(0.0);
  if (vBeam.w > 0.5 && (isSky < 0.5 || d.y < 0.35)) Lb = vBeamIn(o, d, D, jit);
  // 6) valley fog: low moonlit mist banks pooled in the distant valley floor — marched front to back in 6 log-spaced
  //    segments (exact exponential height integral per segment) × a drifting bank map (clear lanes between banks,
  //    thinner over open water), so near tree lines stay dark against the luminous banks behind them
  float tauV = 0.0; vec3 fogCol = vec3(0.0), Lv = vec3(0.0);
  if (vFogV.x > 0.0 && isSky < 0.5 && D > vFogV.z) {
    float t0 = vFogV.z, t1 = min(D, 14000.0);
    vec3 pf0 = o + d * min(D, t0 + 250.0); pf0.y = abs(pf0.y);
    float cs = vKeyShadow(pf0);
    vec3 C0 = (Jamb + vMoonCol * V_PI * (0.07 + phM) * mix(1.0, cs, vKey.x) * vKey.z + vSunCol * V_PI * (0.07 + phS) * mix(cs, 1.0, vKey.x) * vKey.y) * vMistB.y * vFogV.w;
#ifdef MV_VERTEX_STAGE
    const int NVF = 2;
#else
    const int NVF = 6;
#endif
    float Tacc = 1.0, ta = t0;
    for (int i = 1; i <= NVF; i++) {
      float tb = t0 * pow(t1 / t0, float(i) / float(NVF));
      vec3 pm = o + d * (0.5 * (ta + tb)); pm.y = abs(pm.y);
      vec2 bn = texture(vNoiseTex, (pm.xz + vMistN.zw * 0.6) / 1500.0 + 0.21).rg;
#ifdef MV_VERTEX_STAGE
      // per-vertex (far terrain, foliage): gentle contrast — strong banks alias along the far mesh rings
      float bank = (0.45 + 1.1 * smoothstep(0.3, 0.8, bn.x * 0.75 + bn.y * 0.25)) * vWaterMist(pm);
#else
      float bank = (0.2 + 1.7 * smoothstep(0.38, 0.74, bn.x * 0.75 + bn.y * 0.25)) * vWaterMist(pm);
#endif
      float od = vExpODm(o.y + d.y * ta - (vCustomGround>0.5?vGround(pm).x:0.0), d.y, tb - ta, vFogV.x, vFogV.y) * bank;
      float tr = exp(-min(od, 30.0));
      Lv += Tacc * (1.0 - tr) * C0 * (0.75 + 0.5 * bn.y);
      Tacc *= tr; tauV += od;
      ta = tb;
    }
  }
  tauV = min(tauV, 60.0);
  float Th = exp(-tauH), Tv = exp(-tauV);
  // haze is the far medium; the valley-fog banks sit in front of it (their own front-to-back in-scatter Lv)
  vec3 L = ((Lm + Lg) * Tr + Lr + Lb) * mix(1.0, Th * Tv, 0.5) + Lv * mix(1.0, Th, 0.5) + hazeCol * (1.0 - Th) * Tv;
  vec3 medCol = hazeCol;
  Th *= Tv;
  // debug: single terms (vdebug 8 haze+valley fog, 9 mist, 10 glows, 11 rain veil, 12 beam)
  if (vDebug >= 8) {
    if (vDebug == 8) return vec4(Lv + medCol * (1.0 - Th), 0.0);
    if (vDebug == 9) return vec4(Lm, 0.0);
    if (vDebug == 10) return vec4(Lg, 0.0);
    if (vDebug == 11) return vec4(Lr, 0.0);
    if (vDebug == 12) return vec4(Lb, 0.0);
  }
  return vec4(L, Tm * Tr * Th);
}
#ifndef MV_VERTEX_STAGE
vec4 vAtmos(vec3 P, float isSky){ return vAtmosJ(P, isSky, vIGN(gl_FragCoord.xy)); }
#endif
#ifndef MV_VERTEX_STAGE
vec3 vApplyAtmos(vec3 col, vec3 P){
  if (vDebug == 1) return vec3(vKeyShadow(P)) * 0.2;
  if (vDebug == 2) return col;
  vec4 a = vAtmos(P, 0.0);
  if (vDebug == 3) return a.rgb;
  if (vDebug == 7) { vec3 o = vCam; vec3 dv = P - o; float D = length(dv); return vGlows(o, dv / D, D, 1.0) * 10.0; }
  return col * a.a + a.rgb;
}
#endif
#endif
`;

/** bake a tileable RG value-noise fbm texture (N×N) — mist sheets, rain streaks, detail */
function bakeNoiseTexture(THREE, N = 256, seed = 'valley-noise') {
  const rng = makeRng(seed);
  const data = new Uint8Array(N * N * 4);
  const lat = (P, s) => { const a = new Float32Array(P * P); const r = makeRng(seed + ':' + s + ':' + P); for (let i = 0; i < a.length; i++) a[i] = r(); return a; };
  const fade = (t) => t * t * (3 - 2 * t);
  const vn = (L, P, x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = fade(x - xi), fy = fade(y - yi);
    const i0 = ((xi % P) + P) % P, j0 = ((yi % P) + P) % P, i1 = (i0 + 1) % P, j1 = (j0 + 1) % P;
    const a = L[j0 * P + i0], b = L[j0 * P + i1], c = L[j1 * P + i0], d = L[j1 * P + i1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  const oct = (ch) => [4, 8, 16, 32, 64].map((P, k) => ({ P, L: lat(P, ch + k), a: Math.pow(0.52, k) }));
  const O = [oct('r'), oct('g')];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    for (let c = 0; c < 2; c++) {
      let s = 0, n = 0;
      for (const o of O[c]) { s += o.a * vn(o.L, o.P, (i / N) * o.P, (j / N) * o.P); n += o.a; }
      data[(j * N + i) * 4 + c] = Math.round(255 * clamp(s / n));
    }
    data[(j * N + i) * 4 + 2] = Math.round(255 * rng());
    data[(j * N + i) * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * createAtmosphere(ctx, { sky }) -> { uniforms, glsl, update(t, w, camera, extras), sun/moon visibility, dispose }
 *   uniforms: the sky's public uniforms + the valley uniforms (share them in every valley ShaderMaterial).
 *   extras (per frame, optional): { lights:[{pos,color,intensity,radius}], glows:[{pos,color,gain,radius,range}],
 *            beam:{gain, maxDist, haze}, mistGain, rainEdge, veil, ambientGain }
 */
function createAtmosphere(ctx, opts = {}) {
  const { THREE } = ctx;
  const sky = opts.sky;
  const ground = opts.terrain ? fogTerrain(opts.terrain) : null;
  const horizon = ground?.skylineAt || opts.skylineAt || skylineAt;
  const moonColor = opts.moonColor || [0.62, 0.74, 0.98];
  if (!Array.isArray(moonColor) || moonColor.length !== 3 || !moonColor.every(v => Number.isFinite(v) && v >= 0)) throw new Error('moonColor requires three nonnegative linear components');
  const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  const V4 = () => new THREE.Vector4();
  const noiseTex = bakeNoiseTexture(THREE);
  const U = {
    vGroundMap:{value:ground?.texture||noiseTex}, vGroundBounds:{value:ground?.bounds||new THREE.Vector4(0,0,1,1)}, vCustomGround:{value:ground?1:0}, vWaterMistEnabled:{value: opts.waterMist === false ? 0 : 1},
    vCam: { value: V() }, vTime: { value: 0 },
    vMoonDir: { value: V(0, 1, 0) }, vMoonCol: { value: V() }, vSunDir: { value: V(0, -1, 0) }, vSunCol: { value: V() },
    vKey: { value: new THREE.Vector4(1, 0, 1, 1) },
    vHaze: { value: V4() }, vMistN: { value: V4() }, vMistB: { value: V4() },
    vNoiseTex: { value: noiseTex },
    vPL: { value: Array.from({ length: NPL }, () => V4()) }, vPLc: { value: Array.from({ length: NPL }, () => V()) }, vPLn: { value: 0 },
    vGL: { value: Array.from({ length: NGL }, () => V4()) }, vGLc: { value: Array.from({ length: NGL }, () => V4()) }, vGLn: { value: 0 },
    vRain: { value: V4() }, vBeam: { value: V4() }, vMirror: { value: 0 }, vAmbMist: { value: V() }, vDebug: { value: 0 }, vMoonSh: { value: V4() }, vMoonSh2: { value: V4() }, vBeamO: { value: V(...layout.beamOrigin) }, vEastSh: { value: 0 }, vWet: { value: new THREE.Vector2() }, vHazeB: { value: new THREE.Vector4(1, 0, 0, 0) }, vFogV: { value: V4() },
  };
  const swayUniforms = { vWind: { value: 0.3 }, vWindDir: { value: new THREE.Vector2(0.99, 0.13) }, vSwayT: { value: 0 } };
  const uniforms = { ...(sky ? sky.uniforms : {}), ...U };
  const glsl = (sky ? sky.skyGLSL : '') + GLSL_NOISE + VALLEY_GLSL;
  const state = { sunVis: 0, moonVis: 1, t: 0 };

  function update(t, w, camera, x = {}) {
    state.t = t;
    const cp = camera ? camera.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, 2, 0);
    U.vCam.value.copy(cp);
    U.vTime.value = t;
    swayUniforms.vWind.value = w.wind ?? 0.3;
    { const wd0 = w.windDir || [0.9, 0, 0.12]; swayUniforms.vWindDir.value.set(wd0[0], wd0[2]).normalize(); }
    swayUniforms.vSwayT.value = t;
    // --- direct light (sky lib gives colour/intensity consistent with its rendering) ---
    const li = sky ? sky.getLightInfo() : null;
    const md = w.moonDir, sd = w.sunDir;
    U.vMoonDir.value.set(md[0], md[1], md[2]).normalize();
    U.vSunDir.value.set(sd[0], sd[1], sd[2]).normalize();
    // LIB_COMMON colour convention for moonlight (0.62,0.74,0.98), warmed by the sky's extinction tint when low
    const mI = li ? li.moon.intensity : 0.22 * (w.moonlight ?? 1);
    const mt = li ? li.moon.color : [1, 1, 1];
    const mc = [moonColor[0] * mt[0], moonColor[1] * mt[1], moonColor[2] * mt[2]];
    // day-for-night fill (director: shapes must read at night): moon x2.5, sky ambient x3.5, moonlit aerial haze
    const night = 1 - (w.day ?? 0);
    const d4n = x.dayForNight ?? 1;
    const moonFill = 1 + 1.5 * night * d4n, ambFill = 1 + 2.5 * night * d4n;
    state.night = night; state.hazeBoost = 1 + 0.6 * night * d4n;
    U.vMoonCol.value.set(mc[0], mc[1], mc[2]).multiplyScalar(mI / Math.PI * (x.moonGain ?? 1) * moonFill);
    const sI = li ? li.sun.intensity : 7.9 * (w.day ?? 0);
    const st = li ? li.sun.color : [1.0, 0.95, 0.86];
    U.vSunCol.value.set(st[0], st[1], st[2]).multiplyScalar(sI / Math.PI * (x.sunGain ?? 1));
    // terrain visibility of sun & moon (skyline at their azimuth, seen from the camera region)
    const ref = [cp.x, Math.max(cp.y, 2), cp.z];
    const sunR = sky ? sky.info.sunAngR / (Math.PI / 180) : 0.33, moonR = sky ? sky.info.moonAngR / (Math.PI / 180) : 0.58;
    const sunSky = w.sunElev > -3 && w.sunElev < 15 ? horizon(ref, w.sunAzim) : -90;
    const moonSky = w.moonElev > -3 && w.moonElev < 15 ? horizon(ref, w.moonAzim) : -90;
    state.sunVis = smooth(-sunR, sunR, w.sunElev - sunSky);
    state.moonVis = smooth(-moonR, moonR, w.moonElev - moonSky);
    state.sunSkyline = sunSky; state.moonSkyline = moonSky;
    U.vKey.value.set(sky ? (sky.info.key === 'moon' ? 1 : 0) : 1, state.sunVis, state.moonVis, (x.ambientGain ?? 1) * ambFill);
    U.vHazeB.value.set(state.hazeBoost, (x.hazeLift ?? 0.1) * night, x.groundDetail === false ? 0 : 1, 0);
    U.vDebug.value = x.debug ?? (typeof window !== 'undefined' && window.__valleyDebug) ?? 0;
    // --- fog densities ---
    const mist = w.mist ?? 0.5, rain = w.rain ?? 0;
    const vis = 16000 * (1.15 - 0.5 * mist) * (1 - 0.3 * rain) * (x.hazeVis ?? 1);   // horizontal visibility (m) at y=0
    U.vHaze.value.set(3.9 / vis, 600 + 300 * (1 - mist), (0.0022 + 0.011 * mist * mist) * (x.mistDensity ?? 1), 1.8 + 3.2 * mist);
    const D = sky ? sky.driftAt(t) : t * 3;
    const wd = w.windDir || [0.9, 0, 0.12];
    U.vMistN.value.set(0.75, 1 / 190, -wd[0] * D * 0.05 - t * 0.12, -wd[2] * D * 0.05 - t * 0.35);
    U.vMistB.value.set(x.mistTop ?? 9.5, 0.9, 0.62, x.mistGain ?? 1);
    // valley fog (default: night only, grows with world.mist); per shot: x.valleyFog = {sigma, H, start, gain} | false
    {
      const vf = x.valleyFog === false ? null : (x.valleyFog || {});
      const sig = vf ? (vf.sigma ?? 0.0026 * smooth(0.25, 0.7, mist) * night) : 0;
      U.vFogV.value.set(sig, vf ? vf.H ?? 11 : 11, vf ? vf.start ?? 320 : 320, vf ? vf.gain ?? 1 : 1);
    }
    // isotropic ambient for in-scattering: mean of the sky ambient up/down (JS approx from the sky's estimate)
    const amb = x.ambMist || (li ? null : [0.004, 0.006, 0.01]);
    if (amb) U.vAmbMist.value.set(amb[0], amb[1], amb[2]);
    else if (sky) {
      const A = sky.info; // derive from moon/sun direct light and day (the GPU ambient texture is not readable cheaply)
      const day = w.day ?? 0;
      const k = 0.035 * (1 - day) * mI + day * (0.04 + 0.05 * Math.max(0, Math.sin(Math.max(0, w.sunElev) * Math.PI / 180))) * 7.9 / Math.PI * 0.5 + 0.0008;
      U.vAmbMist.value.set(k * 0.72, k * 0.86, k * 1.1);
      void A;
    }
    // --- practical lights & glows ---
    const L = x.lights || [];
    U.vPLn.value = Math.min(NPL, L.length);
    for (let i = 0; i < U.vPLn.value; i++) {
      const l = L[i];
      U.vPL.value[i].set(l.pos[0], l.pos[1], l.pos[2], l.radius ?? 0.2);
      U.vPLc.value[i].set(l.color[0], l.color[1], l.color[2]).multiplyScalar((l.intensity ?? 1) / Math.PI);
    }
    const G = x.glows || [];
    U.vGLn.value = Math.min(NGL, G.length);
    for (let i = 0; i < U.vGLn.value; i++) {
      const g = G[i];
      U.vGL.value[i].set(g.pos[0], g.pos[1], g.pos[2], g.radius ?? 1.5);
      U.vGLc.value[i].set(g.color[0] * g.gain, g.color[1] * g.gain, g.color[2] * g.gain, g.range ?? 60);
    }
    
    const gap = w.moonGap ?? 0;
    U.vMoonSh.value.set(smooth(0.0, 0.22, rain) * 0.93 * (x.rainShadow ?? 1), (x.beamRadius ?? (22 + 38 * gap)), gap * smooth(0.0, 0.12, rain + 0.02) , 0.3 * (w.cloudCover ?? 0.3));
    U.vEastSh.value = x.eastShadow ?? 0;
    U.vWet.value.set(w.wetness ?? Math.min(1, (w.rain ?? 0) * 1.6), 0.08 + 0.12 * (1 - (w.day ?? 0)));
    U.vMoonSh2.value.set(1 / 420, -(w.windDir || [0.9, 0, 0.12])[0] * D * 0.5, -(w.windDir || [0.9, 0, 0.12])[2] * D * 0.5, x.beamSoft ?? 14);
    // --- rain veil (west half) & moonbeam ---
    U.vRain.value.set(rain * (x.veil ?? 1), x.rainEdge ?? -4, 1 / 2600, x.streak ?? 1);
    U.vBeamO.value.fromArray(x.beamOrigin || layout.beamOrigin);
    const b = x.beam;
    U.vBeam.value.set(b ? b.gain ?? 1 : 0, b ? b.maxDist ?? 500 : 0, b ? b.haze ?? 40 : 0, b && (b.gain ?? 1) > 0 ? 1 : 0);
    return state;
  }
  return {
    THREE, uniforms, swayUniforms, glsl, update, state, noiseTex, sky,
    setMirror(on) { U.vMirror.value = on ? 1 : 0; },
    dispose() { noiseTex.dispose(); ground?.dispose(); },
  };
}

// ===============================================================================================================
// Valley materials — ShaderMaterials sharing the atmosphere uniforms. kinds:
//   'terrain'  vertex colour albedo, aMat = (forest, roughness, f0, wet)
//   'surface'  generic built things (houses, bridge, rocks): colour, aMat = (roughness, f0, ao, pattern), uv in metres
//              pattern: 0 plain, 1 plaster, 2 wood, 3 roof tiles, 4 stone blocks, 5 rough stone
//   'foliage'  tree crowns: colour, aMat = (ao, translucency, leaf scale, wind), wrap lighting
//   'reed'     reeds/grass blades: colour, aMat = (height fraction, phase, stiffness, _), wind sway in the vertex shader
// ===============================================================================================================
const VS_COMMON = (atmosGLSL) => /* glsl */ `
#ifdef VERTEX_ATMOS
#define MV_VERTEX_STAGE 1
${atmosGLSL}
out vec4 vAtm;
#endif
in vec4 aMat;
out vec3 vW; out vec3 vN; out vec3 vCol; out vec4 vMatV; out vec2 vUvM;
uniform float vWind; uniform vec2 vWindDir; uniform float vSwayT;
#ifdef KIND_FLECK
uniform vec4 vFleck;
#endif
void main(){
  vec3 pos = position;
  vec4 w = modelMatrix * vec4(pos, 1.0);
#ifdef KIND_REED
  // closed-form sway: bend grows with height fraction^2; gusts travel along the wind
  float hf = aMat.x;
  float ph = aMat.y + dot(w.xz, vWindDir) * 0.35;
  float s = sin(vSwayT * (1.7 + 0.6 * aMat.z) + ph) * 0.6 + sin(vSwayT * 3.9 + ph * 1.7) * 0.25;
  float bend = (0.12 + 0.35 * vWind) * (0.6 + 0.4 * s) * hf * hf * (1.2 - 0.5 * aMat.z);
  w.xz += vWindDir * bend; w.y -= bend * bend * 0.35;
#endif
#ifdef KIND_FLECK
  // floating petals / leaves: hidden outside the river (x) and bobbing on the ripples
  if (abs(w.x - vFleck.x) > vFleck.y || length(w.xz - cameraPosition.xz) > vFleck.z) w.y -= 1000.0;
  w.y += 0.006 * sin(vSwayT * 1.7 + w.x * 0.9 + w.z * 0.7);
#endif
#ifdef KIND_FOLIAGE
  float sw = sin(vSwayT * 1.3 + aMat.w * 6.283 + w.x * 0.07) * 0.5 + sin(vSwayT * 2.9 + aMat.w * 11.0) * 0.25;
  w.xz += vWindDir * sw * (0.03 + 0.12 * vWind) * aMat.x;
#endif
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
#ifdef USE_COLOR
  vCol = color;
#else
  vCol = vec3(0.5);
#endif
  vMatV = aMat;
  vUvM = uv;
  gl_Position = projectionMatrix * viewMatrix * w;
#ifdef VERTEX_ATMOS
  vAtm = vAtmosJ(w.xyz, 0.0, 0.5);
#endif
}`;

const FS_KIND = {
  // Terrain attribute contract, without any river coordinates, plots, dikes or paths.
  slope: /* glsl */ `
  vec2 grain = texture(vNoiseTex, vW.xz * 0.19).rg;
  float closeDetail = 1.0 - smoothstep(18.0, 110.0, length(vCam - vW));
  vec3 alb = vCol * (0.88 + 0.24 * texture(vNoiseTex, vW.xz * 0.017).r);
  alb *= mix(1.0, 0.8 + 0.4 * grain.r, closeDetail);
  vec3 tangentNoise = vec3(grain.x - 0.5, 0.0, grain.y - 0.5);
  N = normalize(N + (tangentNoise - N * dot(tangentNoise, N)) * closeDetail * 0.24);
  float wet = clamp(vWet.x * vMatV.w, 0.0, 1.0);
  alb *= 1.0 - wet * 0.25;
#ifdef NO_SPEC
  col = vShade(vW, N, V, alb, 1.0, 0.0, 1.0, 0.12, 0.0, 1.0);
#else
  col = vShade(vW, N, V, alb, mix(vMatV.y, 0.3, wet), vMatV.z, 1.0, 0.12, 0.0, 1.0);
#endif
  `,
  terrain: /* glsl */ `
  float dist = length(vCam - vW);
  vec2 nt = texture(vNoiseTex, vW.xz * 0.085).rg;
  float forest = vMatV.x;
  vec3 alb = vCol;
  float can = smoothstep(0.3, 0.78, nt.r);
  alb *= mix(1.0, 0.45 + 0.9 * can, forest);
  N = normalize(N + forest * vec3(nt.g - 0.5, 0.0, nt.r - 0.5) * 0.9);
  float near = 1.0 - smoothstep(25.0, 140.0, dist);
  if (near > 0.0) {
    vec2 nd = texture(vNoiseTex, vW.xz * 0.73 + 0.37).rg;
    alb *= mix(1.0, 0.72 + 0.56 * nd.r, near);
    N = normalize(N + near * vec3(nd.r - 0.5, 0.0, nd.g - 0.5) * 0.35);
  }
  // ---- valley floor: field plots (river-aligned grid, same formula as plotAt() in JS) — flooded paddies that mirror
  //      the sky, young rice, tilled soil, rapeseed, vegetable beds, fallow grass — raised grass dikes between them,
  //      farm tracks on some dikes, a dirt path along each bank, dry / damp patches, contact AO under trees ----
  float fwm = max(fwidth(vW.x) + fwidth(vW.z), 1e-3);             // metres per pixel
  float rough = vMatV.y, f0 = vMatV.z, paddy = 0.0;
  float cxR = vRiverCX(vW.z), hwR = vRiverHW(vW.z), dR = abs(vW.x - cxR), sideR = vW.x < cxR ? -1.0 : 1.0;
  float flatK = smoothstep(0.93, 0.985, N.y) * (1.0 - forest) * (1.0 - smoothstep(10.0, 26.0, vW.y - 3.0 - 0.011 * clamp(dR - hwR - 8.0, 0.0, 700.0)));
  float uF = dR - hwR - 14.0;
  if (vHazeB.z > 0.5 && flatK > 0.0 && uF > 0.0 && dR < 520.0) {
    float Lp; vec4 pl = vPlot(vW, Lp);
    float h = pl.x, e = pl.w;
    vec2 f = pl.yz;
    // field types
    vec3 fa = alb; float fr = 0.9;
    if (h < 0.13) {                                                                                   // flooded paddy
      // organic water outline inside the plot: 1–4 m muddy / grassy margin from a warped edge distance
      vec2 wn = texture(vNoiseTex, vW.xz * 0.055 + h * 11.0).rg;
      float ew = e + 7.0 * (wn.x - 0.5) + 3.0 * (wn.y - 0.5);
      // only the low parts of the plot hold water: large organic pools, not the whole rectangle
      float lowPart = texture(vNoiseTex, vW.xz * 0.018 + h * 7.0).g;
      float water = smoothstep(1.6, 3.2, ew) * smoothstep(0.38, 0.5, lowPart + 0.12 * (wn.y - 0.5));
      // margin: dark wet earth with grass tufts; fringe of emergent grass / reeds just inside the waterline
      float tuft = texture(vNoiseTex, vW.xz * 0.9 + h * 5.0).r;
      vec3 earth = mix(vec3(0.05, 0.043, 0.033), vec3(0.055, 0.075, 0.034), smoothstep(0.45, 0.7, tuft));
      float fringe = (1.0 - smoothstep(0.25, 0.9, water)) * smoothstep(0.02, 0.2, water) * smoothstep(0.5, 0.62, tuft);
      // rows of young seedlings breaking the water here and there
      float seedl = texture(vNoiseTex, vW.xz * 0.045 + h * 13.0).r;
      float rowsS = step(0.62, fract(f.x * 30.0 / 0.35)) * smoothstep(0.45, 0.7, seedl + 0.35 * fract(h * 37.0));
      fa = mix(earth, vec3(0.03, 0.045, 0.028), fringe);
      fa = mix(fa, vec3(0.022, 0.026, 0.022), water * (1.0 - fringe));
      fr = mix(0.85, 0.12, water);
      paddy = water * (1.0 - fringe) * (1.0 - 0.7 * rowsS * (1.0 - smoothstep(0.03, 0.15, fwm)));
    }
    else if (h < 0.44) {                                                                              // young rice / wheat
      float rows = 0.5 + 0.5 * sin(f.x * 6.2831853 * 30.0 / 0.3);
      fa = vec3(0.055, 0.085, 0.035) * mix(0.8 + 0.4 * rows, 1.0, smoothstep(0.02, 0.08, fwm));
    } else if (h < 0.66) {                                                                            // tilled soil, furrows
      float fur = 0.5 + 0.5 * sin(f.y * 6.2831853 * Lp / 0.45);
      fa = vec3(0.085, 0.066, 0.05) * mix(0.75 + 0.5 * fur, 1.0, smoothstep(0.03, 0.12, fwm));
    } else if (h < 0.76) fa = vec3(0.16, 0.15, 0.04);                                                 // rapeseed in flower
    else if (h < 0.88) {                                                                              // vegetable beds
      float bed = step(0.5, fract(f.x * 30.0 / 1.4));
      fa = mix(vec3(0.07, 0.058, 0.045), vec3(0.04, 0.07, 0.03), mix(bed, 0.5, smoothstep(0.1, 0.4, fwm)));
    } else fa = alb * vec3(1.05, 1.0, 0.85);                                                         // fallow grass
    fa *= 0.85 + 0.3 * texture(vNoiseTex, vW.xz * 0.021 + h * 7.0).r;
    // dikes (0.56 m, grassy, raised, pale) with a dark wet ditch on the field side
    float aa = fwm * 0.5;
    float dike = 1.0 - smoothstep(0.28 - aa, 0.28 + aa, e);
    float ditch = (1.0 - smoothstep(0.62 - aa, 0.62 + aa, e)) - dike;
    float farK = smoothstep(0.3, 1.4, fwm);
    dike = mix(dike, 0.045, farK); ditch = mix(ditch, 0.05, farK);
    alb = mix(alb, fa, flatK);
    alb = mix(alb, alb * 0.45, ditch * flatK);
    alb = mix(alb, (h < 0.13 ? vec3(0.06, 0.062, 0.04) : vec3(0.11, 0.125, 0.065)) * (0.8 + 0.4 * nt.g), dike * flatK);
    paddy *= (1.0 - dike) * flatK;
    rough = mix(rough, fr, flatK * (1.0 - dike));
  }
  // dirt path along the bank (1.3–3.8 m inland of the embankment / bank top), with wheel ruts and puddles
  float pathK = (1.0 - smoothstep(0.8, 1.6, abs(dR - hwR - 6.2 - 1.2 * sin(vW.z * 0.021)))) * (1.0 - forest);
  if (pathK > 0.0) {
    float rut = 1.0 - smoothstep(0.1, 0.3, abs(abs(dR - hwR - 6.2 - 1.2 * sin(vW.z * 0.021)) - 0.55));
    vec3 pc = vec3(0.14, 0.12, 0.095) * (0.85 + 0.3 * texture(vNoiseTex, vW.xz * 0.3).r) * mix(1.0, 0.8, rut * (1.0 - smoothstep(0.05, 0.2, fwm)));
    alb = mix(alb, pc, pathK);
    rough = mix(rough, 0.75, pathK);
  }
  // soft albedo variation: dry (pale) and damp (dark) patches
  vec2 dn = texture(vNoiseTex, vW.xz * 0.013 + 0.61).rg;
  alb *= mix(vec3(1.0), mix(vec3(0.82, 0.84, 0.86), vec3(1.12, 1.08, 0.95), dn.x), 0.6 * (1.0 - forest));
  // contact AO / tree shadow blobs (baked from the vegetation placement)
  vec2 aoUv = (vW.xz - uGroundAORect.xy) / uGroundAORect.zw;
  float cao = (aoUv.x > 0.0 && aoUv.x < 1.0 && aoUv.y > 0.0 && aoUv.y < 1.0) ? texture(uGroundAO, aoUv).r : 1.0;
  alb *= mix(0.35, 1.0, cao);
  float wet = mix(vWet.y, vWet.x, smoothstep(4.0, -4.0, vW.x)) * (0.35 + 0.65 * vMatV.w) * (1.0 - forest);
  alb *= 1.0 - 0.3 * wet;
#ifdef NO_SPEC
  col = vShade(vW, N, V, alb, 1.0, 0.0, cao, 0.2, 0.0, 1.0);
#else
  col = vShade(vW, N, V, alb, mix(rough, 0.25, wet * 0.7), max(f0, 0.03 * wet), cao, 0.2, 0.0, 1.0);
#endif
  // flooded paddies: muddy water reflecting the sky (Fresnel) — rippled by the breeze, darker, patchy (wind lanes,
  // duckweed), so they read as water in a field, not as tiles
  if (paddy > 0.01) {
    vec2 rn = texture(vNoiseTex, vW.xz * 0.35 + vTime * vec2(0.012, 0.007)).rg - 0.5;
    vec3 Np = normalize(vec3(rn.x * 0.12, 1.0, rn.y * 0.12));
    float nvP = max(dot(Np, V), 1e-3);
    float Fp = 0.02 + 0.98 * pow(1.0 - nvP, 5.0);
    vec3 Rp = reflect(-V, Np); Rp.y = abs(Rp.y) + 0.002;
    float patchy = 0.55 + 0.45 * smoothstep(0.3, 0.7, texture(vNoiseTex, vW.xz * 0.011 + 0.27).g);
    col = mix(col, skyMap(Rp) * 0.2 * patchy, paddy * Fp * mix(0.65, 0.38, vKey.y));
  }`,
  surface: /* glsl */ `
  vec3 alb = vCol; float rough = vMatV.x; float f0 = vMatV.y; float ao = vMatV.z;
  int pat = int(vMatV.w + 0.5);
  vec2 u = vUvM;
  float fwM = length(fwidth(u)) + 1e-4;                 // metres per pixel (pattern anti-aliasing)
  if (pat == 1) {          // plaster: stains, rain streaks from above, damp band above the plinth, soft wash
    float st = texture(vNoiseTex, u * vec2(0.23, 0.31)).r;
    float st2 = texture(vNoiseTex, u * vec2(1.3, 0.4) + 0.5).g;
    float streak = texture(vNoiseTex, vec2(u.x * 1.7 + 0.13, u.y * 0.045)).r;
    alb *= 0.8 + 0.28 * st;
    alb *= 1.0 - 0.28 * smoothstep(0.52, 0.8, streak) * (1.0 - smoothstep(0.02, 0.12, fwM));
    alb *= mix(1.0, 0.6 + 0.25 * st2, smoothstep(2.6, 1.5, u.y) * 0.85);
  } else if (pat == 6) {   // paper lattice (门窗格): pale paper between dark wooden bars (grid 0.14 m), AA by footprint
    vec2 g = abs(fract(u / 0.14) - 0.5) * 0.14;           // distance (m) to the nearest bar centre
    float bar = 1.0 - smoothstep(0.011 - fwM * 0.5, 0.011 + fwM * 0.5, min(g.x, g.y));
    float barAvg = clamp(0.32, 0.0, 1.0);                  // coverage of the bars when unresolved
    bar = mix(bar, barAvg, smoothstep(0.02, 0.06, fwM));
    vec3 paper = vec3(0.44, 0.41, 0.35) * (0.85 + 0.25 * texture(vNoiseTex, u * 0.6).r);
    alb = mix(paper, vec3(0.045, 0.03, 0.021), bar);
    rough = mix(0.9, 0.7, bar);
  } else if (pat == 2) {   // wood: vertical grain + weathering
    float g = texture(vNoiseTex, vec2(u.x * 3.1, u.y * 0.07)).r;
    alb *= 0.7 + 0.55 * g;
  } else if (pat == 3) {   // roof tiles (合瓦/筒瓦): rolled cap rows every 0.26 m across (u.x), courses down the slope (u.y)
    float cx = fract(u.x / 0.26);
    float capD = (cx - 0.17) / 0.17;                        // -1..1 across the rolled cap (cx 0..0.34)
    float cap = 1.0 - smoothstep(0.85, 1.0, abs(capD));
    float gap = smoothstep(0.3, 0.36, cx) * (1.0 - smoothstep(0.36, 0.44, cx)) + (1.0 - smoothstep(0.0, 0.03, cx));
    float row = fract(u.y / 0.24);
    float res = 1.0 - smoothstep(0.012, 0.05, fwM);         // resolvable detail
    vec2 nn = texture(vNoiseTex, u * vec2(0.11, 0.3)).rg;
    float moss = smoothstep(0.55, 0.8, texture(vNoiseTex, u * vec2(0.05, 0.09) + 0.3).g);
    alb *= (0.8 + 0.38 * nn.r) * mix(1.0, (0.85 + 0.2 * smoothstep(0.0, 0.2, row)) * (1.0 + 0.18 * cap) * (1.0 - 0.55 * gap), res);
    alb = mix(alb, alb * vec3(0.8, 0.95, 0.7), moss * 0.5);
    vec3 tU = normalize(cross(N, vec3(0.0, 1.0, 0.0)) + 1e-4);
    N = normalize(N + tU * clamp(capD, -1.0, 1.0) * cap * 0.75 * res + tU * sin(cx * 6.2831853) * 0.2 * res);
    ao *= mix(1.0, (0.78 + 0.22 * cap) * (1.0 - 0.4 * gap), res);
  } else if (pat == 4) {   // dressed stone blocks
    vec2 b = u / vec2(0.9, 0.42); b.x += floor(b.y) * 0.5;
    vec2 f = abs(fract(b) - 0.5);
    float joint = smoothstep(0.47, 0.5, max(f.x * 0.9, f.y));
    float bn = texture(vNoiseTex, floor(b) * 0.137).b;
    alb *= (0.8 + 0.35 * bn) * (1.0 - 0.45 * joint);
    rough = mix(rough, 0.95, joint);
  } else if (pat == 5) {   // rough stone / boulders
    float n = texture(vNoiseTex, u * 0.7).r;
    alb *= 0.7 + 0.6 * n;
  }
  float wet = mix(vWet.y, vWet.x, smoothstep(4.0, -4.0, vW.x)) * smoothstep(0.35, 0.7, N.y + 0.25 * float(pat == 3));
  alb *= 1.0 - 0.38 * wet; rough = mix(rough, 0.12, wet * 0.85); f0 = mix(f0, 0.045, wet);
  col = vShade(vW, N, V, alb, rough, f0, ao, 0.05, 0.0, 1.0);`,
  fleck: /* glsl */ `
  vec3 alb = vCol;
  if (dot(N, V) < 0.0) N = -N;
  col = vShade(vW, N, V, alb, 0.6, 0.02, 1.0, 0.3, 0.35, 1.0);`,
  foliage: /* glsl */ `
  vec4 lt = texture(uLeafTex, vUvM);
  if (lt.a < 0.4) discard;
  outA = smoothstep(0.4, 0.62, lt.a);
  vec3 alb = vCol * (0.5 + 0.95 * lt.b);
  vec3 T1 = normalize(cross(N, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0)); vec3 T2 = cross(N, T1);
  N = normalize(N + (lt.r - 0.5) * 1.8 * T1 + (lt.g - 0.5) * 1.8 * T2);
  col = vShade(vW, N, V, alb, 0.85, 0.0, vMatV.x * (0.55 + 0.45 * lt.b), 0.45, vMatV.y, 1.0);`,
  reed: /* glsl */ `
  vec3 alb = vCol * (0.75 + 0.35 * vMatV.x);
  if (dot(N, V) < 0.0) N = -N;
  col = vShade(vW, N, V, alb, 0.6, 0.02, 0.55 + 0.45 * vMatV.x, 0.5, 0.45, 1.0);`,
};

/** create a valley ShaderMaterial of the given kind; opts: {side, defines, extraUniforms, emissive} */
function makeValleyMaterial(atmos, kind, opts = {}) {
  const THREE = atmos.THREE;
  const fs = /* glsl */ `
${atmos.glsl}
in vec3 vW; in vec3 vN; in vec3 vCol; in vec4 vMatV; in vec2 vUvM;
#ifdef VERTEX_ATMOS
in vec4 vAtm;
#endif
layout(location = 0) out vec4 fragColor;
uniform sampler2D uLeafTex;
uniform sampler2D uGroundAO; uniform vec4 uGroundAORect;
void main(){
  vec3 V = normalize(vCam - vW);
  vec3 N = normalize(vN);
  vec3 col = vec3(0.0);
  float outA = 1.0;
  ${FS_KIND[kind]}
#ifdef VERTEX_ATMOS
  col = vDebug == 2 ? col : col * vAtm.a + vAtm.rgb;
#else
  col = vApplyAtmos(col, vW);
#endif
  fragColor = vec4(col, outA);
}`;
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VS_COMMON(atmos.glsl), fragmentShader: fs,
    uniforms: { ...atmos.uniforms, ...atmos.swayUniforms, ...(opts.extraUniforms || {}) },
    vertexColors: true,
    side: opts.side ?? THREE.FrontSide,
    defines: { ['KIND_' + kind.toUpperCase()]: 1, ...(opts.vertexAtmos ? { VERTEX_ATMOS: 1 } : {}), ...(opts.defines || {}) },
    alphaToCoverage: !!opts.alphaToCoverage,
  });
  m.name = 'valley.' + kind;
  return m;
}

// ===============================================================================================================
// Geometry builders (deterministic, start-up only)
// ===============================================================================================================
const NEAR_RECT = { x0: -360, x1: 360, z0: -560, z1: 520 };

function axis(ranges, extra = []) {
  const v = [];
  for (const [a, b, st] of ranges) for (let x = a; x < b - 1e-6; x += st) v.push(+x.toFixed(4));
  v.push(ranges[ranges.length - 1][1]);
  for (const e of extra) v.push(e);
  v.sort((p, q) => p - q);
  const out = [];
  for (const x of v) if (!out.length || x - out[out.length - 1] > 0.015) out.push(x);
  return out;
}

/** per-vertex terrain look: albedo (linear) + material (forest, roughness, f0, wet) */
function terrainLook(x, z, y, ny) {
  const cx = riverCenter(z), hw = riverHalfWidth(z), d = Math.abs(x - cx);
  const hills = hillsAt(x, z) * smooth(hw + 25, hw + 150, d);
  const n1 = gnoise2(x / 37 + 1.7, z / 37 - 2.3), n2 = gnoise2(x / 190 - 4.1, z / 190 + 3.3);
  // valley floor: dormant grass & young green, fields
  let r = mix(0.12, 0.08, 0.5 + 0.5 * n2), g = mix(0.112, 0.106, 0.5 + 0.5 * n2), b = mix(0.075, 0.052, 0.5 + 0.5 * n2);
  const k = 0.85 + 0.25 * n1; r *= k; g *= k; b *= k;
  let forest = 0, rough = 0.9, f0 = 0, wet = 0;
  // waterline mud / stones
  const mud = smooth(0.9, 0.1, y) * smooth(hw + 14, hw - 2, d);
  if (mud > 0) { r = mix(r, 0.052, mud); g = mix(g, 0.047, mud); b = mix(b, 0.04, mud); rough = mix(rough, 0.4, mud); f0 = mix(f0, 0.035, mud); wet = mud; }
  // forested hills
  const fo = smooth(6, 38, hills) * (0.75 + 0.25 * n1);
  if (fo > 0) { r = mix(r, 0.045, fo); g = mix(g, 0.062, fo); b = mix(b, 0.041, fo); forest = fo; }
  // rock on steep slopes
  const rock = smooth(0.8, 0.62, ny) * smooth(10, 40, hills);
  if (rock > 0) { r = mix(r, 0.11, rock); g = mix(g, 0.108, rock); b = mix(b, 0.1, rock); forest *= 1 - rock; rough = mix(rough, 0.75, rock); }
  return [r, g, b, forest, rough, f0, wet];
}

function finishGeometry(THREE, pos, idx, look = true) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx.length > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  g.computeVertexNormals();
  if (look) {
    const n = pos.length / 3, nrm = g.attributes.normal.array;
    const col = new Float32Array(n * 3), mat = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const L = terrainLook(pos[i * 3], pos[i * 3 + 2], pos[i * 3 + 1], nrm[i * 3 + 1]);
      col[i * 3] = L[0]; col[i * 3 + 1] = L[1]; col[i * 3 + 2] = L[2];
      mat[i * 4] = L[3]; mat[i * 4 + 1] = L[4]; mat[i * 4 + 2] = L[5]; mat[i * 4 + 3] = L[6];
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aMat', new THREE.BufferAttribute(mat, 4));
  }
  g.computeBoundingSphere(); g.computeBoundingBox();
  return g;
}

/** near grid (non-uniform, dense at the banks and caller placements), split into chunks */
function buildNearChunks(THREE) {
  const R = NEAR_RECT;
  const xs = axis([[R.x0, -150, 12], [-150, -96, 3], [-96, -56, 1], [-56, -46, 2.5], [-46, 46, 13], [46, 56, 2.5], [56, 96, 1], [96, 150, 3], [150, R.x1, 12]], [-60, -59.97, 60, 59.97, -60.35, 60.35]);
  const zs = axis([[R.z0,-120,8],[-120,120,2],[120,R.z1,8]]);
  const H = new Float32Array(xs.length * zs.length);
  for (let j = 0; j < zs.length; j++) for (let i = 0; i < xs.length; i++) H[j * xs.length + i] = heightAt(xs[i], zs[j]);
  // chunk boundaries (indices)
  const cutsX = [0, xs.findIndex((x) => x >= -150), xs.findIndex((x) => x >= -46), xs.findIndex((x) => x >= 46), xs.findIndex((x) => x >= 150), xs.length - 1];
  const zc = [R.z0, -300, -200, -120, -40, 40, 120, 300, R.z1];
  const cutsZ = zc.map((z, k) => (k === zc.length - 1 ? zs.length - 1 : zs.findIndex((v) => v >= z)));
  const chunks = [];
  for (let cj = 0; cj < cutsZ.length - 1; cj++) for (let ci = 0; ci < cutsX.length - 1; ci++) {
    const i0 = cutsX[ci], i1 = cutsX[ci + 1], j0 = cutsZ[cj], j1 = cutsZ[cj + 1];
    const nx = i1 - i0 + 1, nz = j1 - j0 + 1;
    const pos = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = (j * nx + i) * 3; pos[k] = xs[i0 + i]; pos[k + 1] = H[(j0 + j) * xs.length + i0 + i]; pos[k + 2] = zs[j0 + j];
    }
    const idx = [];
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      const ya = pos[a * 3 + 1], yb = pos[b * 3 + 1], yc = pos[c * 3 + 1], yd = pos[d * 3 + 1];
      if (Math.max(ya, yb, yc, yd) < -0.7) continue;           // river bed under the opaque water
      idx.push(a, c, b, b, c, d);
    }
    if (!idx.length) continue;
    chunks.push(finishGeometry(THREE, pos, idx));
  }
  return chunks;
}

/** far polar mesh (log-spaced rings, fine azimuth for crisp far silhouettes), sectors × bands */
function buildFarChunks(THREE, { NT = 832, NR = 84, r0 = 300, r1 = 30000, sectors = 16, bands = [0, 22, 44, 64, 83] } = {}) {
  const R = NEAR_RECT, m = 2;
  const inside = (x, z) => x > R.x0 + m && x < R.x1 - m && z > R.z0 + m && z < R.z1 - m;
  const rr = Array.from({ length: NR }, (_, j) => r0 * Math.pow(r1 / r0, j / (NR - 1)));
  const chunks = [];
  const per = NT / sectors;
  for (let s = 0; s < sectors; s++) for (let bnd = 0; bnd < bands.length - 1; bnd++) {
    const j0 = bands[bnd], j1 = bands[bnd + 1];
    const nI = per + 1, nJ = j1 - j0 + 1;
    const pos = new Float32Array(nI * nJ * 3);
    for (let j = 0; j < nJ; j++) for (let i = 0; i < nI; i++) {
      const a = ((s * per + i) / NT) * Math.PI * 2, r = rr[j0 + j];
      const x = Math.sin(a) * r, z = -Math.cos(a) * r;
      const k = (j * nI + i) * 3;
      pos[k] = x; pos[k + 2] = z;
      pos[k + 1] = heightAt(x, z) - (inside(x, z) ? 3 : 0);
    }
    const idx = [];
    for (let j = 0; j < nJ - 1; j++) for (let i = 0; i < nI - 1; i++) {
      const a = j * nI + i, b = a + 1, c = a + nI, d = c + 1;
      const P = (q) => [pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2]];
      const pa = P(a), pb = P(b), pc = P(c), pd = P(d);
      if (inside(pa[0], pa[2]) && inside(pb[0], pb[2]) && inside(pc[0], pc[2]) && inside(pd[0], pd[2])) continue;
      if (Math.max(pa[1], pb[1], pc[1], pd[1]) < -0.7) continue;
      idx.push(a, b, c, b, d, c);
    }
    if (!idx.length) continue;
    chunks.push(finishGeometry(THREE, pos, idx));
  }
  return chunks;
}

// ---- merged-geometry writer ----
class Batch {
  constructor() { this.p = []; this.n = []; this.c = []; this.m = []; this.uv = []; this.i = []; }
  vert(p, n, c, m, uv = [0, 0]) { this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.c.push(c[0], c[1], c[2]); this.m.push(m[0], m[1], m[2], m[3]); this.uv.push(uv[0], uv[1]); return this.p.length / 3 - 1; }
  tri(a, b, c) { this.i.push(a, b, c); }
  get count() { return this.p.length / 3; }
  build(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.m, 4));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

/** a lumpy crown blob (ellipsoid with noise), appended to batch b */
function crownBlob(b, c, R, H, col, rng, { segs = 7, rings = 4, trans = 0.3, leaf = 0.9, lump = 0.22, flatBottom = 0.35 } = {}) {
  const ph = rng() * 100, sway = rng();
  const top = b.vert([c[0], c[1] + H * (1 + lump * 0.3 * (rng() - 0.5)), c[2]], [0, 1, 0], col, [1, trans, leaf, sway]);
  const ringIdx = [];
  for (let r = 1; r <= rings; r++) {
    const v = r / rings;                        // 0 top .. 1 bottom
    const el = Math.PI * 0.5 - v * Math.PI * (0.5 + 0.5 * (1 - flatBottom));
    const row = [];
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2 + (r % 2) * Math.PI / segs;
      const k = 1 + lump * (0.6 * gnoise1(a * 1.6 + ph + r * 0.7, 3) + 0.4 * (rng() - 0.5));
      const cr = Math.cos(el) * R * k, sy = Math.sin(el) * H * k;
      const p = [c[0] + Math.cos(a) * cr, c[1] + sy, c[2] + Math.sin(a) * cr];
      const nn = [Math.cos(a) * Math.cos(el), Math.sin(el) * 1.2 + 0.25, Math.sin(a) * Math.cos(el)];
      const l = Math.hypot(nn[0], nn[1], nn[2]);
      const ao = clamp(0.35 + 0.65 * (Math.sin(el) * 0.5 + 0.5));
      row.push(b.vert(p, [nn[0] / l, nn[1] / l, nn[2] / l], col, [ao, trans, leaf, sway]));
    }
    ringIdx.push(row);
  }
  for (let s = 0; s < segs; s++) b.tri(top, ringIdx[0][(s + 1) % segs], ringIdx[0][s]);
  for (let r = 0; r < rings - 1; r++) for (let s = 0; s < segs; s++) {
    const a = ringIdx[r][s], bb = ringIdx[r][(s + 1) % segs], c2 = ringIdx[r + 1][s], d = ringIdx[r + 1][(s + 1) % segs];
    b.tri(a, bb, c2); b.tri(bb, d, c2);
  }
  // bottom cap
  const last = ringIdx[rings - 1];
  const bc = b.vert([c[0], c[1] - H * flatBottom * 0.8, c[2]], [0, -1, 0], col, [0.25, trans, leaf, sway]);
  for (let s = 0; s < segs; s++) b.tri(bc, last[s], last[(s + 1) % segs]);
}
/** tapered trunk (surface kind: wood) */
function trunk(b, base, top, r0, r1, col, segs = 6) {
  const i0 = [], i1 = [];
  for (let s = 0; s < segs; s++) {
    const a = (s / segs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    i0.push(b.vert([base[0] + ca * r0, base[1], base[2] + sa * r0], [ca, 0, sa], col, [0.9, 0, 0.8, 2], [s / segs * 2 * Math.PI * r0, 0]));
    i1.push(b.vert([top[0] + ca * r1, top[1], top[2] + sa * r1], [ca, 0, sa], col, [0.9, 0, 0.8, 2], [s / segs * 2 * Math.PI * r0, top[1] - base[1]]));
  }
  for (let s = 0; s < segs; s++) { const a = i0[s], bb = i0[(s + 1) % segs], c = i1[s], d = i1[(s + 1) % segs]; b.tri(a, c, bb); b.tri(bb, c, d); }
}

/** silhouette crests seen from the valley centre: local maxima of h along radial rays (near-skyline ones) */
function crestPoints(stepDeg = 0.42) {
  const out = [];
  const eye = 6;
  for (let az = 0; az < 360; az += stepDeg) {
    const dx = Math.sin(az * D2R), dz = -Math.cos(az * D2R);
    const rs = [], hs = [];
    for (let r = 330; r < 8500; r = r * 1.016 + 1) { rs.push(r); hs.push(heightAt(dx * r, dz * r)); }
    let maxE = -90;
    for (let i = 1; i < rs.length - 1; i++) {
      const h1 = hs[i];
      if (!(h1 > hs[i - 1] && h1 >= hs[i + 1] && h1 > 12)) { continue; }
      // prominence along the ray (±6 samples ≈ ±10 %)
      let lo1 = h1, lo2 = h1;
      for (let k = 1; k <= 6; k++) { if (i - k >= 0) lo1 = Math.min(lo1, hs[i - k]); if (i + k < hs.length) lo2 = Math.min(lo2, hs[i + k]); }
      const prom = h1 - Math.max(lo1, lo2);
      const e = Math.atan2(h1 - eye, rs[i]) / D2R;
      if (prom > 4 + 0.04 * h1 && e > maxE - 0.7) out.push({ x: dx * rs[i], z: dz * rs[i], h: h1, r: rs[i], az, e });
      if (e > maxE) maxE = e;
    }
  }
  return out;
}


const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** tapered tube along a polyline (branches, trunks, culms) — 'surface' material, wood pattern */
function tube(b, pts, radii, col, segs = 6) {
  // densify with Catmull-Rom-ish midpoints for gentle curves
  const P = [], Rr = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < 3; k++) {
      const t = k / 3, t2 = t * t, t3 = t2 * t;
      P.push([0, 1, 2].map((c) => 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3)));
      Rr.push(radii[i] + (radii[i + 1] - radii[i]) * t);
    }
  }
  P.push(pts[pts.length - 1]); Rr.push(radii[radii.length - 1]);
  let prevRing = null, len = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[Math.max(0, i - 1)], c = P[Math.min(P.length - 1, i + 1)];
    let d = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; const dl = Math.hypot(...d) || 1; d = d.map((v) => v / dl);
    const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let u = [d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]]; const ul = Math.hypot(...u); u = u.map((v) => v / ul);
    const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
    if (i > 0) len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]);
    const ring = [];
    for (let s = 0; s <= segs; s++) {
      const ang = (s / segs) * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
      const n = [u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa];
      const r = Rr[i];
      ring.push(b.vert([P[i][0] + n[0] * r, P[i][1] + n[1] * r, P[i][2] + n[2] * r], n, col, [0.85, 0.0, 0.85, 2], [ang * 0.3, len]));
    }
    if (prevRing) for (let s = 0; s < segs; s++) { b.tri(prevRing[s], ring[s], prevRing[s + 1]); b.tri(prevRing[s + 1], ring[s], ring[s + 1]); }
    prevRing = ring;
  }
}
/** crossed alpha cards of a leaf cluster: centre c, size w×h, volume centre vc (normals), atlas tile (0 clump 1 strand 2 feather) */
const ATLAS_TILES = 4;
function clumpCards(b, c, w, h, vc, col, rng, tile = 0, n = 2, trans = 0.3) {
  const yaw0 = rng() * Math.PI;
  for (let k = 0; k < n; k++) {
    const yaw = yaw0 + (k * Math.PI) / n + (rng() - 0.5) * 0.5, tilt = (rng() - 0.5) * 0.5;
    const ax = [Math.cos(yaw), 0, Math.sin(yaw)];
    const up = [-Math.sin(tilt) * Math.sin(yaw), Math.cos(tilt), Math.sin(tilt) * Math.cos(yaw)];
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const ids = corners.map(([sx, sy]) => {
      const p = [c[0] + ax[0] * sx * w * 0.5 + up[0] * sy * h * 0.5, c[1] + ax[1] * sx * w * 0.5 + up[1] * sy * h * 0.5, c[2] + ax[2] * sx * w * 0.5 + up[2] * sy * h * 0.5];
      let nn = [p[0] - vc[0], (p[1] - vc[1]) * 1.3 + 0.4 * h, p[2] - vc[2]]; const l = Math.hypot(...nn) || 1; nn = nn.map((v) => v / l);
      const ao = clamp(0.45 + 0.55 * (sy * 0.5 + 0.5) * (0.6 + 0.4 * nn[1]));
      return b.vert(p, nn, col, [ao, trans, tile, rng()], [(tile + 0.03 + 0.94 * (sx * 0.5 + 0.5)) / ATLAS_TILES, sy * 0.5 + 0.5]);
    });
    b.tri(ids[0], ids[1], ids[2]); b.tri(ids[0], ids[2], ids[3]);
  }
}
/** a hanging willow strand card (tile 1): top anchor, length, width, facing yaw */
function strandCard(b, top, len, wid, yaw, vc, col, rng, rows = 4) {
  const out = [(top[0] - vc[0]) * 0.08, 0, (top[2] - vc[2]) * 0.08];
  const sw = rng(), twist = (rng() - 0.5) * 1.2, bow = 0.04 + 0.08 * rng();
  let prev = null;
  for (let r = 0; r <= rows; r++) {
    const f = r / rows;
    const yw = yaw + twist * f;                                   // the strand bundle twists as it hangs
    const ax = [Math.cos(yw) * wid * 0.5 * (1 - 0.35 * f), 0, Math.sin(yw) * wid * 0.5 * (1 - 0.35 * f)];
    const p = [top[0] + out[0] * f * f * len + Math.cos(yaw) * bow * len * f * (1 - f), top[1] - len * f, top[2] + out[2] * f * f * len + Math.sin(yaw) * bow * len * f * (1 - f)];
    let nn = [p[0] - vc[0], 0.35, p[2] - vc[2]]; const l = Math.hypot(...nn) || 1; nn = nn.map((v) => v / l);
    const cc = [col[0] * (1 + 0.35 * f), col[1] * (1 + 0.3 * f), col[2] * (1 + 0.1 * f)];   // paler new-leaf tips
    const a0 = b.vert([p[0] - ax[0], p[1], p[2] - ax[2]], nn, cc, [0.9 - 0.35 * f, 0.55, 1, sw], [(1 + 0.03) / ATLAS_TILES, 1 - f]);
    const a1 = b.vert([p[0] + ax[0], p[1], p[2] + ax[2]], nn, cc, [0.9 - 0.35 * f, 0.55, 1, sw], [(1 + 0.97) / ATLAS_TILES, 1 - f]);
    if (prev) { b.tri(prev[0], a0, prev[1]); b.tri(prev[1], a0, a1); }
    prev = [a0, a1];
  }
}
/** procedural leaf atlas 1024×256: tile 0 broadleaf clump, 1 willow strand bundle, 2 bamboo feather, 3 pine needle pad.
 *  A = coverage, RG = leaf tilt (normal perturbation), B = self-shadow/brightness */
function bakeLeafAtlas(THREE, seed = 'leaf-atlas') {
  const N = 256, Wd = N * ATLAS_TILES;
  const rng = makeRng(seed);
  const A = new Float32Array(Wd * N), R = new Float32Array(Wd * N).fill(0.5), G = new Float32Array(Wd * N).fill(0.5), B = new Float32Array(Wd * N).fill(0.5);
  const leaf = (tile, cx, cy, len, wid, ang, bright) => {   // cx, cy, len, wid in tile px
    const ca = Math.cos(ang), sa = Math.sin(ang), r = Math.ceil(len) + 1;
    const tx = (rng() - 0.5) * 0.8, ty = (rng() - 0.5) * 0.8;
    for (let y = Math.max(4, Math.floor(cy - r)); y <= Math.min(N - 5, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(4, Math.floor(cx - r)); x <= Math.min(N - 5, Math.ceil(cx + r)); x++) {
        const dx = x - cx, dy = y - cy;
        const u = (dx * ca + dy * sa) / len, v = (-dx * sa + dy * ca) / wid;
        const d = u * u + v * v * (1 + 0.6 * u);
        if (d > 1) continue;
        const k = y * Wd + tile * N + x;
        A[k] = Math.max(A[k], 1 - Math.pow(d, 4));
        R[k] = 0.5 + tx * 0.5 + 0.12 * v; G[k] = 0.5 + ty * 0.5; B[k] = bright * (0.8 + 0.2 * (1 - d));
      }
    }
  };
  // tile 0: clump of sub-clusters, ragged outline with gaps
  const subs = Array.from({ length: 9 }, () => { const a = rng() * Math.PI * 2, r = 0.3 * Math.sqrt(rng()); return [0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r * 0.9, 0.08 + 0.08 * rng()]; });
  for (let k = 0; k < 520; k++) {
    const sc = subs[Math.floor(rng() * subs.length)];
    const g1 = (rng() + rng() + rng() - 1.5) * 0.9, g2 = (rng() + rng() + rng() - 1.5) * 0.9;
    const cx = (sc[0] + g1 * sc[2]) * N, cy = (sc[1] + g2 * sc[2]) * N;
    if ((cx / N - 0.5) ** 2 + (cy / N - 0.5) ** 2 > 0.215) continue;
    const bright = 0.35 + 0.65 * clamp((cy / N - 0.15) / 0.8);
    leaf(0, cx, cy, 5 + 6 * rng(), 2.2 + 2 * rng(), rng() * Math.PI, bright);
  }
  // tile 1: willow strands — wavy vertical threads hanging from the top with small narrow leaves
  for (let sI = 0; sI < 12; sI++) {
    const x0 = N * (0.08 + 0.84 * rng()), len = N * (0.75 + 0.22 * rng()), ph = rng() * 6.28;
    for (let y = 6; y < len; y += 3.2 + 2 * rng()) {
      const x = x0 + 5 * Math.sin(y / 23 + ph) + 2 * Math.sin(y / 9 + ph);
      leaf(1, x + (rng() - 0.5) * 5, N - y, 4.5 + 3 * rng(), 1.2 + 0.8 * rng(), Math.PI / 2 + (rng() - 0.5) * 1.3, 0.55 + 0.45 * rng());
      if (rng() < 0.3) leaf(1, x, N - y, 3, 0.8, Math.PI / 2, 0.4);
    }
  }
  // tile 2: bamboo feather — fans of long thin drooping leaves
  for (let f = 0; f < 11; f++) {
    const cx = N * (0.2 + 0.6 * rng()), cy = N * (0.25 + 0.55 * rng());
    for (let k = 0; k < 9; k++) {
      const a = -Math.PI / 2 + (rng() - 0.5) * 2.2, l = 14 + 12 * rng();
      leaf(2, cx + Math.cos(a) * l * 0.8, cy + Math.sin(a) * l * 0.8 - 6, l, 2 + rng(), a, 0.4 + 0.6 * rng());
    }
  }
  // tile 3: pine needle pad — a horizontally elongated mass of radial needle tufts (side view of a flat 'cloud')
  for (let f = 0; f < 46; f++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng());
    const cx = N * (0.5 + Math.cos(a) * r * 0.36), cy = N * (0.54 + Math.sin(a) * r * 0.26);
    const nNd = 16 + Math.floor(rng() * 10);
    for (let k = 0; k < nNd; k++) {
      const an = -Math.PI * (0.05 + 0.9 * rng()), l = 7 + 9 * rng();
      leaf(3, cx + Math.cos(an) * l * 0.55, cy + Math.sin(an) * l * 0.55 * 0.8 + 3, l, 0.9 + 0.5 * rng(), an, 0.35 + 0.65 * clamp((cy / N - 0.35) / 0.4));
    }
  }
  const data = new Uint8Array(Wd * N * 4);
  for (let k = 0; k < Wd * N; k++) {
    data[k * 4] = Math.round(clamp(R[k]) * 255); data[k * 4 + 1] = Math.round(clamp(G[k]) * 255);
    data[k * 4 + 2] = Math.round(clamp(B[k]) * 255); data[k * 4 + 3] = Math.round(clamp(A[k]) * 255);
  }
  const tex = new THREE.DataTexture(data, Wd, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace; tex.flipY = false; tex.needsUpdate = true;
  return tex;
}

/** all vegetation & rocks: crest crowns, bank trees (willow/camphor/bamboo/plum), reeds, boulders */
function buildVegetation(THREE, seed = 'valley-veg') {
  const rng = makeRng(seed);
  const crownBins = Array.from({ length: 16 }, () => new Batch());
  const reedBins = Array.from({ length: 12 }, () => new Batch());
  const nearBins = Array.from({ length: 10 }, () => new Batch()), woodBins = Array.from({ length: 10 }, () => new Batch());
  const unlitBins = Array.from({ length: 10 }, () => new Batch());          // foliage out of reach of the practicals
  const binOf = (x, z) => (x < 0 ? 0 : 5) + Math.min(4, Math.max(0, Math.floor((z + 700) / 280)));
  let near = nearBins[0], wood = woodBins[0];
  const litAt = (x,z)=>layout.lights.some(p=>Math.hypot(x-p[0],z-p[2])<(p[3]||90));
  const at = (x, z) => { near = (litAt(x, z) ? nearBins : unlitBins)[binOf(x, z)]; wood = woodBins[binOf(x, z)]; };
  const rocks = new Batch(), courtL = new Batch(), courtW = new Batch();
  const aoBlobs = [];                                   // [x, z, radius, strength] contact AO under trees & shrubs
  const courtBloom = [new Batch(), new Batch(), new Batch()];                 
  const gardenLeaves = new Batch(), gardenWood = new Batch(), gardenBloom = [new Batch(), new Batch(), new Batch()];   
  // ---- ridge-crest canopy (silhouettes): 1–2 crossed leaf-cluster cards per crest point ----
  const stepDeg = 0.56;
  const crestCol = () => { const k = 0.75 + 0.45 * rng(); return [0.03 * k, 0.043 * k, 0.029 * k]; };
  for (const c of crestPoints(stepDeg)) {
    if (c.r > 5200) continue;                             // beyond: hazy, serrations invisible
    const R = Math.min(8.5, 3.0 + c.r * 0.0022);
    const gf = gapFactor(c.x, c.z, Math.hypot(c.x, c.z / EZ));
    const bin = crownBins[Math.floor(c.az / 22.5) % 16];
    const arc = c.r * stepDeg * D2R;                       // spacing between crest samples (m)
    const n = Math.max(2, Math.min(6, Math.round(arc / (1.6 * R))));
    for (let q = 0; q < n; q++) {
      const sz = (0.55 + 0.9 * rng()) * (0.35 + 0.65 * clamp(gf * 1.4));
      const ta = (rng() - 0.5) * arc, tr = (rng() - 0.5) * R * 1.5;
      const ca = Math.cos(c.az * D2R), sa = Math.sin(c.az * D2R);
      const cx = c.x + ca * ta + sa * tr, cz = c.z + sa * ta - ca * tr;
      const w = 2.2 * R * sz, h = w * (0.8 + 0.5 * rng());
      clumpCards(bin, [cx, c.h - 0.5 * h + h * 0.5, cz], w, h, [cx, c.h - h, cz], crestCol(), rng, 0, 2, 0.12);
    }
  }
  // ---- trees: species with a sub-crown structure (trunk forks low -> limbs -> sub-crowns of leaf-cluster cards
  //      with sky holes between them; twigs poke out of the silhouette); LOD 2 hero (near the central reach), 1 river
  //      corridor, 0 far (a few big single cards) ----
  const barkCol = [0.055, 0.046, 0.04];
  const willowCol = () => { const k = 0.85 + 0.3 * rng(); return [0.085 * k, 0.1 * k, 0.045 * k]; };      // fresh spring green, translucent
  const camphorCol = () => { const k = 0.8 + 0.35 * rng(); return [0.036 * k, 0.052 * k, 0.031 * k]; };
  const elmCol = () => { const k = 0.8 + 0.35 * rng(); return [0.05 * k, 0.06 * k, 0.033 * k]; };
  const pineCol = () => { const k = 0.8 + 0.3 * rng(); return [0.027 * k, 0.04 * k, 0.035 * k]; };
  const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  // cheap 3-sided stick (far trunks, sub-limbs, twigs): 2 rings, no densify
  const stick = (B, p0, p1, r0, r1, col) => {
    const d = unit([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]);
    const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = unit([d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]]);
    const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
    const ids = [];
    for (let q = 0; q < 3; q++) {
      const an = q * 2.0944, ca = Math.cos(an), sa = Math.sin(an);
      const n = [u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa];
      ids.push(B.vert([p0[0] + n[0] * r0, p0[1] + n[1] * r0, p0[2] + n[2] * r0], n, col, [0.85, 0, 0.85, 2], [an * 0.3, 0]));
      ids.push(B.vert([p1[0] + n[0] * r1, p1[1] + n[1] * r1, p1[2] + n[2] * r1], n, col, [0.85, 0, 0.85, 2], [an * 0.3, 1]));
    }
    for (let q = 0; q < 3; q++) { const a0 = ids[q * 2], a1 = ids[q * 2 + 1], b0 = ids[((q + 1) % 3) * 2], b1 = ids[((q + 1) % 3) * 2 + 1]; B.tri(a0, a1, b0); B.tri(b0, a1, b1); }
  };
  // leaf-cluster cards on the outer / upper shell of a sub-crown (centre c, radius r, vertical scale fy); normals from
  // the crown's volume centre vc so the whole crown shades as one mass
  const subCrown = (B, c, r, fy, n, cs, vc, col, tile = 0, cross = 2, trans = 0.3) => {
    for (let k = 0; k < n; k++) {
      const th = rng() * Math.PI * 2, ph = Math.acos(1 - 2 * Math.pow(rng(), 1.35));
      const rr = r * (0.45 + 0.55 * Math.sqrt(rng()));
      const q = [c[0] + Math.cos(th) * Math.sin(ph) * rr, c[1] + Math.cos(ph) * rr * fy, c[2] + Math.sin(th) * Math.sin(ph) * rr];
      const w = cs * (0.75 + 0.5 * rng());
      clumpCards(B, q, w, w * (0.72 + 0.3 * rng()), vc, col, rng, tile, cross, trans);
    }
  };
  // broadleaf (camphor: broad dome, low-forking; elm: taller oval). The crown is an ellipsoid (centre C, radii R, R·fy)
  // filled by sub-crowns at the limb ends (+ a core and a top), cards spread over each sub-crown (denser on top).
  const broadleaf = (x, z, s = 1, kind = 'camphor', lod = 1) => {
    at(x, z);
    const y = heightAt(x, z) - 0.2;
    const camph = kind === 'camphor';
    const H = (camph ? 9 + 5 * rng() : 10 + 5 * rng()) * s;
    const R = (camph ? 4.6 + 2.0 * rng() : 3.5 + 1.4 * rng()) * s;
    const fy = camph ? 0.74 + 0.12 * rng() : 1.02 + 0.2 * rng();
    const col = camph ? camphorCol() : elmCol();
    const Rv = R * fy;
    const C = [x + (rng() - 0.5) * 0.8 * s, y + H - Rv * 0.9, z + (rng() - 0.5) * 0.8 * s];
    const fork = [mix(x, C[0], 0.6), Math.max(y + 1.6 * s, C[1] - Rv * 0.75), mix(z, C[2], 0.6)];
    const tr = camph ? 1 : 0.72;
    aoBlobs.push([C[0], C[2], R * 1.15, 0.55], [x, z, 1.6 * s, 0.35]);
    if (lod <= 0) {
      // far: short trunk, a low irregular crown of three offset card clusters (lumpy silhouette reaching down to
      // ~2.5 m, not a ball on a stick) and often a bush at its foot
      const Cl = [C[0], Math.max(y + 2.2 * s + Rv, C[1] - 0.35 * Rv), C[2]];
      stick(wood, [x, y, z], [fork[0], Math.min(fork[1], Cl[1] - 0.5 * Rv), fork[2]], 0.4 * s * tr, 0.28 * s * tr, barkCol);
      const vcF = [Cl[0], Cl[1] - Rv * 0.6, Cl[2]];
      clumpCards(near, Cl, 1.9 * R, 2.0 * Rv, vcF, col, rng, 0, 2, 0.3);
      const an = rng() * Math.PI * 2, ox = Math.cos(an) * R * 0.55, oz = Math.sin(an) * R * 0.55;
      if (rng() < 0.6) clumpCards(near, [Cl[0] + ox, Cl[1] + (rng() < 0.5 ? -0.3 : 0.4) * Rv, Cl[2] + oz], 1.3 * R, 1.25 * Rv, vcF, col, rng, 0, 1, 0.3);
      if (rng() < 0.3) clumpCards(near, [x + (rng() - 0.5) * 2, y + 0.9 * s, z + (rng() - 0.5) * 2], (2.2 + 1.4 * rng()) * s, 1.6 * s, [x, y, z], col, rng, 0, 1, 0.3);
      return;
    }
    tube(wood, [[x, y, z], lerp3([x, y, z], fork, 0.55), fork], [0.42 * s * tr, 0.35 * s * tr, 0.29 * s * tr], barkCol, lod > 1 ? 7 : 5);
    const nL = 3 + (rng() < 0.5 ? 1 : 0) + (lod > 1 ? 1 : 0);
    const a0 = rng() * Math.PI * 2;
    const vc = [C[0], C[1] - Rv * 0.35, C[2]];
    for (let i = 0; i < nL; i++) {
      const an = a0 + (i / nL) * Math.PI * 2 + (rng() - 0.5) * 0.7;
      const out = 0.5 + 0.2 * rng(), up = (rng() - 0.3) * 0.55;
      const E = [C[0] + Math.cos(an) * R * out, C[1] + Rv * up, C[2] + Math.sin(an) * R * out];
      const M = [mix(fork[0], E[0], 0.35), mix(fork[1], E[1], 0.65), mix(fork[2], E[2], 0.35)];
      tube(wood, [fork, M, E], [0.21 * s * tr, 0.14 * s * tr, 0.07 * s * tr], barkCol, lod > 1 ? 6 : 4);
      const rS = R * (0.52 + 0.14 * rng());
      subCrown(near, E, rS, fy * 0.85, lod > 1 ? 13 + Math.floor(rng() * 4) : 5, rS * (lod > 1 ? 0.85 : 1.2), vc, col, 0, 2, 0.3);
      if (lod > 1) {                                  // twigs beyond the leaf mass (branch structure at the edge)
        for (let k = 0; k < 2; k++) {
          const a2 = an + (rng() - 0.5) * 1.2;
          const T = [E[0] + Math.cos(a2) * rS * 0.7, E[1] + rS * (0.1 + 0.5 * rng()), E[2] + Math.sin(a2) * rS * 0.7];
          const tw = [E[0] + Math.cos(a2) * rS * 1.25, E[1] + rS * (0.2 + 0.6 * rng()), E[2] + Math.sin(a2) * rS * 1.25];
          stick(wood, lerp3(E, T, 0.3), tw, 0.035 * s, 0.008, barkCol);
          stick(wood, T, [tw[0] + (rng() - 0.5) * 0.9, tw[1] + 0.2 + 0.4 * rng(), tw[2] + (rng() - 0.5) * 0.9], 0.015, 0.005, barkCol);
        }
      }
    }
    // core + top (keeps the dome closed from the side, holes remain between the sub-crowns)
    subCrown(near, C, R * 0.5, fy, lod > 1 ? 6 : 2, R * 0.6, vc, col, 0, 2, 0.3);
    subCrown(near, [C[0], C[1] + Rv * 0.55, C[2]], R * 0.45, fy * 0.7, lod > 1 ? 7 : 2, R * 0.6, vc, col, 0, 2, 0.3);
  };
  // weeping willow: short leaning trunk, limbs ascend then arch over; a curtain of long strands hangs from the whole
  // crown (longest at the rim, reaching ~1 m above the ground), a dome of short strand bundles on top
  const willow = (x, z, s = 1, lod = 1) => {
    at(x, z);
    const y = heightAt(x, z) - 0.2;
    const toR = Math.sign(riverCenter(z) - x) || 1;
    const Ht = (1.9 + 0.9 * rng()) * s;
    const top = [x + toR * (0.4 + 0.7 * rng()) * s, y + Ht, z + (rng() - 0.5) * 0.8 * s];
    tube(wood, [[x, y, z], [mix(x, top[0], 0.35), y + Ht * 0.5, mix(z, top[2], 0.35)], top], [0.42 * s, 0.35 * s, 0.28 * s], barkCol, lod > 0 ? 6 : 4);
    const col = willowCol();
    aoBlobs.push([top[0], top[2], 4.2 * s, 0.5], [x, z, 1.4 * s, 0.35]);
    const nb = lod > 1 ? 7 : lod > 0 ? 6 : 5;
    const a0 = rng() * Math.PI * 2;
    const vc = [top[0], top[1] + 2.5 * s, top[2]];
    for (let bI = 0; bI < nb; bI++) {
      const an = a0 + (bI / nb) * Math.PI * 2 + (rng() - 0.5) * 0.5;
      const ca = Math.cos(an), sa = Math.sin(an);
      const rise = (3.6 + 1.8 * rng()) * s, reach = (3.4 + 1.6 * rng()) * s;
      const P1 = [top[0] + ca * reach * 0.25, top[1] + rise * 0.75, top[2] + sa * reach * 0.25];
      const P2 = [top[0] + ca * reach * 0.65, top[1] + rise, top[2] + sa * reach * 0.65];
      const P3 = [top[0] + ca * reach * 1.05, top[1] + rise * 0.8, top[2] + sa * reach * 1.05];
      if (lod > 0) tube(wood, [top, P1, P2, P3], [0.17 * s, 0.11 * s, 0.065 * s, 0.025 * s], barkCol, lod > 1 ? 5 : 3);
      else stick(wood, top, P2, 0.14 * s, 0.05 * s, barkCol);
      const ns = lod > 1 ? 30 + Math.floor(rng() * 8) : lod > 0 ? 15 : 7;
      for (let k = 0; k < ns; k++) {
        const f = Math.sqrt(rng());                    // more strands toward the rim
        const hp = f < 0.45 ? lerp3(P1, P2, f / 0.45) : lerp3(P2, P3, (f - 0.45) / 0.55);
        const anchor = [hp[0] + (rng() - 0.5) * 0.9 * s, hp[1] + 0.1 + 0.3 * rng(), hp[2] + (rng() - 0.5) * 0.9 * s];
        // ragged hem: long rim strands reach ~0.6–2.5 m above the ground, a third of them are short new growth
        const short = rng() < 0.33;
        const bottom = short ? anchor[1] - (1.0 + 1.6 * rng()) * s : y + mix(3.6, 0.6, f) * s + rng() * 2.0 * s;
        const hang = Math.max(0.8, anchor[1] - bottom);
        const radial = Math.atan2(anchor[2] - top[2], anchor[0] - top[0]);
        const tint = 0.8 + 0.45 * rng();
        strandCard(near, anchor, hang, (0.45 + 0.4 * rng()) * s * (lod > 1 ? 1 : lod > 0 ? 1.4 : 2.4), radial + Math.PI / 2 + (rng() - 0.5) * 1.1, vc, [col[0] * tint * 1.05, col[1] * tint, col[2] * tint * 0.9], rng, lod > 1 ? 4 : lod > 0 ? 3 : 2);
      }
    }
    // the dome: short strand bundles over the top
    const nt = lod > 1 ? 22 : lod > 0 ? 12 : 5;
    for (let k = 0; k < nt; k++) {
      const an = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 3.4 * s;
      clumpCards(near, [top[0] + Math.cos(an) * r, top[1] + (3.6 + 1.6 * rng()) * s - r * 0.25, top[2] + Math.sin(an) * r], 2.6 * s, 2.2 * s, vc, col, rng, 1, lod > 0 ? 2 : 1, 0.5);
    }
  };
  // pine (Masson / Huangshan pine): leaning crooked trunk, limbs from ~40 % up, the crown a broad flat-topped stack of
  // needle 'clouds' (each pad = a flat lumpy mass of crossed needle cards + a top card)
  const pad = (B, c, w, col, lod) => {
    const n = lod > 1 ? 4 : lod > 0 ? 3 : 1;
    for (let k = 0; k < n; k++) {
      const q = [c[0] + (rng() - 0.5) * w * 0.55, c[1] + (rng() - 0.5) * w * 0.12, c[2] + (rng() - 0.5) * w * 0.55];
      clumpCards(B, q, w * (0.7 + 0.3 * rng()) * (n === 1 ? 1.5 : 1), w * (0.5 + 0.12 * rng()) * (n === 1 ? 1.3 : 1), [c[0], c[1] - w, c[2]], col, rng, 3, lod > 0 ? 2 : 1, 0.15);
    }
    if (lod > 0) {
      const yaw = rng() * Math.PI, ca = Math.cos(yaw), sa = Math.sin(yaw), hx = w * 0.6, hz = w * 0.45, yy = c[1] + 0.12 * w;
      const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => B.vert([c[0] + ca * u * hx - sa * v * hz, yy, c[2] + sa * u * hx + ca * v * hz], [0, 1, 0], col, [0.95, 0.15, 3, rng()], [(3 + 0.03 + 0.94 * (u * 0.5 + 0.5)) / ATLAS_TILES, 0.28 + 0.4 * (v * 0.5 + 0.5)]));
      B.tri(q[0], q[1], q[2]); B.tri(q[0], q[2], q[3]);
    }
  };
  const pine = (x, z, s = 1, lod = 1) => {
    at(x, z);
    const y = heightAt(x, z) - 0.2;
    const H = (7 + 4 * rng()) * s;
    const col = pineCol();
    const la = rng() * Math.PI * 2, lean = (0.6 + 1.2 * rng()) * s;
    const pts = [[x, y, z]];
    for (let k = 1; k <= 4; k++) {
      const f = k / 4;
      pts.push([x + Math.cos(la) * lean * f * f + (rng() - 0.5) * 0.7 * s, y + H * f * 0.92, z + Math.sin(la) * lean * f * f + (rng() - 0.5) * 0.7 * s]);
    }
    if (lod > 0) tube(wood, pts, [0.3 * s, 0.25 * s, 0.19 * s, 0.13 * s, 0.06 * s], barkCol, lod > 1 ? 6 : 4);
    else stick(wood, pts[0], pts[3], 0.28 * s, 0.14 * s, barkCol);
    const top = pts[4];
    aoBlobs.push([top[0], top[2], 3.4 * s, 0.45], [x, z, 1.3 * s, 0.3]);
    const nB = lod > 1 ? 7 : lod > 0 ? 5 : 3;
    for (let k = 0; k < nB; k++) {
      const f = 0.4 + 0.55 * (k / Math.max(1, nB - 1));
      const seg = Math.min(3, Math.floor(f * 4)), base = lerp3(pts[seg], pts[seg + 1], f * 4 - seg);
      const an = la + (k % 2 ? Math.PI : 0) + (rng() - 0.5) * 2.2;
      const L = (1.4 + 2.6 * (1 - f) + 0.8 * rng()) * s;
      const tip = [base[0] + Math.cos(an) * L, base[1] + (0.1 + 0.5 * rng()) * s, base[2] + Math.sin(an) * L];
      if (lod > 0) stick(wood, base, tip, 0.09 * s, 0.035 * s, barkCol);
      pad(near, tip, (2.2 + 1.4 * rng()) * s * (1.2 - 0.45 * f), col, lod);
    }
    pad(near, [top[0], top[1] + 0.3 * s, top[2]], (2.6 + 1.0 * rng()) * s, col, lod);
  };
  const shrub = (x, z, s = 1) => {
    at(x, z);
    const y = heightAt(x, z);
    aoBlobs.push([x, z, 1.5 * s, 0.4]);
    const col = rng() < 0.5 ? camphorCol() : elmCol();
    const n = 1 + Math.floor(rng() * 2);
    for (let k = 0; k < n; k++) clumpCards(near, [x + (rng() - 0.5) * 1.6 * s, y + (0.5 + 0.5 * rng()) * s, z + (rng() - 0.5) * 1.6 * s], (1.8 + 0.9 * rng()) * s, (1.2 + 0.5 * rng()) * s, [x, y - 0.6, z], col, rng, 0, 1, 0.3);
  };
  const camphor = (x, z, s = 1, lod = 2) => broadleaf(x, z, s, 'camphor', lod);
  const bamboo = (x, z, s = 1, B = null, Wb = null, y0 = null) => {
    at(x, z); B = B || near; Wb = Wb || wood;
    aoBlobs.push([x, z, 2.6 * s, 0.5]);
    const y = y0 ?? heightAt(x, z) - 0.1;
    const col = [0.05, 0.078, 0.034];
    const n = 7 + Math.floor(rng() * 6);
    for (let k = 0; k < n; k++) {
      const bx = x + (rng() - 0.5) * 3.2, bz = z + (rng() - 0.5) * 3.2, hh = (7 + 5 * rng()) * s;
      const tip = [bx + (rng() - 0.5) * 2.2, y + hh, bz + (rng() - 0.5) * 2.2];
      tube(Wb, [[bx, y, bz], lerp3([bx, y, bz], tip, 0.5), tip], [0.05, 0.04, 0.02], [0.085, 0.095, 0.055], 4);
      for (let q = 0; q < 4; q++) {
        const f = 0.55 + 0.45 * rng();
        const p = lerp3([bx, y, bz], tip, f);
        clumpCards(B, [p[0] + (rng() - 0.5) * 1.2, p[1], p[2] + (rng() - 0.5) * 1.2], 2.0 * s, 2.4 * s, [bx, p[1] - 1, bz], col, rng, 2, 1, 0.5);
      }
    }
  };
  
  
  const blocked = (x,z) => layout.exclusions.some(b=>Math.hypot(x-b.x,z-b.z)<b.radius);
  for (const p of layout.bamboo) bamboo(p.x,p.z,p.scale||1,courtL,courtW,p.y);
  for (const p of layout.trees) ({willow,camphor,pine}[p.kind] || camphor)(p.x,p.z,p.scale||1,p.lod||1);
  // old white plums (白梅): gnarled leaning trunk, 4–6 crooked limbs with twigs; blossom clusters split into three
  // bloom levels (buds → half → full) that the terrain update shows by world.bloomAmount
  const plum = (Wb, Lb, base, H, lean, nLimbs = 5) => {
    const [px, y0, pz] = base;
    aoBlobs.push([px + lean[0], pz + lean[2], H * 0.45, 0.4]);
    const t1 = [px + lean[0] * 0.35, y0 + H * 0.3, pz + lean[2] * 0.35];
    const top = [px + lean[0], y0 + H * 0.48, pz + lean[2]];
    const barkP = [0.04, 0.034, 0.03];
    tube(Wb, [[px, y0 - 0.1, pz], [px + lean[0] * 0.12 + 0.08, y0 + H * 0.15, pz + lean[2] * 0.12], t1, top], [0.2, 0.16, 0.13, 0.1], barkP, 7);
    const a0 = rng() * Math.PI * 2;
    for (let bI = 0; bI < nLimbs; bI++) {
      const an = a0 + (bI / nLimbs) * Math.PI * 2 + (rng() - 0.5) * 0.8 + 0.6 * Math.atan2(lean[2], lean[0]) * 0;
      const reach = H * (0.3 + 0.18 * rng()), rise = H * (0.18 + 0.3 * rng());
      const kink = [top[0] + Math.cos(an + 0.5) * reach * 0.45, top[1] + rise * 0.55, top[2] + Math.sin(an + 0.5) * reach * 0.45];
      const e = [top[0] + Math.cos(an) * reach + lean[0] * 0.3, top[1] + rise, top[2] + Math.sin(an) * reach + lean[2] * 0.3];
      tube(Wb, [top, kink, e], [0.08, 0.05, 0.02], barkP, 5);
      // twigs: straight thin shoots (plum twigs grow straight up/out) carrying blossom
      const nt = 4 + Math.floor(rng() * 3);
      for (let k = 0; k < nt; k++) {
        const f = 0.3 + 0.7 * rng(), q = f < 0.5 ? lerp3(top, kink, f * 2) : lerp3(kink, e, (f - 0.5) * 2);
        const tw = [q[0] + Math.cos(an + (rng() - 0.5) * 1.6) * H * 0.12, q[1] + H * (0.06 + 0.12 * rng()), q[2] + Math.sin(an + (rng() - 0.5) * 1.6) * H * 0.12];
        tube(Wb, [q, tw], [0.018, 0.006], barkP, 3);
        for (let c = 0; c < 3; c++) {
          const g = lerp3(q, tw, 0.3 + 0.7 * rng());
          const lvl = rng() < 0.3 ? 0 : rng() < 0.5 ? 1 : 2;
          const col = lvl === 0 ? [0.44, 0.3, 0.31] : [0.66, 0.6, 0.59];
          clumpCards(Lb[lvl], g, (0.45 + 0.35 * rng()) * (H / 4.5), (0.4 + 0.3 * rng()) * (H / 4.5), top, col, rng, 0, 1, 0.45);
        }
      }
      for (let c = 0; c < 3; c++) {
        const g = lerp3(kink, e, 0.3 + 0.7 * rng());
        const lvl = c === 0 ? 0 : c === 1 ? 1 : 2;
        clumpCards(Lb[lvl], [g[0], g[1] + 0.1, g[2]], 0.8 * (H / 4.5), 0.6 * (H / 4.5), top, lvl === 0 ? [0.44, 0.3, 0.31] : [0.66, 0.6, 0.59], rng, 0, 1, 0.45);
      }
    }
  };
  
  for (const p of layout.plums) plum(courtW,courtBloom,p.position,p.height||4,p.lean||[0,0,0],p.limbs||5);
  // bank willows along the natural reaches (hero LOD near the central reach' reach)
  for (const side of [-1, 1]) {
    for (let z = -700; z < 700; z += 20 + rng() * 26) {
      if (blocked(riverCenter(z),z)) {rng();rng();continue;}
      if (rng() < 0.3) continue;
      const hw = riverHalfWidth(z), cx = riverCenter(z);
      const x = cx + side * (hw + 3.5 + rng() * 6);
      willow(x, z, 0.8 + 0.4 * rng(), Math.abs(z) < 260 ? 1 : 0);
      if (rng() < 0.5) shrub(x + side * (3 + 3 * rng()), z + (rng() - 0.5) * 8, 0.8 + 0.4 * rng());
    }
  }
  // groves on the valley floor & the lower slopes (noise mask with clearings), species by slope
  const groveN = (x, z) => 0.5 + 0.5 * (0.65 * gnoise2(x / 230 + 7.7, z / 230 - 3.1) + 0.35 * gnoise2(x / 85 - 2.2, z / 85 + 5.5));
  for (let gz = -640; gz < 640; gz += 15) {
    for (let gx = -480; gx < 480; gx += 15) {
      const x = gx + (rng() - 0.5) * 10, z = gz + (rng() - 0.5) * 10, r1 = rng(), r2 = rng(), r3 = rng();
      const cx = riverCenter(z), hw = riverHalfWidth(z), d = Math.abs(x - cx);
      if (d < hw + 16 || blocked(x, z)) continue;
      const hl = hillsAt(x, z) * smooth(hw + 25, hw + 150, d);
      if (hl > 60) continue;
      const g = groveN(x, z);
      const thr = 0.6 - 0.1 * smooth(4, 26, hl);
      if (g < thr) { if (g > thr - 0.05 && r1 < 0.3) shrub(x, z, 0.8 + 0.5 * r2); continue; }
      if (r1 < 0.15) continue;
      const lod = Math.abs(z) < 320 && d < hw + 110 ? 1 : 0;
      
      const capS = 9;
      if (capS < 0.45) { if (r1 < 0.5) shrub(x, z, 0.9 + 0.5 * r3); continue; }
      if (hl > 8 && r2 < 0.55) pine(x, z, Math.min(capS, 0.85 + 0.4 * r3), lod);
      else broadleaf(x, z, Math.min(capS, 0.8 + 0.45 * r3), r2 < 0.62 ? 'camphor' : 'elm', lod);
      if (r1 < 0.4) shrub(x + (r3 - 0.5) * 6, z + (r2 - 0.5) * 6, 1.3 + 1.2 * r3);        // understory / young trees
    }
  }
  // tree rows along field edges / paths, parallel to the river, with gaps
  for (const side of [-1, 1]) for (const off of [36, 118]) {
    for (let z = -660; z < 660; z += 10 + rng() * 6) {
      const cx = riverCenter(z), hw = riverHalfWidth(z);
      const x = cx + side * (hw + off + 10 * gnoise1(z / 140 + off, 5));
      const r1 = rng(), r2 = rng();
      if (blocked(x, z) || gnoise1(z / 70 + off * 0.1 + side * 3.3, 9) < 0.0) continue;
      const capS = 9;
      if (capS < 0.45) continue;
      broadleaf(x, z, Math.min(capS, 0.72 + 0.3 * r1), r2 < 0.55 ? 'elm' : 'camphor', Math.abs(z) < 280 && off < 100 ? 1 : 0);
    }
  }
  // ---- reeds on the natural bank shelves ----
  for (const side of [-1, 1]) {
    for (let z = -560; z < 560; z += 2.2 + rng() * 2.4) {
      if (Math.abs(z) < 82 || Math.abs(z + 220) < 34) continue;
      const hw = riverHalfWidth(z), cx = riverCenter(z);
      const dd = hw - 2.5 + rng() * 6.5;
      const x0 = cx + side * dd;
      const y0 = heightAt(x0, z);
      if (y0 < -0.25 || y0 > 1.1) continue;
      const nb = 6 + Math.floor(rng() * 12);
      const reeds = reedBins[(side < 0 ? 0 : 6) + Math.min(5, Math.floor((z + 560) / (1120 / 6)))];
      for (let k = 0; k < nb; k++) {
        const bx = x0 + (rng() - 0.5) * 1.6, bz = z + (rng() - 0.5) * 1.6;
        const by = heightAt(bx, bz) - 0.05;
        const h = 1.2 + rng() * 1.3, wdt = 0.035 + 0.02 * rng();
        const dry = rng() < 0.8;
        const col = dry ? [0.23 + 0.06 * rng(), 0.19 + 0.05 * rng(), 0.12 + 0.03 * rng()] : [0.06, 0.1, 0.04];
        const a = rng() * Math.PI * 2, lean = (rng() - 0.3) * 0.25;
        const lx = Math.cos(a) * lean, lz = Math.sin(a) * lean;
        const tx = -Math.sin(a) * wdt, tz = Math.cos(a) * wdt;
        const nrm = [Math.cos(a), 0.3, Math.sin(a)];
        const ph = rng() * 6.283, st = rng();
        const segsB = 3;
        let prev = null;
        for (let q = 0; q <= segsB; q++) {
          const f = q / segsB, bend = f * f;
          const cxp = bx + lx * h * bend, czp = bz + lz * h * bend, cyp = by + h * f;
          const wf = 1 - 0.85 * f;
          const v0 = reeds.vert([cxp - tx * wf, cyp, czp - tz * wf], nrm, col, [f, ph, st, 0]);
          const v1 = reeds.vert([cxp + tx * wf, cyp, czp + tz * wf], nrm, col, [f, ph, st, 0]);
          if (prev) { reeds.tri(prev[0], v0, prev[1]); reeds.tri(prev[1], v0, v1); }
          prev = [v0, v1];
        }
      }
    }
  }
  // ---- hedgerows along some field-plot column boundaries (same lines as the shader's dikes) ----
  for (const side of [-1, 1]) {
    for (let k = 1; k <= 12; k++) {
      const hsh = hash21(k,side); if (hsh > 0.34) continue;
      for (let z = -520; z < 520; z += 4.2 + rng() * 1.6) {
        const gap = gnoise1(z / 55 + k * 3.7 + side, 17);
        const r1 = rng(), r2 = rng();
        if (gap < -0.05) continue;
        const x = plotColumnX(side, k, z) + (r1 - 0.5) * 0.8;
        const hw = riverHalfWidth(z), d = Math.abs(x - riverCenter(z));
        if (d > 420 || blocked(x, z) || hillsAt(x, z) * smooth(hw + 25, hw + 150, d) > 25) continue;
        shrub(x, z, 0.9 + 0.5 * r2);
        if (r2 > 0.93) broadleaf(x, z, 0.65 + 0.2 * r1, 'elm', Math.abs(z) < 260 ? 1 : 0);
      }
    }
  }
  // ---- grass fringes along the embankment tops and weeds / reed clumps at the wall foot (near the central reach) ----
  const blade = (bin, bx, by, bz, h, wdt, col, a, lean, segsB = 2) => {
    const lx = Math.cos(a) * lean, lz = Math.sin(a) * lean;
    const tx = -Math.sin(a) * wdt, tz = Math.cos(a) * wdt;
    const nrm = [Math.cos(a), 0.3, Math.sin(a)];
    const ph = rng() * 6.283, st = rng();
    let prev = null;
    for (let q = 0; q <= segsB; q++) {
      const f = q / segsB, bend = f * f;
      const cxp = bx + lx * h * bend, czp = bz + lz * h * bend, cyp = by + h * f - Math.abs(lean) * h * bend * 0.3;
      const wf = 1 - 0.85 * f;
      const v0 = bin.vert([cxp - tx * wf, cyp, czp - tz * wf], nrm, col, [f, ph, st, 0]);
      const v1 = bin.vert([cxp + tx * wf, cyp, czp + tz * wf], nrm, col, [f, ph, st, 0]);
      if (prev) { bin.tri(prev[0], v0, prev[1]); bin.tri(prev[1], v0, v1); }
      prev = [v0, v1];
    }
  };
  for (const side of [-1, 1]) {
    const top = side < 0 ? VALLEY.westBankY : VALLEY.eastBankY;
    for (let z = -77; z < 77; z += 1.1 + rng() * 0.9) {
      const bin = reedBins[(side < 0 ? 0 : 6) + 2 + (z > 0 ? 1 : 0)];
      const x0 = side * (60.15 + rng() * 0.5);
      const n = 9 + Math.floor(rng() * 9);
      for (let q = 0; q < n; q++) {
        const dry = rng() < 0.5;
        const col = dry ? [0.15 + 0.05 * rng(), 0.14 + 0.04 * rng(), 0.08] : [0.045, 0.08, 0.032];
        // tufts leaning outward over the wall edge (toward the river)
        const a = (side < 0 ? 0 : Math.PI) + (rng() - 0.5) * 2.2;
        blade(bin, x0 + side * rng() * 0.35, top + 0.08, z + (rng() - 0.5) * 0.5, 0.1 + 0.26 * rng() * rng(), 0.008 + 0.006 * rng(), col, a, 0.3 + 0.6 * rng());
      }
    }
    // weeds and reed clumps at the foot of the wall, in the shallow water
    for (let z = -74; z < 74; z += 5.5 + rng() * 5) {
      const bin = reedBins[(side < 0 ? 0 : 6) + 2 + (z > 0 ? 1 : 0)];
      const x0 = side * (59.35 - rng() * 0.5), n = 5 + Math.floor(rng() * 8);
      for (let q = 0; q < n; q++) {
        const dry = rng() < 0.7;
        const col = dry ? [0.21 + 0.05 * rng(), 0.18 + 0.04 * rng(), 0.11] : [0.06, 0.1, 0.04];
        blade(bin, x0 + (rng() - 0.5) * 0.7, -0.05, z + (rng() - 0.5) * 1.6, 0.8 + 0.9 * rng(), 0.02 + 0.012 * rng(), col, rng() * Math.PI * 2, (rng() - 0.3) * 0.3, 3);
      }
    }
  }
  // ---- boulders along the natural banks and inside explicit rock spans ----
  const boulder = (x, z, s) => {
    const y = heightAt(x, z);
    const c = [x, y + s * 0.15, z];
    const segs = 7, rings = 4, ph = rng() * 100;
    const tone = 0.1 + 0.05 * rng();
    const col = [tone, tone * 0.98, tone * 0.93];
    const idx = [];
    for (let r = 0; r <= rings; r++) {
      const el = Math.PI * 0.5 - (r / rings) * Math.PI * 0.75;
      const row = [];
      for (let q = 0; q < segs; q++) {
        const a = (q / segs) * Math.PI * 2;
        const k = 1 + 0.3 * gnoise1(a * 1.3 + ph + r, 7);
        const p = [c[0] + Math.cos(a) * Math.cos(el) * s * k * 1.2, c[1] + Math.sin(el) * s * 0.7 * k, c[2] + Math.sin(a) * Math.cos(el) * s * k];
        const nn = [Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)];
        const wetb = smooth(0.6, 0.0, p[1]);
        row.push(rocks.vert(p, nn, col, [mix(0.8, 0.3, wetb), mix(0.02, 0.05, wetb), 1, 5], [a * s, el * s]));
      }
      idx.push(row);
    }
    for (let r = 0; r < rings; r++) for (let q = 0; q < segs; q++) {
      const a = idx[r][q], b2 = idx[r][(q + 1) % segs], c2 = idx[r + 1][q], d = idx[r + 1][(q + 1) % segs];
      rocks.tri(a, c2, b2); rocks.tri(b2, c2, d);
    }
  };
  for (const side of [-1, 1]) for (let z = -600; z < 600; z += 9 + rng() * 25) {
    if (Math.abs(z) < 75) continue;
    const hw = riverHalfWidth(z), cx = riverCenter(z);
    boulder(cx + side * (hw - 1.5 + rng() * 4), z, 0.35 + rng() * 0.9);
  }
  return { crownBins, nearBins, unlitBins, woodBins, reedBins, rocks, courtL, courtW, courtBloom, gardenLeaves, gardenWood, gardenBloom, aoBlobs };
}

/** contact AO under the trees/shrubs over NEAR_RECT (0.75 m/px, R8): multiplicative soft blobs */
function bakeGroundAO(THREE, blobs) {
  const R = NEAR_RECT, px = 0.75;
  const W = Math.round((R.x1 - R.x0) / px), H = Math.round((R.z1 - R.z0) / px);
  const ao = new Float32Array(W * H).fill(1);
  for (const [bx, bz, rad, st] of blobs) {
    const cx = (bx - R.x0) / px, cz = (bz - R.z0) / px, rr = rad / px;
    const i0 = Math.max(0, Math.floor(cx - rr)), i1 = Math.min(W - 1, Math.ceil(cx + rr));
    const j0 = Math.max(0, Math.floor(cz - rr)), j1 = Math.min(H - 1, Math.ceil(cz + rr));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const r = Math.hypot(i - cx, j - cz) / rr;
      if (r >= 1) continue;
      const o = st * Math.pow(1 - r * r, 1.6);
      ao[j * W + i] *= 1 - o;
    }
  }
  const data = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) data[k] = Math.round(clamp(ao[k]) * 255);
  const tex = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace; tex.flipY = false; tex.unpackAlignment = 1; tex.needsUpdate = true;
  return tex;
}

/**
 * createTerrain(ctx, { atmos }) -> { object (Group), update(t, world, camera), heightAt, meshes, dispose }
 * All pieces are chunked meshes sharing a handful of programs; update() re-orders chunks front-to-back
 * (renderOrder) so SwiftShader's early depth test skips hidden fragments.
 */
function createTerrain(ctx, opts = {}) {
  const { THREE } = ctx;
  const atmos = opts.atmos;
  const group = new THREE.Group(); group.name = 'valley.terrain';
  // contact-AO ground texture (baked below from the vegetation placement), shared by all terrain materials
  const groundU = { uGroundAO: { value: null }, uGroundAORect: { value: new THREE.Vector4(NEAR_RECT.x0, NEAR_RECT.z0, NEAR_RECT.x1 - NEAR_RECT.x0, NEAR_RECT.z1 - NEAR_RECT.z0) } };
  const matT = makeValleyMaterial(atmos, 'terrain', { extraUniforms: groundU });
  const matTF = makeValleyMaterial(atmos, 'terrain', { vertexAtmos: true, extraUniforms: groundU });
  const matTFF = makeValleyMaterial(atmos, 'terrain', { vertexAtmos: true, defines: { NO_SPEC: 1, NO_POINT_LIGHTS: 1 }, extraUniforms: groundU });
  const leafTex = bakeLeafAtlas(THREE);
  const matF = makeValleyMaterial(atmos, 'foliage', { side: THREE.DoubleSide, alphaToCoverage: true, vertexAtmos: true, extraUniforms: { uLeafTex: { value: leafTex } } });
  const matS = makeValleyMaterial(atmos, 'surface');
  const matR = makeValleyMaterial(atmos, 'reed', { side: THREE.DoubleSide, vertexAtmos: true });
  const meshes = [];
  const add = (geo, mat, name, far = false) => { const m = new THREE.Mesh(geo, mat); m.name = name; m.userData.far = far; group.add(m); meshes.push(m); return m; };
  // near chunks: the practicals' point lights only on chunks within their reach (the loop costs every fragment)
  const matTFN = makeValleyMaterial(atmos, 'terrain', { vertexAtmos: true, defines: { NO_POINT_LIGHTS: 1 }, extraUniforms: groundU });
  const LP = layout.lights.map(p=>[p[0],p[2],p[3]||90]);
  for (const g of buildNearChunks(THREE)) {
    const bb = g.boundingBox || (g.computeBoundingBox(), g.boundingBox);
    const lit = LP.some(([x, z, r]) => Math.max(bb.min.x - x, 0, x - bb.max.x) ** 2 + Math.max(bb.min.z - z, 0, z - bb.max.z) ** 2 < r * r);
    add(g, lit ? matTF : matTFN, 'terrain.near');
  }
  for (const g of buildFarChunks(THREE)) add(g, matTFF, 'terrain.far', true);
  const veg = buildVegetation(THREE);
  groundU.uGroundAO.value = bakeGroundAO(THREE, veg.aoBlobs);
  const matFF = makeValleyMaterial(atmos, 'foliage', { side: THREE.DoubleSide, alphaToCoverage: true, vertexAtmos: true, defines: { NO_POINT_LIGHTS: 1 }, extraUniforms: { uLeafTex: { value: leafTex } } });
  for (const b of veg.crownBins) if (b.count) add(b.build(THREE), matFF, 'veg.crests', true);
  for (const b of veg.nearBins) if (b.count) add(b.build(THREE), matF, 'veg.trees');
  for (const b of veg.unlitBins) if (b.count) add(b.build(THREE), matFF, 'veg.trees');
  const matSV = makeValleyMaterial(atmos, 'surface', { vertexAtmos: true });
  for (const b of veg.woodBins) if (b.count) add(b.build(THREE), matSV, 'veg.wood');
  for (const b of veg.reedBins) if (b.count) add(b.build(THREE), matR, 'veg.reeds');
  add(veg.rocks.build(THREE), matS, 'veg.rocks');
  
  add(veg.courtL.build(THREE), matF, 'veg.courtPlants');
  add(veg.courtW.build(THREE), matS, 'veg.courtPlantsWood');
  veg.courtBloom.forEach((b, k) => { if (b.count) { const m = add(b.build(THREE), matF, 'veg.courtPlants'); m.userData.bloomLevel = k; } });
  
  if (veg.gardenLeaves.count) add(veg.gardenLeaves.build(THREE), matF, 'veg.gardenPlants');
  if (veg.gardenWood.count) add(veg.gardenWood.build(THREE), matS, 'veg.gardenPlantsWood');
  veg.gardenBloom.forEach((b, k) => { if (b.count) { const m = add(b.build(THREE), matF, 'veg.gardenPlants'); m.userData.bloomLevel = k; } });
  const _c = new THREE.Vector3(), _s = new THREE.Sphere();
  function update(t, w, camera) {
    // plum blossom by bloom level (buds 0.12 → full 1.0); meshes hidden by a Set's omit stay hidden
    const bl = (w && (w.bloomAmount ?? w.bloom)) ?? 0.12;
    for (const m of meshes) if (m.userData.bloomLevel !== undefined && !m.userData.omitted) m.visible = bl > [0.05, 0.45, 0.8][m.userData.bloomLevel];
    if (!camera) return;
    camera.getWorldPosition(_c);
    // front-to-back ordering between chunks (early-z)
    const arr = meshes.map((m) => { _s.copy(m.geometry.boundingSphere).applyMatrix4(m.matrixWorld); return [m, Math.max(0, _c.distanceTo(_s.center) - _s.radius * 0.8)]; });
    arr.sort((a, b) => a[1] - b[1]);
    arr.forEach(([m], i) => { m.renderOrder = (opts.renderOrderBase ?? 100) + i; });
  }
  return {
    object: group, update, heightAt, meshes, materials: { terrain: matT, terrainFar: matTF, foliage: matF, surface: matS, reed: matR },
    leafTex,
    dispose() { if (groundU.uGroundAO.value) groundU.uGroundAO.value.dispose(); for (const m of meshes) m.geometry.dispose(); for (const m of [matT, matTF, matTFF, matTFN, matF, matS, matR, matSV]) m.dispose(); for (const m of meshes) if (m.material && m.material.name === 'valley.foliage') m.material.dispose(); leafTex.dispose(); },
  };
}

return {VALLEY,riverCenter,riverHalfWidth,GAPS,hillsAt,heightAt,plotColumnX,horizonElevation,skylineAt,NPL,NGL,VALLEY_GLSL,createAtmosphere,makeValleyMaterial,NEAR_RECT,Batch,crownBlob,trunk,tube,clumpCards,bakeLeafAtlas,createTerrain};
}
export const {VALLEY,riverCenter,riverHalfWidth,GAPS,hillsAt,heightAt,plotColumnX,horizonElevation,skylineAt,NPL,NGL,VALLEY_GLSL,createAtmosphere,makeValleyMaterial,NEAR_RECT,Batch,crownBlob,trunk,tube,clumpCards,bakeLeafAtlas,createTerrain} = createTerrainLibrary();
