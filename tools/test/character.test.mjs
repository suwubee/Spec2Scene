import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../tracks/music-video/engine/vendor/three.module.js';
import {createCharacter,adaptExternalCharacter,loadExternalCharacter} from '../../tracks/music-video/character/index.js';
import {createSkeleton,applyPose,inspectRig} from '../../tracks/music-video/character/rig.js';
import {poseAt,gait,handPoses,actions} from '../../tracks/music-video/character/motion.js';

function topology(geometry){
 const edges=new Map(),adj=new Map(),index=geometry.index.array;
 for(let i=0;i<index.length;i+=3)for(let j=0;j<3;j++){
  const a=index[i+j],b=index[i+(j+1)%3];for(const [u,v] of [[a,b],[b,a]]){if(!adj.has(u))adj.set(u,new Set());adj.get(u).add(v);}
  const key=[a,b].sort((a,b)=>a-b).join(':');edges.set(key,(edges.get(key)||0)+1);
 }
 let components=0;const visited=new Set();
 for(const v of adj.keys()){if(visited.has(v))continue;components++;const stack=[v];while(stack.length){const u=stack.pop();if(visited.has(u))continue;visited.add(u);for(const w of adj.get(u))stack.push(w);}}
 return {components,openEdges:[...edges.values()].filter(n=>n!==2).length};
}
function dispose(actor){actor.object.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});}

test('body and hands are connected watertight weighted surfaces; clothing has a stitched lining',()=>{
 const actor=createCharacter();
 try{for(const name of ['continuous-body','hand-L','hand-R','coat-shell']){
  const mesh=actor.object.getObjectByName(name);assert.ok(mesh.isSkinnedMesh);assert.deepEqual(topology(mesh.geometry),{components:1,openEdges:0},name);
  const p=mesh.geometry.attributes.position,w=mesh.geometry.attributes.skinWeight,indices=mesh.geometry.attributes.skinIndex;
  for(let i=0;i<p.count;i++){let sum=0;for(let j=0;j<4;j++){const weight=w.array[i*4+j];assert.ok(Number.isFinite(weight)&&weight>=0);assert.ok(indices.array[i*4+j]<actor.skeleton.bones.length);sum+=weight;}assert.ok(Math.abs(sum-1)<1e-6);}
 }
 const shell=actor.object.getObjectByName('coat-shell').geometry;assert.ok(shell.userData.thickness>=.006&&shell.userData.boundaryEdges>0);
 for(const action of ['walk','pushWindow','shade','sit']){actor.update(action,1.5);const mesh=actor.object.getObjectByName('continuous-body');for(let i=0;i<mesh.geometry.attributes.position.count;i+=31){const p=mesh.getVertexPosition(i,new THREE.Vector3());assert.ok(p.toArray().every(Number.isFinite));}}
 const body=actor.object.getObjectByName('continuous-body'),arm=actor.rig.limbs.Larm;
 const inv=actor.skeleton.boneInverses[actor.skeleton.bones.indexOf(arm.upper)],ring=[];
 for(let i=0;i<body.geometry.attributes.position.count;i++){
  const p=new THREE.Vector3().fromBufferAttribute(body.geometry.attributes.position,i),local=p.clone().applyMatrix4(inv);
  if(Math.abs(local.y+arm.a)<.012&&Math.hypot(local.x,local.z)<.085)ring.push(i);
  if(p.y>.82&&p.y<1.02&&Math.abs(p.x)<.20){const indices=body.geometry.attributes.skinIndex,weights=body.geometry.attributes.skinWeight;for(let j=0;j<4;j++)if(weights.array[i*4+j]>.001)assert.ok(!actor.skeleton.bones[indices.array[i*4+j]].name.includes('arm'),'pelvic vertices must not be dragged by the arms');}
 }
 actor.update('pushWindow',2.3);const elbow=arm.lower.getWorldPosition(new THREE.Vector3()),axis=arm.tip.getWorldPosition(new THREE.Vector3()).sub(elbow).normalize();
 const radii=ring.map(i=>{const p=body.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(body.matrixWorld).sub(elbow);return p.addScaledVector(axis,-p.dot(axis)).length();}).sort((a,b)=>a-b);
 assert.ok(radii.length>30&&radii[Math.floor(radii.length/2)]>.022,'elbow volume must survive pronation');
 assert.equal(actor.rig.fingers.length,10);assert.equal(actor.rig.fingers.flatMap(f=>f.joints).length,30);
 }finally{dispose(actor);}
});

