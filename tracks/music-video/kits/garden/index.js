// Author: suwubee
import * as THREE from '../../engine/vendor/three.module.js';
import {blockStone,porousStone} from './geom.js';
import {bakeRockNoise,makeRockMaterial} from './material.js';
import {bakePebbles} from './textures.js';
import {createPlumTree,createPlumBranch} from '../plumBranch.js';
import {environment,mesh,box} from '../common.js';
export function rockGeometry(data){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(data.pos,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(data.nor,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(data.aux,2));g.setIndex(Array.from(data.idx));return g;}
export function createGarden(ctx,{seed=14,stones=5,treeHeight=3}={}) {
  const E=environment(ctx,{fog:.003,fill:.1}),noise=bakeRockNoise(THREE,128),stone=makeRockMaterial(THREE,noise,1,{waterY:-1});
  for(let i=0;i<stones;i++){const data=i%2?blockStone(seed+i,'chunk'):porousStone(seed+i,{W:.65,H:1.5+i*.18,holes:4,blobs:6,standing:true},ctx.quality==='final'?18:10);const m=mesh(rockGeometry(data),stone,[-1.5+i*.72,0,-1-(i%2)]);E.scene.add(m);}
  const pebbles=bakePebbles(THREE,128),paving=new THREE.MeshStandardMaterial({color:0x738080,roughness:.7,bumpMap:pebbles,bumpScale:.065});pebbles.repeat.set(9,9);
  E.scene.add(box([12,.15,12],paving,[0,-.1,0]));
  const tree=createPlumTree(ctx,{seed,height:treeHeight,lod:'mid',maxFlowers:1200,bloom:.7,anchor:{pos:[-2.5,0,-2]}});E.scene.add(tree.object);
  const branch=createPlumBranch(ctx,{seed:seed+1,length:.8,bloom:.8,anchor:{pos:[1.7,1.4,0]}});E.scene.add(branch.object);E.scene.add(box([.35,1.4,.35],stone,[1.7,.7,0]));
  return {...E,tree,branch,update(t,w,c){E.update(t,w,c);tree.update(t,w,c,{bloom:.7});branch.update(t,w,c,{bloom:.8});},dispose(){tree.dispose();branch.dispose();noise.dispose();pebbles.dispose();E.dispose();}};
}
