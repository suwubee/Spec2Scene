// Author: suwubee
// engine/sky.js — physically-inspired sky for the whole film: atmosphere (Hillaire-style transmittance /
// multiple-scattering / sky-view LUTs, sun AND moon as light sources), stars + Milky Way, procedural Moon disc
// (moon.js), sun disc, halos, a streaky cirrus layer and a raymarched volumetric low-cloud slab (with the west-bank
// rain cloud and the moon gap), plus the derived products other libraries need: an HDR equirect radiance map of the
// CURRENT sky (reflections), a cubeUV PMREM-compatible environment (scene.environment), haze colour for fog, a
// cloud-shadow lookup and sun/moon screen helpers. Everything is a pure function of (t, world, camera).
//
//   import { createSky } from './engine/sky.js';
//   const sky = createSky(ctx, { moonScale: 2.2 });
//   scene.add(sky.object);                 // background (drawn after opaques at the far plane, early-z friendly)
//   scene.add(sky.overlay);                // cloud overlay: only active when the camera is in/above the deck
//   scene.environment = sky.getEnvironment();
//   (several Sets: const sky = getSharedSky(ctx); scene.add(sky.makeBackgroundMesh(), sky.makeOverlayMesh()) per scene)
//   // every frame, AFTER placing the camera:
//   sky.update(t, world.at(t), camera);
//   // other shaders: `${sky.skyGLSL}` + uniforms: { ...sky.uniforms } -> skyRadiance(dir), skyHazeColor(dir), ...
//
// See engine/README.md for the full API, exposure numbers, performance and known issues.
import { createMoonTexture } from './moon.js';
import {skyPreset,lunarTransmittance} from './sky-presets.js';
import { makeRng, GLSL_HASH } from './noise.js';

const D2R = Math.PI / 180;
const RG_KM = 6360, RT_KM = 6460, RP = 6360000; // planet / atmosphere radius
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };
const mix = (a, b, t) => a + (b - a) * t;
const dirFrom = (azDeg, elDeg) => { const az = azDeg * D2R, el = elDeg * D2R, c = Math.cos(el); return [Math.sin(az) * c, Math.sin(el), -Math.cos(az) * c]; };
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// ---------------------------------------------------------------------------------------------------------------
// Defaults (all tunable through opts). Exposure numbers follow docs/LIB_COMMON.md §2.
// ---------------------------------------------------------------------------------------------------------------
export const SKY_DEFAULTS = {
  seed: 'sky-v1',
  moonScale: 2.2,             // x real angular size (0.53 deg)
  moonRadiance: 28,           // disc radiance above the atmosphere (observed ~18-20 at 30 deg elevation) — overexposes on purpose
  moonTint: [1.0, 0.965, 0.92],
  moonPhaseAngle: 21,         // deg (0 = full). ~96.7 % illuminated waxing gibbous
  moonTilt: 1,                // 1 = physical parallactic rotation (lunar north toward the celestial pole), 0 = north up
  latitude: 31,               // observer latitude (temperate)
  moonTexSize: null,          // default 1024 final / 512 preview
  sunScale: 1.25,
  sunRadiance: 520,           // disc radiance at the top of the atmosphere (>= 300 after extinction at noon)
  sunE: 7.85,                 // sun irradiance (white surface facing the sun = 2.5 at ground, see LIB_COMMON)
  moonE: 0.22,                // moon irradiance (white surface = 0.07 on a clear night)
  sunColor: [1.0, 0.985, 0.955],
  moonLightColor: [0.93, 0.97, 1.0],   // colour of moonlight used for the atmosphere/clouds (physics: ~sunlight)
  daySkyGain: 1.3,
  nightSkyGain: 1.35,
  nightTint: [0.86, 1.0, 1.0],         // slight cool bias of the moonlit sky (film look)
  airglow: [0.00016, 0.00024, 0.00036],
  mie: 14,                    // aerosol multiplier over Bruneton's clean-air default (AOD ~0.07: hazy temperate air)
  mieG: 0.78,
  groundAlbedo: 0.12,
  stars: 1.0,                 // star brightness multiplier (brightest star peak ~1.0)
  milkyWay: 1.0,
  halo: 1.0,                  // moon halo strength multiplier (peak ~0.25 at the limb)
  // clouds
  cloudBase: 760, cloudTop: 1420,      // clear-weather slab, metres
  rainBase: 480, rainTop: 1900,        // rain-cloud slab
  rainEdgeX: -20,                      // world x of the configurable ragged rain edge
  rainCell: [0, -500, 1200, 400],     
  rainRegionX: [0, -100],                 
  rainCloudBlob: [1000, 400, 250, 0],   
  cloudDensity: 0.022,                 // extinction (1/m) at density 1
  shapeScale: 3600, detailScale: 1300, // metres per noise tile
  maxCloudDist: 26000,
  gapRadius: 13,                       // deg, angular radius of the moon gap at world.moonGap = 1
  gapOrigin: [0, 2, 0],                // reference viewer for the gap cone (valley centre)
  cirrusAltitude: 8200, cirrus: null,  // cirrus amount (null = derived from world.cloudCover)
  visibility: 14000,                   // aerial-perspective visibility for distant clouds (m)
  cloudRes: null,                      // fraction of the output resolution for the cloud buffer (default .30 final / .2 preview)
  edgeDetail: true, edgeScale: 420, edgeStrength: 0.9, edgeSteep: 1.7,   // full-res cloud edge detail (m per noise tile, strength, alpha steepening)
  budget: 'auto',                      // 'auto' (SwiftShader -> cheaper final clouds) | 'low' | 'high'
  overlay: 'auto',                     // 'auto' | true | false  (clouds composited over scene geometry)
  drift: null,                         // optional (t) => metres of wind drift
  envSize: null,                       // cubeUV face size (default 64 final / 32 preview)
};

// Wind drift of the cloud field (metres along the wind) — closed-form integral of a piecewise-linear speed
// profile (m/s). Projects supply opts.drift for time remapping.
const SPEED_KEYS = [[0,6],[10000,6]];
function driftAt(t) {
  let acc = 0;
  if (t <= 0) return SPEED_KEYS[0][1] * t;
  for (let i = 0; i < SPEED_KEYS.length - 1; i++) {
    const [t0, v0] = SPEED_KEYS[i], [t1, v1] = SPEED_KEYS[i + 1];
    if (t <= t0) break;
    const te = Math.min(t, t1), u = te - t0;
    acc += v0 * u + 0.5 * (v1 - v0) / (t1 - t0) * u * u;
    if (t <= t1) break;
  }
  return acc;
}

// Twilight model (film look, see engine/README.md §6): the physical LUT sky is correct in colour but, in our compressed
// day-for-night exposure scale, far too dark between sun -12° and +2°. Two smooth gains of the sun's scattered light:
//   G_u(e): overall (zenith, Belt of Venus, earth shadow) and A(e): extra glow concentrated near the horizon toward the
//   sun (the twilight arch). Keys: [sun elevation (deg), log10 gain] and [elevation, A]; C1 (smoothstep in log space).
const TWI_GU = [[3, 0], [1, 0.15], [0, 0.3], [-1, 0.45], [-3, 0.8], [-6, 1.45], [-9, 1.75], [-12, 1.8], [-15, 1.3], [-18, 0]];
const TWI_A = [[5, 0], [3, 1.5], [1, 5], [0, 9], [-1, 14], [-3, 24], [-6, 13], [-9, 8], [-12, 9], [-15, 4], [-18, 0]];
// additive deep-blue twilight base (the ozone-blue 'blue hour' sky the physical model under-represents): lum = K * 0.0092
const TWI_BLUE = [[1, 0], [-1, 0.35], [-3, 0.7], [-6, 1.0], [-9, 0.9], [-12, 0.85], [-15, 0.5], [-18, 0.15], [-21, 0]];
function keyInterp(keys, e) {
  if (e >= keys[0][0]) return keys[0][1];
  if (e <= keys[keys.length - 1][0]) return keys[keys.length - 1][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [e0, v0] = keys[i], [e1, v1] = keys[i + 1];
    if (e <= e0 && e >= e1) { const u = (e0 - e) / (e0 - e1); const s = u * u * (3 - 2 * u); return v0 + (v1 - v0) * s; }
  }
  return 0;
}
export function twilightGains(sunElevDeg) {
  return { gu: Math.pow(10, keyInterp(TWI_GU, sunElevDeg)), a: keyInterp(TWI_A, sunElevDeg), blue: keyInterp(TWI_BLUE, sunElevDeg),
    sigAz: (40 + 2 * Math.max(0, -sunElevDeg)) * D2R, sigEl: (6 + Math.max(0, -sunElevDeg)) * D2R };
}

// ---------------------------------------------------------------------------------------------------------------
// CPU noise bakes (deterministic). 3-D: 64^3 RGBA8 tileable (R perlin-worley, G/B worley fbm, A perlin fbm).
// ---------------------------------------------------------------------------------------------------------------
function bakeNoise3D(N, seedStr) {
  const rng = makeRng(seedStr + ':n3');
  const data = new Uint8Array(N * N * N * 4);
  // periodic gradient noise
  const P = 256, perm = new Int32Array(P * 2), gx = new Float32Array(P), gy = new Float32Array(P), gz = new Float32Array(P);
  for (let i = 0; i < P; i++) perm[i] = i;
  for (let i = P - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  for (let i = 0; i < P; i++) { perm[i + P] = perm[i]; let x, y, z, l; do { x = rng() * 2 - 1; y = rng() * 2 - 1; z = rng() * 2 - 1; l = x * x + y * y + z * z; } while (l > 1 || l < 0.05); l = Math.sqrt(l); gx[i] = x / l; gy[i] = y / l; gz[i] = z / l; }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const perlin = (x, y, z, per) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi, u = fade(xf), v = fade(yf), w = fade(zf);
    let r = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      const X = ((xi + dx) % per + per) % per, Y = ((yi + dy) % per + per) % per, Z = ((zi + dz) % per + per) % per;
      const h = perm[perm[perm[X & 255] + (Y & 255)] + (Z & 255)];
      const g = gx[h] * (xf - dx) + gy[h] * (yf - dy) + gz[h] * (zf - dz);
      r += g * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
    }
    return r; // ~[-1,1]
  };
  // worley feature points per octave (cells per axis)
  const pts = new Map();
  const featureSet = (cells) => {
    if (pts.has(cells)) return pts.get(cells);
    const r2 = makeRng(seedStr + ':w' + cells);
    const a = new Float32Array(cells * cells * cells * 3);
    for (let i = 0; i < a.length; i++) a[i] = r2();
    pts.set(cells, a);
    return a;
  };
  const worley = (x, y, z, cells) => { // x,y,z in [0,1) ; returns F1 distance in cell units (0..~1)
    const fp = featureSet(cells);
    const X = x * cells, Y = y * cells, Z = z * cells;
    const xi = Math.floor(X), yi = Math.floor(Y), zi = Math.floor(Z);
    let best = 9;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy, cz = zi + dz;
      const wx = ((cx % cells) + cells) % cells, wy = ((cy % cells) + cells) % cells, wz = ((cz % cells) + cells) % cells;
      const k = ((wz * cells + wy) * cells + wx) * 3;
      const px = cx + fp[k] - X, py = cy + fp[k + 1] - Y, pz = cz + fp[k + 2] - Z;
      const d = px * px + py * py + pz * pz;
      if (d < best) best = d;
    }
    return Math.min(1, Math.sqrt(best));
  };
  const wfbm = (x, y, z, c0) => (1 - worley(x, y, z, c0)) * 0.625 + (1 - worley(x, y, z, c0 * 2)) * 0.25 + (1 - worley(x, y, z, c0 * 4)) * 0.125;
  const R = new Float32Array(N * N * N), G = new Float32Array(N * N * N), B = new Float32Array(N * N * N), A = new Float32Array(N * N * N);
  let i = 0;
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++, i++) {
    const u = (x + 0.5) / N, v = (y + 0.5) / N, w = (z + 0.5) / N;
    // billowy perlin fbm, base period 4
    let pf = 0, amp = 1, na = 0;
    for (let o = 0; o < 4; o++) { const per = 4 << o; pf += amp * perlin(u * per, v * per, w * per, per); na += amp; amp *= 0.5; }
    pf = pf / na; // ~[-0.7,0.7]
    const pb = clamp(Math.abs(pf * 1.9) * 0.5 + 0.5 * (pf * 1.2 + 0.5), 0, 1); // mix of billowy & plain
    const wf0 = wfbm(u, v, w, 3);
    R[i] = wf0 + pb * (1 - wf0) - 0.0; // remap(perlin, 0, 1, worley, 1)
    G[i] = wfbm(u, v, w, 4);
    B[i] = wfbm(u, v, w, 8);
    let af = 0; amp = 1; na = 0;
    for (let o = 0; o < 3; o++) { const per = 8 << o; af += amp * perlin(u * per, v * per, w * per, per); na += amp; amp *= 0.5; }
    A[i] = af / na * 0.5 + 0.5;
  }
  // contrast-normalise each channel to [0,1] (robust percentiles)
  const normCh = (arr, lo = 0.01, hi = 0.995) => {
    const s = Float32Array.from(arr).sort();
    const a = s[Math.floor(lo * (s.length - 1))], b = s[Math.floor(hi * (s.length - 1))];
    for (let k = 0; k < arr.length; k++) arr[k] = clamp((arr[k] - a) / (b - a));
  };
  normCh(R); normCh(G); normCh(B); normCh(A);
  for (let k = 0; k < N * N * N; k++) {
    data[k * 4] = Math.round(R[k] * 255); data[k * 4 + 1] = Math.round(G[k] * 255);
    data[k * 4 + 2] = Math.round(B[k] * 255); data[k * 4 + 3] = Math.round(A[k] * 255);
  }
  return data;
}

