// Author: suwubee
// props/plumBranch.js — the film's key flower: white plum blossom (白梅, Prunus mume) on angular dark twigs.
//
//   import { createPlumBranch, createPlumTree } from './plumBranch.js';
//   const br = createPlumBranch(ctx, { seed: 'vase', length: 0.6, twigs: 6, bloom: 'world', lod: 'mid',
//                                      anchor: { pos: [x, y, z], dir: [0, 1, 0], roll: 0 } });
//   scene.add(br.object);
//   // every frame (after the camera is placed; t = FILM time, world = world.at(t)):
//   br.update(t, world, camera, { swayTime });          // swayTime (optional): time-warped clock for the wind (hush)
//   br.flowers  -> [{ pos:[x,y,z] (world, at creation), axis, openAt, threshold, size, index }]
//
//   const tree = createPlumTree(ctx, { seed: 'courtyard', height: 5, lod: 'far', anchor: { pos: [-66, 1.6, -5.5] },
//                                      detail: { center: [x, y, z], radius: 2.5 } });   // flowers near `center` -> 'mid'
//
// Design (docs/SET_CORRIDOR.md §plumBranch):
//   * ALL geometry is merged at start-up (wood tubes, petals, sepals/receptacles, stamens, far-LOD cards): ≤ 6 draws.
//   * Every flower's state lives in a small float DataTexture (centre, axis, scale, openAt, threshold, sway weights);
//     petals/stamens/sepals are posed IN THE VERTEX SHADER as a pure function of (t, world):
//       open(t) = damped spring (ζ 0.62, ω 8.5 → ~0.55 s to the peak, ≈8 % overshoot, settles by ~1 s)
//                 starting at openAt (explicit openTimes, or the time world.bloomAmount crosses the flower's threshold)
//     bud → petals unfold on hinges (tilt 0.1 → 1.28 rad), shrink-wrapped cup → shallow cup, stamens splay and extend,
//     sepals reflex; wind sway = hierarchical displacement field (branch / twig / flower flutter, multi-frequency).
//   * Materials: MeshPhysical from engine/materials.js (bark with lichen, petal with translucency & sheen) + small
//     MeshStandard materials for stamens / calyx, all receiving the Set's three.js lights & shadows; a vertex patch is
//     added to the library's onBeforeCompile (the MV look is kept). Shadow casters get matching depth materials.
//   * Deterministic: seeded rng (engine/noise.js makeRng), no Math.random, no state across frames.
import * as THREE_NS from '../engine/vendor/three.module.js';
import { makeRng, hashString, gnoise1, GLSL_HASH } from '../engine/noise.js';
import { createMaterials } from '../engine/materials.js';
import {defaultEnvironment as DEFAULT_WORLD} from '../engine/world/environment.js';

