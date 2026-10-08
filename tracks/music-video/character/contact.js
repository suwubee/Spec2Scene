import * as THREE from '../engine/vendor/three.module.js';
import {applyPose,limits} from './rig.js';
/** Constrained numerical IK in the existing hinge convention. Targets/offsets are explicit. */
export function solveHandContacts(rig,pose,targets,{iterations=36,tolerance=.015}={}){
  if(!Number.isInteger(iterations)||iterations<1||iterations>100||!Number.isFinite(tolerance)||tolerance<=0)throw new Error('invalid IK budget');
  pose.handContacts={};const reports=[];
  for(const [side,spec] of Object.entries(targets)){
    if(!['L','R'].includes(side))throw new Error('hand target side must be L or R');
    const target=Array.isArray(spec)?spec:spec.position,offset=spec.offset||[0,-.075,.02];
    if(!Array.isArray(target)||target.length!==3||!target.every(Number.isFinite)||offset.length!==3||!offset.every(Number.isFinite))throw new Error('finite hand target and offset required');
    const limb=rig.limbs[side+'arm'],p=pose.limbs[side+'arm'],goal=new THREE.Vector3(...target);
    const end=()=>{applyPose(rig,pose);rig.root.updateWorldMatrix(true,true);return limb.tip.localToWorld(new THREE.Vector3(...offset));};
    const parameters=[['x',limits.shoulderX],['z',limits.shoulderZ],['bend',limits.elbow]];
    // Damped coordinate descent keeps joint limits authoritative and reports residual error.
    for(let i=0;i<iterations;i++){
      if(end().distanceTo(goal)<=tolerance*.25)break;
      for(const [key,[lo,hi]] of parameters){
        const base=p[key],here=end(),e=here.distanceToSquared(goal),h=.002;
        p[key]=Math.min(hi,base+h);let delta=p[key]-base;
        if(!delta){p[key]=Math.max(lo,base-h);delta=p[key]-base;}
        const derivative=end().sub(here).multiplyScalar(1/delta);p[key]=base;
        const step=THREE.MathUtils.clamp(goal.clone().sub(here).dot(derivative)/(derivative.lengthSq()+.002),-.28,.28);
        p[key]=THREE.MathUtils.clamp(base+step,lo,hi);
        if(end().distanceToSquared(goal)>e)p[key]=base;
      }
    }
    const error=end().distanceTo(goal);
    pose.handContacts[side]={position:[...target],offset:[...offset],tolerance:spec.tolerance??tolerance};
    reports.push({side,errorMetres:error,reachable:error<=(spec.tolerance??tolerance),iterations});
  }
  applyPose(rig,pose);return reports;
}
export function inspectContacts(rig,pose){
  const errors=[],contacts=[];
  for(const [side,c] of Object.entries(pose.handContacts||{})){
    const point=rig.limbs[side+'arm'].tip.localToWorld(new THREE.Vector3(...c.offset)),error=point.distanceTo(new THREE.Vector3(...c.position));
    contacts.push({side,errorMetres:error,tolerance:c.tolerance});if(error>c.tolerance)errors.push(`${side}: hand contact error ${error.toFixed(4)} m`);
  }
  for(const support of pose.bodySupports||[]){
    const bone=rig[support.joint];if(!bone)throw new Error('unknown body support joint');
    const point=bone.localToWorld(new THREE.Vector3(...support.offset)),height=support.space==='parent'&&rig.root.parent?rig.root.parent.localToWorld(new THREE.Vector3(0,support.height,0)).y:support.height,error=Math.abs(point.y-height);
    contacts.push({joint:support.joint,errorMetres:error,tolerance:support.tolerance});if(error>support.tolerance)errors.push(`${support.joint}: body support error ${error.toFixed(4)} m`);
  }
  return {errors,contacts};
}