// ---------------------------------------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------------------------------------
const VS_QUAD = /* glsl */ `out vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const HEAD = /* glsl */ `
precision highp float; precision highp int; precision highp sampler3D;
#define PI 3.14159265358979
#define TAU 6.28318530717959
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec2 equirectUv(vec3 d){ return vec2(atan(d.z, d.x) * (0.5 / PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) * (1.0 / PI) + 0.5); }
vec3 equirectDir(vec2 uv){ float ph = (uv.x - 0.5) * TAU, th = (uv.y - 0.5) * PI; return vec3(cos(th) * cos(ph), sin(th), cos(th) * sin(ph)); }
float ign(vec2 px){ return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
float hgPhase(float c, float g){ float g2 = g * g; float x = max(1.0 + g2 - 2.0 * g * c, 1e-4); return (1.0 - g2) / (4.0 * PI * x * sqrt(x)); }
float angApprox(float c){ return sqrt(max(0.0, 2.0 - 2.0 * c)); }
`;

const QHEAD = HEAD + 'in vec2 vUv;\n';

// ---- atmosphere (units: km) ----
const ATMO = /* glsl */ `
const float RG = ${RG_KM.toFixed(1)}, RT = ${RT_KM.toFixed(1)};
const vec3 RAY_S = vec3(5.802e-3, 13.558e-3, 33.1e-3);
const float RAY_H = 8.0, MIE_S0 = 3.996e-3, MIE_E0 = 4.440e-3, MIE_H = 1.2;
const vec3 OZO_A = vec3(0.650e-3, 1.881e-3, 0.085e-3);
uniform float uMie;
uniform sampler2D uTransLUT;
vec3 atmoExt(float h){ return RAY_S * exp(-h / RAY_H) + vec3(MIE_E0 * uMie * exp(-h / MIE_H)) + OZO_A * max(0.0, 1.0 - abs(h - 25.0) / 15.0); }
float distTop(float r, float mu){ float d = r * r * (mu * mu - 1.0) + RT * RT; return max(0.0, -r * mu + sqrt(max(d, 0.0))); }
float distGround(float r, float mu){ float d = r * r * (mu * mu - 1.0) + RG * RG; return max(0.0, -r * mu - sqrt(max(d, 0.0))); }
bool hitGround(float r, float mu){ return mu < 0.0 && r * r * (mu * mu - 1.0) + RG * RG >= 0.0; }
vec2 transUV(float r, float mu){
  float H = sqrt(RT * RT - RG * RG);
  float rho = sqrt(max(r * r - RG * RG, 0.0));
  float d = distTop(r, mu);
  float dmin = RT - r, dmax = rho + H;
  float xm = (d - dmin) / max(dmax - dmin, 1e-6), xr = rho / H;
  return vec2(0.5 / 256.0 + xm * (1.0 - 1.0 / 256.0), 0.5 / 64.0 + xr * (1.0 - 1.0 / 64.0));
}
vec3 transmittance(float r, float mu){ return texture(uTransLUT, transUV(r, mu)).rgb; }
float planetShadow(float r, float mu){ float muh = -sqrt(max(0.0, 1.0 - (RG * RG) / (r * r))); return smoothstep(muh - 0.0065, muh + 0.0065, mu); }
float phaseRay(float c){ return 3.0 / (16.0 * PI) * (1.0 + c * c); }
float phaseMie(float c, float g){ float g2 = g * g; return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-5), 1.5)); }
`;

const FS_TRANS = HEAD + ATMO + /* glsl */ `
out vec4 o;
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5) / vec2(255.0, 63.0);
  float H = sqrt(RT * RT - RG * RG);
  float rho = H * uv.y;
  float r = sqrt(rho * rho + RG * RG);
  float dmin = RT - r, dmax = rho + H;
  float d = dmin + uv.x * (dmax - dmin);
  float mu = d <= 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
  mu = clamp(mu, -1.0, 1.0);
  float L = distTop(r, mu);
  vec3 od = vec3(0.0);
  float dt = L / 40.0;
  for (int i = 0; i < 40; i++) { float t = (float(i) + 0.5) * dt; float ri = sqrt(r * r + t * t + 2.0 * r * mu * t); od += atmoExt(ri - RG) * dt; }
  o = vec4(exp(-od), 1.0);
}`;

const FS_MS = HEAD + ATMO + /* glsl */ `
out vec4 o;
uniform float uGroundAlbedo;
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5) / 31.0;
  float muS = uv.x * 2.0 - 1.0;
  float r = RG + max(uv.y * (RT - RG), 0.01);
  vec3 pos = vec3(0.0, r, 0.0);
  vec3 sunDir = vec3(0.0, muS, sqrt(max(0.0, 1.0 - muS * muS)));
  vec3 L2 = vec3(0.0), F = vec3(0.0);
  for (int i = 0; i < 8; i++) for (int j = 0; j < 8; j++) {
    float ct = 1.0 - 2.0 * (float(j) + 0.5) / 8.0, st = sqrt(max(0.0, 1.0 - ct * ct));
    float ph = TAU * (float(i) + 0.5) / 8.0;
    vec3 dir = vec3(st * cos(ph), ct, st * sin(ph));
    bool g = hitGround(r, dir.y);
    float tMax = g ? distGround(r, dir.y) : distTop(r, dir.y);
    float dt = tMax / 20.0;
    vec3 T = vec3(1.0), Lf = vec3(0.0), Ff = vec3(0.0);
    for (int k = 0; k < 20; k++) {
      vec3 P = pos + dir * ((float(k) + 0.5) * dt);
      float rk = length(P), hk = rk - RG, muk = dot(P / rk, sunDir);
      vec3 sc = RAY_S * exp(-hk / RAY_H) + vec3(MIE_S0 * uMie * exp(-hk / MIE_H));
      vec3 ext = atmoExt(hk);
      vec3 Ts = transmittance(rk, muk) * planetShadow(rk, muk);
      vec3 Tstep = exp(-ext * dt);
      vec3 integ = (1.0 - Tstep) / max(ext, vec3(1e-9));
      Lf += T * sc * Ts * (0.25 / PI) * integ;
      Ff += T * sc * integ;
      T *= Tstep;
    }
    if (g) { vec3 P = pos + dir * tMax; float rg = length(P), mug = dot(P / rg, sunDir); Lf += T * transmittance(rg, mug) * planetShadow(rg, mug) * max(mug, 0.0) * uGroundAlbedo / PI; }
    L2 += Lf; F += Ff;
  }
  L2 /= 64.0; F /= 64.0;
  o = vec4(L2 / max(vec3(1e-4), 1.0 - F), 1.0);
}`;

// sky-view LUT parameterisation (Hillaire 2020): x = world azimuth (0 = north, clockwise), y = horizon-relative
// zenith angle with sqrt concentration at the horizon. v = 0 zenith, 0.5 horizon, 1 nadir.
const LUTMAP = /* glsl */ `
uniform vec2 uLutSize;
vec2 lutUV(vec3 dir, float r){
  float az = atan(dir.x, -dir.z);
  float u = fract(az / TAU + 1.0);
  float beta = acos(clamp(sqrt(max(r * r - RG * RG, 0.0)) / r, -1.0, 1.0));
  float zha = PI - beta;
  float th = acos(clamp(dir.y, -1.0, 1.0));
  float v;
  if (th < zha) { float c = 1.0 - th / zha; c = sqrt(max(c, 0.0)); v = (1.0 - c) * 0.5; }
  else { float c = (th - zha) / max(beta, 1e-5); v = sqrt(clamp(c, 0.0, 1.0)) * 0.5 + 0.5; }
  return vec2(u, 0.5 / uLutSize.y + v * (1.0 - 1.0 / uLutSize.y));
}
vec3 lutDir(vec2 fc, float r){          // fc = gl_FragCoord.xy
  float u = fc.x / uLutSize.x;
  float v = (fc.y - 0.5) / (uLutSize.y - 1.0);
  float beta = acos(clamp(sqrt(max(r * r - RG * RG, 0.0)) / r, -1.0, 1.0));
  float zha = PI - beta, th;
  if (v < 0.5) { float c = 1.0 - 2.0 * v; th = zha * (1.0 - c * c); }
  else { float c = 2.0 * v - 1.0; th = zha + beta * c * c; }
  float az = u * TAU;
  return vec3(sin(az) * sin(th), cos(th), -cos(az) * sin(th));
}`;

const FS_SKYVIEW = HEAD + ATMO + LUTMAP + /* glsl */ `
layout(location = 0) out vec4 oSR; layout(location = 1) out vec4 oSM; layout(location = 2) out vec4 oMR; layout(location = 3) out vec4 oMM;
uniform sampler2D uMSLUT;
uniform float uCamR, uGroundAlbedo, uFloorAlbedo;
uniform vec3 uSunDir, uMoonDir;
vec3 msLookup(float h, float muS){ return texture(uMSLUT, vec2(0.5 / 32.0 + (muS * 0.5 + 0.5) * (31.0 / 32.0), 0.5 / 32.0 + clamp(h / (RT - RG), 0.0, 1.0) * (31.0 / 32.0))).rgb; }
void main(){
  float r = uCamR;
  vec3 dir = lutDir(gl_FragCoord.xy, r);
  vec3 pos = vec3(0.0, r, 0.0);
  bool g = hitGround(r, dir.y);
  float tMax = g ? distGround(r, dir.y) : distTop(r, dir.y);
  float pS = phaseRay(dot(dir, uSunDir)), pM = phaseRay(dot(dir, uMoonDir));
  vec3 T = vec3(1.0), aSR = vec3(0.0), aSM = vec3(0.0), aMR = vec3(0.0), aMM = vec3(0.0);
  float tPrev = 0.0;
  const int N = 28;
  for (int i = 0; i < N; i++) {
    float s1 = (float(i) + 1.0) / float(N);
    float t1 = tMax * s1 * s1, dt = t1 - tPrev, t = 0.5 * (t1 + tPrev); tPrev = t1;
    vec3 P = pos + dir * t; float rk = length(P), hk = rk - RG; vec3 up = P / rk;
    vec3 sR = RAY_S * exp(-hk / RAY_H); float sM = MIE_S0 * uMie * exp(-hk / MIE_H);
    vec3 ext = atmoExt(hk);
    vec3 Tstep = exp(-ext * dt);
    vec3 integ = T * (1.0 - Tstep) / max(ext, vec3(1e-9));
    float muS = dot(up, uSunDir);
    vec3 TsS = transmittance(rk, muS) * planetShadow(rk, muS);
    vec3 msS = msLookup(hk, muS);
    aSR += integ * (sR * (TsS * pS + msS) + sM * msS);
    aSM += integ * sM * TsS;
    float muM = dot(up, uMoonDir);
    vec3 TsM = transmittance(rk, muM) * planetShadow(rk, muM);
    vec3 msM = msLookup(hk, muM);
    aMR += integ * (sR * (TsM * pM + msM) + sM * msM);
    aMM += integ * sM * TsM;
    T *= Tstep;
  }
  if (g) {
    vec3 P = pos + dir * tMax; float rg = length(P); vec3 up = P / rg;
    float muS = dot(up, uSunDir), muM = dot(up, uMoonDir);
    aSR += T * (transmittance(rg, muS) * planetShadow(rg, muS) * max(muS, 0.0) + msLookup(0.0, muS) * 2.0) * uFloorAlbedo / PI;
    aMR += T * (transmittance(rg, muM) * planetShadow(rg, muM) * max(muM, 0.0) + msLookup(0.0, muM) * 2.0) * uFloorAlbedo / PI;
  }
  oSR = vec4(aSR, 1.0); oSM = vec4(aSM, 1.0); oMR = vec4(aMR, 1.0); oMM = vec4(aMM, 1.0);
}`;

// ---- clear sky (atmosphere + milky way + airglow + wide halos), equirect ----
const FS_CLEAR = QHEAD + ATMO + LUTMAP + /* glsl */ `
out vec4 o;
uniform sampler2D uSR, uSM, uMR, uMM, uWeather;
uniform float uCamR, uMieG;
uniform vec3 uSunDir, uMoonDir, uSunE, uMoonE, uAirglow;
uniform vec4 uNight;        // rgb night tint, a = night amount (1 - day)
uniform vec4 uMW;           // milky way: x intensity, y (unused), z,w
uniform mat3 uGal;          // world -> galactic
uniform vec4 uHaloW;        // x amplitude (behind clouds, wide part), y 1/w1, z 1/w2, w 1/w3
uniform vec3 uHaloCol;
uniform vec4 uTwi;          // x overall gain G_u, y horizon-glow gain A, z azimuth sigma (rad), w elevation sigma (rad)
uniform vec3 uTwiBlue;      // additive twilight blue (radiance at the zenith)
float twilightGain(vec3 d){
  if (uTwi.x <= 1.0001 && uTwi.y <= 0.0001) return 1.0;
  vec2 hs = normalize(uSunDir.xz + vec2(1e-6)), hd = normalize(d.xz + vec2(1e-6));
  float cA = dot(hs, hd);
  float wAz = exp(-(1.0 - cA) / (0.5 * uTwi.z * uTwi.z));
  float el = asin(clamp(d.y, -1.0, 1.0));
  float wEl = exp(-abs(el) / uTwi.w);
  return uTwi.x * (1.0 + uTwi.y * wAz * wEl);
}
float mwNoise(vec2 q){ return texture(uWeather, q).g; }
void main(){
  vec3 dir = equirectDir(vUv);
  vec2 luv = lutUV(dir, uCamR);
  float cs = dot(dir, uSunDir), cm = dot(dir, uMoonDir);
  vec3 L = uSunE * (texture(uSR, luv).rgb + texture(uSM, luv).rgb * phaseMie(cs, uMieG)) * twilightGain(dir)
         + uMoonE * (texture(uMR, luv).rgb + texture(uMM, luv).rgb * phaseMie(cm, uMieG)) * uNight.rgb;
  float horizonMu = -sqrt(max(0.0, 1.0 - (RG * RG) / (uCamR * uCamR)));
  float above = smoothstep(horizonMu - 0.004, horizonMu + 0.004, dir.y);
  if (above > 0.0) {
    vec3 Tv = transmittance(uCamR, dir.y);
    vec3 night = uAirglow * (1.0 + 1.2 * pow(1.0 - max(dir.y, 0.0), 4.0));
    // Milky Way
    vec3 g = uGal * dir;
    float b = asin(clamp(g.y, -1.0, 1.0)), l = atan(g.z, g.x);
    float band = exp(-b * b / (2.0 * 0.11 * 0.11));
    float bulge = exp(-l * l / (2.0 * 0.55 * 0.55)) * exp(-b * b / (2.0 * 0.2 * 0.2));
    vec2 q = vec2(l / TAU * 5.0, b * 1.6);
    float n1 = mwNoise(q * 1.0 + 0.31), n2 = mwNoise(q * 2.7 + 0.77), n3 = mwNoise(q * 6.1 + 0.13);
    float clumps = 0.55 + 0.9 * (n1 * 0.55 + n2 * 0.3 + n3 * 0.15);
    float dust = smoothstep(0.35, 0.75, n2 * 0.6 + n1 * 0.4) * exp(-b * b / (2.0 * 0.045 * 0.045)) * (0.5 + 0.5 * exp(-l * l / 1.2));
    vec3 mwc = mix(vec3(0.78, 0.84, 1.0), vec3(1.0, 0.88, 0.72), clamp(bulge * 1.5, 0.0, 1.0));
    float mw = (band * 0.55 * clumps + bulge * 1.3 * clumps) * (1.0 - 0.8 * dust);
    night += mwc * mw * uMW.x;
    L += night * Tv * uNight.a * above;
    // twilight blue base: slightly brighter toward the horizon, a little violet away from the sun
    float hz = 1.0 - max(dir.y, 0.0);
    L += uTwiBlue * (0.8 + 0.55 * hz * hz * hz) * above;
    // wide moon halo (haze/aerosol forward scattering beyond the LUT aureole) — behind the clouds
    float th = acos(clamp(cm, -1.0, 1.0));
    float hw = exp(-th * uHaloW.z) * 0.3 + exp(-th * uHaloW.w) * 0.1;
    L += uHaloCol * (uHaloW.x * hw) * above;
  }
  o = vec4(max(L, vec3(0.0)), 1.0);
}`;

// ---- ambient: 6 directions (+x -x +y -y +z -z) cosine-weighted irradiance/pi of an equirect ----
const FS_AMB = HEAD + /* glsl */ `
out vec4 o;
uniform sampler2D uSrc;
void main(){
  int k = int(gl_FragCoord.x);
  vec3 N = k == 0 ? vec3(1,0,0) : k == 1 ? vec3(-1,0,0) : k == 2 ? vec3(0,1,0) : k == 3 ? vec3(0,-1,0) : k == 4 ? vec3(0,0,1) : vec3(0,0,-1);
  vec3 T = normalize(cross(abs(N.y) < 0.9 ? vec3(0,1,0) : vec3(1,0,0), N)); vec3 B = cross(N, T);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 8; i++) for (int j = 0; j < 8; j++) {
    float u1 = (float(i) + 0.5) / 8.0, u2 = (float(j) + 0.5) / 8.0;
    float r = sqrt(u1), ph = TAU * u2;
    vec3 d = normalize(T * (r * cos(ph)) + B * (r * sin(ph)) + N * sqrt(max(0.0, 1.0 - u1)));
    acc += textureLod(uSrc, equirectUv(d), 0.0).rgb;
  }
  o = vec4(acc / 64.0, 1.0);
}`;

// ---- clouds: density, light, march (metres) ----
const CLOUDS = /* glsl */ `
uniform sampler3D uNoise3;
uniform sampler2D uWeather;
uniform vec4 uCA;    // coverage east, coverage rain side, rain amount, extinction scale (1/m)
uniform vec4 uCB;    // base east, top east, base rain, top rain
uniform vec4 uCC;    // gap amount, gap cos inner, gap cos outer, rain edge x
uniform vec4 uCD;    // shell min base, shell max top, max distance, shape scale
uniform vec4 uCE;    // detail scale, visibility (m), cirrus altitude, cirrus amount
uniform vec3 uGapDir, uGapOrigin, uWind, uWind2;
uniform vec3 uKeyDir, uKeyCol, uSecDir, uSecCol;
uniform vec3 uAmbTop, uAmbBot;
uniform sampler2D uAmbTex;
uniform float uAmbGPU;
uniform vec3 uGlowDir;
uniform float uGlowW;
vec3 ambToward(vec3 n, int row){
  vec3 n2 = n * n;
  return texelFetch(uAmbTex, ivec2(n.x >= 0.0 ? 0 : 1, row), 0).rgb * n2.x + texelFetch(uAmbTex, ivec2(n.z >= 0.0 ? 4 : 5, row), 0).rgb * n2.z;
}
const float RP = 6360000.0;
float altOf(vec3 p){ return p.y + dot(p.xz, p.xz) * (0.5 / RP); }
float altExact(vec3 p){ float q = dot(p.xz, p.xz) + p.y * p.y + 2.0 * RP * p.y; return q / (sqrt(dot(p.xz, p.xz) + (p.y + RP) * (p.y + RP)) + RP); }
// intersections with the sphere of altitude H (numerically stable); returns (t_near, t_far) or (-1,-1)
vec2 shellHit(vec3 o, vec3 d, float H){
  float b = dot(d, vec3(o.x, o.y + RP, o.z));
  float c = dot(o.xz, o.xz) + o.y * o.y - H * H + 2.0 * RP * (o.y - H);
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float sq = sqrt(disc);
  float q = -b - (b >= 0.0 ? sq : -sq);
  float t1 = q, t2 = c / q;
  return vec2(min(t1, t2), max(t1, t2));
}
float remap01(float x, float a, float b){ return clamp((x - a) / max(b - a, 1e-5), 0.0, 1.0); }
uniform vec4 uRainCell;   
uniform vec4 uView;       
uniform vec4 uRainBlob;    // moon-hiding patch: centre altitude, half length along the moon direction, radius (m)



vec2 rainMaskAt(vec3 p, float h, float n, float n2, vec4 w3){
  float e = uRainCell.x + 380.0 * (n - 0.5) + 260.0 * (n2 - 0.5) + 240.0 * (w3.r - 0.5) + 110.0 * (w3.b - 0.5);
  float A = smoothstep(e + 150.0, e - 330.0, p.x) * smoothstep(uRainCell.y - 60.0, uRainCell.y + 200.0, p.x)
          * smoothstep(uRainCell.z + 350.0, uRainCell.z - 250.0, abs(p.z + 300.0 * (n2 - 0.5)));
  float B = 0.0, C = 0.0;
  if (uGapDir.y > 0.035) {
    
    
    
    vec2 fp = p.xz - uGapDir.xz * (h / uGapDir.y);
    float cw = uRainCell.w * (0.75 + 0.5 * w3.b);
    C = (1.0 - uView.w) * smoothstep(-60.0, 90.0, fp.x) * smoothstep(640.0 + 200.0 * w3.r, 300.0, fp.x) * smoothstep(cw + 260.0, cw - 160.0, abs(fp.y));
  }
  return vec2(max(A, B), C);
}

float rainPatchR(vec3 p){
  vec3 dv = p - uView.xyz;
  float along = dot(dv, uGapDir);
  float sc = (uRainBlob.x - uView.y) / max(uGapDir.y, 0.05);
  vec3 pp = dv - uGapDir * along;
  vec3 uh = normalize(cross(uGapDir, vec3(0.0, 1.0, 0.0)));
  vec3 uv = cross(uh, uGapDir);
  vec2 q = vec2(dot(pp, uh) / 1.9, dot(pp, uv)) / uRainBlob.z;
  return length(vec3(q, (along - sc) / uRainBlob.y));
}
float gFar = 0.0;   // 0 near .. 1 far (set by the march): coarser, softer clouds far away

