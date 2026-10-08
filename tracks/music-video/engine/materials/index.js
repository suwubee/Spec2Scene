import * as THREE from '../vendor/three.module.js';
const presets = {
  cloth: {color: 0x273541, roughness: .94}, wood: {color: 0x514333, roughness: .78},
  stone: {color: 0x697680, roughness: .85}, metal: {color: 0x384854, metalness: .82, roughness: .32},
  glass: {color: 0xb9d4de, transmission: .85, roughness: .12, thickness: .1, transparent: true},
  skin: {color: 0xbba18c, roughness: .73}, snow: {color: 0x9fbed1, roughness: .83},
};
export function material(kind, options = {}) {
  if (!presets[kind]) throw new Error('unknown material preset');
  const mat = new THREE.MeshPhysicalMaterial({...presets[kind], ...options});
  // Microstructure in world space, entirely procedural; no image assets.
  mat.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vSurface;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurface=position;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vSurface;')
      .replace('#include <color_fragment>', '#include <color_fragment>\nfloat weave=sin(vSurface.x*190.0)*sin(vSurface.y*160.0)*sin(vSurface.z*180.0); diffuseColor.rgb *= 0.97+0.03*weave;');
  };
  return mat;
}
export function lightRig(scene, {color = 0xc5ddff, intensity = 2, position = [8, 12, -5], fill = .4} = {}) {
  const key = new THREE.DirectionalLight(color, intensity); key.position.fromArray(position);
  key.castShadow=true;key.shadow.mapSize.set(1024,1024);key.shadow.camera.left=-18;key.shadow.camera.right=18;key.shadow.camera.top=18;key.shadow.camera.bottom=-18;key.shadow.normalBias=.03;key.shadow.bias=-.0001;
  scene.add(key, new THREE.HemisphereLight(0x8aadc9, 0x121c2c, fill));
  return key;
}
export function windowLight(scene, position, color = 0xffbb76, intensity = 30) {
  const light = new THREE.PointLight(color, intensity, 18, 2); light.position.fromArray(position); scene.add(light); return light;
}

export function threePoint(scene,options={}) {
  const key=lightRig(scene,options),rim=new THREE.DirectionalLight(options.rimColor??0xa5cae5,options.rimIntensity??1);
  rim.position.set(-4,3,-5);scene.add(rim);return {key,rim};
}
