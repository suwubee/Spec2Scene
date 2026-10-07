// Author: suwubee

// bamboo ribs (paper wrapped over them -> faint ridges; silhouettes when lit), dark turned-wood caps, cord + iron hook,
// short brown-red tassel, and a real candle flame inside. NOT festival red: oiled paper #f2d9a8 glowing amber.
//
//   import { createLantern } from './lantern.js';

//   scene.add(L.object); scene.add(L.light);            // L.light = the flame's PointLight (1.1 cd × glow, LIB_COMMON)
//   // per frame (pure function of t):
//   L.update(t, { glow, flicker, swayX, swayZ, env: { ambient:[r,g,b], moonDir, moonCol:[r,g,b] }, camera, ember });
//
// Emission model of the paper (custom shader, scene-linear HDR):
//   L = τ(fibres, soot)/π · (E_direct(flame, 1/r², cosθ, rib shadows) + E_cavity) · paperTint + hot spot + exterior
//   * E_cavity: the inside of a paper lantern is an integrating sphere (paper reflects ~45 % inward) -> a uniform
//     component so the barrel glows evenly-ish (top/middle ≈ 0.4) instead of a hard 1/r² blob;
//   * ribs: the bamboo strips glued inside block the direct light -> dark vertical lines, soft 4 mm penumbra;
//   * hot spot: the direct (unscattered) transmission shows a blurred image of the flame where the line of sight to the
//     flame crosses the paper: HDR core ~30 × glow (blooms, streaks, bokeh) — "the real flame behind the paper";
//   * soot darkens the top inside; paper fibres/oil blotches (procTex 'paper' lantern variant) modulate transmission.
// Everything is a pure function of (t, glow, flicker) — no state.
import * as THREE_NS from '../engine/vendor/three.module.js';
import * as G from '../engine/geo.js';
import { makeRng, hashString, GLSL_NOISE } from '../engine/noise.js';
import { hexLin } from '../engine/procTex.js';

const TAU = Math.PI * 2;
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);

export const LANTERN = {
  radiusMid: 0.19, radiusEnd: 0.166, halfH: 0.25, ribs: 14,
  capR: 0.176, capH: 0.034,
  flameY: -0.145,           // flame centre (local, lantern centre = 0): candle in the lower part
  candleTop: -0.172,
  paperHex: '#f2d9a8', tasselHex: '#6b3424', capHex: '#2b1a12',
  lightColor: [1.0, 0.62, 0.30], intensity: 1.1,
};

// ------------------------------------------------------------------------------------------------------------------
// Geometry
// ------------------------------------------------------------------------------------------------------------------
/** paper barrel: 14-gon with slightly puffed faces, wrinkles near the caps. Attributes: position, normal, uv (m), aRib. */
function paperGeometry(THREE, seed) {
  const L = LANTERN, nR = L.ribs, perFace = 10, cols = nR * perFace, rows = 40;
  const rng = makeRng(hashString('lanternPaper:' + seed));
  // a few crease lines (paper folded when the lantern was collapsed): horizontal-ish ridges
  const creases = [];
  for (let k = 0; k < 9; k++) creases.push({ y: (rng() * 2 - 1) * 0.22, a: (rng() - 0.5) * 0.0024, w: 0.006 + 0.012 * rng(), ph: rng() * TAU, f: 1 + Math.floor(rng() * 3) });
  const pos = [], uv = [], rib = [], idx = [];
  const rOf = (y) => { const u = y / L.halfH; return L.radiusEnd + (L.radiusMid - L.radiusEnd) * Math.pow(Math.max(0, 1 - u * u), 0.55); };
  for (let j = 0; j <= rows; j++) {
    const v = j / rows, y = -L.halfH + 2 * L.halfH * v;
    const r0 = rOf(y);
    for (let i = 0; i <= cols; i++) {
      const phi = (i / cols) * TAU;
      const f = ((i % perFace) / perFace);          // 0 at a rib
      const d = (f - 0.5) * (TAU / nR);             // offset from the face centre
      const poly = Math.cos(Math.PI / nR) / Math.cos(d);
      let r = r0 * (0.3 + 0.7 * poly);
      // paper puckers near the caps (gathered), creases, small random waviness
      const endW = Math.exp(-Math.pow((L.halfH - Math.abs(y)) / 0.018, 2));
      r += endW * 0.0025 * Math.sin(phi * 37 + seed) * (0.5 + 0.5 * Math.sin(phi * 5.3));
      for (const c of creases) r += c.a * Math.exp(-Math.pow((y - c.y - 0.01 * Math.sin(phi * c.f + c.ph)) / c.w, 2));
      r += 0.0006 * Math.sin(phi * 23 + y * 61) * Math.sin(y * 41 + phi * 3);
      pos.push(Math.sin(phi) * r, y, Math.cos(phi) * r);
      uv.push(phi * L.radiusMid, y + L.halfH);
      rib.push(Math.min(f, 1 - f) * (TAU / nR) * r0);   // arc distance to the nearest rib (m)
    }
  }
  const C = cols + 1;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const a = j * C + i, b = a + 1, c = a + C, d = c + 1;
    idx.push(a, b, c, b, d, c);          // outward-facing (front = outside of the barrel)
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aRib', new THREE.Float32BufferAttribute(rib, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  // weld the seam normals
  const N = g.attributes.normal;
  for (let j = 0; j <= rows; j++) {
    const a = j * C, b = j * C + cols;
    const x = N.getX(a) + N.getX(b), y = N.getY(a) + N.getY(b), z = N.getZ(a) + N.getZ(b), l = Math.hypot(x, y, z) || 1;
    N.setXYZ(a, x / l, y / l, z / l); N.setXYZ(b, x / l, y / l, z / l);
  }
  g.computeBoundingSphere();
  return g;
}

