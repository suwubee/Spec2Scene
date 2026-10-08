// Author: suwubee
// plants/material.js — one patched MeshStandardMaterial for all foliage / bark / blades (+ the matching shadow depth material).
//
// Per-vertex data (see build.js): aA = [ao, translucency, wind flex, kind], aB = [flutter, phase, hide, style|twoSided].
// Per-instance data: instanceMatrix, instanceColor (tint) and aInst = [phase offset, wind scale, density (leaf-card hide threshold), -].
// Wind: displacement along the wind direction = f(t, world position, flex) — a pure function of the uniform uTime.
// Lighting: wrap diffuse + view-dependent translucency (thin leaves lit from behind) inside RE_Direct_Physical, so it uses the
// sun's shadow-mapped light colour (leaves in shade stay dark); per-vertex AO scales the ambient (sky IBL).
import { GLSL_NOISE } from '../../engine/noise.js';
import { ALPHA_TEST, tileRect } from './atlas.js';

const VERT_DECL = /* glsl */ `
attribute vec4 aA;
attribute vec4 aB;
attribute vec4 aInst;
uniform float uTime;
uniform vec4 uWind;          // xyz = unit wind direction (world), w = amplitude (m) at flex = 1
varying vec4 vPA;            // ao, translucency, kind, twoSided
varying vec2 vPUv;
varying float vPStyle;
varying vec3 vPW;            // world position (far-crown noise)
varying float vFade;         // LOD cross-fade: >= 0 visible where dither <= w, < 0 visible where dither > 1 + w (1 = always)
`;
// applied right after #include <begin_vertex>; leaves `transformed` displaced (or collapsed when the card is hidden)
const VERT_MAIN = /* glsl */ `
  {
    if (aB.z > aInst.z) transformed = vec3(0.0);                        // thinned-out crown (per-instance density; leaf cards, far lobes and their limbs)
    else {
      #ifdef USE_INSTANCING
        mat3 pIM = mat3(instanceMatrix);
        vec3 pW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        vec3 pO = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      #else
        mat3 pIM = mat3(1.0);
        vec3 pW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vec3 pO = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      #endif
      float pFlex = aA.z * aInst.y;
      float pPh = aInst.x + aB.y * 6.2831853;
      float gust = 0.55 + 0.45 * sin(uTime * 0.37 + pO.x * 0.021 + pO.z * 0.017);
      float osc = 0.62 * sin(uTime * 1.31 + pPh + pO.x * 0.09 + pO.z * 0.06) + 0.38 * sin(uTime * 2.27 + pPh * 1.7 + pO.z * 0.13);
      vec3 dW = uWind.xyz * uWind.w * pFlex * pFlex * (0.45 + 0.55 * gust) * (0.55 + 0.45 * osc);
      float s2 = max(1e-4, dot(pIM[0], pIM[0]));
      transformed += (transpose(pIM) * dW) / s2;
      // leaf flutter: small motion along the normal at the card tip, plus a little extra sway at the tip
      transformed += normal * (aB.x * 0.022 * sin(uTime * 5.1 + pPh * 3.0 + pW.x * 0.7 + pW.z * 0.5));
    }
    vPA = vec4(aA.x, aA.y, aA.w, aB.w);
    vPUv = uv;
    vPStyle = aB.w;
    vFade = aInst.w;
    #ifdef USE_INSTANCING
      vPW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
    #else
      vPW = (modelMatrix * vec4(transformed, 1.0)).xyz;
    #endif
  }
`;

