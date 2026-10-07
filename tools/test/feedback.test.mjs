import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../tracks/music-video/engine/vendor/three.module.js';
import {footprintField,pathFootsteps} from '../../tracks/music-video/engine/traces/index.js';
import {continuousHeightfield,sampleAxis} from '../../tracks/music-video/kits/heightfield.js';
import {particleTimeDomain,getTimeline} from '../../tracks/music-video/engine/particles.js';
import {skyPreset,lunarTransmittance} from '../../tracks/music-video/engine/sky-presets.js';
import {createApartment} from '../../tracks/music-video/kits/apartment.js';
import {createPottedPlant,createFoldedPaper} from '../../tracks/music-video/kits/close-props.js';
import {measureComposition} from '../../tracks/music-video/engine/composition.js';
import {createSkeleton,applyPose,inspectRig} from '../../tracks/music-video/character/rig.js';
import {poseAt} from '../../tracks/music-video/character/motion.js';
import {solveHandContacts} from '../../tracks/music-video/character/contact.js';
import {alignedSongLines,subtitleAt} from '../../tracks/music-video/engine/lyrics/index.js';
import {verifyWeight,demucsModel} from '../music/lyrics/fetch.mjs';
import {spawnSync} from 'node:child_process';

test('curved footsteps use arc length, alternate sides, fill over time and restore on reverse seek',()=>{
 const path=[[0,0,3],[1,0,0],[-1,0,-3],[2,0,-7]],marks=pathFootsteps({path,count:20,step:.45,startTime:0});
 assert.equal(marks.length,20);for(let i=1;i<marks.length;i++){assert.notEqual(marks[i].side,marks[i-1].side);assert.ok(Math.abs(marks[i].distance-marks[i-1].distance-.45)<1e-10);assert.ok(Math.abs(marks[i].birth-marks[i-1].birth-.45/.38)<1e-10);}
 const field=footprintField({path,count:20,startTime:0,fillAfter:2,fillDuration:1}),m=field.marks[4],sample=t=>field.height(m.x,m.z,t);
 assert.equal(sample(m.birth-.1),0);assert.ok(sample(m.birth+.5)<-.03);const fresh=sample(m.birth+.5);assert.equal(sample(m.birth+4),0);assert.equal(sample(m.birth+.5),fresh);
 assert.notEqual(marks[1].yaw,marks[15].yaw);
});
test('heightfield has a single monotonic nonuniform grid with continuous far heights',()=>{
 const xs=sampleAxis({min:-100,max:100,nearMin:-2,nearMax:2,step:.1});assert.ok(xs.every((x,i)=>!i||x>xs[i-1]));assert.equal(xs[0],-100);assert.equal(xs.at(-1),100);
 const field=continuousHeightfield({x:{min:-100,max:100,nearMin:-2,nearMax:2,step:.1},z:{min:-100,max:100,nearMin:-2,nearMax:2,step:.1},height:(x,z,t)=>Math.sin(x*.01)+z*.02+t});
 const p=field.geometry.attributes.position;field.update(3);for(let i=0;i<p.count;i++)assert.ok(Math.abs(p.getY(i)-(Math.sin(p.getX(i)*.01)+p.getZ(i)*.02+3))<1e-6);field.geometry.dispose();assert.throws(()=>sampleAxis({growth:1}));
});
test('particle CPU drift and GPU texture domain cover a ten minute song',()=>{
 const world={at:t=>({wind:1,windDir:[1,0,0],rain:t>350?1:0}),particleTimeDomain:{start:-8,end:720,step:.125}};
 const domain=particleTimeDomain(world),tl=getTimeline(THREE,world);assert.ok(domain.end>=720);assert.ok(Math.abs(tl.at(600)[0]-3600)<.001);assert.equal(tl.at(360)[3],1);assert.deepEqual(tl.domain,[-8,.125,domain.count-1.001]);tl.tex.dispose();assert.throws(()=>particleTimeDomain({particleTimeDomain:{end:1e6}}));
});
test('cold lunar cloud tint neutralizes red extinction without changing luminance',()=>{
 const preset=skyPreset('coldNight'),rgb=lunarTransmittance([.8,.3,.1],preset.sky.lunarCloudNeutrality);assert.equal(rgb[0],rgb[2]);assert.ok(preset.sky.moonLightColor[2]>preset.sky.moonLightColor[0]);preset.sky.mie=99;assert.notEqual(skyPreset('coldNight').sky.mie,99);
});
test('window schedules, plant growth and boat folding restore on reverse seek',()=>{
 const kit=createApartment({floors:2,columns:2,windows:{'0:0':{brightness:.8,offAt:8},'1:1':{schedule:[[2,.3],[6,0]]}}});kit.update(9);assert.equal(kit.lights[0].pane.material.emissiveIntensity,0);kit.update(1);assert.equal(kit.lights[0].pane.material.emissiveIntensity,.8);kit.dispose();
 const plant=createPottedPlant();plant.update(4,{growth:.4,unfurl:.2});const first=plant.leafGroups[0].group.rotation.x;plant.update(9,{growth:1,unfurl:1});plant.update(4,{growth:.4,unfurl:.2});assert.equal(plant.leafGroups[0].group.rotation.x,first);plant.dispose();
 const paper=createFoldedPaper({waterHeight:()=>2});paper.update(3,{fold:1});const vertices=[...paper.geometry.attributes.position.array];assert.ok(paper.object.position.y>2);paper.update(1,{fold:0});paper.update(3,{fold:1});assert.deepEqual([...paper.geometry.attributes.position.array],vertices);paper.dispose();
});
test('composition distinguishes offscreen/hidden subjects, occlusion and negative space',()=>{
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(50,1,.1,100);camera.position.z=5;camera.lookAt(0,0,0);
 const actor=new THREE.Mesh(new THREE.BoxGeometry(1,2,1),new THREE.MeshBasicMaterial());scene.add(actor);
 const run=()=>measureComposition({scene,camera,characters:[actor],columns:32,rows:32});const unobstructed=run();assert.ok(unobstructed.characterAreaFraction>.08);assert.equal(unobstructed.visibleFraction,1);assert.ok(unobstructed.negativeSpaceFraction>.5);
 const wall=new THREE.Mesh(new THREE.BoxGeometry(3,3,.1),new THREE.MeshBasicMaterial());wall.position.z=2;scene.add(wall);const blocked=run();assert.equal(blocked.characterAreaFraction,0);assert.equal(blocked.occludedFraction,1);
 wall.visible=false;actor.visible=false;assert.equal(run().projectedCharacterAreaFraction,0);actor.visible=true;actor.position.z=8;assert.equal(run().characterAreaFraction,0);
});
test('non-standing supports and hand IK report actual contact error including unreachable targets',()=>{
 const rig=createSkeleton();for(const action of ['sit','lie']){const pose=poseAt(action,4);applyPose(rig,pose);assert.deepEqual(inspectRig(rig,pose).errors,[]);pose.bodySupports[0].height+=.2;assert.ok(inspectRig(rig,pose).errors.some(e=>e.includes('body support')));}
 const pose=poseAt('stand',0);const report=solveHandContacts(rig,pose,{L:[.27,1.15,.4]});assert.ok(report[0].errorMetres<.015);assert.deepEqual(inspectRig(rig,pose).errors,[]);
 assert.equal(solveHandContacts(rig,pose,{L:[3,2,1]})[0].reachable,false);assert.ok(inspectRig(rig,pose).errors.some(e=>e.includes('hand contact error')));
});
test('subtitle adapters display only confirmed/high-confidence locked lines and preserve punctuation',()=>{
 const lines=[{text:'甲，乙',start:1,end:3,locked:true,words:[{text:'甲',offset:0,length:1,start:1,end:2},{text:'乙',offset:2,length:1,start:2,end:3}]},{text:'candidate',start:3,end:4,locked:false}];
 assert.equal(subtitleAt(lines,3.5).text,'');assert.equal(subtitleAt([{...lines[0],locked:undefined}],2).text,'');const adapted=alignedSongLines({lines});assert.equal(adapted.length,1);assert.equal(adapted[0].chars.map(c=>c.c).join(''),'甲，乙');assert.equal(adapted[0].chars[2].t0,2);
});
test('Demucs pin rejects corrupt bytes and records a full official hash',()=>{
 assert.match(demucsModel.sha256,/^[a-f0-9]{64}$/);assert.equal(demucsModel.license,'MIT');assert.ok(demucsModel.file.includes(demucsModel.sha256.slice(0,8)));assert.throws(()=>verifyWeight(Buffer.from('corrupt')),/SHA-256/);
});
test('synthetic audio goes through the complete lyrics pipeline with bounded onset error', {timeout:180000}, t=>{
 const python=process.env.SCENE_PYTHON||'python3';
 const check=spawnSync(python,['-c','import numpy, scipy, librosa, matplotlib, soundfile'],{encoding:'utf8'});
 if(check.status!==0){if(process.env.SCENE_PYTHON)assert.fail(check.stderr);t.skip('Python music dependencies unavailable; install tools/music/lyrics/requirements.txt and set SCENE_PYTHON');return;}
 const result=spawnSync(python,['tools/music/lyrics/align.py','--selftest'],{encoding:'utf8',timeout:170000,env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',NUMBA_NUM_THREADS:'1'}});assert.equal(result.status,0,result.stdout+'\n'+result.stderr);const report=JSON.parse(result.stdout.trim());assert.ok(report.onsetMaxErrorSeconds<=.12);assert.equal(report.syllables,12);t.diagnostic(JSON.stringify(report));
});