// view sample and reused by that sample's light march (only the 3-D noise is re-fetched there) — keeps SwiftShader fast.
struct CCol { float base; float top; float cov; float rm; };
CCol cloudColumn(vec3 p, float h){
  vec2 xz = p.xz;
  vec4 w = texture(uWeather, (xz + uWind.xz * 0.55) * (1.0 / 17000.0));
  vec4 w2 = texture(uWeather, (xz + uWind.xz * 0.8) * (1.0 / 5300.0) + vec2(0.37, 0.61));
  vec4 w3 = texture(uWeather, (xz + uWind.xz * 0.9) * (1.0 / 1700.0) + vec2(0.21, 0.83));
#ifdef RAIN_FX
  vec2 rmc = rainMaskAt(p, h, w.g, w2.a, w3);
#else
  vec2 rmc = vec2(0.0);
#endif
  CCol c;
  c.rm = rmc.x * uCA.z;
  c.base = mix(uCB.x, uCB.z, c.rm) + (w2.g - 0.5) * 180.0;
  c.top = mix(uCB.y, uCB.w, c.rm) + (w.a - 0.5) * 260.0;
  float cov = mix(uCA.x, uCA.y, c.rm);
  cov = cov + (w.r - 0.5) * 0.62 * (1.0 - 0.6 * c.rm) + (w2.r - 0.5) * 0.22 - c.rm * 0.4 * smoothstep(0.58, 0.8, w2.b);
  cov -= rmc.y * (1.0 - c.rm) * 0.9 * min(1.0, uCA.z * 2.0);   
  if (uCC.x > 0.0) {
    vec3 v = normalize(p - uGapOrigin);
    float gc = dot(v, uGapDir) + (w2.b - 0.5) * 0.035 + (w3.r - 0.5) * 0.02 + (w.b - 0.5) * 0.015;
    cov -= uCC.x * smoothstep(uCC.z, uCC.y, gc) * (0.95 + 0.6 * w3.g);
  }
  c.cov = cov;
  return c;
}
float densityFromCol(vec3 p, float h, CCol c, bool hi, out float h01){
  h01 = (h - c.base) / (c.top - c.base);
  if (h01 < 0.0 || h01 > 1.0) return 0.0;
  float cov = c.cov;
#ifdef RAIN_FX
  if (cov <= 0.02 && uView.w * uCA.z < 0.001) return 0.0;
#else
  if (cov <= 0.02) return 0.0;
#endif
  cov = min(cov, 1.0);
  float prof = smoothstep(0.0, 0.07 + 0.1 * (1.0 - c.rm), h01) * smoothstep(1.0, 0.5 - 0.25 * c.rm, h01);
  vec4 n = texture(uNoise3, (p + uWind) / uCD.w);
  float shape = n.r * (0.85 + 0.15 * n.a);
#ifdef RAIN_FX
  if (uView.w * uCA.z > 0.001 && uGapDir.y > 0.035) {
    float r0 = rainPatchR(p);
    float pr = r0 * (1.0 + (n.r - 0.5) * 1.1 + (n.a - 0.5) * 0.7);   // noisy silhouette, solid core
    cov = min(1.0, cov + 0.85 * uView.w * min(1.0, uCA.z * 1.6) * smoothstep(1.0, 0.25, pr) * (1.0 - uCC.x * 1.2));
  }
#endif
  float d = remap01(shape * prof, 1.0 - cov, 1.0 - 0.45 * cov + 0.35 * gFar);
  if (d <= 0.0) return 0.0;
  if (hi) {
    vec4 dn = texture(uNoise3, (p + uWind2) / uCE.x);
    float det = dn.g * 0.45 + dn.b * 0.3 + dn.a * 0.25;
    float er = mix(1.0 - det, det, clamp(h01 * 3.0, 0.0, 1.0));  // wispy base, billowy top
    d = remap01(d, er * 0.42 * (1.0 - 0.45 * c.rm), 1.0);
  }
  return d * mix(1.0, 3.4, c.rm) * uCA.w;
}
float cloudDensity(vec3 p, float h, bool hi, out float h01){ return densityFromCol(p, h, cloudColumn(p, h), hi, h01); }
float lightOD(vec3 p, vec3 L, CCol c){
  float od = 0.0, ds = 36.0, t = 0.0, h01;
  for (int i = 0; i < LSTEPS; i++) {
    vec3 q = p + L * (t + 0.5 * ds);
    od += densityFromCol(q, altOf(q), c, false, h01) * ds;
    t += ds; ds *= 2.7;
  }
  return od;
}
vec4 marchClouds(vec3 ro, vec3 rd, float tLimit, float jit, out float tHit){
  tHit = 1e9;
  float camH = altExact(ro);
  float hb = uCD.x, ht = uCD.y;
  vec2 B = shellHit(ro, rd, hb), Tt = shellHit(ro, rd, ht), G = shellHit(ro, rd, 0.0);
  float t0, t1;
  bool hitsG = G.x > 0.0;
  if (camH < hb) {
    if (hitsG) return vec4(0.0, 0.0, 0.0, 1.0);
    t0 = B.y; t1 = Tt.y;
  } else if (camH < ht) {
    t0 = 0.0; t1 = B.x > 0.0 ? B.x : Tt.y;
  } else {
    if (Tt.x < 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
    t0 = Tt.x; t1 = B.x > 0.0 ? B.x : Tt.y;
  }
  if (hitsG) t1 = min(t1, G.x);
  t1 = min(t1, min(tLimit, uCD.z));
  if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);
  float len = t1 - t0;
  vec3 L = vec3(0.0); float T = 1.0, tw = 0.0, aw = 0.0;
  float cK = dot(rd, uKeyDir), cS = dot(rd, uSecDir);
  float phK = mix(hgPhase(cK, 0.82), hgPhase(cK, -0.2), 0.28);
  float phKs = 0.75 + 0.25 * 4.0 * PI * hgPhase(cK, 0.45);
  float phS = mix(hgPhase(cS, 0.8), hgPhase(cS, -0.2), 0.3);
  bool secOn = dot(uSecCol, vec3(1.0)) > 1e-6;
  vec3 ambT = uAmbTop, ambB = uAmbBot;
  vec3 ambG = vec3(0.0);
  if (uAmbGPU > 0.5) { ambT = texelFetch(uAmbTex, ivec2(2, 0), 0).rgb; ambB = texelFetch(uAmbTex, ivec2(3, 0), 0).rgb * 0.6; if (uGlowW > 0.0) ambG = ambToward(uGlowDir, 0) * uGlowW; }
  float sPrev = pow(jit / float(STEPS), 1.5);
  for (int i = 0; i < STEPS; i++) {
    float sNext = pow((float(i) + 1.0 + jit) / float(STEPS), 1.5);
    float t = t0 + len * 0.5 * (sPrev + sNext);
    float dt = len * (sNext - sPrev);
    sPrev = sNext;
    if (t > t1) break;
    vec3 p = ro + rd * t;
    float h01;
    gFar = smoothstep(2500.0, 12000.0, t);
    float hp = altOf(p);
    CCol col = cloudColumn(p, hp);
    float d = densityFromCol(p, hp, col, t < 4500.0, h01) * smoothstep(uCD.z, uCD.z * 0.25, t);
    if (d > 1e-6) {
      float odK = lightOD(p, uKeyDir, col);
      float Tl = exp(-odK);
      // single scattering (silver lining) + diffusion-like multiple scattering (clouds reflect ~75 %)
      float msT = 1.0 / (1.0 + 0.2 * odK);
      float farK = smoothstep(3000.0, 11000.0, t);
      vec3 S = uKeyCol * (Tl * mix(phK, 0.25 / PI, farK) + (0.62 / PI) * msT * mix(phKs, 1.0, farK) * (0.35 + 0.65 * smoothstep(0.0, 0.35, h01 + 0.25 * uKeyDir.y)));
      if (secOn) {
        float odS = d * max(uCD.y - altOf(p), 30.0) / max(uSecDir.y, 0.12) * 0.5;
        float TlS = exp(-odS), msS = 1.0 / (1.0 + 0.2 * odS);
        S += uSecCol * (TlS * phS + (0.62 / PI) * msS);
      }
      float ao = clamp(h01, 0.0, 1.0);
      S += 0.5 * (ambT * mix(0.28, 1.0, ao) + ambB * mix(0.8, 0.25, ao));
      S += ambG * (1.0 * mix(1.0, 0.5, ao)) * (0.7 + 0.3 * 4.0 * PI * hgPhase(dot(rd, uGlowDir), 0.4)) * (0.35 + 0.65 * msT);
      float Ts = exp(-d * dt);
      float a = T * (1.0 - Ts);
      L += S * a;
      tw += a * t; aw += a;
      T *= Ts;
      if (T < 0.012) { T = 0.0; break; }
    }
  }
  if (aw > 1e-5) tHit = tw / aw;
  return vec4(L, T);
}`;

// cirrus layer (thin, streaky, high) — shared by the sky map and the background pass
const CIRRUS = /* glsl */ `
uniform vec4 uCi;          // x altitude, y amount, z optical depth scale, w (unused)
uniform vec2 uCiAxis;      // wind axis (x,z)
uniform vec3 uCiWind;      // drift (m)
uniform vec3 uCiKeyCol, uCiKeyDir, uCiAmb;
uniform vec4 uIceHalo;     // x amount, y radius (rad), z width (rad)
vec4 cirrus(vec3 ro, vec3 rd){
  if (uCi.y <= 0.001) return vec4(0.0, 0.0, 0.0, 1.0);
  vec2 hit = shellHit(ro, rd, uCi.x);
  float camH = altExact(ro);
  float t = camH < uCi.x ? hit.y : hit.x;
  if (t <= 0.0 || t > 400000.0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec3 p = ro + rd * t;
  vec2 q = p.xz + uCiWind.xz;
  vec2 w = vec2(dot(q, uCiAxis), dot(q, vec2(-uCiAxis.y, uCiAxis.x)));
  float big = texture(uWeather, q * (1.0 / 41000.0) + vec2(0.13, 0.71)).r;
  float n1 = texture(uWeather, w * vec2(1.0 / 42000.0, 1.0 / 11000.0)).b;
  float n2 = texture(uWeather, w * vec2(1.0 / 14000.0, 1.0 / 3200.0) + vec2(0.5, 0.2) + n1 * 0.08).a;
  float n3 = texture(uWeather, w * vec2(1.0 / 5200.0, 1.0 / 1300.0) + vec2(0.1, 0.9) + n2 * 0.05).a;
  float fib = n1 * 0.55 + n2 * 0.3 + n3 * 0.15;
  float patchM = smoothstep(0.45, 0.8, big);
  float dens = smoothstep(0.52, 0.8, fib) * patchM * (0.6 + 0.4 * n3) + 0.05 * smoothstep(0.55, 0.9, big);
  dens *= uCi.y;
  float mu = abs(dot(normalize(vec3(p.x, p.y + RP, p.z)), rd));
  float fade = exp(-t / 70000.0);                 // distant cirrus dissolves into the horizon haze
  float tau = dens * uCi.z / max(mu, 0.09) * fade;
  float T = exp(-tau);
  float c = dot(rd, uCiKeyDir);
  float ph = mix(hgPhase(c, 0.72), hgPhase(c, -0.15), 0.3);
  float th = acos(clamp(c, -1.0, 1.0));
  float ring = exp(-pow((th - uIceHalo.y) / uIceHalo.z, 2.0));
  vec3 ringCol = mix(vec3(1.0, 0.72, 0.5), vec3(0.85, 0.92, 1.0), smoothstep(-0.5, 1.0, (th - uIceHalo.y) / uIceHalo.z));
  vec3 ciAmb = texelFetch(uAmbTex, ivec2(2, 0), 0).rgb * 0.9 + (uGlowW > 0.0 ? ambToward(uGlowDir, 0) * uGlowW * 0.6 : vec3(0.0));
  vec3 L = (uCiKeyCol * (ph + uIceHalo.x * ring * ringCol * 0.06) + ciAmb) * (1.0 - T);
  return vec4(L, T);
}`;

// cloud march into an equirect (map) or into the screen buffer
const FS_CLOUDMAP = QHEAD + CLOUDS + /* glsl */ `
out vec4 o;
uniform sampler2D uClear;
uniform vec3 uCamPos;
void main(){
  vec3 rd = equirectDir(vUv);
  float tHit;
  vec4 c = marchClouds(uCamPos, rd, 1e9, ign(gl_FragCoord.xy), tHit);
  float Ta = exp(-tHit / uCE.y);
  vec3 haze = texture(uClear, vUv).rgb;
  o = vec4(c.rgb * Ta + (1.0 - c.a) * (1.0 - Ta) * haze, c.a);
}`;

const FS_CLOUDSCREEN_BODY = /* glsl */ `
layout(location = 0) out vec4 oSky;   // clear sky + cirrus (everything above the low clouds), a = cirrus transmittance
layout(location = 1) out vec4 oCld;   // low clouds, premultiplied radiance incl. aerial perspective, a = transmittance
layout(location = 2) out vec4 oDep;   // x = alpha-weighted hit distance (m) * alpha, y = alpha (for weighted resolve)
uniform sampler2D uClear;
uniform vec3 uCamPos;
uniform mat4 uInvVPRot;
uniform float uUseDepth;
uniform sampler2D uDepth;
uniform vec4 uDepthP;   // near, far
void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 pw = uInvVPRot * vec4(ndc, 1.0, 1.0);
  vec3 rd = normalize(pw.xyz / pw.w);
  vec3 clear = texture(uClear, equirectUv(rd)).rgb;
  vec4 ci = cirrus(uCamPos, rd);
  oSky = vec4((clear + nearHalo(rd)) * ci.a + ci.rgb, ci.a);
  float tLim = 1e9;
  if (uUseDepth > 0.5) {
    float dz = texture(uDepth, vUv).r;
    if (dz < 1.0) {
      float z = dz * 2.0 - 1.0;
      float lin = 2.0 * uDepthP.x * uDepthP.y / (uDepthP.y + uDepthP.x - z * (uDepthP.y - uDepthP.x));
      vec4 pf = uInvVPRot * vec4(0.0, 0.0, 1.0, 1.0); vec3 fwd = normalize(pf.xyz / pf.w);
      tLim = lin / max(dot(rd, fwd), 1e-3);
    }
  }
  float tHit;
  vec4 c = marchClouds(uCamPos, rd, tLim, ign(gl_FragCoord.xy), tHit);
  float Ta = exp(-tHit / uCE.y);
  vec3 front = uFrontHalo * uMoonT > 0.0 ? uNearHaloCol * (uFrontHalo * uMoonT * exp(-max(angApprox(dot(rd, uMoonDirD)) - uDisc.w, 0.0) * 9.0)) : vec3(0.0);
  oCld = vec4(c.rgb * Ta + (1.0 - c.a) * (1.0 - Ta) * clear + front, c.a);
  float al = 1.0 - c.a;
  oDep = vec4(min(tHit, 1e6) * al, al, 0.0, 1.0);
}`;

// cloud shadow map: transmittance of the slab along the key light for ground points (x,z) around the valley
const FS_RESOLVE = QHEAD + /* glsl */ `
layout(location = 0) out vec4 oComb; layout(location = 1) out vec4 oSky; layout(location = 2) out vec4 oCld; layout(location = 3) out vec4 oDep;
uniform sampler2D uSrc, uSky, uDep; uniform vec2 uSrcTexel;
void main(){
  vec2 o1 = vec2(uSrcTexel.x, 0.0), o2 = vec2(0.0, uSrcTexel.y);
  vec4 c0 = texture(uSrc, vUv);
  vec4 e0 = texture(uSrc, vUv + o1), e1 = texture(uSrc, vUv - o1), e2 = texture(uSrc, vUv + o2), e3 = texture(uSrc, vUv - o2);
  vec4 k = texture(uSrc, vUv + uSrcTexel) + texture(uSrc, vUv - uSrcTexel) + texture(uSrc, vUv + vec2(uSrcTexel.x, -uSrcTexel.y)) + texture(uSrc, vUv + vec2(-uSrcTexel.x, uSrcTexel.y));
  // firefly clamp: an isolated bright cloudlet (1 low-res pixel) cannot exceed 1.6x its brightest neighbour
  float mN = max(max(dot(e0.rgb, LUMA), dot(e1.rgb, LUMA)), max(dot(e2.rgb, LUMA), dot(e3.rgb, LUMA)));
  float lc = dot(c0.rgb, LUMA);
  if (lc > 1.6 * mN + 1e-5) c0.rgb *= (1.6 * mN + 1e-5) / lc;
  vec4 cl = (c0 * 4.0 + (e0 + e1 + e2 + e3) * 2.0 + k) / 16.0;
  vec4 sk = texture(uSky, vUv);
  vec4 dp = texture(uDep, vUv) * 4.0 + (texture(uDep, vUv + o1) + texture(uDep, vUv - o1) + texture(uDep, vUv + o2) + texture(uDep, vUv - o2)) * 2.0
          + texture(uDep, vUv + uSrcTexel) + texture(uDep, vUv - uSrcTexel) + texture(uDep, vUv + vec2(uSrcTexel.x, -uSrcTexel.y)) + texture(uDep, vUv + vec2(-uSrcTexel.x, uSrcTexel.y));
  oComb = vec4(cl.rgb + cl.a * sk.rgb, cl.a * sk.a);
  oSky = sk; oCld = cl;
  oDep = vec4(dp.y > 1e-4 ? dp.x / dp.y : 1e9, dp.y / 16.0, 0.0, 1.0);
}`;

const FS_SHADOW = QHEAD + CLOUDS + /* glsl */ `
out vec4 o;
uniform vec4 uShadowRect;   // x0, z0, size, groundY
void main(){
  vec2 xz = uShadowRect.xy + vUv * uShadowRect.z;
  vec3 p0 = vec3(xz.x, uShadowRect.w, xz.y);
  vec3 L = uKeyDir;
  if (L.y < 0.02) { o = vec4(0.0); return; }
  vec2 B = shellHit(p0, L, uCD.x), Tt = shellHit(p0, L, uCD.y);
  float t0 = B.y, t1 = min(Tt.y, t0 + 12000.0);
  float dt = (t1 - t0) / 12.0, od = 0.0, h01;
  float t = t0 + dt * 0.5;
  for (int i = 0; i < 12; i++) { vec3 p = p0 + L * t; od += cloudDensity(p, altOf(p), false, h01) * dt; t += dt; }
  float T = exp(-od);
  o = vec4(T, 1.0 / (1.0 + 0.11 * od), 0.0, 1.0);
}`;



const FS_SKYMAP = QHEAD + CLOUDS + CIRRUS + /* glsl */ `
out vec4 o;
uniform sampler2D uClear, uCloudMap;
uniform vec3 uCamPos;
void main(){
  vec3 dir = equirectDir(vUv);
  vec3 L = texture(uClear, vUv).rgb;
  vec4 ci = cirrus(uCamPos, dir);
  L = L * ci.a + ci.rgb;
  vec4 cl = texture(uCloudMap, vUv);
  L = L * cl.a + cl.rgb;
  o = vec4(L, ci.a * cl.a);
}`;

// env map (cubeUV layout of three's PMREM): cone-blurred lookups of the sky map
const VS_ENV = /* glsl */ `in vec3 outputDirection; out vec3 vDir; void main(){ vDir = outputDirection; gl_Position = vec4(position, 1.0); }`;
const FS_ENV = HEAD + /* glsl */ `
in vec3 vDir;
out vec4 o;
uniform sampler2D uSrc0, uSrc1;
uniform float uSigma, uSmall;
vec3 fetchE(vec3 d){ vec2 uv = equirectUv(d); return uSmall > 0.5 ? textureLod(uSrc1, uv, 0.0).rgb : textureLod(uSrc0, uv, 0.0).rgb; }
void main(){
  vec3 N = normalize(vDir);
  if (uSigma < 0.006) { o = vec4(fetchE(N), 1.0); return; }
  vec3 T = normalize(cross(abs(N.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), N)); vec3 B = cross(N, T);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  int n = uSigma > 0.25 ? 96 : 20;
  for (int k = 0; k < 96; k++) {
    if (k >= n) break;
    float u = (float(k) + 0.5) / float(n);
    float th = min(uSigma * sqrt(-2.0 * log(1.0 - u * 0.985)), 1.55);
    float ph = float(k) * 2.39996323;
    vec3 d = normalize(N * cos(th) + (T * cos(ph) + B * sin(ph)) * sin(th));
    float w = sin(max(th, 1e-3)) / max(th, 1e-3);          // area correction of the polar Gaussian on the sphere
    acc += fetchE(d) * w; wsum += w;
  }
  o = vec4(acc / wsum, 1.0);
}`;
const FS_DOWN = QHEAD + /* glsl */ `
out vec4 o;
uniform sampler2D uSrc; uniform vec2 uSrcTexel; uniform float uK;
void main(){
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 off = (vec2(float(i), float(j)) - 1.5) * uSrcTexel * uK;
    acc += textureLod(uSrc, vUv + off, 0.0).rgb;
  }
  o = vec4(acc / 16.0, 1.0);
}`;

// ---- moon & sun discs, near halos, stars (full resolution; also used by skyGLSL) ----
const DISCS = /* glsl */ `
uniform sampler2D uMoonTex;
uniform vec3 uSunDirD, uMoonDirD, uSunRad, uMoonRad;
uniform vec4 uDisc;        // cos sun radius, cos moon radius(+margin), sun radius (rad), moon radius (rad)
uniform mat3 uMoonFrame;   // columns: right (lunar east), north, toward viewer
uniform vec3 uMoonSun;     // sun direction in the moon's local frame (phase)
uniform vec4 uNearHalo;    // x amp (moon), y 1/w (moon), z amp (sun), w 1/w (sun)
uniform vec3 uNearHaloCol, uSunHaloCol;
uniform vec2 uMoonTexInfo;   // x size (texels), y uv scale (1 / (1 + margin))
vec3 moonDisc(vec3 d, float pixAng){
  float c = dot(d, uMoonDirD);
  if (c < uDisc.y) return vec3(0.0);
  vec2 xy = vec2(dot(d, uMoonFrame[0]), dot(d, uMoonFrame[1])) / (max(c, 1e-4) * tan(uDisc.w));
  float r2 = dot(xy, xy);
  float edge = 1.0 - smoothstep(1.0 - pixAng / uDisc.w * 1.2, 1.0 + pixAng / uDisc.w * 0.6, sqrt(r2));
  if (edge <= 0.0) return vec3(0.0);
  float lod = log2(max(1.0, uMoonTexInfo.x * 0.5 * pixAng / uDisc.w));
  vec4 tx = textureLod(uMoonTex, xy * 0.5 * uMoonTexInfo.y + 0.5, lod);
  vec2 nxy = tx.gb * 2.0 - 1.0;
  float zz = sqrt(max(0.0, 1.0 - dot(nxy, nxy)));
  vec3 n = vec3(nxy, zz);
  float mu0 = dot(n, uMoonSun);
  float mu = max(n.z, 0.05);
  float ls = mu0 > 0.0 ? 2.0 * mu0 / (mu0 + mu) : 0.0;
  float term = smoothstep(-0.02, 0.06, dot(vec3(xy, sqrt(max(0.0, 1.0 - r2))), uMoonSun));
  return uMoonRad * (tx.r * 1.6) * ls * term * edge;
}
vec3 sunDisc(vec3 d, float pixAng){
  float c = dot(d, uSunDirD);
  if (c < uDisc.x - 0.00002) return vec3(0.0);
  float th = acos(clamp(c, -1.0, 1.0));
  float rr = th / uDisc.z;
  float edge = 1.0 - smoothstep(1.0 - pixAng / uDisc.z, 1.0 + pixAng / uDisc.z * 0.5, rr);
  float mu = sqrt(max(0.0, 1.0 - min(rr * rr, 1.0)));
  return uSunRad * (1.0 - 0.6 * (1.0 - mu)) * edge;
}
vec3 nearHalo(vec3 d){
  vec3 L = vec3(0.0);
  if (uNearHalo.x > 0.0) L += uNearHaloCol * (uNearHalo.x * exp(-max(angApprox(dot(d, uMoonDirD)) - uDisc.w, 0.0) * uNearHalo.y));
  if (uNearHalo.z > 0.0) L += uSunHaloCol * (uNearHalo.z * exp(-max(angApprox(dot(d, uSunDirD)) - uDisc.z, 0.0) * uNearHalo.w));
  return L;
}`;

const STARS = /* glsl */ `
uniform vec4 uStarP;   // x brightness, y time, z twinkle amount, w (unused)
uvec3 sPcg3(uvec3 v){ v = v * 1664525u + 1013904223u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; v ^= v >> 16u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; return v; }
vec3 starColor(float k){ // k in [0,1]: cool red .. blue-white
  vec3 a = vec3(1.0, 0.62, 0.36), b = vec3(1.0, 0.86, 0.70), c = vec3(1.0, 0.97, 0.94), e = vec3(0.74, 0.84, 1.0);
  return k < 0.3 ? mix(a, b, k / 0.3) : k < 0.7 ? mix(b, c, (k - 0.3) / 0.4) : mix(c, e, (k - 0.7) / 0.3);
}
vec3 faceDir(int f, vec2 uv){
  return f == 0 ? vec3(1.0, uv.y, uv.x) : f == 1 ? vec3(-1.0, uv.y, uv.x) : f == 2 ? vec3(uv.x, 1.0, uv.y) : f == 3 ? vec3(uv.x, -1.0, uv.y) : f == 4 ? vec3(uv.x, uv.y, 1.0) : vec3(uv.x, uv.y, -1.0);
}
// one star per cell (probability prob, corrected for the cube-face cell solid angle), magnitude power law between
// the layer's brightest (peak pMax) and faintest (peak p1) star; Gaussian PSF of ~1 px; deterministic twinkle.
vec3 starLayer(vec3 d, float N, float prob, float p1, float span, uint seed, float sig, float mwBoost){
  vec3 a = abs(d); int f; vec2 uv; float ma;
  if (a.x >= a.y && a.x >= a.z) { f = d.x > 0.0 ? 0 : 1; uv = d.zy; ma = a.x; }
  else if (a.y >= a.z) { f = d.y > 0.0 ? 2 : 3; uv = d.xz; ma = a.y; }
  else { f = d.z > 0.0 ? 4 : 5; uv = d.xy; ma = a.z; }
  uv /= ma;
  vec2 cell = floor((uv * 0.5 + 0.5) * N);
  uvec3 h = sPcg3(uvec3(uvec2(ivec2(cell)), uint(f) + seed * 16u));
  vec3 r = vec3(h) * (1.0 / 4294967296.0);
  vec2 cc = (cell + 0.5) / N * 2.0 - 1.0;
  float sa = 1.0 + dot(cc, cc); sa = 1.0 / (sa * sqrt(sa));
  if (r.x > prob * mwBoost * sa) return vec3(0.0);
  vec2 sp = (cell + 0.2 + 0.6 * r.yz) / N * 2.0 - 1.0;
  vec3 sd = normalize(faceDir(f, sp));
  vec3 dv = d - sd;
  float dist2 = dot(dv, dv);
  float s2 = sig * sig;
  if (dist2 > 12.0 * s2) return vec3(0.0);
  uvec3 h2 = sPcg3(h ^ uvec3(0x9e3779b9u, 0x85ebca6bu, 0xc2b2ae35u));
  vec3 r2 = vec3(h2) * (1.0 / 4294967296.0);
  float peak = p1 * pow(mix(span, 1.0, r2.x), -0.656);
  float tw = 1.0 + uStarP.z * sin(uStarP.y * (2.3 + 4.1 * r2.y) + r2.z * 60.0);
  vec3 col = mix(vec3(1.0), starColor(r2.y), 0.3 + 0.5 * smoothstep(0.005, 0.25, peak));
  return col * (peak * tw * exp(-dist2 / (2.0 * s2)));
}
vec3 starField(vec3 d, float pixAng, float skyLum, float mw){
  if (uStarP.x <= 0.0) return vec3(0.0);
  float sig = max(pixAng * 0.62, 1e-5);
  // layers: (cells per face edge, probability, faintest peak, span = 10^(-0.5*(m1-m0)))
  vec3 s = starLayer(d, 26.0, 0.42, 0.0272, 0.00316, 11u, sig * 1.15, 1.0)     // m -1.3 .. 3.6
         + starLayer(d, 70.0, 0.5, 0.00248, 0.0355, 23u, sig, 1.0)              // m 3.2 .. 6.1
         + starLayer(d, 170.0, 0.26, 0.000235, 0.05, 37u, sig * 0.9, 1.0 + 2.2 * mw);  // m 5.7 .. 8.3
  float pk = max(s.r, max(s.g, s.b));
  float vis = smoothstep(0.7, 3.0, pk / max(skyLum, 1e-6));
  return s * vis * uStarP.x;
}`;

// ---- background pass (full res) ----
const VS_BG = /* glsl */ `
uniform mat4 uInvVPBg;
out vec3 vDir;
void main(){
  vec4 p = uInvVPBg * vec4(position.xy, 1.0, 1.0);
  vDir = p.xyz / p.w;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}`;
const FS_BG = HEAD + /* glsl */ `
in vec3 vDir;
layout(location = 0) out vec4 fragColor;
uniform sampler2D uCombBuf, uSkyBuf, uSkyMapB;
// full-resolution cloud edge detail: steepen and fractalise the low-res cloud alpha at edges using a fine 3-D noise
// sampled where the view ray meets the cloud (alpha-weighted hit distance from the low-res pass)
uniform sampler2D uCldBuf, uDepBuf;
uniform sampler3D uNoise3;
uniform vec3 uCamPosB, uWind2;
uniform vec4 uEdge;   // x detail scale (m), y strength, z steepness, w enable
vec4 cloudEdge(vec4 cld, vec2 uv, vec3 d){
  float a = 1.0 - cld.a;
  if (uEdge.w < 0.5 || a < 0.004) return cld;
  vec2 dep = texture(uDepBuf, uv).xy;
  if (dep.x > 5e5) return cld;
  vec3 p = uCamPosB + d * dep.x;
  vec4 n = texture(uNoise3, (p + uWind2) / uEdge.x);
  float nn = n.g * 0.55 + n.b * 0.3 + n.a * 0.15;
  // detail only where it is resolvable: near, and not at grazing angles through the deck
  float fade = exp(-dep.x / 9000.0) * smoothstep(0.02, 0.16, abs(d.y));
  // interior: gentle lumpiness (cauliflower lobes) from a coarser octave
  float lump = texture(uNoise3, (p + uWind2) / (uEdge.x * 3.1)).r;
  cld.rgb *= 1.0 + (lump - 0.5) * 0.32 * fade * smoothstep(0.3, 0.9, a);
  if (a > 0.996) return cld;
  float edge = 1.0 - abs(2.0 * a - 1.0);                        // 1 at mid alpha, 0 in cores / clear sky
  float a2 = clamp((a - 0.5) * mix(1.0, uEdge.z, fade) + 0.5 + (nn - 0.5) * uEdge.y * edge * fade, 0.0, 1.0);
  return vec4(cld.rgb * (a2 / max(a, 1e-3)), 1.0 - a2);
}

