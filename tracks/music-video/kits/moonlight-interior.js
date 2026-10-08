import * as THREE from '../engine/vendor/three.module.js';
/** Motivated area-light approximation: floor bounce plus broad wall diffuse fill. No GI claim. */
export function createInteriorMoonlight({window=[0,2,-2],floor=[0,.12,0],wall=[0,1.4,1.8],intensity=1,color=0xb8cce2,bounce=.22,diffuse=.12,range=8}={}){
  const object=new THREE.Group(),key=new THREE.SpotLight(color,intensity,range,Math.PI/3,.85,2),ground=new THREE.PointLight(color,intensity*bounce,range,2),fill=new THREE.PointLight(color,intensity*diffuse,range,2);
  key.position.fromArray(window);key.target.position.fromArray(floor);ground.position.fromArray(floor);fill.position.fromArray(wall);object.add(key,key.target,ground,fill);
  return {object,key,ground,fill,update(t,w={}){const gain=Math.max(0,w.moonlight??1);key.intensity=intensity*gain;ground.intensity=intensity*bounce*gain;fill.intensity=intensity*diffuse*gain;},dispose(){key.dispose();ground.dispose();fill.dispose();}};
}
