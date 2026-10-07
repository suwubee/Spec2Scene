import * as THREE from '../engine/vendor/three.module.js';
import {createSkeleton,applyPose,inspectRig,anatomy,limits} from './rig.js';
import {poseAt,handPoses} from './motion.js';
import {clamp} from './math.js';

// Loader ownership stays with the project. Use the same THREE instance/version as
// the character, with GLTFLoader and optionally VRMLoaderPlugin registered there.
export async function loadExternalCharacter({url,loader,mapping,...options}={}){
  if(!loader?.loadAsync||!url)throw new TypeError('url and a project-owned glTF/VRM loader are required');
  const gltf=await loader.loadAsync(url);
  return adaptExternalCharacter({scene:gltf.scene,vrm:gltf.userData?.vrm,mapping,...options});
}
const names={hips:'pelvis',chest:'chest',neck:'neck',leftUpperArm:'Larm.upper',leftLowerArm:'Larm.lower',leftHand:'Larm.tip',rightUpperArm:'Rarm.upper',rightLowerArm:'Rarm.lower',rightHand:'Rarm.tip',leftUpperLeg:'Lleg.upper',leftLowerLeg:'Lleg.lower',leftFoot:'Lleg.tip',rightUpperLeg:'Rleg.upper',rightLowerLeg:'Rleg.lower',rightFoot:'Rleg.tip'};
const sides=['left','right'],digits=['Thumb','Index','Middle','Ring','Little'];
const vec=()=>new THREE.Vector3(),quat=()=>new THREE.Quaternion();
const position=node=>node.getWorldPosition(vec());
const rotation=node=>node.getWorldQuaternion(quat());
const isDescendant=(node,parent)=>{for(let p=node?.parent;p;p=p.parent)if(p===parent)return true;return false;};
function worldRotation(node,q){node.quaternion.copy(node.parent?rotation(node.parent).invert().multiply(q):q);node.updateMatrixWorld(true);}
function worldPosition(node,p){node.position.copy(node.parent?node.parent.worldToLocal(p.clone()):p);node.updateMatrixWorld(true);}
function aim(node,rest,direction){worldRotation(node,quat().setFromUnitVectors(rest.direction,direction.normalize()).multiply(rest.rotation));}