test('contact trajectory is continuous at heel strike/toe off and stance has straight knees and opposing arms',()=>{
 const stride=.9;
 for(const boundary of [0,.1,.48,.62,1])for(const side of ['L','R']){
  const a=gait((boundary-1e-7)*stride,side),b=gait((boundary+1e-7)*stride,side);
  assert.ok(Math.hypot(a.z-b.z,a.y-b.y)<1e-5,`${side} boundary ${boundary}`);assert.ok(Math.abs(a.footPitch-b.footPitch)<1e-5);
 }
 const rig=createSkeleton();let previous,maxKnee=0,maxSlip=0;
 for(let i=0;i<480;i++){
  const pose=poseAt('walk',i/120);applyPose(rig,pose);const report=inspectRig(rig,pose,previous);assert.deepEqual(report.errors,[]);
  for(const side of ['L','R']){const g=pose.gait[side],key=side+'leg';if(g.phase>.14&&g.phase<.46)maxKnee=Math.max(maxKnee,rig.limbs[key].lower.rotation.x);
   if(previous&&pose.contacts[key]&&previous.contacts[key]&&pose.contactIds[key]===previous.contactIds[key])maxSlip=Math.max(maxSlip,new THREE.Vector3(...previous.supportPoints[key]).distanceTo(new THREE.Vector3(...report.supportPoints[key])));
  }previous=report;
 }
 assert.ok(maxKnee<.48);assert.ok(maxSlip<1e-5);
 assert.throws(()=>gait(Infinity,'L'));assert.throws(()=>poseAt('walk',1,{speed:NaN}));assert.throws(()=>createCharacter({height:NaN}));
});

test('anatomy rejects crouched support, reversed swing, backwards fingers and floating soles',()=>{
 const actor=createCharacter({coat:false,scarf:false});
 try{
 for(const handPose of Object.keys(handPoses)){const pose=actor.update('stand',1,{handPose});assert.deepEqual(inspectRig(actor.rig,pose).errors,[],handPose);}
 let pose=actor.update('walk',.6),rig=actor.rig;
 rig.limbs.Lleg.lower.rotation.x=.8;rig.limbs.Larm.upper.rotation.x=-.8;rig.fingers[0].joints[1].rotation.x=.1;rig.root.updateMatrixWorld(true);
 const errors=inspectRig(rig,pose).errors;
 assert.ok(errors.some(e=>e.includes('stance knee')));assert.ok(errors.some(e=>e.includes('arm swing')));assert.ok(errors.some(e=>e.includes('finger')));assert.ok(errors.some(e=>e.includes('sole off ground')));
 pose=actor.update('stand',1);rig.limbs.Larm.tip.position.x=NaN;rig.root.updateMatrixWorld(true);assert.ok(inspectRig(rig,pose).errors.some(e=>e.includes('nonfinite')));
 }finally{dispose(actor);}
});

// Procedural fixtures exercise adapter math only; they are not licensed asset or
// human capture evidence. Nothing is bundled as a user model.
function externalFixture({differentAxes=false,scale=1,fingers=false}={}){
 const rig=createSkeleton(),scene=new THREE.Group();scene.add(rig.root);scene.scale.setScalar(scale);
 const mapping={hips:rig.pelvis,chest:rig.chest,neck:rig.neck};
 for(const [side,short] of [['left','L'],['right','R']])for(const [type,lower] of [['Arm','arm'],['Leg','leg']]){
  const l=rig.limbs[short+lower];mapping[side+'Upper'+type]=l.upper;mapping[side+'Lower'+type]=l.lower;mapping[side+(type==='Arm'?'Hand':'Foot')]=l.tip;
  if(differentAxes)for(const node of [l.upper,l.lower]){const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2);node.quaternion.multiply(q);for(const child of node.children){child.position.applyQuaternion(q.clone().invert());child.quaternion.premultiply(q.clone().invert());}}
 }
 if(fingers)for(const side of ['left','right'])for(const digit of ['Thumb','Index','Middle','Ring','Little']){
  let parent=mapping[side+'Hand'];
  for(const segment of digit==='Thumb'?['Metacarpal','Proximal','Distal']:['Proximal','Intermediate','Distal']){
   const bone=new THREE.Bone();bone.position.y=-.025;bone.name=side+digit+segment;parent.add(bone);mapping[bone.name]=bone;parent=bone;
  }
 }
 scene.updateMatrixWorld(true);const bones=[];rig.root.traverse(o=>{if(o.isBone)bones.push(o);});
 const g=new THREE.BoxGeometry(.2,.3,.1),n=g.attributes.position.count;g.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(new Uint16Array(n*4),4));const w=new Float32Array(n*4);for(let i=0;i<n;i++)w[i*4]=1;g.setAttribute('skinWeight',new THREE.Float32BufferAttribute(w,4));
 const mesh=new THREE.SkinnedMesh(g,new THREE.MeshBasicMaterial());scene.add(mesh);mesh.bind(new THREE.Skeleton(bones));return {scene,mapping};
}