const FRAG_DECL = /* glsl */ `
${GLSL_NOISE}
uniform sampler2D tAtlas;
uniform vec4 uBarkTone;
uniform vec4 uClump;          // atlas rectangle of the 'clump' tile: u0, v0, du, dv
uniform float uSpecK;
uniform float uTransSky;
varying vec4 vPA;
varying vec2 vPUv;
varying float vPStyle;
varying vec3 vPW;
varying float vFade;
// Worley clumps (domain-warped): distance to the nearest clump centre (clump units), its hash, and the vector to it
void fol_clump(vec3 wpos, float cs, out float dc, out float hmin, out vec3 rmin) {
  vec3 wp = wpos + 0.5 * cs * vec3(mvValue(wpos * (0.74 / cs)), mvValue(wpos * (0.74 / cs) + 11.3), mvValue(wpos * (0.74 / cs) + 23.7));
  vec3 qq = wp / cs, ip = floor(qq), fq = qq - ip;
  float d1 = 9.0; rmin = vec3(0.0); hmin = 0.5;
  for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 g = vec3(float(i), float(j), float(k));
    vec3 hh = mvHash33(ip + g);
    vec3 r = g + 0.05 + 0.9 * hh - fq;
    float d = dot(r, r);
    if (d < d1) { d1 = d; rmin = r; hmin = hh.x; }
  }
  dc = sqrt(d1);
}
float fol_ao = 1.0;
float fol_trans = 0.0;
float fol_wrap = 0.0;
float fol_k4 = 0.0;           // 1 on far-crown lobes
vec3 fol_rv = vec3(0.0);      // world-space vector from the shaded point to the centre of its foliage clump
`;
// bark / leaf / blob colour — replaces #include <map_fragment>
const FRAG_MAP = /* glsl */ `
  {
    // LOD cross-fade (screen-door dither, complementary between the outgoing and incoming level)
    float pNF = mvIGN(gl_FragCoord.xy);
    if (vFade < 0.999) {                                                               // overlapping masks: no see-through holes while two levels share the pixels
      float pg = abs(vFade), pv = min(1.0, pg + 1.2 * pg * (1.0 - pg));
      if (vFade >= 0.0) { if (pNF > pv) discard; } else if (pNF <= 1.0 - pv) discard;
    }
    float pKind = vPA.z;
    fol_ao = vPA.x; fol_trans = vPA.y;
    if (pKind < 0.5) {
      // ---- bark: procedural, style in vPStyle: 0 fissured, 1 smooth, 2 scaly plates, 3 bamboo (nodes + streaks)
      vec2 b = vec2(vPUv.x * 9.0, vPUv.y * 1.6);
      float n1 = mvGradient(b * vec2(1.0, 0.55));
      float n2 = mvGradient(b * vec2(2.6, 2.4) + 7.7);
      float k = 1.0; vec3 tone = vec3(1.0);
      if (vPStyle < 0.5) { float fis = smoothstep(-0.25, 0.55, n1 + 0.45 * n2); k = mix(0.38, 1.12, fis); }
      else if (vPStyle < 1.5) { k = 0.86 + 0.22 * n2 + 0.08 * n1; }
      else if (vPStyle < 2.5) { vec2 q = vec2(vPUv.x * 7.0, vPUv.y * 2.4 + n1 * 0.4); float cell = mvHash21(floor(q)); float ed = min(fract(q.y), fract(q.x)); k = mix(0.45, 1.15, smoothstep(0.0, 0.18, ed)) * (0.82 + 0.3 * cell); }
      else if (vPStyle < 3.5) { float v = vPUv.y / 0.32; float nd = abs(fract(v) - 0.03); k = (0.9 + 0.16 * n1) * (1.0 - 0.38 * (1.0 - smoothstep(0.0, 0.05, nd))); k *= 1.0 + 0.08 * sin(vPUv.x * 6.2831 * 2.0); }
      else {
        // mottled exfoliating plates (悬铃木): olive-green / cream / grey-brown patches ~0.3 m
        vec2 q = vec2(vPUv.x * 7.0, vPUv.y);
        float w1 = mvValue(vec3(q, 3.7)), w2 = mvValue(vec3(q * 2.3 + 5.1, 1.3));
        float m = smoothstep(-0.1, 0.3, w1 + 0.5 * w2), m2 = smoothstep(0.15, 0.5, mvValue(vec3(q * 1.7 + 11.0, 7.7)));
        tone = mix(vec3(0.46, 0.56, 0.36), vec3(1.0, 1.0, 0.88), m);
        tone = mix(tone, vec3(0.62, 0.57, 0.52), m2 * 0.6);
        k = 0.9 + 0.2 * n2;
      }
      diffuseColor.rgb *= k * tone;
      fol_trans = 0.0;
    } else if (pKind < 1.5) {
      // ---- leaf card (atlas, cut-out)
      vec4 lt = texture2D(tAtlas, vPUv);
      diffuseColor.rgb *= lt.rgb * 1.2;
      diffuseColor.a *= lt.a;
      fol_wrap = 0.35;
    } else if (pKind < 2.5) {
      // ---- solid foliage core (near crowns, conifer / shrub cores): leafy clump shading, no cut-out — mottled albedo, dark creases, bumped normal
      float fpx2 = max(length(dFdx(vPW)), length(dFdy(vPW)));
      const float CS2 = 0.42;
      float dc2, hm2; vec3 rm2;
      fol_clump(vPW, CS2, dc2, hm2, rm2);
      float aa2 = 1.0 - smoothstep(CS2 * 0.12, CS2 * 0.5, fpx2);
      float lum2 = mix(1.1, 0.55, smoothstep(0.15, 0.85, dc2)) * (0.84 + 0.32 * hm2);
      diffuseColor.rgb *= mix(0.85, lum2, 0.25 + 0.75 * aa2);
      fol_ao = vPA.x * mix(1.0, mix(1.0, 0.55, smoothstep(0.3, 0.85, dc2)), aa2);
      fol_wrap = 0.35;
      fol_k4 = 1.0; fol_rv = rm2 * aa2;
    } else if (pKind < 3.5) {
      fol_wrap = 0.0;
    } else {
      // ---- far crown lobe: foliage seen from afar. Worley "clumps" (~1.1 m) drive everything: lit dome tops / dark creases (albedo, AO and a bump that
      //      tilts the normal away from each clump centre), a ragged alpha-cut silhouette made of clump cores, a few gaps inside; back faces seen through
      //      the gaps are dark (the inside of the crown). Detail fades out when a clump drops below a few pixels (no shimmer).
      vec3 pN = normalize(vNormal);
      float ndv = abs(dot(pN, normalize(vViewPosition)));
      float fpx = max(length(dFdx(vPW)), length(dFdy(vPW)));                             // metres per pixel
      const float CS = 0.8;
      float dc, hmin; vec3 rmin;
      fol_clump(vPW, CS, dc, hmin, rmin);
      float n2 = mvValue(vPW * 1.9 + 7.7), n3 = mvValue(vPW * 5.3 + 3.1);
      float aa = 1.0 - smoothstep(CS * 0.12, CS * 0.5, fpx);                            // 1 = full detail, 0 = clumps are ~2 px (mean only)
      vec3 pFn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));              // geometric (facet) normal: its silhouette is each lobe's own outline
      float ndvG = abs(dot(pFn, normalize(vViewPosition)));
      float edge = 1.0 - smoothstep(0.0, 0.5, min(ndvG, mix(ndvG, ndv, 0.35)));          // 1 at the lobe outline, 0 face-on
      float keepR = mix(0.9, 0.28, pow(edge, 0.9));
      float cutv = dc + aa * (0.34 * n2 + 0.16 * n3) - keepR;
      float soft = clamp(fpx / CS * 1.1, 0.03, 0.3);
      diffuseColor.a *= 1.0 - smoothstep(-soft, soft, cutv);
      float lumC = mix(1.18, 0.55, smoothstep(0.15, 0.85, dc)) * (0.84 + 0.32 * hmin);
      diffuseColor.rgb *= mix(1.0, lumC * (1.0 + 0.1 * n3 + 0.1 * n2), 0.3 + 0.7 * aa);
      fol_ao = vPA.x * mix(1.0, mix(1.0, 0.62, smoothstep(0.3, 0.85, dc)), aa);
      if (!gl_FrontFacing) fol_ao *= 0.6;
      fol_wrap = 0.35;
      fol_k4 = 1.0; fol_rv = rmin * mix(0.0, 1.0, aa);
    }
    // near-camera dither fade: nothing blocks the view when the camera is inside a crown / curtain of strands
    float pNear = smoothstep(0.45, 2.1, length(vViewPosition));
    if (pNear < 1.0 && mvIGN(gl_FragCoord.xy) > pNear) discard;
  }
`;
// two-sided shading for blades / petals / lotus (aB.w = 1): flip the normal on back faces; puffy cards keep their normal
const FRAG_NORMAL = /* glsl */ `
float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
vec3 normal = normalize( vNormal );
if ( vPA.w > 0.5 || fol_k4 > 0.5 ) normal *= faceDirection;
if ( fol_k4 > 0.5 ) {                                          // far crown: tilt the normal away from the clump centre (cauliflower domes)
  vec3 pRv = ( viewMatrix * vec4( fol_rv, 0.0 ) ).xyz;
  vec3 pTg = pRv - normal * dot( pRv, normal );
  normal = normalize( normal - 0.42 * pTg );
}
vec3 nonPerturbedNormal = normal;
`;
const FRAG_AO = /* glsl */ `
  #include <aomap_fragment>
  {
    float pAO = clamp(fol_ao, 0.0, 1.0);
    reflectedLight.indirectDiffuse *= pAO;
    reflectedLight.indirectSpecular *= pAO * uSpecK;
    reflectedLight.directSpecular *= uSpecK;
    reflectedLight.directDiffuse *= mix(1.0, pAO, 0.45);
  }
`;
// transmitted sky light: thin leaves pass the light of the hemisphere BEHIND them (their underside glows green when you look up into a crown)
const FRAG_TRANS_SKY = /* glsl */ `
#if defined( RE_IndirectDiffuse ) && defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  iblIrradiance += fol_trans * uTransSky * getIBLIrradiance( - geometryNormal );
#endif
`;
const LIGHT_PATCH = /* glsl */ `
  reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
  {
    // wrap lighting + translucency (leaves are thin: the sun shines through them towards the camera)
    float wrapNL = saturate( ( dot( geometryNormal, directLight.direction ) + fol_wrap ) / ( 1.0 + fol_wrap ) );
    reflectedLight.directDiffuse += ( wrapNL - dotNL ) * directLight.color * BRDF_Lambert( material.diffuseContribution ) * step(0.001, fol_wrap);
    float tdot = saturate( dot( geometryViewDir, - directLight.direction ) );
    float back = pow( tdot, 4.0 ) * 1.1 + 0.18 * saturate( 1.0 - dotNL );
    reflectedLight.directDiffuse += directLight.color * material.diffuseColor * RECIPROCAL_PI * fol_trans * back * 1.15;
  }
`;

