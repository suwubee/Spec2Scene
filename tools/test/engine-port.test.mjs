import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {makeRng,gnoise2,hash21} from '../../tracks/music-video/engine/noise.js';
import {createTerrainLibrary} from '../../tracks/music-video/engine/terrain.js';
import {createEnvironment} from '../../tracks/music-video/engine/world/environment.js';
import {resolveQuality} from '../../tracks/music-video/engine/core/quality.js';
import {footprintField} from '../../tracks/music-video/engine/traces/index.js';
import {bevelBox,curvedTile,latticeFrame} from '../../tracks/music-video/engine/geo.js';
import {blockStone,porousStone} from '../../tracks/music-video/kits/garden/geom.js';
import {createTimeline} from '../../tracks/music-video/engine/timeline.js';
import {rangeFrames,checkResume,finite,renderIdentity} from '../cinematic/lib/plan.mjs';
import {parseTimes} from '../cinematic/lib/browser.mjs';
import {collectCharacters} from '../cinematic/build_fonts.mjs';
import {run} from '../lib/cli.mjs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

test('ported integer random streams fork independently; coherent noise is finite and continuous',()=>{
 const a=makeRng('scene'),b=makeRng('scene');assert.deepEqual(Array.from({length:30},()=>a()),Array.from({length:30},()=>b()));
 const f=a.fork('water');a();a();const g=a.fork('water');assert.deepEqual(Array.from({length:8},()=>f()),Array.from({length:8},()=>g()));
 for(const [x,z] of [[-300,70],[.3,.7],[2000.31,-900.3]]){assert.ok(Number.isFinite(gnoise2(x,z)));assert.ok(Math.abs(gnoise2(x,z)-gnoise2(x+.0001,z))<.01);assert.ok(hash21(x,z)>=0&&hash21(x,z)<1);}
});
test('terrain instances isolate project banks/gaps and named parameters have no implicit channels',()=>{
 const plain=createTerrainLibrary(),custom=createTerrainLibrary({banks:{westBankY:8},layout:{embankments:[{length:30,fade:10,z:0}]}});
 assert.deepEqual(plain.GAPS,[]);assert.equal(plain.VALLEY.westBankY,1.2);assert.equal(custom.VALLEY.westBankY,8);assert.ok(custom.heightAt(-65,0)>plain.heightAt(-65,0)+5);
 const w=createEnvironment({wind:[[0,.1],[10,.8]]},{lampA:[[0,0],[4,1]]});assert.deepEqual(Object.keys(w.at(3).parameters),['lampA']);const state=w.at(3);w.at(9);assert.deepEqual(w.at(3),state);assert.ok(Math.abs(Math.hypot(...state.moonDir)-1)<1e-9);
});
test('footprints carve below ground with positive lips; reverse time hides unborn traces',()=>{
 const f=footprintField({count:3});const m=f.marks[1];assert.ok(f.height(m.x,m.z)<-.08);assert.ok(f.height(m.x+.115,m.z)>0);assert.equal(f.height(m.x,m.z,-100),0);assert.equal(f.height(100,100),0);
});
test('ported bevels, tiles, lattice and porous stones have finite vertices and seeded repeatability',()=>{
 for(const geometry of [bevelBox(1,2,3),curvedTile(),latticeFrame(3,4,{width:1,height:2})]){assert.ok(geometry.attributes.position.count>20);assert.ok([...geometry.attributes.position.array].every(Number.isFinite));geometry.dispose();}
 const a=blockStone(4,'chunk'),b=blockStone(4,'chunk');assert.deepEqual(a.pos,b.pos);assert.notDeepEqual(a.pos,blockStone(5,'chunk').pos);
 const stone=porousStone(4,{W:.6,H:1,holes:2,blobs:4,standing:true},8);assert.ok(stone.idx.length>100);assert.ok(stone.pos.every(Number.isFinite));
});
test('full-pipeline shot adapter preserves dissolve ends and reverse seek',()=>{
 const base={position:[[0,[0,1,3]]],target:[[0,[0,1,0]]],focal:[[0,24]],focus:[[0,3]],fstop:[[0,4]]};
 const t=createTimeline([{...base,id:'a',scene:'room',start:0,end:2},{...base,id:'b',scene:'river',start:2,end:4,dissolve:1}]);
 assert.deepEqual(t.resolve(2).map(l=>l.weight),[1,0]);assert.equal(t.resolve(3).length,1);const result=t.resolve(2.5);t.resolve(0);assert.deepEqual(t.resolve(2.5),result);assert.ok(Math.abs(result.reduce((s,l)=>s+l.weight,0)-1)<1e-8);
});
test('software renderer lowers realtime quality but preserves explicit offline final',()=>{
 const gl={RENDERER:1,getExtension:()=>null,getParameter:()=> 'Mesa llvmpipe'};
 assert.equal(resolveQuality('high',gl).name,'low');assert.equal(resolveQuality('final',gl).name,'high');assert.equal(resolveQuality('final',gl).pipeline,'final');assert.throws(()=>resolveQuality('invalid'));
});
test('render plans reject runaway ranges; resume rejects changed source/browser/settings before work',async t=>{
 assert.deepEqual(rangeFrames(0,8,3),[0,3,6]);for(const spec of ['0:2:0','2:1:1','0:2:-1','-1','NaN'])assert.throws(()=>parseTimes(spec));assert.throws(()=>finite(12,'workers',1,2));
 const dir=await mkdtemp(path.join(os.tmpdir(),'scene-port-'));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(path.join(dir,'out'));await writeFile(path.join(dir,'scene.js'),'export const x=1;');
 await assert.rejects(renderIdentity(dir,{channel:'chrome'}),/requires --chrome/);
 const id=await renderIdentity(dir,{width:100,gl:'test'});await writeFile(path.join(dir,'scene.js'),'export const x=2;');const changed=await renderIdentity(dir,{width:100,gl:'test'});assert.notEqual(id.sourceDigest,changed.sourceDigest);
 const out=path.join(dir,'out');const file=await checkResume(out,id,false);await writeFile(file,JSON.stringify(id));await writeFile(path.join(out,'f00000.png'),'test');await checkResume(out,id,true);await assert.rejects(checkResume(out,changed,true),/changed/);await assert.rejects(checkResume(out,id,false),/contains frames/);
});
test('project font collection includes nested captions, explicit glyphs and extra text',()=>{
 const text=collectCharacters([{title:'示例',lyrics:[{text:'声音',chars:[{c:'字'}]}]}],'补');for(const c of '示例声音字补09')assert.ok(text.includes(c));assert.ok(!text.includes('\n'));
});

