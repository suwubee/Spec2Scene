import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as THREE from '../../tracks/music-video/engine/vendor/three.module.js';
import {poseAt,blendPoses} from '../../tracks/music-video/character/motion.js';
import {createSkeleton,applyPose,inspectRig} from '../../tracks/music-video/character/rig.js';
import {characterBounds,placeSubtitle} from '../../tracks/music-video/engine/composition.js';
import {fogTerrain} from '../../tracks/music-video/engine/fog-terrain.js';
import {telephotoMaxStep,createMountainLOD} from '../../tracks/music-video/kits/heightfield.js';
import {createRock} from '../../tracks/music-video/kits/rock.js';
import {createSmallWater} from '../../tracks/music-video/kits/small-water.js';
import {reviewGate} from '../review-gates.mjs';
import {watchdog} from '../watchdog.mjs';
import {shotPostAt} from '../../tracks/music-video/engine/core.js';

test('shot white balance and exposure curves override global defaults and restore after another shot',()=>{
  const state={post:{whiteBalance:[.7,.8,1]},exposureBias:.2},global={whiteBalance:[1.4,.8,.6],exposure:2},shot={post:t=>({exposure:t*.1,whiteBalance:[1,1,1]})};
  const first=shotPostAt(state,global,shot,3);assert.equal(first.exposure,.5);assert.deepEqual(first.whiteBalance,[1,1,1]);
  shotPostAt(state,global,{post:{exposure:8}},1);assert.deepEqual(shotPostAt(state,global,shot,3),first);
  assert.equal(shotPostAt(state,global,shot,3,{exposure:1}).exposure,1.2);assert.equal(global.exposure,2);
});

test('seated presets and blended/additive actions respect anatomy over continuous time',()=>{
  const rig=createSkeleton();
  for(const action of ['sit','sitKnees','hugKnees'])for(let i=0;i<=160;i++){const p=poseAt(action,i/40);applyPose(rig,p);assert.deepEqual(inspectRig(rig,p).errors,[],`${action} ${i/40}`);}
  const from=poseAt('pushWindow',3),to=poseAt('sitKnees',4);
  assert.deepEqual(blendPoses(from,to,0),from);assert.deepEqual(blendPoses(from,to,1),to);
  for(let i=0;i<=100;i++){const p=blendPoses(from,to,i/100);applyPose(rig,p);assert.deepEqual(inspectRig(rig,p).errors,[],`blend ${i}`);}
  const walk=poseAt('walk',3),raised=poseAt('walk',3,{additive:[{action:'lookUp',weight:.7}]});assert.deepEqual(raised.limbs,walk.limbs);assert.ok(raised.headPitch<walk.headPitch);
  poseAt('hugKnees',1);assert.deepEqual(poseAt('walk',3,{additive:[{action:'lookUp',weight:.7}]}),raised);
});
test('subtitle bounds follow visibility and choose a clear alternate location',()=>{
  const actor=new THREE.Mesh(new THREE.BoxGeometry(1,2,1),new THREE.MeshBasicMaterial()),camera=new THREE.PerspectiveCamera(40,1,.1,100);camera.position.set(0,1,5);camera.lookAt(0,1,0);actor.position.y=1;
  const bounds=characterBounds(camera,[actor]);assert.equal(bounds.length,1);const box={x0:.25,y0:.8,x1:.75,y1:.9},placed=placeSubtitle(box,bounds);assert.ok(placed.resolved);assert.notEqual(placed.y0,box.y0);
  actor.visible=false;assert.deepEqual(characterBounds(camera,[actor]),[]);assert.ok(!placeSubtitle(box,[{x0:0,y0:0,x1:1,y1:1}]).resolved);
});
test('custom fog terrain samples project coordinates and telephoto LOD increases detail within its budget',()=>{
  const ground=fogTerrain({heightAt:(x,z)=>x+z,waterMask:x=>x>0?1:0,bounds:[-10,-10,10,10],resolution:8});assert.equal(ground.texture.image.data[0],-20);assert.equal(ground.texture.image.data[(8*8-1)*4],20);ground.dispose();
  assert.ok(telephotoMaxStep({distance:1000,focal:200})<telephotoMaxStep({distance:1000,focal:40}));
  const lod=createMountainLOD({height:(x,z)=>Math.sin(x*.05)*20+Math.cos(z*.03)*10,maxSegments:128}),camera=new THREE.PerspectiveCamera(80,1,.1,5000);camera.position.z=100;const wide=lod.update(camera);camera.setFocalLength(200);const tele=lod.update(camera);assert.ok(tele.segments>=wide.segments);assert.ok(lod.object.geometry.attributes.position.count<=129**2);lod.dispose();
  const rock=createRock(),p=rock.object.geometry.attributes.position;assert.ok(p.count>1000);assert.ok([...p.array].every(Number.isFinite));rock.dispose();
  const water=createSmallWater({kind:'puddle',puddles:[[0,0,1],[2,1,.5]]});assert.equal(water.surfaces.length,2);assert.equal(water.surfaces[0].material,water.surfaces[1].material);water.dispose();
});
test('phrase mode segments synthetic activity and enforces explicit approval without optional dependencies',()=>{
  const r=spawnSync(process.env.SCENE_PYTHON||'python3',['tools/music/lyrics/phrase.py','--selftest'],{encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stdout+r.stderr);
});
test('schema 2 review requires every intervening gate and prevents self-signature',()=>{
  const record={schema:2,revision:'test',implementer:'implementation',gates:{}};
  for(const gate of ['G1','G1b','G2G3','FINAL'])record.gates[gate]={status:'PASS',revision:'test',reviewer:'independent',reviewedAt:'test-time',evidence:['test.png'],findings:['test finding'],scope:'synthetic test',reviewFile:`REVIEW-${gate}.md`,gateFile:`GATE-${gate}.md`};
  assert.equal(reviewGate(record,'FINAL').status,'PASS');record.gates.G1b.status='PENDING';assert.throws(()=>reviewGate(record,'FINAL'),/G1b/);record.gates.G1b.status='PASS';record.gates.FINAL.reviewer='implementation';assert.throws(()=>reviewGate(record,'FINAL'),/self-review/);
});
test('watchdog terminates and awaits its own stalled child before restarting with context', {timeout:15000},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'scene-watchdog-'));try{
    const context=path.join(root,'context.md'),report=path.join(root,'report.json');await writeFile(context,'Synthetic restart checkpoint');
    const script="if(process.env.SCENE_RESTART_ATTEMPT==='0')setInterval(()=>{},1000);else{require('fs').writeFileSync('resumed.txt',require('fs').readFileSync(process.env.SCENE_RESTART_CONTEXT));}";
    const result=await watchdog({root,context,report,command:[process.execPath,'-e',script],idleSeconds:.15,commandSeconds:5,pollSeconds:.05,restarts:1});assert.equal(result.status,'PASS');assert.equal(result.events.filter(e=>e.event==='stalled').length,1);assert.equal(result.events.filter(e=>e.event==='closed').length,2);assert.equal(await readFile(path.join(root,'resumed.txt'),'utf8'),'Synthetic restart checkpoint');
  }finally{await rm(root,{recursive:true,force:true});}
});
