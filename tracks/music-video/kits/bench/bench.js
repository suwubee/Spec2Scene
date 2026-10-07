// Author: suwubee
import * as THREE from '../../engine/vendor/three.module.js';
import {createEngine} from '../../engine/core.js';
import {createEnvironment} from '../../engine/world/environment.js';
import {createSnowfield} from '../snowfield.js';
import {createStation} from '../station.js';
import {createRiver} from '../river.js';
import {createInterior} from '../interior.js';
import {createArchitecture} from '../architecture.js';
import {createGarden} from '../garden/index.js';
import {createVegetation} from '../vegetation.js';
import {environment,mesh,box} from '../common.js';
import {lathe,cupProfile,thickenProfile} from '../../engine/geo.js';
import {createRain,createSteam,createLightShaft,createDust,createPetals,createFireflies,createMistCards} from '../../engine/particles.js';
const q=new URLSearchParams(location.search),kind=document.body.dataset.kit,width=+(q.get('w')||1920),height=+(q.get('h')||1080),canvas=document.querySelector('canvas');
const worlds={rain:[[0,kind==='station'||kind==='particles'?.7:0]],moonElev:[[0,20]],moonAzim:[[0,335]],wind:[[0,.35]],mist:[[0,.5]],bloomAmount:[[0,.7]]};
if(q.has('day'))Object.assign(worlds,{day:[[0,1]],sunElev:[[0,25]],sunAzim:[[0,140]]});
const world=createEnvironment(worlds,{tableLamp:[[0,.7]]});
const cameras={snowfield:[[12,9,30],[0,1,-80],19],station:[[2,2.2,14],[-3,1.8,-22],24],river:[[15,8,110],[0,10,-700],20],interior:[[3.9,1.8,2.8],[.1,1.4,0],18],architecture:[[7,3.8,8],[0,1.8,0],24],garden:[[5,2.5,7],[0,1.0,-1],24],vegetation:[[12,5,15],[0,2,0],24],sky:[[0,2,0],[-25,15,-70],18],materials:[[4,2.5,5],[0,1,0],24],particles:[[3,2.0,5],[0,1.5,0],24]};
async function create(ctx){
 const factories={snowfield:createSnowfield,station:createStation,river:createRiver,interior:createInterior,architecture:createArchitecture,garden:createGarden,vegetation:createVegetation};
 let E;
 if(factories[kind])E=await factories[kind](ctx);else{
  E=environment(ctx,{fill:.1});const M=E.materials;
  if(kind==='materials'){
   const materials=[M.wood(),M.bluestone({wet:.8,puddles:.6}),M.ceramic('porcelain'),M.gauze(),M.iron(),M.plaster()];
   materials.forEach((m,i)=>E.scene.add(mesh(new THREE.SphereGeometry(.48,40,32),m,[(i%3-1)*1.2,.65,-Math.floor(i/3)*1.35])));
  }
  if(kind==='particles'){
   E.scene.add(box([8,.12,8],M.bluestone(),[0,-.1,0]),box([8,4,.2],M.plaster(),[0,1.9,-3]));
   E.scene.add(box([1.5,.1,1],M.wood(),[-.6,.6,0]));
   const cup=lathe(thickenProfile(cupProfile({radius:.18,height:.22,footR:.1,footH:.03}),.015));
   E.scene.add(mesh(cup,M.ceramic('porcelain'),[-.6,.65,0]));
   const backlight=new THREE.PointLight(0xffd3a0,22,10,2);backlight.position.set(-1,2.2,-1.5);E.scene.add(backlight);
   E.scene.add(mesh(new THREE.SphereGeometry(.07,16,12),new THREE.MeshStandardMaterial({emissive:0xffc78c,emissiveIntensity:4}),backlight.position.toArray()));
   const shaft=createLightShaft(ctx,{kind:'cylinder',origin:[1,3.2,-1],dir:[-.2,-1,.3],radius:.55,length:3.3,color:[.5,.7,1],intensity:1.5,density:.22});
   const lighting={lights:[backlight],pointGain:3};
   const systems=[shaft,createDust(ctx,{shaft,maxCount:800,gain:5}),createRain(ctx,{...lighting,density:.3,moonBoost:18}),createSteam(ctx,{...lighting,origin:[-.6,.87,0],height:1,radius:.12,width:.012,opacity:2,scale:1}),createPetals(ctx,{...lighting,box:{center:[0,1.5,0],size:[4,3,4]},density:2,maxCount:120}),createFireflies(ctx,{count:28}),createMistCards(ctx,{...lighting,count:2,density:.15})];
   systems.forEach(s=>E.scene.add(s.object));const update=E.update,dispose=E.dispose;E.update=(t,w,c)=>{const a={...w,petalFall:.8,steam:1};update(t,a,c);systems.forEach(s=>s.update(t,a,c));};E.dispose=()=>{systems.forEach(s=>s.dispose());dispose();};
  }
 }
 const [pos,target,focal]=cameras[kind],update=E.update;
 return {...E,cameraAt:()=>({pos,target,focal,focus:{distance:new THREE.Vector3(...pos).distanceTo(new THREE.Vector3(...target)),fstop:5.6}}),update(t,shot,c){update(c.t,c.state,E.camera);}};
}
try{
 const shot={id:kind,set:kind,t0:0,t1:60},timeline={FPS:24,DURATION:60,shots:[shot],resolve:t=>[{shot,tLocal:t,weight:1,gain:1,fade:1}]};
 const engine=await createEngine({canvas,width,height,world,timeline,sets:{[kind]:{create}},quality:q.get('quality')||'final',lyrics:false});await engine.seek(+(q.get('t')||4));
 const api={...engine,engine,ready:true,capture:()=>canvas.toDataURL('image/png')};window.__scene=api;window.__mv=api;
 document.querySelector('output').textContent=`${kind} · ${engine.qualityInfo.name} · ${width}×${height}`;
 window.addEventListener('pagehide',()=>engine.dispose());
}catch(e){window.__sceneError=e.stack;document.querySelector('output').textContent=e.message;console.error(e);}