const TAU = Math.PI * 2;
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };
const mix = (a, b, t) => a + (b - a) * t;
// --- tiny vec3 helpers on arrays ---
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function rotAround(v, ax, ang) {          // Rodrigues
  const c = Math.cos(ang), s = Math.sin(ang), k = norm(ax), d = dot(k, v), cr = cross(k, v);
  return [v[0] * c + cr[0] * s + k[0] * d * (1 - c), v[1] * c + cr[1] * s + k[1] * d * (1 - c), v[2] * c + cr[2] * s + k[2] * d * (1 - c)];
}
function basisOf(d) {                      // two unit vectors perpendicular to d
  const ref = Math.abs(d[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
  const b1 = norm(cross(ref, d)), b2 = cross(d, b1);
  return [b1, b2];
}
const perpAt = (d, az) => { const [b1, b2] = basisOf(d); return norm(add(mul(b1, Math.cos(az)), mul(b2, Math.sin(az)))); };
const srgb2lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const hexLin = (h) => { const v = parseInt(h.replace('#', ''), 16); return [srgb2lin(((v >> 16) & 255) / 255), srgb2lin(((v >> 8) & 255) / 255), srgb2lin((v & 255) / 255)]; };


const COL = {
  filament: hexLin('#f1e9d6'), anther: hexLin('#e3b23c'), antherTip: hexLin('#c9892a'), pistil: hexLin('#b7c46a'), stigma: hexLin('#d8d98a'),
  sepal: hexLin('#7a3d3a'), sepalIn: hexLin('#8a5a3c'), recept: hexLin('#6a3431'), pedicel: hexLin('#4f3b2a'),
};

// LOD tables
const LOD = {
  macro: { pr: 8, ps: 34, sr: 3, ss: 14, nSt: 28, fil: [6, 5], anth: [9, 6], woodRad: 18, ringStep: 0.003, recept: 14 },
  mid: { pr: 2, ps: 7, sr: 0, ss: 0, nSt: 6, fil: null, anth: [2, 1], woodRad: 7, ringStep: 0.02, recept: 4, noPedicel: true, noSepals: true },
  far: { pr: 2, ps: 8, sr: 1, ss: 5, nSt: 0, fil: null, anth: [3, 2], woodRad: 5, ringStep: 0.06, recept: 5, noPedicel: true },
};

// =====================================================================================================================
// GLSL — the per-flower dynamic state (centre incl. wind sway, fluttered axis/frame, open state) is computed ONCE per
// flower per frame on the CPU (update) into a small float texture; the vertex shaders only pose the parts.
// The wood reads per-tube sway vectors (branch level + twig level) from a second texture: flowers and wood always agree.
// =====================================================================================================================
const PLUM_PARS = GLSL_HASH + /* glsl */ `
#ifndef PLUM_PARS_GLSL
#define PLUM_PARS_GLSL
uniform highp sampler2D uPlumDyn;    // 3 texels per flower (256 per row): (C, open) (A, flutter) (E1, size)
uniform highp sampler2D uPlumSwT;    // 2 texels per tube (512 per row): S_branch, S_twig (object space, metres)
uniform vec4 uPlumT;                 // x film time, y sway time (x freq), z, w
uniform vec3 uPlumKey;               // direction to the key light (sun, else moon) in object space
struct PlumF { vec3 c; float o; vec3 a; float fl; vec3 e1; float sc; float r1; float r2; };
PlumF plumFetch(float fi) {
  int i = int(fi + 0.5);
  ivec2 b = ivec2((i - (i / 256) * 256) * 3, i / 256);
  vec4 t0 = texelFetch(uPlumDyn, b, 0), t1 = texelFetch(uPlumDyn, b + ivec2(1, 0), 0), t2 = texelFetch(uPlumDyn, b + ivec2(2, 0), 0);
  PlumF f; f.c = t0.xyz; f.o = t0.w; f.a = t1.xyz; f.fl = t1.w; f.e1 = t2.xyz; f.sc = t2.w;
  f.r1 = mvHash21(vec2(fi,17.0)); f.r2 = mvHash21(vec2(fi,31.0));
  return f;
}
vec3 plumSwayW(vec4 sw) {            // sw = (w_branch, w_twig, tube, 0)
  int i = int(sw.z + 0.5);
  ivec2 b = ivec2((i - (i / 512) * 512) * 2, i / 512);
  return texelFetch(uPlumSwT, b, 0).xyz * sw.x + texelFetch(uPlumSwT, b + ivec2(1, 0), 0).xyz * sw.y;
}
#endif
`;

// petals + sepals + static calyx parts. position = (xn, yn, zn) normalised petal coords (static: flower-local metres)
// aPetA = (flowerIdx, yaw, tiltJitter, part: 0 petal | 1 sepal | 2 static), aPetB = (L, W, cupJitter, curlJitter)
const PLUM_PETAL_V = /* glsl */ `
attribute vec4 aPetA;
attribute vec4 aPetB;
varying vec4 vPlum;          // x open, y part, z r1
void plumVertex(out vec3 P, out vec3 N) {
  PlumF f = plumFetch(aPetA.x);
  float o = f.o;
  float oc = clamp(o, 0.0, 1.0);
  float part = aPetA.w;
  vec3 A = f.a, E1 = f.e1, E2 = cross(A, E1);
  vec3 base = f.c;
  vPlum = vec4(o, part, f.r1, 0.0);
  if (part > 1.5) {            // receptacle / pedicel: rigid in the flower frame
    P = base + (position.x * E1 + position.y * A + position.z * E2) * f.sc;
    N = normalize(normal.x * E1 + normal.y * A + normal.z * E2);
    return;
  }
  // arc model: the petal's mid-line leaves the hinge along lv (tilt from the axis) and bends toward its inner face m
  // with curvature kap (arc angle kap*L): bud = near-semicircle (petals close into a ball), open = gently upturned.
  float sc, tilt, cup, arc, hr, hy;
  if (part < 0.5) {
    sc = mix(0.62, 1.0, smoothstep(0.0, 0.85, oc));
    arc = mix(3.55, 0.30, o) + aPetB.w * oc;                 // o > 1 (overshoot) -> flatter, then settles
    tilt = mix(1.62, 1.20, o) + aPetA.z * oc;
    cup = mix(0.85, 0.30, oc) + aPetB.z;
    hr = mix(0.00022, 0.0011, oc); hy = 0.0008;
    // imbricate: petals are stacked a little (no coplanar overlaps / z-fighting between neighbours)
    float ord = fract(aPetA.y * 0.159155 + 10.0);
    hy += ord * 0.0003 * oc; tilt -= ord * 0.03 * oc;
    // in the bud the petals nest inside each other (outer ones a little larger / further out): no coincident shells
    sc *= 1.0 + 0.07 * ord * (1.0 - oc); hr += ord * 0.0003 * (1.0 - oc);
    tilt += 0.6 * f.fl * oc * sin(uPlumT.y * 9.0 + aPetA.y * 3.0 + f.r2 * 20.0);
  } else {
    sc = mix(0.85, 1.0, oc);
    arc = mix(0.9, -0.45, oc);
    tilt = mix(1.02, 1.95, o) + aPetA.z;
    cup = 0.5 + aPetB.z;
    hr = 0.0013; hy = -0.0010;
  }
  float L = aPetB.x * f.sc * sc, W = aPetB.y * f.sc * sc;
  float kap = arc / max(L, 1e-5);
  float yaw = aPetA.y;
  vec3 R = E1 * sin(yaw) + E2 * cos(yaw);
  vec3 lv = cos(tilt) * A + sin(tilt) * R;
  vec3 m = -cos(tilt) * R + sin(tilt) * A;
  vec3 T = cross(lv, m);
  if (part < 0.5) {                        // pinwheel roll about the petal axis: each edge over one neighbour, under the other
    float rho = 0.2 * smoothstep(0.15, 0.9, oc);
    vec3 T2 = T * cos(rho) + m * sin(rho), m2 = m * cos(rho) - T * sin(rho);
    T = T2; m = m2;
  }
  float y = position.y * L;
  float ky = kap * y, sk = sin(ky), ck = cos(ky);
  float fy = abs(kap) > 1e-3 ? sk / kap : y;
  float gy = abs(kap) > 1e-3 ? (1.0 - ck) / kap : 0.5 * kap * y * y;
  vec3 Ni = -sk * lv + ck * m;           // inner normal at y
  float xn = position.x * 2.0;
  float zc = cup * L * 0.45 * xn * xn + position.z * L;
  float dzdx = cup * L * 1.8 * xn / max(W, 1e-6);
  P = base + (R * hr + A * hy) * f.sc + fy * lv + gy * m + (position.x * W) * T + zc * Ni;
  N = normalize(Ni - dzdx * T);
}
`;

// stamens + pistil. position = local offset (ring / anther ellipsoid) in the stamen frame (T, d, m), metres
// aSt = (flowerIdx, yaw, baseRadius, kind: 0 filament | 1 anther | 2 pistil | 3 stigma), aSt2 = (length, spreadJit, curve, s)
const PLUM_STAMEN_V = /* glsl */ `
attribute vec4 aSt;
attribute vec4 aSt2;
varying vec4 vPlum;
void plumVertex(out vec3 P, out vec3 N) {
  PlumF f = plumFetch(aSt.x);
  float o = f.o;
  float oc = clamp(o, 0.0, 1.1);
  vec3 A = f.a, E1 = f.e1, E2 = cross(A, E1);
  vec3 R = E1 * sin(aSt.y) + E2 * cos(aSt.y);
  bool pist = aSt.w > 1.5;
  float spread = pist ? 0.04 + aSt2.y : mix(0.04, 0.66, smoothstep(0.05, 1.0, o)) * (0.7 + aSt2.y) + 0.06 * (oc - clamp(o, 0.0, 1.0));
  float grow = pist ? mix(0.28, 1.0, smoothstep(0.05, 0.8, oc)) : mix(0.2, 1.0, smoothstep(0.1, 0.9, o));
  float Ls = aSt2.x * f.sc * grow;
  vec3 d = cos(spread) * A + sin(spread) * R;
  vec3 m = -cos(spread) * R + sin(spread) * A;
  vec3 T = cross(d, m);
  float s = aSt2.w;
  vec3 base = f.c + (R * aSt.z + A * 0.0007) * f.sc;
  vec3 axisP = base + d * (s * Ls) + m * (aSt2.z * Ls * s * s * 0.35);
  P = axisP + (position.x * T + position.y * d + position.z * m) * f.sc;
  N = normalize(normal.x * T + normal.y * d + normal.z * m);
  vPlum = vec4(o, 3.0 + aSt.w, f.r1, 0.0);
}
`;

// wood: position/normal in object space, aSw = (w_branch, w_twig, tube, 0)
const PLUM_WOOD_V = /* glsl */ `
attribute vec4 aSw;
varying vec4 vPlum;
void plumVertex(out vec3 P, out vec3 N) {
  P = position + plumSwayW(aSw);
  N = normal;
  vPlum = vec4(1.0, 9.0, 0.0, 0.0);
}
`;

// far LOD: one camera-facing card per flower (atlas: open | bud), aCard = (flowerIdx, cx, cy, 0)
const PLUM_CARD_V = /* glsl */ `
attribute vec4 aCard;
varying vec4 vPlum;
varying vec2 vCardUv;
vec3 plumCardCentre; float plumCardSize; vec3 plumCardAxis; float plumCardStage;
void plumVertex(out vec3 P, out vec3 N) {
  PlumF f = plumFetch(aCard.x);
  float o = f.o;
  P = f.c;
  plumCardCentre = P;
  plumCardAxis = f.a;
  plumCardSize = 0.024 * f.sc * (o < 0.3 ? 0.42 : o < 0.72 ? 0.72 : 1.0);
#ifndef PLUM_DEPTH
  if (aCard.w > 0.5) plumCardSize = 0.0;
#else
  plumCardSize *= 0.8;
#endif
  N = normalize(f.a * 0.35 + uPlumKey * 0.65);
  plumCardStage = o < 0.3 ? 3.0 : o < 0.72 ? 2.0 : 0.0;
  vCardUv = vec2(aCard.y * 0.5 + 0.5, aCard.z * 0.5 + 0.5);
  vPlum = vec4(o, 7.0, f.r1, 0.0);
}
`;

// fragment tint (petal bud blush, per-flower brightness jitter) — injected before the roughness block
const PLUM_FRAG_PARS = /* glsl */ `
varying vec4 vPlum;
uniform vec3 uPlumBud;       // bud blush multiplier
`;
const PLUM_FRAG_TINT = /* glsl */ `
#ifdef PLUM_PETAL
  if (vPlum.y < 0.5) {
    float bl = 1.0 - smoothstep(0.12, 0.85, vPlum.x);
    diffuseColor.rgb *= mix(vec3(1.0), uPlumBud, bl);
    diffuseColor.rgb *= 0.95 + 0.08 * vPlum.z;
  }
#endif
`;

// ---------------------------------------------------------------------------------------------------------------------
// shader patching (on top of the materials.js MV patch when present)
// ---------------------------------------------------------------------------------------------------------------------
function injectVertex(vs, body, depth) {
  const pars = PLUM_PARS + body;
  if (!vs.includes('#include <common>')) throw new Error('plumBranch: vertex shader has no <common>');
  vs = vs.replace('#include <common>', '#include <common>\n' + pars);
  if (!depth && vs.includes('#include <beginnormal_vertex>')) {
    vs = vs.replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vec3 plP, plN; plumVertex(plP, plN); objectNormal = plN;');
    vs = vs.replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed = plP;');
  } else {
    vs = vs.replace('#include <begin_vertex>', '#include <begin_vertex>\n  { vec3 plP, plN; plumVertex(plP, plN); transformed = plP; }');
  }
  return vs;
}
function patchMaterial(mat, U, body, key, { depth = false, card = false, tint = false } = {}) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    if (prev && prev !== THREE_NS.Material.prototype.onBeforeCompile) prev.call(this, shader, renderer);
    for (const k of Object.keys(U)) shader.uniforms[k] = U[k];
    let vs = injectVertex(shader.vertexShader, body, depth);
    if (card) {
      // billboard: replace the projection of the card corner (view-space offset around the flower centre)
      vs = vs.replace('#include <project_vertex>', `#include <project_vertex>
  { vec4 mvC = modelViewMatrix * vec4(plumCardCentre, 1.0);
    vec3 av = normalize(mat3(modelViewMatrix) * plumCardAxis);
    // screen-space frame: y along the projected flower axis (the 3/4 tile is squashed along it)
    vec2 pa = av.xy; float pl = length(pa);
    vec2 cy = pl > 1e-3 ? pa / pl : vec2(0.0, 1.0), cx = vec2(cy.y, -cy.x);
    float stage = plumCardStage;
    if (stage < 0.5 && abs(av.z) < 0.62) stage = 1.0;                  // open flower seen obliquely
    if (stage > 2.5) { cy = vec2(0.0, 1.0); cx = vec2(1.0, 0.0); }      // buds hang in the calyx: keep upright
    vec2 q = (cx * aCard.y + cy * aCard.z) * plumCardSize * 0.5;
    mvC.xy += q;
    mvPosition = mvC; gl_Position = projectionMatrix * mvC;
#ifdef USE_MAP
    vMapUv = vec2((vCardUv.x + stage) * 0.25, vCardUv.y);
#endif
  }`);
    }
    if (depth) vs = '#define PLUM_DEPTH\n' + vs;
    shader.vertexShader = vs;
    if (!depth) {
      let fs = shader.fragmentShader;
      fs = fs.replace('#include <common>', '#include <common>\n' + PLUM_FRAG_PARS);
      if (tint) {
        const needle = 'float roughnessFactor = roughness;';
        if (fs.includes(needle)) fs = fs.replace(needle, PLUM_FRAG_TINT + '\n' + needle);
        else fs = fs.replace('#include <roughnessmap_fragment>', PLUM_FRAG_TINT + '\n#include <roughnessmap_fragment>');
      }
      shader.fragmentShader = fs;
    }
  };
  const baseKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : () => '';
  mat.customProgramCacheKey = () => baseKey() + '|plum:' + key;
  mat.needsUpdate = true;
  return mat;
}

