import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {hash,curve} from '../../tracks/music-video/engine/core/math.js';
import {createWorld} from '../../tracks/music-video/engine/world/index.js';
import {validateShots,shotAt,cameraAt,focalToFov,orbit} from '../../tracks/music-video/engine/camera/index.js';
import {circleOfConfusion,makeLUT} from '../../tracks/music-video/engine/post/index.js';
import {footprintState,afterglow,footprints} from '../../tracks/music-video/engine/traces/index.js';
import {material} from '../../tracks/music-video/engine/materials/index.js';
import {subtitleAt} from '../../tracks/music-video/engine/lyrics/index.js';
import {musicAt,createClock} from '../../tracks/music-video/engine/audio/index.js';
import {createSkeleton,applyPose,inspectRig,twoBone,limits,limit} from '../../tracks/music-video/character/rig.js';
import {poseAt,gait,actions} from '../../tracks/music-video/character/motion.js';
import {createCharacter} from '../../tracks/music-video/character/index.js';
import {checkAnatomy} from '../check-anatomy.mjs';
import {reviewGate} from '../review-gates.mjs';
const shots=JSON.parse(await readFile(new URL('../../tracks/music-video/sample/shots.json',import.meta.url),'utf8'));

test('integer hash, world and shot sampling are independent of seek order',()=>{
  assert.equal(hash(123,4),hash(123,4));assert.notEqual(hash(123,4),hash(123,5));
  const w=createWorld({wind:[[0,.1],[60,.5]]});const before=w.at(13);w.at(59);w.at(0);assert.deepEqual(w.at(13),before);
  assert.equal(curve([[0,2],[1,4]],.5),3);assert.throws(()=>w.at(NaN));
  validateShots(shots);assert.equal(shotAt(shots,29.999).shot.id,'snow-crane');assert.equal(shotAt(shots,30).shot.id,'station-arrival');
  assert.equal(shotAt(shots,30).blend,0);assert.equal(shotAt(shots,31.2).previous,null);assert.equal(shotAt(shots,60).shot.id,'station-departure');
  assert.ok(focalToFov(14)>focalToFov(135));assert.deepEqual(orbit([0,0,0],3,2,0),[0,2,3]);
  const state=cameraAt(shots[2],44);cameraAt(shots[0],0);assert.deepEqual(cameraAt(shots[2],44),state);
  assert.throws(()=>validateShots([{...shots[0],end:0}]));assert.throws(()=>validateShots([{...shots[0],focal:[[0,-1]]}]));
});
test('HDR lens model and optional LUT',()=>{
  assert.equal(circleOfConfusion(5,5),0);assert.ok(circleOfConfusion(2,5,50,1.4)>circleOfConfusion(2,5,50,8));
  const lut=makeLUT(4);assert.deepEqual([...lut.image.data.slice(0,4)],[0,0,0,1]);assert.deepEqual([...lut.image.data.slice(-4)],[1,1,1,1]);lut.dispose();
});
test('traces appear by birth time, decay predictably and reset after reverse seek',()=>{
  assert.equal(footprintState(0,1).visible,false);assert.equal(footprintState(2,1).visible,true);assert.equal(afterglow(4,0,2),.25);
  const traces=footprints({count:3,birth:i=>i});traces.update(9);assert.ok(traces.object.children.every(x=>x.visible));traces.update(-1);assert.ok(traces.object.children.every(x=>!x.visible));
});
test('legacy character material names remain compatible',()=>{
  for(const name of ['cloth','wood','stone','metal','glass','skin'])assert.ok(material(name).isMeshPhysicalMaterial);
  assert.throws(()=>material('unknown'));
});
test('subtitle timing and silent/media clocks share absolute time; no automatic audio unlock',async()=>{
  const lines=[{start:1,end:3,text:'<placeholder>',words:[{text:'<a>',start:1},{text:'<b>',start:2}]}];
  assert.equal(subtitleAt(lines,.9).text,'');assert.equal(subtitleAt(lines,2).active,1);assert.equal(subtitleAt(lines,3).text,'');
  assert.equal(musicAt({beats:[0,.5,1],energy:{times:[0,1],values:[.2,.8]}},1).energy,.8);
  const c=createClock({duration:4});assert.equal(c.playing,false);await c.play(1000);assert.equal(c.time(2500),1.5);c.pause(3000);assert.equal(c.time(9000),2);c.seek(1,9000);assert.equal(c.time(9001),1);
});
test('all action samples pass hinge direction, joint limits, constant bones, torso/ground and stance slip checks',()=>{
  const r=checkAnatomy();assert.deepEqual(r.failures,[]);assert.equal(r.samples,actions.length*481);
  const rig=createSkeleton(),stopped=poseAt('stop',8);applyPose(rig,stopped);const feet=inspectRig(rig,stopped);assert.ok(Object.values(stopped.contacts).every(Boolean));for(const side of ['L','R'])assert.ok(Math.abs(feet.points[side+'leg'][1]-.085)<1e-6,'completed stop must land both feet');
});
test('anatomy guard detects a deliberately reversed knee, hand collision and altered bone length',()=>{
  const rig=createSkeleton(),pose=poseAt('stand',0);applyPose(rig,pose);rig.limbs.Lleg.lower.rotation.x=-.5;rig.limbs.Rarm.lower.position.y=-.4;
  // Place the hand inside the torso in world space, independent of twist-bone layout.
  rig.root.updateMatrixWorld(true);const inside=rig.pelvis.localToWorld(rig.pelvis.position.clone().set(0,.25,0));
  rig.limbs.Larm.tip.position.copy(rig.limbs.Larm.tip.parent.worldToLocal(inside));rig.root.updateMatrixWorld(true);
  const errors=inspectRig(rig,pose).errors;assert.ok(errors.some(e=>e.includes('reversed hinge')));assert.ok(errors.some(e=>e.includes('bone length')));assert.ok(errors.some(e=>e.includes('hand intersects')));
});
test('IK clamps singular/unreachable targets, and mirrored half-cycle gait preserves left/right convention',()=>{
  for(const [y,z] of [[0,0],[-3,2],[-.7,.25]]){const ik=twoBone(y,z,.43,.43);assert.ok(Number.isFinite(ik.root));assert.ok(ik.bend>=limits.knee[0]&&ik.bend<=limits.knee[1]);}
  assert.throws(()=>twoBone(NaN,0,.4,.4));assert.throws(()=>limit('knee',NaN));
  for(let d=.05;d<2;d+=.03){const a=gait(d,'R'),b=gait(d+.45,'L');assert.ok(Math.abs(a.y-b.y)<1e-8);assert.ok(Math.abs(a.z+.45-b.z)<1e-8);}
  const rig=createSkeleton();applyPose(rig,poseAt('stand',0));const r=inspectRig(rig,poseAt('stand',0));
  assert.ok(Math.abs(r.points.Lleg[0]+r.points.Rleg[0])<1e-9);assert.ok(Math.abs(r.points.Larm[0]+r.points.Rarm[0])<1e-9);
  for(const body of ['masculine','feminine'])for(const height of [1.55,1.9]){const c=createCharacter({body,height,headRatio:7.6,backpack:true});c.update('shade',2);assert.ok(c.object.scale.x>0);}
});
test('independent review gates reject self-review, missing predecessor and stale evidence',()=>{
  const record={revision:'test-revision',implementer:'implementer',gates:{G1:{status:'PASS',reviewer:'reviewer',revision:'test-revision',reviewedAt:'test-time',evidence:['test-image'],findings:['test-finding']}}};
  assert.equal(reviewGate(record,'G1').status,'PASS');assert.throws(()=>reviewGate(record,'G2'));
  assert.throws(()=>reviewGate({...record,implementer:'reviewer'},'G1'));assert.throws(()=>reviewGate({...record,revision:'new'},'G1'));
});

test('final render gate blocks missing evidence and mismatched reviewed identity before browser startup',async t=>{
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
  const {requireFinalReview}=await import('../render-final.mjs');const dir=await mkdtemp(path.join(os.tmpdir(),'scene-gates-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'review.json'),record={revision:'test-revision',implementer:'implementation-session',gates:{}};
  for(const gate of ['G1','G2','G3'])record.gates[gate]={status:'PASS',reviewer:'review-session',revision:'test-revision',reviewedAt:'test-time',evidence:['evidence.txt'],findings:['test-finding']};
  await writeFile(file,JSON.stringify(record));await assert.rejects(requireFinalReview(file,'wrong'),/identity/);await assert.rejects(requireFinalReview(file,'test-revision'),/ENOENT/);
  await writeFile(path.join(dir,'evidence.txt'),'synthetic test evidence');assert.equal((await requireFinalReview(file,'test-revision')).revision,'test-revision');
  record.gates.G2.status='PENDING';await writeFile(file,JSON.stringify(record));await assert.rejects(requireFinalReview(file,'test-revision'),/G2/);
});
