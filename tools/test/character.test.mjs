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

test('feminine shape has independent shoulders, waist, hips, bust, neck, hands and face',()=>{
 const m=createCharacter({body:'masculine',coat:false}),f=createCharacter({body:'feminine',coat:false});
 try{
  assert.equal(f.proportions.height,1.66);assert.equal(f.proportions.headRatio,7.4);
  assert.ok(f.rig.limbs.Larm.upper.position.x<m.rig.limbs.Larm.upper.position.x*.9);
  const radius=(a,y)=>a.proportions.bodyRings.find(r=>r[0]===y)[1];
  assert.ok(radius(f,1.11)<radius(m,1.11)*.9);assert.ok(radius(f,.90)>radius(m,.90)*1.1);
  assert.ok(f.proportions.neckRadius<m.proportions.neckRadius*.9);
  assert.ok(f.rig.fingers[2].length<m.rig.fingers[2].length*.9);
  const frontAtChest=a=>{const p=a.object.getObjectByName('continuous-body').geometry.attributes.position;let max=-Infinity;for(let i=0;i<p.count;i++)if(p.getY(i)>1.29&&p.getY(i)<1.35&&Math.abs(p.getX(i))<.13)max=Math.max(max,p.getZ(i));return max;};
  assert.ok(frontAtChest(f)>frontAtChest(m)+.025,'clothed bust must have real volume');
  const jaw=a=>{const p=a.object.getObjectByName('sculpted-face').geometry.attributes.position;let max=0;for(let i=0;i<p.count;i++)if(p.getY(i)<-.085)max=Math.max(max,Math.abs(p.getX(i)));return max;};
  assert.ok(jaw(f)<jaw(m)*.9);
 }finally{dispose(m);dispose(f);}
});

test('relaxed fingers bend towards the palm, increase index to little, and reject hyperextension',()=>{
 const a=createCharacter({body:'feminine',coat:false});
 try{
  for(const side of ['L','R']){
   let pose=a.update('stand',1,{handPose:'relaxed'}),previous=0;
   const hand=a.rig.limbs[side+'arm'].tip;
   for(const f of a.rig.fingers.filter(f=>f.side===side&&!f.thumb)){
    const angle=-f.joints[0].rotation.x*180/Math.PI;assert.ok(angle>previous);previous=angle;
    if(f.index===1)assert.ok(angle>=10&&angle<=20);if(f.index===4)assert.ok(angle>=25&&angle<=40);
    const base=hand.worldToLocal(f.joints[0].getWorldPosition(new THREE.Vector3())),end=hand.worldToLocal(f.joints[2].localToWorld(new THREE.Vector3(0,-f.length*.24,0)));
    assert.ok(end.z>base.z+.006,'finger curls to +Z palm, away from -Z nail');
   }
   const f=a.rig.fingers.find(f=>f.side===side&&f.index===1);f.joints[1].rotation.x=11*Math.PI/180;
   assert.ok(inspectRig(a.rig,pose).errors.some(e=>e.includes('hyperextension exceeds 10')));
   pose=a.update('stand',1,{handPose:'relaxed'});f.joints[0].rotation.x=-.65;
   assert.ok(inspectRig(a.rig,pose).errors.some(e=>e.includes('must increase')));
  }
  for(const gesture of ['relaxed','open','touch','smooth','carry']){
   const pose=a.update('stand',1,{handPose:gesture});assert.deepEqual(inspectRig(a.rig,pose).errors,[]);
   const normal=new THREE.Vector3(0,0,1).applyQuaternion(a.rig.limbs.Larm.tip.getWorldQuaternion(new THREE.Quaternion()));
   if(gesture==='open')assert.ok(normal.y>.8,'open palm faces up');if(gesture==='smooth')assert.ok(normal.y<-.8,'smooth palm faces down');
   if(gesture==='touch'){const fs=a.rig.fingers.filter(f=>f.side==='L'&&!f.thumb);assert.ok(-fs[0].joints[0].rotation.x<.04);assert.ok(fs.slice(1).every(f=>-f.joints[0].rotation.x>.4));}
  }
 }finally{dispose(a);}
});