// =====================================================================================================================
// Skeleton generation (JS, deterministic)
// =====================================================================================================================
/** polyline zig-zag: from p0 along d0, nSeg segments of total length L; bend angle range, trend blend toward d0 */
let _avoid = null;     // optional growth constraint (set by treeSkeleton for the duration of a build)
function zigzag(rng, p0, d0, L, nSeg, bendMin, bendMax, trend = 0.18, trendDir = null) {
  const pts = [p0.slice()], dirs = [];
  let d = norm(d0), p = p0.slice(), az = rng() * TAU;
  const target = trendDir ? norm(trendDir) : norm(d0);
  const lens = []; let tot = 0;
  for (let i = 0; i < nSeg; i++) { const l = 0.7 + 0.6 * rng(); lens.push(l); tot += l; }
  for (let i = 0; i < nSeg; i++) {
    if (i > 0) {
      az += Math.PI + (rng() - 0.5) * 1.3;               // alternate sides: the 'zig-zag' of plum wood
      d = norm(rotAround(d, perpAt(d, az), mix(bendMin, bendMax, rng())));
      d = norm(lerp3(d, target, trend));
    }
    const sl = (L * lens[i]) / tot;
    if (_avoid) d = _avoid(p, d, sl);
    p = add(p, mul(d, sl));
    pts.push(p.slice()); dirs.push(d.slice());
  }
  return { pts, dirs };
}
/** growth constraint in LOCAL coordinates from world-space limits {eaveX, eaveY, maxX} and the anchor offset */
function makeAvoid(av, origin) {
  if (!av) return null;
  const ox = origin[0], oy = origin[1];
  const ex = av.eaveX - ox, ey = av.eaveY - oy, mx = (av.maxX ?? 1e9) - ox;
  return (p, d, sl) => {
    for (let it = 0; it < 3; it++) {
      const q = add(p, mul(d, sl));
      let bad = false;
      if (q[0] > mx) { d = norm([Math.min(d[0], -0.05), d[1] - 0.1, d[2]]); bad = true; }
      if (q[0] > ex && q[1] > ey - 0.25 * Math.max(0, q[0] - ex)) { d = norm([d[0] - 0.25, Math.min(d[1], -0.2), d[2]]); bad = true; }
      if (!bad) break;
    }
    return d;
  };
}
/** point + direction at arc-length fraction s along a polyline */
function along(pl, s) {
  const P = pl.pts; let tot = 0; const cum = [0];
  for (let i = 1; i < P.length; i++) { tot += len(sub(P[i], P[i - 1])); cum.push(tot); }
  const x = clamp(s) * tot;
  let i = 1; while (i < P.length - 1 && cum[i] < x) i++;
  const f = (x - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
  return { p: lerp3(P[i - 1], P[i], f), d: norm(sub(P[i], P[i - 1])), total: tot, seg: i - 1 };
}

/**
 * Plum branch skeleton (vase / macro / hanging branch). Local frame: base at origin, growing along +y.
 * Returns { tubes:[{pts, radii, sw:[[w0,w1]...], ph:[p0,p1], kind}], spots:[flower spots] }
 */
function branchSkeleton(rng, o) {
  const L = o.length, tubes = [], spots = [];
  const r0 = o.radius ?? (0.0026 + 0.0042 * L / 0.6);
  const nMain = Math.round(clamp(L / 0.085, 4, 10));
  const main = zigzag(rng, [0, 0, 0], [0, 1, 0], L, nMain, 0.22, 0.52, 0.16);
  const ph0 = rng();
  const mainR = (s) => r0 * (1 - 0.62 * s) * (1 + 0.05 * Math.sin(s * 37));
  tubes.push({ pl: main, rad: mainR, w: (s) => [s * s, 0], ph: [ph0, rng()], kind: 0, tip: true });
  const nT = o.twigs;
  const fr = [];
  for (let j = 0; j < nT; j++) fr.push(0.16 + 0.78 * (j + 0.2 + 0.6 * rng()) / nT);
  let azT = rng() * TAU;
  for (let j = 0; j < nT; j++) {
    const s = fr[j];
    const at = along(main, s);
    azT += 2.4 + (rng() - 0.5) * 0.7;
    const ang = 0.45 + 0.45 * rng();
    let d = norm(rotAround(at.d, perpAt(at.d, azT), ang));
    const Lt = L * (0.24 + 0.26 * rng()) * (1 - 0.4 * s) * (o.twigScale ?? 1);
    const nS = 2 + Math.floor(rng() * 3);
    const trendDir = norm(add(d, [0, 0.35, 0]));
    const tw = zigzag(rng, at.p, d, Lt, nS, 0.06, 0.3, 0.3, trendDir);
    const rA = mainR(s) * 0.5, ph1 = rng();
    const w0a = s * s;
    tubes.push({ pl: tw, rad: (u) => Math.max(0.00065, rA * (1 - 0.72 * u)), w: (u) => [w0a, Math.pow(u, 1.4) * Lt / 0.25], ph: [ph0, ph1], kind: 1, tip: true });
    // flowers along the twig (nodes every 1.2–2.4 cm, alternate phyllotaxis, 1–2 per node) + a bud at the tip
    let u = 0.012 + 0.01 * rng();
    let azF = rng() * TAU;
    while (u < Lt - 0.008) {
      const q = along(tw, u / Lt);
      azF += 2.5 + (rng() - 0.5) * 0.6;
      const nf = rng() < 0.32 ? 2 : 1;
      for (let k = 0; k < nf; k++) {
        const az = azF + (k ? 0.9 + rng() * 0.6 : 0);
        const out = perpAt(q.d, az);
        const axis = norm(add(add(mul(out, 0.85), mul(q.d, 0.42)), [0, 0.22, 0]));
        spots.push({ p: q.p, out, axis, r: Math.max(0.00065, rA * (1 - 0.72 * (u / Lt))), w: [w0a, Math.pow(u / Lt, 1.4) * Lt / 0.25], ph: [ph0, ph1], frac: u / Lt, twig: j, tip: false, tube: tubes.length - 1 });
      }
      u += 0.012 + 0.012 * rng();
    }
    const qe = along(tw, 1);
    spots.push({ p: qe.p, out: qe.d, axis: norm(add(qe.d, [0, 0.1, 0])), r: 0.0007, w: [w0a, Lt / 0.25], ph: [ph0, ph1], frac: 1, twig: j, tip: true, onTip: true, tube: tubes.length - 1 });
  }
  // short spurs on the main branch with clusters of 2–4 flowers
  const nSp = Math.max(2, Math.round(nT * (o.spurs ?? 0.8)));
  let azS = rng() * TAU;
  for (let j = 0; j < nSp; j++) {
    const s = 0.1 + 0.85 * rng();
    const at = along(main, s);
    azS += 2.2 + rng();
    const d = norm(rotAround(at.d, perpAt(at.d, azS), 1.0 + 0.5 * rng()));
    const Ls = 0.008 + 0.018 * rng();
    const sp = zigzag(rng, at.p, d, Ls, 1, 0, 0);
    const rA = mainR(s) * 0.55;
    const w0a = s * s;
    tubes.push({ pl: sp, rad: (u) => Math.max(0.0008, rA * (1 - 0.35 * u)), w: () => [w0a, 0.02], ph: [ph0, rng()], kind: 2, tip: true });
    const tipP = sp.pts[sp.pts.length - 1];
    const n = 2 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const out = perpAt(d, azS + k * 2.1 + rng() * 0.5);
      const axis = norm(add(add(mul(d, 0.8), mul(out, 0.7)), [0, 0.15, 0]));
      spots.push({ p: tipP, out: axis, axis, r: rA * 0.8, w: [w0a, 0.02], ph: [ph0, 0], frac: 0.3 + 0.2 * rng(), twig: -1, tip: false, cluster: true, tube: tubes.length - 1 });
    }
  }
  // a few single flowers directly on the main wood near the nodes
  for (let i = 1; i < main.pts.length - 1; i++) {
    if (rng() < 0.5) continue;
    const s = i / (main.pts.length - 1);
    const q = along(main, s - 0.02);
    const out = perpAt(q.d, rng() * TAU);
    spots.push({ p: q.p, out, axis: norm(add(mul(out, 0.9), mul(q.d, 0.3))), r: mainR(s), w: [s * s, 0], ph: [ph0, 0], frac: 0.5, twig: -1, tip: false, tube: 0 });
  }
  return { tubes, spots };
}

/**
 * Plum TREE skeleton: gnarled trunk -> 3–5 limbs -> branches -> long upright twigs (flowering whips) + spurs.
 * Local frame: base at origin, +y up. height ≈ overall height (m).
 */
