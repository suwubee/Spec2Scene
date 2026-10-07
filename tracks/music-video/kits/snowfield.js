// Author: suwubee
import * as THREE from '../engine/vendor/three.module.js';
import {hillsAt} from '../engine/terrain.js';
import {gnoise2,makeRng} from '../engine/noise.js';
import {footprintField} from '../engine/traces/index.js';
import {createMistCards,createLightShaft,createDust} from '../engine/particles.js';
import {environment,mesh} from './common.js';
export function snowHeight(x,z){return .05+ .12*gnoise2(x*.17,z*.12)+.025*gnoise2(x*.95,z*.5)+.012*gnoise2(x*6+z*.8,z*.6);}
/** New snow kit uses the transplanted ridged multifractal, atmosphere and particle library. */
export function createSnowfield(ctx,{seed=71,tracks={},mountains=true}={}) {
  const E=environment(ctx,{sky:{cloudDensity:.016,moonScale:2.6,stars:.3,mie:9,cloudBase:1050,cloudTop:1750,cirrus:.35},fog:.00048,fill:.1});
  const {scene}=E,field=footprintField(tracks),rng=makeRng(seed);
  const N=256,data=new Uint8Array(N*N*4);for(let i=0;i<N*N;i++){const v=110+rng()*145;data.set([v,v,v,255],i*4);}
  const grain=new THREE.DataTexture(data,N,N);grain.wrapS=grain.wrapT=THREE.RepeatWrapping;grain.repeat.set(360,360);grain.needsUpdate=true;
  const snow=new THREE.MeshPhysicalMaterial({color:0xa7bfce,roughness:.8,bumpMap:grain,bumpScale:.022,clearcoat:.13,clearcoatRoughness:.6});
  const xs=[-500,-250,-100,-50,-20,-8];for(let x=-4;x<=4.001;x+=.075)xs.push(x);xs.push(8,20,50,100,250,500);
  const zs=[-1500,-800,-400,-200,-100,-60];for(let z=-35;z<=14.001;z+=.085)zs.push(z);zs.push(25,60,150,500);
  const pos=[],uv=[],idx=[];for(const z of zs)for(const x of xs){pos.push(x,snowHeight(x,z)+field.height(x,z),z);uv.push(x/500,z/500);}
  for(let j=0;j<zs.length-1;j++)for(let i=0;i<xs.length-1;i++){const a=j*xs.length+i;idx.push(a,a+xs.length,a+1,a+1,a+xs.length,a+xs.length+1);}
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geo.setIndex(idx);geo.computeVertexNormals();const ground=mesh(geo,snow);ground.castShadow=false;scene.add(ground);
  const ridges=[];
  if(mountains)for(let layer=0;layer<3;layer++){
    const d=[900,1900,3400][layer],w=[3100,5200,8400][layer],depth=700+layer*500,g=new THREE.PlaneGeometry(w,depth,240,70);g.rotateX(-Math.PI/2);
    const a=g.attributes.position;for(let i=0;i<a.count;i++){const x=a.getX(i),z=a.getZ(i)-d;
      const h=hillsAt(x*.75+1170+layer*960,z*.75-4300)*(.48+layer*.3);
      const edge=Math.max(0,Math.sin(Math.PI*(z+d+depth/2)/depth));a.setXYZ(i,x,Math.max(0,h*(.4+layer*.12)*Math.pow(edge,.65)-8),z);}
    g.computeVertexNormals();const mat=new THREE.MeshStandardMaterial({color:[0x698596,0x7796a9,0x8a9fb0][layer],roughness:.98,flatShading:false});
    const m=mesh(g,mat);m.castShadow=false;scene.add(m);ridges.push(m);
  }
  const mist=createMistCards(ctx,{seed,count:5,region:{center:[0,1,-65],size:[180,3,135]},density:.27,scale:14,tint:[.7,.84,1]});scene.add(mist.object);
  const beams=[[-45,48,-125],[-14,55,-180],[65,85,-260]].map((origin,i)=>createLightShaft(ctx,{kind:'cylinder',origin,dir:[.55,-.75,.35],radius:4+i*3,length:100+i*50,density:.012,color:[.42,.62,.92],intensity:.3,noise:.7,g:.4}));beams.forEach(b=>scene.add(b.object));
  const powder=createDust(ctx,{seed:'snow-powder',maxCount:ctx.quality==='final'?2400:800,box:{center:[0,1,-8],size:[36,3,65]},size:.016,gain:5,lightColor:[.16,.22,.32],lightDir:[-.3,-.1,1],windScale:1.4,moonBoost:2});scene.add(powder.object);
  return {...E,field,ground,ridges,update(t,w,c){E.update(t,w,c);mist.update(t,w,c);powder.update(t,w,c);beams.forEach(b=>b.update(t,w,c));},dispose(){mist.dispose();powder.dispose();beams.forEach(b=>b.dispose());grain.dispose();E.dispose();}};
}
