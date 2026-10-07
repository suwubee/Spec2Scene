import * as THREE from '../engine/vendor/three.module.js';
const presets={cloth:{color:0x635346,roughness:.92},skin:{color:0xc28c71,roughness:.68},metal:{color:0x222222,roughness:.6,metalness:.1}};
export function material(kind,options={}){
  if(!presets[kind])throw new Error('unknown character material');
  const mat=new THREE.MeshPhysicalMaterial({...presets[kind],...options});
  if(kind==='skin'){
    // A restrained warm wrap term approximates skin scattering. No transmission
    // claim: this does not simulate layered skin or replace a close-up asset.
    mat.onBeforeCompile=shader=>{
      shader.fragmentShader=shader.fragmentShader.replace('#include <lights_physical_pars_fragment>',`#include <lights_physical_pars_fragment>
void characterSkinLight(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
  RE_Direct_Physical(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  float wrap = max(0.0, (dot(geometryNormal, directLight.direction) + 0.45) / 1.45) * 0.09;
  reflectedLight.directDiffuse += directLight.color * material.diffuseColor * vec3(1.0, 0.42, 0.28) * wrap;
}
#undef RE_Direct
#define RE_Direct characterSkinLight`);
    };
    mat.customProgramCacheKey=()=> 'character-skin-wrap-v1';
  }
  return mat;
}