function treeSkeleton(rng, o) {
  _avoid = makeAvoid(o.avoid, o.anchor && o.anchor.pos ? o.anchor.pos : (Array.isArray(o.anchor) ? o.anchor : [0, 0, 0]));
  try { return treeSkeleton0(rng, o); } finally { _avoid = null; }
}
function treeSkeleton0(rng, o) {
  const H = o.height, tubes = [], spots = [];
  const K = H / 4.4;
  const maxFlowers = o.maxFlowers ?? 7000;
  const dens = o.density ?? 1;                      // flower node density multiplier
  const trunkH = H * (o.trunkFrac ?? (0.2 + 0.08 * rng()));
  const rT = o.trunkRadius ?? 0.13 * K;
  const lean = norm([(rng() - 0.5) * 0.3 + (o.lean ? o.lean[0] : 0), 1, (rng() - 0.5) * 0.3 + (o.lean ? o.lean[2] : 0)]);
  const trunk = zigzag(rng, [0, 0, 0], lean, trunkH, 4, 0.14, 0.32, 0.15);
  tubes.push({ pl: trunk, rad: (s) => rT * (1 - 0.3 * s) * (1 + 0.45 * Math.exp(-s * 9)), w: () => [0, 0], ph: [0, 0], kind: 0, gnarl: 1 });
  const flowerRun = (tw, Lt, rA, w0t, ph0, ph1, upBias = 0.3) => {
    let v = 0.015 + 0.02 * rng(), azF = rng() * TAU;
    while (v < Lt - 0.01 && spots.length < maxFlowers) {
      const qq = along(tw, v / Lt);
      azF += 2.5 + (rng() - 0.5) * 0.6;
      const nf = rng() < 0.16 ? 0 : rng() < 0.34 ? 2 : 1;
      for (let f = 0; f < nf; f++) {
        const out = perpAt(qq.d, azF + (f ? 0.9 + 0.5 * rng() : 0));
        const axis = norm(add(add(mul(out, 0.85), mul(qq.d, 0.35)), [0, upBias, 0]));
        spots.push({ p: qq.p, out, axis, r: rA * (1 - 0.7 * v / Lt), w: [w0t, Math.pow(v / Lt, 1.4) * Lt / 0.3], ph: [ph0, ph1], frac: v / Lt, tip: false, tube: tubes.length - 1 });
      }
      v += (0.014 + 0.014 * rng()) / dens;
    }
    const qe = along(tw, 1);
    spots.push({ p: qe.p, out: qe.d, axis: qe.d, r: 0.0008, w: [w0t, Lt / 0.3], ph: [ph0, ph1], frac: 1, tip: true, onTip: true, tube: tubes.length - 1 });
  };
  const whip = (p, dParent, u, rParent, w0, phL, lenMul = 1) => {
    let d2 = norm(rotAround(dParent, perpAt(dParent, rng() * TAU), 0.35 + 0.55 * rng()));
    d2 = norm(add(d2, [0, 0.75, 0]));
    const Lt = (0.22 + 0.5 * rng()) * K * lenMul;
    const tw = zigzag(rng, p, d2, Lt, 2 + Math.floor(rng() * 2), 0.03, 0.14, 0.35, norm(add(d2, [0, 0.6, 0])));
    const rA = Math.max(0.0016, Math.min(rParent * 0.5, 0.0045));
    const ph1 = rng();
    tubes.push({ pl: tw, rad: (v) => Math.max(0.0008, rA * (1 - 0.72 * v)), w: (v) => [w0, Math.pow(v, 1.4) * Lt / 0.3], ph: [phL, ph1], kind: 3, tip: true });
    flowerRun(tw, Lt, rA, w0, phL, ph1);
    // short side shoots on long whips
    if (Lt > 0.4 * K) {
      const ns = 1 + Math.floor(rng() * 2);
      for (let k = 0; k < ns; k++) {
        const v = 0.3 + 0.5 * rng();
        const q = along(tw, v);
        const d3 = norm(add(rotAround(q.d, perpAt(q.d, rng() * TAU), 0.6 + 0.3 * rng()), [0, 0.3, 0]));
        const Ls = (0.07 + 0.12 * rng()) * K;
        const sw = zigzag(rng, q.p, d3, Ls, 1, 0, 0);
        const ph2 = rng();
        tubes.push({ pl: sw, rad: (x) => Math.max(0.0007, rA * 0.6 * (1 - 0.6 * x)), w: (x) => [w0, (v + x * 0.4) * Lt / 0.3], ph: [phL, ph2], kind: 3, tip: true });
        flowerRun(sw, Ls, rA * 0.6, w0, phL, ph2);
      }
    }
  };
  const spur = (p, dParent, rParent, w0, phL) => {
    const d3 = norm(add(perpAt(dParent, rng() * TAU), [0, 0.55, 0]));
    const tip = add(p, mul(d3, 0.012 + 0.025 * rng()));
    const rS = Math.max(0.002, Math.min(rParent * 0.35, 0.006));
    tubes.push({ pl: { pts: [p, tip], dirs: [d3] }, rad: () => rS, w: () => [w0, 0], ph: [phL, 0], kind: 4, tip: true });
    const n = 2 + Math.floor(rng() * 4);
    for (let f = 0; f < n && spots.length < maxFlowers; f++) {
      const axis = norm(add(add(d3, mul(perpAt(d3, f * 2.1 + rng()), 0.9)), [0, 0.15, 0]));
      spots.push({ p: tip, out: axis, axis, r: rS, w: [w0, 0.01], ph: [phL, 0], frac: 0.4, tip: false, cluster: true, tube: tubes.length - 1 });
    }
  };
  const nL = o.limbs ?? (3 + Math.floor(rng() * 2));
  let azL = rng() * TAU;
  const bias = o.limbBias ? norm(o.limbBias) : null;
  for (let l = 0; l < nL; l++) {
    azL += TAU / nL + (rng() - 0.5) * 0.9;
    const lu = o.limbUp ?? [0.75, 0.55];
    let dirL = norm([Math.cos(azL), lu[0] + lu[1] * rng(), Math.sin(azL)]);
    if (bias) dirL = norm(lerp3(dirL, norm(add(bias, [0, 0.55, 0])), 0.4));
    const start = along(trunk, 0.7 + 0.3 * rng()).p;
    const Ll = (H - trunkH) * (0.8 + 0.35 * rng());
    const limb = zigzag(rng, start, dirL, Ll, 5 + Math.floor(rng() * 2), 0.18, 0.42, 0.12, norm([dirL[0] * 0.8, 0.9, dirL[2] * 0.8]));
    const rL = rT * (0.5 + 0.15 * rng());
    const phL = rng();
    const wL = (s) => [Math.pow(s * Ll / 2.5, 1.5), 0];
    tubes.push({ pl: limb, rad: (s) => Math.max(0.01, rL * (1 - 0.72 * s)), w: wL, ph: [phL, 0], kind: 1, gnarl: 0.55, tip: true });
    // whips and spurs straight on the limb (upper side)
    const nWl = Math.round((5 + 4 * rng()) * (o.twigMul ?? 1));
    for (let k = 0; k < nWl; k++) { const s = 0.3 + 0.7 * rng(); const q = along(limb, s); whip(q.p, q.d, s, rL * (1 - 0.72 * s), wL(s)[0], phL, 0.8); }
    for (let k = 0; k < 5; k++) { const s = 0.2 + 0.8 * rng(); const q = along(limb, s); spur(q.p, q.d, rL * (1 - 0.72 * s), wL(s)[0], phL); }
    // branches
    const nB = 5 + Math.floor(rng() * 4);
    let azB = rng() * TAU;
    for (let b = 0; b < nB; b++) {
      const s = 0.18 + 0.78 * (b + rng() * 0.8) / nB;
      const at = along(limb, s);
      azB += 2.4 + (rng() - 0.5);
      let d = norm(rotAround(at.d, perpAt(at.d, azB), 0.45 + 0.55 * rng()));
      d = norm(add(d, [0, 0.2, 0]));
      const Lb = Ll * (0.3 + 0.35 * rng()) * (1 - 0.35 * s);
      const br = zigzag(rng, at.p, d, Lb, 3 + Math.floor(rng() * 2), 0.2, 0.45, 0.12);
      const rB = Math.max(0.006, rL * (1 - 0.72 * s) * 0.55);
      const w0b = wL(s)[0];
      const wB = (u) => [w0b + Math.pow(u * Lb / 2.5, 1.5) * 0.7, 0];
      tubes.push({ pl: br, rad: (u) => Math.max(0.0035, rB * (1 - 0.7 * u)), w: wB, ph: [phL, 0], kind: 2, tip: true });
      const nTw = Math.round((6 + 5 * rng()) * (o.twigMul ?? 1));
      for (let k = 0; k < nTw; k++) {
        if (spots.length > maxFlowers) break;
        const u = 0.12 + 0.88 * (k + rng() * 0.8) / nTw;
        const q = along(br, u);
        whip(q.p, q.d, u, rB * (1 - 0.7 * u), wB(u)[0], phL);
      }
      const nSp = 3 + Math.floor(rng() * 4);
      for (let k = 0; k < nSp; k++) { const u = 0.1 + 0.85 * rng(); const q = along(br, u); spur(q.p, q.d, rB * (1 - 0.7 * u), wB(u)[0], phL); }
    }
  }
  return { tubes, spots };
}

// =====================================================================================================================
// Geometry builders
// =====================================================================================================================
class Buf {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.idx = []; this.at = {}; }
  v(p, n, uv, attrs) {
    this.pos.push(p[0], p[1], p[2]); this.nrm.push(n[0], n[1], n[2]); this.uv.push(uv[0], uv[1]);
    for (const k in attrs) { (this.at[k] || (this.at[k] = [])).push(...attrs[k]); }
    return this.pos.length / 3 - 1;
  }
  t(a, b, c) { this.idx.push(a, b, c); }
  get n() { return this.pos.length / 3; }
  build(THREE, sizes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const k in this.at) g.setAttribute(k, new THREE.Float32BufferAttribute(this.at[k], sizes[k]));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    return g;
  }
}

/** wood tube along a polyline: angular joints (miter rings), taper, bark bumps, metric UVs, sway weights per ring */
function buildTube(B, tube, lod, rng, colFn, tubeIdx = 0) {
  const P = tube.pl.pts;
  const nR = Math.max(3, Math.round(lod.woodRad * (tube.kind === 0 ? 1 : tube.kind >= 3 ? 0.6 : 0.8)));
  // arc lengths
  const cum = [0]; for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + len(sub(P[i], P[i - 1])));
  const total = cum[cum.length - 1] || 1e-6;
  // ring stations: every polyline node (miter) + intermediate stations
  const st = [];
  for (let i = 0; i < P.length - 1; i++) {
    const segL = cum[i + 1] - cum[i];
    const n = Math.max(1, Math.ceil(segL / Math.max(lod.ringStep, 1e-4)));
    for (let k = 0; k < n; k++) st.push({ seg: i, f: k / n });
  }
  st.push({ seg: P.length - 2, f: 1 });
  const segDir = (i) => norm(sub(P[i + 1], P[i]));
  let ref = null;
  let prevRing = null;
  const gn = tube.gnarl || 0;
  const bumpPh = [rng() * TAU, rng() * TAU, rng() * TAU];
  for (let k = 0; k < st.length; k++) {
    const { seg, f } = st[k];
    const c = lerp3(P[seg], P[seg + 1], f);
    let d = segDir(seg);
    if (f === 0 && seg > 0) d = norm(add(segDir(seg - 1), d));           // miter at the joint
    if (f === 1 && seg < P.length - 2) d = norm(add(d, segDir(seg + 1)));
    // parallel transport of the reference vector
    if (!ref) ref = basisOf(d)[0];
    ref = norm(sub(ref, mul(d, dot(ref, d))));
    const b2 = cross(d, ref);
    const s = (cum[seg] + f * (cum[seg + 1] - cum[seg])) / total;
    let r = tube.rad(s);
    // node swelling at joints
    const nodeK = (f === 0 && seg > 0) || (f === 1 && seg < P.length - 2) ? 1.12 : 1;
    r *= nodeK;
    const w = tube.w(s);
    const sw = [w[0], w[1], tubeIdx, 0];
    const col = colFn(r, s, tube);
    const ring = [];
    for (let j = 0; j <= nR; j++) {
      const a = (j / nR) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      let rr = r;
      if (gn > 0) rr *= 1 + gn * (0.14 * Math.sin(3 * a + bumpPh[0] + s * 9) + 0.08 * Math.sin(5 * a + bumpPh[1] - s * 14) + 0.06 * Math.sin(2 * a + bumpPh[2] + s * 23));
      else rr *= 1 + 0.035 * Math.sin(3 * a + bumpPh[0] + s * 31) + 0.02 * Math.sin(7 * a + bumpPh[1] + s * 57) + (lod.ringStep < 0.005 ? 0.025 * Math.sin(11 * a + bumpPh[2] + s * 211) * Math.sin(s * 97 + a * 2) : 0);
      const nrm = add(mul(ref, ca), mul(b2, sa));
      const p = add(c, mul(nrm, rr));
      ring.push(B.v(p, nrm, [a * Math.max(r, 0.004), cum[seg] + f * (cum[seg + 1] - cum[seg])], { aSw: sw, color: col }));
    }
    if (prevRing) for (let j = 0; j < nR; j++) { const a = prevRing[j], b = prevRing[j + 1], cc = ring[j], dd = ring[j + 1]; B.t(a, cc, b); B.t(b, cc, dd); }
    prevRing = ring;
  }
  // tip cap (small cone) / base cap
  if (tube.tip && prevRing) {
    const dEnd = segDir(P.length - 2), rEnd = tube.rad(1);
    const tipP = add(P[P.length - 1], mul(dEnd, rEnd * 1.6));
    const w = tube.w(1);
    const ti = B.v(tipP, dEnd, [0, total + rEnd], { aSw: [w[0], w[1], tubeIdx, 0], color: colFn(rEnd, 1, tube) });
    for (let j = 0; j < nR; j++) B.t(prevRing[j], ti, prevRing[j + 1]);
  }
}

