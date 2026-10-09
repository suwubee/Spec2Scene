// Author: suwubee
// engine/post.js — HDR (half-float, linear) cinematic post pipeline.
//
//   scene RT (W×H, half-float + depth)
//     ├─ DOF: prefilter (½ res: colour + signed CoC from depth) → near-CoC tiles (max) → dilate
//     │        → gather (rings; 8/24/48 taps adaptive, 24 max in preview; separate near layer with
//     │          coverage alpha → foreground bleed) → fill (hole-filling ring) ⇒ D (rgb) + β (blend)
//     ├─ bloom: dual-filter (Kawase/Bjørge) 6 levels from ¼ res, energy-conserving lerp;
//     │        alpha channel carries thresholded highlights ⇒ halation (red-orange, wide)
//     ├─ anamorphic streaks: thresholded highlights, 3 horizontal passes (1,6,36 texel steps)
//     ├─ glow (¼ res): bloom·k·exposure + halation + streaks pre-combined (1 fetch in the final pass)
//     └─ final (to canvas): gate weave → barrel distortion + lateral CA → DOF composite (+ softness,
//        highlight bleed) → exposure/WB, bloom lerp, glow add → vignette (cos⁴ + optical) →
//        3D LUT (filmic per-channel tonescale with soft shoulder & toe → sRGB → LGG, contrast,
//        split-tone, saturation, lifted teal black floor; baked on the CPU when params change)
//        → fade → film grain (luma-dependent, ~1.2 px, hashed by frame) → TPDF dither → lyrics
//        overlay (1:1 texels, bbox only). Letterbox bars stay pure black.
//
// Everything is a pure function of (inputs, params, frameIndex). No time queries, no randomness.
import * as THREE from './vendor/three.module.js';
import { GLSL_HASH } from './noise.js';
import { deepMerge, clamp } from './util.js';

// ---------------------------------------------------------------------------------------------
// Default parameters (the "house look"). Timeline `post:{}` / `grade:{}` and world.exposureBias
// override these per shot. All colours are LINEAR unless noted.
// ---------------------------------------------------------------------------------------------
export const DEFAULT_POST = {
  exposure: 0.0,                 // EV (stops) applied to scene-linear
  whiteBalance: [1, 1, 1],       // linear gains (see util.whiteBalance(K))
  dof: {
    enabled: true,
    scale: 1.0,                  // artistic multiplier on the physical CoC
    maxRadius: 32,               // max CoC radius in px @1080p-reference (clamped)
    sensorWidth: 24.89,          // mm (Super-35)
  },
  bloom: { strength: 0.045, radius: 0.78 },               // lerp weight; radius = upsample mix (0..1)
  halation: { strength: 0.10, threshold: 0.9, tint: [1.0, 0.28, 0.06] },
  streak: { strength: 0.25, threshold: 10.0, tint: [0.22, 0.45, 1.0], atten: 0.955 },
  lens: {
    distortion: 0.018,           // barrel, fractional displacement at the corner
    ca: 1.2,                     // lateral chromatic aberration, px at the corner (@1080p ref)
    cos4: 0.85,                  // natural (cos⁴) vignetting weight
    vignette: 0.22,              // extra optical vignette amount
    vignetteStart: 0.45,         // normalised radius where extra vignette starts (0 centre..1 corner)
    softness: 0.08,              // blend toward the ½-res image (diffusion / old glass)
    highlightSoft: 0.7,          // extra blend for very bright pixels (kills HDR edge stair-steps, lens bleed)
  },
  tone: {                        // matches LIB_COMMON §2: moonlit albedo-0.5 (0.035) → ~21 % display, 0.18 → ~44 %
    contrast: 1.14,              // power of the tonescale (slope in log space)
    mid: 0.145,                  // display-linear value of scene 0.18 at exposure 0
    peak: 1.0,                   // asymptotic display white (>=1)
    toe: 0.005,                  // toe crush
  },
  grade: {
    lift: [0.0, 0.0, 0.0],       // display-space LGG
    gamma: [1.0, 1.0, 1.0],
    gain: [1.0, 1.0, 1.0],
    saturation: 0.86,
    split: 0.08,                 // split-tone amount
    splitBalance: 0.0,           // -0.5..0.5 moves the shadow/highlight pivot
    shadowTint: [0.10, 0.42, 0.52],   // teal
    highlightTint: [1.0, 0.72, 0.45], // warm
    blackFloor: [0.030, 0.050, 0.058],// display (sRGB 0..1) lifted teal black
    contrast: 1.0,               // display-space contrast around 0.45
  },
  grain: { amount: 0.030, size: 1.2, chroma: 0.22 },  // size in px @1080p ref
  dither: 1.0,
  weave: 0.25,                   // gate weave amplitude in px @1080p ref
  fade: 1.0,                     // 0 black .. 1 full picture (display-space)
  debug: 0,                      // 0 off, 1 DOF β, 3 glow (bloom+halation+streak), 5 linear (no LUT)
};

export function mergePost(...ps) { return deepMerge(DEFAULT_POST, ...ps); }

