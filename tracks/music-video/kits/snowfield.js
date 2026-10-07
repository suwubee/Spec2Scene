// Author: suwubee
import * as THREE from '../engine/vendor/three.module.js';
import {hillsAt} from '../engine/terrain.js';
import {gnoise2,makeRng} from '../engine/noise.js';
import {footprintField} from '../engine/traces/index.js';
import {createMistCards,createLightShaft,createDust} from '../engine/particles.js';
import {environment,mesh} from './common.js';
import {continuousHeightfield} from './heightfield.js';
export function snowHeight(x,z){return .05+ .12*gnoise2(x*.17,z*.12)+.025*gnoise2(x*.95,z*.5)+.012*gnoise2(x*6+z*.8,z*.6);}
/** New snow kit uses the transplanted ridged multifractal, atmosphere and particle library. */
export function createSnowfield(ctx,{seed=71,tracks={},mountains=true,terrain={},skyPreset='coldNight'}={}) {
  const E=environment(ctx,{sky:{preset:skyPreset,cloudDensity:.016,moonScale:2.6,stars:.3,mie:9,cloudBase:1050,cloudTop:1750,cirrus:.35},fog:.00048,fill:.1});
  const {scene}=E,field=footprintField({depth:.065,...tracks}),rng=makeRng(seed);
  const N=256,data=new Uint8Array(N*N*4);for(let i=0;i<N*N;i++){const v=110+rng()*145;data.set([v,v,v,255],i*4);}
  const grain=new THREE.DataTexture(data,N,N);grain.wrapS=grain.wrapT=THREE.RepeatWrapping;grain.repeat.set(360,360);grain.needsUpdate=true;
  const snow=new THREE.MeshPhysicalMaterial({color:0xb8cedb,roughness:.76,bumpMap:grain,bumpScale:.016,clearcoat:.18,clearcoatRoughness:.5});
  const baseHeight=(x,z)=>{
    const far=THREE.MathUtils.smoothstep(Math.hypot(x,z),240,950);
    return snowHeight(x,z)+(mountains?far*hillsAt(x*.7+1170,z*.7-4300)*.32:0);
  };
  const surface=continuousHeightfield({x:{min:-6000,max:6000,nearMin:-1.4,nearMax:1.4,step:.025},z:{min:-10000,max:3000,nearMin:-35,nearMax:14,step:.04},...terrain,height:(x,z,t)=>baseHeight(x,z)+field.height(x,z,t)});
  const geo=surface.geometry,ground=mesh(geo,snow);ground.castShadow=false;scene.add(ground);
  const ridges=[];
  const mist=createMistCards(ctx,{seed,count:5,region:{center:[0,1,-65],size:[180,3,135]},density:.27,scale:14,tint:[.7,.84,1]});scene.add(mist.object);
  const beams=[[-45,48,-125],[-14,55,-180],[65,85,-260]].map((origin,i)=>createLightShaft(ctx,{kind:'cylinder',origin,dir:[.55,-.75,.35],radius:4+i*3,length:100+i*50,density:.018,color:[.42,.62,.92],intensity:.9,noise:.7,g:.25}));beams.forEach(b=>scene.add(b.object));
  const powder=createDust(ctx,{seed:'snow-powder',maxCount:ctx.quality==='final'?2400:800,box:{center:[0,1,-8],size:[36,3,65]},size:.016,gain:5,lightColor:[.16,.22,.32],lightDir:[-.3,-.1,1],windScale:1.4,moonBoost:2});scene.add(powder.object);
  return {...E,field,ground,ridges,surface,update(t,w,c){surface.update(t);E.update(t,w,c);mist.update(t,w,c);powder.update(t,w,c);beams.forEach(b=>b.update(t,w,c));},dispose(){mist.dispose();powder.dispose();beams.forEach(b=>b.dispose());grain.dispose();E.dispose();}};
}
