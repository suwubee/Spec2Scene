import * as THREE from '../vendor/three.module.js';
import {validateShots,shotAt,cameraAt,applyCamera} from '../camera/index.js';
import {createPost} from '../post/index.js';
import {clamp} from './math.js';
export function createEngine({canvas,shots,scenes,world,width=1280,height=720,post={}}) {
  validateShots(shots);
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true,powerPreference:'low-power'});
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.setPixelRatio(1);renderer.setSize(width,height,false);renderer.outputColorSpace=THREE.LinearSRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;
  const camera=new THREE.PerspectiveCamera(45,width/height,.1,500),pipeline=createPost(renderer,width,height,post);
  let current=0,disposed=false;
  const renderShot=(shot,t,target)=>{const scene=scenes[shot.scene];if(!scene)throw new Error(`unknown scene ${shot.scene}`);
    const state=cameraAt(shot,t);scene.update(t,world.at(t));applyCamera(camera,state);renderer.setRenderTarget(target);renderer.render(scene.scene,camera);return state;};
  const api={ready:false,canvas,duration:shots.at(-1).end,renderer,camera,scenes,post:pipeline,
    seek(t){if(disposed)throw new Error('engine disposed');if(!Number.isFinite(t))throw new TypeError('finite scene time required');current=clamp(t,0,api.duration);
      const {shot,previous,blend}=shotAt(shots,current);const lensOther=previous?renderShot(previous,current,pipeline.b):null;
      const lens=renderShot(shot,current,pipeline.a);pipeline.render({blend,lens,lensOther:lensOther||lens,t:current,exposure:shot.exposure??1});return {t:current,shot:shot.id,lens,blend};},
    resize(w,h){if(!Number.isInteger(w)||!Number.isInteger(h)||w<16||h<16||w>4096||h>4096)throw new Error('render dimensions out of bounds');renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();pipeline.resize(w,h);api.seek(current);},
    capture(){api.seek(current);return canvas.toDataURL('image/png');},
    composition(){const {shot}=shotAt(shots,current),actor=scenes[shot.scene].character?.object;if(!actor)return null;
      const bounds=new THREE.Box3().setFromObject(actor),points=[];
      for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z])points.push(new THREE.Vector3(x,y,z).project(camera));
      const xs=points.map(p=>clamp((p.x+1)/2)),ys=points.map(p=>clamp((p.y+1)/2));
      const width=Math.max(...xs)-Math.min(...xs),height=Math.max(...ys)-Math.min(...ys);return {shot:shot.id,characterAreaFraction:width*height,bounds:{left:Math.min(...xs),bottom:Math.min(...ys),width,height},method:'Conservative projected 3D bounding box; negative space still requires visual annotation'};},
    inspect(){return {time:current,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures};},
    dispose(){disposed=true;pipeline.dispose();for(const item of Object.values(scenes))item.scene.traverse(o=>{o.geometry?.dispose();for(const m of (Array.isArray(o.material)?o.material:[o.material]))m?.dispose();});renderer.dispose();api.ready=false;}
  };
  api.seek(0);api.ready=true;return api;
}
