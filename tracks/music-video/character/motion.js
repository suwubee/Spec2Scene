import * as THREE from '../engine/vendor/three.module.js';
import {smooth, mix, mod, clamp} from './math.js';
import {anatomy, twoBone, limit, createSkeleton, applyPose} from './rig.js';
export const actions = ['stand','walk','stop','turn','sit','sitKnees','hugKnees','lie','rise','pushDoor','pushWindow','shade','embrace','bow','lookUp','windWalk','lanternWalk','bagWalk','holdCup','phone'];
export const handPoses={relaxed:[.22,.32,.25],carry:[1.05,1.35,.85],open:[.025,.025,.025],touch:[.12,.16,.09],smooth:[.06,.08,.05],rest:[.22,.32,.25],fist:[1.2,1.4,1.1],point:[.3,.4,.25]};
// MCP/PIP/DIP flexion is per digit, in radians. The local palm faces +Z;
// negative X rotation carries the finger pad towards that palm, never the nail.
export function fingerAngles(gesture,index){
  if(!handPoses[gesture])throw new Error('unknown hand pose');
  const relaxed=[[.24,.28,.20],[.262,.30,.19],[.384,.38,.23],[.489,.45,.27],[.593,.53,.32]];
  if(['relaxed','rest'].includes(gesture))return relaxed[index];
  if(gesture==='touch'||gesture==='point')return index===1?[.015,.025,.02]:relaxed[index].map(a=>a*1.4);
  if(gesture==='open')return index===0?[.15,.12,.06]:[.015,.025,.02];
  if(gesture==='smooth')return index===0?[.18,.15,.08]:[.035,.045,.025];
  return (gesture==='fist'?[1.20,1.40,1.10]:[1.05,1.35,.85]).map(a=>a*(index===0?.65:1));
}
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
function basePoseAt(action,t,{speed=.38,distance=t*speed,yaw=0,wind=.5,handPose}={}) {
  if(!actions.includes(action)||![t,speed,distance,yaw,wind].every(Number.isFinite)||speed<0)throw new Error('known action and finite time required');
  const walking=['walk','windWalk','stop','lanternWalk','bagWalk'].includes(action);
  const brakeLength=Math.min(.3,speed*.8),brakeStart=.75-brakeLength/2,u=brakeLength?clamp((distance-brakeStart)/brakeLength):1;
  const d=action==='stop'?(distance<brakeStart?distance:brakeStart+brakeLength*(u-u**3+.5*u**4)):distance,cycle=d/.9*Math.PI*2;
  const settle=action==='stop'?smooth((distance-(.75+brakeLength/2))/(Math.max(.01,speed)*.8)):0;
  const pose={position:[walking?.016*Math.sin(cycle)*(1-settle):.004*Math.sin(t*.7),0,walking?d:0],yaw,hipHeight:.94,headPitch:0,headYaw:0,pelvisYaw:walking?.065*Math.cos(cycle)*(1-settle):.008*Math.sin(t*.6),chestYaw:walking?-.12*Math.cos(cycle)*(1-settle):0,breath:Math.sin(t*1.7)*.006,limbs:{},contacts:{},contactIds:{},support:{},gait:{},blink:mod(t,4.7)<.12,secondary:Math.sin(t*2.4)*.04*wind+(walking?.025*Math.sin(cycle):0),handPose:'relaxed'};
  if(action==='turn')pose.headYaw=smooth((t-.5)/2)*.85;
  if(action==='bow')pose.headPitch=smooth(t/2)*.65;
  if(action==='lookUp')pose.headPitch=-smooth(t/2)*.48;
  if(action==='windWalk'){pose.headPitch=.18;pose.secondary+=Math.sin(t*5)*.08;}
  let seated=['sit','sitKnees','hugKnees'].includes(action)?smooth((t-.5)/2):action==='rise'?1-smooth((t-.5)/2):0;
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
    if(seated){x=-seated*.28;bend=.36;}
    let twist=-sign*Math.PI*(.5+(push?.5*prepare:0));
    if(handPose==='open'){x=-.25;bend=1.2;wrist=0;twist=0;}
    if(handPose==='smooth'){x=-.6;bend=.85;wrist=0;twist=sign*Math.PI;}
    if(handPose==='touch'&&!push){x=-.45;bend=.85;twist=-sign*Math.PI*.5;}
    pose.limbs[side+'arm']={x:limit('shoulderX',x),z:limit('shoulderZ',z),bend:limit('elbow',bend),wrist,forearmTwist:twist};
  }
  if(handPose){if(!handPoses[handPose])throw new Error('unknown hand pose');pose.handPose=handPose;pose.occupiedArms=['L','R'];}
  pose.posture=seated>.99?'seated':'standing';
  if(seated>.99){pose.bodySupports=[{joint:'pelvis',offset:[0,-.1,0],height:.44,tolerance:.025,space:'parent'}];}
  if(action==='lie'){
    pose.posture='lying';pose.rootPitch=-Math.PI/2;pose.groundY=0;pose.position=[0,.22,0];pose.hipHeight=.94;pose.pelvisYaw=0;pose.chestYaw=0;pose.breath=0;
    pose.bodySupports=[{joint:'chest',offset:[0,0,-.12],height:.1,tolerance:.02,space:'parent'}];
    for(const side of ['L','R']){pose.contacts[side+'leg']=false;pose.limbs[side+'leg']={x:0,z:0,bend:.08,footPitch:0};pose.limbs[side+'arm'].z=(side==='L'?1:-1)*.22;}
  }
  if(['sit','sitKnees','hugKnees'].includes(action) && seated>0){
    pose.handPose='rest';pose.occupiedArms=['L','R'];
    if(action==='hugKnees'){
      pose.hipHeight=mix(.94,.34,seated);pose.position[2]=-seated*.17;pose.bodySupports=seated>.99?[{joint:'pelvis',offset:[0,-.1,0],height:.24,tolerance:.025,space:'parent'}]:[];
      for(const side of ['L','R']){pose.contacts[side+'leg']=false;pose.limbs[side+'leg']={x:mix(pose.limbs[side+'leg'].x,-1.85,seated),z:0,bend:mix(pose.limbs[side+'leg'].bend,2.45,seated),footPitch:0};}
    }
    if(action==='hugKnees')for(const side of ['L','R']){const l=pose.limbs[side+'leg'];pose.hipHeight=Math.max(pose.hipHeight,anatomy.ankle+.001+(anatomy.upperLeg*Math.cos(l.x)+anatomy.lowerLeg*Math.cos(l.x+l.bend))*Math.cos(l.z));}
    const leg=pose.limbs.Lleg,kneeY=-anatomy.upperLeg*Math.cos(leg.x),kneeZ=-anatomy.upperLeg*Math.sin(leg.x);
    const targetY=kneeY-.51+(action==='hugKnees'?-.03:.12),targetZ=kneeZ+(action==='hugKnees'?.025:-.055);
    const arm=twoBone(targetY,targetZ,anatomy.upperArm,anatomy.lowerArm+.075,'elbow');
    for(const [side,sign] of [['L',1],['R',-1]]){const p=pose.limbs[side+'arm'];p.x=mix(p.x,arm.root,seated);p.bend=mix(p.bend,arm.bend,seated);p.z=sign*mix(.14,-.11,seated);p.forearmTwist=-sign*Math.PI*.5;p.wrist=0;}
  }
  return pose;
}

