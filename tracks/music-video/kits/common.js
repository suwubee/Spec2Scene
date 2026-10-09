// Author: suwubee
import * as THREE from '../engine/vendor/three.module.js';
import {createSky} from '../engine/sky.js';
import {createMaterials} from '../engine/materials.js';
import {disposeOwned} from '../engine/release.js';
export function environment(ctx,{sky:options={},fog=.003,fill=.06}={}) {
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(35,ctx.aspect,.05,30000);
  const sky=createSky(ctx,{...options,budget:ctx.quality==='final'?'high':'low'});
  scene.add(sky.object,sky.overlay);
  scene.fog=new THREE.FogExp2(0x263a49,fog);
  const key=new THREE.DirectionalLight(0xb4cee8,.7);key.castShadow=true;
  key.shadow.mapSize.setScalar(ctx.qualityInfo?.shadow||1024);Object.assign(key.shadow.camera,{left:-75,right:75,top:75,bottom:-75,near:.1,far:400});key.shadow.normalBias=.025;key.shadow.bias=-.00015;
  scene.add(key,key.target,new THREE.HemisphereLight(0x99b5d1,0x172233,fill));
  const materials=createMaterials(ctx,{anisotropy:4});
  return {scene,camera,sky,key,materials,
    update(t,w,cam=camera){sky.update(t,w,cam);scene.environment=sky.getEnvironment();scene.environmentIntensity=.38;
      key.position.fromArray(w.day>.5?w.sunDir:w.moonDir).multiplyScalar(150);key.target.position.set(0,0,-20);key.intensity=w.day>.5?2.2:.65*(w.moonlight??1);materials.update(t,w);},
    dispose(){sky.dispose();materials.dispose();disposeObject(scene);}
  };
}
/** Release scene-owned resources; callers may pass shared cache resources to keep. */
export function disposeObject(object, options = {}) { return disposeOwned(object, options); }
export function mesh(geometry,material,position=[0,0,0]){const m=new THREE.Mesh(geometry,material);m.position.fromArray(position);m.castShadow=true;m.receiveShadow=true;return m;}
export function box(size,material,position){return mesh(new THREE.BoxGeometry(...size),material,position);}