/** turned wooden cap (top or bottom) with a knob/finial; returns merged geometry with metric UVs */
function capGeometry(top) {
  const L = LANTERN;
  const prof = G.lanternCapProfile({ radius: L.capR, height: L.capH, rim: 0.008, hole: 0.03 });
  const cap = G.lathe(prof, { segments: 48, edges: [0.55] });
  const parts = [cap];
  // knob / finial (a small turned bead + neck)
  const knob = [[0, 0], [0.024, 0.0], [0.026, 0.006], [0.02, 0.012], [0.016, 0.02], [0.02, 0.028], [0.018, 0.036], [0.01, 0.042], [0, 0.044]];
  const k = G.lathe(knob, { segments: 24, edges: [0.3, 0.7] });
  k.translate(0, L.capH * 0.98, 0);
  parts.push(k);
  const g = G.merge(parts);
  if (!top) g.rotateX(Math.PI);        // bottom cap: mirror (flip) — the rim faces the paper
  return g;
}

/** candle + iron pricket dish (inside the lantern, visible from below / when the camera peeks in) */
function candleGeometry() {
  const L = LANTERN;
  const dish = G.lathe([[0, 0], [0.04, 0.0], [0.042, 0.006], [0.036, 0.008], [0.006, 0.006], [0, 0.006]], { segments: 24 });
  dish.translate(0, -L.halfH + 0.004, 0);
  const candle = G.lathe([[0, 0], [0.0125, 0], [0.0128, 0.03], [0.0124, 0.058], [0.011, 0.066], [0.006, 0.0685], [0, 0.068]], { segments: 20, wobble: 0.03, seed: 3 });
  candle.translate(0, L.candleTop - 0.068, 0);
  return { dish, candle };
}

/** cord (twisted, 3 mm) from the knob to the hook + an iron hook ring. local coords (lantern centre = origin). */
function cordGeometry(len) {
  const top = LANTERN.halfH + LANTERN.capH + 0.044;
  const pts = [];
  for (let i = 0; i <= 12; i++) { const f = i / 12; pts.push(new THREE_NS.Vector3(0.0012 * Math.sin(f * 9), top + f * len, 0.0012 * Math.cos(f * 7))); }
  const cord = G.tubeAlongCurve(new THREE_NS.CatmullRomCurve3(pts), 0.0017, { tubular: 24, radial: 6 });
  // iron hook: a small ring at the top
  const ringPts = [];
  for (let i = 0; i <= 20; i++) { const a = (i / 20) * TAU * 0.85 - Math.PI / 2; ringPts.push(new THREE_NS.Vector3(0.012 * Math.cos(a), top + len + 0.012 + 0.012 * Math.sin(a), 0)); }
  const hook = G.tubeAlongCurve(new THREE_NS.CatmullRomCurve3(ringPts), 0.0022, { tubular: 24, radial: 6 });
  return { cord, hook };
}

