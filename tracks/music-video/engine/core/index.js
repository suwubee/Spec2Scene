// Author: suwubee
import * as THREE from '../vendor/three.module.js';
import {createEngine as createFilmEngine} from '../core.js';
import {createTimeline,cameraFromShot} from '../timeline.js';
import {shotAt} from '../camera/index.js';
import {defaultEnvironment} from '../world/environment.js';
/** Async adapter: scene factories receive the original engine context. */
export async function createEngine({canvas,shots,scenes,world=defaultEnvironment,width=1280,height=720,quality='auto',post={},...options}) {
  const timeline=createTimeline(shots),sets={};
  for(const [id,definition] of Object.entries(scenes))sets[id]={create:async ctx=>{
    const inst=typeof definition==='function'?await definition(ctx):definition;
    inst.camera ||= new THREE.PerspectiveCamera(35,ctx.aspect,.05,30000);
    const update=inst.update;
    return {...inst,cameraAt(t,shot){return cameraFromShot(shot,shot.t0+t);},update(t,shot,c){update?.(c.t,c.state,inst.camera,shot,c);}};
  }};
  let native=await createFilmEngine({canvas,width,height,world,quality,timeline,sets,lyrics:false,postOverride:post,...options});
  let current=0,disposed=false;
  const seek=async(t,opts)=>{if(disposed)throw new Error('engine disposed');const result=await native.seek(t,opts);current=result.t;return {...result,shot:shotAt(shots,current).shot.id};};
  const api={...native,ready:false,seek,
    capture(){return canvas.toDataURL('image/png');},
    async composition(){const {shot}=shotAt(shots,current),inst=await native.getSet(shot.scene),actor=inst.character?.object;if(!actor)return {shot:shot.id,characterAreaFraction:0};
      const box=new THREE.Box3().setFromObject(actor),points=[];
      for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z])points.push(new THREE.Vector3(x,y,z).project(inst.camera));
      const xs=points.map(p=>Math.max(0,Math.min(1,(p.x+1)/2))),ys=points.map(p=>Math.max(0,Math.min(1,(p.y+1)/2)));
      return {shot:shot.id,characterAreaFraction:(Math.max(...xs)-Math.min(...xs))*(Math.max(...ys)-Math.min(...ys))};},
    inspect(){return {time:current,quality:native.qualityInfo,drawCalls:native.renderer.info.render.calls,triangles:native.renderer.info.render.triangles,errors:native.errors};},
    async resize(w,h){if(!Number.isInteger(w)||!Number.isInteger(h)||w<16||h<16||w>4096||h>4096)throw new Error('render dimensions out of bounds');
      // Recreate fixed-size render targets and procedural libraries through the same factory contract.
      api.ready=false;native.dispose();native=await createFilmEngine({canvas,width:w,height:h,world,quality,timeline,sets,lyrics:false,postOverride:post,...options});
      const methods={seek:api.seek,resize:api.resize,dispose:api.dispose};Object.assign(api,native,methods);await seek(current);api.ready=true;return api;},
    dispose(){disposed=true;api.ready=false;native.dispose();}
  };
  await api.seek(0);api.ready=true;return api;
}
