// Author: suwubee
// engine/materials.js — PBR material factories (MeshPhysicalMaterial + one shared onBeforeCompile patch) and the

//
//   import { createMaterials, makeMoonLight, makeLanternLight, configureShadows } from '/src/engine/materials.js';
//   const M = createMaterials(ctx);                       // ctx = { THREE, renderer, quality }
//   const table = new THREE.Mesh(geo.bevelBox(1.2, 0.04, 0.6, 0.003), M.wood({ variant: 'hardwood', edgeWear: 0.6 }));
//   const floor = new THREE.Mesh(g, M.bluestone({ wet: 0.8, puddles: 0.45 }));
//   M.update(t, world);                                    // per frame: only uniform writes (time, rain)
//
// Every factory returns a THREE.MeshPhysicalMaterial whose textures come from procTex.js (baked once, cached).
// Extras live in material.userData.mv: { uniforms, kind, tex, setWetness(w), setPuddles(level) }.
// Shared features (all per-material uniforms, zero extra passes):
//   * ORM texture (AO/roughness/metal-or-mask/aux) read with ONE fetch; AO also micro-shadows direct light.
//   * wetness 0..1 (porous darkening, lower roughness, water-film clearcoat, puddles in low areas of up-facing
//     surfaces, closed-form rain ripples in the film); world-space puddle mask hook (`puddleMap`).
//   * micro-normal detail layer (close range, faded by distance) + Toksvig specular anti-aliasing.
//   * translucency (thin-sheet diffuse transmission + forward-scatter lobe, thickness from the texture, tinted),
//     wrap lighting (cloth), sheen (linen), anisotropy (strings, bamboo, silk).
//   * per-instance / per-object colour & roughness variation (hash of the object/instance origin), UV jitter,
//     low-frequency anti-tiling variation, geometry edge wear (mvEdge attribute from geo.js).
//   * better PCF soft shadows (12 taps final / 6 preview) inside these materials.
import * as THREE from './vendor/three.module.js';
import { GLSL_HASH, pink1, hashString } from './noise.js';
import { bake, bakeDetail, bakeVariation, hexLin } from './procTex.js';
import { CLOTH_GLSL, STRING_GLSL, STRING_MAX_NOTES, stringNotesAt } from './geo.js';

// ------------------------------------------------------------------------------------------------
// Exposure convention (LIB_COMMON §2): intensity so that a white Lambert surface facing the light has the target radiance.
// ------------------------------------------------------------------------------------------------
export const LIGHTS = {
  moon: { intensity: 0.22, color: [0.62, 0.74, 0.98] },            // x world.moonlight  -> white radiance 0.07
  sunDay: { intensity: 7.9, color: [1.0, 0.95, 0.86] },            // radiance 2.5
  sunGold: { intensity: 4.4, color: [1.0, 0.68, 0.36] },           // radiance 1.4 (low warm)
  sunLow: { intensity: 1.6, color: [1.0, 0.47, 0.19] },            // at the horizon (extinction)
  lantern: { intensity: 1.1, color: [1.0, 0.62, 0.30], flicker: 0.12 },  // point, cd; x practicalLight
  lamp: { intensity: 0.2, color: [1.0, 0.70, 0.40], flicker: 0.035 },    // point, cd; x localLight
};

// ------------------------------------------------------------------------------------------------
// GLSL patch
// ------------------------------------------------------------------------------------------------
const V_PARS = /* glsl */ `
#ifdef MV_STD
attribute float mvEdge;
attribute float mvSeed;     // optional per-vertex seed (geo.mergeInstanced); 0 = absent
uniform vec4 mvUvXform;
uniform vec2 mvDetailScale;
uniform float mvVarScale;
uniform float mvUvJitter;
uniform float mvObjSeed;
uniform float mvThinBias;
varying vec2 vMvUv;
varying vec2 vMvDetailUv;
varying vec2 vMvVarUv;
varying vec4 vMvRand;
varying vec3 vMvWorldPos;
varying vec3 vMvWorldNrm;
varying float vMvEdge;
#endif
${GLSL_HASH}
${CLOTH_GLSL}
${STRING_GLSL}
`;
const V_UV = /* glsl */ `
#include <uv_vertex>
#ifdef MV_STD
  {
    // stable random per instance (gl_InstanceID) / per object (mvObjSeed uniform, else hash of the object origin)
    #ifdef USE_INSTANCING
      uvec3 mvH = mvPcg3d(uvec3(uint(gl_InstanceID) + 7919u, uint(mvObjSeed) + 104729u, 1299709u));
    #else
      float mvS = mvSeed > 0.0 ? mvSeed + mvObjSeed * 65536.0 : mvObjSeed;
      uvec3 mvH = mvS > 0.0 ? mvPcg3d(uvec3(uint(mvS), 7919u, 104729u))
                            : mvPcg3d(uvec3(ivec3(floor(modelMatrix[3].xyz * 1000.0 + 0.5)) + ivec3(7919, 104729, 1299709)));
    #endif
    vMvRand = vec4(vec3(mvH) * MV_U2F, float(mvPcg(mvH.x ^ mvH.z)) * MV_U2F);
  }
  vMvUv = uv * mvUvXform.xy + mvUvXform.zw + vMvRand.xy * mvUvJitter;
  #ifdef USE_MAP
    vMapUv = vMvUv;
  #endif
  #ifdef USE_NORMALMAP
    vNormalMapUv = vMvUv;
  #endif
  #ifdef USE_CLEARCOAT_NORMALMAP
    vClearcoatNormalMapUv = vMvUv;
  #endif
  vMvDetailUv = uv * mvDetailScale + vMvRand.zw * 5.0;
  vMvVarUv = uv * mvVarScale + vMvRand.wx * 3.0;
  vMvEdge = mvEdge;
#endif
`;
const V_NORMAL = /* glsl */ `
#include <beginnormal_vertex>
#if defined( MV_CLOTH ) || defined( MV_STRING )
  vec3 mvDisp = vec3(0.0);
  mvDeform(position, objectNormal, uv, mvDisp, objectNormal);
#endif
`;
const V_BEGIN = /* glsl */ `
#include <begin_vertex>
#if defined( MV_CLOTH ) || defined( MV_STRING )
  #ifdef MV_DEPTH
    { vec3 mvD; vec3 mvN; mvDeform(position, vec3(0.0, 0.0, 1.0), uv, mvD, mvN); transformed += mvD; }
  #else
    transformed += mvDisp;
  #endif
#endif
`;
const V_PROJECT = /* glsl */ `
#include <project_vertex>
#ifdef MV_STD
  {
    vec4 mvWp = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      mvWp = instanceMatrix * mvWp;
    #endif
    mvWp = modelMatrix * mvWp;
    vMvWorldPos = mvWp.xyz;
    vMvWorldNrm = normalize(inverseTransformDirection(transformedNormal, viewMatrix));
  }
#endif
`;