// ---------------------------------------------------------------------------------------------
const VS = /* glsl */ `
out vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const HEAD = /* glsl */ `
precision highp float; precision highp int;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
`;

// ---- DOF prefilter: ½ res colour (2×2 box) + signed CoC radius (½-res px) of the NEAREST depth ----
const FS_PREFILTER = HEAD + /* glsl */ `
uniform sampler2D tColor; uniform sampler2D tDepth;
uniform vec4 uLens;      // x focus dist (m), y CoC scale (½-res px radius at infinity), z near, w far
uniform float uMaxCoc;
float linZ(float d){ float z = d * 2.0 - 1.0; return 2.0 * uLens.z * uLens.w / (uLens.w + uLens.z - z * (uLens.w - uLens.z)); }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  ivec2 mx = textureSize(tDepth, 0) - 1;
  float d = min(min(texelFetch(tDepth, min(p, mx), 0).r, texelFetch(tDepth, min(p + ivec2(1, 0), mx), 0).r),
                min(texelFetch(tDepth, min(p + ivec2(0, 1), mx), 0).r, texelFetch(tDepth, min(p + ivec2(1, 1), mx), 0).r));
  float z = d >= 1.0 ? 1e6 : linZ(d);
  float coc = uLens.y * (1.0 - uLens.x / max(z, 1e-3));
  coc = clamp(coc, -uMaxCoc, uMaxCoc);
  vec3 c = textureLod(tColor, vUv, 0.0).rgb;
  c = clamp(c, vec3(0.0), vec3(30000.0));
  if (any(isnan(c))) c = vec3(0.0);
  fragColor = vec4(c, coc);
}`;

// ---- near-CoC tile max (8×8 ½-res px per tile) ----
const FS_TILEMAX = HEAD + /* glsl */ `
uniform sampler2D tA;
void main(){
  ivec2 base = ivec2(gl_FragCoord.xy) * 8; ivec2 mx = textureSize(tA, 0) - 1;
  float m = 0.0;
  for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) m = max(m, -texelFetch(tA, min(base + ivec2(x, y), mx), 0).a);
  fragColor = vec4(m, 0.0, 0.0, 1.0);
}`;

// ---- dilate tiles (max over ±DIL tiles) ----
const FS_DILATE = HEAD + /* glsl */ `
uniform sampler2D tT;
uniform int uDilation;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy); ivec2 mx = textureSize(tT, 0) - 1;
  float m = 0.0;
  for (int y = -DIL; y <= DIL; y++) for (int x = -DIL; x <= DIL; x++) {
    if (abs(x) <= uDilation && abs(y) <= uDilation) m = max(m, texelFetch(tT, clamp(p + ivec2(x, y), ivec2(0), mx), 0).r);
  }
  fragColor = vec4(m, 0.0, 0.0, 1.0);
}`;

// ---- gather: scatter-as-gather bokeh with a separate near layer ----
//  weights ∝ coverage / CoC² (a defocused point spreads its energy over its disc → highlights keep
//  their energy); background samples behind the centre are clamped (no bleeding over sharp
//  foreground); near samples form a layer whose coverage alpha lets blurred foreground bleed over
//  in-focus background.
const FS_GATHER = HEAD + GLSL_HASH + /* glsl */ `
uniform sampler2D tA; uniform sampler2D tTile;
uniform vec2 uTexel; uniform float uMaxCoc; uniform float uFrame;
uniform vec3 uTaps[NTAPS];
void main(){
  ivec2 pc = ivec2(gl_FragCoord.xy);
  ivec2 mx = textureSize(tA, 0) - 1;
  vec4 C = texelFetch(tA, pc, 0);
  float cocC = C.a;
  float nearT = textureLod(tTile, vUv, 0.0).r;
  float R = min(max(abs(cocC), nearT), uMaxCoc);
  if (R < 0.5) { fragColor = vec4(C.rgb, 0.0); return; }
  float ang = mvIGN(gl_FragCoord.xy + uFrame * 5.588238) * 6.2831853;
  float ca = cos(ang), sa = sin(ang);
  vec3 bgS = vec3(0.0); float bgW = 0.0;
  vec3 nS = vec3(0.0); float nW = 0.0;
  float cc2 = max(cocC * cocC, 1.0);
  if (cocC < -0.5) { nS += C.rgb / cc2; nW += 1.0 / cc2; }
  else { bgS += C.rgb / cc2; bgW += 1.0 / cc2; }
  float cmax = max(cocC, 0.0) * 2.0 + 1.0;
  // adaptive ring count: small kernels need fewer taps (ring j has 8j taps)
  float rings = R < 2.5 ? 1.0 : (R < 6.0 || RINGS < 3 ? min(2.0, float(RINGS)) : float(RINGS));
  int ntap = rings < 1.5 ? 8 : (rings < 2.5 ? 24 : 48);
  float rstep = R / rings;
  for (int i = 0; i < NTAPS; i++) {
    if (i >= ntap) break;
    vec3 tp = uTaps[i];
    vec2 dir = vec2(tp.x * ca - tp.y * sa, tp.x * sa + tp.y * ca);
    float r = tp.z * rstep;
    vec4 S = texelFetch(tA, clamp(pc + ivec2(floor(dir * r + 0.5)), ivec2(0), mx), 0); // nearest: ~5x cheaper than bilinear half-float on SwiftShader
    float cs = S.a;
    if (cs < -0.5) {
      float w = clamp(-cs - r + 1.0, 0.0, 1.0) / (cs * cs);
      nS += S.rgb * w; nW += w;
    } else {
      float csb = cs > cocC ? min(cs, cmax) : cs;
      float w = clamp(abs(csb) - r + 1.0, 0.0, 1.0) / max(csb * csb, 1.0);
      bgS += S.rgb * w; bgW += w;
    }
  }
  float alpha = clamp(nW * R * R / float(ntap + 1), 0.0, 1.0);
  vec3 bg = bgW > 0.0 ? bgS / bgW : C.rgb;
  vec3 nearC = nW > 0.0 ? nS / nW : bg;
  float b = smoothstep(0.35, 1.35, abs(cocC));
  float beta = 1.0 - (1.0 - b) * (1.0 - alpha);
  vec3 D = beta > 1e-4 ? (bg * b * (1.0 - alpha) + nearC * alpha) / beta : bg;
  fragColor = vec4(D, beta);
}`;

// ---- fill: small premultiplied ring blur scaled by the kernel radius ----
const FS_FILL = HEAD + /* glsl */ `
uniform sampler2D tB; uniform sampler2D tA; uniform sampler2D tTile;
uniform vec2 uTexel; uniform float uMaxCoc; uniform float uFillK;
void main(){
  ivec2 pc = ivec2(gl_FragCoord.xy);
  ivec2 mx = textureSize(tB, 0) - 1;
  vec4 D = texelFetch(tB, pc, 0);
  float cocC = texelFetch(tA, pc, 0).a;
  float nearT = textureLod(tTile, vUv, 0.0).r;
  float R = min(max(abs(cocC), nearT), uMaxCoc);
  float s = R * uFillK;
  if (s < 0.5) { fragColor = D; return; }
  vec4 acc = vec4(D.rgb * D.a, D.a) * 2.0; float ws = 2.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.78539816 + 0.3927;
    vec4 S = texelFetch(tB, clamp(pc + ivec2(floor(vec2(cos(a), sin(a)) * s + 0.5)), ivec2(0), mx), 0);
    acc += vec4(S.rgb * S.a, S.a); ws += 1.0;
  }
  acc /= ws;
  fragColor = vec4(acc.a > 1e-4 ? acc.rgb / acc.a : D.rgb, acc.a);
}`;

// ---- bloom level 1 (¼ res) from the DOF composite (single layer) or from a full-res image ----
const FS_BLOOM1 = HEAD + /* glsl */ `
uniform sampler2D tA; uniform sampler2D tC; uniform sampler2D tImg; uniform sampler2D tFx;
uniform vec2 uSrcTexel; uniform float uExposure; uniform float uHalThresh;
vec3 comp(vec2 uv){
#ifdef FROM_IMAGE
  return textureLod(tImg, uv, 0.0).rgb;
#else
  vec4 a = textureLod(tA, uv, 0.0); vec4 c = textureLod(tC, uv, 0.0); vec3 d = mix(a.rgb, c.rgb, c.a);
#ifdef USE_FX
  vec4 fx = textureLod(tFx, uv, 0.0); d = d * (1.0 - fx.a) + fx.rgb;   // post-DOF particles bloom too
#endif
  return d;
#endif
}
void main(){
  vec2 o = uSrcTexel;
  vec3 s = comp(vUv) * 4.0 + comp(vUv + vec2(-o.x, -o.y)) + comp(vUv + vec2(o.x, -o.y)) + comp(vUv + vec2(-o.x, o.y)) + comp(vUv + vec2(o.x, o.y));
  s *= 0.125;
  s = max(s, vec3(0.0));
  float l = dot(s, LUMA) * uExposure;
  float e = max(l - uHalThresh, 0.0);
  fragColor = vec4(s, e * e / (e + uHalThresh + 1e-3));
}`;

const FS_DOWN = HEAD + /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uSrcTexel;
void main(){
  vec2 o = uSrcTexel;
  vec4 s = textureLod(tSrc, vUv, 0.0) * 4.0 + textureLod(tSrc, vUv + vec2(-o.x, -o.y), 0.0) + textureLod(tSrc, vUv + vec2(o.x, -o.y), 0.0)
         + textureLod(tSrc, vUv + vec2(-o.x, o.y), 0.0) + textureLod(tSrc, vUv + vec2(o.x, o.y), 0.0);
  fragColor = s * 0.125;
}`;

