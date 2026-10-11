import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {analyzeCamera, cameraRecord, decomposeCamera, CAM_DEFAULTS, collectFromPage} from '../cam-check.mjs';
import {handheld} from '../../tracks/music-video/engine/camera.js';
import * as THREE from '../../tracks/music-video/engine/vendor/three.module.js';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../cam-check.mjs', import.meta.url));
const fps = 24;
const pan = t => ({yaw: 0.02 * t, pitch: 0.01 * Math.sin(0.2 * t), pos: [0.3 * t, 1.6, 0]});
const film = (fn, seconds = 20) => Array.from({length: fps * seconds}, (_, f) => { const t = f / fps; return cameraRecord({t, shot: t < seconds / 2 ? 'A' : 'B', fov: 30, aspect: 2.388, ...fn(t)}); });
const withShake = (scale, amount) => t => { const p = pan(t), h = handheld(t, amount, 'shot'); return {...p, yaw: p.yaw + scale * h.yaw, pitch: p.pitch + scale * h.pitch}; };

test('default thresholds match the picture gate: p95 ≤ 1.5 px, rms ≤ 1.5 px, peak ≤ 4 px at 1920 width', () => {
  assert.deepEqual({refWidth: CAM_DEFAULTS.refWidth, hfP95: CAM_DEFAULTS.hfP95, rms: CAM_DEFAULTS.rms, peak: CAM_DEFAULTS.peak, win: CAM_DEFAULTS.win}, {refWidth: 1920, hfP95: 1.5, rms: 1.5, peak: 4, win: 0.5});
});

test('engine handheld at its working amount passes over a smooth pan; a self-made shake 30× the calibration fails', () => {
  const smooth = analyzeCamera(film(pan), {fps});
  assert.equal(smooth.pass, true);
  for (const s of smooth.segments) assert.ok(s.rmsPx < 0.05, 'a smooth pan/dolly is not jitter');
  const engine = analyzeCamera(film(withShake(1, 0.35)), {fps});
  assert.equal(engine.pass, true, JSON.stringify(engine.segments));
  const self = analyzeCamera(film(withShake(30, 0.35)), {fps});
  assert.equal(self.pass, false);
  for (const s of self.segments) assert.ok(s.peakPx > 4 && s.rmsPx > 1.5, JSON.stringify(s));
  assert.deepEqual(self.segments.map(s => s.segment), ['A', 'B']);
});

test('in-shot hard cuts split segments and are not jitter; residuals only count full windows', () => {
  const cut = analyzeCamera(film(t => ({yaw: t < 5 ? 0.01 * t : 1.2 + 0.01 * t, pitch: 0, pos: t < 5 ? [0, 1, 0] : [4, 1, 0]})), {fps});
  assert.deepEqual(cut.segments.map(s => s.segment), ['A', 'A#1', 'B']);
  assert.equal(cut.pass, true);
  const short = analyzeCamera(film(pan, 0.25).map(s => ({...s, shot: 'S'})), {fps});
  assert.equal(short.segments[0].scored, 0, 'a segment shorter than one window is reported but not judged');
  assert.throws(() => analyzeCamera([]), /no camera samples/);
  assert.throws(() => analyzeCamera([cameraRecord({t: 1, shot: 'a'}), cameraRecord({t: 1, shot: 'a'})]), /increasing time/);
});

test('matrix convention matches three.js: forward is −Z of matrixWorld, yaw/pitch and pixels per radian at the reference width', () => {
  const cam = new THREE.PerspectiveCamera(30, 2, 0.1, 100);
  cam.position.set(1, 2, 3); cam.lookAt(2, 2, 2); cam.updateMatrixWorld();
  const d = decomposeCamera({t: 0, shot: 'x', e: cam.matrixWorld.elements, fov: cam.fov, aspect: cam.aspect});
  assert.ok(Math.abs(d.yaw - Math.PI / 4) < 1e-9 && Math.abs(d.pitch) < 1e-9);
  assert.deepEqual(d.pos, [1, 2, 3]);
  const hfov = 2 * Math.atan(Math.tan(15 * Math.PI / 180) * 2);
  assert.ok(Math.abs(d.pxPerRad - 1920 / hfov) < 1e-6);
  const r = cameraRecord({t: 0, shot: 'x', yaw: 0.3, pitch: -0.1, pos: [4, 5, 6]}), back = decomposeCamera(r);
  assert.ok(Math.abs(back.yaw - 0.3) < 1e-12 && Math.abs(back.pitch + 0.1) < 1e-12);
});

test('cam-check CLI reads recorded samples, writes the report and exits 3 on threshold failure', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'cam-check-'));
  try {
    await writeFile(path.join(d, 'ok.json'), JSON.stringify(film(withShake(1, 0.3), 6)));
    await writeFile(path.join(d, 'bad.json'), JSON.stringify(film(withShake(30, 0.3), 6)));
    const ok = await exec(process.execPath, [CLI, '--samples', path.join(d, 'ok.json'), '--out', path.join(d, 'ok-report.json')]);
    assert.match(ok.stdout, /PASS cam-check · 2 segments/);
    assert.equal(JSON.parse(await readFile(path.join(d, 'ok-report.json'), 'utf8')).thresholds.hfP95Px, 1.5);
    const bad = await exec(process.execPath, [CLI, '--samples', path.join(d, 'bad.json')]).then(() => null, e => e);
    assert.equal(bad?.code, 3); assert.match(bad.stdout, /FAIL A /);
    const strict = await exec(process.execPath, [CLI, '--samples', path.join(d, 'ok.json'), '--peak', '0.01']).then(() => null, e => e);
    assert.equal(strict?.code, 3);
    const usage = await exec(process.execPath, [CLI, '--samples', path.join(d, 'ok.json'), '--url', 'http://127.0.0.1:39920/']).then(() => null, e => e);
    assert.equal(usage?.code, 2);
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('engine core records the final camera after Set update, lens breathing and handheld, before the scene render', async () => {
  const core = await readFile(new URL('../../tracks/music-video/engine/core.js', import.meta.url), 'utf8');
  const hh = core.indexOf('cam.translateX(h.dx)'), rec = core.indexOf('lastCamera = { e: cam.matrixWorld.elements.slice()'), render = core.indexOf('renderer.render(inst.scene, cam)');
  assert.ok(hh > 0 && rec > hh && render > rec, 'lastCamera must be taken after handheld and before rendering');
  assert.match(core, /lastCamera: \(\) =>/);
  await assert.rejects(collectFromPage({url: 'http://example.com:39920/'}), /loopback/);
});

test('generated project exposes window.__scene.lastCamera() and the browser path analyses it', {timeout: 600000, skip: !process.env.SCENE_CAMCHECK_BROWSER && 'set SCENE_CAMCHECK_BROWSER=1 (software WebGL browser run)'}, async () => {
  const {playbackFixture} = await import('./playback-browser.mjs');
  const {localServer} = await import('./helpers.mjs');
  const fixture = await playbackFixture(); let server;
  try {
    server = await localServer(fixture.project);
    const {samples, fps: rate} = await collectFromPage({url: server.url, start: 0, end: 2, every: 6});
    assert.ok(samples.length >= 8);
    for (const s of samples) { assert.equal(s.e.length, 16); assert.ok(s.fov > 0 && s.aspect > 0 && typeof s.shot === 'string'); }
    const report = analyzeCamera(samples, {fps: rate});
    assert.ok(report.segments.length >= 1);
  } finally { await server?.close(); await fixture.close(); }
});
