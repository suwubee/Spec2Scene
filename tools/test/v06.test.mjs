import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as THREE from '../../tracks/music-video/engine/vendor/three.module.js';
import {defaultEnvironment} from '../../tracks/music-video/engine/world/environment.js';
import {bakeSurface, phaseLight} from '../../tracks/music-video/kits/celestial-phase/surface.js';
import {createTerrainLibrary} from '../../tracks/music-video/engine/terrain.js';
import {progressTracker, resumeCommand, inventory, watchRender} from '../render-resume-guard.mjs';
import {validateV06} from './v06-browser.mjs';

test('celestial phase surface is deterministic, seamless and parameterized', () => {
  const a = bakeSurface({seed: 19, resolution: 64, craters: 8});
  const b = bakeSurface({seed: 19, resolution: 64, craters: 8});
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.data, bakeSurface({seed: 20, resolution: 64, craters: 8}).data);
  assert.equal(a.data.length, 64 * 32 * 4);
  assert.deepEqual(phaseLight(0), [0, 0, -1]);
  assert.ok(Math.abs(Math.hypot(...phaseLight(.37)) - 1) < 1e-12);
  assert.throws(() => bakeSurface({resolution: 63}), /Invalid/);
});

test('slope and atmosphere options isolate unrelated layouts and light instances', () => {
  const plain = createTerrainLibrary(), explicit = createTerrainLibrary({banks: {}, layout: {}});
  for (const [x, z] of [[-20, 0], [80, -400], [390, 700]]) assert.equal(plain.heightAt(x, z), explicit.heightAt(x, z));
  const base = plain.createAtmosphere({THREE}), custom = plain.createAtmosphere({THREE}, {skylineAt: () => 80, waterMist: false, moonColor: [1, .5, .25]});
  const w = {...defaultEnvironment.at(1), moonElev: 4, sunElev: 5};
  const camera = new THREE.PerspectiveCamera();
  base.update(1, w, camera); custom.update(1, w, camera);
  assert.equal(custom.state.moonVis, 0); assert.equal(custom.state.sunVis, 0);
  assert.equal(custom.uniforms.vWaterMistEnabled.value, 0); assert.equal(base.uniforms.vWaterMistEnabled.value, 1);
  assert.equal(custom.uniforms.vMoonCol.value.x / custom.uniforms.vMoonCol.value.y, 2);
  assert.ok(base.uniforms.vMoonCol.value.z > base.uniforms.vMoonCol.value.x);
  base.dispose(); custom.dispose();
});

test('resume guard reports only complete frames and halves workers without signalling', () => {
  assert.equal(resumeCommand(['node', 'render.mjs', '--workers', '4', '--out', 'frames']), "'node' 'render.mjs' '--out' 'frames' '--resume' '--workers' '2'");
  const track = progressTracker({minutes: 3, now: 1000});
  const first = new Map([['frame-000001.png', '1']]);
  assert.equal(track(first, 1000).stalled, false);
  assert.equal(track(new Map(first), 181001).stalled, true);
  assert.equal(track(new Map([['frame-000001.png', '2']]), 181002).stalled, false);
  assert.equal(track(new Map([['frame-000001.png', '2']]), 361003).stalled, true);
});

test('guard ignores logs, partial files, empty files and symlinks; alarm retains safe command', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scene-guard-')); t.after(() => rm(dir, {recursive: true, force: true}));
  for (const [name, content] of [['f00000.png', 'frame'], ['frame-000001.jpg', 'frame'], ['f00002.png.tmp', 'partial'], ['f00003.png', ''], ['progress.log', 'progress']]) await writeFile(path.join(dir, name), content);
  await symlink(path.join(dir, 'f00000.png'), path.join(dir, 'f00004.png'));
  assert.equal((await inventory(dir)).size, 2);
  const rows = []; assert.equal(await watchRender({frames: dir, command: ['node', 'render.mjs', '--out', "$(false)' dir"], minutes: .001, pollSeconds: .02, report: row => rows.push(JSON.parse(row))}), 2);
  assert.equal(rows[0].status, 'STALLED'); assert.match(rows[0].resume, /--resume/);
  assert.throws(() => resumeCommand(['node', '--workers', 'NaN']));
});

test('v06 browser controls, download, procedural phase and unchanged legacy terrain', {timeout: 300000, skip: !process.env.SCENE_V06_BROWSER}, async () => {
  const base = process.env.SCENE_EVIDENCE_DIR || os.tmpdir(); await mkdir(base, {recursive: true});
  const out = await mkdtemp(path.join(base, 'scene-v06-')); console.log(`V06 evidence retained: ${out}`);
  await validateV06(out);
});