const FS_UP = HEAD + /* glsl */ `
uniform sampler2D tLow; uniform sampler2D tCur; uniform vec2 uLowTexel; uniform float uRadius;
void main(){
  vec2 o = uLowTexel;
  vec4 s = textureLod(tLow, vUv + vec2(-o.x, 0.0), 0.0) + textureLod(tLow, vUv + vec2(o.x, 0.0), 0.0)
         + textureLod(tLow, vUv + vec2(0.0, -o.y), 0.0) + textureLod(tLow, vUv + vec2(0.0, o.y), 0.0)
         + 2.0 * (textureLod(tLow, vUv + 0.5 * vec2(-o.x, -o.y), 0.0) + textureLod(tLow, vUv + 0.5 * vec2(o.x, -o.y), 0.0)
                + textureLod(tLow, vUv + 0.5 * vec2(-o.x, o.y), 0.0) + textureLod(tLow, vUv + 0.5 * vec2(o.x, o.y), 0.0));
  s /= 12.0;
  fragColor = mix(textureLod(tCur, vUv, 0.0), s, uRadius);
}`;

const FS_STREAK_PRE = HEAD + /* glsl */ `
uniform sampler2D tSrc; uniform float uExposure; uniform float uThresh;
void main(){
  vec3 c = textureLod(tSrc, vUv, 0.0).rgb * uExposure;
  float l = max(max(c.r, c.g), c.b);
  float e = max(l - uThresh, 0.0);
  e = e * e / (e + uThresh);
  fragColor = vec4(min(e, 4000.0), 0.0, 0.0, 1.0);
}`;