/** tassel: knot bead + ~42 threads (thin flat ribbons), slightly splayed; hanging from the bottom finial */
function tasselGeometry(THREE, seed) {
  const rng = makeRng(hashString('tassel:' + seed));
  const top = -(LANTERN.halfH + LANTERN.capH + 0.044);
  const parts = [];
  const bead = G.lathe([[0, 0], [0.009, 0.002], [0.013, 0.012], [0.009, 0.022], [0.004, 0.026], [0, 0.026]], { segments: 16 });
  bead.translate(0, top - 0.03, 0);
  parts.push(bead);
  // knotted cord from the finial down through the bead to the collar
  const cordT = G.lathe([[0, 0], [0.0022, 0], [0.0024, 0.02], [0.0021, 0.045], [0, 0.045]], { segments: 8 });
  cordT.translate(0, top - 0.043, 0);
  parts.push(cordT);
  // wrapped collar
  const collar = G.lathe([[0, 0], [0.0085, 0], [0.009, 0.004], [0.0088, 0.018], [0.0075, 0.022], [0, 0.022]], { segments: 16 });
  collar.translate(0, top - 0.058, 0);
  parts.push(collar);
  const pos = [], uv = [], idx = [];
  const n = 42, len0 = 0.125;
  for (let k = 0; k < n; k++) {
    const a = rng() * TAU, r0 = 0.002 + 0.005 * Math.sqrt(rng());
    const len = len0 * (0.86 + 0.2 * rng());
    const spread = 0.004 + 0.012 * rng();
    const w = 0.0011;
    const base = pos.length / 3;
    const segs = 6;
    for (let s = 0; s <= segs; s++) {
      const f = s / segs;
      const rr = r0 + spread * f * f;
      const x = Math.cos(a) * rr + 0.002 * Math.sin(f * 5 + k), z = Math.sin(a) * rr, y = top - 0.058 - f * len;
      const tx = -Math.sin(a) * w, tz = Math.cos(a) * w;
      pos.push(x - tx, y, z - tz, x + tx, y, z + tz);
      uv.push(0, f * len, 0.002, f * len);
    }
    for (let s = 0; s < segs; s++) { const i0 = base + s * 2; idx.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3); }
  }
  const th = new THREE.BufferGeometry();
  th.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  th.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  th.setIndex(idx); th.computeVertexNormals();
  parts.push(th);
  return G.merge(parts);
}

// ------------------------------------------------------------------------------------------------------------------
// Paper shader
// ------------------------------------------------------------------------------------------------------------------
const PAPER_VS = /* glsl */ `
in float aRib;
out vec3 vLocal; out vec3 vLN; out vec2 vUv; out float vRib; out vec3 vW; out vec3 vWN;
void main(){
  vLocal = position; vLN = normal; vUv = uv; vRib = aRib;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz; vWN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const PAPER_FS = GLSL_NOISE + /* glsl */ `
