// Author: suwubee
// engine/moon.js — procedural near-side Moon (albedo + relief normals), baked ONCE on the GPU at startup.
//
//   import { createMoonTexture } from './moon.js';
//   const moon = createMoonTexture(renderer, THREE, { size: 1024 });
//   moon.texture   // RGBA8, mipmapped. Orthographic view of the near side, lunar north = +v, lunar east (Mare
//                  // Crisium side) = +u, i.e. exactly how the Moon looks from Earth with north up.
//                  //   r = normal-albedo (linear, highlands ~0.62, maria ~0.33, fresh ejecta/rays up to ~1)
//                  //   g,b = surface normal x,y (in the disc frame, encoded *0.5+0.5), a = 1 inside the limb.
//   moon.dispose()
//
// Content (fixed seed -> the same face all film): the named maria at their selenographic positions (Procellarum,
// Imbrium, Serenitatis, Tranquillitatis, Crisium, Fecunditatis, Nectaris, Nubium, Humorum, Frigoris, Vaporum,
// Cognitum, Insularum, the sinus/lacus, limb maria), dark-floored Plato/Grimaldi/Riccioli, ~40 named craters with
// relief, 4 octaves of cellular random craters (fewer on the maria), FBM highland mottling, and bright ray systems
// for Tycho (incl. the long ray across Serenitatis), Copernicus, Kepler, Aristarchus, Proclus, Anaxagoras, Glushko.
// Pure function of `seed`. No images.
import { GLSL_NOISE } from './noise.js';

// [lon(E+), lat(N+), a(E-W half-size deg), b(N-S half-size deg)], [rot(deg), tone(albedo), edgeNoise, depth]
const MARIA = [
  // Oceanus Procellarum (several lobes)
  [[-56, 20, 16, 16], [0, 0.40, 0.30, 1]], [[-47, 3, 12, 11], [10, 0.41, 0.30, 1]], [[-63, 35, 10, 12], [-10, 0.40, 0.30, 1]],
  [[-41, 29, 9, 8], [0, 0.42, 0.30, 1]], [[-61, 6, 9, 12], [0, 0.39, 0.30, 1]], [[-52, -8, 8, 7], [20, 0.41, 0.30, 1]],
  [[-70, 22, 5, 12], [0, 0.40, 0.25, 1]],
  // Mare Imbrium + Sinus Iridum
  [[-16, 33, 20, 16], [0, 0.42, 0.22, 1]], [[-31, 45, 5.5, 3.2], [-25, 0.44, 0.2, 0.6]],
  // Serenitatis (lighter core, darker rim added separately), Tranquillitatis (+NE lobe), Crisium
  [[17.5, 28, 11.5, 11], [0, 0.47, 0.18, 1]], [[31, 8.5, 13, 9.5], [15, 0.355, 0.28, 1]], [[37.5, 15, 6, 5], [0, 0.365, 0.3, 1]],
  [[59, 17, 9.2, 7.6], [0, 0.375, 0.15, 1]],
  // Fecunditatis, Nectaris, Nubium, Humorum, Vaporum, Cognitum, Insularum
  [[51, -6, 8.5, 13], [-10, 0.43, 0.3, 1]], [[35, -15, 5.5, 5.5], [0, 0.42, 0.15, 1]], [[-17, -20, 12, 10], [0, 0.46, 0.3, 1]],
  [[-39, -24, 6.4, 6], [0, 0.40, 0.15, 1]], [[4, 13, 4.5, 3.5], [0, 0.40, 0.3, 1]], [[-23, -10, 6, 5], [0, 0.46, 0.3, 0.8]],
  [[-31, 7, 8, 5], [0, 0.47, 0.35, 0.8]],
  // Frigoris (long band), Lacus Somniorum, Sinus Medii / Aestuum, Palus Putredinis
  [[-30, 56, 14, 4.5], [5, 0.48, 0.3, 0.7]], [[0, 58, 16, 4.2], [0, 0.48, 0.3, 0.7]], [[28, 56, 12, 4], [-8, 0.49, 0.3, 0.7]],
  [[30, 37, 7, 4], [20, 0.50, 0.3, 0.6]], [[1, 2, 3, 2.5], [0, 0.48, 0.3, 0.6]], [[-9, 11, 4, 3], [0, 0.43, 0.3, 0.7]],
  [[0, 26, 3, 3], [0, 0.47, 0.3, 0.6]],
  // limb maria: Marginis, Smythii, Undarum/Spumans, Australe patches, Humboldtianum
  [[86, 13, 4, 6], [0, 0.45, 0.3, 0.7]], [[87, -2, 4, 6], [0, 0.44, 0.3, 0.7]], [[67, 6, 3, 3], [0, 0.44, 0.35, 0.5]],
  [[84, -43, 5, 7], [0, 0.47, 0.45, 0.5]], [[82, 56, 3, 4], [0, 0.46, 0.4, 0.5]],
  // dark-floored craters
  [[-68.6, -5.2, 2.9, 2.9], [0, 0.29, 0.05, 0.4]], [[-9.4, 51.6, 1.65, 1.65], [0, 0.33, 0.03, 0.3]], [[-74.3, -3.2, 2.2, 2.2], [0, 0.35, 0.05, 0.3]],
];

