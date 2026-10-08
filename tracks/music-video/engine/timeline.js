// Author: suwubee
import {validateShots,shotAt,cameraAt} from './camera/index.js';
import {fovFromFocal} from './camera.js';
/** Preserve the JSON shot-table contract; the full engine owns all rendering and lens evaluation. */
export function createTimeline(input) {
  if(input.length)validateShots(input);
  const shots=input.map(s=>({...s,t0:s.start,t1:s.end,set:s.scene,post:s.post||{exposure:Math.log2(s.exposure||1)}}));
  const converted=new Map(shots.map(s=>[s.id,s]));
  return {shots,FPS:24,DURATION:input.at(-1)?.end||60,globalFade:()=>1,
    resolve(t) {if(!input.length)return [];const {shot,previous,blend}=shotAt(input,t);
      return [...(previous?[{shot:converted.get(previous.id),tLocal:t-previous.start,weight:1-blend,gain:1,fade:1}]:[]),
        {shot:converted.get(shot.id),tLocal:t-shot.start,weight:blend,gain:1,fade:1}];}
  };
}
export function cameraFromShot(shot,t) {
  const s=cameraAt(shot,t);
  return {pos:s.position,target:s.target,fov:fovFromFocal(s.focal),focus:{distance:s.focus,fstop:s.fstop}};
}