export function createUniforms(THREE, atlasTex) {
  return {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector4(0.99, 0.0, 0.13, 0.30) },
    tAtlas: { value: atlasTex },
    uBarkTone: { value: new THREE.Vector4(1, 1, 1, 1) },
    uClump: { value: (() => { const r = tileRect('clump', 0.5); return new THREE.Vector4(r[0], r[1], r[2] - r[0], r[3] - r[1]); })() },
  };
}

const LIGHT_RE = /reflectedLight\.directDiffuse \+= irradiance \* BRDF_Lambert\( material\.diffuseContribution \) \* \( 1\.0 - F \);/;

/** main foliage material (roughness / flags per variant through the options) */
export function createFoliageMaterial(THREE, U, o = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: o.roughness ?? 0.68, metalness: 0, side: THREE.DoubleSide, vertexColors: true,
    alphaTest: ALPHA_TEST, alphaToCoverage: o.a2c ?? true,
  });
  m.name = 'plants-' + (o.name || 'foliage');
  const lightChunk = THREE.ShaderChunk.lights_physical_pars_fragment.replace(LIGHT_RE, LIGHT_PATCH);
  if (lightChunk === THREE.ShaderChunk.lights_physical_pars_fragment) console.warn('[plants] light patch anchor not found — translucency disabled');
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, { uSpecK: { value: o.spec ?? 0.35 }, uTransSky: { value: o.transSky ?? 0.9 } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL)
      .replace('#include <color_vertex>', '#include <color_vertex>\n  if (aA.w < 0.5) vColor.rgb = color;           // bark keeps its own colour (the instance colour is the leaf tint)')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_MAIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_DECL)
      .replace('#include <map_fragment>', FRAG_MAP + '\n#include <map_fragment>')
      .replace('#include <normal_fragment_begin>', FRAG_NORMAL)
      .replace('#include <lights_physical_pars_fragment>', lightChunk)
      .replace('#include <aomap_fragment>', FRAG_AO)
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n' + FRAG_TRANS_SKY);
  };
  m.customProgramCacheKey = () => 'zzy-plants-foliage-v5';
  m.userData.uniforms = U;
  return m;
}

/** shadow-map depth material: same wind / thinning, cut-out through the atlas alpha */
export function createDepthMaterial(THREE, U) {
  const m = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide, alphaTest: ALPHA_TEST });
  m.name = 'plants-depth';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_MAIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_NOISE + '\nuniform sampler2D tAtlas;\nvarying vec4 vPA;\nvarying vec2 vPUv;\nvarying float vPStyle;\nvarying vec3 vPW;\nvarying float vFade;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n  if (vPA.z > 0.5 && vPA.z < 1.5) diffuseColor.a *= texture2D(tAtlas, vPUv).a;\n  if (vPA.z > 3.5 && 0.6 * mvValue(vPW * 0.9) + 0.4 * mvValue(vPW * 2.4 + 7.7) < -0.5) discard;');
  };
  m.customProgramCacheKey = () => 'zzy-plants-depth-v2';
  return m;
}
