// Author: suwubee
import * as THREE from '../engine/vendor/three.module.js';
import {createTreeBatch} from './plants/batch.js';
import {prepareKit} from './plants/kit.js';
import {genTuft,genReed} from './plants/trees.js';
import {environment,box} from './common.js';
/** Explicit project placement list; no researched site coordinates are distributed. */
export async function createVegetation(ctx,{items=[{species:'pine',x:-4,z:-3,h:6},{species:'willow',x:1,z:-4,h:5},{species:'bamboo',x:4,z:-3,h:4}],grass=28,reeds=12}={}) {
  const E=environment(ctx,{fog:.003,fill:.12}),env={...ctx,THREE,renderer:ctx.renderer,quality:ctx.qualityInfo?.name||'medium',camera:E.camera,scene:E.scene,ground:{heightAt:()=>0}},kit=await prepareKit(env),trees=await createTreeBatch(env,items,{groundY:0});E.scene.add(trees.group);
  E.scene.add(box([40,.1,40],E.materials.bluestone({seed:12}),[0,-.12,0]));
  for(const [count,geometry,offset] of [[grass,genTuft(0).toGeometry(THREE),0],[reeds,genReed().toGeometry(THREE),4]]){
    const m=new THREE.InstancedMesh(geometry,kit.matMain,count),mat=new THREE.Matrix4();for(let i=0;i<count;i++){mat.makeTranslation(-5+(i%10)*.68,0,offset+Math.floor(i/10)*.6);m.setMatrixAt(i,mat);}m.customDepthMaterial=kit.depth;m.castShadow=true;E.scene.add(m);
  }
  return {...E,trees,update(t,w,c){E.update(t,w,c);kit.U.uWind.value.set(...w.windDir,w.wind);trees.update(t,c);},dispose(){E.dispose();}};
}
