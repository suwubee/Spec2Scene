import {smooth, mix, mod, clamp} from '../engine/core/math.js';
import {anatomy, twoBone, limit} from './rig.js';
export const actions = ['stand','walk','stop','turn','sit','rise','pushDoor','pushWindow','shade','embrace','bow','lookUp','windWalk'];
export function gait(distance, side, stride=.9) {
  const offset=side==='L'?0:.5, q=distance/stride+offset, n=Math.floor(q), phase=mod(q,1), stance=.62;
  const planted=(n+.31-offset)*stride;
  return {z:phase<stance?planted:mix(planted,planted+stride,smooth((phase-stance)/(1-stance))),
    y:anatomy.ankle+(phase<stance?0:.09*Math.sin(Math.PI*(phase-stance)/(1-stance))), contact:phase<stance, id:n};
}
export function poseAt(action,t,{speed=.38,distance=t*speed,yaw=0}={}) {
  if(!actions.includes(action)||!Number.isFinite(t)) throw new Error('known action and finite time required');
  const walking=['walk','windWalk','stop'].includes(action), d=action==='stop'?Math.min(distance,.75):distance;
  const pose={position:[0,0,walking?d:0],yaw,hipHeight:walking?.89:.94,headPitch:0,headYaw:0,limbs:{},contacts:{},contactIds:{},expression:'neutral',blink:mod(t,4.7)>.0&&mod(t,4.7)<.12,fingers:.22,secondary:Math.sin(t*2.4)*.025};
  const settle=action==='stop'?smooth((t-.75/Math.max(.01,speed))/.8):0;
  pose.hipHeight=mix(pose.hipHeight,.94,settle);
  const cycle=d/.9*Math.PI*2;
  if(action==='turn') pose.headYaw=smooth((t-.5)/2)*.85;
  if(action==='bow') pose.headPitch=smooth(t/2)*.65;
  if(action==='lookUp') pose.headPitch=-smooth(t/2)*.48;
  if(action==='windWalk') {pose.headPitch=.22;pose.secondary+=Math.sin(t*5)*.06;}
  let seated=0;
  if(action==='sit') seated=smooth((t-.5)/2);
  if(action==='rise') seated=1-smooth((t-.5)/2);
  pose.hipHeight-=seated*.40;
  pose.position[2]-=seated*.4;
  for(const [side,sign] of [['L',1],['R',-1]]) {
    const foot=walking?gait(d,side):{y:anatomy.ankle,z:0,contact:true,id:0};
    if(settle>0&&!foot.contact){foot.y=mix(foot.y,anatomy.ankle,settle);foot.z=mix(foot.z,d,settle);if(settle===1){foot.contact=true;foot.id='settled';}}
    const ik=twoBone(foot.y-pose.hipHeight,foot.z-pose.position[2],anatomy.upperLeg,anatomy.lowerLeg);
    pose.limbs[side+'leg']={x:ik.root,z:0,bend:ik.bend};
    pose.contacts[side+'leg']=foot.contact;pose.contactIds[side+'leg']=foot.id;
    let x=walking?Math.sin(cycle+(side==='L'?0:Math.PI))*.21*(1-settle):-.035, z=sign*.13, bend=.17;
    if(['pushDoor','pushWindow'].includes(action)) {x=-smooth(t/2)*1.4;bend=.25+(1-smooth(t/2))*.65;}
    if(action==='shade'&&side==='R'){x=-smooth(t/2)*1.75;bend=smooth(t/2)*1.45;z=-.22;}
    if(action==='embrace'){x=-smooth(t/2)*1.35;bend=.85;z=sign*.12;}
    if(seated){x=-seated*.7;bend=.4;}
    pose.limbs[side+'arm']={x:limit('shoulderX',x),z:limit('shoulderZ',z),bend:limit('elbow',bend),wrist:0};
  }
  return pose;
}
