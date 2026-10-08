import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {AdaptiveQuality,PRESETS,percentile} from '../../tracks/music-video/player/quality.js';
import {demoWave} from '../../tracks/music-video/player/demo-audio.mjs';
import {validateGeneratedPlayback} from './playback-browser.mjs';
import {createDistantCharacter} from '../../tracks/music-video/sample/distant-character.js';
import {inspectRig} from '../../tracks/music-video/character/rig.js';

test('distant preview mesh keeps production joint constraints within a small geometry budget',()=>{
  const actor=createDistantCharacter();let triangles=0;
  actor.object.traverse(o=>{if(o.isMesh)triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3;});
  assert.ok(triangles<5000);
  for(const action of ['stand','windWalk'])for(const t of [0,.2,.4,.6,.8,1,2,6]) {
    const pose=actor.update(action,t,{distance:t*.22});assert.deepEqual(inspectRig(actor.rig,pose).errors,[]);
  }
});

test('adaptive p90 lowers slow frames, requires sustained headroom, and respects manual selection',()=>{
  const q=new AdaptiveQuality();q.sample(90,0);assert.equal(q.sample(90,2000).to,'low');
  for(let t=4000;t<32000;t+=2000)q.sample(10,t);
  assert.equal(q.level,'low','slow tier cannot bounce back within 30 seconds');
  assert.equal(q.sample(10,32000).to,'medium');
  q.select('high');for(let t=0;t<=10000;t+=1000)q.sample(200,t);assert.equal(q.level,'high');
  q.select('auto');for(let t=0;t<=4000;t+=1000)q.sample(10,t);assert.equal(q.level,'high');
  q.select('auto');q.sample(200,0);q.resetSampling();assert.equal(q.sample(10,60000),null);assert.equal(q.level,'medium','paused or hidden wall time must not count as a slow window');
  assert.throws(()=>q.select('final'));assert.equal(q.sample(NaN,0),null);
  assert.equal(percentile([1,2,3,4,5,6,7,8,9,100]),9);
  assert.ok(PRESETS.low.scale<PRESETS.medium.scale&&PRESETS.medium.scale<PRESETS.high.scale);
});

test('synthetic demo wave is finite, audible PCM with the promised duration',()=>{
  const wave=demoWave(1);assert.equal(wave.toString('ascii',0,4),'RIFF');assert.equal(wave.readUInt32LE(40)/wave.readUInt32LE(28),1);
  let peak=0;for(let i=44;i<wave.length;i+=2)peak=Math.max(peak,Math.abs(wave.readInt16LE(i)));
  assert.ok(peak>1000&&peak<32767);assert.throws(()=>demoWave(100000));
});

test('generated real-time page: trusted sound, 20-second clock, auto quality, slow network and weak CPU',{timeout:360000},async()=>{
  const base=process.env.SCENE_EVIDENCE_DIR||os.tmpdir();await mkdir(base,{recursive:true});
  const out=await mkdtemp(path.join(base,'scene-player-'));
  console.log(`Playback evidence retained: ${out}`);await validateGeneratedPlayback(out);
});
