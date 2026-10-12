import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {analyzeCamera, cameraRecord, decomposeCamera, CAM_DEFAULTS, collectFromPage, gimbalCheck, formatReport} from '../cam-check.mjs';
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

// A look-at rig over a target that slides past (nearly) beneath the camera: three.js lookAt keeps up = +Y, so when the
// view passes near the nadir the yaw swings through ~180° within a frame or two — the picture spins.
const lookAtFilm = (offsetZ, {seconds = 4, height = 10} = {}) => Array.from({length: fps * seconds}, (_, f) => {
  const t = f / fps, cam = new THREE.PerspectiveCamera(30, 2.388, 0.1, 1000);
  cam.position.set(0, height, 0); cam.lookAt(-6 + 12 * t / seconds, 0, offsetZ); cam.updateMatrixWorld();
  return {t, shot: 'over', e: [...cam.matrixWorld.elements], fov: cam.fov, aspect: cam.aspect};
});

test('gimbal: roll is decomposed from the matrix (0 for a level camera at any pitch) and round-trips through cameraRecord', () => {
  for (const pitch of [-1.4, -0.5, 0, 0.7, 1.45]) assert.ok(Math.abs(decomposeCamera(cameraRecord({t: 0, shot: 'x', yaw: 2, pitch})).roll) < 1e-12);
  const r = decomposeCamera(cameraRecord({t: 0, shot: 'x', yaw: -0.4, pitch: 0.3, roll: 0.25}));
  assert.ok(Math.abs(r.roll - 0.25) < 1e-12 && Math.abs(r.yaw + 0.4) < 1e-12 && Math.abs(r.pitch - 0.3) < 1e-12);
  const cam = new THREE.PerspectiveCamera(30, 2, 0.1, 100);
  cam.position.set(0, 5, 0); cam.lookAt(3, 0, -4); cam.updateMatrixWorld();
  assert.ok(Math.abs(decomposeCamera({t: 0, shot: 'x', e: cam.matrixWorld.elements, fov: 30, aspect: 2}).roll) < 1e-9, 'three.js lookAt is level');
});

// A steep move whose yaw flips by 111° between two frames at pitch −85.5° (an orbit/target slide crossing the pole).
const abruptFlip = () => Array.from({length: fps * 4}, (_, f) => cameraRecord({t: f / fps, shot: 'over', yaw: (0.2 * f + (f >= 48 ? 111 : 0)) * Math.PI / 180, pitch: -85.5 * Math.PI / 180, pos: [0, 30, 0]}));

test('gimbal: a single-frame yaw flip near the nadir FAILS with its frame reported, even when the jitter metric passes', () => {
  assert.deepEqual({deg: CAM_DEFAULTS.gimbalDeg, pitch: CAM_DEFAULTS.gimbalPitch}, {deg: 3, pitch: 80});
  const flip = analyzeCamera(abruptFlip(), {fps});
  assert.deepEqual(flip.segments.map(s => [s.segment, s.pass]), [['over', true], ['over#1', true]], 'the jump is split off as an in-shot cut, so jitter alone would PASS');
  assert.equal(flip.gimbal.pass, false);
  assert.equal(flip.pass, false, 'the gimbal event fails the whole report');
  assert.deepEqual(flip.gimbal.events.map(e => ({frame: e.frame, dYaw: Math.round(e.dYawDeg), pitch: e.pitchDeg})), [{frame: 48, dYaw: 111, pitch: -85.5}]);
  assert.match(formatReport(flip), /FAIL gimbal over\s+t=2\.000s \(frame 48\) Δyaw 111\.2° Δroll 0° at pitch -85\.5°/);
  assert.match(formatReport(flip), /FAIL gimbal · 1 orientation jumps/);
  // A look-at rig whose target slides almost beneath the camera swings its yaw through ~180° around the nadir.
  const look = analyzeCamera(lookAtFilm(0.35), {fps});
  const worst = look.gimbal.events.reduce((a, b) => (b.dYawDeg > a.dYawDeg ? b : a));
  assert.ok(worst.dYawDeg > 15 && worst.pitchDeg < -85 && Math.abs(worst.t - 2) < 0.2 && worst.frame === Math.round(worst.t * fps), JSON.stringify(worst));
  // The same move with the target well off the pole never exceeds 80° of pitch: no events.
  const off = analyzeCamera(lookAtFilm(4), {fps});
  assert.ok(off.gimbal.maxPitchDeg < 80 && off.gimbal.pass && off.gimbal.events.length === 0, JSON.stringify(off.gimbal));
});