/** petal outline radius (irregular obovate), after geo.js petalGeometry */
function petalShape(rng) {
  const ph = [rng() * TAU, rng() * TAU, rng() * TAU], irr = 0.02 + 0.025 * rng(), notch = 0.02 + 0.04 * rng();
  return (th) => {  // th: angle around the petal centre (−π/2 = toward the base)
    const c = Math.cos(th), s = Math.sin(th);
    const ry = s >= 0 ? 0.5 : 0.5;
    let r = 1 / Math.sqrt((c / 0.5) ** 2 + (s / ry) ** 2);
    const d = Math.abs(th + Math.PI / 2), claw = Math.exp(-((d / 0.55) ** 2));
    r *= 1 - 0.16 * claw * (1 - claw) * 4;
    const tipD = Math.abs(th - Math.PI / 2);
    r *= 1 - notch * Math.exp(-((tipD / 0.12) ** 2));             // shallow apex notch
    r *= 1 + irr * (0.5 * Math.sin(2 * th + ph[0]) + 0.3 * Math.sin(3 * th + ph[1]) + 0.2 * Math.sin(5 * th + ph[2])) * (1 - claw);
    return r;
  };
}
/** normalised petal: xn in [-0.5,0.5] (× W), yn in [0,1] (× L), zn small wobble (× L) */
function addPetal(B, rng, rings, segs, attrsA, attrsB, isSepal) {
  const R = petalShape(rng);
  const wobP = rng() * TAU;
  const c = [0, 0.5];
  const base = B.n;
  const at = (x, y, rho, th) => [x, y, 0.012 * Math.sin(3 * th + wobP) * rho * rho * rho];
  const p0 = at(0, 0.5, 0, 0);
  B.v(p0, [0, 0, 1], [0.5, 0.5], { aPetA: attrsA, aPetB: attrsB });
  for (let i = 1; i <= rings; i++) {
    const rho = i / rings;
    for (let j = 0; j < segs; j++) {
      const th = (j / segs) * TAU - Math.PI / 2;
      const r = R(th) * rho;
      let x = Math.cos(th) * r, y = c[1] + Math.sin(th) * r;
      if (isSepal) { x *= 1.0; }
      const p = at(x, y, rho, th);
      B.v(p, [0, 0, 1], [0.5 + x, y], { aPetA: attrsA, aPetB: attrsB });
    }
  }
  for (let j = 0; j < segs; j++) B.t(base, base + 1 + j, base + 1 + ((j + 1) % segs));
  for (let i = 1; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = base + 1 + (i - 1) * segs + j, b = base + 1 + (i - 1) * segs + ((j + 1) % segs);
    const cc = a + segs, d = b + segs;
    B.t(a, cc, b); B.t(b, cc, d);
  }
}
/** receptacle (small cup under the petals) + pedicel stub, flower-local metres, part 2 */
function addReceptacle(B, fi, segs, pedLen) {
  const prof = segs > 8 ? [[0.0, -0.0032], [0.0011, -0.003], [0.0017, -0.0019], [0.0019, -0.0006], [0.0015, 0.0006], [0.0, 0.0009]]
                        : [[0.0, -0.0032], [0.0018, -0.0016], [0.0015, 0.0006]];
  const A = [fi, 0, 0, 2], Bb = [0, 0, 0, 0];
  const rows = [];
  for (let r = 0; r < prof.length; r++) {
    const row = [];
    const [rr, y] = prof[r];
    const r0 = prof[Math.max(0, r - 1)], r1 = prof[Math.min(prof.length - 1, r + 1)];
    const dy = r1[1] - r0[1], dr = r1[0] - r0[0];
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * TAU, ca = Math.cos(a), sa = Math.sin(a);
      const n = norm([ca * dy, -dr, sa * dy]);
      row.push(B.v([ca * rr, y, sa * rr], n, [a * 0.002, y], { aPetA: A, aPetB: Bb, color: r < 2 ? COL.pedicel : COL.recept }));
    }
    rows.push(row);
  }
  for (let r = 0; r < rows.length - 1; r++) for (let j = 0; j < segs; j++) { const a = rows[r][j], b = rows[r][j + 1], c = rows[r + 1][j], d = rows[r + 1][j + 1]; B.t(a, c, b); B.t(b, c, d); }
  // pedicel: short stalk from the receptacle bottom down to the twig
  if (pedLen > 0.0005) {
    const top = [], bot = [], rp = 0.00055, n = Math.max(3, Math.round(segs / 2));
    for (let j = 0; j <= n; j++) {
      const a = (j / n) * TAU, ca = Math.cos(a), sa = Math.sin(a);
      top.push(B.v([ca * rp, -0.003, sa * rp], [ca, 0, sa], [a * rp, 0], { aPetA: A, aPetB: Bb, color: COL.pedicel }));
      bot.push(B.v([ca * rp * 1.2, -0.003 - pedLen, sa * rp * 1.2], [ca, 0, sa], [a * rp, pedLen], { aPetA: A, aPetB: Bb, color: COL.pedicel }));
    }
    for (let j = 0; j < n; j++) { B.t(bot[j], top[j], bot[j + 1]); B.t(bot[j + 1], top[j], top[j + 1]); }
  }
}
/** filament (thin tube along the local d axis, s in [0,1]) + anther (ellipsoid at the tip) */
function addStamen(B, fi, yaw, r0, Ls, spreadJit, curve, kind, lod, rng) {
  const [nSeg, nRad] = lod.fil || [0, 0];
  const A = [fi, yaw, r0, kind === 'pistil' ? 2 : 0];
  const rad = kind === 'pistil' ? 0.00016 : 0.000085;
  const col = kind === 'pistil' ? COL.pistil : COL.filament;
  const rows = [];
  for (let i = 0; i <= nSeg && lod.fil; i++) {
    const s = i / nSeg;
    const row = [];
    const rr = rad * (1 - 0.25 * s);
    for (let j = 0; j <= nRad; j++) {
      const a = (j / nRad) * TAU, ca = Math.cos(a), sa = Math.sin(a);
      row.push(B.v([ca * rr, 0, sa * rr], [ca, 0, sa], [j / nRad, s], { aSt: A, aSt2: [Ls, spreadJit, curve, s], color: col }));
    }
    rows.push(row);
  }
  if (lod.fil) for (let i = 0; i < nSeg; i++) for (let j = 0; j < nRad; j++) { const a = rows[i][j], b = rows[i][j + 1], c = rows[i + 1][j], d = rows[i + 1][j + 1]; B.t(a, c, b); B.t(b, c, d); }
  // anther / stigma
  const [nu, nv] = lod.anth;
  const big = lod.fil ? 1 : 1.5;
  const ax = kind === 'pistil' ? [0.00032, 0.00012, 0.00032] : [0.00034 * (0.9 + 0.2 * rng()) * big, 0.00042 * big, 0.00024 * big];
  const kA = [fi, yaw, r0, kind === 'pistil' ? 3 : 1];
  const tilt = (rng() - 0.5) * 0.8;
  const grid = [];
  for (let i = 0; i <= nv; i++) {
    const v = (i / nv) * Math.PI, sv = Math.sin(v), cv = Math.cos(v);
    const row = [];
    for (let j = 0; j <= nu; j++) {
      const u = (j / nu) * TAU, cu = Math.cos(u), su = Math.sin(u);
      // ellipsoid; anthers: two lobes (slight waist along x)
      const lobe = kind === 'pistil' ? 1 : 1 - 0.18 * Math.exp(-((cu * 3) ** 2)) * sv;
      let p = [cu * sv * ax[0] * lobe, cv * ax[1] + ax[1] * 0.8, su * sv * ax[2]];
      let n = norm([cu * sv / ax[0], cv / ax[1], su * sv / ax[2]]);
      // tilt the anther a little (versatile anthers)
      const ct = Math.cos(tilt), st = Math.sin(tilt);
      p = [p[0] * ct - (p[1] - ax[1] * 0.8) * st, (p[0] * st + (p[1] - ax[1] * 0.8) * ct) + ax[1] * 0.8, p[2]];
      n = [n[0] * ct - n[1] * st, n[0] * st + n[1] * ct, n[2]];
      const colA = kind === 'pistil' ? COL.stigma : (i < nv * 0.35 ? COL.antherTip : COL.anther);
      row.push(B.v(p, n, [j / nu, i / nv], { aSt: kA, aSt2: [Ls, spreadJit, curve, 1], color: colA }));
    }
    grid.push(row);
  }
  for (let i = 0; i < nv; i++) for (let j = 0; j < nu; j++) { const a = grid[i][j], b = grid[i][j + 1], c = grid[i + 1][j], d = grid[i + 1][j + 1]; B.t(a, b, c); B.t(b, d, c); }
}