/** Absolute-time blend. The caller owns the transition weight; no accumulated mixer state. */
export function blendPoses(from,to,weight){
  if(!Number.isFinite(weight)||weight<0||weight>1)throw new Error('blend weight must be 0..1');
  if(weight===0)return structuredClone(from);if(weight===1)return structuredClone(to);
  const blend=(a,b)=>{if(typeof a==='number'&&typeof b==='number')return mix(a,b,weight);if(Array.isArray(a)&&Array.isArray(b)&&a.length===b.length)return a.map((v,i)=>blend(v,b[i]));if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){const out={};for(const k of new Set([...Object.keys(a),...Object.keys(b)]))out[k]=blend(a[k],b[k]);return out;}return structuredClone(weight<.5?a:b);};
  const pose=blend(from,to);
  for(const k of ['yaw','pelvisYaw','chestYaw','headYaw'])pose[k]=(from[k]||0)+Math.atan2(Math.sin((to[k]||0)-(from[k]||0)),Math.cos((to[k]||0)-(from[k]||0)))*weight;
  pose.contacts={Lleg:false,Rleg:false};pose.contactIds={};pose.bodySupports=[];pose.handContacts={};pose.gait={};
  // Intermediate clips have no certified support contact; lift only if FK would penetrate the floor.
  const rig=createSkeleton();applyPose(rig,pose);let low=Infinity;
  for(const side of ['L','R'])low=Math.min(low,rig.limbs[side+'leg'].tip.getWorldPosition(new THREE.Vector3()).y);
  pose.position[1]+=Math.max(0,anatomy.ankle-low);
  pose.groundY=0;
  return pose;
}
export function poseAt(action,t,options={}){
  let pose=basePoseAt(action,t,options);
  if(options.blend){const b=options.blend;pose=blendPoses(basePoseAt(b.from,b.time??t,{...options,...b.options}),pose,b.weight);}
  for(const layer of options.additive||[]){
    if(!['lookUp','bow','turn'].includes(layer.action)||!Number.isFinite(layer.weight)||layer.weight<0||layer.weight>1)throw new Error('unsupported additive pose or weight');
    const time=layer.time??t,add=basePoseAt(layer.action,time),reference=basePoseAt('stand',time);
    for(const key of ['headPitch','headYaw','breath'])pose[key]=limit('neck',pose[key]+(add[key]-reference[key])*layer.weight);
    pose.headPitch=limit('neck',pose.headPitch-pose.breath)+pose.breath;
  }
  return pose;
}
