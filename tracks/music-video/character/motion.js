import * as THREE from '../engine/vendor/three.module.js';
import {smooth, mix, mod, clamp} from './math.js';
import {anatomy, twoBone, limit} from './rig.js';
export const actions = ['stand','walk','stop','turn','sit','rise','pushDoor','pushWindow','shade','embrace','bow','lookUp','windWalk'];
export const handPoses={relaxed:[.22,.32,.25],carry:[1.05,1.35,.85],open:[.025,.025,.025],touch:[.12,.16,.09],smooth:[.06,.08,.05],rest:[.22,.32,.25],fist:[1.2,1.4,1.1],point:[.3,.4,.25]};
export function gait(distance, side, stride=.9) {
  if(!Number.isFinite(distance)||!Number.isFinite(stride)||stride<=0||!['L','R'].includes(side))throw new TypeError('finite distance, positive stride and L/R side required');
  const offset=side==='L'?0:.5,q=distance/stride+offset,n=Math.floor(q),phase=mod(q,1),stance=.62,planted=(n+.31-offset)*stride;
  const swing=(phase-stance)/(1-stance);
  // Fixed ankle during contact; the sole rocks from heel to toe around that anchor.
  const footPitch=phase<.10?mix(-.18,0,smooth(phase/.10)):phase>.48&&phase<stance?smooth((phase-.48)/.14)*.22:phase>=stance?mix(.22,-.18,smooth(swing)):0;
  const pivot=footPitch<0?-.106:.194,roll=footPitch!==0;
  const dz=roll?pivot*(1-Math.cos(footPitch))+anatomy.ankle*Math.sin(footPitch):0,dy=roll?anatomy.ankle*(Math.cos(footPitch)-1)+pivot*Math.sin(footPitch):0;
  return {z:(phase<stance?planted:mix(planted,planted+stride,smooth(swing)))+dz,y:anatomy.ankle+dy+(phase<stance?0:.115*Math.sin(Math.PI*swing)),contact:phase<stance,id:n+':'+(roll?(footPitch<0?'heel':'toe'):'flat'),phase,footPitch,support:[0,-anatomy.ankle,roll?pivot:0]};
}
export function poseAt(action,t,{speed=.38,distance=t*speed,yaw=0,wind=.5}={}) {
  if(!actions.includes(action)||![t,speed,distance,yaw,wind].every(Number.isFinite)||speed<0)throw new Error('known action and finite time required');
  const walking=['walk','windWalk','stop'].includes(action);
  const brakeLength=Math.min(.3,speed*.8),brakeStart=.75-brakeLength/2,u=brakeLength?clamp((distance-brakeStart)/brakeLength):1;
  const d=action==='stop'?(distance<brakeStart?distance:brakeStart+brakeLength*(u-u**3+.5*u**4)):distance,cycle=d/.9*Math.PI*2;
  const settle=action==='stop'?smooth((distance-(.75+brakeLength/2))/(Math.max(.01,speed)*.8)):0;
  const pose={position:[walking?.016*Math.sin(cycle)*(1-settle):.004*Math.sin(t*.7),0,walking?d:0],yaw,hipHeight:.94,headPitch:0,headYaw:0,pelvisYaw:walking?.065*Math.cos(cycle)*(1-settle):.008*Math.sin(t*.6),chestYaw:walking?-.12*Math.cos(cycle)*(1-settle):0,breath:Math.sin(t*1.7)*.006,limbs:{},contacts:{},contactIds:{},support:{},gait:{},blink:mod(t,4.7)<.12,secondary:Math.sin(t*2.4)*.04*wind+(walking?.025*Math.sin(cycle):0),handPose:'relaxed'};
  if(action==='turn')pose.headYaw=smooth((t-.5)/2)*.85;
  if(action==='bow')pose.headPitch=smooth(t/2)*.65;
  if(action==='lookUp')pose.headPitch=-smooth(t/2)*.48;
  if(action==='windWalk'){pose.headPitch=.18;pose.secondary+=Math.sin(t*5)*.08;}
  let seated=action==='sit'?smooth((t-.5)/2):action==='rise'?1-smooth((t-.5)/2):0;
  const push=['pushDoor','pushWindow'].includes(action),prepare=smooth(t/.85),extend=smooth((t-.85)/1.25);
  if(push){pose.position[2]=prepare*.07+extend*.09;pose.chestYaw=-.035*prepare;pose.breath+=prepare*.04;pose.handPose='touch';}
  pose.position[2]-=seated*.4;
  const feet={};
  for(const [side,sign] of [['L',1],['R',-1]]){
    const foot=walking?gait(d,side):{y:anatomy.ankle,z:0,contact:true,id:0,footPitch:0};
    if(settle>0&&!foot.contact){foot.y=mix(foot.y,anatomy.ankle,settle);foot.z=mix(foot.z,d,settle);if(settle===1){foot.contact=true;foot.id='settled';}}
    if(settle>0){foot.support=[0,-anatomy.ankle,0];if(foot.contact){foot.y=anatomy.ankle;foot.footPitch=0;foot.id='stop-'+side;}}
    feet[side]=foot;
  }
  if(walking){pose.hipHeight=Math.min(...Object.entries(feet).filter(([,f])=>f.contact).map(([side,f])=>{
    const sign=side==='L'?1:-1,hz=-sign*anatomy.hipWidth*Math.sin(pose.pelvisYaw),dx=pose.position[0]+sign*anatomy.hipWidth*Math.cos(pose.pelvisYaw)-sign*anatomy.hipWidth,dz=f.z-d-hz;
    return f.y+Math.sqrt(.86**2-dx*dx-dz*dz)-.004;
  }));pose.hipHeight=mix(pose.hipHeight,.94,settle);}
  pose.hipHeight-=seated*.40;
  if(push)pose.hipHeight-=.02*prepare;
  for(const [side,sign] of [['L',1],['R',-1]]){
    const foot=feet[side],target=new THREE.Vector3(sign*anatomy.hipWidth-pose.position[0],foot.y-pose.hipHeight,foot.z-pose.position[2]).applyAxisAngle(new THREE.Vector3(0,1,0),-pose.pelvisYaw);
    target.x-=sign*anatomy.hipWidth;
    const ik=twoBone(-Math.hypot(target.x,target.y),target.z,anatomy.upperLeg,anatomy.lowerLeg);
    pose.limbs[side+'leg']={x:ik.root,z:Math.atan2(target.x,-target.y),bend:ik.bend,footPitch:foot.footPitch*(1-settle)};
    pose.contacts[side+'leg']=foot.contact;pose.contactIds[side+'leg']=foot.id;pose.support[side+'leg']=foot.support||[0,-anatomy.ankle,0];pose.gait[side]={phase:foot.phase,reach:foot.z-d,settle};
    // Same-side arm goes back when the thigh goes forward; the opposite arm goes forward.
    let x=walking?(foot.z-d)*1.15*(1-settle):-.035,z=sign*.14,bend=.19+(walking?.10*Math.max(0,Math.sin(cycle+(sign===1?0:Math.PI))):0),wrist=0;
    if(push){x=-.48*prepare-.83*extend;bend=.18+.98*prepare-.66*extend;wrist=.90*extend;}
    if(action==='shade'&&side==='R'){x=-smooth(t/2)*1.75;bend=smooth(t/2)*1.45;z=-.22;}
    if(action==='embrace'){x=-smooth(t/2)*1.35;bend=.85;z=sign*.12;}
    if(seated){x=-seated*.7;bend=.4;}
    pose.limbs[side+'arm']={x:limit('shoulderX',x),z:limit('shoulderZ',z),bend:limit('elbow',bend),wrist,forearmTwist:-sign*Math.PI*(.5+(push?.5*prepare:0))};
  }
  return pose;
}