/** far-LOD sprite atlas (Canvas2D, procedural), 4 tiles: 0 open face-on | 1 open 3/4 view | 2 half-open cup | 3 bud */
function flowerAtlas(THREE) {
  const T = 256, W = T * 4, H = T;
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, W, H);
  const rng = makeRng('plum-atlas-v2');
  const petal = (R, wid, notch) => {          // obovate petal along +y from the centre, as a closed path
    const p = new Path2D();
    const b = R * 0.1, m = R * 0.62, hw = R * wid;
    p.moveTo(0, b);
    p.bezierCurveTo(hw * 0.55, R * 0.25, hw * 1.05, m - R * 0.1, hw * 0.95, m + R * 0.12);
    p.bezierCurveTo(hw * 0.85, R * 0.93, hw * 0.3, R * 1.02, R * 0.05, R * (1 - notch));
    p.bezierCurveTo(-hw * 0.3, R * 1.02, -hw * 0.85, R * 0.93, -hw * 0.95, m + R * 0.12);
    p.bezierCurveTo(-hw * 1.05, m - R * 0.1, -hw * 0.55, R * 0.25, 0, b);
    return p;
  };
  const flower = (cx, cy, R, sy, pinkK, stamens, sepals) => {
    g.save(); g.translate(cx, cy); g.scale(1, sy);
    if (sepals) {                               // dark red-brown sepals peeking between/below the petals
      for (let i = 0; i < 5; i++) {
        g.save(); g.rotate(((i + 0.5) / 5) * Math.PI * 2 + 0.3);
        g.fillStyle = 'rgb(112,52,46)'; g.beginPath(); g.ellipse(0, R * 0.5, R * 0.2, R * 0.34, 0, 0, Math.PI * 2); g.fill();
        g.restore();
      }
    }
    const a0 = rng() * Math.PI * 2;
    for (let i = 0; i < 5; i++) {
      g.save(); g.rotate(a0 + (i / 5) * Math.PI * 2 + (rng() - 0.5) * 0.15);
      const Rp = R * (0.94 + 0.1 * rng());
      const pth = petal(Rp, 0.36 + 0.04 * rng(), 0.04 + 0.03 * rng());
      const grd = g.createRadialGradient(0, 0, R * 0.05, 0, 0, Rp);
      grd.addColorStop(0, `rgb(${Math.round(222 - 20 * pinkK)},${Math.round(160 - 30 * pinkK)},${Math.round(160 - 30 * pinkK)})`);
      grd.addColorStop(0.28, `rgb(240,${Math.round(214 - 20 * pinkK)},${Math.round(210 - 20 * pinkK)})`);
      grd.addColorStop(0.55, 'rgb(248,242,237)'); grd.addColorStop(1, 'rgb(242,236,232)');
      g.fillStyle = grd; g.fill(pth);
      g.strokeStyle = 'rgba(150,118,110,0.28)'; g.lineWidth = 1.6; g.stroke(pth);
      g.strokeStyle = 'rgba(214,186,182,0.35)'; g.lineWidth = 1;         // faint veins
      for (let k = -2; k <= 2; k++) { g.beginPath(); g.moveTo(0, R * 0.14); g.quadraticCurveTo(k * R * 0.05, R * 0.5, k * R * 0.13, R * 0.86); g.stroke(); }
      g.restore();
    }
    // centre: hypanthium ring, pistil, stamens with anthers
    g.fillStyle = 'rgb(150,78,70)'; g.beginPath(); g.arc(0, 0, R * 0.11, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgb(186,196,110)'; g.beginPath(); g.arc(0, 0, R * 0.045, 0, Math.PI * 2); g.fill();
    for (let i = 0; i < stamens; i++) {
      const a = rng() * Math.PI * 2, r = R * (0.24 + 0.2 * rng());
      g.strokeStyle = 'rgba(242,234,214,0.95)'; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(Math.cos(a) * R * 0.08, Math.sin(a) * R * 0.08); g.lineTo(Math.cos(a) * r, Math.sin(a) * r); g.stroke();
      g.fillStyle = rng() < 0.5 ? 'rgb(226,176,58)' : 'rgb(200,140,40)';
      g.beginPath(); g.arc(Math.cos(a) * r, Math.sin(a) * r, 3.2 + rng() * 1.3, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  };
  flower(T * 0.5, T * 0.5, T * 0.47, 1, 0.5, 30, false);                    // 0 open, face-on
  flower(T * 1.5, T * 0.56, T * 0.47, 0.58, 0.6, 26, true);                 // 1 open, 3/4 view (squashed along y)
  // 2 half-open cup: shorter, pinker petals, centre partly hidden, sepals under
  g.save(); g.translate(T * 2.5, T * 0.55); g.scale(1, 0.8);
  for (let i = 0; i < 5; i++) { g.save(); g.rotate((i + 0.5) / 5 * Math.PI * 2 + 0.3); g.fillStyle = 'rgb(110,50,45)'; g.beginPath(); g.ellipse(0, T * 0.28, T * 0.1, T * 0.17, 0, 0, Math.PI * 2); g.fill(); g.restore(); }
  for (let i = 0; i < 5; i++) {
    g.save(); g.rotate((i / 5) * Math.PI * 2 + 0.2);
    const pth = petal(T * 0.36, 0.44, 0.02);
    const grd = g.createRadialGradient(0, 0, 4, 0, 0, T * 0.36);
    grd.addColorStop(0, 'rgb(214,150,150)'); grd.addColorStop(0.5, 'rgb(242,222,218)'); grd.addColorStop(1, 'rgb(246,236,232)');
    g.fillStyle = grd; g.fill(pth); g.strokeStyle = 'rgba(150,110,104,0.35)'; g.lineWidth = 1.8; g.stroke(pth);
    g.restore();
  }
  for (let i = 0; i < 10; i++) { const a = rng() * Math.PI * 2, r = T * (0.03 + 0.07 * rng()); g.fillStyle = 'rgb(222,170,56)'; g.beginPath(); g.arc(Math.cos(a) * r, Math.sin(a) * r, 3.4, 0, Math.PI * 2); g.fill(); }
  g.restore();
  // 3 bud: blushed ball in the calyx
  { const bx = T * 3.5, by = T * 0.46, r = T * 0.3;
    const gb = g.createRadialGradient(bx - r * 0.35, by - r * 0.4, r * 0.1, bx, by, r);
    gb.addColorStop(0, 'rgb(250,240,236)'); gb.addColorStop(0.6, 'rgb(234,196,190)'); gb.addColorStop(1, 'rgb(196,140,134)');
    g.fillStyle = gb; g.beginPath(); g.arc(bx, by, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(170,120,114,0.4)'; g.lineWidth = 2;
    for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(bx + (k - 1) * r * 0.45, by - r * 0.1, r * 0.8, -1.9 + k * 0.2, -1.1 + k * 0.2); g.stroke(); }
    g.fillStyle = 'rgb(112,50,45)';
    for (let i = 0; i < 5; i++) { const a = Math.PI / 2 + (i - 2) * 0.5; g.beginPath(); g.ellipse(bx + Math.cos(a) * r * 0.55, by + r * 0.62, r * 0.28, r * 0.42, a - Math.PI / 2, 0, Math.PI * 2); g.fill(); } }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// =====================================================================================================================
// Flower data texture + open times
// =====================================================================================================================
/** first time world.bloomAmount >= thr (sampled 0.05 s, linear refine); +1e6 if never */
function bloomCrossTimes(worldSrc, thresholds, t0 = -1, t1 = 60) {
  const dt = 0.05, n = Math.ceil((t1 - t0) / dt) + 1;
  const b = new Float32Array(n);
  let run = -Infinity;
  for (let i = 0; i < n; i++) { const v = worldSrc.at(t0 + i * dt).bloomAmount ?? 0; run = Math.max(run, v); b[i] = run; }  // monotone envelope
  return thresholds.map((th) => {
    if (b[0] >= th) return -1e6;       // already open at the start of the film
    let lo = 0, hi = n - 1;
    if (b[hi] < th) return 1e6;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (b[m] >= th) hi = m; else lo = m; }
    const f = (th - b[lo]) / Math.max(1e-9, b[hi] - b[lo]);
    return t0 + (lo + f) * dt;
  });
}

/** JS mirror of the opening spring (see plumOpenCurve) */
function springJS(tau) {
  if (tau <= 0) return 0;
  const e = Math.exp(-0.62 * 8.5 * tau), wd = 8.5 * 0.7846;
  return 1 - e * (Math.cos(wd * tau) + 0.79021 * Math.sin(wd * tau));
}
const smooth01 = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };

// =====================================================================================================================
// Build meshes from a skeleton
// =====================================================================================================================
function buildPlant(ctx, skel, o, rng, kindLabel) {
  const THREE = ctx.THREE || THREE_NS;
  const lodName = o.lod in LOD ? o.lod : 'mid';
  const lodW = LOD[lodName];
  // ---- flowers: per-flower data ----
  const spots = skel.spots;
  const N = spots.length;
  const score = spots.map((s) => (s.onTip ? 0.75 : 0) + 0.45 * rng() + 0.3 * (s.frac ?? 0.5));
  const order = score.map((v, i) => i).sort((a, b) => score[a] - score[b]);
  const thr = new Array(N);
  order.forEach((i, r) => { thr[i] = (r + 0.5) / N; });
  const flowers = spots.map((s, i) => {
    const size = (s.onTip ? 0.8 : 1) * (0.9 + 0.22 * rng()) * (o.flowerSize ?? 1);
    const ped = s.cluster ? 0.0012 + 0.001 * rng() : 0.0006 + 0.0012 * rng();
    const c = add(s.p, mul(s.axis, (s.r || 0.001) + ped + 0.003 * size));
    return { c, a: s.axis, size, spin: rng() * TAU, openAt: 1e6, thr: thr[i], r1: rng(), r2: rng(), sw: [s.w[0], s.w[1], s.ph[0], s.ph[1]], ped, spot: s, onTip: !!s.onTip };
  });
  // order flowers base -> tip along the local +y (presentation order for openTimes)
  // (kept in generation order: twig by twig, base to tip)
  // ---- open times ----
  const worldSrc = (ctx.world && typeof ctx.world.at === 'function') ? ctx.world : DEFAULT_WORLD;
  let crossT = null;
  const bloomMode = o.bloom === undefined ? 'world' : o.bloom;
  if (bloomMode === 'world') crossT = bloomCrossTimes(worldSrc, flowers.map((f) => f.thr), -1, o.duration ?? ctx.duration ?? 60);
  flowers.forEach((f, i) => { f.openAt = crossT ? crossT[i] : 1e6; });
  const applyOpenTimes = (times) => {
    if (!times) return;
    const entries = Array.isArray(times) ? times.map((t, i) => [i, t]) : Object.entries(times).map(([k, t]) => [+k, t]);
    for (const [i, t] of entries) {
      if (t === null || t === undefined || !flowers[i]) continue;
      flowers[i].openAt = t; flowers[i].thr = -1;    // explicit time: always time-driven
    }
  };
  applyOpenTimes(o.openTimes);
  /** re-aim flowers (local direction), keeping them attached to their twig point */
  const orient = (indices, dirLocal, amount = 0.6) => {
    const dl = norm(dirLocal);
    for (const i of indices) {
      const f = flowers[i]; if (!f) continue;
      const a = norm(lerp3(f.a, dl, amount));
      f.a = a;
      f.c = add(f.spot.p, mul(a, (f.spot.r || 0.001) + f.ped + 0.003 * f.size));
    }
  };
  // ---- dynamic textures: per-flower state (3 texels) and per-tube sway (2 texels), rewritten every update ----
  const FPR = 256, fRows = Math.max(1, Math.ceil(N / FPR));
  const dyn = new Float32Array(FPR * 3 * fRows * 4);
  const dynTex = new THREE.DataTexture(dyn, FPR * 3, fRows, THREE.RGBAFormat, THREE.FloatType);
  dynTex.minFilter = dynTex.magFilter = THREE.NearestFilter; dynTex.generateMipmaps = false; dynTex.needsUpdate = true;
  const NT = skel.tubes.length, TPR = 512, tRows = Math.max(1, Math.ceil(NT / TPR));
  const swd = new Float32Array(TPR * 2 * tRows * 4);
  const swTex = new THREE.DataTexture(swd, TPR * 2, tRows, THREE.RGBAFormat, THREE.FloatType);
  swTex.minFilter = swTex.magFilter = THREE.NearestFilter; swTex.generateMipmaps = false; swTex.needsUpdate = true;
  const tubePh = skel.tubes.map((tb) => [tb.ph[0] * 37, tb.ph[1] * 53]);
  const flTube = flowers.map((f) => (f.spot.tube ?? 0));
  const FD = { tex: dynTex, write() {} };

  // ---- uniforms (shared by all parts of this plant) ----
  const U = {
    uPlumDyn: { value: dynTex }, uPlumSwT: { value: swTex }, uPlumT: { value: new THREE.Vector4(0, 0, 0, 0) }, uPlumKey: { value: new THREE.Vector3(0, 1, 0) },
    uPlumBud: { value: new THREE.Color().setRGB(...(o.budTint || [1.0, 0.78, 0.76])) },
  };
  const amp = o.swayAmp || [0.012, 0.008, 0.05, 1];

  // ---- materials ----
  const M = o.materials || createMaterials(ctx);
  const barkMat = M.bark({ seed: o.barkSeed ?? 1, uvScale: lodName === 'macro' ? [5, 5] : (lodName === 'mid' ? [2, 2] : [1, 1]) });
  barkMat.vertexColors = true;
  patchMaterial(barkMat, U, PLUM_WOOD_V, 'wood');
  const petalMat = M.petal({ translucency: o.translucency ?? 0.85 });
  petalMat.defines = { ...(petalMat.defines || {}), PLUM_PETAL: '' };
  patchMaterial(petalMat, U, PLUM_PETAL_V, 'petal', { tint: true });
  const calyxMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, side: THREE.DoubleSide, color: 0xffffff });
  patchMaterial(calyxMat, U, PLUM_PETAL_V, 'calyx');
  const stamenMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0, color: 0xffffff });
  patchMaterial(stamenMat, U, PLUM_STAMEN_V, 'stamen');
  const depthOf = (body, key, side = THREE.FrontSide) => {
    const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side });
    patchMaterial(dm, U, body, key + ':depth', { depth: true });
    const di = new THREE.MeshDistanceMaterial({ side });
    patchMaterial(di, U, body, key + ':dist', { depth: true });
    return { depth: dm, distance: di };
  };

  const group = new THREE.Group(); group.name = 'plum:' + kindLabel;
  const meshes = [];
  const addMesh = (geo, mat, name, cast, depthBody, side) => {
    const m = new THREE.Mesh(geo, mat); m.name = name; m.frustumCulled = false;
    m.castShadow = !!cast; m.receiveShadow = true;
    if (cast && depthBody) { const d = depthOf(depthBody, name, side); m.customDepthMaterial = d.depth; m.customDistanceMaterial = d.distance; }
    group.add(m); meshes.push(m); return m;
  };

  // ---- wood ----
  const Bw = new Buf();
  const colFn = (r, s, tube) => {
    // young shoots: warmer / greener brown; old wood: neutral (texture) ; slight per-tube variation
    const young = smooth(0.0026, 0.0009, r);
    return [mix(1.0, 2.3, young), mix(1.0, 1.85, young), mix(1.0, 1.25, young)];
  };
  skel.tubes.forEach((tb, k) => buildTube(Bw, tb, lodW, rng, colFn, k));
  addMesh(Bw.build(THREE, { aSw: 4, color: 3 }), barkMat, 'plum.wood', o.castShadow !== false, PLUM_WOOD_V);

  // ---- flowers ----
  const detail = o.detail || null;       // {center (local), radius}: flowers inside -> lod 'mid' geometry, others cards
  const useCard = (f) => {
    if (lodName !== 'far') return false;
    if (!detail) return true;
    return len(sub(f.c, detail.center)) > detail.radius;
  };
  const geoLod = lodName === 'far' ? LOD.mid : lodW;
  const Bp = new Buf(), Bc = new Buf(), Bs = new Buf(), Bk = new Buf();
  let nCards = 0;
  const cardShadows = o.cardShadows ?? (lodName !== 'macro');
  flowers.forEach((f, fi) => {
    const card = useCard(f);
    if (card || cardShadows) {
      // aCard.w = 1: shadow-only card (the flower has real geometry in the colour pass)
      const ids = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => Bk.v([0, 0, 0], [0, 0, 1], [0, 0], { aCard: [fi, x, y, card ? 0 : 1] }));
      Bk.t(ids[0], ids[1], ids[2]); Bk.t(ids[0], ids[2], ids[3]);
      if (card) nCards++;
    }
    if (card) return;
    const L0 = 0.0105, W0 = 0.0102;
    const yaw0 = rng() * TAU;
    for (let i = 0; i < 5; i++) {
      const yaw = yaw0 + (i / 5) * TAU + (rng() - 0.5) * 0.22;
      addPetal(Bp, rng, geoLod.pr, geoLod.ps, [fi, yaw, (rng() - 0.5) * 0.18, 0], [L0 * (0.9 + 0.2 * rng()), W0 * (0.9 + 0.18 * rng()), (rng() - 0.5) * 0.12, (rng() - 0.5) * 0.06], false);
    }
    for (let i = 0; i < 5 && !geoLod.noSepals; i++) {
      const yaw = yaw0 + ((i + 0.5) / 5) * TAU + (rng() - 0.5) * 0.2;
      const cStart = Bc.n;
      addPetal(Bc, rng, geoLod.sr, geoLod.ss, [fi, yaw, (rng() - 0.5) * 0.15, 1], [0.0042 * (0.9 + 0.2 * rng()), 0.0040, (rng() - 0.5) * 0.1, 0], true);
      // sepal colours: dark red-brown (outer), paler toward the base inside
      for (let k = cStart; k < Bc.n; k++) { (Bc.at.color || (Bc.at.color = [])).push(...COL.sepal); }
    }
    addReceptacle(Bc, fi, geoLod.recept, geoLod.noPedicel ? 0 : f.ped);
    if (geoLod.nSt > 0) {
      const nSt = Math.round(geoLod.nSt * (0.9 + 0.2 * rng()));
      for (let i = 0; i < nSt; i++) {
        const yaw = rng() * TAU, r0 = 0.0006 + 0.0012 * Math.sqrt(rng());
        const Ls = 0.0048 + 0.0032 * rng();
        addStamen(Bs, fi, yaw, r0, Ls, (rng() - 0.5) * 0.5, 0.6 + 0.8 * rng(), 'stamen', geoLod, rng);
      }
      if (geoLod.fil) addStamen(Bs, fi, rng() * TAU, 0.0001, 0.0062 + 0.0015 * rng(), 0.02, 0.2, 'pistil', geoLod, rng);
    }
  });
  // colour attribute for the receptacle vertices was pushed by addReceptacle (includes color); fix the petal/sepal mix:
  // Bc has 'color' for sepals (pushed above) and receptacles (pushed in B.v) — lengths match vertex count.
  if (Bp.n) addMesh(Bp.build(THREE, { aPetA: 4, aPetB: 4 }), petalMat, 'plum.petals', o.castShadow !== false && !cardShadows, PLUM_PETAL_V, THREE.DoubleSide);
  if (Bc.n) addMesh(Bc.build(THREE, { aPetA: 4, aPetB: 4, color: 3 }), calyxMat, 'plum.calyx', false);
  if (Bs.n) addMesh(Bs.build(THREE, { aSt: 4, aSt2: 4, color: 3 }), stamenMat, 'plum.stamens', false);
  let atlas = null;
  if (Bk.n) {
    atlas = flowerAtlas(THREE);
    const cardMat = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.7, metalness: 0 });
    patchMaterial(cardMat, U, PLUM_CARD_V, 'card', { card: true });
    const cg = Bk.build(THREE, { aCard: 4 });
    const cm = addMesh(cg, cardMat, 'plum.cards', false);
    if (o.castShadow !== false && cardShadows) {
      // shadow pass: every flower casts through its card (the billboard faces the light there)
      const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide, map: atlas, alphaTest: 0.45 });
      patchMaterial(dm, U, PLUM_CARD_V, 'card:depth', { depth: true, card: true });
      cm.castShadow = true; cm.customDepthMaterial = dm;
    }
  }

  // ---- update: per-tube sway vectors + per-flower dynamic state (pure function of t, world) ----
  const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
  const S0 = new Float32Array(NT * 3), S1 = new Float32Array(NT * 3);
  function update(t, world, camera, x = {}) {
    const w = world || {};
    const ts = (x.swayTime ?? t) * amp[3] * (x.swayFreq ?? 1);
    const still = clamp(x.still ?? 0);
    const bloomStatic = typeof bloomMode === 'number' ? (x.bloom ?? bloomMode) : (x.bloom ?? -1);
    U.uPlumT.value.set(t, ts, 0, still);
    group.updateWorldMatrix(true, false);
    group.matrixWorld.decompose(_v, _q, _s);
    _q.invert();
    const wdw = w.windDir || [0.9, 0, 0.12];
    _v.set(wdw[0], 0, wdw[2]).normalize().applyQuaternion(_q); const wd = [_v.x, _v.y, _v.z];
    _v.set(0, 1, 0).applyQuaternion(_q); const up = [_v.x, _v.y, _v.z];
    { const key = (w.sunElev ?? -30) > -1 ? (w.sunDir || [0, 1, 0]) : (w.moonDir || [0, 1, 0]); _v.set(key[0], key[1], key[2]).normalize().applyQuaternion(_q); U.uPlumKey.value.copy(_v); }
    const sd = norm(add(cross(up, wd), [1e-5, 0, 0]));
    const Wk = (w.wind ?? 0.3) * (x.windGain ?? 1) * (1 - 0.9 * still) / (_s.x || 1);
    // tubes
    for (let k = 0; k < NT; k++) {
      const [p0, p1] = tubePh[k];
      const gust = 0.55 + 0.45 * gnoise1(ts * 0.31 + p0 * 0.1, 11);
      const o0 = 0.55 * Math.sin(ts * 2.7 + p0) + 0.3 * Math.sin(ts * 4.6 + 1.7 * p0) + 0.45 * gnoise1(ts * 1.3 + p0, 5);
      const q0 = 0.5 * Math.sin(ts * 2.1 + 0.7 * p0) + 0.45 * gnoise1(ts * 1.1 + p0 + 3, 7);
      const a0 = amp[0] * Wk;
      const o1 = 0.5 * Math.sin(ts * 6.3 + p1) + 0.25 * Math.sin(ts * 10.1 + 1.3 * p1) + 0.5 * gnoise1(ts * 3.7 + p1, 3);
      const q1 = 0.45 * Math.sin(ts * 5.2 + 0.6 * p1) + 0.5 * gnoise1(ts * 2.9 + p1 + 5, 9);
      const a1 = amp[1] * Wk;
      for (let c = 0; c < 3; c++) {
        S0[k * 3 + c] = (wd[c] * (0.45 * gust + 0.3 * o0) + sd[c] * 0.3 * q0 + up[c] * 0.08 * o0) * a0;
        S1[k * 3 + c] = (wd[c] * (0.35 * gust + 0.4 * o1) + sd[c] * 0.45 * q1 + up[c] * 0.2 * q1) * a1;
      }
      const base = (Math.floor(k / TPR) * TPR * 2 + (k % TPR) * 2) * 4;
      swd[base] = S0[k * 3]; swd[base + 1] = S0[k * 3 + 1]; swd[base + 2] = S0[k * 3 + 2];
      swd[base + 4] = S1[k * 3]; swd[base + 5] = S1[k * 3 + 1]; swd[base + 6] = S1[k * 3 + 2];
    }
    swTex.needsUpdate = true;
    // flowers
    const fl = amp[2] * Wk * (_s.x || 1);
    for (let i = 0; i < N; i++) {
      const f = flowers[i], k = flTube[i];
      const w0 = f.sw[0], w1 = f.sw[1];
      const cx = f.c[0] + S0[k * 3] * w0 + S1[k * 3] * w1, cy = f.c[1] + S0[k * 3 + 1] * w0 + S1[k * 3 + 1] * w1, cz = f.c[2] + S0[k * 3 + 2] * w0 + S1[k * 3 + 2] * w1;
      let op;
      if (bloomStatic >= 0 && f.thr >= 0) op = smooth01(f.thr - 0.035, f.thr + 0.035, bloomStatic);
      else { const tau = t - f.openAt; op = Math.max(springJS(tau), 0.07 * smooth01(-0.45, 0, tau)); }
      // fluttered axis + spun frame
      const a = f.a, ref = Math.abs(a[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
      let b1 = norm(cross(ref, a)), b2 = cross(a, b1);
      const wx = fl * (Math.sin(ts * 7.1 + f.r1 * 40) + 0.5 * gnoise1(ts * 3.3 + f.r2 * 50, 13));
      const wy = fl * (Math.sin(ts * 6.3 + f.r2 * 30) + 0.5 * gnoise1(ts * 2.9 + f.r1 * 60, 17));
      const A = norm([a[0] + b1[0] * wx + b2[0] * wy, a[1] + b1[1] * wx + b2[1] * wy, a[2] + b1[2] * wx + b2[2] * wy]);
      b1 = norm(cross(ref, A)); b2 = cross(A, b1);
      const cs = Math.cos(f.spin), sn = Math.sin(f.spin);
      const E1 = [b1[0] * cs + b2[0] * sn, b1[1] * cs + b2[1] * sn, b1[2] * cs + b2[2] * sn];
      const base = (Math.floor(i / FPR) * FPR * 3 + (i % FPR) * 3) * 4;
      dyn[base] = cx; dyn[base + 1] = cy; dyn[base + 2] = cz; dyn[base + 3] = op;
      dyn[base + 4] = A[0]; dyn[base + 5] = A[1]; dyn[base + 6] = A[2]; dyn[base + 7] = fl;
      dyn[base + 8] = E1[0]; dyn[base + 9] = E1[1]; dyn[base + 10] = E1[2]; dyn[base + 11] = f.size;
    }
    dynTex.needsUpdate = true;
  }
  update(0, { wind: 0.3, windDir: [0.9, 0, 0.12] }, null, {});

  // ---- public flower list (world positions at creation, using the anchor) ----
  return {
    group, U, meshes, flowers, FD, applyOpenTimes, orient, update, atlas, swTex,
    materials: [barkMat, petalMat, calyxMat, stamenMat],
    counts: { flowers: N, cards: nCards, verts: meshes.reduce((a, m) => a + m.geometry.attributes.position.count, 0) },
  };
}

function applyAnchor(THREE, group, anchor) {
  if (!anchor) return;
  if (Array.isArray(anchor)) { group.position.fromArray(anchor); return; }
  if (anchor.isObject3D) { anchor.add(group); return; }
  if (anchor.pos) group.position.fromArray(anchor.pos);
  if (anchor.dir) {
    const d = new THREE.Vector3().fromArray(anchor.dir).normalize();
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
  }
  if (anchor.roll) group.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), anchor.roll));
  if (anchor.scale) group.scale.setScalar(anchor.scale);
  group.updateMatrixWorld(true);
}