export function adaptExternalCharacter({scene,vrm,mapping={},license,footHeight=.085}={}){
  if(!scene?.isObject3D)throw new TypeError('loaded scene is required');
  if(typeof license!=='string'||!license.trim())throw new Error('record the user-provided asset license before adaptation');
  if(!Number.isFinite(footHeight)||footHeight<=0||footHeight>.3)throw new Error('footHeight must be in normalized metres');
  scene.updateMatrixWorld(true);
  const objects=new Set();scene.traverse(o=>objects.add(o));
  let meshes=0;scene.traverse(o=>{if(!o.matrixWorld.elements.every(Number.isFinite))throw new Error('finite asset transforms required');if(o.isSkinnedMesh){meshes++;if(!o.geometry.attributes.skinIndex||!o.geometry.attributes.skinWeight)throw new Error('bound skin attributes required');}const s=o.scale;if(Math.min(s.x,s.y,s.z)<=0||Math.max(s.x,s.y,s.z)-Math.min(s.x,s.y,s.z)>1e-5)throw new Error('positive uniform model/bone scales required');});
  if(!meshes)throw new Error('asset must contain a bound SkinnedMesh');
  const lookup=name=>{
    const item=mapping[name]??vrm?.humanoid?.getRawBoneNode(name);
    if(typeof item==='string'){
      const matches=[...objects].filter(o=>o.name===item);if(matches.length!==1)throw new Error(`ambiguous or missing bone: ${name}`);return matches[0];
    }
    return item;
  };
  const bound=new Set();scene.traverse(o=>{if(o.isSkinnedMesh)for(const bone of o.skeleton.bones)bound.add(bone);});
  const mapped={};
  for(const name of Object.keys(names)){
    const bone=lookup(name);if(!bone?.isObject3D||!objects.has(bone))throw new Error(`missing humanoid mapping: ${name}`);if(!bound.has(bone))throw new Error(`mapped node is not in a bound skeleton: ${name}`);mapped[name]=bone;
  }
  if(new Set(Object.values(mapped)).size!==Object.keys(mapped).length)throw new Error('humanoid mappings must be distinct');
  for(const side of sides)for(const type of ['Arm','Leg']){
    const upper=mapped[`${side}Upper${type}`],lower=mapped[`${side}Lower${type}`],tip=mapped[`${side}${type==='Arm'?'Hand':'Foot'}`];
    if(!isDescendant(upper,type==='Arm'?mapped.chest:mapped.hips)||!isDescendant(lower,upper)||!isDescendant(tip,lower))throw new Error(`invalid ${side} ${type} hierarchy`);
  }
  if(!isDescendant(mapped.chest,mapped.hips)||!isDescendant(mapped.neck,mapped.chest))throw new Error('invalid torso hierarchy');
  const control=createSkeleton(),canonical={};
  for(const [name,path] of Object.entries(names)){const [limb,part]=path.split('.');canonical[name]=part?control.limbs[limb][part]:control[path];}
  control.root.updateMatrixWorld(true);
  const rest={};
  const childOf={hips:'chest',chest:'neck',neck:null};
  for(const side of sides)for(const type of ['Arm','Leg']){
    childOf[`${side}Upper${type}`]=`${side}Lower${type}`;childOf[`${side}Lower${type}`]=`${side}${type==='Arm'?'Hand':'Foot'}`;
  }
  for(const [name,node] of Object.entries(mapped)){
    const child=childOf[name],direction=child?position(mapped[child]).sub(position(node)).normalize():new THREE.Vector3(0,1,0);
    rest[name]={rotation:rotation(node),direction,control:rotation(canonical[name]),position:position(node)};
  }
  const lengths={};for(const side of sides)for(const type of ['Arm','Leg']){
    const a=position(mapped[`${side}Upper${type}`]).distanceTo(position(mapped[`${side}Lower${type}`]));
    const b=position(mapped[`${side}Lower${type}`]).distanceTo(position(mapped[`${side}${type==='Arm'?'Hand':'Foot'}`]));
    if(Math.min(a,b)<1e-5)throw new Error('zero-length limb');lengths[side+type]=[a,b];
  }
  const unit=(lengths.leftLeg[0]+lengths.leftLeg[1]+lengths.rightLeg[0]+lengths.rightLeg[1])/(4*anatomy.upperLeg);
  const fingers=[],missingFingers=[];
  for(const side of sides)for(const digit of digits){
    const segments=digit==='Thumb'?['Metacarpal','Proximal','Distal']:['Proximal','Intermediate','Distal'];
    const joints=segments.map(segment=>lookup(`${side}${digit}${segment}`));
    if(joints.every(x=>x&&objects.has(x))){
      if(!isDescendant(joints[0],mapped[side+'Hand'])||!isDescendant(joints[1],joints[0])||!isDescendant(joints[2],joints[1]))throw new Error('invalid finger hierarchy');
      fingers.push({side,digit,joints,rest:joints.map(j=>j.quaternion.clone()),axes:joints.map(j=>new THREE.Vector3(1,0,0).applyQuaternion(rotation(j).invert()))});
    }else missingFingers.push(`${side}${digit}`);
  }
  const object=new THREE.Group();object.name='user-character';object.add(scene);
  const origin=rest.hips.position.clone().sub(new THREE.Vector3(0,.94*unit,0));
  const expected=new Map();let lastPose;
  const api={object,rig:control,mapped,license,unit,capabilities:{fingers:missingFingers.length?'PARTIAL':'PASS',missingFingers},
    update(action,t,options={}){
      const pose=poseAt(action,t,options);applyPose(control,pose);lastPose=pose;object.updateMatrixWorld(true);
      // Bind axes may differ (including a T-pose). Aim each measured segment along
      // the canonical pose, using its own rest basis instead of copying Euler angles.
      const base=object.matrixWorld;
      const targetPoint=node=>position(node).multiplyScalar(unit).add(origin).applyMatrix4(base);
      const baseQ=rotation(object);
      worldPosition(mapped.hips,targetPoint(control.pelvis));
      for(const name of ['hips','chest','neck'])worldRotation(mapped[name],baseQ.clone().multiply(rotation(canonical[name])).multiply(rest[name].control.clone().invert()).multiply(rest[name].rotation));
      for(const side of sides){
        for(const part of ['UpperArm','LowerArm']){
          const name=side+part,child=childOf[name],d=position(canonical[child]).sub(position(canonical[name])).applyQuaternion(baseQ);aim(mapped[name],rest[name],d);
        }
        const hand=side+'Hand';worldRotation(mapped[hand],baseQ.clone().multiply(rotation(canonical[hand])).multiply(rest[hand].control.clone().invert()).multiply(rest[hand].rotation));
        const upper=side+'UpperLeg',lower=side+'LowerLeg',foot=side+'Foot',hip=position(mapped[upper]),target=targetPoint(canonical[foot]);
        const [a,b]=lengths[side+'Leg'].map(x=>x*object.scale.x),delta=target.clone().sub(hip),distance=clamp(delta.length(),Math.abs(a-b)+1e-7,a+b-1e-7),direction=delta.normalize();
        const along=(a*a+distance*distance-b*b)/(2*distance),pole=new THREE.Vector3(0,0,1).applyAxisAngle(new THREE.Vector3(0,1,0),pose.yaw).applyQuaternion(baseQ);
        pole.addScaledVector(direction,-pole.dot(direction)).normalize();
        const knee=hip.clone().addScaledVector(direction,along).addScaledVector(pole,Math.sqrt(Math.max(0,a*a-along*along)));
        aim(mapped[upper],rest[upper],knee.clone().sub(hip));aim(mapped[lower],rest[lower],target.clone().sub(position(mapped[lower])));
        worldRotation(mapped[foot],baseQ.clone().multiply(rotation(canonical[foot])).multiply(rest[foot].control.clone().invert()).multiply(rest[foot].rotation));
      }
      const angles=handPoses[options.handPose||pose.handPose];if(!angles)throw new Error('unknown hand pose');
      for(const f of fingers)f.joints.forEach((j,i)=>j.quaternion.copy(f.rest[i]).multiply(quat().setFromAxisAngle(f.axes[i],-clamp(angles[i]*(f.digit==='Thumb'?.65:1),...limits.finger))));
      object.updateMatrixWorld(true);scene.traverse(o=>{if(o.isSkinnedMesh)o.skeleton.update();});
      expected.clear();for(const node of [...Object.values(mapped),...fingers.flatMap(f=>f.joints)])expected.set(node,rotation(node));
      return pose;
    },
    inspect(previous=null){
      if(!lastPose)throw new Error('update the asset before inspection');
      object.updateMatrixWorld(true);const pose=lastPose,errors=[...inspectRig(control,pose).errors],points={},supportPoints={};
      for(const [node,q] of expected){if(!node.matrixWorld.elements.every(Number.isFinite))errors.push(`${node.name||'mapped joint'}: nonfinite transform`);if(rotation(node).angleTo(q)>1e-4)errors.push(`${node.name||'mapped joint'}: mapped joint deviates from limited pose`);}
      const scale=unit*object.scale.x,baseQ=rotation(object),up=new THREE.Vector3(0,1,0).applyQuaternion(baseQ),floor=origin.clone().applyMatrix4(object.matrixWorld);
      for(const [side,short] of [['left','L'],['right','R']])for(const type of ['Arm','Leg']){
        const key=short+type.toLowerCase(),a=position(mapped[`${side}Upper${type}`]),b=position(mapped[`${side}Lower${type}`]),c=position(mapped[`${side}${type==='Arm'?'Hand':'Foot'}`]);points[key]=c.toArray();
        const known=lengths[side+type];if(Math.abs(a.distanceTo(b)-known[0]*object.scale.x)>1e-5||Math.abs(b.distanceTo(c)-known[1]*object.scale.x)>1e-5)errors.push(`${key}: bone length`);
        const bend=Math.PI-a.clone().sub(b).angleTo(c.clone().sub(b));if(!Number.isFinite(bend)||bend>limits[type==='Arm'?'elbow':'knee'][1]+1e-5)errors.push(`${key}: joint range`);
        if(type==='Leg'){
          const contact=new THREE.Vector3(...pose.support[key]);contact.y=-footHeight;contact.multiplyScalar(scale).applyAxisAngle(new THREE.Vector3(1,0,0),pose.limbs[key].footPitch||0).applyAxisAngle(new THREE.Vector3(0,1,0),pose.yaw).applyQuaternion(baseQ).add(c);supportPoints[key]=contact.toArray();
          const groundDistance=contact.clone().sub(floor).dot(up);if(groundDistance<-.003*scale||(pose.contacts[key]&&Math.abs(groundDistance)>.004*scale))errors.push(`${key}: sole ground contact`);
          if(previous&&pose.contacts[key]&&previous.contacts[key]&&pose.contactIds[key]===previous.contactIds[key]&&contact.distanceTo(new THREE.Vector3(...previous.supportPoints[key]))>.001*scale)errors.push(`${key}: stance foot slides`);
          const g=pose.gait[short];if(g?.phase>.14&&g.phase<.46&&g.settle===0&&bend>.48)errors.push(`${key}: stance knee remains crouched`);
        }else{
          const local=c.clone().sub(position(mapped.hips)).applyQuaternion(rotation(mapped.hips).invert()).divideScalar(scale);
          if(local.y>0&&local.y<.53&&(local.x/.19)**2+(local.z/.14)**2<1)errors.push(`${key}: hand intersects torso`);
        }
      }
      return {status:errors.length?'FAIL':'PASS',errors,points,supportPoints,contacts:pose.contacts,contactIds:pose.contactIds,fingers:api.capabilities,scope:'Measured mapped joints and sole anchors; mesh collisions and asset-specific foot shape require visual review.'};
    }
  };return api;
}