test('scarf and hair respond to wind with deterministic seek; two tails and a helical wrap replace the ring',()=>{
 const a=createCharacter({body:'feminine',hairStyle:'ponytail'});
 try{
  assert.equal(a.object.getObjectByName('scarf-wrap').geometry.type,'BufferGeometry');
  const tails=[0,1].map(i=>a.object.getObjectByName(`scarf-tail-${i}`));assert.ok(tails.every(Boolean));
  a.update('walk',1,{wind:0});const still=tails[0].geometry.attributes.position.array.slice();
  a.update('walk',1,{wind:1});const windy=tails[0].geometry.attributes.position.array.slice();assert.notDeepEqual(still,windy);
  for(let i=0;i<windy.length;i+=12){const width=Math.hypot(windy[i]-windy[i+3],windy[i+1]-windy[i+4],windy[i+2]-windy[i+5]);assert.ok(Math.abs(width-.055)<1e-6,'wind must preserve ribbon width rather than collapse it to a line');}
  a.update('stand',4,{wind:.2});a.update('walk',1,{wind:1});assert.deepEqual(tails[0].geometry.attributes.position.array,windy);
  const shoe=a.object.getObjectByName('boot-last').geometry;shoe.computeBoundingBox();assert.ok(shoe.boundingBox.max.z-shoe.boundingBox.min.z>.29);
  assert.deepEqual(topology(shoe),{components:1,openEdges:0},'shoe last must close at toe and heel');
  assert.deepEqual(topology(a.object.getObjectByName('boot-sole').geometry),{components:1,openEdges:0},'sole must have closed ends');
 }finally{dispose(a);}
});

test('all prop actions preserve anatomy and lantern handle remains at the gripping hand',()=>{
 const a=createCharacter({body:'feminine'});
 try{
  for(const action of ['lanternWalk','bagWalk','holdCup','phone']){
   let previous;
   for(let i=0;i<=48;i++){
    const pose=a.update(action,i/24),r=inspectRig(a.rig,pose,previous);assert.deepEqual(r.errors,[],`${action} ${i}`);previous=r;
    if(action==='lanternWalk'){
     const socket=a.rig.limbs.Larm.tip.localToWorld(new THREE.Vector3(0,-.078*a.proportions.handScale,.022*a.proportions.handScale)),handle=a.props.objects.lantern.getWorldPosition(new THREE.Vector3());assert.ok(socket.distanceTo(handle)<1e-6);
     assert.equal(a.rig.fingers.find(f=>f.side==='L').gesture,'carry');
    }
    if(action==='phone')assert.ok(a.rig.neck.rotation.x>.35);
   }
  }
 }finally{dispose(a);}
});

test('every coat style has a level sewn hem and contains the feminine chest surface',()=>{
 for(const coatStyle of ['long','cloak','short']){
  const a=createCharacter({body:'feminine',coatStyle});
  try{
   const g=a.object.getObjectByName('coat-shell').geometry,p=g.attributes.position;
   assert.deepEqual(topology(g),{components:1,openEdges:0},coatStyle);
   const hem=coatStyle==='long'?.595:coatStyle==='cloak'?.32:.99;
   const low=[],front=[];
   for(let i=0;i<p.count;i++){
    const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
    if(Math.abs(x)<.19&&y<hem+.012&&y>hem-.02)low.push(y);
    if(Math.abs(x)<.12&&y>1.30&&y<1.34)front.push(z);
   }
   assert.ok(low.length>10);assert.ok(low.every(y=>Math.abs(y-hem)<1e-6),'no marching-grid saw teeth at hem');
   const bp=a.object.getObjectByName('continuous-body').geometry.attributes.position;let bodyFront=0;
   for(let i=0;i<bp.count;i++)if(Math.abs(bp.getX(i))<.12&&bp.getY(i)>1.30&&bp.getY(i)<1.34)bodyFront=Math.max(bodyFront,bp.getZ(i));
   assert.ok(Math.max(...front)>bodyFront+.009,'outer cloth chest has clearance');
  }finally{dispose(a);}
 }
});