function publicFlowers(THREE, plant) {
  const m = plant.group.matrixWorld, v = new THREE.Vector3(), a = new THREE.Vector3();
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  return plant.flowers.map((f, i) => {
    v.fromArray(f.c).applyMatrix4(m); a.fromArray(f.a).applyMatrix3(nm).normalize();
    return { index: i, pos: v.toArray(), axis: a.toArray(), openAt: f.openAt, threshold: f.thr, size: f.size, tip: f.onTip, twig: f.spot.twig ?? -1, frac: f.spot.frac ?? 0.5 };
  });
}

// =====================================================================================================================
// Public API
// =====================================================================================================================
function makeApi(THREE, plant, o) {
  const api = {
    object: plant.group,
    flowers: publicFlowers(THREE, plant),
    counts: plant.counts,
    uniforms: plant.U,
    /** per frame: t = FILM time, world = world.at(t); extra: { swayTime, still, bloom, windGain, swayFreq } */
    update(t, world, camera, x) { plant.update(t, world, camera, x); },
    /** explicit opening times: number[] in `flowers` index order, or { index: t }; null entries keep the bloom mode */
    setOpenTimes(times) { plant.applyOpenTimes(times); plant.FD.write(); api.flowers = publicFlowers(THREE, plant); },
    /** re-aim flowers toward a WORLD direction (amount 0..1), keeping them on their twig (e.g. hero flowers of a macro) */
    orientFlowers(indices, dirWorld, amount = 0.6) {
      plant.group.updateMatrixWorld(true);
      const q = new THREE.Quaternion(); plant.group.getWorldQuaternion(q); q.invert();
      const d = new THREE.Vector3().fromArray(dirWorld).applyQuaternion(q).toArray();
      plant.orient(indices, d, amount); plant.FD.write(); api.flowers = publicFlowers(THREE, plant);
    },
    /** recompute `flowers` world positions after moving `object` */
    refresh() { plant.group.updateMatrixWorld(true); api.flowers = publicFlowers(THREE, plant); return api.flowers; },
    flowerWorld(i) { plant.group.updateMatrixWorld(true); return new THREE.Vector3().fromArray(plant.flowers[i].c).applyMatrix4(plant.group.matrixWorld).toArray(); },
    /** n points on the flowering twigs (world), e.g. burst sources for createPetals({bursts}) */
    petalSources(n = 8) { const r = makeRng('src:' + o.seed); const out = []; for (let i = 0; i < n; i++) out.push(api.flowerWorld(Math.floor(r() * plant.flowers.length))); return out; },
    dispose() {
      for (const m of plant.meshes) { m.geometry.dispose(); if (m.customDepthMaterial) m.customDepthMaterial.dispose(); if (m.customDistanceMaterial) m.customDistanceMaterial.dispose(); }
      plant.materials.forEach((m) => m.dispose()); plant.FD.tex.dispose(); plant.swTex.dispose(); if (plant.atlas) plant.atlas.dispose();
    },
  };
  return api;
}

