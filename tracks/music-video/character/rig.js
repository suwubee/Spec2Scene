import * as THREE from '../engine/vendor/three.module.js';
import {clamp} from '../engine/core/math.js';
export const limits = Object.freeze({elbow:[0,2.5], knee:[0,2.6], shoulderX:[-2.5,1.2], shoulderZ:[-1.8,1.8], hip:[-1.9,1.1], neck:[-.9,.9], wrist:[-.65,.65]});
export const anatomy = Object.freeze({upperLeg:.43, lowerLeg:.43, upperArm:.29, lowerArm:.265, ankle:.085, hipWidth:.14, shoulderWidth:.235});
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
  const root=new THREE.Group(), pelvis=new THREE.Group(), neck=new THREE.Group(); root.add(pelvis);
  neck.position.y=.63; pelvis.add(neck);
  const limbs={};
  for(const [side,sign] of [['L',1],['R',-1]]) {
    for(const type of ['arm','leg']) {
      const upper=new THREE.Group(), lower=new THREE.Group(), tip=new THREE.Group();
      const isArm=type==='arm', a=isArm?anatomy.upperArm:anatomy.upperLeg, b=isArm?anatomy.lowerArm:anatomy.lowerLeg;
      upper.position.set(sign*(isArm?anatomy.shoulderWidth:anatomy.hipWidth),isArm?.51:0,0);
      lower.position.y=-a; tip.position.y=-b; pelvis.add(upper); upper.add(lower); lower.add(tip);
      limbs[side+type]={upper,lower,tip,a,b,side,sign,type};
    }
  }
  return {root,pelvis,neck,limbs};
}
export function applyPose(rig, pose) {
  rig.root.position.fromArray(pose.position); rig.root.rotation.set(0,pose.yaw,0); rig.pelvis.position.y=pose.hipHeight;
  rig.pelvis.rotation.set(0,0,0); rig.neck.rotation.set(limit('neck',pose.headPitch),limit('neck',pose.headYaw),0);
  for(const [key,limb] of Object.entries(rig.limbs)) {
    const p=pose.limbs[key], arm=limb.type==='arm';
    limb.upper.rotation.set(limit(arm?'shoulderX':'hip',p.x),0,arm?limit('shoulderZ',p.z):0);
    limb.lower.rotation.set(hingeAxis[arm?'elbow':'knee']*limit(arm?'elbow':'knee',p.bend),0,0);
    limb.tip.rotation.set(arm?limit('wrist',p.wrist||0):-(limb.upper.rotation.x+limb.lower.rotation.x),0,0);
  }
  rig.root.updateMatrixWorld(true);
}
export function inspectRig(rig, pose, previous = null) {
  const errors=[], points={},scale=rig.root.getWorldScale(new THREE.Vector3()).x,ground=rig.root.getWorldPosition(new THREE.Vector3()).y;
  for(const value of [rig.neck.rotation.x,rig.neck.rotation.y])if(value<limits.neck[0]||value>limits.neck[1])errors.push('neck: joint range');
  for(const [key,l] of Object.entries(rig.limbs)) {
    const a=l.upper.getWorldPosition(new THREE.Vector3()), b=l.lower.getWorldPosition(new THREE.Vector3()), c=l.tip.getWorldPosition(new THREE.Vector3());
    points[key]=c.toArray();
    if(Math.abs(a.distanceTo(b)-l.a*scale)>1e-6 || Math.abs(b.distanceTo(c)-l.b*scale)>1e-6) errors.push(`${key}: bone length`);
    const arm=l.type==='arm';
    if(arm&&(l.upper.rotation.z<limits.shoulderZ[0]||l.upper.rotation.z>limits.shoulderZ[1]))errors.push(`${key}: shoulder range`);
    const hinge=l.lower.rotation.x*hingeAxis[arm?'elbow':'knee'], range=limits[arm?'elbow':'knee'];
    if(hinge<range[0]-1e-8 || hinge>range[1]+1e-8) errors.push(`${key}: reversed hinge`);
    const local=rig.pelvis.worldToLocal(c.clone());
    if(arm && local.y>0 && local.y<.53 && (local.x/.19)**2+(local.z/.14)**2<1) errors.push(`${key}: hand intersects torso`);
    if(!arm) {
      if(c.y<ground+anatomy.ankle*scale-1e-6) errors.push(`${key}: foot below ground`);
      if(previous && pose.contacts[key] && previous.contacts[key] && pose.contactIds[key]===previous.contactIds[key] && new THREE.Vector3(...previous.points[key]).distanceTo(c)>1e-5) errors.push(`${key}: stance foot slides`);
    }
    for(const [value,range] of [[l.upper.rotation.x,limits[arm?'shoulderX':'hip']],[l.tip.rotation.x,arm?limits.wrist:[-4,4]]]) if(value<range[0]-1e-8 || value>range[1]+1e-8) errors.push(`${key}: joint range`);
  }
  return {errors,points,contacts:pose.contacts,contactIds:pose.contactIds};
}