// named craters: [lon, lat, radius(deg), freshness(0 old .. 1 fresh bright)], [rayLength(deg, 0 = none), rayCount, rayGain, seed]
const CRATERS = [
  [[-11.2, -43.3, 1.45, 1.0], [30, 26, 1.0, 1]],   // Tycho
  [[-20.1, 9.6, 1.55, 0.85], [13, 22, 0.75, 2]],   // Copernicus
  [[-38.0, 8.1, 0.53, 0.9], [7, 16, 0.7, 3]],      // Kepler
  [[-47.4, 23.7, 0.4, 1.0], [3.5, 12, 0.8, 4]],    // Aristarchus (brightest spot)
  [[46.8, 16.1, 0.23, 1.0], [6, 9, 0.55, 5]],      // Proclus
  [[-10.1, 73.4, 0.85, 0.9], [8, 14, 0.5, 6]],     // Anaxagoras
  [[-77.6, 8.1, 0.7, 0.9], [9, 14, 0.5, 7]],       // Glushko (Olbers A)
  [[-63.7, -24.5, 0.33, 0.9], [6, 10, 0.4, 8]],    // Byrgius A
  [[54.2, -32.7, 0.3, 0.9], [7, 10, 0.4, 9]],      // Furnerius A / Stevinus A
  [[16.0, 16.3, 0.45, 0.85], [0, 0, 0, 0]],        // Menelaus
  [[9.1, 14.5, 0.65, 0.6], [0, 0, 0, 0]],          // Manilius
  [[-14.0, -58.4, 3.8, 0.15], [0, 0, 0, 0]],       // Clavius
  [[-1.9, -9.3, 2.5, 0.1], [0, 0, 0, 0]],          // Ptolemaeus
  [[-2.9, -13.4, 1.8, 0.15], [0, 0, 0, 0]],        // Alphonsus
  [[-1.9, -18.2, 1.6, 0.25], [0, 0, 0, 0]],        // Arzachel
  [[26.4, -11.4, 1.65, 0.45], [0, 0, 0, 0]],       // Theophilus
  [[24.0, -13.2, 1.6, 0.2], [0, 0, 0, 0]],         // Cyrillus
  [[23.4, -18.0, 1.7, 0.15], [0, 0, 0, 0]],        // Catharina
  [[60.4, -25.3, 2.9, 0.3], [0, 0, 0, 0]],         // Petavius
  [[61.0, -8.9, 2.2, 0.45], [0, 0, 0, 0]],         // Langrenus
  [[29.9, 31.8, 1.6, 0.2], [0, 0, 0, 0]],          // Posidonius
  [[-4.0, 29.7, 1.4, 0.25], [0, 0, 0, 0]],         // Archimedes
  [[17.4, 50.2, 1.45, 0.4], [0, 0, 0, 0]],         // Aristoteles
  [[11.3, 45.7, 1.1, 0.35], [0, 0, 0, 0]],         // Eudoxus
  [[-55.0, -44.4, 3.6, 0.1], [0, 0, 0, 0]],        // Schickard
  [[-40.1, -17.5, 1.8, 0.2], [0, 0, 0, 0]],        // Gassendi
  [[-22.2, -20.7, 1.0, 0.5], [0, 0, 0, 0]],        // Bullialdus
  [[-11.3, 14.5, 1.0, 0.4], [0, 0, 0, 0]],         // Eratosthenes
  [[4.0, -11.2, 2.2, 0.1], [0, 0, 0, 0]],          // Albategnius
  [[5.0, -5.6, 2.5, 0.1], [0, 0, 0, 0]],           // Hipparchus
  [[40.0, -45.0, 3.1, 0.1], [0, 0, 0, 0]],         // Janssen
  [[44.4, 46.7, 1.2, 0.35], [0, 0, 0, 0]],         // Atlas
  [[39.1, 46.7, 1.1, 0.35], [0, 0, 0, 0]],         // Hercules
  [[14.0, -42.0, 1.9, 0.15], [0, 0, 0, 0]],        // Maurolycus
  [[6.0, -41.1, 2.1, 0.1], [0, 0, 0, 0]],          // Stöfler
  [[-6.2, -50.0, 2.6, 0.1], [0, 0, 0, 0]],         // Maginus
  [[-28.0, -42.4, 2.2, 0.15], [0, 0, 0, 0]],       // Wilhelm/Longomontanus
  [[-38.6, 14.1, 0.9, 0.35], [0, 0, 0, 0]],        // Kepler-side: Encke-ish
  [[-51.6, -2.3, 1.0, 0.3], [0, 0, 0, 0]],         // Flamsteed P region
  [[-32.6, 13.8, 1.0, 0.25], [0, 0, 0, 0]],        // Tobias Mayer
  [[64.0, -29.0, 1.5, 0.25], [0, 0, 0, 0]],        // Vendelinus/Furnerius region
  [[-60.0, 11.8, 0.9, 0.3], [0, 0, 0, 0]],         // Hevelius-ish
];

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const vec4s = (rows, k) => rows.map((r) => `vec4(${r[k].map(f).join(',')})`).join(',\n  ');