const F_PARS = /* glsl */ `
#ifdef MV_STD
uniform sampler2D mvOrmMap;
uniform sampler2D mvDetailMap;
uniform sampler2D mvVarMap;
uniform vec4 mvDetail;      // normal strength, albedo amount, roughness amount, fade distance (m)
uniform vec4 mvVar;         // albedo, roughness, hue, (unused)
uniform vec4 mvJitter;      // per-instance value, hue, saturation, roughness
uniform vec4 mvEdgeWear;    // amount, width (m), albedo multiplier, roughness delta
uniform vec3 mvEdgeTint;
uniform vec4 mvWet;         // wetness, porosity scale, puddle level, darkening
uniform vec4 mvWetParams;   // film roughness, puddle roughness, ripple strength, puddle map weight
uniform sampler2D mvPuddleMap;
uniform vec4 mvPuddleXform; // world xz -> uv: scale.xy, offset.xy
uniform vec4 mvTrans;       // strength, distortion, power, forward scale
uniform vec3 mvTransColor;
uniform float mvTransAbs;
uniform vec4 mvShade;       // wrap, micro-shadow, toksvig, ao strength
uniform float mvTime;
uniform float mvRain;
varying vec2 vMvUv;
varying vec2 vMvDetailUv;
varying vec2 vMvVarUv;
varying vec4 vMvRand;
varying vec3 vMvWorldPos;
varying vec3 vMvWorldNrm;
varying float vMvEdge;
#ifdef MV_STRING
varying float vMvStrCov;
varying float vMvStrSide;
#endif
uniform float mvPointRadius;   // radius (m) of practical point lights (lantern/lamp shade) -> sphere-light specular
uniform float mvDirAngle;      // angular radius (rad) of the moon/sun disc
float mvLightDist = 1.0;
float mvLightRad = 0.0;
float mvTransT = 0.0;
float mvFilm = 0.0;
float mvPuddleM = 0.0;
${GLSL_HASH}
vec3 mvHueShift(vec3 c, float a) {
  const mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 yiq = toYIQ * c; float cs = cos(a), sn = sin(a);
  yiq.yz = mat2(cs, sn, -sn, cs) * yiq.yz;
  return toRGB * yiq;
}
// closed-form rain ripples: gradient of the ripple height field at world xz (m) and time t (s)
vec2 mvRippleGrad(vec2 p, float t, float rain) {
  vec2 g = vec2(0.0);
  const float cell = 0.07;
  for (int layer = 0; layer < 2; layer++) {
    vec2 q = p / cell + float(layer) * vec2(0.37, 0.61);
    vec2 c = floor(q);
    for (int j = 0; j <= 1; j++) for (int i = 0; i <= 1; i++) {
      vec2 cc = c + vec2(float(i), float(j)) - 0.5 + step(0.5, fract(q)) - 0.5;
      vec3 h = vec3(mvPcg3d(uvec3(ivec3(cc, layer + 17)))) * MV_U2F;
      if (h.z > rain * 0.9) continue;
      float period = 0.7 + 0.8 * h.x;
      float age = fract(t / period + h.y) * period;
      vec2 d = (q - (cc + 0.5 + (h.xy - 0.5) * 0.6)) * cell;
      float r = length(d);
      float size = 0.5 + h.z / max(rain * 0.9, 1e-3);     // drop size 0.5..1.5
      float w = 0.0025 + 0.002 * size;                      // ring width (m)
      float R = age * (0.16 + 0.1 * size);
      float x = (r - R) / w;
      float env = exp(-age * (4.5 - size)) * exp(-x * x * 0.5) * (1.0 - smoothstep(0.012 * size, 0.03 * size, R)) * size;
      float dh = env * (cos(x * 2.4) * 2.4 - x * sin(x * 2.4)) * 0.00035 / w;
      g += dh * d / max(r, 1e-4);
    }
  }
  return g;
}
#endif
`;
const F_COLOR = /* glsl */ `
#include <color_fragment>
#ifdef MV_STD
  vec4 mvOrm = texture2D(mvOrmMap, vMvUv);
  vec4 mvV = texture2D(mvVarMap, vMvVarUv);
  float mvViewD = length(vViewPosition);
  #ifdef MV_DETAIL
    vec4 mvDet = texture2D(mvDetailMap, vMvDetailUv);
    float mvDetF = 1.0 - smoothstep(mvDetail.w * 0.5, mvDetail.w, mvViewD);
  #else
    vec4 mvDet = vec4(0.5); float mvDetF = 0.0;
  #endif
  float mvL = 1.0 + mvVar.x * (mvV.r - 0.5) * 2.0 + mvJitter.x * (vMvRand.x - 0.5) * 2.0;
  diffuseColor.rgb *= max(mvL, 0.0);
  float mvHue = mvVar.z * (mvV.b - 0.5) * 2.0 + mvJitter.y * (vMvRand.y - 0.5) * 2.0;
  float mvSat = 1.0 + mvJitter.z * (vMvRand.z - 0.5) * 2.0;
  vec3 mvGrey = vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)));
  diffuseColor.rgb = max(mix(mvGrey, mvHueShift(diffuseColor.rgb, mvHue), mvSat), 0.0);
  diffuseColor.rgb *= 1.0 + mvDetail.y * (mvDet.b - 0.5) * 2.0 * mvDetF;
  float mvEdgeD = (1.0 - vMvEdge) * 0.05;
  float mvWear = mvEdgeWear.x * step(0.0001, vMvEdge) * (1.0 - smoothstep(0.0, mvEdgeWear.y, mvEdgeD + (mvV.a - 0.5) * mvEdgeWear.y * 1.2));
  mvWear = saturate(mvWear);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * mvEdgeTint * mvEdgeWear.z, mvWear);
  #ifdef MV_STRING
    {
      // shutter-integrated vibrating string: coverage r/(r+env) with arcsine density (bright extremes)
      float mvArc = min(3.0, 0.6366 / sqrt(max(1.0 - vMvStrSide * vMvStrSide, 0.05)));
      diffuseColor.a *= min(1.0, vMvStrCov * mix(1.0, mvArc, step(0.001, 1.0 - vMvStrCov)));
    }
  #endif
#endif
`;
const F_ROUGH = /* glsl */ `
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
  roughnessFactor *= texelRoughness.g;
#endif
#ifdef MV_STD
  roughnessFactor *= mvOrm.g;
  roughnessFactor *= max(0.0, 1.0 + mvVar.y * (mvV.g - 0.5) * 2.0 + mvJitter.w * (vMvRand.w - 0.5) * 2.0);
  roughnessFactor *= mix(1.0, 0.5 + mvDet.a, mvDetail.z * mvDetF);
  roughnessFactor = saturate(roughnessFactor + mvWear * mvEdgeWear.w);
#endif
`;
const F_METAL = /* glsl */ `
float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
  vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
  metalnessFactor *= texelMetalness.b;
#endif
#if defined( MV_STD ) && defined( MV_ORM_METAL )
  metalnessFactor *= mvOrm.b;
#endif
`;
const F_NORMAL = /* glsl */ `
#ifdef USE_NORMALMAP_OBJECTSPACE
  normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  #ifdef FLIP_SIDED
    normal = - normal;
  #endif
  #ifdef DOUBLE_SIDED
    normal = normal * faceDirection;
  #endif
  normal = normalize( normalMatrix * normal );
#elif defined( USE_NORMALMAP_TANGENTSPACE )
  vec4 mvNrmTex = texture2D( normalMap, vNormalMapUv );
  vec3 mapN = mvNrmTex.xyz * 2.0 - 1.0;
  #ifdef MV_STD
    float mvNLen = length(mapN);
  #endif
  mapN.xy *= normalScale;
  #if defined( MV_STD ) && defined( MV_DETAIL )
    mapN.xy += (mvDet.rg * 2.0 - 1.0) * mvDetail.x * mvDetF * mapN.z;
  #endif
  normal = normalize( tbn * mapN );
  #ifdef MV_STD
    roughnessFactor = sqrt(min(1.0, roughnessFactor * roughnessFactor + mvShade.z * (1.0 - min(mvNLen, 1.0)) / max(mvNLen, 1e-3)));
  #endif
#elif defined( USE_BUMPMAP )
  normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif
#if defined( MV_STD ) && defined( MV_WET )
  {
    float mvW = mvWet.x;
    float mvPor = saturate(mvOrm.a * mvWet.y);
    float mvUp = saturate(vMvWorldNrm.y);
    #ifdef USE_NORMALMAP_TANGENTSPACE
      float mvHgt = mvNrmTex.a;
    #else
      float mvHgt = 0.5;
    #endif
    float mvLvl = mvWet.z * (0.8 + 0.6 * (mvV.b - 0.5)) * smoothstep(0.25, 0.85, mvW);
    float mvPud = smoothstep(-0.02, 0.02, mvLvl - mvHgt) * pow(mvUp, 6.0) * step(0.0001, mvWet.z);
    #ifdef MV_PUDDLE_MAP
      mvPud = max(mvPud, mvWetParams.w * texture2D(mvPuddleMap, vMvWorldPos.xz * mvPuddleXform.xy + mvPuddleXform.zw).r * pow(mvUp, 6.0) * mvW);
    #endif
    float mvWetAll = max(mvW, mvPud);
    diffuseColor.rgb *= mix(1.0, 1.0 - mvWet.w, mvPor * mvWetAll);
    diffuseColor.rgb *= mix(1.0, 0.8, mvPud);
    roughnessFactor = mix(roughnessFactor, roughnessFactor * mix(0.45, 0.8, mvPor), mvW);
    roughnessFactor = mix(roughnessFactor, mvWetParams.y, mvPud);
    normal = normalize(mix(normal, nonPerturbedNormal, mvPud * 0.92));
    mvFilm = max(smoothstep(0.2, 0.9, mvW) * (1.0 - 0.55 * mvPor) * mix(0.45, 1.0, mvUp), mvPud);
    mvPuddleM = mvPud;
  }
#endif
`;
const F_CC_NORMAL = /* glsl */ `
#include <clearcoat_normal_fragment_maps>
#if defined( MV_STD ) && defined( MV_WET ) && defined( USE_CLEARCOAT )
  if (mvFilm > 0.001 && mvRain > 0.001) {
    vec2 mvG = mvRippleGrad(vMvWorldPos.xz, mvTime, mvRain) * mvWetParams.z;
    vec3 mvNW = normalize(vec3(-mvG.x, 1.0, -mvG.y));
    vec3 mvNV = normalize((viewMatrix * vec4(mvNW, 0.0)).xyz);
    // rings form in standing water; on a merely wet film raindrops only make faint splashes
    clearcoatNormal = normalize(mix(clearcoatNormal, mvNV, saturate(vMvWorldNrm.y) * mix(0.2 * mvFilm, 1.0, mvPuddleM)));
  }
#endif
`;
const F_LIGHTS_PHYS = /* glsl */ `
#include <lights_physical_fragment>
#if defined( MV_STD ) && defined( MV_WET ) && defined( USE_CLEARCOAT )
  material.clearcoat = max(material.clearcoat, mvFilm);
  material.clearcoatRoughness = mix(material.clearcoatRoughness, min(1.0, max(mvWetParams.x, 0.0525) + geometryRoughness), mvFilm);
  material.clearcoatF0 = mix(material.clearcoatF0, vec3(0.02), mvFilm);
#endif
#if defined( MV_STD ) && defined( MV_TRANS )
  mvTransT = mvTrans.x * exp(-mvTransAbs * mvOrm.a);
#endif
`;
const F_RE = /* glsl */ `
#include <lights_physical_pars_fragment>
#ifdef MV_STD
void RE_Direct_MV( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  // Sphere / disc lights (Karis 2013, representative point): diffuse uses the light centre; the specular (base +
  // clearcoat) is evaluated toward the point of the source closest to the reflection ray and renormalised by
  // (a/a')^2, so a glossy surface shows a sized, soft-edged image of the lantern / the moon disc in a puddle.
  vec3 mvS0 = reflectedLight.directSpecular;
  #ifdef USE_CLEARCOAT
    vec3 mvC0 = clearcoatSpecularDirect;
  #endif
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  if ( mvLightRad > 0.0 ) {
    #ifdef USE_SHEEN
      vec3 mvSh1 = sheenSpecularDirect;
    #endif
    vec3 mvD1 = reflectedLight.directDiffuse;
    reflectedLight.directSpecular = mvS0;
    vec3 mvR = reflect( - geometryViewDir, geometryNormal );
    vec3 mvLc = directLight.direction * mvLightDist;
    vec3 mvC2R = dot( mvLc, mvR ) * mvR - mvLc;
    IncidentLight mvLs = directLight;
    mvLs.direction = normalize( mvLc + mvC2R * saturate( mvLightRad / max( length( mvC2R ), 1e-6 ) ) );
    float mvW = 0.5 * mvLightRad / max( mvLightDist, 1e-3 );
    float mvA = pow2( material.roughness );
    float mvK = pow2( mvA / min( 1.0, mvA + mvW ) );
    #ifdef USE_CLEARCOAT
      float mvAc = pow2( material.clearcoatRoughness );
      float mvKc = pow2( mvAc / min( 1.0, mvAc + mvW ) );
      clearcoatSpecularDirect = mvC0;
    #endif
    RE_Direct_Physical( mvLs, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
    reflectedLight.directSpecular = mvS0 + ( reflectedLight.directSpecular - mvS0 ) * mvK;
    reflectedLight.directDiffuse = mvD1;
    #ifdef USE_CLEARCOAT
      clearcoatSpecularDirect = mvC0 + ( clearcoatSpecularDirect - mvC0 ) * mvKc;
    #endif
    #ifdef USE_SHEEN
      sheenSpecularDirect = mvSh1;
    #endif
  }
  float mvNdL = dot( geometryNormal, directLight.direction );
  #ifdef MV_WRAP
    float mvWp = mvShade.x;
    float mvExtra = max( 0.0, ( mvNdL + mvWp ) / ( 1.0 + mvWp ) ) - max( mvNdL, 0.0 );
    reflectedLight.directDiffuse += directLight.color * mvExtra * BRDF_Lambert( material.diffuseContribution );
  #endif
  #ifdef MV_TRANS
    vec3 mvLt = normalize( directLight.direction + geometryNormal * mvTrans.y );
    float mvFwd = pow( saturate( dot( geometryViewDir, -mvLt ) ), mvTrans.z ) * mvTrans.w;
    float mvBack = saturate( -mvNdL );
    reflectedLight.directDiffuse += directLight.color * ( mvBack + mvFwd ) * mvTransT * mvTransColor * material.diffuseColor * RECIPROCAL_PI;
  #endif
}
#undef RE_Direct
#define RE_Direct RE_Direct_MV
#endif
`;
const F_SHADOW = /* glsl */ `
#if defined( USE_SHADOWMAP ) && defined( SHADOWMAP_TYPE_PCF ) && defined( MV_SHADOW_TAPS )
  #define getShadow getShadow_three
  #define getPointShadow getPointShadow_three
  #define MV_PCF_OVERRIDE
#endif
#include <shadowmap_pars_fragment>
#ifdef MV_PCF_OVERRIDE
  #undef getShadow
  #undef getPointShadow
  float getShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
    float shadow = 1.0;
    shadowCoord.xyz /= shadowCoord.w;
    // receiver-plane depth bias (Isidoro 2006): each PCF tap compares against the receiver's own plane, so wide soft
    // kernels on grazing surfaces do not self-shadow (no acne / moire) and normalBias can stay ~1 texel.
    vec3 sdx = dFdx( shadowCoord.xyz ), sdy = dFdy( shadowCoord.xyz );
    float det = sdx.x * sdy.y - sdx.y * sdy.x;
    vec2 dz = abs( det ) > 1e-14 ? vec2( sdy.y * sdx.z - sdx.y * sdy.z, sdx.x * sdy.z - sdy.x * sdx.z ) / det : vec2( 0.0 );
    dz = clamp( dz, vec2( -3.0 ), vec2( 3.0 ) );
    shadowCoord.z += shadowBias;
    bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
    if ( inFrustum && shadowCoord.z <= 1.0 ) {
      float radius = shadowRadius / shadowMapSize.x;
      float slack = 1.5 / shadowMapSize.x * ( abs( dz.x ) + abs( dz.y ) );
      float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
      float acc = 0.0;
      for ( int i = 0; i < MV_SHADOW_TAPS; i ++ ) {
        vec2 o = vogelDiskSample( i, MV_SHADOW_TAPS, phi ) * radius;
        acc += texture( shadowMap, vec3( shadowCoord.xy + o, min( shadowCoord.z + dot( dz, o ) - slack, 1.0 ) ) );
      }
      shadow = acc / float( MV_SHADOW_TAPS );
    }
    return mix( 1.0, shadow, shadowIntensity );
  }
  #if NUM_POINT_LIGHT_SHADOWS > 0
  float getPointShadow( samplerCubeShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
    float shadow = 1.0;
    vec3 lightToPosition = shadowCoord.xyz;
    vec3 bd3D = normalize( lightToPosition );
    vec3 absVec = abs( lightToPosition );
    float viewSpaceZ = max( max( absVec.x, absVec.y ), absVec.z );
    if ( viewSpaceZ - shadowCameraFar <= 0.0 && viewSpaceZ - shadowCameraNear >= 0.0 ) {
      #ifdef USE_REVERSED_DEPTH_BUFFER
        float dp = ( shadowCameraNear * ( shadowCameraFar - viewSpaceZ ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
        dp -= shadowBias;
      #else
        float dp = ( shadowCameraFar * ( viewSpaceZ - shadowCameraNear ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
        dp += shadowBias;
      #endif
      float texelSize = shadowRadius / shadowMapSize.x;
      vec3 absDir = abs( bd3D );
      vec3 tangent = absDir.x > absDir.z ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
      tangent = normalize( cross( bd3D, tangent ) );
      vec3 bitangent = cross( bd3D, tangent );
      float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
      float acc = 0.0;
      for ( int i = 0; i < MV_SHADOW_TAPS; i ++ ) {
        vec2 s = vogelDiskSample( i, MV_SHADOW_TAPS, phi );
        acc += texture( shadowMap, vec4( bd3D + ( tangent * s.x + bitangent * s.y ) * texelSize, dp ) );
      }
      shadow = acc / float( MV_SHADOW_TAPS );
    }
    return mix( 1.0, shadow, shadowIntensity );
  }
  #endif
#endif
`;
const F_AO = /* glsl */ `
#include <aomap_fragment>
#ifdef MV_STD
  {
    float mvAO = mix(1.0, mvOrm.r, mvShade.w);
    reflectedLight.indirectDiffuse *= mvAO;
    reflectedLight.indirectSpecular *= computeSpecularOcclusion(saturate(dot(geometryNormal, geometryViewDir)), mvAO, material.roughness);
    reflectedLight.directDiffuse *= mix(1.0, mvAO, mvShade.y);
    reflectedLight.directSpecular *= mix(1.0, mvAO, mvShade.y * 0.6);
    #ifdef USE_SHEEN
      sheenSpecularIndirect *= mvAO;
    #endif
    #ifdef USE_CLEARCOAT
      clearcoatSpecularIndirect *= mix(1.0, mvAO, 0.5);
    #endif
  }
#endif
`;