test('external adapter retargets measured joints with different bind axes and uniform units; catches actual bone corruption',()=>{
 for(const differentAxes of [false,true])for(const scale of [1,100]){
  const f=externalFixture({differentAxes,scale}),actor=adaptExternalCharacter({...f,license:'Synthetic unit test fixture'});
  for(const action of actions){let previous;for(let i=0;i<=48;i++){actor.update(action,i/12);const r=actor.inspect(previous);assert.deepEqual(r.errors,[],`${action} ${i/12} axes=${differentAxes} scale=${scale}`);previous=r;}}
  actor.update('stand',1);f.mapping.leftLowerLeg.position.y-=.05;f.scene.updateMatrixWorld(true);assert.ok(actor.inspect().errors.some(e=>e.includes('bone length')));
  assert.equal(actor.capabilities.fingers,'PARTIAL');assert.equal(actor.capabilities.missingFingers.length,10);dispose(actor);
 }
});

test('GLB/glTF loader and VRM raw-bone interface require explicit license and complete mapping',async()=>{
 const f=externalFixture();assert.throws(()=>adaptExternalCharacter(f),/license/);
 assert.throws(()=>adaptExternalCharacter({...externalFixture(),license:'fixture',mapping:{}}),/mapping/);
 const g=externalFixture();g.scene.scale.x=2;assert.throws(()=>adaptExternalCharacter({...g,license:'fixture'}),/uniform/);
 let requested;
 const loader={async loadAsync(url){requested=url;return {scene:f.scene,userData:{vrm:{humanoid:{getRawBoneNode:name=>f.mapping[name]}}}};}};
 const actor=await loadExternalCharacter({url:'user-avatar.glb',loader,license:'Synthetic test fixture'});assert.equal(requested,'user-avatar.glb');actor.update('walk',1);assert.deepEqual(actor.inspect().errors,[]);dispose(actor);
 await assert.rejects(loadExternalCharacter({url:'avatar.vrm'}),/loader/);
});


test('external complete fingers are articulated and actual corruption/nonfinite transforms fail',()=>{
 const fixture=externalFixture({fingers:true}),actor=adaptExternalCharacter({...fixture,license:'Synthetic test fixture'});
 assert.equal(actor.capabilities.fingers,'PASS');
 for(const handPose of ['relaxed','carry','open','touch','smooth']){actor.update('stand',1,{handPose});assert.deepEqual(actor.inspect().errors,[]);}
 fixture.mapping.leftIndexIntermediate.rotation.x=.7;assert.ok(actor.inspect().errors.some(e=>e.includes('deviates')));
 actor.update('stand',1);fixture.mapping.leftUpperLeg.position.x=NaN;assert.ok(actor.inspect().errors.some(e=>e.includes('nonfinite')));dispose(actor);
 const invalid=externalFixture();invalid.mapping.hips.position.y=NaN;assert.throws(()=>adaptExternalCharacter({...invalid,license:'fixture'}),/finite/);
});


test('stopping decelerates continuously and settles into two planted feet',()=>{
 const h=.001,velocity=t=>(poseAt('stop',t+h).position[2]-poseAt('stop',t-h).position[2])/(2*h);
 assert.ok(velocity(1.8)>velocity(2.1)&&velocity(2.1)>velocity(2.3));assert.ok(Math.abs(velocity(2.4))<1e-6);
 const stopped=poseAt('stop',4);assert.ok(Math.abs(stopped.position[2]-.75)<1e-10);assert.equal(stopped.hipHeight,.94);assert.ok(Object.values(stopped.contacts).every(Boolean));
});