precision highp float;
in vec3 vLocal; in vec3 vLN; in vec2 vUv; in float vRib; in vec3 vW; in vec3 vWN;
layout(location = 0) out vec4 fragColor;
uniform sampler2D uMap;          // paper albedo (sRGB -> linear by the sampler)
uniform sampler2D uOrm;          // a = thickness
uniform vec3 uFlame;             // flame centre (lantern-local)
uniform vec3 uFlameW;            // flame centre (world)
uniform float uI;                // flame intensity (cd) incl. glow & flicker
uniform vec3 uCol;               // light colour (linear)
uniform vec3 uTint;              // paper transmission tint
uniform float uTau;              // diffuse transmission
uniform float uHot;              // hot-spot peak (× uI / 1.1)
uniform vec3 uAmb;               // exterior ambient radiance (sky / fill)
uniform vec3 uMoonDir; uniform vec3 uMoonCol;
uniform float uRibW;             // rib half width (m)
uniform float uHalfH;
uniform float uEmber;            // 0..1: after the flame is out, a faint glowing wick (bottom centre)
void main(){
  vec3 N = normalize(vLN);
  vec3 Nw = normalize(vWN);
  vec3 V = normalize(cameraPosition - vW);
  bool front = gl_FrontFacing;                 // outer surface seen from outside
  // ---------- paper texture ----------
  vec3 alb = texture(uMap, vUv).rgb;
  float thick = texture(uOrm, vUv).a;
  float tau = uTau * exp(-1.6 * (thick - 0.45));
  // soot: the top inside is darkened by years of candle smoke (irregular, streaky)
  float y = vLocal.y / uHalfH;
  float soot = smoothstep(0.25, 0.95, y) * (0.55 + 0.45 * mvValue(vec2(vUv.x * 9.0, vUv.y * 3.0)));
  tau *= 1.0 - 0.55 * soot;
  // old water stains / oil blotches (low frequency)
  float stain = smoothstep(0.55, 0.8, mvValue(vUv * 7.3 + 3.1));
  tau *= 1.0 - 0.18 * stain;
  // ---------- direct irradiance from the flame ----------
  vec3 d = uFlame - vLocal; float r2 = dot(d, d); float r = sqrt(r2);
  float cosT = max(dot(-N, d / r), 0.0);
  float Ed = uI / (r2 + 0.0004) * cosT;
  // rib shadows (bamboo strips glued inside) + the rib itself: dark lines, soft penumbra from the flame size
  float ribD = vRib;
  float ribShadow = 1.0 - 0.92 * (1.0 - smoothstep(uRibW, uRibW + 0.0035, ribD));
  // paper overlap seam along each rib (double layer a little wider than the rib)
  float seam = 1.0 - 0.18 * (1.0 - smoothstep(uRibW + 0.003, uRibW + 0.007, ribD));
  // cap rims / hoops at the ends: paper glued over a bamboo hoop -> dark bands
  float hoop = 1.0 - 0.85 * smoothstep(uHalfH - 0.018, uHalfH - 0.006, abs(vLocal.y));
  // integrating-sphere cavity term (uniform) — scaled with the flame
  float Ec = uI * 11.5;
  float E = (Ed * ribShadow + Ec * mix(1.0, ribShadow, 0.6)) * seam * hoop;
  vec3 trans = uCol * uTint * tau * E / 3.14159;
  // ---------- direct view of the flame through the paper (blurred image) ----------
  vec3 hot = vec3(0.0);
  if (front) {
    vec3 toF = uFlameW - cameraPosition;
    float dF = length(toF);
    vec3 toP = vW - cameraPosition;
    float along = dot(toP, toF / dF);
    if (along < dF) {                              // this paper point is in front of the flame
      float perp = length(toP - toF / dF * along);  // metres from the line of sight to the flame (at the paper)
      float depth = dF - along;                     // paper -> flame distance: blur grows with it
      float s = 0.012 + 0.16 * depth;
      float core = exp(-perp * perp / (s * s));
      float halo = exp(-perp * perp / (s * s * 9.0));
      hot = uCol * vec3(1.0, 0.86, 0.66) * uHot * (uI / 1.1) * (core + 0.12 * halo) * ribShadow * hoop * (1.0 - 0.5 * soot);
    }
  }
  // inside surface seen through the openings (back faces): reflection of the flame, brighter than transmission
  vec3 inner = uCol * alb * 0.55 * (Ed * ribShadow + Ec) / 3.14159 * (1.0 - 0.7 * soot);
  // ---------- exterior lighting (when the lantern is dim / out) ----------
  vec3 ext = alb * (uAmb * (0.6 + 0.4 * Nw.y) + uMoonCol * max(dot(Nw, uMoonDir), 0.0) / 3.14159);
  // ember: the wick still glows faintly right after the flame dies (a small warm smudge low on the paper)
  float ember = uEmber * exp(-pow((vLocal.y + 0.19) / 0.07, 2.0));
  vec3 col = front ? (trans + hot + ext + uCol * vec3(1.0, 0.5, 0.2) * ember * 0.08) : (inner + ext * 0.5);
  fragColor = vec4(col, 1.0);
}`;

// ------------------------------------------------------------------------------------------------------------------
// Flame (seen only through the openings / from below) + glow billboard in the moist air (FX layer)
// ------------------------------------------------------------------------------------------------------------------
const FLAME_VS = /* glsl */ `
uniform vec3 uC; uniform vec2 uSize;
out vec2 vQ;
void main(){
  vec4 vc = viewMatrix * vec4(uC, 1.0);
  vQ = position.xy;
  gl_Position = projectionMatrix * vec4(vc.xy + position.xy * uSize, vc.z, 1.0);
}`;
const FLAME_FS = /* glsl */ `
precision highp float;
in vec2 vQ; layout(location = 0) out vec4 fragColor;
uniform float uI; uniform float uBend;
void main(){
  vec2 q = vQ; q.x -= uBend * (q.y + 1.0) * (q.y + 1.0) * 0.12;
  float y = q.y * 0.5 + 0.5;                                   // 0 bottom .. 1 top
  float w = 0.42 * sqrt(max(y, 0.0)) * (1.0 - y * 0.92);       // teardrop half width
  float inside = smoothstep(w, w * 0.55, abs(q.x)) * smoothstep(0.0, 0.08, y) * smoothstep(1.0, 0.85, y);
  float core = exp(-pow(q.x / max(w * 0.45, 1e-3), 2.0)) * smoothstep(0.1, 0.35, y) * smoothstep(0.85, 0.45, y);
  vec3 c = vec3(1.0, 0.55, 0.16) * inside * 18.0 + vec3(1.0, 0.86, 0.6) * core * 60.0;
  float blue = exp(-pow((y - 0.1) / 0.07, 2.0)) * smoothstep(w, 0.0, abs(q.x));
  c += vec3(0.1, 0.2, 1.0) * blue * 2.0;
  c *= uI / 1.1;
  float a = clamp(inside * 0.6, 0.0, 1.0);
  fragColor = vec4(c, 0.0);
}`;

const GLOW_VS = /* glsl */ `
uniform vec3 uC; uniform float uR;
out vec3 vW;
void main(){
  vec3 f = normalize(cameraPosition - uC);
  vec3 ax = normalize(cross(vec3(0.0, 1.0, 0.0), f)); vec3 ay = cross(f, ax);
  vec3 w = uC + (position.x * ax + position.y * ay) * uR;
  vW = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
// single scattering of a point light in a homogeneous medium, integrated along the whole view ray (closed form):
//   L = σ·I/(4π) · ∫ ds / (h² + s²) · p(θ) ≈ σ·I·p/(4π h) · (atan(s1/h) − atan(s0/h))
const GLOW_FS = /* glsl */ `
precision highp float;
in vec3 vW; layout(location = 0) out vec4 fragColor;
uniform vec3 uC; uniform float uI; uniform vec3 uCol; uniform float uSigma; uniform float uR; uniform float uG;
uniform vec4 uLensG;   // unused hook
void main(){
  vec3 ro = cameraPosition; vec3 rd = normalize(vW - ro);
  vec3 oc = uC - ro;
  float tc = dot(oc, rd);                  // closest approach along the ray
  float h = max(length(oc - rd * tc), 0.02);
  float s0 = -tc, s1 = uR * 3.0;           // from the camera to beyond the light
  float I1 = (atan(s1 / h) - atan(s0 / h)) / h;
  // HG phase toward the camera: stronger forward scattering when looking at the light
  float c = dot(normalize(uC - ro), rd);
  float g = uG, g2 = g * g;
  float ph = (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * clamp(c, -1.0, 1.0), 1.5) / (4.0 * 3.14159);
  float fade = 1.0 - smoothstep(0.55, 1.0, length(vW - uC) / uR);
  vec3 L = uCol * uI * uSigma * ph * I1 * fade;
  fragColor = vec4(L, 0.0);
}`;

/**
 * createLantern(ctx, opts)
 *   opts: materials (createMaterials lib), center [x,y,z] (paper centre, world), pivot [x,y,z] (hook, world), seed,
 *         hotSpot (peak radiance at glow 1, default 30), tau (paper diffuse transmission, default 0.3),
 *         glow: { sigma (1/m scattering of the moist air, default 0.05), radius (m, default 2.2), g (0.55) } | false
 */
export function createLantern(ctx, opts = {}) {
  const THREE = ctx.THREE || THREE_NS;
  const M = opts.materials;
  const seed = opts.seed ?? 1;
  const center = new THREE.Vector3().fromArray(opts.center || [0, 1.5, 0]);
  const pivot = new THREE.Vector3().fromArray(opts.pivot || [center.x, center.y + .45, center.z]);
  const L = LANTERN;
  // hierarchy: root (at pivot, swings) -> body (lantern centre)
  const root = new THREE.Group(); root.name = 'lantern'; root.position.copy(pivot);
  const body = new THREE.Group(); body.position.set(0, center.y - pivot.y, 0); root.add(body);

  // --- paper ---
  const paperTex = M.textures('paper', { variant: 'lantern', seed: 2 });
  const paperU = {
    uMap: { value: paperTex.map }, uOrm: { value: paperTex.ormMap },
    uFlame: { value: new THREE.Vector3(0, L.flameY, 0) }, uFlameW: { value: new THREE.Vector3() },
    uI: { value: L.intensity }, uCol: { value: new THREE.Vector3(...L.lightColor) },
    uTint: { value: new THREE.Vector3(1.0, 0.66, 0.36) }, uTau: { value: opts.tau ?? 0.15 }, uHot: { value: opts.hotSpot ?? 30 },
    uAmb: { value: new THREE.Vector3(0.004, 0.005, 0.007) }, uMoonDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonCol: { value: new THREE.Vector3() },
    uRibW: { value: 0.0021 }, uHalfH: { value: L.halfH }, uEmber: { value: 0 },
  };
  const paperMat = new THREE.ShaderMaterial({ name: 'lanternPaper', glslVersion: THREE.GLSL3, uniforms: paperU, vertexShader: PAPER_VS, fragmentShader: PAPER_FS, side: THREE.DoubleSide });
  const paper = new THREE.Mesh(paperGeometry(THREE, seed), paperMat); paper.name = 'lantern.paper';
  body.add(paper);

  // --- caps, knob, candle, cord, hook, tassel (MV materials: they catch the flame light + moon) ---
  const capMat = M.wood({ variant: 'rosewood', seed: 7, objSeed: 31, edgeWear: 0.7, color: new THREE.Color().setRGB(0.55, 0.45, 0.4) });
  const topCap = new THREE.Mesh(capGeometry(true), capMat); topCap.position.y = L.halfH - 0.004; topCap.name = 'lantern.capTop';
  const botCap = new THREE.Mesh(capGeometry(false), capMat); botCap.position.y = -L.halfH + 0.004; botCap.name = 'lantern.capBottom';
  body.add(topCap, botCap);
  const cd = candleGeometry();
  const ironMat = M.iron({ seed: 3, objSeed: 32 });
  const dish = new THREE.Mesh(cd.dish, ironMat); body.add(dish);
  const waxMat = M.porcelain({ seed: 9, objSeed: 33, color: new THREE.Color().setRGB(0.95, 0.9, 0.8), roughness: 3.5 });
  const candle = new THREE.Mesh(cd.candle, waxMat); body.add(candle);
  const cordLen = Math.max(0.02, pivot.y - (center.y + L.halfH + L.capH + 0.044) - 0.024);
  const cg = cordGeometry(cordLen);
  const cordMat = M.linen({ seed: 4, objSeed: 34, color: new THREE.Color().setRGB(0.32, 0.2, 0.14), translucency: 0.05 });
  const cord = new THREE.Mesh(cg.cord, cordMat); body.add(cord);
  const hook = new THREE.Mesh(cg.hook, ironMat); body.add(hook);
  const tasselMat = M.linen({ seed: 5, objSeed: 35, color: new THREE.Color().setRGB(...hexLin(L.tasselHex)).multiplyScalar(0.9), translucency: 0.15 });
  const tasselPivot = new THREE.Group(); tasselPivot.position.y = -(L.halfH + L.capH + 0.044); body.add(tasselPivot);
  const tasselGeo = tasselGeometry(THREE, seed); tasselGeo.translate(0, L.halfH + L.capH + 0.044, 0);
  const tassel = new THREE.Mesh(tasselGeo, tasselMat); tasselPivot.add(tassel);
  for (const m of [topCap, botCap, dish, candle, cord, hook, tassel]) { m.castShadow = false; m.receiveShadow = true; }

  // --- flame sprite (inside; visible through the bottom opening / at the end of a push-in) on the FX layer ---
  const flameU = { uC: { value: new THREE.Vector3() }, uSize: { value: new THREE.Vector2(0.006, 0.022) }, uI: { value: 1.1 }, uBend: { value: 0 } };
  const flame = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    name: 'lanternFlame', glslVersion: THREE.GLSL3, uniforms: flameU, vertexShader: FLAME_VS, fragmentShader: FLAME_FS,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  }));
  flame.frustumCulled = false; flame.renderOrder = 20; flame.name = 'lantern.flame';

  // --- light: the flame's point light (LIB_COMMON: 1.1 cd × practicalLight, (1,.62,.30), decay 2) ---
  const light = new THREE.PointLight(new THREE.Color().setRGB(...L.lightColor), L.intensity, 0, 2);
  light.name = 'lanternLight'; light.userData.radius = 0.2;   // for particles.js (soft 1/r² near the paper)

  // --- glow in the moist air around the lantern (FX layer, additive, alpha 0) ---
  const gopt = opts.glow === false ? null : { sigma: 0.05, radius: 2.2, g: 0.55, ...(opts.glow || {}) };
  let glow = null, glowU = null;
  if (gopt) {
    glowU = { uC: { value: new THREE.Vector3() }, uI: { value: 1.1 }, uCol: { value: new THREE.Vector3(...L.lightColor) }, uSigma: { value: gopt.sigma }, uR: { value: gopt.radius }, uG: { value: gopt.g }, uLensG: { value: new THREE.Vector4() } };
    glow = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      name: 'practicalLight', glslVersion: THREE.GLSL3, uniforms: glowU, vertexShader: GLOW_VS, fragmentShader: GLOW_FS,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    }));
    glow.frustumCulled = false; glow.renderOrder = 19; glow.name = 'lantern.glow';
  }
  const fxLayer = Number.isInteger(ctx.fxLayer) ? ctx.fxLayer : null;
  if (fxLayer !== null) { flame.layers.set(fxLayer); if (glow) glow.layers.set(fxLayer); }

  const _v = new THREE.Vector3();
  const api = {
    object: root, body, paper, light, flame, glow, materials: [paperMat, capMat, ironMat, waxMat, cordMat, tasselMat],
    uniforms: paperU,
    /** world position of the flame (after update) */
    flameWorld(target = new THREE.Vector3()) { return target.copy(light.position); },
    /**
     * per frame. s = { glow (0..1 world.practicalLight × shot gain), flicker (multiplier ~1±0.12), swayX, swayZ (rad: rotation
     * about x / z of the pendulum), tasselSway (rad), flameBend (-1..1), flameJitter [dx,dy,dz] (m, local),
     * env: { ambient:[r,g,b], moonDir:[x,y,z], moonCol:[r,g,b] }, ember (0..1), glowGain }
     */
    update(t, s = {}) {
      const g = Math.max(0, s.glow ?? 1), fl = s.flicker ?? 1;
      const I = L.intensity * g * fl;
      root.rotation.set(s.swayX ?? 0, 0, s.swayZ ?? 0);
      tasselPivot.rotation.set((s.tasselSway ?? 0) * 0.8, 0, (s.tasselSway ?? 0) * 0.6);
      const j = s.flameJitter || [0, 0, 0];
      paperU.uFlame.value.set(j[0], L.flameY + j[1], j[2]);
      root.updateMatrixWorld(true);
      _v.set(j[0], L.flameY + j[1], j[2]).applyMatrix4(body.matrixWorld);
      paperU.uFlameW.value.copy(_v);
      paperU.uI.value = I;
      paperU.uEmber.value = s.ember ?? 0;
      light.position.copy(_v);
      light.intensity = I * (s.lightGain ?? 1);
      light.visible = I > 1e-4;
      flameU.uC.value.copy(_v); flameU.uI.value = I; flameU.uBend.value = s.flameBend ?? 0;
      const fs = Math.sqrt(Math.max(g, 0.02));
      flameU.uSize.value.set(0.0065 * fs, 0.024 * fs * (0.9 + 0.1 * fl));
      flame.visible = I > 0.002;
      if (glow) {
        _v.set(0, 0, 0).applyMatrix4(body.matrixWorld);
        glowU.uC.value.lerpVectors(_v, light.position, 0.6);
        glowU.uI.value = I * (s.glowGain ?? 1);
        glow.visible = I * (s.glowGain ?? 1) > 1e-3;
      }
      const e = s.env || {};
      if (e.ambient) paperU.uAmb.value.set(...e.ambient);
      if (e.moonDir) paperU.uMoonDir.value.set(...e.moonDir).normalize();
      if (e.moonCol) paperU.uMoonCol.value.set(...e.moonCol);
    },
    dispose() {
      paper.geometry.dispose(); paperMat.dispose(); topCap.geometry.dispose(); botCap.geometry.dispose();
      dish.geometry.dispose(); candle.geometry.dispose(); cord.geometry.dispose(); hook.geometry.dispose(); tassel.geometry.dispose();
      flame.geometry.dispose(); flame.material.dispose(); if (glow) { glow.geometry.dispose(); glow.material.dispose(); }
    },
  };
  return api;
}
