// Author: suwubee
import {buildEaves} from './eaves.js';
import {createLantern} from './lantern.js';
import {environment,box} from './common.js';
export function createArchitecture(ctx,{length=6,bays=4}={}) {
  const E=environment(ctx,{fog:.004,fill:.08}),M=E.materials,wood=M.wood({seed:32}),stone=M.bluestone({seed:31});
  const roof=buildEaves(ctx,M,{z0:-length/2,z1:length/2,liftStart:length*.33,detailZ:[-length/2,length/2]});E.scene.add(roof.object,box([5,.22,length+1],stone,[0,-.11,0]));
  for(let i=0;i<=bays;i++){const z=-length/2+i*length/bays;for(const x of [-1.8,1.8])E.scene.add(box([.16,2.8,.16],wood,[x,1.4,z]));}
  for(const x of [-1.8,1.8])for(const y of [.35,.85])E.scene.add(box([.1,.09,length],wood,[x,y,0]));
  for(let z=-length/2;z<=length/2;z+=.3)for(const x of [-1.8,1.8])E.scene.add(box([.06,.58,.06],wood,[x,.55,z]));
  const lamp=createLantern(ctx,{materials:M,center:[1.5,2.2,0],pivot:[1.5,2.65,0]});E.scene.add(lamp.object,lamp.light);
  return {...E,roof,lamp,update(t,w,c){E.update(t,w,c);lamp.update(t,{glow:1,flicker:1,swayX:.015*Math.sin(t),swayZ:.02*Math.sin(t*.7),camera:c,env:{ambient:[.006,.009,.015],moonDir:w.moonDir,moonCol:[.1,.14,.22]}});},dispose(){roof.dispose?.();lamp.dispose();E.dispose();}};
}