const FS_STREAK = HEAD + /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uStep; uniform vec4 uW; // weights for |k| = 0..3 (normalised)
void main(){
  float dx = uStep * uTexel.x;
  float acc = uW.x * textureLod(tSrc, vUv, 0.0).r;
  acc += uW.y * (textureLod(tSrc, vUv + vec2(dx, 0.0), 0.0).r + textureLod(tSrc, vUv - vec2(dx, 0.0), 0.0).r);
  acc += uW.z * (textureLod(tSrc, vUv + vec2(2.0 * dx, 0.0), 0.0).r + textureLod(tSrc, vUv - vec2(2.0 * dx, 0.0), 0.0).r);
  acc += uW.w * (textureLod(tSrc, vUv + vec2(3.0 * dx, 0.0), 0.0).r + textureLod(tSrc, vUv - vec2(3.0 * dx, 0.0), 0.0).r);
  fragColor = vec4(acc, 0.0, 0.0, 1.0);
}`;

// ---- glow (¼ res): pre-combined additive light = bloom·k·exposure + halation + streak ----
const FS_GLOW = HEAD + /* glsl */ `
uniform sampler2D tBloom; uniform sampler2D tStreak;
uniform vec3 uBloomK;       // bloom strength * exposure * WB
uniform vec3 uHal;          // halation tint * strength
uniform vec3 uStreak;       // streak tint * strength
void main(){
  vec4 b = textureLod(tBloom, vUv, 0.0);
  float st = textureLod(tStreak, vUv, 0.0).r;
  vec3 g = max(b.rgb * uBloomK + uHal * b.a + uStreak * st, vec3(0.0));
  fragColor = vec4(sqrt(g / (g + 1.0)), 1.0); // RGBA8 storage: 8-bit bilinear is ~2.5x cheaper than half-float
}`;

// Per-layer lens composite (ALL frames go through it: single shots = one layer of weight 1, dissolves = two).
// DOF mix (+ softness / highlight bleed) → FX layer → this layer's exposure × WB × gain → this lens's vignette
// → × weight, additively accumulated. Everything shared (bloom, streaks, CA/distortion, LUT, grain) then runs once
// on the accumulated image, so a dissolve at weight → 0 / 1 is continuous with the single-layer frames.
const FS_LAYER = HEAD + /* glsl */ `
uniform sampler2D tSharp; uniform sampler2D tDof; uniform sampler2D tFx;
uniform float uWeight; uniform float uUseDof; uniform float uUseFx;
uniform vec3 uExpWB;        // 2^EV * WB * layer gain
uniform float uSoft; uniform float uHiSoft;
uniform vec4 uVig;          // cos4 weight, tanHalfFovY, extra amount, extra start
uniform float uAspect;
uniform int uDebugBeta;
void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec3 s = texelFetch(tSharp, px, 0).rgb;
  s = clamp(s, vec3(0.0), vec3(30000.0)); if (any(isnan(s))) s = vec3(0.0);
  vec3 c = s; float beta = 0.0;
  if (uUseDof > 0.5) {
    vec4 d = textureLod(tDof, vUv, 0.0);
    float hl = max(dot(s, LUMA), dot(d.rgb, LUMA)) * uExpWB.g;
    beta = max(max(d.a, uSoft), uHiSoft * smoothstep(0.8, 5.0, hl));
    c = mix(s, d.rgb, beta);
  }
  if (uUseFx > 0.5) { vec4 fx = texelFetch(tFx, px, 0); c = c * (1.0 - fx.a) + fx.rgb; }
  c *= uExpWB;
  // vignette of THIS lens: cos^4 (real FOV) + optical falloff
  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0) * 2.0;
  float tt = length(q) * uVig.y;
  float c4 = 1.0 / ((1.0 + tt * tt) * (1.0 + tt * tt));
  float dn = length((vUv - 0.5) * 2.0) * 0.70710678;
  float v2 = smoothstep(uVig.w, 1.08, dn);
  c *= mix(1.0, c4, uVig.x) * (1.0 - uVig.z * v2 * sqrt(v2));
  c = clamp(c, vec3(0.0), vec3(30000.0)); if (any(isnan(c))) c = vec3(0.0);
  if (uDebugBeta == 1) c = vec3(beta);
  fragColor = vec4(c * uWeight, 1.0);
}`;

// weighted scene copy for sub-frame (motion blur) accumulation — additive blending into the MB target
const FS_MBACC = HEAD + /* glsl */ `
uniform sampler2D tSrc; uniform float uW;
void main(){
  vec3 c = texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0).rgb;
  c = clamp(c, vec3(0.0), vec3(30000.0)); if (any(isnan(c))) c = vec3(0.0);
  fragColor = vec4(c * uW, uW);
}`;

// copy the (resolved) scene depth into the FX target's depth buffer (colour writes off)
const FS_DEPTHCOPY = HEAD + /* glsl */ `
uniform sampler2D tDepth;
void main(){ gl_FragDepth = texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0).r; fragColor = vec4(0.0); }`;

// LUT input shaping: log2 over [LUT_LO, LUT_HI] stops (exposed scene-linear)
const LUT_N = 33, LUT_LO = -12.5, LUT_HI = 8.5;

// Picture pass (viewport = picture rect). Branch-light on purpose: on SwiftShader code after an
// early return in a large shader is still paid for, so debug views are compile-time variants and
// bars / lyrics are separate cheap draws.
// DEVELOP (per layer): lens distortion + CA on this layer's composite, its bloom/halation/streak glow, its own grade
// LUT → display-referred colour × weight, added into the display accumulator. A dissolve is thus an editorial
// (display-space) crossfade of two fully developed shots: mean luma is linear in the weight, no bump.
const FS_DEVELOP = HEAD + /* glsl */ `
uniform sampler2D tSharp; uniform sampler2D tGlow;
uniform highp sampler3D tLut;
uniform vec2 uWeave;        // picture uv offset
uniform vec4 uDist;         // k (barrel), 1/(1+k r2max), caR, caB (fraction at corner)
uniform float uAspect;
uniform float uImgK;        // 1 - bloom strength (the image is already exposed)
uniform float uWeight;
vec3 srgbEncode(vec3 c){
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main(){
  vec2 pic = vUv + uWeave;
  vec2 p = (pic - 0.5) * vec2(uAspect, 1.0);
  float r2 = dot(p, p);
  float r2max = uAspect * uAspect * 0.25 + 0.25;
  vec2 pd = p * (1.0 + uDist.x * r2) * uDist.y;
  float cr = r2 / r2max;
  vec2 sc = vec2(1.0 / uAspect, 1.0);
  vec2 uvG = pd * sc + 0.5;
  vec2 uvR = pd * (1.0 + uDist.z * cr) * sc + 0.5;
  vec2 uvB = pd * (1.0 - uDist.w * cr) * sc + 0.5;
  vec3 col;
  if (cr > 0.2) col = vec3(textureLod(tSharp, uvR, 0.0).r, textureLod(tSharp, uvG, 0.0).g, textureLod(tSharp, uvB, 0.0).b);
  else col = textureLod(tSharp, uvG, 0.0).rgb;   // CA < ~0.25 px near the centre
  col = clamp(col, vec3(0.0), vec3(30000.0));
  vec3 ge = textureLod(tGlow, uvG, 0.0).rgb; ge *= ge;
  vec3 glow = ge / max(1.0 - ge, 1e-4);
  vec3 lin = col * uImgK + glow;
#if DEBUG == 1
  vec3 c = clamp(col, 0.0, 1.0);
#elif DEBUG == 3
  vec3 c = srgbEncode(glow);
#elif DEBUG == 5
  vec3 c = srgbEncode(lin);
#else
  vec3 u = clamp((log2(max(lin, vec3(1e-7))) - LUT_LO) * (1.0 / (LUT_HI - LUT_LO)), 0.0, 1.0);
  vec3 c = textureLod(tLut, u * ((LUT_N - 1.0) / LUT_N) + 0.5 / LUT_N, 0.0).rgb;
#endif
  fragColor = vec4(c * uWeight, uWeight);
}`;

// PRINT (once per frame): display accumulator → fade → film grain (luma-dependent, ~1.2 px, per frame) → TPDF dither.
const FS_PRINT = HEAD + GLSL_HASH + /* glsl */ `
uniform sampler2D tDisp;
uniform vec2 uPicOrigin;    // canvas px of the picture's lower-left corner
uniform float uFade;
uniform vec4 uGrain;        // amount, size(px), chroma, dither
uniform int uFrame;
uniform sampler2D tGrain;   // 512² seeded noise (baked once), bilinear → ~size-px grain
uniform vec4 uGrainXf;      // per-frame offset (uv) + flip signs, from the frame hash
vec3 grainAt(vec2 frag){
  vec2 gp = frag / (uGrain.y * 512.0);
  gp = gp * uGrainXf.zw + uGrainXf.xy;
  vec4 n = textureLod(tGrain, gp, 0.0) - 0.5;          // r,g,b ~ independent, a = luma (sum of 4)
  return vec3(n.a) * 2.2 + (n.rgb - n.gbr) * 0.9;
}
void main(){
  vec2 frag = gl_FragCoord.xy;
  vec3 c = texelFetch(tDisp, ivec2(frag - uPicOrigin), 0).rgb;
  c *= uFade;
#if DEBUG == 0
  vec3 g = grainAt(frag);
  float Lg = dot(c, LUMA);
  float resp = mix(0.5, 1.0, smoothstep(0.02, 0.22, Lg)) * mix(1.0, 0.35, smoothstep(0.55, 1.0, Lg));
  c += uGrain.x * resp * (vec3(g.x) + uGrain.z * (g - g.x));
  vec3 h = mvHashPixel(ivec2(frag), uFrame + 104729);
  c += (h.x + h.y - 1.0) / 255.0 * uGrain.w;
#endif
  fragColor = vec4(c, 1.0);
}`;

// Lyrics composite: a quad covering only the lyric bbox, premultiplied "over" blending.
const VS_BOX = /* glsl */ `
uniform vec4 uBox; // x0, y0, x1, y1 in canvas px (GL, y up)
uniform vec2 uCanvas;
void main(){ vec2 p = mix(uBox.xy, uBox.zw, position.xy * 0.5 + 0.5); gl_Position = vec4(p / uCanvas * 2.0 - 1.0, 0.0, 1.0); }`;
const FS_LYRICS = /* glsl */ `
precision highp float; precision highp int;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tLyrics; uniform float uCanvasH; uniform vec4 uBox;
void main(){
  // the draw is a triangle that over-covers the box: never read texels outside this frame's upload
  if (gl_FragCoord.x < uBox.x || gl_FragCoord.x >= uBox.z || gl_FragCoord.y < uBox.y || gl_FragCoord.y >= uBox.w) discard;
  vec4 l = texelFetch(tLyrics, ivec2(int(gl_FragCoord.x), int(uCanvasH - gl_FragCoord.y)), 0); // rows stored top-down
  fragColor = vec4(l.rgb * l.a, l.a);
}`;

// ---------------------------------------------------------------------------------------------
function makeTaps(rings) {
  const taps = [];
  for (let j = 1; j <= rings; j++) {
    const n = 8 * j;
    for (let k = 0; k < n; k++) {
      const a = ((k + (j % 2 ? 0 : 0.5)) / n) * Math.PI * 2;
      taps.push(new THREE.Vector3(Math.cos(a), Math.sin(a), j)); // z = ring index
    }
  }
  return taps;
}

/** Solve the tonescale constants: T(x) = s1*(x/(x+s0))^p, toe f²/(f+t0); T(0.18)=mid, T(∞)=peak */
export function solveTone({ contrast = 1.14, mid = 0.145, peak = 1.0, toe = 0.005 } = {}) {
  const t0 = Math.max(1e-5, toe);
  const s1 = (peak + Math.sqrt(peak * peak + 4 * peak * t0)) / 2; // s1²/(s1+t0) = peak
  const fm = (mid + Math.sqrt(mid * mid + 4 * mid * t0)) / 2;     // f with f²/(f+t0) = mid
  const p = Math.max(0.3, contrast);
  const s0 = 0.18 * (Math.pow(s1 / fm, 1 / p) - 1);
  return [p, s0, s1, t0];
}

const srgbEnc = (c) => { c = c < 0 ? 0 : c > 1 ? 1 : c; return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * The display transform as a pure JS function (exposed linear rgb → display sRGB 0..1), exactly what
 * the LUT bakes: filmic tonescale per channel → sRGB → LGG → contrast → split-tone → saturation →
 * lifted black floor. Useful for tests and for tuning.
 */
export function displayTransform(rgb, P) {
  const [p, s0, s1, t0] = solveTone(P.tone);
  const G = P.grade;
  const c = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const x = Math.max(0, rgb[k]);
    const f = s1 * Math.pow(x / (x + s0), p);
    let v = srgbEnc((f * f) / (f + t0));
    v = G.gain[k] * (v + G.lift[k] * (1 - v));
    v = Math.pow(Math.max(v, 0), 1 / G.gamma[k]);
    c[k] = (v - 0.45) * (G.contrast ?? 1) + 0.45;
  }
  const luma = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  let L = luma(c);
  const piv = 0.5 + G.splitBalance;
  const wS = 1 - sstep(0, piv, L), wH = sstep(piv, 1, L);
  const lS = luma(G.shadowTint), lH = luma(G.highlightTint);
  for (let k = 0; k < 3; k++) c[k] += G.split * (wS * (G.shadowTint[k] - lS) + wH * (G.highlightTint[k] - lH));
  L = luma(c);
  for (let k = 0; k < 3; k++) {
    let v = L + (c[k] - L) * G.saturation;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    c[k] = G.blackFloor[k] + (1 - G.blackFloor[k]) * v;
  }
  return c;
}

/**
 * createPost(renderer, {width, height, canvasWidth, canvasHeight, quality, msaa, renderScale})
 *   width/height: picture size in canvas px (e.g. 1920×804); canvas size for the final pass.
 */
export function createPost(renderer, opts) {
  const quality = opts.quality || 'final';
  // preview: internal picture width capped at 960 px (half of 1080p; full res for small canvases)
  let scale = opts.renderScale ?? (quality === 'preview' ? Math.min(1, 960 / opts.width) : 1.0);
  let PW = opts.width, PH = opts.height;                  // picture size on canvas
  let CW = opts.canvasWidth, CH = opts.canvasHeight;       // canvas size
  let iw = Math.max(2, Math.round(PW * scale)), ih = Math.max(2, Math.round(PH * scale));
  let hw = Math.ceil(iw / 2), hh = Math.ceil(ih / 2);
  let refScale = CH / 1080;                               // px scaling vs the 1080p reference
  const rings = quality === 'preview' ? 2 : 3;
  const taps = makeTaps(rings);
  const NTAPS = taps.length;
  const samples = opts.msaa ?? 0;
  const glc = renderer.getContext();

  // HDR target type: half-float (default, validated) or 'float' (32-bit; experiments only — needs
  // OES_texture_float_linear for bilinear taps, 2× memory/bandwidth).
  const HDR_TYPE = opts.hdrType === 'float' ? THREE.FloatType : THREE.HalfFloatType;
  const rtOpts = (extra = {}) => ({ type: HDR_TYPE, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, ...extra });
  const mk = (w, h, extra) => new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), rtOpts(extra));

  const depthTex = new THREE.DepthTexture(iw, ih, THREE.UnsignedIntType);
  depthTex.minFilter = depthTex.magFilter = THREE.NearestFilter;
  const sceneRT = mk(iw, ih, { depthBuffer: true, depthTexture: depthTex, samples });
  const accumRT = mk(iw, ih);   // this layer's composite (DOF, FX, exposure × WB × gain, vignette) — linear
  const dispRT = mk(PW, PH);    // display-referred accumulator: Σ weight × developed layer (picture resolution)
  const dofA = mk(hw, hh), dofB = mk(hw, hh), dofC = mk(hw, hh);
  let tw = Math.ceil(hw / 8), th = Math.ceil(hh / 8);
  const tileA = mk(tw, th), tileB = mk(tw, th);
  const LEVELS = quality === 'preview' ? 5 : 6;
  const down = [], up = [];
  let bw = hw, bh = hh;
  for (let i = 0; i < LEVELS; i++) {
    bw = Math.max(1, Math.ceil(bw / 2)); bh = Math.max(1, Math.ceil(bh / 2));
    down.push(mk(bw, bh));
    up.push(i < LEVELS - 1 ? mk(bw, bh) : null);
  }
  const stA = mk(down[0].width, down[0].height), stB = mk(down[0].width, down[0].height);
  const glowRT = mk(down[0].width, down[0].height, { type: THREE.UnsignedByteType });
  // post-DOF particle (FX layer) target: HalfFloat colour + its own depth buffer (scene depth copied in),
  // no MSAA; and the motion-blur accumulation target. Both allocated on first use.
  let fxRT = null, mbRT = null;
  const getFxRT = () => (fxRT || (fxRT = mk(iw, ih, { depthBuffer: true, stencilBuffer: false })));
  const getMbRT = () => (mbRT || (mbRT = mk(iw, ih)));

  // ---- lyrics texture: RGBA8, updated per frame only inside the drawn bbox (raw sub-image upload) ----
  const lyrTex = new THREE.DataTexture(new Uint8Array(CW * CH * 4), CW, CH, THREE.RGBAFormat, THREE.UnsignedByteType);
  lyrTex.minFilter = lyrTex.magFilter = THREE.NearestFilter;
  lyrTex.generateMipmaps = false; lyrTex.flipY = false; lyrTex.needsUpdate = true;
  const lyrBox = new THREE.Vector4(0, 0, 0, 0);
  let picY0 = Math.round((CH - PH) / 2);   // lower bar height (GL y of the picture's bottom row)

  // ---- grading LUTs (one per tone/grade key, small LRU: dissolves develop two shots per frame) ----
  const luts = new Map();
  function lutFor(P) {
    const key = JSON.stringify([P.tone, P.grade]);
    let L = luts.get(key);
    if (L) { luts.delete(key); luts.set(key, L); return L.tex; }           // refresh LRU order
    const data = new Uint8Array(LUT_N * LUT_N * LUT_N * 4);
    const q8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
    const xs = new Float64Array(LUT_N);
    for (let i = 0; i < LUT_N; i++) xs[i] = Math.pow(2, LUT_LO + (LUT_HI - LUT_LO) * (i / (LUT_N - 1)));
    const rgb = [0, 0, 0];
    let o = 0;
    for (let b = 0; b < LUT_N; b++) for (let g = 0; g < LUT_N; g++) for (let r = 0; r < LUT_N; r++) {
      rgb[0] = xs[r]; rgb[1] = xs[g]; rgb[2] = xs[b];
      const c = displayTransform(rgb, P);
      data[o++] = q8(c[0]); data[o++] = q8(c[1]); data[o++] = q8(c[2]); data[o++] = 255;
    }
    const tex = new THREE.Data3DTexture(data, LUT_N, LUT_N, LUT_N);
    tex.format = THREE.RGBAFormat; tex.type = THREE.UnsignedByteType; // 8-bit trilinear: ~4x cheaper than half-float
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false; tex.unpackAlignment = 1; tex.needsUpdate = true;
    luts.set(key, { tex });
    while (luts.size > 8) { const k0 = luts.keys().next().value; luts.get(k0).tex.dispose(); luts.delete(k0); }
    return tex;
  }

  // film-grain noise: 512², seeded (deterministic), rgb = independent uniform noise, a = their
  // normalised sum (≈gaussian luma grain). Sampled bilinearly at ~grain size, offset per frame.
  const grainTex = (() => {
    const N = 512, d = new Uint8Array(N * N * 4);
    let st = 0x9e3779b9;
    const rnd = () => { st = (st + 0x6d2b79f5) >>> 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = 0; i < N * N; i++) {
      const a = rnd(), b = rnd(), c = rnd(), e = rnd();
      d[i * 4] = Math.round(a * 255); d[i * 4 + 1] = Math.round(b * 255); d[i * 4 + 2] = Math.round(c * 255);
      d[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, 0.5 + ((a + b + c + e) - 2) * 0.5)) * 255);
    }
    const tex = new THREE.DataTexture(d, N, N);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
    return tex;
  })();
  const blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  blackTex.needsUpdate = true;

  let maxCocHalf = Math.max(2, Math.round(DEFAULT_POST.dof.maxRadius * scale * refScale / 2)); // ½-res px
  const DIL = 8; // Supports up to 4096px canvas height without changing a program key.

  const mat = (fs, uniforms, defines = {}) => new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: fs, uniforms, defines,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
  const U = (v) => ({ value: v });

  const M = {
    prefilter: mat(FS_PREFILTER, { tColor: U(null), tDepth: U(depthTex), uLens: U(new THREE.Vector4()), uMaxCoc: U(maxCocHalf) }),
    tilemax: mat(FS_TILEMAX, { tA: U(dofA.texture) }),
    dilate: mat(FS_DILATE, { tT: U(tileA.texture), uDilation: U(Math.ceil(maxCocHalf / 8)) }, { DIL }),
    gather: mat(FS_GATHER, { tA: U(dofA.texture), tTile: U(tileB.texture), uTexel: U(new THREE.Vector2(1 / hw, 1 / hh)), uMaxCoc: U(maxCocHalf), uFrame: U(0), uTaps: U(taps) }, { NTAPS, RINGS: rings }),
    fill: mat(FS_FILL, { tB: U(dofB.texture), tA: U(dofA.texture), tTile: U(tileB.texture), uTexel: U(new THREE.Vector2(1 / hw, 1 / hh)), uMaxCoc: U(maxCocHalf), uFillK: U(rings === 3 ? 0.16 : 0.2) }),
    bloom1: mat(FS_BLOOM1, { tA: U(dofA.texture), tC: U(dofC.texture), tImg: U(null), uSrcTexel: U(new THREE.Vector2(1 / hw, 1 / hh)), uExposure: U(1), uHalThresh: U(1) }),
    bloom1img: mat(FS_BLOOM1, { tA: U(null), tC: U(null), tImg: U(null), uSrcTexel: U(new THREE.Vector2(2 / iw, 2 / ih)), uExposure: U(1), uHalThresh: U(1) }, { FROM_IMAGE: 1 }),
    down: mat(FS_DOWN, { tSrc: U(null), uSrcTexel: U(new THREE.Vector2()) }),
    up: mat(FS_UP, { tLow: U(null), tCur: U(null), uLowTexel: U(new THREE.Vector2()), uRadius: U(0.8) }),
    streakPre: mat(FS_STREAK_PRE, { tSrc: U(null), uExposure: U(1), uThresh: U(3) }),
    streak: mat(FS_STREAK, { tSrc: U(null), uTexel: U(new THREE.Vector2(1 / stA.width, 1 / stA.height)), uStep: U(1), uW: U(new THREE.Vector4()) }),
    glow: mat(FS_GLOW, { tBloom: U(null), tStreak: U(null), uBloomK: U(new THREE.Vector3()), uHal: U(new THREE.Vector3()), uStreak: U(new THREE.Vector3()) }),
    layerPass: mat(FS_LAYER, { tSharp: U(sceneRT.texture), tDof: U(dofC.texture), tFx: U(null), uWeight: U(1), uUseDof: U(1), uUseFx: U(0),
      uExpWB: U(new THREE.Vector3(1, 1, 1)), uSoft: U(0), uHiSoft: U(0), uVig: U(new THREE.Vector4()), uAspect: U(PW / PH), uDebugBeta: U(0) }),
    mbacc: mat(FS_MBACC, { tSrc: U(sceneRT.texture), uW: U(1) }),
  };
  M.mbacc.blending = THREE.CustomBlending;
  M.mbacc.blendEquation = THREE.AddEquation; M.mbacc.blendSrc = THREE.OneFactor; M.mbacc.blendDst = THREE.OneFactor;
  M.depthCopy = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS_DEPTHCOPY, uniforms: { tDepth: U(depthTex) },
    depthTest: true, depthFunc: THREE.AlwaysDepth, depthWrite: true, colorWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
  M.layerPass.uniforms.tFx.value = blackTex;
  M.layerPass.blending = THREE.CustomBlending;
  M.layerPass.blendEquation = THREE.AddEquation; M.layerPass.blendSrc = THREE.OneFactor; M.layerPass.blendDst = THREE.OneFactor;
  const LUT_DEF = { LUT_N: LUT_N.toFixed(1), LUT_LO: LUT_LO.toFixed(2), LUT_HI: LUT_HI.toFixed(2) };
  const develops = new Map(); // variants: debug view
  function developMat(debug) {
    const key = `${debug | 0}`;
    if (!develops.has(key)) {
      const m = mat(FS_DEVELOP, {
        tSharp: U(accumRT.texture), tGlow: U(glowRT.texture), tLut: U(null),
        uWeave: U(new THREE.Vector2()), uDist: U(new THREE.Vector4()), uAspect: U(PW / PH), uImgK: U(1), uWeight: U(1),
      }, { ...LUT_DEF, DEBUG: debug | 0 });
      m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor;
      develops.set(key, m);
    }
    return develops.get(key);
  }
  const prints = new Map();
  function printMat(debug) {
    const key = `${debug ? 1 : 0}`;
    if (!prints.has(key)) prints.set(key, mat(FS_PRINT, {
      tDisp: U(dispRT.texture), uPicOrigin: U(new THREE.Vector2(0, picY0)), uFade: U(1), uGrain: U(new THREE.Vector4()), uFrame: U(0),
      tGrain: U(grainTex), uGrainXf: U(new THREE.Vector4(0, 0, 1, 1)),
    }, { DEBUG: debug ? 1 : 0 }));
    return prints.get(key);
  }
  M.lyrics = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VS_BOX, fragmentShader: FS_LYRICS,
    uniforms: { tLyrics: U(lyrTex), uCanvasH: U(CH), uBox: U(lyrBox), uCanvas: U(new THREE.Vector2(CW, CH)) },
    depthTest: false, depthWrite: false, transparent: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });

  // fullscreen triangle
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(geo, M.prefilter);
  quad.frustumCulled = false;
  const qScene = new THREE.Scene();
  qScene.add(quad);
  const qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const _px = new Uint8Array(4);
  function gpuSync() { renderer.setRenderTarget(null); glc.readPixels(0, 0, 1, 1, glc.RGBA, glc.UNSIGNED_BYTE, _px); }
  function pass(material, target, name) {
    const prof = api.profile;
    let t0 = 0;
    if (prof) { gpuSync(); t0 = performance.now(); } // profiling only (never in normal rendering)
    quad.material = material;
    if (target !== null || renderer.getRenderTarget() !== null) renderer.setRenderTarget(target);
    const ac = renderer.autoClear;
    renderer.autoClear = false; // post passes cover their targets; the lyrics quad must not clear the canvas
    renderer.render(qScene, qCam);
    renderer.autoClear = ac;
    if (prof) { gpuSync(); const k = name || 'pass'; prof[k] = (prof[k] || 0) + performance.now() - t0; }
  }

  let layerCount = 0;

  /** CoC scale (½-res px radius at infinity) for a lens */
  function cocScaleFor(lens, P) {
    const f = lens.focal;                          // mm
    const N = Math.max(0.7, lens.fstop);
    const S1 = Math.max(lens.distance * 1000, f * 1.05); // mm
    const sensorH = (P.dof.sensorWidth || 24.89) / (PW / PH);
    const diam = (f * f) / (N * (S1 - f));         // mm on sensor
    return (diam / sensorH) * ih * 0.25 * (P.dof.scale ?? 1) * (lens.dofScale ?? 1);
  }

  /** upload the lyric overlay (CPU canvas) — only its bounding box */
  function uploadLyrics(canvas2d, box) {
    if (!box) { lyrBox.set(0, 0, 0, 0); return; }
    const x0 = Math.max(0, Math.floor(box.x0)), y0 = Math.max(0, Math.floor(box.y0));
    const x1 = Math.min(CW, Math.ceil(box.x1)), y1 = Math.min(CH, Math.ceil(box.y1));
    if (x1 <= x0 || y1 <= y0) { lyrBox.set(0, 0, 0, 0); return; }
    const img = canvas2d.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0);
    // make sure three created the texture, then sub-upload through three's state (keeps its cache valid)
    renderer.initTexture(lyrTex);
    const glTex = renderer.properties.get(lyrTex).__webglTexture;
    const state = renderer.state;
    state.activeTexture(glc.TEXTURE0);
    state.bindTexture(glc.TEXTURE_2D, glTex);
    glc.pixelStorei(glc.UNPACK_FLIP_Y_WEBGL, false);
    glc.pixelStorei(glc.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    glc.pixelStorei(glc.UNPACK_ALIGNMENT, 4);
    glc.texSubImage2D(glc.TEXTURE_2D, 0, x0, y0, x1 - x0, y1 - y0, glc.RGBA, glc.UNSIGNED_BYTE, img.data);
    // GL-space bbox (y up): canvas rows y0..y1 (top-down) ↔ GL rows CH-y1 .. CH-y0
    lyrBox.set(x0, CH - y1, x1, CH - y0);
  }

  /** bloom/streaks/glow + develop pass for the current accumRT content (one layer), added into dispRT × weight */
  function develop(P, weight, weave) {
    const glowOn=P.bloom.strength>0||P.halation.strength>0||P.streak.strength>0;
    if(glowOn) {
    // --- bloom chain from the accumulated composite (already exposed per layer) ---
    const b1 = M.bloom1img;
    b1.uniforms.tImg.value = accumRT.texture;
    b1.uniforms.uExposure.value = 1;
    b1.uniforms.uHalThresh.value = P.halation.threshold;
    pass(b1, down[0], 'bloom');
    for (let i = 1; i < LEVELS; i++) {
      M.down.uniforms.tSrc.value = down[i - 1].texture;
      M.down.uniforms.uSrcTexel.value.set(1 / down[i - 1].width, 1 / down[i - 1].height);
      pass(M.down, down[i], 'bloom');
    }
    M.up.uniforms.uRadius.value = P.bloom.radius;
    for (let i = LEVELS - 2; i >= 0; i--) {
      const low = i === LEVELS - 2 ? down[LEVELS - 1] : up[i + 1];
      M.up.uniforms.tLow.value = low.texture;
      M.up.uniforms.tCur.value = down[i].texture;
      M.up.uniforms.uLowTexel.value.set(1 / low.width, 1 / low.height);
      pass(M.up, up[i], 'bloom');
    }
    // --- streaks ---
    const streakOn = P.streak.strength > 0;
    let streakTex = blackTex;
    if (streakOn) {
      M.streakPre.uniforms.tSrc.value = down[0].texture;
      M.streakPre.uniforms.uExposure.value = 1;
      M.streakPre.uniforms.uThresh.value = P.streak.threshold;
      pass(M.streakPre, stA, 'streak');
      let src = stA, dst = stB;
      for (const s of [1, 6, 36]) {
        M.streak.uniforms.tSrc.value = src.texture;
        M.streak.uniforms.uStep.value = s;
        const w = [0, 1, 2, 3].map((k) => Math.pow(P.streak.atten, k * s));
        const n = w[0] + 2 * (w[1] + w[2] + w[3]);
        M.streak.uniforms.uW.value.set(w[0] / n, w[1] / n, w[2] / n, w[3] / n);
        pass(M.streak, dst, 'streak');
        const tmp = src; src = dst; dst = tmp;
      }
      streakTex = src.texture;
    }
    // --- glow = bloom·k·exp·WB + halation + streak (¼ res) ---
    const kB = P.bloom.strength;
    const G = M.glow.uniforms;
    G.tBloom.value = up[0].texture; G.tStreak.value = streakTex;
    G.uBloomK.value.set(kB, kB, kB);
    G.uHal.value.fromArray(P.halation.tint).multiplyScalar(P.halation.strength);
    G.uStreak.value.fromArray(P.streak.tint).multiplyScalar(streakOn ? P.streak.strength : 0);
    pass(M.glow, glowRT, 'glow');
    }
    // --- develop pass: lens + glow + this layer's LUT → display accumulator (× weight) ---
    const F = developMat(P.debug | 0);
    const u = F.uniforms;
    u.tSharp.value = accumRT.texture;
    u.tGlow.value = glowOn ? glowRT.texture : blackTex;
    u.tLut.value = lutFor(P);
    u.uWeight.value = weight;
    u.uWeave.value.set((weave[0] * P.weave * refScale) / PW, (weave[1] * P.weave * refScale) / PH);
    const aspect = PW / PH;
    const r2max = aspect * aspect * 0.25 + 0.25;
    const k = P.lens.distortion / Math.max(1e-6, r2max);
    const halfDiag = 0.5 * Math.hypot(PW, PH);
    u.uDist.value.set(k, 1 / (1 + k * r2max), (P.lens.ca * refScale) / halfDiag, (P.lens.ca * refScale * 0.6) / halfDiag);
    u.uImgK.value = 1 - P.bloom.strength;
    renderer.setViewport(0, 0, PW, PH);
    pass(F, dispRT, 'develop');
    api._lastDevelop = F;
  }

  const api = {
    profile: null,
    sceneTarget: sceneRT,
    depthTexture: depthTex,
    internalSize: { width: iw, height: ih },
    quality,
    NTAPS,
    uploadLyrics,
    /** Resize storage, preserving materials, program keys, targets and MSAA. */
    resize({width, height, canvasWidth, canvasHeight, renderScale = scale}) {
      if (![width,height,canvasWidth,canvasHeight].every(n => Number.isInteger(n) && n >= 2 && n <= 4096) || !(renderScale > 0 && renderScale <= 1)) throw new RangeError('post dimensions out of bounds');
      PW=width; PH=height; CW=canvasWidth; CH=canvasHeight; scale=renderScale;
      iw=Math.max(2,Math.round(PW*scale)); ih=Math.max(2,Math.round(PH*scale));
      hw=Math.ceil(iw/2); hh=Math.ceil(ih/2); tw=Math.ceil(hw/8); th=Math.ceil(hh/8);
      refScale=CH/1080; picY0=Math.round((CH-PH)/2);
      maxCocHalf=Math.max(2,Math.round(DEFAULT_POST.dof.maxRadius*scale*refScale/2));
      renderer.setRenderTarget(null);
      for(const rt of [sceneRT,accumRT,fxRT,mbRT]) rt?.setSize(iw,ih);
      dispRT.setSize(PW,PH);
      for(const rt of [dofA,dofB,dofC]) rt.setSize(hw,hh);
      for(const rt of [tileA,tileB]) rt.setSize(tw,th);
      let w=hw,h=hh;
      for(let i=0;i<LEVELS;i++){w=Math.max(1,Math.ceil(w/2));h=Math.max(1,Math.ceil(h/2));down[i].setSize(w,h);up[i]?.setSize(w,h);}
      for(const rt of [stA,stB,glowRT]) rt.setSize(down[0].width,down[0].height);
      for(const name of ['gather','fill']) M[name].uniforms.uTexel.value.set(1/hw,1/hh);
      M.dilate.uniforms.uDilation.value=Math.min(DIL,Math.ceil(maxCocHalf/8));
      M.bloom1.uniforms.uSrcTexel.value.set(1/hw,1/hh);
      M.bloom1img.uniforms.uSrcTexel.value.set(2/iw,2/ih);
      M.streak.uniforms.uTexel.value.set(1/stA.width,1/stA.height);
      M.layerPass.uniforms.uAspect.value=PW/PH;
      for(const m of develops.values())m.uniforms.uAspect.value=PW/PH;
      for(const m of prints.values())m.uniforms.uPicOrigin.value.set(0,picY0);
      if(lyrTex.image.width!==CW||lyrTex.image.height!==CH){lyrTex.dispose();lyrTex.image={data:new Uint8Array(CW*CH*4),width:CW,height:CH};lyrTex.needsUpdate=true;}
      lyrBox.set(0,0,0,0);M.lyrics.uniforms.uCanvasH.value=CH;M.lyrics.uniforms.uCanvas.value.set(CW,CH);
      Object.assign(api.internalSize,{width:iw,height:ih});
      return api.internalSize;
    },
    get renderTargets(){return [sceneRT,accumRT,dispRT,fxRT,mbRT,dofA,dofB,dofC,tileA,tileB,stA,stB,glowRT,...down,...up].filter(Boolean);},

    /** begin a new frame */
    begin() { layerCount = 0; },

    /** FX (layer 7) target: set as render target, cleared to 0, scene depth copied into its depth buffer. */
    fxBegin() {
      const rt = getFxRT();
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      const ac = renderer.autoClear; renderer.autoClear = false;
      quad.material = M.depthCopy; renderer.render(qScene, qCam);
      renderer.autoClear = ac;
      return rt;
    },
    get fxTarget() { return getFxRT(); },

    /** motion blur: add sceneTarget (weight 1/count) into the MB accumulation target; index 0 clears it */
    accumulateScene(index, count) {
      const rt = getMbRT();
      if (index === 0) { renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false); }
      M.mbacc.uniforms.uW.value = 1 / count;
      pass(M.mbacc, rt, 'mb.accumulate');
      return rt.texture;
    },

    /**
     * Process the current contents of sceneTarget as one layer.
     * layer: { lens:{focal(mm), fstop, distance(m), near, far, dofScale} | null, weight, gain, params, frame, multi }
     */
    layer(layer) {
      const P = layer.params;
      const dofOn = P.dof.enabled !== false && !!layer.lens;
      const color = layer.color || sceneRT.texture;          // scene colour (or the motion-blur accumulation)
      const fxOn = !!layer.fx && !!fxRT;
      api._color = color; api._fxOn = fxOn;
      if (dofOn) {
        const L = layer.lens;
        M.prefilter.uniforms.tColor.value = color;
        M.prefilter.uniforms.uLens.value.set(L.distance, cocScaleFor(L, P), L.near, L.far);
        const maxC = Math.max(1, Math.min(maxCocHalf, (P.dof.maxRadius ?? 32) * scale * refScale / 2));
        M.prefilter.uniforms.uMaxCoc.value = maxC;
        pass(M.prefilter, dofA, 'dof.prefilter');
        pass(M.tilemax, tileA, 'dof.tiles');
        pass(M.dilate, tileB, 'dof.tiles');
        M.gather.uniforms.uFrame.value = layer.frame % 1024;
        M.gather.uniforms.uMaxCoc.value = maxC;
        pass(M.gather, dofB, 'dof.gather');
        M.fill.uniforms.uMaxCoc.value = maxC;
        pass(M.fill, dofC, 'dof.fill');
      }
      api._dofOn = dofOn;
      // this layer's composite → accumRT (DOF mix, FX, exposure × WB × gain and vignette of THIS layer)
      renderer.setRenderTarget(accumRT); renderer.setClearColor(0x000000, 1); renderer.clear(true, false, false);
      const Lp = M.layerPass.uniforms;
      const e = Math.pow(2, P.exposure) * (layer.gain ?? 1), wb = P.whiteBalance;
      Lp.tSharp.value = color;
      Lp.uUseDof.value = dofOn ? 1 : 0;
      Lp.tFx.value = fxOn ? fxRT.texture : blackTex;
      Lp.uUseFx.value = fxOn ? 1 : 0;
      Lp.uWeight.value = 1;
      Lp.uExpWB.value.set(e * wb[0], e * wb[1], e * wb[2]);
      Lp.uSoft.value = P.lens.softness;
      Lp.uHiSoft.value = P.lens.highlightSoft ?? 0.7;
      Lp.uVig.value.set(P.lens.cos4, Math.tan(((layer.fovY || 30) * Math.PI) / 360), P.lens.vignette, P.lens.vignetteStart);
      Lp.uDebugBeta.value = (P.debug | 0) === 1 ? 1 : 0;
      pass(M.layerPass, accumRT, 'layer');
      // develop this layer (its bloom / streaks / halation, lens, grade LUT) into the display accumulator
      if (layerCount === 0) { renderer.setRenderTarget(dispRT); renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false); }
      develop(P, layer.weight ?? 1, layer.weave || [0, 0]);
      layerCount++;
    },

    /**
     * Bloom, streaks, glow and the final composite to the canvas.
     * fs: { params, frame, multi, gain, fovY, weave:[x,y] }
     */
    finish(fs) {
      const P = fs.params;
      const F = printMat((P.debug | 0) !== 0);
      const u = F.uniforms;
      u.uFade.value = clamp(P.fade, 0, 1);
      u.uGrain.value.set(P.grain.amount, Math.max(0.5, P.grain.size * refScale), P.grain.chroma, P.dither);
      u.uFrame.value = fs.frame | 0;
      { // per-frame grain placement: Weyl-sequence offset + hashed flips (deterministic)
        const f = fs.frame | 0, h = Math.imul(f ^ 0x5bd1e995, 0x27d4eb2d) >>> 0;
        u.uGrainXf.value.set((f * 0.7548776662) % 1, (f * 0.5698402910) % 1, h & 1 ? -1 : 1, h & 2 ? -1 : 1);
      }
      renderer.setRenderTarget(null);
      renderer.setViewport(0, 0, CW, CH);
      renderer.setScissorTest(false);
      if (CH > PH) { renderer.setClearColor(0x000000, 1); renderer.clear(true, false, false); }
      renderer.setViewport(0, picY0, PW, PH);
      pass(F, null, 'print');
      renderer.setViewport(0, 0, CW, CH);
      if (lyrBox.z > lyrBox.x) pass(M.lyrics, null, 'lyrics');
      api._lastFinal = F;
    },

    /** min-of-n timing (ms) of the passes of the last frame, re-run in isolation (diagnostics only) */
    benchPasses(n = 5) {
      const out = {};
      const time = (name, fn) => { let best = 1e9; for (let i = 0; i < n; i++) { gpuSync(); const a = performance.now(); fn(); gpuSync(); best = Math.min(best, performance.now() - a); } out[name] = +best.toFixed(1); };
      const F = api._lastFinal;
      if (F) { renderer.setRenderTarget(null); renderer.setViewport(0, picY0, PW, PH); time('print', () => pass(F, null)); renderer.setViewport(0, 0, CW, CH); }
      if (api._lastDevelop) time('develop', () => pass(api._lastDevelop, dispRT));   // (adds into dispRT: diagnostics only)
      if (lyrBox.z > lyrBox.x) time('lyrics', () => pass(M.lyrics, null));
      if (api._dofOn) {
        time('dof.prefilter', () => pass(M.prefilter, dofA));
        time('dof.gather', () => pass(M.gather, dofB));
        time('dof.fill', () => pass(M.fill, dofC));
      }
      M.bloom1img.uniforms.tImg.value = accumRT.texture; time('bloom1', () => pass(M.bloom1img, down[0]));
      time('layer', () => pass(M.layerPass, accumRT));
      M.streak.uniforms.tSrc.value = stA.texture;
      time('streak1', () => pass(M.streak, stB));
      time('glow', () => pass(M.glow, glowRT));
      return out;
    },

    dispose() {
      for (const rt of [sceneRT, accumRT, dispRT, fxRT, mbRT, dofA, dofB, dofC, tileA, tileB, stA, stB, glowRT, ...down, ...up]) if (rt) rt.dispose();
      for (const m of Object.values(M)) m.dispose();
      for (const m of develops.values()) m.dispose();
      for (const m of prints.values()) m.dispose();
      for (const L of luts.values()) L.tex.dispose();
      lyrTex.dispose(); blackTex.dispose(); grainTex.dispose(); geo.dispose();
    },
  };
  return api;
}