// shadowmap_vertex for thin translucent sheets: the normal-offset is flipped to face each light and an extra
// mvThinBias (m) is added, so a sheet does not shadow its own back side (translucency keeps working) while
// shadows cast by OTHER objects are unchanged.
const V_SHADOW_THIN = /* glsl */ `
#if defined( MV_THIN ) && defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 || NUM_POINT_LIGHT_SHADOWS > 0 )
  #ifdef HAS_NORMAL
    vec3 shadowWorldNormal = transformNormalByInverseViewMatrix( transformedNormal, viewMatrix );
  #else
    vec3 shadowWorldNormal = vec3( 0.0 );
  #endif
  vec4 shadowWorldPosition;
  #if NUM_SUN_LIGHT_SHADOWS > 0
    vSunShadowWorldPosition = vec4( worldPosition.xyz, - mvPosition.z );
    vSunShadowWorldNormal = shadowWorldNormal;
  #endif
  #if NUM_DIR_LIGHT_SHADOWS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      {
        vec3 mvLF = normalize( vec3( directionalShadowMatrix[ i ][ 0 ][ 2 ], directionalShadowMatrix[ i ][ 1 ][ 2 ], directionalShadowMatrix[ i ][ 2 ][ 2 ] ) );
        vec3 mvSN = dot( shadowWorldNormal, mvLF ) > 0.0 ? - shadowWorldNormal : shadowWorldNormal;
        shadowWorldPosition = worldPosition + vec4( mvSN * ( directionalLightShadows[ i ].shadowNormalBias + mvThinBias ), 0 );
        vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;
      }
    }
    #pragma unroll_loop_end
  #endif
  #if NUM_POINT_LIGHT_SHADOWS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
      {
        vec3 mvLP = - pointShadowMatrix[ i ][ 3 ].xyz;
        vec3 mvSN = dot( shadowWorldNormal, worldPosition.xyz - mvLP ) > 0.0 ? - shadowWorldNormal : shadowWorldNormal;
        shadowWorldPosition = worldPosition + vec4( mvSN * ( pointLightShadows[ i ].shadowNormalBias + mvThinBias ), 0 );
        vPointShadowCoord[ i ] = pointShadowMatrix[ i ] * shadowWorldPosition;
      }
    }
    #pragma unroll_loop_end
  #endif
  #if NUM_SPOT_LIGHT_COORDS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
      shadowWorldPosition = worldPosition;
      #if ( defined( USE_SHADOWMAP ) && UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
        shadowWorldPosition.xyz += shadowWorldNormal * spotLightShadows[ i ].shadowNormalBias;
      #endif
      vSpotLightCoord[ i ] = spotLightMatrix[ i ] * shadowWorldPosition;
    }
    #pragma unroll_loop_end
  #endif
#else
  #include <shadowmap_vertex>
#endif
`;
function lightsBeginPatched() {
  let c = THREE.ShaderChunk.lights_fragment_begin;
  const P = 'getPointLightInfo( pointLight, geometryPosition, directLight );';
  const D = 'getDirectionalLightInfo( directionalLight, directLight );';
  const S = 'getSpotLightInfo( spotLight, geometryPosition, directLight );';
  const SU = 'getSunLightInfo( sunLight, directLight );';
  for (const k of [P, D, S]) if (!c.includes(k)) throw new Error('materials.js: lights_fragment_begin changed (' + k + ')');
  c = c.replace(P, P + '\n\t\tmvLightDist = length( pointLight.position - geometryPosition ); mvLightRad = mvPointRadius;');
  c = c.replace(D, D + '\n\t\tmvLightDist = 1.0; mvLightRad = mvDirAngle;');
  c = c.replace(S, S + '\n\t\tmvLightDist = 1.0; mvLightRad = 0.0;');
  if (c.includes(SU)) c = c.replace(SU, SU + '\n\t\tmvLightDist = 1.0; mvLightRad = mvDirAngle;');
  return '#ifdef MV_STD\n' + c + '\n#else\n#include <lights_fragment_begin>\n#endif\n';
}
let _lightsBegin = null;
function rep(src, needle, repl, where) {
  if (!src.includes(needle)) throw new Error(`materials.js patch: '${needle}' not found in ${where} shader (three.js version mismatch?)`);
  return src.replace(needle, repl);
}
function patchVertex(vs) {
  vs = rep(vs, '#include <common>', '#include <common>\n' + V_PARS, 'vertex');
  vs = rep(vs, '#include <uv_vertex>', V_UV, 'vertex');
  vs = rep(vs, '#include <beginnormal_vertex>', V_NORMAL, 'vertex');
  vs = rep(vs, '#include <begin_vertex>', V_BEGIN, 'vertex');
  vs = rep(vs, '#include <project_vertex>', V_PROJECT, 'vertex');
  vs = rep(vs, '#include <shadowmap_vertex>', V_SHADOW_THIN, 'vertex');
  return vs;
}
function patchFragment(fs) {
  fs = rep(fs, '#include <common>', '#include <common>\n' + F_PARS, 'fragment');
  fs = rep(fs, '#include <color_fragment>', F_COLOR, 'fragment');
  fs = rep(fs, '#include <roughnessmap_fragment>', F_ROUGH, 'fragment');
  fs = rep(fs, '#include <metalnessmap_fragment>', F_METAL, 'fragment');
  fs = rep(fs, '#include <normal_fragment_maps>', F_NORMAL, 'fragment');
  fs = rep(fs, '#include <clearcoat_normal_fragment_maps>', F_CC_NORMAL, 'fragment');
  fs = rep(fs, '#include <lights_physical_fragment>', F_LIGHTS_PHYS, 'fragment');
  fs = rep(fs, '#include <lights_physical_pars_fragment>', F_RE, 'fragment');
  fs = rep(fs, '#include <shadowmap_pars_fragment>', F_SHADOW, 'fragment');
  fs = rep(fs, '#include <aomap_fragment>', F_AO, 'fragment');
  fs = rep(fs, '#include <lights_fragment_begin>', _lightsBegin || (_lightsBegin = lightsBeginPatched()), 'fragment');
  return fs;
}
// One shared function object => identical customProgramCacheKey; variants are separated by material.defines.
function mvOnBeforeCompile(shader) {
  const U = this.userData.mv.uniforms;
  for (const k of Object.keys(U)) shader.uniforms[k] = U[k];
  shader.vertexShader = patchVertex(shader.vertexShader);
  shader.fragmentShader = patchFragment(shader.fragmentShader);
}
function mvDepthOnBeforeCompile(shader) {
  const U = this.userData.mvDepth.uniforms;
  for (const k of Object.keys(U)) shader.uniforms[k] = U[k];
  let vs = shader.vertexShader;
  vs = rep(vs, '#include <common>', '#include <common>\n' + GLSL_HASH + CLOTH_GLSL + STRING_GLSL + '\nuniform vec4 mvUvXform;', 'depth vertex');
  vs = rep(vs, '#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = uv * mvUvXform.xy + mvUvXform.zw;\n#endif\n', 'depth vertex');
  vs = rep(vs, '#include <begin_vertex>', V_BEGIN, 'depth vertex');
  shader.vertexShader = vs;
}

