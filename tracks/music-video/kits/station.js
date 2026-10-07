// Author: suwubee
import * as THREE from '../engine/vendor/three.module.js';
import {makeRng} from '../engine/noise.js';
import {createAtmosphere} from '../engine/terrain.js';
import {createWater} from '../engine/water.js';
import {createRain,createLightShaft,createMistCards} from '../engine/particles.js';
import {environment,box,mesh} from './common.js';
/** Parametric platform, volumetric city blocks, wet-film reflections and lit rain. No station identity or signage. */
export function createStation(ctx,{seed=29,lamps=[[.35,4.5,4],[.35,4.5,-8],[.35,4.5,-20],[.35,4.5,-32]]}={}) {
  const E=environment(ctx,{sky:{cloudDensity:.028,stars:.12,moonScale:1.3},fog:.006,fill:.035}),{scene,materials:M}=E,rng=makeRng(seed);
  E.key.intensity=.22;
  const stone=M.bluestone({seed,wet:.85,puddles:.65,uvScale:1}),metal=new THREE.MeshStandardMaterial({color:0x232930,metalness:.8,roughness:.5});
  const roofMat=M.wood({seed:seed+2,wet:.15,color:new THREE.Color(.1,.11,.12)});
  const platform=box([11,.3,88],stone,[-3,-.2,-27]);scene.add(platform);
  const paving=box([10,.015,85],stone,[-3,.008,-27]);scene.add(paving);
  const canopy=box([7.8,.25,62],roofMat,[-4,4.95,-23]);scene.add(canopy);
  const lightMeshes=[],lights=[],beams=[];
  const yellow=new THREE.MeshStandardMaterial({color:0xb29a68,roughness:.92});
  for(let z=13;z>-69;z-=.6)scene.add(box([.22,.025,.37],yellow,[2,.03,z]));
  for(const [x,y,z] of lamps){
    scene.add(box([.16,y,.16],metal,[x-2,y/2,z]));scene.add(box([6.8,.16,.12],metal,[x,y+.05,z]));
    const bulb=box([1.2,.045,.22],new THREE.MeshStandardMaterial({color:0xffce86,emissive:0xffb957,emissiveIntensity:7}),[x,y,z]);scene.add(bulb);lightMeshes.push(bulb);
    const light=new THREE.PointLight(0xffc083,7,18,2);light.position.set(x,y-.15,z);light.userData.radius=.2;scene.add(light);lights.push(light);
    const beam=createLightShaft(ctx,{kind:'cylinder',origin:[x,y-.2,z],dir:[0,-1,0],radius:1.25,length:y-.2,density:.035,color:[1,.59,.27],intensity:.32,noise:.6,g:.35});scene.add(beam.object);beams.push(beam);
  }
  const city=new THREE.Group();
  for(let row=0;row<3;row++)for(let i=0;i<17;i++){
    const x=(row===2?-36:20+row*25)+(rng()-.5)*9,z=22-i*13+(rng()-.5)*9,h=7+rng()*28,w=5+rng()*8;
    const wall=new THREE.MeshStandardMaterial({color:new THREE.Color().setRGB(.022+row*.004,.028+row*.006,.04+row*.008),roughness:.9});
    city.add(box([w,h,7+rng()*7],wall,[x,h/2,z]));
    for(let y=2;y<h-1;y+=2.2)for(let zz=z-3;zz<z+3;zz+=1.65)if(rng()>.55){const c=rng()>.32?0x90b1c5:0xd9a368;const wm=new THREE.MeshStandardMaterial({color:c,emissive:c,emissiveIntensity:.18+rng()*.55});city.add(box([.025,.9,.75],wm,[x-w/2-.02,y,zz]));}
  }scene.add(city);
  for(const x of [4.4,6.1,10.5,12.2])scene.add(box([.085,.12,150],metal,[x,-.06,-45]));
  for(let z=25;z>-105;z-=.8)scene.add(box([9,.12,.22],roofMat,[8,-.18,z]));
  const bench=new THREE.Group();for(let i=0;i<5;i++)bench.add(box([2.6,.065,.1],roofMat,[0,0,i*.13]));for(const x of [-.9,.9])bench.add(box([.075,.5,.55],metal,[x,-.28,.25]));bench.position.set(-4,.56,-5);scene.add(bench);
  const atmos=createAtmosphere(ctx,{sky:E.sky});
  const film=createWater(ctx,{atmos,sky:E.sky,size:150,planeY:.018,rain:true,reflScale:.5});film.object.position.y=.018;scene.add(film.object);film.object.scale.set(.073,1,.57);film.object.position.x=-3;film.object.position.z=-27;
  film.uniforms.uBody.value.set(.028,.037,.044);
  film.material.transparent=true;film.material.depthWrite=false;
  film.material.fragmentShader=film.material.fragmentShader.replace('fragColor = vec4(col, 1.0);', 'fragColor = vec4(col, 0.3 + 0.55*smoothstep(-0.35,0.4,mvGradient(p*.8)));');
  // Reflect actual geometry and lighting. Thin film lies on the paving; no mirrored copy of scene geometry.
  scene.traverse(o=>{if(o!==film.object&&!o.layers.isEnabled(ctx.FX_LAYER??7))o.layers.enable(film.mirrorLayer);});
  const rain=createRain(ctx,{seed,lights,density:.7,gain:.7,pointGain:26,moonBoost:1,region:{floorY:0,exclude:[{min:[-8,0,-54],max:[0,5,8]}]},layers:{far:{maxCols:180},mid:{maxCols:160},near:{maxCols:60}}});scene.add(rain.object);
  const mist=createMistCards(ctx,{seed,count:3,region:{center:[14,2,-45],size:[55,3,100]},lights,density:.3});scene.add(mist.object);
  return {...E,lights,film,city,update(t,w,c){E.update(t,w,c);E.key.intensity=.24;atmos.update(t,w,c,{lights:lights.map(l=>({pos:l.position.toArray(),color:l.color.toArray(),intensity:l.intensity})),mistDensity:.25});rain.update(t,w,c);mist.update(t,w,c);beams.forEach(b=>b.update(t,w,c));film.update(t,w,c,{renderer:ctx.renderer,scene,waveGain:.035,roughness:.2,distortion:3.8,patches:0,rainEdge:1000,glitter:.15});},dispose(){rain.dispose();mist.dispose();beams.forEach(b=>b.dispose());film.dispose();atmos.dispose();E.dispose();}};
}