test('project audio accepts arbitrary instrument keys and rejects missing data without substituting a mock',async()=>{
 const {normalizeSong,createAudio,loadSong}=await import('../../tracks/music-video/engine/audio.js');
 const song=normalizeSong({duration:5,notes:{customSynth:[{t:1,dur:.3,midi:65,vel:.8}]}});assert.deepEqual(Object.keys(song.notes),['customSynth']);assert.deepEqual(createAudio(song).instruments,['customSynth']);
 await assert.rejects(loadSong('data:application/json,not-json'));
});

test('encoding refuses regular missing frames unless a sparse stride is explicitly provided',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'scene-encode-gap-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const frame of [0,2,4])await writeFile(path.join(dir,`f${String(frame).padStart(5,'0')}.png`),'inventory-only test');
 const args=['tools/cinematic/encode.mjs','--frames',dir,'--dry-run'];
 await assert.rejects(run(process.execPath,args),/missing frame/);
 const sparse=await run(process.execPath,[...args,'--every','2']);assert.match(sparse.stderr,/@ 12 fps/);
 await assert.rejects(run(process.execPath,[...args,'--range','0.5:4']),/invalid encode range/);
});

test('engine and kit manifests identify the exact distributed modules',async()=>{
 for(const kind of ['engine','kits']){
  const root=new URL(`../../tracks/music-video/${kind}/`,import.meta.url),manifest=JSON.parse(await readFile(new URL('port-manifest.json',root)));
  const rows=Array.isArray(manifest)?manifest:manifest.modules;
  assert.equal(rows.length,kind==='engine'?15:18);
  for(const row of rows){const data=await readFile(new URL(row.module,root));assert.equal(data.length,row.portedBytes,row.module);assert.equal(createHash('sha256').update(data).digest('hex'),row.portedSHA256,row.module);assert.match(row.sourceSHA256,/^[a-f0-9]{64}$/);}
 }
});
