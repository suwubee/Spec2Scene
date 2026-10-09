import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp, mkdir} from 'node:fs/promises';
import {createAudioTransport} from '../../tracks/music-video/realtime/audio.js';
import {createCutSafe, hardCuts, remapShotClock, warmupTimes} from '../../tracks/music-video/realtime/timing.js';
import {frameDifference, scoreSequence, sampleTimes, cutOffsets} from '../flicker-check.mjs';
import {validateGeneratedRealtime} from './realtime-browser.mjs';

class Media extends EventTarget {
  currentTime = 0; readyState = 0; muted = false; calls = []; src = '';
  play() { this.calls.push('play'); return this.reject ? Promise.reject(Object.assign(new Error(), {name: this.reject})) : Promise.resolve(); }
  pause() { this.calls.push('pause'); }
  load() { this.calls.push(`load:${this.src}`); }
  emit(name) { this.dispatchEvent(new Event(name)); }
}
test('media waits indefinitely, changes sources only on error, aligns late playing, retries and pauses pending requests', async () => {
  const media = new Media(); let now = 0;
  const audio = createAudioTransport({media, sources: ['one', 'two'], duration: 100, now: () => now});
  audio.unlock(); assert.deepEqual(media.calls.slice(-2), ['play', 'pause']); audio.start();
  now = 25; assert.equal(audio.time(), 25); assert.equal(media.src, 'one'); assert.equal(audio.state.sound, 'loading');
  media.readyState = 1; media.emit('loadedmetadata'); assert.equal(media.currentTime, 25);
  now = 28; media.emit('playing'); assert.equal(media.currentTime, 28); assert.equal(audio.state.clock, 'audio');
  media.currentTime = 29; media.emit('error'); assert.equal(media.src, 'two'); assert.equal(audio.time(), 29);
  media.emit('error'); assert.equal(audio.state.sound, 'failed');
  audio.retry(); assert.equal(media.src, 'one'); assert.equal(audio.state.sound, 'loading');
  audio.pause(); now = 50; assert.equal(audio.time(), 29); media.emit('playing'); assert.equal(audio.state.clock, 'wall');
  audio.seek(7); assert.equal(audio.time(), 7); audio.start(); await Promise.resolve(); media.emit('playing');
  media.currentTime = 8; audio.pause(); assert.equal(audio.time(), 8);
  audio.setDuration(120); audio.seek(110); assert.equal(audio.time(), 110); assert.throws(() => audio.setDuration(NaN)); audio.dispose();
  const missing = createAudioTransport({media: new Media(), sources: [], duration: 60});
  missing.start(); missing.retry(); assert.equal(missing.state.sound, 'failed'); missing.dispose();
});
test('autoplay rejection is visible, never chooses a different source, and a trusted retry recovers', async () => {
  const media = new Media(); media.readyState = 2; media.reject = 'NotAllowedError';
  const audio = createAudioTransport({media, sources: ['one', 'two'], duration: 60, now: () => 0});
  audio.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(audio.state.sound, 'blocked'); assert.equal(media.src, 'one');
  media.reject = null; audio.retry(); media.emit('playing'); assert.equal(audio.state.sound, 'playing'); audio.dispose();
});
test('hard-cut guard preserves side and is idempotent; warmup includes dissolve interior', () => {
  const shots = [{start: 0, end: 3}, {start: 3, end: 5, dissolve: .5}, {start: 5, end: 10}];
  assert.deepEqual(hardCuts(shots), [5]); const safe = createCutSafe([5], {duration: 10});
  for (const dt of cutOffsets) { const t = 5 + dt, s = safe(t); assert.equal(s < 5, t < 5); assert.ok(Math.abs(s - t) <= safe.guard); assert.equal(safe(s), s); }
  assert.ok(safe(5) > 5); assert.equal(safe(4), 4); assert.throws(() => safe(NaN));
  assert.throws(() => createCutSafe([5, 5.001])); assert.ok(warmupTimes(shots).includes(3.25));
});
test('remapped frame centres use the real frame number, exact inverse and frozen-world policy', () => {
  for (const [from, to] of [[10, 40], [40, 10], [10, 10]]) {
    const options = {t: 5.01, frame: 121, fps: 24, start: 5, end: 8, from, to, world: {at: t => t}};
    const mapped = remapShotClock(options);
    assert.ok(Math.abs(mapped.world.at(mapped.t) - options.t) < 1e-10);
    assert.ok(Math.abs(mapped.frameT - (from + (121 / 24 - 5) / 3 * (to - from))) < 1e-10);
    if (from !== to) assert.ok(Math.abs(mapped.world.at(mapped.frameT) - 121 / 24) < 1e-10);
    else assert.equal(mapped.world.at(mapped.frameT), 5.01);
  }
});
test('flicker detector separates global spikes, persistent steps, local flashes and smooth motion', () => {
  const frame = value => Buffer.alloc(64 * 36 * 3, value);
  const score = values => scoreSequence(values.map((v, t) => ({t, pixels: typeof v === 'number' ? frame(v) : v})));
  assert.ok(score([0, 0, 255, 0, 0])[2].flags.includes('spike'));
  assert.deepEqual(score([0, 0, 255, 255, 255])[2].flags, ['step']);
  assert.ok(score([0, 5, 10, 15, 20]).every(r => !r.flags.length));
  const local = frame(0); for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) local.fill(255, (y * 64 + x) * 3, (y * 64 + x) * 3 + 3);
  const row = score([0, 0, local, 0, 0])[2]; assert.deepEqual(row.flags, ['local-spike']); assert.deepEqual(row.localBlocks, [[0, 0]]);
  assert.equal(frameDifference(frame(0), frame(255)).mean, 255); assert.throws(() => frameDifference([], []));
  assert.equal(sampleTimes(0, 1, 24).length, 25); assert.equal(sampleTimes(0, 1, 60).length, 61);
});
test('resident starter: strict activation, 5s/25s audio delay, retry, sync, controls and flicker routes', {timeout: 900000}, async () => {
  const base = process.env.SCENE_EVIDENCE_DIR || os.tmpdir(); await mkdir(base, {recursive: true});
  const out = await mkdtemp(path.join(base, 'scene-resident-')); console.log(`Resident evidence retained: ${out}`);
  await validateGeneratedRealtime(out);
});
