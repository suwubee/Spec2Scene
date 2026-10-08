// Author: suwubee
import * as THREE from '../engine/vendor/three.module.js';
import {createLatticeWindow} from './latticeWindow.js';
import {createGauze} from './gauze.js';
import {createOilLamp} from './oilLamp.js';
import {createLightShaft,createDust} from '../engine/particles.js';
import {environment,box} from './common.js';
/** Open room shell in local coordinates. Window wall is x=0; dimensions and practicals belong to the caller. */
export function createInterior(ctx,{width=5,depth=6,height=3,windowHeight=1.6,windowY=1.6,windowWidth=1.5,lightPosition=[1,.75,1]}={}) {
  const E=environment(ctx,{fog:.008,fill:.16}),{scene,materials:M}=E;
  const wall=M.plaster({seed:11}),wood=M.wood({seed:12}),winTop=windowY+windowHeight/2,winBottom=windowY-windowHeight/2;
  for(const [size,p] of [[[width,.16,depth],[width/2,-.08,0]],[[width,.12,depth],[width/2,height,0]],[[width,height,.18],[width/2,height/2,-depth/2]],[[.2,winBottom,depth],[0,winBottom/2,0]],[[.2,height-winTop,depth],[0,(height+winTop)/2,0]],[[.2,windowHeight,(depth-windowWidth)/2],[0,windowY,-(depth+windowWidth)/4]],[[.2,windowHeight,(depth-windowWidth)/2],[0,windowY,(depth+windowWidth)/4]]])scene.add(box(size,size[1]<.2?wood:wall,p));
  const window=createLatticeWindow(ctx,M,{center:[0,windowY,0],width:windowWidth,height:windowHeight,blind:{x:.12,topY:winTop,width:windowWidth,length:windowHeight,seed:4}}),curtain=createGauze(ctx,M,{x:.23,topY:winTop+.1,length:windowHeight+.1,panels:[[-windowWidth*.55,-.25],[.35,windowWidth*.55]]});
  const lamp=createOilLamp(ctx,M,{position:lightPosition,parameter:'tableLamp',lightGain:3});scene.add(window.object,curtain.object,lamp.object,lamp.lightObject);
  scene.add(box([1.5,.09,.7],wood,[lightPosition[0],lightPosition[1]-.05,lightPosition[2]]));
  const shaft=createLightShaft(ctx,{origin:[-.02,windowY,0],dir:[1,-.28,.15],across:[0,0,1],up:[0,1,0],width:windowWidth,height:windowHeight,length:5,lattice:[5,6],density:.02,color:[.62,.78,1],intensity:.08,noise:.6});scene.add(shaft.object);
  const dust=createDust(ctx,{shaft,maxCount:300,density:4,gain:.03});scene.add(dust.object);
  return {...E,window,curtain,lamp,update(t,w,c){E.update(t,w,c);window.update(t,w,{roll:.28});curtain.update(t,w);lamp.update(t,w,c);shaft.update(t,w,c);dust.update(t,w,c);},dispose(){window.dispose();curtain.dispose();lamp.dispose();shaft.dispose();dust.dispose();E.dispose();}};
}