test('gimbal: a slow steep pan passes; a roll jump or a yaw jump above the threshold while |pitch| > 80° fails; shot changes are ignored', () => {
  const steep = Array.from({length: 48}, (_, f) => cameraRecord({t: f / fps, shot: 'S', yaw: f * 0.5 * Math.PI / 180, pitch: -85 * Math.PI / 180}));
  assert.equal(gimbalCheck(steep.map(s => decomposeCamera(s)), {fps}).pass, true, '0.5°/frame at −85° is a slow pan');
  const roll = steep.map((s, f) => (f >= 20 ? cameraRecord({t: f / fps, shot: 'S', yaw: f * 0.5 * Math.PI / 180, pitch: -85 * Math.PI / 180, roll: 10 * Math.PI / 180}) : s));
  const g = gimbalCheck(roll.map(s => decomposeCamera(s)), {fps});
  assert.equal(g.events.length, 1);
  assert.deepEqual({frame: g.events[0].frame, dRoll: Math.round(g.events[0].dRollDeg), pitch: Math.round(g.events[0].pitchDeg)}, {frame: 20, dRoll: 10, pitch: -85});
  const yawJump = steep.map((s, f) => (f === 30 ? cameraRecord({t: f / fps, shot: 'S', yaw: (f * 0.5 + 4) * Math.PI / 180, pitch: 82 * Math.PI / 180}) : s));
  const y = gimbalCheck(yawJump.map(s => decomposeCamera(s)), {fps});
  assert.deepEqual(y.events.map(e => e.frame), [30, 31], 'jump in and jump back');
  assert.equal(gimbalCheck(yawJump.map(s => decomposeCamera(s)), {fps, gimbalDeg: 5}).pass, true, 'threshold is configurable');
  const level = Array.from({length: 48}, (_, f) => cameraRecord({t: f / fps, shot: 'L', yaw: f * 0.2, pitch: -0.3}));
  assert.equal(gimbalCheck(level.map(s => decomposeCamera(s)), {fps}).pass, true, 'fast yaw at a normal pitch is not a gimbal event');
  const cut = [...steep.slice(0, 10), ...steep.slice(10).map(s => ({...cameraRecord({t: s.t, shot: 'T', yaw: 2, pitch: -1.5})}))];
  assert.equal(gimbalCheck(cut.map(s => decomposeCamera(s)), {fps}).pass, true, 'a shot change is not a flip');
  const noRoll = steep.map(s => { const d = decomposeCamera(s); delete d.roll; return d; });
  assert.equal(gimbalCheck(noRoll, {fps}).pass, true, 'decomposed samples without roll are judged on yaw only');
});

test('cam-check CLI fails a nadir flip with exit 3 and honours --gimbal-pitch', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'cam-gimbal-'));
  try {
    await writeFile(path.join(d, 'flip.json'), JSON.stringify(abruptFlip()));
    const bad = await exec(process.execPath, [CLI, '--samples', path.join(d, 'flip.json'), '--fps', '24', '--out', path.join(d, 'r.json')]).then(() => null, e => e);
    assert.equal(bad?.code, 3);
    assert.match(bad.stdout, /FAIL gimbal over\s+t=\d+\.\d+s \(frame \d+\)/);
    const report = JSON.parse(await readFile(path.join(d, 'r.json'), 'utf8'));
    assert.equal(report.gimbal.pass, false); assert.equal(report.thresholds.gimbalDeg, 3);
    const relaxed = await exec(process.execPath, [CLI, '--samples', path.join(d, 'flip.json'), '--fps', '24', '--gimbal-pitch', '89.9']);
    assert.match(relaxed.stdout, /PASS gimbal/); assert.match(relaxed.stdout, /PASS cam-check/);
    const usage = await exec(process.execPath, [CLI, '--samples', path.join(d, 'flip.json'), '--gimbal-pitch', '95']).then(() => null, e => e);
    assert.equal(usage?.code, 2);
  } finally { await rm(d, {recursive: true, force: true}); }
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
