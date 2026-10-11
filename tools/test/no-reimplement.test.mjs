import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, mkdir, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {scanSource, scanPaths, RULES} from '../no-reimplement.mjs';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../no-reimplement.mjs', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const rules = text => scanSource(text, 'sets/example.js').map(f => `${f.line}:${f.rule}`);

// Synthetic scene code (no real work): the failure pattern is a hand-made 1/f shake added to the camera in update().
const SHAKE = `import {pink1} from '../engine/noise.js';
export function create(ctx) {
  const camera = ctx.camera;
  return {update(t) {
    camera.position.set(0, 1.6, 8); camera.lookAt(0, 1, 0);
    camera.rotateY((pink1(t * 0.6, 7) - 0.5) * 0.05);
    const wob = Math.sin(t * 11.3) * 0.004;
    camera.rotateX(wob);
    ctx.camera.position.x += 0.02 * Math.cos(t * 9.1);
  }};
}`;

test('self-made camera shake is reported at file:line (direct noise, tainted variable, sin-driven translation)', () => {
  assert.deepEqual(rules(SHAKE), ['6:camera-shake', '8:camera-shake', '9:camera-shake']);
});

test('engine-native camera use is clean: preset handheld within range, evalCam keys, lookAt from a smooth path', () => {
  const ok = `import {evalCam} from '../engine/camera.js';
export const presets = {wide: {keys: [{t: 0, pos: [0, 1.6, 8], target: [0, 1, 0], fov: 30}, {t: 1, pos: [1, 1.6, 7], target: [0, 1, 0], fov: 30}], handheld: 0.3}};
export function cameraAt(t, shot) { const s = evalCam(presets.wide, t, 10, 2.39); return {...s, handheld: 0.25}; }
export function update(t, w, camera) { camera.position.set(t * 0.2, 1.6, 8); camera.lookAt(0, 1, 0); }`;
  assert.deepEqual(rules(ok), []);
  assert.deepEqual(rules("export const presets = {shaky: {handheld: 3.5}};\nconst h = handheld(t, 2.0, 'x');"), ['1:handheld-amount', '2:handheld-amount']);
});

test('GLSL fract(sin()) hashes, self-made fog/sky and hard-coded credits are reported; the credits file is exempt', () => {
  const glsl = "const fs = `float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}`;\nconst ok = GLSL_HASH + 'float n = hash21(p);';";
  assert.deepEqual(rules(glsl), ['1:glsl-sin-hash']);
  const fog = "scene.fog = new THREE.FogExp2(0x101820, 0.01);\nfloat fogFactor = 1.0 - exp(-uDensity * d);\nconst skyMat = new THREE.ShaderMaterial({uniforms});\nconst dome = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), mat); // side: THREE.BackSide";
  assert.deepEqual(rules(fog), ['1:custom-fog', '2:custom-fog', '3:custom-sky']);
  assert.deepEqual(rules("const dome = new THREE.Mesh(new THREE.SphereGeometry(900), new THREE.MeshBasicMaterial({side: THREE.BackSide}));"), ['1:custom-sky']);
  const credit = "const card = {text: '作词：某人 / 作曲：某人'};\nconst end = 'Directed by: Someone';";
  assert.deepEqual(rules(credit), ['1:hardcoded-credit', '2:hardcoded-credit']);
  assert.deepEqual(scanSource(credit, 'src/credits.js'), []);
});

test('allowlist comment needs a known rule and a reason; without a reason it is itself a finding', () => {
  const allowed = "// no-reimplement-allow camera-shake: turntable lab orbit, not a film shot\ncamera.position.set(Math.cos(a) * 5, 1.2, Math.sin(a) * 5);";
  assert.deepEqual(rules(allowed), []);
  const sameLine = "scene.fog = new THREE.FogExp2(0x101820, 0.01); // no-reimplement-allow custom-fog: lab bench without the engine atmosphere";
  assert.deepEqual(rules(sameLine), []);
  assert.deepEqual(rules("// no-reimplement-allow camera-shake\ncamera.rotateY(Math.sin(t) * 0.01);"), ['1:allow-without-reason', '2:camera-shake']);
  assert.deepEqual(rules("// no-reimplement-allow made-up-rule: some long reason here\nconst x = 1;"), ['1:allow-without-reason']);
  assert.ok(Object.keys(RULES).length >= 6);
});

test('the music-video starter source passes; CLI prints file:line and exits 1 on findings', async () => {
  assert.equal((await scanPaths([path.join(repo, 'templates/starters/music-video/src')])).pass, true);
  const d = await mkdtemp(path.join(os.tmpdir(), 'no-reimplement-'));
  try {
    await mkdir(path.join(d, 'sets')); await writeFile(path.join(d, 'sets/shaky.js'), SHAKE); await writeFile(path.join(d, 'sets/notes.md'), 'camera.rotateY(Math.sin(t))');
    const err = await exec(process.execPath, [CLI, d]).then(() => null, e => e);
    assert.equal(err?.code, 1);
    assert.match(err.stdout, /sets\/shaky\.js:6 camera-shake/);
    assert.match(err.stdout, /FAIL no-reimplement · 1 files · 3 findings/);
    await writeFile(path.join(d, 'sets/shaky.js'), 'export const ok = 1;\n');
    assert.match((await exec(process.execPath, [CLI, d])).stdout, /PASS no-reimplement/);
  } finally { await rm(d, {recursive: true, force: true}); }
});
