// Distant preview silhouette only. Uses the production joint limits and motion, without face/finger meshes.
import * as THREE from '../engine/vendor/three.module.js';
import {createSkeleton,applyPose} from '../character/rig.js';
import {poseAt} from '../character/motion.js';

export function createDistantCharacter() {
  const rig=createSkeleton(),object=new THREE.Group();object.add(rig.root);object.scale.setScalar(1.78/1.851);
  const cloth=new THREE.MeshStandardMaterial({color:0x635346,roughness:.94}),pants=new THREE.MeshStandardMaterial({color:0x273038,roughness:.9});
  const skin=new THREE.MeshStandardMaterial({color:0xc28c71,roughness:.85}),hair=new THREE.MeshStandardMaterial({color:0x211c1a,roughness:1});
  function mesh(parent,geometry,material,position=[0,0,0]) {const m=new THREE.Mesh(geometry,material);m.position.fromArray(position);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
  const torso=mesh(rig.pelvis,new THREE.CylinderGeometry(.205,.17,.57,12),cloth,[0,.29,0]);torso.scale.z=.64;
  const hem=mesh(rig.pelvis,new THREE.CylinderGeometry(.17,.275,.38,12),cloth,[0,-.17,0]);hem.scale.z=.7;
  mesh(rig.neck,new THREE.CylinderGeometry(.049,.049,.11,10),skin,[0,.025,0]);
  const head=mesh(rig.neck,new THREE.SphereGeometry(1,12,10),skin,[0,.16,0]);head.scale.set(.084,.12,.09);
  const cap=mesh(rig.neck,new THREE.SphereGeometry(1,12,8,0,Math.PI*2,0,Math.PI*.56),hair,[0,.17,-.006]);cap.scale.set(.088,.117,.09);
  for(const limb of Object.values(rig.limbs)) {
    const arm=limb.type==='arm',r=arm?.064:.079;
    mesh(limb.upper,new THREE.CylinderGeometry(r,r*.85,limb.a,10),arm?cloth:pants,[0,-limb.a/2,0]);
    mesh(limb.lower,new THREE.CylinderGeometry(r*.85,r*.55,limb.b,10),arm?cloth:pants,[0,-limb.b/2,0]);
    const tip=mesh(limb.tip,new THREE.SphereGeometry(1,10,8),arm?skin:hair,arm?[0,-.05,0]:[0,-.04,.055]);
    tip.scale.set(...(arm?[.034,.064,.024]:[.065,.045,.14]));
  }
  return {object,rig,update(action,t,options={}){const pose=poseAt(action,t,options);applyPose(rig,pose);return pose;}};
}