// ------------------------------------------------------------------------------------------------
// Material library
// ------------------------------------------------------------------------------------------------
const V2 = (a, b) => new THREE.Vector2(a, b);
const V4 = (a, b, c, d) => new THREE.Vector4(a, b, c, d);
const asPair = (v, d) => (v === undefined ? [d, d] : Array.isArray(v) ? v : [v, v]);

/**
 * createMaterials(ctx, opts) -> library. ctx: { renderer, quality:'final'|'preview' }.
 * opts: { anisotropy (texture max aniso, default 16), shadowTaps (default 12 final / 6 preview) }
 */
export function createMaterials(ctx, libOpts = {}) {
  const renderer = ctx.renderer;
  const quality = ctx.quality || 'final';
  const aniso = libOpts.anisotropy ?? 16;
  const taps = libOpts.shadowTaps ?? (quality === 'preview' ? 6 : 12);
  const shared = { mvTime: { value: 0 }, mvRain: { value: 0 }, mvPointRadius: { value: libOpts.pointRadius ?? 0.12 }, mvDirAngle: { value: 0.0046 } };
  const variation = bakeVariation(renderer, {}).map;
  const blankDetail = (() => { const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1); t.needsUpdate = true; return t; })();
  const blankPuddle = (() => { const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); t.needsUpdate = true; return t; })();
  const created = [];
  const tex = (name, o) => bake(renderer, name, { quality, anisotropy: aniso, ...o });
  const det = (name, o = {}) => bakeDetail(renderer, name, { quality, ...o });

  /** Core: build an MV material. spec = { tex (bake result), detail (bakeDetail result|null), phys (MeshPhysical params), o (user opts), d (defaults) } */
  function make(kind, T, detail, phys, o, d) {
    const uvS = asPair(o.uvScale, 1), uvR = o.uvRepeat;
    const su = uvR ? uvR[0] : uvS[0] / T.worldSize[0], sv = uvR ? uvR[1] : uvS[1] / T.worldSize[1];
    const uo = o.uvOffset || [0, 0];
    const dS = detail ? (o.detailScale ?? 1) : 1;
    const detailOn = !!detail && (o.detail ?? d.detail ?? 1) > 0;
    const U = {
      mvOrmMap: { value: T.ormMap },
      mvDetailMap: { value: detailOn ? detail.map : blankDetail },
      mvVarMap: { value: variation },
      mvUvXform: { value: V4(su, sv, uo[0], uo[1]) },
      mvDetailScale: { value: detailOn ? V2(dS / detail.worldSize[0], dS / detail.worldSize[1]) : V2(1, 1) },
      mvVarScale: { value: 1 / (o.variationSize ?? d.variationSize ?? 1.7) },
      mvUvJitter: { value: o.uvJitter ?? d.uvJitter ?? 0 },
      mvObjSeed: { value: o.objSeed ?? 0 },
      mvThinBias: { value: o.thinBias ?? d.thinBias ?? 0.004 },
      mvDetail: { value: V4((o.detail ?? d.detail ?? 1) * (d.detailNormal ?? 1), d.detailAlbedo ?? 0.25, d.detailRough ?? 0.5, o.detailFade ?? d.detailFade ?? 1.5) },
      mvVar: { value: V4(o.variation ?? d.variation ?? 0.12, d.variationRough ?? 0.15, d.variationHue ?? 0.03, 0) },
      mvJitter: { value: V4(...(o.colorJitter ?? d.colorJitter ?? [0.04, 0.02, 0.05, 0.05])) },
      mvEdgeWear: { value: V4(o.edgeWear ?? d.edgeWear ?? 0, o.edgeWidth ?? d.edgeWidth ?? 0.006, d.edgeAlbedo ?? 1.35, d.edgeRough ?? -0.12) },
      mvEdgeTint: { value: new THREE.Color().setRGB(...(d.edgeTint || [1, 1, 1])) },
      mvWet: { value: V4(o.wet ?? 0, d.porosity ?? 1, o.puddles ?? 0, d.wetDarken ?? 0.55) },
      mvWetParams: { value: V4(0.06, 0.03, o.ripples ?? 1, o.puddleMapWeight ?? 1) },
      mvPuddleMap: { value: o.puddleMap || blankPuddle },
      mvPuddleXform: { value: V4(...(o.puddleXform || [1, 1, 0, 0])) },
      mvTrans: { value: V4(o.translucency ?? d.translucency ?? 0, d.transDistortion ?? 0.3, d.transPower ?? 4, d.transForward ?? 0.8) },
      mvTransColor: { value: new THREE.Color().setRGB(...(o.transColor || d.transColor || [1, 1, 1])) },
      mvTransAbs: { value: d.transAbs ?? 1.2 },
      mvShade: { value: V4(o.wrap ?? d.wrap ?? 0, d.microShadow ?? 0.5, d.toksvig ?? 0.6, o.ao ?? d.ao ?? 1) },
      mvTime: shared.mvTime, mvRain: shared.mvRain, mvPointRadius: shared.mvPointRadius, mvDirAngle: shared.mvDirAngle,
    };
    const defines = { MV_STD: '', MV_SHADOW_TAPS: taps };
    if (detailOn) defines.MV_DETAIL = '';
    if (T.metal) defines.MV_ORM_METAL = '';
    const wetReady = o.wetReady ?? d.wetReady ?? ((o.wet ?? 0) > 0 || (o.puddles ?? 0) > 0);
    if (wetReady || o.wet !== undefined) defines.MV_WET = '';
    if (o.puddleMap) defines.MV_PUDDLE_MAP = '';
    if ((o.translucency ?? d.translucency ?? 0) > 0) defines.MV_TRANS = '';
    if (o.thin ?? d.thin ?? false) defines.MV_THIN = '';
    if ((o.wrap ?? d.wrap ?? 0) > 0) defines.MV_WRAP = '';
    const p = {
      map: T.map, normalMap: T.normalMap, roughness: o.roughness ?? 1, metalness: T.metal ? (o.metalness ?? 1) : (o.metalness ?? 0),
      envMapIntensity: o.envMapIntensity ?? 1, side: o.side ?? d.side ?? THREE.FrontSide,
      ...phys,
    };
    if (o.normalScale !== undefined) p.normalScale = new THREE.Vector2(...asPair(o.normalScale, 1));
    if (o.color) p.color = new THREE.Color(o.color);
    if (wetReady && !(p.clearcoat > 0)) { p.clearcoat = 0.0001; p.clearcoatRoughness = 0.06; }
    const mat = new THREE.MeshPhysicalMaterial(p);
    mat.defines = { ...(mat.defines || {}), ...defines };
    Object.defineProperty(mat.userData, 'mv', { enumerable: false, configurable: true, value: {
      kind, uniforms: U, tex: T, detail,
      setWetness(w) { U.mvWet.value.x = w; }, setPuddles(l) { U.mvWet.value.z = l; },
      setTranslucency(s) { U.mvTrans.value.x = s; }, setSeed(n) { U.mvObjSeed.value = n; },
    } });
    mat.onBeforeCompile = mvOnBeforeCompile;
    mat.name = kind;
    created.push(mat);
    return mat;
  }

  // ---------------------------------------------------------------- factories
  const lib = {
    quality, uniforms: shared, variation,
    /** Per frame: t = film time (s), world = world.at(t). Only uniform writes. */
    update(t, world) { shared.mvTime.value = t; shared.mvRain.value = world ? world.rain : 0; },
    /** Suggested wetness for outdoor surfaces in a rainy region from the world state (pure function). */
    wetnessFrom(world) { if (!world) return 0; if (world.wetness !== undefined) return world.wetness; return Math.min(1, world.rain * 1.6 + (world.rain > 0.01 ? 0.25 : 0)); },

    /** Wood: variant 'hardwood' (#3b2a1e aged dark) | 'paulownia' (#7b5a3c) | 'rosewood' (#4a2418) | 'weathered'. */
    wood(o = {}) {
      const variant = o.variant || 'hardwood';
      const T = tex('wood', { size: o.size, variant, seed: o.seed ?? 1, params: o.params, colors: o.colors });
      const D = det('woodPores');
      const pol = variant === 'rosewood' ? 0.25 : variant === 'paulownia' ? 0.1 : 0;
      return make('wood:' + variant, T, D, { clearcoat: o.clearcoat ?? pol, clearcoatRoughness: 0.28, specularIntensity: 1 }, o,
        { detail: 1, detailNormal: 0.9, detailAlbedo: 0.3, edgeWear: 0.5, edgeWidth: 0.008, edgeAlbedo: 1.45, edgeRough: -0.15, edgeTint: [1.05, 0.98, 0.9],
          porosity: 1.0, wetDarken: 0.5, variation: 0.1, colorJitter: [0.06, 0.02, 0.06, 0.06], uvJitter: 1 });
    },
    /** Black lacquer with 断纹 (guqin). */
    lacquer(o = {}) {
      const T = tex('lacquer', { size: o.size, variant: 'guqin', seed: o.seed ?? 1, params: o.params, colors: o.colors });
      const D = det('smudge');
      return make('lacquer', T, D, { specularIntensity: 1, ior: 1.55 }, o,
        { detail: 1, detailNormal: 0.6, detailAlbedo: 0.15, detailRough: 0.9, edgeWear: 0.6, edgeWidth: 0.004, edgeAlbedo: 2.2, edgeRough: 0.08, edgeTint: [1.1, 0.8, 0.6],
          porosity: 0.1, variation: 0.06, colorJitter: [0.03, 0.01, 0.03, 0.05] });
    },
    /** Ceramic: 'porcelain' (white, glossy) | 'celadon' (粉青 with 开片 crackle, jade-like). */
    ceramic(kind = 'porcelain', o = {}) {
      const T = tex('ceramic', { size: o.size, variant: kind, seed: o.seed ?? 1, params: o.params, colors: o.colors });
      const D = det('glaze');
      const cel = kind === 'celadon';
      return make('ceramic:' + kind, T, D, { clearcoat: 1, clearcoatRoughness: o.clearcoatRoughness ?? (cel ? 0.16 : 0.035), ior: 1.52, specularIntensity: cel ? 0.7 : 0.9,
        sheen: cel ? 0.25 : 0, sheenColor: new THREE.Color().setRGB(0.55, 0.68, 0.6), sheenRoughness: 0.5 }, o,
        { detail: 1, detailNormal: 0.7, detailAlbedo: 0.1, detailRough: 0.6, porosity: 0.05, variation: 0.03, colorJitter: [0.02, 0.01, 0.03, 0.05],
          translucency: cel ? 0.0 : 0.0, edgeWear: 0 });
    },
    porcelain(o = {}) { return lib.ceramic('porcelain', o); },
    celadon(o = {}) { return lib.ceramic('celadon', o); },
    /** White linen bedding / pillow: weave, sheen, wrap lighting. */
    linen(o = {}) {
      const T = tex('linen', { size: o.size, seed: o.seed ?? 1, params: o.params, colors: o.colors });
      const D = det('cloth');
      return make('linen', T, D, { sheen: 1, sheenColor: new THREE.Color().setRGB(0.85, 0.83, 0.8), sheenRoughness: 0.55, specularIntensity: 0.35 }, o,
        { detail: 0.6, detailAlbedo: 0.12, wrap: 0.35, translucency: o.translucency ?? 0.25, transAbs: 1.0, transColor: [1, 0.97, 0.92], porosity: 1.2, wetDarken: 0.3,
          variation: 0.08, colorJitter: [0.02, 0.01, 0.02, 0.03], side: THREE.DoubleSide, microShadow: 0.7 });
    },
    /** Lime whitewash plaster. o.damp: height (m) of rising damp band from `dampBase` (use with world-space y). */
    plaster(o = {}) {
      const T = tex('plaster', { size: o.size, seed: o.seed ?? 1, params: o.params, colors: o.colors });
      const D = det('grit');
      return make('plaster', T, D, { specularIntensity: 0.5 }, o,
        { detail: 0.8, detailAlbedo: 0.25, porosity: 1.1, wetDarken: 0.45, variation: 0.1, colorJitter: [0.03, 0.01, 0.03, 0.03], detailFade: 3 });
    },
    /** Bluestone paving (青石). `wet` 0..1, `puddles` level 0..1 (fills the low areas: joints, worn dishes). */
    bluestone(o = {}) {
      if (typeof o === 'number') o = { wet: o };
      const T = tex('bluestone', { size: o.size, seed: o.seed ?? 1, params: o.params, colors: o.colors });
      const D = det('grit');
      return make('bluestone', T, D, { specularIntensity: 0.8 }, o,
        { detail: 1, detailAlbedo: 0.2, porosity: 1.0, wetDarken: 0.6, wetReady: true, variation: 0.12, colorJitter: [0.05, 0.02, 0.05, 0.05], detailFade: 4 });
    },
    /** Roof: flat tile-field texture for distant slopes ('rows'); for instanced tile geometry use tileClay(). */
    roofTile(o = {}) {
      const T = tex('roofTile', { size: o.size, seed: o.seed ?? 1, params: o.params, colors: o.colors });
      return make('roofTile', T, null, { specularIntensity: 0.6 }, o,
        { porosity: 1.0, wetDarken: 0.55, wetReady: true, variation: 0.14, colorJitter: [0.05, 0.02, 0.05, 0.05] });
    },
    /** Clay tile surface for geo.instancedTiles (per-instance UV jitter + value jitter). */
    tileClay(o = {}) {
      const T = tex('tileClay', { size: o.size, seed: o.seed ?? 1, params: o.params, colors: o.colors });
      const D = det('grit');
      return make('tileClay', T, D, { specularIntensity: 0.6 }, o,
        { detail: 0.7, porosity: 1.0, wetDarken: 0.55, wetReady: true, uvJitter: 1, variation: 0.12, colorJitter: [0.1, 0.02, 0.08, 0.08], edgeWear: 0.4, edgeWidth: 0.01, edgeAlbedo: 1.25, edgeRough: 0.05 });
    },
    /** Bamboo slat (blind): aged #b9a066, anisotropic highlight along the length, backlight translucency, dark edges. */
    bambooSlat(o = {}) {
      const T = tex('bamboo', { size: o.size, variant: 'slat', seed: o.seed ?? 1, params: o.params, colors: o.colors });
      return make('bambooSlat', T, null, { anisotropy: o.anisotropy ?? 0.45, anisotropyRotation: 0, specularIntensity: 0.8 }, o,
        { thin: true, translucency: o.translucency ?? 0.35, transAbs: 1.8, transColor: [1.0, 0.8, 0.45], transForward: 0.5, uvJitter: 1, colorJitter: [0.08, 0.03, 0.08, 0.06],
          edgeWear: 0.8, edgeWidth: 0.0012, edgeAlbedo: 0.62, edgeRough: 0.08, edgeTint: [0.95, 0.85, 0.7], porosity: 0.4, variation: 0.1 });
    },
    /** Bamboo rod (culm from geo.bambooRod): node darkening via mvEdge, anisotropic. */
    bambooRod(o = {}) {
      const T = tex('bamboo', { size: o.size, variant: 'rod', seed: o.seed ?? 2, params: o.params, colors: o.colors });
      return make('bambooRod', T, null, { anisotropy: o.anisotropy ?? 0.4, anisotropyRotation: 0, specularIntensity: 0.85 }, o,
        { translucency: o.translucency ?? 0.15, transAbs: 2.2, transColor: [1.0, 0.8, 0.45], uvJitter: 1, colorJitter: [0.06, 0.02, 0.06, 0.05],
          edgeWear: 0.9, edgeWidth: 0.012, edgeAlbedo: 0.55, edgeRough: 0.1, edgeTint: [0.9, 0.8, 0.65], porosity: 0.4, variation: 0.08 });
    },
    /** Guqin silk string (ivory, twisted; `wound` for the thick strings). Use with geo.stringLine (v normalised). */
    silkString(o = {}) {
      const T = tex('silk', { size: o.size, variant: o.wound ? 'wound' : 'plain', seed: o.seed ?? 1 });
      const radius = o.radius ?? 0.0006;
      return make('silkString', T, null, { sheen: 0.8, sheenColor: new THREE.Color().setRGB(0.9, 0.85, 0.72), sheenRoughness: 0.4, anisotropy: 0.6,
        anisotropyRotation: o.wound ? 0.1 : Math.atan2(2 * Math.PI * radius * 3, 0.002), specularIntensity: 0.6 }, { uvRepeat: [1 / T.worldSize[0], 1], ...o },
        { translucency: 0.2, transAbs: 0.8, transColor: [1, 0.92, 0.75], wrap: 0.3, variation: 0.03, colorJitter: [0.03, 0.01, 0.02, 0.04] });
    },
    /** Polished metal string: kind 'steel' | 'silver' | 'brass' | 'woundSteel'. */
    metalString(o = {}) {
      const kind = o.kind || 'steel';
      const T = tex('metal', { size: o.size, variant: kind, seed: o.seed ?? 1 });
      const D = det('smudge');
      return make('metalString:' + kind, T, D, { anisotropy: o.anisotropy ?? (kind === 'woundSteel' ? 0.5 : 0.25), anisotropyRotation: kind === 'woundSteel' ? 0 : Math.PI / 2, specularIntensity: 1 },
        { uvRepeat: [1 / T.worldSize[0], 1], ...o },
        { detail: 0.4, detailNormal: 0.3, detailRough: 0.6, detailAlbedo: 0.05, variation: 0.05, colorJitter: [0.02, 0.0, 0.0, 0.08] });
    },
    /** Matte black iron (hooks, hardware). */
    iron(o = {}) {
      const T = tex('iron', { size: o.size, seed: o.seed ?? 1 });
      const D = det('grit');
      return make('iron', T, D, { specularIntensity: 1 }, o,
        { detail: 0.6, porosity: 0.3, wetReady: o.wetReady ?? false, edgeWear: 0.5, edgeWidth: 0.003, edgeAlbedo: 2.0, edgeRough: -0.25, variation: 0.08 });
    },
    /** Oiled lantern paper (#f2d9a8): strong diffuse transmission (glows when lit from inside). */
    paperLantern(o = {}) {
      const T = tex('paper', { size: o.size, variant: 'lantern', seed: o.seed ?? 1 });
      const D = det('fibre');
      return make('paperLantern', T, D, { specularIntensity: 0.5, side: THREE.DoubleSide }, o,
        { thin: true, detail: 0.5, detailAlbedo: 0.1, translucency: o.translucency ?? 0.45, transAbs: 1.1, transColor: [1.0, 0.86, 0.62], transForward: 0.6, transPower: 3,
          wrap: 0.2, side: THREE.DoubleSide, porosity: 0.6, variation: 0.06 });
    },
    /** Rice paper 宣纸 (#e9dfc8): letters, window paper. Translucent with visible fibres/laid lines when backlit. */
    ricePaper(o = {}) {
      const T = tex('paper', { size: o.size, variant: 'rice', seed: o.seed ?? 1 });
      const D = det('fibre');
      return make('ricePaper', T, D, { specularIntensity: 0.4, side: THREE.DoubleSide }, o,
        { thin: true, detail: 0.8, detailAlbedo: 0.15, translucency: o.translucency ?? 0.6, transAbs: 1.6, transColor: [1.0, 0.95, 0.85], transForward: 0.4, wrap: 0.25,
          side: THREE.DoubleSide, porosity: 1.2, variation: 0.05 });
    },
    /** Sheer silk gauze 素纱 (#efe9df): alpha weave (transparent), sheen, translucency, anisotropic silk lustre. */
    gauze(o = {}) {
      const T = tex('gauze', { size: o.size, variant: o.variant || 'sheer', seed: o.seed ?? 1 });
      const m = make('gauze', T, null, { transparent: true, depthWrite: false, sheen: 0.7, sheenColor: new THREE.Color().setRGB(0.95, 0.92, 0.86), sheenRoughness: 0.35,
        specularIntensity: 0.5, side: THREE.DoubleSide, alphaToCoverage: false }, o,
        { thin: true, translucency: o.translucency ?? 0.9, transAbs: 0.5, transColor: [1, 0.97, 0.93], transForward: 1.2, transPower: 2.5, wrap: 0.4, side: THREE.DoubleSide,
          porosity: 1.0, variation: 0.04, microShadow: 0.2 });
      m.shadowSide = THREE.DoubleSide;
      return m;
    },
    /** White plum petal (per-petal UVs from geo.petalGeometry): pink base, veins, sheen, strong translucency. */
    petal(o = {}) {
      const T = tex('petal', { size: o.size, variant: o.variant || 'plum', seed: o.seed ?? 1 });
      return make('petal', T, null, { sheen: 0.6, sheenColor: new THREE.Color().setRGB(0.95, 0.9, 0.9), sheenRoughness: 0.45, specularIntensity: 0.45, side: THREE.DoubleSide },
        { uvRepeat: [1, 1], ...o },
        { thin: true, translucency: o.translucency ?? 0.8, transAbs: 0.9, transColor: [1.0, 0.93, 0.9], transForward: 0.8, wrap: 0.4, side: THREE.DoubleSide,
          variation: 0.02, colorJitter: [0.03, 0.02, 0.05, 0.05], microShadow: 0.2 });
    },
    /** Leaf (bamboo / willow; per-leaf UVs u across 0..1, v base->tip): translucent, wrap-lit, sheen-less. variant 'bamboo' | 'dry'. */
    leaf(o = {}) {
      const T = tex('leaf', { size: o.size, variant: o.variant || 'bamboo', seed: o.seed ?? 1 });
      return make('leaf', T, null, { specularIntensity: 0.6, side: THREE.DoubleSide }, { uvRepeat: [1, 1], ...o },
        { thin: true, translucency: o.translucency ?? 0.7, transAbs: 1.2, transColor: [0.85, 1.0, 0.55], transForward: 0.9, wrap: 0.3, side: THREE.DoubleSide,
          variation: 0.05, colorJitter: [0.08, 0.04, 0.08, 0.06], microShadow: 0.2 });
    },
    /** Plum bark (#2c2521) with lichen. */
    bark(o = {}) {
      const T = tex('bark', { size: o.size, seed: o.seed ?? 1 });
      return make('bark', T, null, { specularIntensity: 0.5 }, o,
        { porosity: 1.0, wetDarken: 0.5, variation: 0.1, uvJitter: 1, colorJitter: [0.05, 0.02, 0.05, 0.05] });
    },

    // ------------------------------------------------------------ deformation hooks
    /**
     * Cloth wind deformation in the vertex shader (geo.clothPlane geometry). Returns the uniforms; call
     * lib.setCloth(mat, clothParams(world, mesh), t) per frame. Also build the shadow material with makeDepthMaterial(mat).
     */
    applyCloth(mat, { width = 1.5, height = 1.5 } = {}) {
      const U = mat.userData.mv.uniforms;
      U.mvClothT = { value: 0 }; U.mvClothW = { value: V4(0, 1, 0, 0.004) }; U.mvClothP = { value: V4(0.12, 0.32, height, width) };
      mat.defines.MV_CLOTH = ''; mat.needsUpdate = true;
      return U;
    },
    setCloth(mat, P, t) {
      const U = mat.userData.mv.uniforms;
      U.mvClothT.value = t;
      U.mvClothW.value.set(P.wind, P.dirN, P.dirT, P.idle);
      U.mvClothP.value.x = P.amp; U.mvClothP.value.y = P.freq; if (P.h) U.mvClothP.value.z = P.h;
    },
    /**
     * String vibration (geo.stringLine geometry). mode 'blur' (shutter-integrated envelope, default, photoreal) | 'wave'.
     * setStringNotes(mat, notes, t, opts) per frame (notes of THIS string: [{t, vel}] sorted by t).
     */
    applyString(mat, { length = 1, radius = 0.0005, freq = 7, mode = 'blur', dir = [0, 1, 0] } = {}) {
      const U = mat.userData.mv.uniforms;
      U.mvStrNotes = { value: Array.from({ length: STRING_MAX_NOTES }, () => V4(0, 0, 0.5, 1)) };
      U.mvStrT = { value: 0 }; U.mvStrP = { value: V4(length, freq, mode === 'wave' ? 0 : 1, radius) };
      U.mvStrDir = { value: new THREE.Vector3(...dir).normalize() };
      mat.defines.MV_STRING = '';
      if (mode !== 'wave') { mat.transparent = true; }
      mat.needsUpdate = true;
      return U;
    },
    setStringNotes(mat, notes, t, opts = {}) {
      const U = mat.userData.mv.uniforms;
      const arr = stringNotesAt(notes, t, opts);
      arr.forEach((a, i) => U.mvStrNotes.value[i].set(a[0], a[1], a[2], a[3]));
      U.mvStrT.value = t;
    },
    /** Shadow-map materials matching a MV material's deformation + alpha (gauze): assign to mesh.customDepthMaterial / customDistanceMaterial. */
    makeDepthMaterial(mat) {
      const mk = (Cls, extra) => {
        const m = new Cls({ map: mat.transparent || mat.alphaTest > 0 ? mat.map : null, alphaHash: !!mat.transparent, alphaTest: mat.alphaTest, side: THREE.DoubleSide, ...extra });
        m.defines = { MV_DEPTH: '' };
        if (mat.defines.MV_CLOTH !== undefined) m.defines.MV_CLOTH = '';
        if (mat.defines.MV_STRING !== undefined) m.defines.MV_STRING = '';
        m.userData.mvDepth = { uniforms: mat.userData.mv.uniforms };
        m.onBeforeCompile = mvDepthOnBeforeCompile;
        return m;
      };
      return { depth: mk(THREE.MeshDepthMaterial, { depthPacking: THREE.RGBADepthPacking }), distance: mk(THREE.MeshDistanceMaterial, {}) };
    },
    /** Raw texture access (bake results) for custom shaders. */
    textures(name, o = {}) { return tex(name, o); },
    detailTexture(name, o = {}) { return det(name, o); },
    materials: created,
    dispose() { for (const m of created) m.dispose(); blankDetail.dispose(); blankPuddle.dispose(); },
  };
  // remember (factory, args) on every material so lib.clone() can rebuild an independent copy (own uniforms)
  for (const name of ['wood', 'lacquer', 'ceramic', 'porcelain', 'celadon', 'linen', 'plaster', 'bluestone', 'roofTile', 'tileClay', 'bambooSlat',
    'bambooRod', 'silkString', 'metalString', 'iron', 'paperLantern', 'ricePaper', 'gauze', 'petal', 'leaf', 'bark']) {
    const f = lib[name];
    lib[name] = (...args) => { const m = f(...args); if (m.userData.mv) m.userData.mv.factory = [name, args]; return m; };
  }
  /** Independent copy of an MV material (e.g. a moving object needing its own objSeed): lib.clone(mat, { objSeed: 7 }) */
  lib.clone = (mat, overrides = {}) => {
    const [name, args] = mat.userData.mv.factory;
    const a = args.slice();
    const i = name === 'ceramic' ? 1 : 0;
    a[i] = { ...(a[i] && typeof a[i] === 'object' ? a[i] : {}), ...overrides };
    return lib[name](...a);
  };
  return lib;
}