const BAKE_FS = /* glsl */ `
precision highp float; precision highp int;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform float uTexel;
uniform uint uSeed;
${GLSL_NOISE}
#define PI 3.14159265358979
#define D2R 0.017453292519943
const int NM = ${MARIA.length};
const vec4 MA[NM] = vec4[](
  ${vec4s(MARIA, 0)});
const vec4 MB[NM] = vec4[](
  ${vec4s(MARIA, 1)});
const int NC = ${CRATERS.length};
const vec4 CA[NC] = vec4[](
  ${vec4s(CRATERS, 0)});
const vec4 CB[NC] = vec4[](
  ${vec4s(CRATERS, 1)});

vec3 sph(float lonDeg, float latDeg){ float lo = lonDeg*D2R, la = latDeg*D2R; return vec3(cos(la)*sin(lo), sin(la), cos(la)*cos(lo)); }
// local tangent frame (east, north) at unit vector c
void frameAt(vec3 c, out vec3 e, out vec3 n){ e = normalize(cross(vec3(0.0,1.0,0.0), c)); if (dot(e,e) < 0.5) e = vec3(1.0,0.0,0.0); n = cross(c, e); }
float hashU(uint a, uint b){ return float(mvPcg(a * 747796405u + b * 2891336453u + uSeed)) * MV_U2F; }

// crater profile: height (in units of radius) and radial derivative, d = distance / radius
// bowl + raised rim + ejecta falloff
void craterProfile(float d, float depth, out float h, out float dh){
  if (d < 1.0) {
    float fl = 0.18;                                 // flat floor fraction
    float u = max(d - fl, 0.0) / (1.0 - fl);
    h = -depth * (1.0 - u*u) + 0.12 * depth * u*u*u*u;  // bowl rising to the rim
    dh = (d > fl) ? (depth * 2.0*u + 0.48*depth*u*u*u) / (1.0 - fl) : 0.0;
  } else {
    float x = d - 1.0;
    h = 0.12 * depth * exp(-x * 4.0) * (1.0 + x*0.5);
    dh = 0.12 * depth * exp(-x * 4.0) * (0.5 - 4.0*(1.0 + x*0.5));
  }
}

void main(){
  vec2 xy = (vUv * 2.0 - 1.0) * (1.0 + 1.0 / 256.0);    // small margin beyond the limb (see sky.js uMoonTexInfo)
  float r = length(xy);
  vec2 xyc = r > 0.999 ? xy / r * 0.999 : xy;
  vec3 p = vec3(xyc, sqrt(max(0.0, 1.0 - dot(xyc, xyc))));   // x = east, y = north, z = toward Earth
  float lat = asin(clamp(p.y, -1.0, 1.0)) / D2R;
  float lon = atan(p.x, p.z) / D2R;

  // ---------------- maria ----------------
  float mare = 0.0, rim = 0.0, tsum = 0.0, wsum = 0.0;
  vec3 pw = p + 0.06 * vec3(mvFbm(p * 5.0 + 1.7, 4), mvFbm(p * 5.0 - 4.1, 4), mvFbm(p * 5.0 + 8.3, 4));   // domain warp
  float en = mvFbm(pw * 9.0 + 3.1, 5);                  // edge noise
  float en2 = mvFbm(pw * 23.0 - 7.7, 4) + 0.5 * mvFbm(pw * 61.0 + 2.2, 3);
  for (int i = 0; i < NM; i++) {
    vec4 A = MA[i], B = MB[i];
    vec3 c = sph(A.x, A.y);
    float ang = acos(clamp(dot(p, c), -1.0, 1.0)) / D2R;
    if (ang > max(A.z, A.w) * 1.8 + 3.0) continue;
    vec3 e, n; frameAt(c, e, n);
    vec3 dv = p - c * dot(p, c);
    vec2 q = normalize(vec2(dot(dv, e), dot(dv, n)) + 1e-9) * ang;   // azimuthal-equidistant coords (deg)
    float cr = cos(B.x * D2R), sr = sin(B.x * D2R);
    q = vec2(cr*q.x + sr*q.y, -sr*q.x + cr*q.y);
    float dist = length(q / A.zw);
    float d2 = dist + B.z * (en * 1.2 + en2 * 0.55);
    float m = 1.0 - smoothstep(0.82, 1.1, d2);
    float core = 0.84 + 0.16 * smoothstep(0.25, 1.0, d2);      // darker mare interiors, lighter shores
    tsum += m * B.y * 0.8 * core; wsum += m;
    mare = max(mare, m * B.w);
    if (i == 9) rim = max(rim, smoothstep(0.62, 0.95, d2) * (1.0 - smoothstep(0.95, 1.1, d2)));   // Serenitatis dark rim
  }
  float tone = wsum > 1e-4 ? tsum / wsum : 0.42;
  // ---------------- highlands albedo mottling ----------------
  float hn = mvFbm(p * 6.0 + 11.0, 6);
  float hn2 = mvFbm(p * 40.0 - 5.0, 4);
  float high = 0.62 + 0.09 * hn + 0.035 * hn2;
  float mareA = tone * (1.0 + 0.12 * mvFbm(pw * 14.0 + 2.0, 5) + 0.05 * mvFbm(pw * 45.0 - 3.0, 3)) - 0.045 * rim;
  float albedo = mix(high, mareA, mare);

  // ---------------- relief: gradient accumulation (in the local (e,n) frame of p) ----------------
  vec3 ep, np; frameAt(p, ep, np);
  vec2 grad = vec2(0.0);
  float bright = 0.0;       // fresh ejecta brightening
  float rays = 0.0;
  // named craters
  for (int i = 0; i < NC; i++) {
    vec4 A = CA[i], B = CB[i];
    vec3 c = sph(A.x, A.y);
    float ang = acos(clamp(dot(p, c), -1.0, 1.0)) / D2R;
    float R = A.z;
    // rays
    if (B.x > 0.0 && ang < B.x * 2.6) {
      vec3 e, n; frameAt(c, e, n);
      vec3 dv = p - c * dot(p, c);
      float bear = atan(dot(dv, e), dot(dv, n));          // 0 = north, +east
      float acc = 0.0;
      int nr = int(B.y);
      for (int k = 0; k < 28; k++) {
        if (k >= nr) break;
        float bk = hashU(uint(i) * 131u + uint(k), 17u) * 2.0 * PI;
        float lk = B.x * (0.35 + 0.9 * hashU(uint(i) * 131u + uint(k), 29u));
        float wk = R * (0.18 + 0.35 * hashU(uint(i) * 131u + uint(k), 37u));
        float db = bear - bk; db = atan(sin(db), cos(db));
        float perp = abs(sin(db)) * ang; float along = cos(db) * ang;
        if (along > 0.0) {
          float w = wk * (1.0 + along / (B.x * 0.8));
          float g = exp(-perp * perp / (w * w)) * exp(-along / lk) * smoothstep(R * 0.9, R * 2.2, ang);
          float streak = 0.55 + 0.45 * mvGradient(vec2(along * 1.7 / max(R, 0.3), float(k) * 7.1));
          acc += g * streak;
        }
      }
      // Tycho's famous long ray across Mare Serenitatis (bearing ~ N 23 E)
      if (i == 0) {
        float db = bear - 0.40; db = atan(sin(db), cos(db));
        float perp = abs(sin(db)) * ang, along = cos(db) * ang;
        if (along > 0.0) acc += 0.8 * exp(-perp*perp / 0.9) * exp(-along / 70.0) * smoothstep(3.0, 8.0, ang) * (0.6 + 0.4 * mvGradient(vec2(along * 0.4, 3.3)));
      }
      rays += acc * B.z;
      // bright ejecta blanket / dark collar for fresh craters
      bright += A.w * B.z * 0.55 * exp(-max(ang - R, 0.0) / (R * 0.9)) * smoothstep(R * 0.6, R * 1.05, ang);
    }
    if (ang < R * 3.0) {
      float h, dh; craterProfile(ang / R, 0.22, h, dh);
      // radial direction in p's frame
      vec3 dv = c - p * dot(c, p);
      vec2 rdir = -normalize(vec2(dot(dv, ep), dot(dv, np)) + 1e-9);
      grad += rdir * dh * (1.0 - 0.3 * A.w);
      bright += A.w * 0.12 * exp(-max(ang - R * 0.9, 0.0) / (R * 0.3));
      // floors of old large craters: slightly darker, rims slightly brighter
      albedo += (ang < R * 0.85 ? -0.02 : 0.0) * (1.0 - A.w) + 0.015 * exp(-pow((ang - R) / (R * 0.12), 2.0));
    }
  }
  // random craters: 4 octaves of cellular craters on the sphere (3-D cells)
  float craterDensity = mix(1.0, 0.35, mare);
  for (int o = 0; o < 4; o++) {
    float cell = 0.30 * pow(0.5, float(o));
    vec3 g = p / cell;
    vec3 base = floor(g - 0.5);
    for (int k = 0; k < 8; k++) {
      vec3 ci = base + vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
      vec3 h3 = mvHash33(ci + vec3(float(o) * 101.0, 17.0, float(uSeed & 255u)));
      if (h3.x > 0.62 * craterDensity + 0.08) continue;
      vec3 cc = normalize((ci + 0.25 + 0.5 * h3) * cell);
      float rr = cell * (0.16 + 0.26 * h3.y * h3.y);            // radius (unit sphere, ~ radians)
      float ang = acos(clamp(dot(p, cc), -1.0, 1.0));
      if (ang > rr * 2.5) continue;
      float fresh = step(0.86, h3.z);
      float h, dh; craterProfile(ang / rr, mix(0.16, 0.24, h3.z), h, dh);
      vec3 dv = cc - p * dot(cc, p);
      vec2 rdir = -normalize(vec2(dot(dv, ep), dot(dv, np)) + 1e-9);
      grad += rdir * dh * 0.8;
      albedo += 0.012 * exp(-pow((ang - rr) / (rr * 0.18), 2.0)) + (ang < rr ? -0.006 : 0.0);
      bright += fresh * 0.12 * exp(-max(ang - rr, 0.0) / (rr * 0.6)) * (1.0 - 0.5 * float(o == 0));
    }
  }
  // maria: wrinkle ridges / subtle relief; highlands: rough
  vec2 rough = vec2(mvGradient(p * 60.0 + 1.3), mvGradient(p * 60.0 - 9.1)) * 0.06 * (1.0 - 0.6 * mare);
  grad += rough;

  albedo = albedo + bright * 0.55 + rays * 0.30 * (1.0 - 0.25 * mare);
  albedo = clamp(albedo, 0.05, 1.0);
  // normal in the disc frame: tangent-plane gradient -> perturbed sphere normal, expressed in (x,y) of the disc
  vec3 nrm = normalize(p - 0.5 * (grad.x * ep + grad.y * np));
  float inside = 1.0 - smoothstep(1.0, 1.0 + uTexel * 2.0, r);
  fragColor = vec4(albedo, nrm.x * 0.5 + 0.5, nrm.y * 0.5 + 0.5, inside);
}`;

const VS = /* glsl */ `out vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * Bake the procedural Moon. Returns { texture, size, dispose }.
 * opts.size (default 1024), opts.seed (default 7 — the film's Moon).
 */
export function createMoonTexture(renderer, THREE, opts = {}) {
  const size = opts.size || 1024;
  const seed = (opts.seed ?? 7) >>> 0;
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: BAKE_FS,
    uniforms: { uTexel: { value: 2 / size }, uSeed: { value: seed } },
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(mesh, cam);
  renderer.setRenderTarget(prev);
  mat.dispose(); geo.dispose();
  return { texture: rt.texture, size, dispose() { rt.dispose(); } };
}

export const MOON_DATA = { MARIA, CRATERS };
