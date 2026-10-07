import test from 'node:test';
import assert from 'node:assert/strict';
import {hygiene} from '../hygiene.mjs';
import {readFile} from 'node:fs/promises';
test('repository hygiene: no generated content, private paths, media or changed vendored runtime',async()=>{
  const report=await hygiene();assert.deepEqual(report.issues,[]);assert.equal(report.vendorVerified,3);
});
test('music starter uses local 3D engine and a complete cinematic shot timeline',async()=>{
  const main=await readFile(new URL('../../templates/starters/music-video/src/main.js',import.meta.url),'utf8');
  assert.ok(main.includes('createEngine'));assert.ok(!main.includes("getContext('2d')"));
  const shots=JSON.parse(await readFile(new URL('../../tracks/music-video/sample/shots.json',import.meta.url),'utf8'));
  assert.equal(shots[0].end,30);assert.equal(shots.at(-1).end,60);assert.ok(shots.some(s=>s.focus.length>2));
});