// ------------------------------------------------------------------------------------------------
// Lighting rigs (identical for every set). Each: { light, object, update(t, world), setCenter(v3, radius?), dispose() }.
// ------------------------------------------------------------------------------------------------
const smooth = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Renderer shadow setup for SwiftShader: PCF (r186 Vogel-disk; MV materials use 12/6 taps), shadows on. */
export function configureShadows(renderer) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = true;
}

// Skip the shadow pass of a light that is dark (intensity 0) without toggling castShadow (which would recompile every
// program). The map must still be rendered ONCE: an unrendered shadow map leaves its sampler2DShadow bound to an
// incompatible texture -> GL_INVALID_OPERATION on every draw.
function shadowGate(light) {
  if (!light.castShadow) return;
  const on = light.intensity > 1e-5;
  light.shadow.autoUpdate = on;
  if (!on && !light.shadow.map) light.shadow.needsUpdate = true;
}
function dirShadow(light, ctx, opts, defaults) {
  const q = ctx.quality || 'final';
  const size = Math.min(2048, opts.mapSize || (q === 'preview' ? defaults.preview : defaults.final));
  light.castShadow = opts.castShadow !== false;
  light.shadow.mapSize.set(size, size);
  const cam = light.shadow.camera;
  const state = { center: new THREE.Vector3(...(opts.center || [0, 0, 0])), radius: opts.radius ?? 3, size };
  const apply = () => {
    const r = state.radius;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.near = 0.05; cam.far = r * 4 + 2;
    cam.updateProjectionMatrix();
    const texel = (2 * r) / size;
    light.shadow.bias = opts.bias ?? -0.0002;
    light.shadow.normalBias = opts.normalBias ?? texel * 1.0;
    const pen = opts.penumbra ?? defaults.penumbra;            // world-space penumbra width (m)
    light.shadow.radius = Math.max(1, Math.min(24, pen / texel));
  };
  apply();
  return { state, apply };
}
function placeDir(light, st, dir) {
  // stable (texel-snapped) placement at distance 2r along dir from the centre
  const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
  const r = st.radius, texel = (2 * r) / st.size;
  const up = Math.abs(d.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const X = new THREE.Vector3().crossVectors(up, d).normalize(), Y = new THREE.Vector3().crossVectors(d, X);
  const c = st.center.clone();
  const cx = Math.round(c.dot(X) / texel) * texel, cy = Math.round(c.dot(Y) / texel) * texel, cz = c.dot(d);
  const snapped = X.multiplyScalar(cx).add(Y.multiplyScalar(cy)).add(d.clone().multiplyScalar(cz));
  light.target.position.copy(snapped);
  light.position.copy(snapped).addScaledVector(d, r * 2 + 1);
  light.target.updateMatrixWorld();
}

/**
 * Moon: DirectionalLight I = 0.22 × world.moonlight × gain × occlusion(world), colour (0.62,0.74,0.98), from world.moonDir.
 * opts: { center:[x,y,z], radius (shadow half-extent m), mapSize (<=2048), penumbra (world-space PCF blur, m; default 0.005 = crisp
 *   contact shadows; use ~0.015 for shadows cast from 1-2 m, e.g. the window lattice on the bed), gain, occlusion:(world)=>0..1, castShadow }
 */
export function makeMoonLight(ctx, opts = {}) {
  const light = new THREE.DirectionalLight(0xffffff, 0);
  light.name = 'moonLight';
  const S = dirShadow(light, ctx, opts, { final: 2048, preview: 1024, penumbra: 0.005 });
  const obj = new THREE.Group(); obj.add(light); obj.add(light.target);
  return {
    light, object: obj,
    update(t, world) {
      const occ = opts.occlusion ? opts.occlusion(world) : 1;
      light.intensity = LIGHTS.moon.intensity * (world.moonlight ?? 1) * (opts.gain ?? 1) * occ;
      shadowGate(light);
      light.color.setRGB(...LIGHTS.moon.color);
      placeDir(light, S.state, world.moonDir || [-0.8, 0.5, 0.3]);
    },
    setCenter(c, radius) { S.state.center.set(...c); if (radius) S.state.radius = radius; S.apply(); },
    dispose() { light.dispose(); },
  };
}
/**
 * Sun: DirectionalLight. Day I 7.9 (1,.95,.86) -> golden (elev ~8°) I 4.4 (1,.68,.36) -> horizon I 1.6 (1,.47,.19) -> 0 below -1.5°.
 * × (1 - 0.3 cloudCover). opts as makeMoonLight.
 */
export function makeSunLight(ctx, opts = {}) {
  const light = new THREE.DirectionalLight(0xffffff, 0);
  light.name = 'sunLight';
  const S = dirShadow(light, ctx, opts, { final: 2048, preview: 1024, penumbra: 0.005 });
  const obj = new THREE.Group(); obj.add(light); obj.add(light.target);
  return {
    light, object: obj,
    update(t, world) {
      const e = world.sunElev ?? 30;
      const g = 1 - smooth(8, 26, e), h = 1 - smooth(1, 8, e);
      let I = LIGHTS.sunDay.intensity + (LIGHTS.sunGold.intensity - LIGHTS.sunDay.intensity) * g;
      I = I + (LIGHTS.sunLow.intensity - I) * h;
      let c = lerp3(LIGHTS.sunDay.color, LIGHTS.sunGold.color, g);
      c = lerp3(c, LIGHTS.sunLow.color, h);
      const up = smooth(-1.5, 2.0, e);
      light.intensity = I * up * (1 - 0.3 * (world.cloudCover ?? 0)) * (opts.gain ?? 1);
      shadowGate(light);
      light.color.setRGB(c[0], c[1], c[2]);
      placeDir(light, S.state, world.sunDir || [0, 1, 0]);
    },
    setCenter(c, radius) { S.state.center.set(...c); if (radius) S.state.radius = radius; S.apply(); },
    dispose() { light.dispose(); },
  };
}
function pointRig(ctx, opts, base, glowKey, name) {
  const light = new THREE.PointLight(0xffffff, 0, 0, 2);
  light.name = name;
  const home = new THREE.Vector3(...(opts.position || [0, 1.5, 0]));
  light.position.copy(home);
  const q = ctx.quality || 'final';
  light.castShadow = !!opts.castShadow;
  if (light.castShadow) {
    const size = Math.min(1024, opts.mapSize || (q === 'preview' ? 512 : 1024));
    light.shadow.mapSize.set(size, size);
    light.shadow.camera.near = opts.near ?? 0.05; light.shadow.camera.far = opts.far ?? 25;
    light.shadow.bias = opts.bias ?? -0.0015;
    light.shadow.normalBias = opts.normalBias ?? 0.006;
    light.shadow.radius = opts.shadowRadius ?? 3;
  }
  const seed = hashString(name + ':' + (opts.seed ?? 1)) % 100000;
  return {
    light, object: light, home,
    update(t, world) {
      const glow = opts.glow !== undefined ? (typeof opts.glow === 'function' ? opts.glow(world) : opts.glow) : (world.parameters?.[opts.parameter || glowKey] ?? 1);
      const fl = 1 + (opts.flicker ?? base.flicker) * pink1(t * (opts.flickerRate ?? 1.6), seed);
      light.intensity = Math.max(0, base.intensity * glow * fl * (opts.gain ?? 1));
      shadowGate(light);
      light.color.setRGB(...(opts.color || base.color));
      const j = opts.jitter ?? 0.002;
      light.position.set(home.x + j * pink1(t * 2.3, seed + 11), home.y + j * 0.6 * pink1(t * 2.9, seed + 23), home.z + j * pink1(t * 2.1, seed + 37));
    },
    setPosition(p) { home.set(...p); light.position.copy(home); },
    dispose() { light.dispose(); },
  };
}
/** Lantern: PointLight 1.1 cd × practicalLight × (1 ± 12% 1/f flicker), (1,.62,.30), decay 2, flame position jitter. opts: { position, castShadow, mapSize<=1024, shadowRadius, glow } */
export function makeLanternLight(ctx, opts = {}) { return pointRig(ctx, opts, LIGHTS.lantern, 'practicalLight', 'lanternLight'); }
/** Small practical lamp: PointLight 0.2 cd × localLight, (1,.70,.40), subtle flicker. */
export function makeLampLight(ctx, opts = {}) { return pointRig(ctx, { jitter: 0.0008, ...opts }, LIGHTS.lamp, 'localLight', 'lampLight'); }

/**
 * Fallback sky fill (use only when the sky library's IBL is absent): HemisphereLight tuned to the convention
 * (night white-surface ≈ 0.01, day ≈ 0.5). opts: { gain }
 */
export function makeSkyFill(ctx, opts = {}) {
  const light = new THREE.HemisphereLight(0xffffff, 0xffffff, 0);
  light.name = 'skyFill';
  return {
    light, object: light,
    update(t, world) {
      const day = world.day ?? 0, tw = world.twilight ?? 0;
      const night = [0.020, 0.030, 0.052], dayC = [0.9, 1.1, 1.45], dusk = [0.55, 0.42, 0.5];
      let c = lerp3(night, dayC, day); c = lerp3(c, dusk, tw * (1 - day) * 0.6);
      const moon = (world.moonlight ?? 0) * 0.35;
      light.color.setRGB(c[0] * (1 + moon), c[1] * (1 + moon), c[2] * (1 + moon));
      light.groundColor.setRGB(c[0] * 0.35, c[1] * 0.33, c[2] * 0.3);
      light.intensity = opts.gain ?? 1;
    },
    dispose() { light.dispose(); },
  };
}

/**
 * Procedural interior environment (PMREM) for glossy reflections when no sky IBL is available (room shells, macro inserts).
 * A dim room with one bright window (cold) and a small warm lamp. Values are radiances in the exposure convention
 * (window 0.08, walls 0.004, lamp 1.5); scale at runtime with scene.environmentIntensity.
 *   opts: { window:{dir:[x,y,z], color:[r,g,b], radiance, size:[w,h]}, lamp:{pos, radiance, color}, wall:[r,g,b] }
 */
export function makeRoomEnvironment(renderer, opts = {}) {
  const scene = new THREE.Scene();
  const wall = opts.wall || [0.004, 0.0045, 0.006];
  const room = new THREE.Mesh(new THREE.BoxGeometry(6, 3.2, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(...wall), side: THREE.BackSide }));
  room.position.y = 1.2;
  scene.add(room);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(wall[0] * 0.6, wall[1] * 0.55, wall[2] * 0.5) }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.39; scene.add(floor);
  const w = { dir: [-1, 0.25, 0.1], color: [0.62, 0.74, 0.98], radiance: 0.08, size: [1.4, 1.5], ...(opts.window || {}) };
  const wd = new THREE.Vector3(...w.dir).normalize();
  const win = new THREE.Mesh(new THREE.PlaneGeometry(w.size[0], w.size[1]), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(w.color[0] * w.radiance, w.color[1] * w.radiance, w.color[2] * w.radiance), side: THREE.DoubleSide }));
  win.position.copy(wd.clone().multiplyScalar(2.9)); win.lookAt(0, win.position.y, 0);
  scene.add(win);
  // lattice bars in front of the window (so reflections show the window structure)
  const barMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  for (let i = 1; i < 5; i++) { const b = new THREE.Mesh(new THREE.PlaneGeometry(0.03, w.size[1]), barMat); b.position.set((i / 5 - 0.5) * w.size[0], 0, 0.01); win.add(b); }
  for (let j = 1; j < 6; j++) { const b = new THREE.Mesh(new THREE.PlaneGeometry(w.size[0], 0.03), barMat); b.position.set(0, (j / 6 - 0.5) * w.size[1], 0.01); win.add(b); }
  if (opts.lamp !== false) {
    const l = { pos: [1.4, 0.3, 1.2], radiance: 1.5, color: [1.0, 0.7, 0.4], ...(opts.lamp || {}) };
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(l.color[0] * l.radiance, l.color[1] * l.radiance, l.color[2] * l.radiance) }));
    lamp.position.set(...l.pos); scene.add(lamp);
  }
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(scene, 0.02);
  pm.dispose();
  scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  return rt.texture;
}