/**
 * createPlumBranch(ctx, opts) -> { object, update(t, world, camera, extra?), flowers, setOpenTimes(times), orientFlowers,
 *                                  refresh, flowerWorld(i), petalSources(n), dispose, counts }
 *   opts: seed, length=0.6 (m), twigs=6, spurs=0.8, radius (base, m), bloom='world' | number (0..1 static),
 *         openTimes: number[] (index order of `flowers`) | {index: t} — explicit film times at which flowers start opening,
 *         lod: 'macro' | 'mid' | 'far', anchor: [x,y,z] | {pos, dir (growth direction, default +y), roll, scale} | Object3D,
 *         swayAmp: [branch m, twig m, flutter rad, freq] (default [0.012, 0.008, 0.05, 1]), flowerSize=1, translucency,
 *         castShadow=true, materials (a createMaterials(ctx) library to share), budTint
 *   update extra: { swayTime (time-warped wind clock, e.g. for a hush), still (0..1 damping), bloom (override), windGain }
 */
export function createPlumBranch(ctx, opts = {}) {
  const THREE = ctx.THREE || THREE_NS;
  const o = { seed: 'plum-branch', length: 0.6, twigs: 6, bloom: 'world', lod: 'mid', ...opts };
  const rng = makeRng(hashString('plumBranch:' + o.seed));
  const skel = branchSkeleton(rng, o);
  const plant = buildPlant(ctx, skel, o, rng, 'branch:' + o.seed);
  applyAnchor(THREE, plant.group, o.anchor);
  plant.group.updateMatrixWorld(true);
  return makeApi(THREE, plant, o);
}

/**
 * createPlumTree(ctx, opts) -> same API as createPlumBranch
 *   opts: seed, height=5 (m), lod: 'far' (flowers as camera-facing cards) | 'mid' | 'macro' (all geometry),
 *         detail: { center:[x,y,z] (WORLD), radius } with lod 'far' -> flowers inside get real 'mid' geometry,
 *         anchor, bloom, openTimes, maxFlowers=5000, trunkRadius, spread, lean:[x,0,z], limbBias:[x,y,z],
 *         swayAmp (default [0.045, 0.022, 0.07, 1]), castShadow
 */
export function createPlumTree(ctx, opts = {}) {
  const THREE = ctx.THREE || THREE_NS;
  const o = { seed: 'plum-tree', height: 5, bloom: 'world', lod: 'far', swayAmp: [0.045, 0.022, 0.07, 1], ...opts };
  const rng = makeRng(hashString('plumTree:' + o.seed));
  const skel = treeSkeleton(rng, o);
  // detail centre is given in world space: convert to local using the anchor (translation + rotation)
  const tmp = new THREE.Group(); applyAnchor(THREE, tmp, o.anchor); tmp.updateMatrixWorld(true);
  if (o.detail) {
    const inv = new THREE.Matrix4().copy(tmp.matrixWorld).invert();
    const c = new THREE.Vector3().fromArray(o.detail.center).applyMatrix4(inv);
    o.detail = { center: c.toArray(), radius: o.detail.radius };
  }
  const plant = buildPlant(ctx, skel, o, rng, 'tree:' + o.seed);
  applyAnchor(THREE, plant.group, o.anchor);
  plant.group.updateMatrixWorld(true);
  return makeApi(THREE, plant, o);
}

/** the spring used for flower opening (JS mirror of plumSpring, for choreography) */
export function plumOpenCurve(tau) {
  if (tau <= 0) return 0;
  const z = 0.62, w = 8.5, wd = w * 0.7846, e = Math.exp(-z * w * tau);
  return 1 - e * (Math.cos(wd * tau) + 0.79021 * Math.sin(wd * tau));
}