uniform mat4 uCloudVP;
uniform float uCloudMode;   // 0 = overlay mode (sky only; the overlay draws the low clouds), 1 = screen buffer, 2 = sky map
void main(){
  vec3 d = normalize(vDir);
  vec4 base;
  if (uCloudMode > 1.5) base = texture(uSkyMapB, equirectUv(d));
  else {
    vec4 c = uCloudVP * vec4(d, 0.0);
    vec2 uv = clamp(c.xy / max(c.w, 1e-5) * 0.5 + 0.5, 0.0, 1.0);
    if (uCloudMode > 0.5 && uEdge.w > 0.5) {
      vec4 sk = texture(uSkyBuf, uv);
      vec4 cl = cloudEdge(texture(uCldBuf, uv), uv, d);
      base = vec4(cl.rgb + cl.a * sk.rgb, cl.a * sk.a);
    } else base = uCloudMode > 0.5 ? texture(uCombBuf, uv) : texture(uSkyBuf, uv);
  }
  fragColor = vec4(base.rgb, 1.0);
}`;

// base sky (behind stars / discs) at direction d, same source as the background: rgb, a = transmittance to space
const BASELOOK = /* glsl */ `
uniform sampler2D uCombBuf, uSkyBuf, uSkyMapB;
uniform mat4 uCloudVP;
uniform float uCloudMode;
vec4 baseSky(vec3 d){
  if (uCloudMode > 1.5) return textureLod(uSkyMapB, equirectUv(d), 0.0);
  vec4 c = uCloudVP * vec4(d, 0.0);
  vec2 uv = clamp(c.xy / max(c.w, 1e-5) * 0.5 + 0.5, 0.0, 1.0);
  return uCloudMode > 0.5 ? textureLod(uCombBuf, uv, 0.0) : textureLod(uSkyBuf, uv, 0.0);
}`;

// ---- stars as sparse geometry (one tiny quad per star, drawn additively at the far plane) ----
const VS_STARS = HEAD + BASELOOK + /* glsl */ `
in vec2 aCorner; in vec4 aStar; in vec3 aCol;
uniform mat4 uVPStar;
uniform vec3 uPxNdc;       // 2/W, 2/H, quad radius (px)
uniform float uCamHorizonMu;
uniform vec4 uStarP;       // x gain, y time, z twinkle amount
out vec3 vCol; out vec2 vPx;
void main(){
  vec3 d = position;
  vec4 c = uVPStar * vec4(d, 0.0);
  float bright = aStar.x * uStarP.x;
  vCol = vec3(0.0); vPx = vec2(0.0);
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // clipped by default
  if (c.w <= 1e-4 || d.y < uCamHorizonMu || bright <= 0.0) return;
  vec2 ndc = c.xy / c.w;
  if (abs(ndc.x) > 1.05 || abs(ndc.y) > 1.05) return;
  vec4 base = baseSky(d);
  float skyLum = dot(base.rgb, LUMA) / max(base.a, 0.25);
  float airmass = 1.0 / max(d.y + 0.06, 0.06);
  float tw = 1.0 + uStarP.z * min(airmass * 0.35, 2.2) * sin(uStarP.y * aStar.y + aStar.z);
  float peak = bright * max(tw, 0.0) * exp(-0.12 * airmass);
  float amp = peak * smoothstep(0.7, 3.0, peak / max(skyLum, 1e-6)) * base.a;
  if (amp < 2e-5) return;
  gl_Position = vec4(ndc + aCorner * uPxNdc.xy * uPxNdc.z, 0.999998, 1.0);
  vCol = aCol * amp; vPx = aCorner * uPxNdc.z;
}`;
const FS_STARS = HEAD + /* glsl */ `
in vec3 vCol; in vec2 vPx;
layout(location = 0) out vec4 fragColor;
uniform float uStarSig;
void main(){ fragColor = vec4(vCol * exp(-dot(vPx, vPx) / (2.0 * uStarSig * uStarSig)), 0.0); }`;

// ---- sun & moon discs as small sprites ----
const VS_DISCS = HEAD + /* glsl */ `
in vec2 aCorner; in float aWhich;
uniform mat4 uVPStar;
uniform vec3 uSunDirD, uMoonDirD;
uniform vec4 uDisc;
uniform mat3 uMoonFrame;
out vec3 vDir; out float vWhich;
void main(){
  vec3 f = aWhich < 0.5 ? uMoonDirD : uSunDirD;
  float r = (aWhich < 0.5 ? uDisc.w : uDisc.z) * 1.35 + 0.0015;
  vec3 rt = aWhich < 0.5 ? uMoonFrame[0] : normalize(cross(f, abs(f.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, f);
  vec3 d = f + (aCorner.x * rt + aCorner.y * up) * tan(r);
  vec4 c = uVPStar * vec4(d, 0.0);
  vDir = d; vWhich = aWhich;
  gl_Position = c.w > 1e-4 ? vec4(c.xy / c.w, 0.999998, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
}`;
const FS_DISCS = HEAD + BASELOOK + DISCS + /* glsl */ `
in vec3 vDir; in float vWhich;
layout(location = 0) out vec4 fragColor;
uniform float uPixAng, uCamHorizonMu;
void main(){
  vec3 d = normalize(vDir);
  if (d.y < uCamHorizonMu) discard;
  vec3 L = vWhich < 0.5 ? moonDisc(d, uPixAng) : sunDisc(d, uPixAng);
  fragColor = vec4(L * baseSky(d).a, 0.0);
}`;

// ---- overlay pass: low clouds composited over scene geometry (camera in/above the deck) ----
const VS_OV = /* glsl */ `
uniform mat4 uInvVPBg;
out vec3 vDir;
void main(){ vec4 p = uInvVPBg * vec4(position.xy, 1.0, 1.0); vDir = p.xyz / p.w; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FS_OV = HEAD + /* glsl */ `
in vec3 vDir;
layout(location = 0) out vec4 fragColor;
uniform mat4 uCloudVP;
// full-resolution cloud edge detail: steepen and fractalise the low-res cloud alpha at edges using a fine 3-D noise
// sampled where the view ray meets the cloud (alpha-weighted hit distance from the low-res pass)
uniform sampler2D uCldBuf, uDepBuf;
uniform sampler3D uNoise3;
uniform vec3 uCamPosB, uWind2;
uniform vec4 uEdge;   // x detail scale (m), y strength, z steepness, w enable
vec4 cloudEdge(vec4 cld, vec2 uv, vec3 d){
  float a = 1.0 - cld.a;
  if (uEdge.w < 0.5 || a < 0.004) return cld;
  vec2 dep = texture(uDepBuf, uv).xy;
  if (dep.x > 5e5) return cld;
  vec3 p = uCamPosB + d * dep.x;
  vec4 n = texture(uNoise3, (p + uWind2) / uEdge.x);
  float nn = n.g * 0.55 + n.b * 0.3 + n.a * 0.15;
  // detail only where it is resolvable: near, and not at grazing angles through the deck
  float fade = exp(-dep.x / 9000.0) * smoothstep(0.02, 0.16, abs(d.y));
  // interior: gentle lumpiness (cauliflower lobes) from a coarser octave
  float lump = texture(uNoise3, (p + uWind2) / (uEdge.x * 3.1)).r;
  cld.rgb *= 1.0 + (lump - 0.5) * 0.32 * fade * smoothstep(0.3, 0.9, a);
  if (a > 0.996) return cld;
  float edge = 1.0 - abs(2.0 * a - 1.0);                        // 1 at mid alpha, 0 in cores / clear sky
  float a2 = clamp((a - 0.5) * mix(1.0, uEdge.z, fade) + 0.5 + (nn - 0.5) * uEdge.y * edge * fade, 0.0, 1.0);
  return vec4(cld.rgb * (a2 / max(a, 1e-3)), 1.0 - a2);
}
void main(){
  vec3 d = normalize(vDir);
  vec4 c = uCloudVP * vec4(d, 0.0);
  vec2 uv = clamp(c.xy / max(c.w, 1e-4) * 0.5 + 0.5, 0.0, 1.0);
  vec4 cb = cloudEdge(texture(uCldBuf, uv), uv, d);
  fragColor = vec4(cb.rgb, cb.a);
}`;

const FS_CLOUDSCREEN = QHEAD + CLOUDS + CIRRUS + DISCS + `
uniform float uMoonT, uFrontHalo;
` + FS_CLOUDSCREEN_BODY;

// ---- public GLSL chunk for other shaders (water, fog, valley...) ----
const SKY_GLSL = /* glsl */ `
#ifndef MV_SKY_GLSL
#define MV_SKY_GLSL
uniform sampler2D skyMapTex;       // equirect (three's equirectUv convention), rgb radiance, a = cloud transmittance
uniform sampler2D skyMoonTex;
uniform sampler2D skyAmbTex;       // 6x2: row 0 = ambient (irradiance/pi) of the clear sky, row 1 = of the full sky
uniform sampler2D skyShadowTex;    // cloud shadow map (r = transmittance along the key light)
uniform vec3 skySunDir, skyMoonDir, skySunDisc, skyMoonDisc, skyKeyDir, skyKeyColor;
uniform vec4 skyDiscA;             // cos sun radius, cos moon radius, sun radius, moon radius (rad)
uniform vec4 skyShadowRect;        // x0, z0, size, groundY
uniform vec4 skyHazeA;             // x forward-glow amount, y g, z key visibility (cloud T), w mist
uniform vec3 skyHazeKeyCol;
uniform vec4 skyNearHalo;          // moon halo amp, 1/w, sun halo amp, 1/w
uniform vec3 skyNearHaloCol, skySunHaloCol;
const float SKY_PI = 3.14159265358979;
vec2 skyEquirectUv(vec3 d){ return vec2(atan(d.z, d.x) * (0.5 / SKY_PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) * (1.0 / SKY_PI) + 0.5); }
vec3 skyMap(vec3 d){ return texture(skyMapTex, skyEquirectUv(d)).rgb; }
float skyCloudT(vec3 d){ return texture(skyMapTex, skyEquirectUv(d)).a; }
float skyHG(float c, float g){ float g2 = g * g; return (1.0 - g2) / (4.0 * SKY_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
vec3 skyDiscs(vec3 d){
  vec3 L = vec3(0.0);
  float cm = dot(d, skyMoonDir);
  if (cm > skyDiscA.y) {
    float th = acos(clamp(cm, -1.0, 1.0)) / skyDiscA.w;
    L += skyMoonDisc * (1.0 - smoothstep(0.9, 1.0, th));
  }
  float cs = dot(d, skySunDir);
  if (cs > skyDiscA.x) {
    float th = acos(clamp(cs, -1.0, 1.0)) / skyDiscA.z;
    L += skySunDisc * (1.0 - smoothstep(0.85, 1.0, th)) * (1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - th * th))));
  }
  float thm = acos(clamp(cm, -1.0, 1.0)), ths = acos(clamp(cs, -1.0, 1.0));
  L += skyNearHaloCol * (skyNearHalo.x * exp(-max(thm - skyDiscA.w, 0.0) * skyNearHalo.y));
  L += skySunHaloCol * (skyNearHalo.z * exp(-max(ths - skyDiscA.z, 0.0) * skyNearHalo.w));
  return L;
}
// full sky radiance in direction d (reflections): baked map + analytic sun/moon discs (cloud-attenuated)
vec3 skyRadiance(vec3 d){ vec4 s = texture(skyMapTex, skyEquirectUv(d)); return s.rgb + skyDiscs(d) * s.a; }
vec3 skyRadianceNoDisc(vec3 d){ return skyMap(d); }
// ambient radiance (irradiance/pi) of the whole sky for a surface normal n (6-axis ambient cube)
vec3 skyAmbient(vec3 n){
  vec3 n2 = n * n;
  vec3 px = texelFetch(skyAmbTex, ivec2(n.x >= 0.0 ? 0 : 1, 1), 0).rgb;
  vec3 py = texelFetch(skyAmbTex, ivec2(n.y >= 0.0 ? 2 : 3, 1), 0).rgb;
  vec3 pz = texelFetch(skyAmbTex, ivec2(n.z >= 0.0 ? 4 : 5, 1), 0).rgb;
  return px * n2.x + py * n2.y + pz * n2.z;
}
// colour an optically thick haze/fog takes in view direction d (fog: mix(surface, skyHazeColor(d), 1-exp(-k*dist)))
vec3 skyHazeColor(vec3 d){
  vec3 amb = 0.5 * (skyAmbient(vec3(0.0, 1.0, 0.0)) + skyAmbient(normalize(vec3(d.x, 0.0, d.z) + 1e-5)));
  vec3 hor = texture(skyMapTex, skyEquirectUv(normalize(vec3(d.x, max(d.y, 0.0) * 0.35 + 0.03, d.z)))).rgb;
  float c = dot(d, skyKeyDir);
  vec3 glow = skyHazeKeyCol * (skyHazeA.x * skyHazeA.z * skyHG(c, skyHazeA.y));
  return mix(amb, hor, 0.45) + glow;
}
// transmittance of the cloud deck along the key light (moon at night, sun by day) for a world point below the deck
float skyCloudShadow(vec3 p){
  vec3 L = skyKeyDir;
  float t = (skyShadowRect.w - p.y) / max(L.y, 0.02);
  vec2 xz = p.xz + L.xz * t;
  vec2 uv = (xz - skyShadowRect.xy) / skyShadowRect.z;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return texture(skyMapTex, skyEquirectUv(L)).a;
  return texture(skyShadowTex, uv).r;
}
#endif
`;

// ---------------------------------------------------------------------------------------------------------------
// shared static resources (per renderer): LUTs, noise, moon texture — baked once
// ---------------------------------------------------------------------------------------------------------------
const SHARED = new WeakMap();

function makeQuadScene(THREE) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new THREE.Mesh(geo);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { geo, mesh, scene, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
}

function getShared(ctx, o) {
  const { THREE, renderer } = ctx;
  const key = renderer;
  let s = SHARED.get(key);
  const moonSize = o.moonTexSize || (ctx.quality === 'preview' ? 512 : 1024);
  if (s && s.seed === o.seed && s.mie === o.mie && s.moonSize === moonSize) { s.refs++; return s; }
  const q = makeQuadScene(THREE);
  const floatType = THREE.FloatType;
  const mkRT = (w, h, extra = {}) => new THREE.WebGLRenderTarget(w, h, { type: floatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, ...extra });
  const mat = (fs, uniforms, defines = {}) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS_QUAD, fragmentShader: fs, uniforms, defines, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false });
  const pass = (m, rt) => { m.uniformsNeedUpdate = true; q.mesh.material = m; renderer.setRenderTarget(rt); renderer.render(q.scene, q.cam); };
  const prevRT = renderer.getRenderTarget();
  // transmittance + multiple scattering LUTs
  const trans = mkRT(256, 64);
  const ms = mkRT(32, 32);
  const uMie = { value: o.mie };
  const mTrans = mat(FS_TRANS, { uMie });
  pass(mTrans, trans);
  const mMs = mat(FS_MS, { uMie, uTransLUT: { value: trans.texture }, uGroundAlbedo: { value: o.groundAlbedo } });
  pass(mMs, ms);
  mTrans.dispose(); mMs.dispose();
  // 2-D weather / cirrus / misc noise (GPU bake + one-time readback so the JS mirror sees identical data)
  const WN = 256;
  const weatherRT = new THREE.WebGLRenderTarget(WN, WN, { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
  const mW = mat(HEAD + GLSL_HASH + /* glsl */ `
    out vec4 o;
    uniform float uSeed;
    vec2 grad(vec2 i, float per, float s){ i = mod(i, per); float h = mvHash31(vec3(i,s*100.0)); float a = h * TAU; return vec2(cos(a), sin(a)); }
    float pn(vec2 p, float per, float s){ vec2 i = floor(p), f = p - i; vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
      float a = dot(grad(i, per, s), f), b = dot(grad(i + vec2(1, 0), per, s), f - vec2(1, 0)), c = dot(grad(i + vec2(0, 1), per, s), f - vec2(0, 1)), d = dot(grad(i + vec2(1, 1), per, s), f - vec2(1, 1));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.414; }
    float fbm(vec2 uv, float per, int oct, float s){ float a = 1.0, t = 0.0, n = 0.0; for (int k = 0; k < 7; k++) { if (k >= oct) break; t += a * pn(uv * per, per, s + float(k) * 3.1); n += a; per *= 2.0; a *= 0.52; } return t / n; }
    float ridged(vec2 uv, float per, int oct, float s){ float a = 0.5, t = 0.0, n = 0.0; for (int k = 0; k < 7; k++) { if (k >= oct) break; float r = 1.0 - abs(pn(uv * per, per, s + float(k) * 5.7)); t += a * r * r; n += a; per *= 2.0; a *= 0.55; } return t / n; }
    void main(){
      vec2 uv = (gl_FragCoord.xy) / ${WN.toFixed(1)};
      float r = fbm(uv, 4.0, 6, uSeed + 1.0) * 1.35 + 0.5;
      float g = fbm(uv, 3.0, 5, uSeed + 9.0) * 1.35 + 0.5;
      float b = fbm(uv, 5.0, 6, uSeed + 21.0) * 1.3 + 0.5;
      float a = ridged(uv, 8.0, 5, uSeed + 33.0);
      o = vec4(clamp(vec4(r, g, b, a), 0.0, 1.0));
    }`, { uSeed: { value: makeRng(o.seed + ':w')() * 100 } });
  pass(mW, weatherRT);
  mW.dispose();
  const weatherData = new Uint8Array(WN * WN * 4);
  renderer.readRenderTargetPixels(weatherRT, 0, 0, WN, WN, weatherData);
  // 3-D noise (CPU)
  const N3 = 64;
  const n3data = bakeNoise3D(N3, String(o.seed));
  const noise3 = new THREE.Data3DTexture(n3data, N3, N3, N3);
  noise3.format = THREE.RGBAFormat; noise3.type = THREE.UnsignedByteType;
  noise3.minFilter = noise3.magFilter = THREE.LinearFilter;
  noise3.wrapS = noise3.wrapT = noise3.wrapR = THREE.RepeatWrapping;
  noise3.unpackAlignment = 1; noise3.needsUpdate = true;
  // moon
  const moon = createMoonTexture(renderer, THREE, { size: moonSize, seed: 7 });
  renderer.setRenderTarget(prevRT);
  s = { seed: o.seed, mie: o.mie, moonSize, refs: 1, trans, ms, weatherRT, weatherData, WN, noise3, n3data, N3, moon, quad: q, mkRT, mat, pass };
  SHARED.set(key, s);
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// CPU mirrors: transmittance (for light colours) and cloud density (probes)
// ---------------------------------------------------------------------------------------------------------------
function atmoExtJS(h, mie) {
  const r = Math.exp(-h / 8), m = 4.44e-3 * mie * Math.exp(-h / 1.2), o3 = Math.max(0, 1 - Math.abs(h - 25) / 15);
  return [5.802e-3 * r + m + 0.65e-3 * o3, 13.558e-3 * r + m + 1.881e-3 * o3, 33.1e-3 * r + m + 0.085e-3 * o3];
}
/** transmittance from altitude hKm toward direction with zenith-cosine mu (incl. smooth planet shadow) */
export function transmittanceJS(hKm, mu, mie = SKY_DEFAULTS.mie) {
  const r = RG_KM + Math.max(0.001, hKm);
  const muh = -Math.sqrt(Math.max(0, 1 - (RG_KM * RG_KM) / (r * r)));
  const vis = smooth(muh - 0.0065, muh + 0.0065, mu);
  if (vis <= 0) return [0, 0, 0];
  const mm = Math.max(mu, muh + 0.0005);
  const disc = r * r * (mm * mm - 1) + RT_KM * RT_KM;
  const L = Math.max(0, -r * mm + Math.sqrt(Math.max(disc, 0)));
  const N = 48, dt = L / N;
  const od = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) * dt, ri = Math.sqrt(r * r + t * t + 2 * r * mm * t);
    const e = atmoExtJS(ri - RG_KM, mie);
    od[0] += e[0] * dt; od[1] += e[1] * dt; od[2] += e[2] * dt;
  }
  return [Math.exp(-od[0]) * vis, Math.exp(-od[1]) * vis, Math.exp(-od[2]) * vis];
}

function makeCloudMirror(sh) {
  const W = sh.weatherData, WN = sh.WN, D = sh.n3data, N = sh.N3;
  const wrap = (i, n) => ((i % n) + n) % n;
  const s2 = (u, v, ch) => { // bilinear, repeat (texel centres at (i+0.5)/WN)
    const x = u * WN - 0.5, y = v * WN - 0.5;
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const g = (i, j) => W[(wrap(j, WN) * WN + wrap(i, WN)) * 4 + ch] / 255;
    return mix(mix(g(xi, yi), g(xi + 1, yi), fx), mix(g(xi, yi + 1), g(xi + 1, yi + 1), fx), fy);
  };
  const s3 = (u, v, w, ch) => {
    const x = u * N - 0.5, y = v * N - 0.5, z = w * N - 0.5;
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = x - xi, fy = y - yi, fz = z - zi;
    const g = (i, j, k) => D[((wrap(k, N) * N + wrap(j, N)) * N + wrap(i, N)) * 4 + ch] / 255;
    const a = mix(mix(g(xi, yi, zi), g(xi + 1, yi, zi), fx), mix(g(xi, yi + 1, zi), g(xi + 1, yi + 1, zi), fx), fy);
    const b = mix(mix(g(xi, yi, zi + 1), g(xi + 1, yi, zi + 1), fx), mix(g(xi, yi + 1, zi + 1), g(xi + 1, yi + 1, zi + 1), fx), fy);
    return mix(a, b, fz);
  };
  // P = the per-frame cloud parameter block (same numbers as the uniforms)
  function density(p, P) {
    const x = p[0], z = p[2];
    const h = p[1] + (x * x + z * z) * (0.5 / RP);
    const u1 = (x + P.wind[0] * 0.55) / 17000, v1 = (z + P.wind[2] * 0.55) / 17000;
    const u2 = (x + P.wind[0] * 0.8) / 5300 + 0.37, v2 = (z + P.wind[2] * 0.8) / 5300 + 0.61;
    const wr = s2(u1, v1, 0), wg = s2(u1, v1, 1), wa = s2(u1, v1, 3);
    const w2r = s2(u2, v2, 0), w2g = s2(u2, v2, 1);
    const w2a = s2(u2, v2, 3);
    const u4 = (x + P.wind[0] * 0.9) / 1700 + 0.21, v4 = (z + P.wind[2] * 0.9) / 1700 + 0.83;
    const e = P.rainEdgeX + 380 * (wg - 0.5) + 260 * (w2a - 0.5) + 240 * (s2(u4, v4, 0) - 0.5) + 110 * (s2(u4, v4, 2) - 0.5);
    const A = smooth(e + 150, e - 330, x) * smooth(P.rainWest - 60, P.rainWest + 200, x) * smooth(P.rainZ + 350, P.rainZ - 250, Math.abs(z + 300 * (w2a - 0.5)));
    let B = 0, Cc = 0;
    if (P.gapDir[1] > 0.035) {
      const fx = x - P.gapDir[0] * (h / P.gapDir[1]), fz = z - P.gapDir[2] * (h / P.gapDir[1]);
      const cw = P.clearRegion * (0.75 + 0.5 * s2(u4, v4, 2));
      Cc = (1 - P.view[3]) * smooth(-60, 90, fx) * smooth(640 + 200 * s2(u4, v4, 0), 300, fx) * smooth(cw + 260, cw - 160, Math.abs(fz));
    }
    const rm = Math.max(A, B) * P.rain;
    const base = mix(P.base, P.rainBase, rm) + (w2g - 0.5) * 180;
    const top = mix(P.top, P.rainTop, rm) + (wa - 0.5) * 260;
    const h01 = (h - base) / (top - base);
    if (h01 < 0 || h01 > 1) return 0;
    const w2b = s2(u2, v2, 2);
    let cov = mix(P.covE, P.covR, rm) + (wr - 0.5) * 0.62 * (1 - 0.6 * rm) + (w2r - 0.5) * 0.22 - rm * 0.4 * smooth(0.58, 0.8, w2b);
    cov -= Cc * (1 - rm) * 0.9 * Math.min(1, P.rain * 2);
    if (P.gap > 0) {
      const v = norm([x - P.gapOrigin[0], p[1] - P.gapOrigin[1], z - P.gapOrigin[2]]);
      const gc = dot(v, P.gapDir) + (w2b - 0.5) * 0.035 + (s2(u4, v4, 0) - 0.5) * 0.02 + (s2(u1, v1, 2) - 0.5) * 0.015;
      cov -= P.gap * smooth(P.gapCosOuter, P.gapCosInner, gc) * (0.95 + 0.6 * s2(u4, v4, 1));
    }
    if (cov <= 0.02 && P.view[3] * P.rain < 0.001) return 0;
    cov = Math.min(cov, 1);
    const prof = smooth(0, 0.07 + 0.1 * (1 - rm), h01) * smooth(1, 0.5 - 0.25 * rm, h01);
    const qx = (x + P.wind[0]) / P.shapeScale, qy = (p[1] + P.wind[1]) / P.shapeScale, qz = (z + P.wind[2]) / P.shapeScale;
    const n0 = s3(qx, qy, qz, 0), n3 = s3(qx, qy, qz, 3);
    const shape = n0 * (0.85 + 0.15 * n3);
    if (P.view[3] * P.rain > 0.001 && P.gapDir[1] > 0.035) {
      const dv = [x - P.view[0], p[1] - P.view[1], z - P.view[2]];
      const along = dot(dv, P.gapDir);
      const sc = (P.rainBlob[0] - P.view[1]) / Math.max(P.gapDir[1], 0.05);
      const pp = [dv[0] - P.gapDir[0] * along, dv[1] - P.gapDir[1] * along, dv[2] - P.gapDir[2] * along];
      const uh = norm(cross(P.gapDir, [0, 1, 0])), uv = cross(uh, P.gapDir);
      const r0 = Math.hypot(dot(pp, uh) / 1.9 / P.rainBlob[2], dot(pp, uv) / P.rainBlob[2], (along - sc) / P.rainBlob[1]);
      const pr = r0 * (1 + (n0 - 0.5) * 1.1 + (n3 - 0.5) * 0.7);
      cov = Math.min(1, cov + 0.85 * P.view[3] * Math.min(1, P.rain * 1.6) * smooth(1.0, 0.25, pr) * (1 - P.gap * 1.2));
    }
    const d = clamp((shape * prof - (1 - cov)) / Math.max(cov * 0.55, 1e-5));
    if (d <= 0) return 0;
    return d * mix(1, 3.4, rm) * P.ext;
  }
  // transmittance of the low-cloud deck along a ray (probe)
  function transmittanceRay(o, dir, P, steps = 48) {
    const d = norm(dir);
    const hit = (H) => {
      const b = d[0] * o[0] + d[1] * (o[1] + RP) + d[2] * o[2];
      const c = o[0] * o[0] + o[2] * o[2] + o[1] * o[1] - H * H + 2 * RP * (o[1] - H);
      const disc = b * b - c;
      if (disc < 0) return null;
      const sq = Math.sqrt(disc), qq = -b - (b >= 0 ? sq : -sq);
      const t1 = qq, t2 = c / qq;
      return [Math.min(t1, t2), Math.max(t1, t2)];
    };
    const camH = o[1] + (o[0] * o[0] + o[2] * o[2]) * (0.5 / RP);
    const B = hit(P.shellBase), T = hit(P.shellTop), G = hit(0);
    const hitsG = G && G[0] > 0;
    let t0, t1;
    if (camH < P.shellBase) { if (hitsG || !B || !T) return 1; t0 = B[1]; t1 = T[1]; }
    else if (camH < P.shellTop) { t0 = 0; t1 = B && B[0] > 0 ? B[0] : (T ? T[1] : 0); }
    else { if (!T || T[0] < 0) return 1; t0 = T[0]; t1 = B && B[0] > 0 ? B[0] : T[1]; }
    if (hitsG) t1 = Math.min(t1, G[0]);
    t1 = Math.min(t1, P.maxDist);
    if (!(t1 > t0)) return 1;
    const dt = (t1 - t0) / steps;
    let od = 0;
    for (let i = 0; i < steps; i++) {
      const t = t0 + (i + 0.5) * dt;
      od += density([o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t], P) * dt;
      if (od > 30) break;
    }
    return Math.exp(-od);
  }
  function debugRay(o, dir, P, steps = 24) {
    const d = norm(dir), out = [];
    for (let i = 0; i < steps; i++) {
      const t = 200 + i * 150;
      const p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
      out.push([Math.round(t), Math.round(p[0]), Math.round(p[1]), Math.round(p[2]), +(density(p, P) * 1000).toFixed(2)]);
    }
    return out;
  }
  return { density, transmittanceRay, debugRay };
}

// star catalogue (deterministic): ~7000 stars, magnitude power law N(<m) ~ 10^(0.5 m) from -1.45 to 6.6,
// fainter stars concentrated toward the galactic plane, colour temperature classes.
function starColorJS(k) {
  const a = [1.0, 0.62, 0.36], b = [1.0, 0.86, 0.70], c = [1.0, 0.97, 0.94], e = [0.74, 0.84, 1.0];
  const L = (x, y, u) => x.map((v, i) => v + (y[i] - v) * u);
  return k < 0.3 ? L(a, b, k / 0.3) : k < 0.7 ? L(b, c, (k - 0.3) / 0.4) : L(c, e, (k - 0.7) / 0.3);
}
function makeStarGeometry(THREE, seedStr, galPole, count = 7000) {
  const rng = makeRng(seedStr + ':stars');
  const mMin = -1.45, mMax = 6.6, span = Math.pow(10, -0.5 * (mMax - mMin));
  const P = new Float32Array(count * 12), C = new Float32Array(count * 8), S = new Float32Array(count * 16), K = new Float32Array(count * 12);
  const I = new Uint32Array(count * 6);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  let n = 0, guard = 0;
  while (n < count && guard++ < count * 20) {
    const z = rng() * 2 - 1, ph = rng() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    const d = [r * Math.cos(ph), z, r * Math.sin(ph)];
    const m = mMax + 2 * Math.log10(span + (1 - span) * rng());
    const b = Math.asin(clamp(dot(d, galPole), -1, 1));
    const accept = m < 3 ? 1 : 0.42 + 0.58 * Math.exp(-b * b / (2 * 0.28 * 0.28));
    if (rng() > accept) continue;
    const peak = Math.min(1, Math.pow(10, -0.328 * (m + 1)));
    const u = rng();
    const k = u < 0.12 ? 0.05 + 0.25 * rng() : u < 0.85 ? 0.3 + 0.45 * rng() : 0.75 + 0.25 * rng();
    const sat = 0.3 + 0.55 * smooth(0.004, 0.25, peak);
    const c0 = starColorJS(k).map((v) => 1 + (v - 1) * sat);
    const cl = lum(c0) || 1;
    const col = c0.map((v) => v / cl);
    const tw1 = 2.3 + 4.1 * rng(), tw2 = rng() * 60;
    for (let v = 0; v < 4; v++) {
      const i = n * 4 + v;
      P.set(d, i * 3); C.set(corners[v], i * 2); S.set([peak, tw1, tw2, m], i * 4); K.set(col, i * 3);
    }
    I.set([n * 4, n * 4 + 1, n * 4 + 2, n * 4, n * 4 + 2, n * 4 + 3], n * 6);
    n++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P.subarray(0, n * 12), 3));
  g.setAttribute('aCorner', new THREE.BufferAttribute(C.subarray(0, n * 8), 2));
  g.setAttribute('aStar', new THREE.BufferAttribute(S.subarray(0, n * 16), 4));
  g.setAttribute('aCol', new THREE.BufferAttribute(K.subarray(0, n * 12), 3));
  g.setIndex(new THREE.BufferAttribute(I.subarray(0, n * 6), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

// cubeUV planes (replicates three's PMREMGenerator._createPlanes so the layout matches the cube_uv shader chunk)
function makeCubeUVPlanes(THREE, lodMax) {
  const LOD_MIN = 4, EXTRA = 6;
  const sizeLods = [], meshes = [];
  let lod = lodMax;
  const total = lodMax - LOD_MIN + 1 + EXTRA;
  for (let i = 0; i < total; i++) {
    const sizeLod = Math.pow(2, lod);
    sizeLods.push(sizeLod);
    const texel = 1 / (sizeLod - 2), mn = -texel, mx = 1 + texel;
    const uv1 = [mn, mn, mx, mn, mx, mx, mn, mn, mx, mx, mn, mx];
    const pos = new Float32Array(3 * 6 * 6), dirs = new Float32Array(3 * 6 * 6);
    for (let face = 0; face < 6; face++) {
      const x = (face % 3) * 2 / 3 - 1, y = face > 2 ? 0 : -1;
      pos.set([x, y, 0, x + 2 / 3, y, 0, x + 2 / 3, y + 1, 0, x, y, 0, x + 2 / 3, y + 1, 0, x, y + 1, 0], 18 * face);
      for (let v = 0; v < 6; v++) {
        const u = uv1[v * 2] * 2 - 1, w = uv1[v * 2 + 1] * 2 - 1;
        let d;
        if (face === 0) d = [1, w, u]; else if (face === 1) d = [-u, 1, -w]; else if (face === 2) d = [-u, w, 1];
        else if (face === 3) d = [-1, w, -u]; else if (face === 4) d = [-u, -1, w]; else d = [u, w, -1];
        dirs.set(d, (face * 6 + v) * 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('outputDirection', new THREE.BufferAttribute(dirs, 3));
    const m = new THREE.Mesh(g);
    m.frustumCulled = false;
    meshes.push(m);
    if (lod > LOD_MIN) lod--;
  }
  return { sizeLods, meshes };
}
// inverse of three's roughnessToMip
function mipToRoughness(m) {
  if (m <= -1) return 1.0 - (m + 2) * (0.2 / 1.0);         // [-2,-1] -> [1.0, 0.8]
  if (m <= 2) return 0.8 - (m + 1) * (0.4 / 3);            // [-1, 2] -> [0.8, 0.4]
  if (m <= 3) return 0.4 - (m - 2) * 0.095;                // [2, 3]  -> [0.4, 0.305]
  if (m <= 4) return 0.305 - (m - 3) * 0.095;              // [3, 4]  -> [0.305, 0.21]
  return Math.pow(2, -m / 2) / 1.16;
}

// ---------------------------------------------------------------------------------------------------------------
// createSky
// ---------------------------------------------------------------------------------------------------------------
export function createSky(ctx, opts = {}) {
  const { THREE, renderer } = ctx;
  const o = { ...SKY_DEFAULTS, ...(opts.preset?skyPreset(opts.preset).sky:{}), ...opts };
  let quality = ctx.quality === 'preview' ? 'preview' : 'final';
  // budget tier: software SwiftShader gets a cheaper 'final' cloud march (llvmpipe / real GPUs get the full one)
  let slowGL = o.budget === 'low';
  if (o.budget === 'auto' || o.budget == null) {
    try { const g = renderer.getContext(); const ext = g.getExtension('WEBGL_debug_renderer_info'); const rs = ext ? String(g.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''; slowGL = /swiftshader/i.test(rs); } catch (e) { slowGL = false; }
  }
  const sh = getShared(ctx, o);
  const mirror = makeCloudMirror(sh);
  const { mkRT } = sh;
  const _pbuf = new Float32Array(4);
  const pass = (m, rt, name) => {
    const prof = api.profile;
    let t0 = 0;
    if (prof) { t0 = performance.now(); } // profiling only (never used for rendering)
    sh.pass(m, rt);
    if (prof) { renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, _pbuf); const k = name || 'pass'; prof[k] = (prof[k] || 0) + performance.now() - t0; }
  };

  // ---------------- uniforms (shared objects between all materials) ----------------
  const V3 = () => new THREE.Vector3(), V4 = () => new THREE.Vector4(), V2 = () => new THREE.Vector2();
  const U = {
    uMie: { value: o.mie }, uTransLUT: { value: sh.trans.texture }, uMSLUT: { value: sh.ms.texture },
    uGroundAlbedo: { value: o.groundAlbedo }, uFloorAlbedo: { value: o.groundAlbedo }, uLutSize: { value: V2() }, uCamR: { value: RG_KM + 0.002 },
    uSunDir: { value: V3() }, uMoonDir: { value: V3() }, uSunE: { value: V3() }, uMoonE: { value: V3() },
    uMieG: { value: o.mieG }, uAirglow: { value: new THREE.Vector3(...o.airglow) }, uNight: { value: V4() },
    uMW: { value: V4() }, uGal: { value: new THREE.Matrix3() }, uHaloW: { value: V4() }, uHaloCol: { value: V3() }, uTwi: { value: V4() }, uTwiBlue: { value: V3() }, uGlowDir: { value: V3() }, uGlowW: { value: 0 },
    uSR: { value: null }, uSM: { value: null }, uMR: { value: null }, uMM: { value: null },
    uWeather: { value: sh.weatherRT.texture }, uNoise3: { value: sh.noise3 },
    uCA: { value: V4() }, uCB: { value: V4() }, uCC: { value: V4() }, uCD: { value: V4() }, uCE: { value: V4() },
    uGapDir: { value: V3() }, uRainCell: { value: V4() }, uView: { value: V4() }, uRainBlob: { value: V4() }, uGapOrigin: { value: new THREE.Vector3(...o.gapOrigin) }, uWind: { value: V3() }, uWind2: { value: V3() },
    uKeyDir: { value: V3() }, uKeyCol: { value: V3() }, uSecDir: { value: V3() }, uSecCol: { value: V3() },
    uAmbTop: { value: V3() }, uAmbBot: { value: V3() }, uAmbTex: { value: null }, uAmbGPU: { value: 1 },
    uClear: { value: null }, uCamPos: { value: V3() }, uInvVPRot: { value: new THREE.Matrix4() },
    uUseDepth: { value: 0 }, uDepth: { value: null }, uDepthP: { value: V4() },
    uShadowRect: { value: V4() },
    uCi: { value: V4() }, uCiAxis: { value: V2() }, uCiWind: { value: V3() }, uCiKeyCol: { value: V3() }, uCiKeyDir: { value: V3() }, uCiAmb: { value: V3() },
    uIceHalo: { value: V4() },
    uCloudMap: { value: null },
    uMoonTex: { value: sh.moon.texture }, uMoonTexInfo: { value: new THREE.Vector2(sh.moon.size, 1 / (1 + 1 / 256)) }, uSunDirD: { value: V3() }, uMoonDirD: { value: V3() }, uSunRad: { value: V3() }, uMoonRad: { value: V3() },
    uDisc: { value: V4() }, uMoonFrame: { value: new THREE.Matrix3() }, uMoonSun: { value: V3() },
    uNearHalo: { value: V4() }, uNearHaloCol: { value: V3() }, uSunHaloCol: { value: V3() },
    uStarP: { value: V4() },
    uCombBuf: { value: null }, uSkyBuf: { value: null }, uCldBuf: { value: null }, uDepBuf: { value: null }, uEdge: { value: V4() }, uSkyMapB: { value: null }, uCloudVP: { value: new THREE.Matrix4() }, uCloudMode: { value: 1 },
    uCamPosB: { value: V3() }, uPixAng: { value: 0.0004 }, uCamHorizonMu: { value: 0 }, uMoonT: { value: 1 }, uFrontHalo: { value: 0 },
    uMWStar: { value: V4() }, uGalB: { value: new THREE.Matrix3() }, uInvVPBg: { value: new THREE.Matrix4() },
    uVPStar: { value: new THREE.Matrix4() }, uPxNdc: { value: V3() }, uStarSig: { value: 0.62 },
  };
  // public uniforms for skyGLSL
  const PU = {
    skyMapTex: { value: null }, skyMoonTex: { value: sh.moon.texture }, skyAmbTex: { value: null }, skyShadowTex: { value: null },
    skySunDir: { value: V3() }, skyMoonDir: { value: V3() }, skySunDisc: { value: V3() }, skyMoonDisc: { value: V3() },
    skyKeyDir: { value: V3() }, skyKeyColor: { value: V3() }, skyDiscA: { value: V4() }, skyShadowRect: { value: V4() },
    skyHazeA: { value: V4() }, skyHazeKeyCol: { value: V3() }, skyNearHalo: { value: V4() }, skyNearHaloCol: { value: V3() }, skySunHaloCol: { value: V3() },
  };

  let galPole = [0, 1, 0];
  // ---------------- galactic frame (fixed): centre low in the SSE, band arching through the east & north ----------------
  {
    const gc = norm(dirFrom(165, 12));
    const other = norm(dirFrom(40, 55));
    const np = norm(cross(gc, other));           // galactic north pole
    const gy = np, gx = gc, gz = cross(gx, gy);
    U.uGal.value.set(gx[0], gx[1], gx[2], gy[0], gy[1], gy[2], gz[0], gz[1], gz[2]);
    U.uGalB.value.copy(U.uGal.value);
    galPole = gy;
  }

  // ---------------- per-quality resources ----------------
  let R = null;
  const matQ = (fs, defines = {}) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS_QUAD, fragmentShader: fs, uniforms: U, defines, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false });
  function build() {
    if (R) disposeQ();
    const fin = quality === 'final';
    const lutW = fin ? 128 : 96, lutH = fin ? 64 : 48;
    const mapW = fin ? 512 : 256, mapH = mapW / 2;
    const cmW = fin ? 256 : 128, cmH = cmW / 2;
    const steps = fin ? (slowGL ? 26 : 30) : 16, lsteps = 3;
    const envSize = o.envSize || (fin ? 64 : 32);
    const lut = new THREE.WebGLRenderTarget(lutW, lutH, { count: 4, type: THREE.FloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping });
    for (const t of lut.textures) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.minFilter = t.magFilter = THREE.LinearFilter; }
    const clear = mkRT(mapW, mapH, { wrapS: THREE.RepeatWrapping });
    const cloudMap = mkRT(cmW, cmH, { wrapS: THREE.RepeatWrapping });
    const skyMap = mkRT(mapW, mapH, { wrapS: THREE.RepeatWrapping });
    const amb = mkRT(6, 2, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const small = mkRT(64, 32, { wrapS: THREE.RepeatWrapping });
    const shadow = mkRT(fin ? 128 : 96, fin ? 128 : 96);
    const lodMax = Math.round(Math.log2(envSize));
    const planes = makeCubeUVPlanes(THREE, lodMax);
    const envRT = new THREE.WebGLRenderTarget(3 * Math.max(envSize, 16 * 7), 4 * envSize, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    envRT.texture.mapping = THREE.CubeUVReflectionMapping;
    envRT.texture.name = 'Sky.cubeUv';
    envRT.scissorTest = true;
    const defs = { STEPS: steps, LSTEPS: lsteps };
    const M = {
      skyview: matQ(FS_SKYVIEW),
      clear: matQ(FS_CLEAR),
      amb: matQ(FS_AMB),
      cloudMap: matQ(FS_CLOUDMAP, { STEPS: fin ? 20 : 12, LSTEPS: 2, RAIN_FX: 1 }),
      cloudScreen: matQ(FS_CLOUDSCREEN, { ...defs, RAIN_FX: 1 }),
      shadow: matQ(FS_SHADOW, { STEPS: 16, LSTEPS: 2, RAIN_FX: 1 }),
      cloudMapDry: matQ(FS_CLOUDMAP, { STEPS: fin ? 20 : 12, LSTEPS: 2 }),
      cloudScreenDry: matQ(FS_CLOUDSCREEN, defs),
      shadowDry: matQ(FS_SHADOW, { STEPS: 16, LSTEPS: 2 }),
      skymap: matQ(FS_SKYMAP, { STEPS: 1, LSTEPS: 1 }),
      down: matQ(FS_DOWN),
      resolve: matQ(FS_RESOLVE),
      env: new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS_ENV, fragmentShader: FS_ENV, uniforms: { uSrc0: { value: skyMap.texture }, uSrc1: { value: small.texture }, uSigma: { value: 0 }, uSmall: { value: 0 } }, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false, side: THREE.DoubleSide }),
    };
    M.amb.uniforms = { uSrc: { value: null } };
    M.resolve.uniforms = { uSrc: { value: null }, uSky: { value: null }, uDep: { value: null }, uSrcTexel: { value: new THREE.Vector2() } };
    M.down.uniforms = { uSrc: { value: skyMap.texture }, uSrcTexel: { value: new THREE.Vector2(1 / mapW, 1 / mapH) }, uK: { value: mapW / 64 / 4 } };
    R = { fin, lutW, lutH, mapW, mapH, cmW, cmH, lut, clear, cloudMap, skyMap, amb, small, shadow, planes, envRT, envSize, lodMax, M, screen: null, screenW: 0, screenH: 0 };
    U.uLutSize.value.set(lutW, lutH);
    U.uSR.value = lut.textures[0]; U.uSM.value = lut.textures[1]; U.uMR.value = lut.textures[2]; U.uMM.value = lut.textures[3];
    U.uClear.value = clear.texture; U.uCloudMap.value = cloudMap.texture; U.uSkyMapB.value = skyMap.texture;
    PU.skyMapTex.value = skyMap.texture; PU.skyAmbTex.value = amb.texture; PU.skyShadowTex.value = shadow.texture;
    U.uAmbTex.value = amb.texture;
    lastKey = null;
  }
  function ensureScreen(w, h) {
    const frac = o.cloudRes || (quality === 'final' ? (slowGL ? 0.25 : 0.3) : 0.2);
    U.uEdge.value.set(o.edgeScale, o.edgeStrength, o.edgeSteep, o.edgeDetail === false ? 0 : 1);
    const sw = Math.max(16, Math.round(w * frac)), shh = Math.max(8, Math.round(h * frac));
    if (R.screen && R.screenW === sw && R.screenH === shh) return;
    if (R.screen) { R.screen.dispose(); R.screenRaw.dispose(); }
    const mrt = (n) => { const rt = new THREE.WebGLRenderTarget(sw, shh, { count: n, type: THREE.FloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      for (const tx of rt.textures) { tx.minFilter = tx.magFilter = THREE.LinearFilter; tx.wrapS = tx.wrapT = THREE.ClampToEdgeWrapping; tx.generateMipmaps = false; } return rt; };
    R.screenRaw = mrt(3); R.screen = mrt(4);
    R.screenW = sw; R.screenH = shh;
    U.uCombBuf.value = R.screen.textures[0]; U.uSkyBuf.value = R.screen.textures[1]; U.uCldBuf.value = R.screen.textures[2]; U.uDepBuf.value = R.screen.textures[3];
    R.M.resolve.uniforms.uSrc.value = R.screenRaw.textures[1];
    R.M.resolve.uniforms.uSky.value = R.screenRaw.textures[0];
    R.M.resolve.uniforms.uDep.value = R.screenRaw.textures[2];
    R.M.resolve.uniforms.uSrcTexel.value.set(1 / sw, 1 / shh);
  }
  function disposeQ() {
    const r = R;
    for (const k of ['lut', 'clear', 'cloudMap', 'skyMap', 'amb', 'small', 'shadow', 'envRT', 'screen', 'screenRaw']) if (r[k]) r[k].dispose();
    for (const m of Object.values(r.M)) m.dispose();
    for (const m of r.planes.meshes) m.geometry.dispose();
    R = null;
  }
  let lastKey = null;
  build();

  // ---------------- background & overlay meshes ----------------
  const bgDefs = { STEPS: 1, LSTEPS: 1 }; for (const k of (o.bgDisable || [])) bgDefs['NO_' + k.toUpperCase()] = 1;
  const bgMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS_BG, fragmentShader: FS_BG, uniforms: U, defines: bgDefs, depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth, toneMapped: false, side: THREE.DoubleSide });
  const ovMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS_OV, fragmentShader: FS_OV, uniforms: U, depthTest: false, depthWrite: false, transparent: true, toneMapped: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  quadGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const _m4 = new THREE.Matrix4(), _m4b = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
  const rotOnlyVP = (camera, out) => { // projection * view(rotation only)
    camera.matrixWorld.decompose(_v, _q, _s);
    _m4.makeRotationFromQuaternion(_q).invert();
    return out.multiplyMatrices(camera.projectionMatrix, _m4);
  };
  let updCam = null; // camera used for the cloud buffer
  const bgMeshes = [], ovMeshes = [];
  function makeBackgroundMesh() {
    const m = new THREE.Mesh(quadGeo, bgMat);
    m.frustumCulled = false; m.renderOrder = 1e6; m.name = 'sky.background';
    m.onBeforeRender = (r, scene, camera) => camUniforms(r, camera, bgMat);
    bgMeshes.push(m);
    return m;
  }
  const _fwd = new THREE.Vector3();
  const updPos = new THREE.Vector3(), updFwd = new THREE.Vector3();
  let updFov = 0;
  const dirDot = (camera) => { camera.getWorldDirection(_fwd); return _fwd.dot(updFwd); };
  function makeOverlayMesh() {
    const m = new THREE.Mesh(quadGeo, ovMat);
    m.frustumCulled = false; m.renderOrder = 2e6; m.name = 'sky.cloudOverlay';
    m.visible = false;
    m.onBeforeRender = (r, scene, camera) => {
      ovMat.uniformsNeedUpdate = true;
      camera.updateMatrixWorld();
      rotOnlyVP(camera, _m4b);
      U.uInvVPBg.value.copy(_m4b).invert();
    };
    ovMeshes.push(m);
    return m;
  }
  const starGeo = makeStarGeometry(THREE, String(o.seed), galPole, o.starCount || 7000);
  const starMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS_STARS, fragmentShader: FS_STARS, uniforms: U, depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth, transparent: true, toneMapped: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
  const discGeo = new THREE.BufferGeometry();
  discGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(24), 3));
  discGeo.setAttribute('aCorner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1], 2));
  discGeo.setAttribute('aWhich', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 1, 1, 1], 1));
  discGeo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  discGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const discMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS_DISCS, fragmentShader: FS_DISCS, uniforms: U, depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth, transparent: true, toneMapped: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
  function camUniforms(r, camera, mat) {
    mat.uniformsNeedUpdate = true;
    camera.updateMatrixWorld();
    rotOnlyVP(camera, U.uVPStar.value);
    U.uInvVPBg.value.copy(U.uVPStar.value).invert();
    camera.matrixWorld.decompose(_v, _q, _s);
    U.uCamPosB.value.copy(_v);
    const tgt = r.getRenderTarget();
    const wPx = tgt ? tgt.width : r.domElement.width, hPx = tgt ? tgt.height : r.domElement.height;
    U.uPxNdc.value.set(2 / Math.max(1, wPx), 2 / Math.max(1, hPx), 2.4);
    U.uPixAng.value = (camera.fov * D2R) / Math.max(1, hPx) / (camera.zoom || 1);
    const hKm = Math.max(0.001, altitudeM(_v) / 1000);
    U.uCamHorizonMu.value = -Math.sqrt(Math.max(0, 1 - (RG_KM * RG_KM) / ((RG_KM + hKm) * (RG_KM + hKm)))) - 0.002;
    let mode = 2;
    if (overlayActive) mode = 0;
    else if (updCam && R.screen) {
      const same = camera === updCam || (Math.abs(camera.fov - updFov) < 8 && _v.distanceTo(updPos) < 5 && dirDot(camera) > 0.97);
      mode = same ? 1 : 2;
    }
    U.uCloudMode.value = mode;
  }
  function makeSkyGroup() {
    const g = new THREE.Group(); g.name = 'sky';
    const bg = makeBackgroundMesh();
    const st = new THREE.Mesh(starGeo, starMat); st.frustumCulled = false; st.renderOrder = -1e6 + 1; st.name = 'sky.stars';
    st.onBeforeRender = (r, sc, cam) => camUniforms(r, cam, starMat);
    const dc = new THREE.Mesh(discGeo, discMat); dc.frustumCulled = false; dc.renderOrder = -1e6 + 2; dc.name = 'sky.discs';
    dc.onBeforeRender = (r, sc, cam) => camUniforms(r, cam, discMat);
    g.add(bg, st, dc);
    return g;
  }
  const object = makeSkyGroup();
  const overlay = makeOverlayMesh();
  let overlayActive = false;
  const altitudeM = (p) => p.y + (p.x * p.x + p.z * p.z) * (0.5 / RP);

  // ---------------- per-frame state (JS side) ----------------
  const info = { t: 0, sunDir: [0, -1, 0], moonDir: [0, 1, 0], sunRad: [0, 0, 0], moonRad: [0, 0, 0], moonT: 1, sunT: 1, key: 'moon', keyDir: [0, 1, 0], keyCol: [0, 0, 0], cloudParams: null, moonAngR: 0, sunAngR: 0, day: 0 };

  function frameParams(t, w) {
    const day = w.day ?? smooth(-6, 8, w.sunElev);
    const sunDir = norm(w.sunDir || dirFrom(w.sunAzim, w.sunElev));
    const moonDir = norm(w.moonDir || dirFrom(w.moonAzim, w.moonElev));
    const cloud = clamp(w.cloudCover ?? 0.4), rain = clamp(w.rain ?? 0), mist = clamp(w.mist ?? 0.4);
    const gap = clamp(((w.moonGap ?? 0) - 0.04) / 0.96);   // ignore the curve's tiny early values (no premature hole)
    const windDir = norm([(w.windDir || [0.9, 0, 0.12])[0], 0, (w.windDir || [0.9, 0, 0.12])[2]]);
    const D = o.drift ? o.drift(t) : driftAt(t);
    return { t, day, sunDir, moonDir, cloud, rain, gap, mist, windDir, D, w };
  }

  function computeUniforms(F, camPos) {
    const { sunDir, moonDir, day, cloud, rain, gap, mist, windDir, D } = F;
    const camH = Math.max(1, altitudeM(camPos));
    U.uCamR.value = RG_KM + camH / 1000;
    U.uSunDir.value.set(...sunDir); U.uMoonDir.value.set(...moonDir);
    const nightAmt = 1 - day;
    const sunElDeg = F.w.sunElev ?? Math.asin(clamp(sunDir[1], -1, 1)) / D2R;
    const TW = twilightGains(sunElDeg);
    U.uTwi.value.set(TW.gu, TW.a, TW.sigAz, TW.sigEl);
    U.uTwiBlue.value.set(0.3 * 0.02 * TW.blue, 0.46 * 0.02 * TW.blue, 1.0 * 0.02 * TW.blue);
    { const hx = sunDir[0], hz = sunDir[2], hl = Math.hypot(hx, hz) || 1; U.uGlowDir.value.set(hx / hl, 0, hz / hl); }
    U.uGlowW.value = clamp(Math.log10(TW.gu) / 0.8) * (1 - smooth(-16, -12, -sunElDeg) * 0);
    // light sources at the top of the atmosphere
    const sunCol = o.sunColor, mlc = o.moonLightColor;
    const sunGain = o.sunE / Math.max(1e-3, transmittanceJS(0.1, 0.7, o.mie)[0]) * o.daySkyGain;
    U.uSunE.value.set(sunCol[0] * sunGain, sunCol[1] * sunGain, sunCol[2] * sunGain);
    const moonGain = o.moonE * o.nightSkyGain;
    U.uMoonE.value.set(mlc[0] * moonGain, mlc[1] * moonGain, mlc[2] * moonGain);
    U.uNight.value.set(o.nightTint[0], o.nightTint[1], o.nightTint[2], nightAmt);
    U.uMW.value.set(0.0016 * o.milkyWay, 0, 0, 0);
    // moon visibility from the ground (above horizon)
    const tMoonCam = transmittanceJS(camH / 1000, moonDir[1], o.mie);
    const tSunCam = transmittanceJS(camH / 1000, sunDir[1], o.mie);
    // ---- clouds ----
    const covBase = cloud;
    const covE = clamp(covBase * 0.78 + 0.02), covR = clamp(0.66 + 0.3 * rain);
    const rainAmt = clamp(rain * 1.25 + 0.08 * smooth(0.0, 0.05, rain)); // rain-cloud strength (dissolves as the rain stops)
    U.uRainCell.value.set(o.rainEdgeX, o.rainCell[1], o.rainCell[2], o.rainCell[3]);
    U.uView.value.set(camPos.x, camPos.y, camPos.z, smooth(o.rainRegionX[0], o.rainRegionX[1], camPos.x));
    U.uRainBlob.value.set(...o.rainCloudBlob);
    U.uCA.value.set(covE, covR, rainAmt, o.cloudDensity);
    const shellBase = Math.min(o.cloudBase, o.rainBase) - 100, shellTop = Math.max(o.cloudTop, o.rainTop) + 140;
    U.uCB.value.set(o.cloudBase, o.cloudTop, o.rainBase, o.rainTop);
    const gapR = o.gapRadius * D2R;
    U.uCC.value.set(gap, Math.cos(gapR * 0.35), Math.cos(gapR * 1.25), o.rainEdgeX);
    const aboveDeck = smooth(o.cloudTop - 200, o.cloudTop + 250, camH);
    U.uCD.value.set(shellBase, shellTop, o.maxCloudDist * (1 + 2.2 * aboveDeck), o.shapeScale);
    U.uFloorAlbedo.value = mix(o.groundAlbedo, 0.72 * clamp(0.35 + cloud), aboveDeck);
    const vis = o.visibility * (1.15 - 0.5 * mist);
    const ciAmt = o.cirrus ?? clamp(0.18 + 0.35 * cloud);
    U.uCE.value.set(o.detailScale, vis, o.cirrusAltitude, ciAmt);
    U.uGapDir.value.set(...moonDir);
    U.uWind.value.set(-windDir[0] * D, -D * 0.06, -windDir[2] * D);
    U.uWind2.value.set(-windDir[0] * D * 1.25, -D * 0.1, -windDir[2] * D * 1.25);
    // key light for the clouds: moon at night, sun by day (both TOA irradiance * transmittance at ~1.1 km)
    const tMoonCl = lunarTransmittance(transmittanceJS(1.1, moonDir[1], o.mie),o.lunarCloudNeutrality), tSunCl = transmittanceJS(sunDir[1] < 0.03 ? 3.0 : 1.1, sunDir[1], o.mie);
    const moonI = [U.uMoonE.value.x * tMoonCl[0], U.uMoonE.value.y * tMoonCl[1], U.uMoonE.value.z * tMoonCl[2]];
    const sunI = [U.uSunE.value.x * tSunCl[0] / o.daySkyGain * TW.gu, U.uSunE.value.y * tSunCl[1] / o.daySkyGain * TW.gu, U.uSunE.value.z * tSunCl[2] / o.daySkyGain * TW.gu];
    const moonKey = lum(moonI) >= lum(sunI);
    const kDir = moonKey ? moonDir : sunDir, sDir = moonKey ? sunDir : moonDir;
    const kCol = moonKey ? moonI : sunI, sCol = moonKey ? sunI : moonI;
    U.uKeyDir.value.set(...kDir); U.uKeyCol.value.set(...kCol);
    U.uSecDir.value.set(...sDir);
    U.uSecCol.value.set(...(lum(sCol) > 1e-4 * Math.max(1e-6, lum(kCol)) && lum(sCol) > 1e-7 ? sCol : [0, 0, 0]));
    // cirrus: lit at its own altitude (stays lit after sunset)
    const ciH = o.cirrusAltitude / 1000;
    const tMoonCi = lunarTransmittance(transmittanceJS(ciH, moonDir[1], o.mie),o.lunarCloudNeutrality), tSunCi = transmittanceJS(ciH, sunDir[1], o.mie);
    const moonCi = [U.uMoonE.value.x * tMoonCi[0], U.uMoonE.value.y * tMoonCi[1], U.uMoonE.value.z * tMoonCi[2]];
    const sunCi = [U.uSunE.value.x * tSunCi[0] / o.daySkyGain * TW.gu, U.uSunE.value.y * tSunCi[1] / o.daySkyGain * TW.gu, U.uSunE.value.z * tSunCi[2] / o.daySkyGain * TW.gu];
    const ciMoonKey = lum(moonCi) >= lum(sunCi);
    U.uCiKeyDir.value.set(...(ciMoonKey ? moonDir : sunDir));
    const ciK = ciMoonKey ? moonCi : sunCi;
    U.uCiKeyCol.value.set(ciK[0], ciK[1], ciK[2]);
    U.uCi.value.set(o.cirrusAltitude, ciAmt, 0.28, 0);
    U.uCiAxis.value.set(windDir[0], windDir[2]).normalize();
    U.uCiWind.value.set(-windDir[0] * D * 2.2, 0, -windDir[2] * D * 2.2);
    U.uIceHalo.value.set(clamp(ciAmt - 0.35) * 1.4, 22 * D2R, 0.9 * D2R, 0);
    // ---- discs ----
    const moonAng = 0.2655 * D2R * o.moonScale, sunAng = 0.2665 * D2R * o.sunScale;
    const moonAbove = smooth(-1.2, 0.6, F.w.moonElev ?? Math.asin(moonDir[1]) / D2R);
    const sunAbove = smooth(-1.0, 0.6, F.w.sunElev ?? Math.asin(sunDir[1]) / D2R);
    const mr = o.moonRadiance * moonAbove;
    const moonRad = [mr * o.moonTint[0] * tMoonCam[0], mr * o.moonTint[1] * tMoonCam[1], mr * o.moonTint[2] * tMoonCam[2]];
    const sr = o.sunRadiance * sunAbove;
    const sunRad = [sr * sunCol[0] * tSunCam[0], sr * sunCol[1] * tSunCam[1], sr * sunCol[2] * tSunCam[2]];
    U.uSunDirD.value.set(...sunDir); U.uMoonDirD.value.set(...moonDir);
    U.uSunRad.value.set(...sunRad); U.uMoonRad.value.set(...moonRad);
    U.uDisc.value.set(Math.cos(sunAng * 1.05), Math.cos(moonAng * 1.06), sunAng, moonAng);
    // moon frame: lunar north toward the celestial pole (parallactic angle), blended with "north up"
    const pole = dirFrom(0, o.latitude);
    const f = moonDir;
    const upW = Math.abs(f[1]) > 0.995 ? [0, 0, -1] : [0, 1, 0];
    const projOn = (v) => norm([v[0] - f[0] * dot(v, f), v[1] - f[1] * dot(v, f), v[2] - f[2] * dot(v, f)]);
    const nUp = projOn(upW), nPole = projOn(pole);
    const north = norm([mix(nUp[0], nPole[0], o.moonTilt), mix(nUp[1], nPole[1], o.moonTilt), mix(nUp[2], nPole[2], o.moonTilt)]);
    const right = norm(cross(f, north));
    const toward = [-f[0], -f[1], -f[2]];
    U.uMoonFrame.value.set(right[0], north[0], toward[0], right[1], north[1], toward[1], right[2], north[2], toward[2]);
    // phase: bright limb toward the (projected) sun; fixed phase angle (same moon face & phase all film)
    let ps = [sunDir[0] - f[0] * dot(sunDir, f), sunDir[1] - f[1] * dot(sunDir, f), sunDir[2] - f[2] * dot(sunDir, f)];
    let psx = dot(ps, right), psy = dot(ps, north);
    if (Math.hypot(psx, psy) < 1e-3) { psx = 0.5; psy = -0.86; }
    const pl = Math.hypot(psx, psy); psx /= pl; psy /= pl;
    const al = o.moonPhaseAngle * D2R;
    U.uMoonSun.value.set(Math.sin(al) * psx, Math.sin(al) * psy, Math.cos(al));
    // ---- halos ----
    const hazeAmt = 0.45 + 0.55 * mist;
    // halo = moonlight scattered by haze near the viewer: scales with the moon's extinction, coloured by it
    const tMoonL = lum(tMoonCam);
    const haloBase = 0.15 * o.halo * moonAbove * nightAmt * hazeAmt * Math.sqrt(clamp(tMoonL / 0.75));
    const mcol = tMoonL > 1e-7 ? [o.moonTint[0] * tMoonCam[0] / tMoonL, o.moonTint[1] * tMoonCam[1] / tMoonL, o.moonTint[2] * tMoonCam[2] / tMoonL] : [1, 0.7, 0.4];
    U.uHaloW.value.set(haloBase * 0.3, 0, 1 / (4.5 * D2R), 1 / (14 * D2R));
    U.uHaloCol.value.set(mcol[0] * 0.95, mcol[1] * 0.98, mcol[2]);
    U.uNearHalo.value.set(haloBase * 0.42, 1 / (1.15 * D2R), 0.9 * sunAbove * (0.5 + 0.5 * mist) * lum(tSunCam), 1 / (1.2 * D2R));
    U.uNearHaloCol.value.copy(U.uHaloCol.value);
    const tSunL = lum(tSunCam);
    if (tSunL > 1e-7) U.uSunHaloCol.value.set(sunCol[0] * tSunCam[0] / tSunL, sunCol[1] * tSunCam[1] / tSunL, sunCol[2] * tSunCam[2] / tSunL); else U.uSunHaloCol.value.set(1, 0.6, 0.3);
    U.uFrontHalo.value = haloBase * 0.16;
    // ---- stars ----
    U.uStarP.value.set(o.stars * nightAmt * smooth(-4, -12, F.w.sunElev ?? -30), F.t, 0.22, 0);
    U.uMWStar.value.set(1, 0, 0, 0);
    // ---- JS-side info ----
    const P = {
      wind: [U.uWind.value.x, U.uWind.value.y, U.uWind.value.z], rainEdgeX: o.rainEdgeX, rain: rainAmt,
      base: o.cloudBase, top: o.cloudTop, rainBase: o.rainBase, rainTop: o.rainTop, covE, covR,
      gap, gapOrigin: o.gapOrigin, gapDir: moonDir, gapCosInner: U.uCC.value.y, gapCosOuter: U.uCC.value.z,
      rainWest: o.rainCell[1], rainZ: o.rainCell[2], clearRegion: o.rainCell[3], view: [camPos.x, camPos.y, camPos.z, smooth(o.rainRegionX[0], o.rainRegionX[1], camPos.x)], rainBlob: o.rainCloudBlob,
      shapeScale: o.shapeScale, ext: o.cloudDensity, shellBase, shellTop, maxDist: U.uCD.value.z,
    };
    Object.assign(info, { t: F.t, day, sunDir, moonDir, sunRad, moonRad, moonAngR: moonAng, sunAngR: sunAng, key: moonKey ? 'moon' : 'sun', keyDir: kDir, keyCol: kCol, cloudParams: P, moonAbove, sunAbove, tMoonCam, tSunCam });
    return P;
  }

  // ---------------- update ----------------
  const _invVP = new THREE.Matrix4();
  function update(t, w, camera) {
    if (!w) throw new Error('sky.update(t, world, camera): world state required');
    const camPos = new THREE.Vector3(0, 2, 0);
    if (camera) { camera.updateMatrixWorld(); camera.matrixWorld.decompose(camPos, _q, _s); }
    const F = frameParams(t, w);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const outW = ctx.width || size.x, outH = ctx.pictureHeight || ctx.height || size.y;
    const camKey = camera ? camera.matrixWorld.elements.map((x) => x.toFixed(5)).join(',') + camera.projectionMatrix.elements.map((x) => x.toFixed(5)).join(',') : 'none';
    const key = `${t}|${quality}|${camKey}|${JSON.stringify([w.sunElev, w.moonElev, w.cloudCover, w.rain, w.moonGap, w.mist, w.sunAzim, w.moonAzim])}`;
    if (key === lastKey) return api;
    lastKey = key;
    const P = computeUniforms(F, camPos);
    // probes (JS mirror): cloud transmittance toward the moon/sun from the camera and from the valley centre
    info.moonT = F.w.moonElev > -2 ? mirror.transmittanceRay([camPos.x, camPos.y, camPos.z], F.moonDir, P) : 0;
    info.sunT = F.w.sunElev > -2 ? mirror.transmittanceRay([camPos.x, camPos.y, camPos.z], F.sunDir, P) : 0;
    U.uMoonT.value = info.moonT;
    const prevRT = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    U.uCamPos.value.copy(camPos);
    const camH = altitudeM(camPos);
    // 1) sky-view LUT (sun + moon, MRT)
    pass(R.M.skyview, R.lut, 'lut');
    // 2) clear-sky equirect
    pass(R.M.clear, R.clear, 'clear');
    // 3) ambient of the clear sky (row 0) -> cloud ambient
    R.M.amb.uniforms.uSrc.value = R.clear.texture;
    R.amb.viewport.set(0, 0, 6, 1); R.amb.scissor.set(0, 0, 6, 1); R.amb.scissorTest = true;
    pass(R.M.amb, R.amb, 'amb');
    // cloud ambient (radiance) from a JS estimate of the sky above the clouds (keeps GPU->CPU sync out of the frame)
    const skyAmb = estimateAmbient(F);
    U.uAmbTop.value.set(...skyAmb.top); U.uAmbBot.value.set(...skyAmb.bot);
    // 4) cloud map (equirect, from the camera)
    const wet = U.uCA.value.z > 0.001;   // rain-cloud logic needed this frame?
    pass(wet ? R.M.cloudMap : R.M.cloudMapDry, R.cloudMap, 'cloudMap');
    // 5) screen cloud buffer
    overlayActive = o.overlay === true || (o.overlay === 'auto' && camH > P.shellBase - 60);
    if (camera) {
      ensureScreen(outW, outH);
      rotOnlyVP(camera, U.uCloudVP.value);
      U.uInvVPRot.value.copy(U.uCloudVP.value).invert();
      if (depthInfo && overlayActive) {
        U.uUseDepth.value = 1; U.uDepth.value = depthInfo.texture; U.uDepthP.value.set(camera.near, camera.far, 1, 0);
      } else U.uUseDepth.value = 0;
      pass(wet ? R.M.cloudScreen : R.M.cloudScreenDry, R.screenRaw, 'cloudScreen');
      pass(R.M.resolve, R.screen, 'resolve');
      updCam = camera; updFov = camera.fov; updPos.copy(camPos); camera.getWorldDirection(updFwd);
    } else updCam = null;
    for (const m of ovMeshes) m.visible = overlayActive;
    // 6) cloud shadow map around the valley (key light)
    const S = o.shadowSize || 4000;
    U.uShadowRect.value.set(-S / 2, -S / 2, S, 0);
    pass(wet ? R.M.shadow : R.M.shadowDry, R.shadow, 'shadow');
    // 7) final sky map (clear + cirrus + clouds)
    pass(R.M.skymap, R.skyMap, 'skyMap');
    // 8) ambient of the full sky (row 1) for fog / haze
    R.M.amb.uniforms.uSrc.value = R.skyMap.texture;
    R.amb.viewport.set(0, 1, 6, 1); R.amb.scissor.set(0, 1, 6, 1);
    pass(R.M.amb, R.amb, 'amb');
    R.amb.scissorTest = false; R.amb.viewport.set(0, 0, 6, 2); R.amb.scissor.set(0, 0, 6, 2);
    // 9) environment (cubeUV)
    renderEnv();
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAutoClear;

    // public uniforms
    PU.skySunDir.value.copy(U.uSunDirD.value); PU.skyMoonDir.value.copy(U.uMoonDirD.value);
    PU.skySunDisc.value.copy(U.uSunRad.value).multiplyScalar(0.6);
    PU.skyMoonDisc.value.copy(U.uMoonRad.value).multiplyScalar(0.9);
    PU.skyDiscA.value.set(Math.cos(info.sunAngR), Math.cos(info.moonAngR), info.sunAngR, info.moonAngR);
    PU.skyKeyDir.value.copy(U.uKeyDir.value); PU.skyKeyColor.value.copy(U.uKeyCol.value);
    PU.skyShadowRect.value.copy(U.uShadowRect.value);
    const keyT = info.key === 'moon' ? info.moonT : info.sunT;
    PU.skyHazeA.value.set(0.9 * (0.4 + 0.6 * F.mist), 0.62, keyT, F.mist);
    PU.skyHazeKeyCol.value.copy(U.uKeyCol.value);
    PU.skyNearHalo.value.copy(U.uNearHalo.value); PU.skyNearHaloCol.value.copy(U.uNearHaloCol.value); PU.skySunHaloCol.value.copy(U.uSunHaloCol.value);
    return api;
  }

  // approximate ambient radiance above/below the cloud layer (JS) — tuned to the LUT sky
  function estimateAmbient(F) {
    const sEl = Math.asin(clamp(F.sunDir[1], -1, 1)) / D2R, mEl = Math.asin(clamp(F.moonDir[1], -1, 1)) / D2R;
    const sunE = o.sunE, moonE = o.moonE;
    // clear-sky diffuse irradiance / pi relative to the direct irradiance, by source elevation (fit to the LUT sky)
    const skyFrac = (el) => (el < -18 ? 0 : el < 0 ? 0.035 * Math.pow(10, el / 6.5) : 0.035 + 0.05 * Math.sin(Math.min(el, 60) * D2R));
    const blueS = sEl > 4 ? [0.55, 0.78, 1.0] : sEl > -4 ? [0.62, 0.72, 1.0] : [0.45, 0.6, 1.0];
    const kS = sunE * skyFrac(sEl), kM = moonE * skyFrac(mEl) * (1 - F.day);
    const top = [kS * blueS[0] + kM * 0.5 + o.airglow[0] * 1.2, kS * blueS[1] + kM * 0.68 + o.airglow[1] * 1.2, kS * blueS[2] + kM * 1.0 + o.airglow[2] * 1.2];
    // ground bounce: albedo * (direct + sky) under the (partly) cloudy sky
    const tS = transmittanceJS(0.05, F.sunDir[1], o.mie), tM = transmittanceJS(0.05, F.moonDir[1], o.mie);
    const dirS = Math.max(0, F.sunDir[1]) * sunE, dirM = Math.max(0, F.moonDir[1]) * moonE * (1 - F.day);
    const cloudy = 1 - 0.6 * F.cloud;
    const a = o.groundAlbedo / Math.PI;
    const bot = [a * (dirS * tS[0] * cloudy + dirM * tM[0] * cloudy + top[0] * Math.PI * 0.8), a * (dirS * tS[1] * cloudy + dirM * tM[1] * cloudy + top[1] * Math.PI * 0.8), a * (dirS * tS[2] * cloudy + dirM * tM[2] * cloudy + top[2] * Math.PI * 0.8)];
    return { top, bot };
  }

  function renderEnv() {
    // 64x32 pre-blurred source
    pass(R.M.down, R.small, 'envDown');
    const prof = api.profile; const te0 = prof ? performance.now() : 0;
    const env = R.envRT, M = R.M.env;
    const { sizeLods, meshes } = R.planes;
    const cubeSize = R.envSize;
    const scene = sh.quad.scene;
    for (let i = 0; i < meshes.length; i++) {
      const s = sizeLods[i];
      const mip = R.lodMax - i;
      const rough = mipToRoughness(mip);
      const sigma = i === 0 ? 0 : rough * rough * 1.05;
      M.uniforms.uSigma.value = sigma;
      M.uniforms.uSmall.value = sigma > 0.06 ? 1 : 0;
      const x = 3 * s * (i > R.lodMax - 4 ? i - R.lodMax + 4 : 0);
      const y = 4 * (cubeSize - s);
      env.viewport.set(x, y, 3 * s, 2 * s); env.scissor.set(x, y, 3 * s, 2 * s);
      meshes[i].material = M;
      M.uniformsNeedUpdate = true;
      renderer.setRenderTarget(env);
      renderer.render(meshes[i], sh.quad.cam);
    }
    if (prof) { renderer.readRenderTargetPixels(env, 0, 0, 1, 1, _pbuf); prof.env = (prof.env || 0) + performance.now() - te0; }
    void scene;
  }

  // ---------------- public helpers ----------------
  let depthInfo = null;
  let privBg = null;
  const _p4 = new THREE.Vector4();
  function screenOf(dir, camera, angR, radiance, T) {
    camera.updateMatrixWorld();
    rotOnlyVP(camera, _m4b);
    _p4.set(dir[0], dir[1], dir[2], 0).applyMatrix4(_m4b);
    const inFront = _p4.w > 0;
    const x = _p4.x / _p4.w, y = _p4.y / _p4.w;
    const hPx = ctx.pictureHeight || ctx.height || renderer.domElement.height;
    const rPx = angR / (camera.fov * D2R) * hPx;
    return { x, y, uv: [x * 0.5 + 0.5, y * 0.5 + 0.5], onScreen: inFront && Math.abs(x) < 1.1 && Math.abs(y) < 1.1, inFront, radiusPx: rPx, radiusNdcY: rPx / hPx * 2, radiance, visibility: T };
  }
  const api = {
    object, overlay,
    update,
    get skyMapTexture() { return R.skyMap.texture; },
    get clearSkyTexture() { return R.clear.texture; },
    get cloudShadowTexture() { return R.shadow.texture; },
    get moonTexture() { return sh.moon.texture; },
    getEnvironment() { return R.envRT.texture; },
    skyGLSL: SKY_GLSL,
    uniforms: PU,
    /** extra background meshes (one per scene when several Sets share this sky) */
    makeBackgroundMesh: makeSkyGroup, makeOverlayMesh,
    setQuality(q) { const nq = q === 'preview' ? 'preview' : 'final'; if (nq !== quality) { quality = nq; build(); } },
    get quality() { return quality; },
    setOptions(p) { Object.assign(o, p); lastKey = null; },
    invalidate() { lastKey = null; },
    _debug() { return { clearRT: R.clear, skyMapRT: R.skyMap, screen: R.screen ? R.screen.textures[0] : null, lut: R.lut, cloudMap: R.cloudMap.texture, clear: R.clear.texture, env: R.envRT.texture, amb: R.amb.texture, U }; },
    options: o,
    /** render the sky background alone into `target` (or the canvas) for `camera` */
    renderBackground(r = renderer, camera, target = null) {
      if (!privBg) { privBg = new THREE.Scene(); privBg.add(makeSkyGroup()); privBg.add(makeOverlayMesh()); for (const m of ovMeshes) m.visible = overlayActive; }
      r.setRenderTarget(target);
      r.render(privBg, camera);
    },
    /** moon position on screen for `camera` (NDC x,y in [-1,1]); radiance (rgb), visibility = cloud transmittance */
    getMoonScreen(camera) { return screenOf(info.moonDir, camera, info.moonAngR, info.moonRad, info.moonT * (info.moonAbove ?? 1)); },
    getSunScreen(camera) { return screenOf(info.sunDir, camera, info.sunAngR, info.sunRad, info.sunT * (info.sunAbove ?? 1)); },
    /** direct light for Sets: directional-light parameters consistent with LIB_COMMON (three physical units) */
    getLightInfo(pos = null) {
      const P = info.cloudParams;
      const from = pos ? [pos.x ?? pos[0], pos.y ?? pos[1], pos.z ?? pos[2]] : o.gapOrigin;
      const Pv = P ? { ...P, view: [from[0], from[1], from[2], smooth(o.rainRegionX[0], o.rainRegionX[1], from[0])] } : null;
      const moonT = Pv ? mirror.transmittanceRay(from, info.moonDir, Pv) : 1;
      const sunT = Pv ? mirror.transmittanceRay(from, info.sunDir, Pv) : 1;
      const tm = transmittanceJS(0.05, info.moonDir[1], o.mie), ts = transmittanceJS(0.05, info.sunDir[1], o.mie);
      const mI = o.moonE * (1 - info.day) * (info.moonAbove ?? 1);
      const sI = o.sunE * (info.sunAbove ?? 1);
      const tint = (tt) => { const L = lum(tt) || 1e-6; return [tt[0] / L, tt[1] / L, tt[2] / L]; };
      return {
        moon: { dir: info.moonDir, color: tint([o.moonLightColor[0] * tm[0], o.moonLightColor[1] * tm[1], o.moonLightColor[2] * tm[2]]), intensity: mI * lum(tm), cloudT: moonT, intensityClouded: mI * lum(tm) * moonT },
        sun: { dir: info.sunDir, color: tint([o.sunColor[0] * ts[0], o.sunColor[1] * ts[1], o.sunColor[2] * ts[2]]), intensity: sI * lum(ts), cloudT: sunT, intensityClouded: sI * lum(ts) * sunT },
        key: info.key,
      };
    },
    /** JS probe: low-cloud transmittance along a ray (world metres) */
    _debugRay(origin, dir) { return mirror.debugRay(origin, dir, info.cloudParams); },
    cloudTransmittance(origin, dir) { return info.cloudParams ? mirror.transmittanceRay(origin, dir, info.cloudParams) : 1; },
    info,
    profile: null,
    driftAt: (t) => (o.drift ? o.drift(t) : driftAt(t)),
    dispose() {
      disposeQ(); bgMat.dispose(); ovMat.dispose(); quadGeo.dispose(); starMat.dispose(); starGeo.dispose(); discMat.dispose(); discGeo.dispose();
      sh.refs--;
      if (sh.refs <= 0) {
        sh.trans.dispose(); sh.ms.dispose(); sh.weatherRT.dispose(); sh.noise3.dispose(); sh.moon.dispose(); sh.quad.geo.dispose();
        SHARED.delete(renderer);
      }
    },
  };
  return api;
}

/**
 * One sky per renderer, shared by every Set (the bakes run once per frame no matter how many Sets use it).
 * Each Set adds its own meshes: scene.add(sky.makeBackgroundMesh(), sky.makeOverlayMesh()).
 */
const SHARED_SKY = new WeakMap();
export function getSharedSky(ctx, opts = {}) {
  let s = SHARED_SKY.get(ctx.renderer);
  if (!s) { s = createSky(ctx, opts); SHARED_SKY.set(ctx.renderer, s); }
  return s;
}

export { SKY_GLSL, driftAt };
