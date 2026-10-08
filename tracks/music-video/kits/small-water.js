import * as THREE from '../engine/vendor/three.module.js';
import {createGlassReflection} from '../engine/glass.js';
/** True planar scene reflection. Coplanar puddles share this kit's single reflection target. */
export function createSmallWater({kind='basin',radius=.5,height=0,position=[0,0,0],resolution=256,puddles=[[0,0,1]],color=0x424b51}={}){
  if(!['basin','jar','puddle'].includes(kind)||!(radius>0)||!Number.isFinite(height)||!puddles.length||puddles.length>64||puddles.some(p=>p.length!==3||!p.every(Number.isFinite)||p[2]<=0))throw new Error('invalid small water');
  const object=new THREE.Group();object.position.fromArray(position);
  const reflection=createGlassReflection({width:radius*2,height:radius*2,resolution,opacity:.88,tint:0x93b4c4});
  reflection.object.geometry.dispose();reflection.object.geometry=new THREE.CircleGeometry(radius,96);reflection.object.rotation.x=-Math.PI/2;reflection.object.position.y=height;object.add(reflection.object);
  const surfaces=[reflection.object];
  if(kind==='puddle')for(let i=0;i<puddles.length;i++){
    const [x,z,s]=puddles[i],surface=i===0?reflection.object:new THREE.Mesh(reflection.object.geometry,reflection.object.material);
    surface.rotation.x=-Math.PI/2;surface.position.set(x,height,z);surface.scale.set(s,s*.72,1);if(i)object.add(surface);if(i)surfaces.push(surface);
  }
  let shell;
  if(kind!=='puddle'){
    const depth=kind==='jar'?radius*1.7:radius*.45,points=[[0,-depth],[radius*.72,-depth],[radius*.93,-.04],[radius,-.015],[radius*.99,.035],[radius*.91,.035],[radius*.85,-.05],[radius*.67,-depth+.06],[0,-depth+.06]].map(([r,y])=>new THREE.Vector2(r,y+height));
    shell=new THREE.Mesh(new THREE.LatheGeometry(points,96),new THREE.MeshPhysicalMaterial({color,roughness:.48,specularIntensity:.35,side:THREE.DoubleSide}));object.add(shell);
  }
  return {object,reflection,surfaces,update(renderer,scene,camera){const hidden=surfaces.slice(1).map(o=>o.visible);surfaces.slice(1).forEach(o=>o.visible=false);try{return reflection.update(renderer,scene,camera);}finally{surfaces.slice(1).forEach((o,i)=>o.visible=hidden[i]);}},dispose(){reflection.dispose();if(shell){shell.geometry.dispose();shell.material.dispose();}}};
}
