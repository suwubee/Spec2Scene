// Lower-cost geometry for the same sample spaces and shot table. Final capture uses scenes.js.
import * as THREE from '../engine/vendor/three.module.js';
import {createDistantCharacter} from './distant-character.js';
import {makeRng} from '../engine/noise.js';
import {mergeGeometries} from '../engine/vendor/BufferGeometryUtils.js';

export function createRealtimeScene(ctx,kind) {
  const q=ctx.playback,scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(35,ctx.aspect,.05,30000);
  scene.background=new THREE.Color(0x0b1627);scene.fog=new THREE.FogExp2(0x13283a,kind==='snow'?.0018:.008);
  const light=new THREE.DirectionalLight(0xb4d7ff,1.2);light.position.set(-30,65,-55);light.castShadow=true;
  light.shadow.mapSize.setScalar(q.shadow);Object.assign(light.shadow.camera,{left:-60,right:60,top:60,bottom:-60,near:.1,far:220});light.shadow.normalBias=.03;
  scene.add(light,new THREE.HemisphereLight(0x93b4dd,0x27364a,.7));
  const materials=[];
  const material=(color,extra={})=>{const m=new THREE.MeshStandardMaterial({color,roughness:.8,...extra});materials.push(m);return m;};
  const box=(size,pos,mat)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(...size),mat);m.position.fromArray(pos);m.castShadow=true;m.receiveShadow=true;scene.add(m);return m;};
  const character=createDistantCharacter();scene.add(character.object);
  const rng=makeRng(kind),snow=kind==='snow';
  if(snow) {
    const ground=new THREE.Mesh(new THREE.PlaneGeometry(14000,14000),material(0x9fb6cc));ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
    const ridge=material(0x344c68);
    for(let i=0;i<18;i++) {const m=new THREE.Mesh(new THREE.ConeGeometry(100+rng()*250,90+rng()*210,7),ridge);m.position.set((i-9)*200,25,-1200-rng()*900);scene.add(m);}
    const moon=new THREE.Mesh(new THREE.SphereGeometry(19,20,12),new THREE.MeshBasicMaterial({color:0xd8e5ed}));moon.position.set(-260,360,-1600);scene.add(moon);
    const mark=material(0x647e98);
    for(let i=0;i<100;i++) {const m=box([.12,.008,.28],[i%2?.16:-.16,.006,9-i*.38],mark);m.rotation.y=i%2?.12:-.12;}
  } else {
    const stone=material(0x394954,{metalness:.18,roughness:.35}),metal=material(0x263544,{metalness:.5}),wood=material(0x403d39);
    box([11,.3,88],[-3,-.2,-27],stone);box([7.8,.25,62],[-4,4.95,-23],wood);
    for(const z of [4,-8,-20,-32]) {
      box([.16,4.5,.16],[-1.65,2.25,z],metal);box([6.8,.16,.12],[.35,4.55,z],metal);
      box([1.2,.045,.22],[.35,4.5,z],material(0xffce86,{emissive:0xffb957,emissiveIntensity:4}));
      const lamp=new THREE.PointLight(0xffc083,28,14,2);lamp.position.set(.35,4.3,z);scene.add(lamp);
    }
    const wall=material(0x223043),windowMat=material(0x819caf,{emissive:0x718da0,emissiveIntensity:.3});
    for(let i=0;i<22;i++) {const z=12-i*10,h=7+rng()*22,x=i%2?28:-28;box([8,h,7],[x,h/2,z],wall);box([.05,h*.65,2.5],[x+(x>0?-4.03:4.03),h*.5,z],windowMat);}
    for(const x of [4.4,6.1,10.5,12.2])box([.09,.12,150],[x,-.06,-45],metal);
    for(let z=20;z>-100;z-=2)box([9,.12,.22],[8,-.18,z],wood);
    box([2.6,.12,.6],[-4,.56,-5],wood);for(const x of [-4.9,-3.1])box([.09,.5,.5],[x,.25,-5],metal);
    character.object.position.set(-3,.04,-27);character.object.rotation.y=Math.PI;
  }
  const count=Math.round(1600*q.particles),positions=new Float32Array(count*3),base=new Float32Array(count*3);
  for(let i=0;i<count;i++)base.set([(rng()-.5)*60,rng()*18,-rng()*90],i*3);
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3));
  const particles=new THREE.Points(geo,new THREE.PointsMaterial({color:snow?0xc6d9e8:0x8caabe,size:snow?.06:.035,transparent:true,opacity:.65}));scene.add(particles);
  // Static meshes sharing a material become one draw, without deleting triangles or opening surfaces.
  const batches=new Map();scene.updateMatrixWorld(true);
  for(const child of [...scene.children])if(child.isMesh) {
    const key=child.material;let batch=batches.get(key);if(!batch)batches.set(key,batch={geometries:[],cast:false,receive:false});
    batch.geometries.push(child.geometry.clone().applyMatrix4(child.matrixWorld));batch.cast ||= child.castShadow;batch.receive ||= child.receiveShadow;
    scene.remove(child);child.geometry.dispose();
  }
  for(const [mat,batch] of batches) {
    const merged=mergeGeometries(batch.geometries);batch.geometries.forEach(g=>g.dispose());
    const m=new THREE.Mesh(merged,mat);m.castShadow=batch.cast;m.receiveShadow=batch.receive;scene.add(m);
  }
  return {scene,camera,character,update(t){
    if(snow) {character.update('windWalk',t,{distance:t*.22});character.object.position.set(.4,.02,-28);}
    else character.update('stand',t);
    for(let i=0;i<count;i++){positions[i*3]=base[i*3]+Math.sin(t*.3+i)*.25;positions[i*3+1]=(base[i*3+1]-t*(snow?.4:9)%18+18)%18;positions[i*3+2]=base[i*3+2];}
    geo.attributes.position.needsUpdate=true;
  },dispose(){const gs=new Set(),ms=new Set();scene.traverse(o=>{if(o.geometry)gs.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:[o.material])if(m)ms.add(m);});gs.forEach(g=>g.dispose());ms.forEach(m=>m.dispose());}};
}
