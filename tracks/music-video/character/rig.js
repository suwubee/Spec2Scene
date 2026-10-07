import * as THREE from '../engine/vendor/three.module.js';
import {clamp} from './math.js';
export const limits = Object.freeze({elbow:[0,2.5], knee:[0,2.6], shoulderX:[-2.5,1.2], shoulderZ:[-1.8,1.8], hip:[-1.9,1.1], neck:[-.9,.9], wrist:[-.9,.9], finger:[0,1.55], forearmTwist:[-Math.PI,Math.PI]});
export const anatomy = Object.freeze({upperLeg:.43, lowerLeg:.43, upperArm:.29, lowerArm:.265, ankle:.085, hipWidth:.105, shoulderWidth:.205});
export function limit(name, value) {
  if (!Number.isFinite(value)) throw new TypeError('finite joint angle required');
  return clamp(value,...limits[name]);
}
// +Z is forward. Knee bends toward -Z, elbow toward +Z. The sign is fixed here, never in clips.
export const hingeAxis = Object.freeze({elbow: -1, knee: 1});
export function twoBone(y, z, a, b, kind = 'knee') {
  if (!['knee','elbow'].includes(kind) || ![y,z,a,b].every(Number.isFinite) || a<=0 || b<=0) throw new TypeError('invalid IK input');
  const distance = clamp(Math.hypot(y,z), Math.abs(a-b)+1e-7, a+b-1e-7);
  const bend = limit(kind, Math.PI-Math.acos(clamp((a*a+b*b-distance*distance)/(2*a*b),-1,1)));
  const signed = hingeAxis[kind]*bend;
  const correction = Math.atan2(b*Math.sin(signed),a+b*Math.cos(signed));
  return {root:limit(kind==='knee'?'hip':'shoulderX',Math.atan2(-z,-y)-correction), bend, reachable:Math.hypot(y,z)<=a+b};
}
export function createSkeleton() {
  const root=new THREE.Group(), pelvis=new THREE.Bone(), chest=new THREE.Bone(), neck=new THREE.Bone(); root.add(pelvis);
  pelvis.position.y=.94;chest.position.y=.34;pelvis.add(chest);neck.position.y=.29;chest.add(neck);
  const limbs={};
  for(const [side,sign] of [['L',1],['R',-1]]) {
    for(const type of ['arm','leg']) {
      const upper=new THREE.Bone(), lower=new THREE.Bone(), tip=new THREE.Bone();
      const isArm=type==='arm', a=isArm?anatomy.upperArm:anatomy.upperLeg, b=isArm?anatomy.lowerArm:anatomy.lowerLeg;
      upper.position.set(sign*(isArm?anatomy.shoulderWidth:anatomy.hipWidth),isArm?.17:0,0);
      lower.position.y=-a;(isArm?chest:pelvis).add(upper);upper.add(lower);
      const twists=[];
      if(isArm){let parent=lower;for(let i=0;i<3;i++){const bone=new THREE.Bone();bone.position.y=-b/3;parent.add(bone);twists.push(bone);parent=bone;}parent.add(tip);}
      else{tip.position.y=-b;lower.add(tip);}
      upper.rotation.order='ZXY';if(isArm)upper.rotation.z=sign*.30;
      limbs[side+type]={upper,lower,tip,twists,a,b,side,sign,type};
    }
  }
  pelvis.name='hips';chest.name='chest';neck.name='neck';
  for(const [key,l] of Object.entries(limbs))for(const part of ['upper','lower','tip'])l[part].name=`${key}-${part}`;
  return {root,pelvis,chest,neck,limbs};
}
export function applyPose(rig, pose) {
  rig.root.position.fromArray(pose.position); rig.root.rotation.set(0,pose.yaw,0); rig.pelvis.position.y=pose.hipHeight;
  rig.pelvis.rotation.set(0,pose.pelvisYaw||0,0);rig.chest.rotation.set(pose.breath||0,pose.chestYaw||0,0); rig.neck.rotation.set(limit('neck',pose.headPitch-(pose.breath||0)),limit('neck',pose.headYaw-(pose.pelvisYaw||0)-(pose.chestYaw||0)),0);
  for(const [key,limb] of Object.entries(rig.limbs)) {
    const p=pose.limbs[key], arm=limb.type==='arm';
    limb.upper.rotation.set(limit(arm?'shoulderX':'hip',p.x),0,arm?limit('shoulderZ',p.z):(p.z||0));
    limb.lower.rotation.set(hingeAxis[arm?'elbow':'knee']*limit(arm?'elbow':'knee',p.bend),0,0);
    for(const twist of limb.twists)twist.rotation.y=limit('forearmTwist',p.forearmTwist||0)/3;
    limb.tip.rotation.set(arm?limit('wrist',p.wrist||0):-(limb.upper.rotation.x+limb.lower.rotation.x)+(p.footPitch||0),0,0);
  }
  rig.root.updateMatrixWorld(true);
  const rootRotation=rig.root.getWorldQuaternion(new THREE.Quaternion());
  for(const limb of Object.values(rig.limbs))if(limb.type==='leg'){const desired=rootRotation.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),pose.limbs[limb.side+'leg'].footPitch||0));limb.tip.quaternion.copy(limb.lower.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(desired));limb.tip.updateMatrixWorld(true);}
}
export function inspectRig(rig, pose, previous = null) {
  const errors=[], points={},supportPoints={},scale=rig.root.getWorldScale(new THREE.Vector3()).x,ground=rig.root.getWorldPosition(new THREE.Vector3()).y;
  for(const value of [rig.neck.rotation.x,rig.neck.rotation.y])if(value<limits.neck[0]||value>limits.neck[1])errors.push('neck: joint range');
  for(const [key,l] of Object.entries(rig.limbs)) {
    const a=l.upper.getWorldPosition(new THREE.Vector3()), b=l.lower.getWorldPosition(new THREE.Vector3()), c=l.tip.getWorldPosition(new THREE.Vector3());
    points[key]=c.toArray();
    if(![...a.toArray(),...b.toArray(),...c.toArray(),l.upper.rotation.x,l.lower.rotation.x,l.tip.rotation.x].every(Number.isFinite))errors.push(`${key}: nonfinite transform`);
    if(Math.abs(a.distanceTo(b)-l.a*scale)>1e-6 || Math.abs(b.distanceTo(c)-l.b*scale)>1e-6) errors.push(`${key}: bone length`);
    const arm=l.type==='arm';
    if(arm&&(l.upper.rotation.z<limits.shoulderZ[0]||l.upper.rotation.z>limits.shoulderZ[1]))errors.push(`${key}: shoulder range`);
    const hinge=l.lower.rotation.x*hingeAxis[arm?'elbow':'knee'], range=limits[arm?'elbow':'knee'];
    if(hinge<range[0]-1e-8 || hinge>range[1]+1e-8) errors.push(`${key}: reversed hinge`);
    if(arm&&(l.twists.reduce((s,b)=>s+b.rotation.y,0)<limits.forearmTwist[0]-1e-8||l.twists.reduce((s,b)=>s+b.rotation.y,0)>limits.forearmTwist[1]+1e-8))errors.push(`${key}: forearm twist range`);
    const local=rig.pelvis.worldToLocal(c.clone());
    if(arm && local.y>0 && local.y<.53 && (local.x/.19)**2+(local.z/.14)**2<1) errors.push(`${key}: hand intersects torso`);
    if(!arm) {
      if(c.y<ground+anatomy.ankle*scale-1e-6) errors.push(`${key}: foot below ground`);
      const contact=new THREE.Vector3(...(pose.support?.[key]||[0,-anatomy.ankle,0])).applyMatrix4(l.tip.matrixWorld);supportPoints[key]=contact.toArray();
      if(pose.contacts[key]&&Math.abs(contact.y-ground)>1e-6)errors.push(`${key}: sole off ground`);
      if(previous && pose.contacts[key] && previous.contacts[key] && pose.contactIds[key]===previous.contactIds[key] && new THREE.Vector3(...previous.supportPoints[key]).distanceTo(contact)>1e-5) errors.push(`${key}: stance foot slides`);
    }
    for(const [value,range] of [[l.upper.rotation.x,limits[arm?'shoulderX':'hip']],[l.tip.rotation.x,arm?limits.wrist:[-4,4]]]) if(value<range[0]-1e-8 || value>range[1]+1e-8) errors.push(`${key}: joint range`);
  }
  for(const side of ['L','R']){const g=pose.gait?.[side];if(g&&g.settle===0&&Number.isFinite(g.phase)){if(g.phase>.14&&g.phase<.46&&rig.limbs[side+'leg'].lower.rotation.x>.48)errors.push(`${side}: stance knee remains crouched`);if(Math.abs(g.reach)>.035&&rig.limbs[side+'arm'].upper.rotation.x*g.reach<-.002)errors.push(`${side}: arm swing phase reversed`);}}
  for(const finger of rig.fingers||[])for(const joint of finger.joints){const bend=-joint.rotation.x;if(bend<limits.finger[0]-1e-8||bend>limits.finger[1]+1e-8)errors.push('finger: reversed or excessive flexion');}
  return {errors,points,supportPoints,contacts:pose.contacts,contactIds:pose.contactIds};
}
