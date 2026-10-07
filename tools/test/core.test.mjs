import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp, writeFile, mkdir, rm, symlink, readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {localServer} from './helpers.mjs';
import {byteRange, mime, startServer} from '../serve.mjs';
import {cli, number, required, run, atomic} from '../lib/cli.mjs';
import {imageStats, intersects, lightness, luminance, sha256} from '../lib/images.mjs';
import {contactSheet} from '../contact-sheet.mjs';
import {qaFrames} from '../qa.mjs';
import {encode} from '../encode.mjs';
import {OneEuro} from '../pose/one-euro.mjs';
import {localFileset} from '../pose/local-loader.mjs';
import {matchEvents, evaluateEvents} from '../pose/metrics.mjs';
import {patchRuntime} from '../pose/patch-runtime.mjs';
import {installHarness} from '../pose/harness-template.mjs';
import {evaluateVideo} from '../pose/evaluate-video.mjs';

const temporary = async t => { const folder = await mkdtemp(path.join(os.tmpdir(), 'scene-test-')); t.after(() => rm(folder, {recursive: true, force: true})); return folder; };

test('CLI rejects unknown, missing and invalid numeric arguments; subprocess failure propagates', async t => {
  assert.throws(() => cli({}, '', ['--unknown']));
  assert.throws(() => required('', 'file'));
  for (const value of ['', undefined, NaN, -1, '1.5']) assert.throws(() => number(value, 'n', 0, 5, true));
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(7)']), /failed \(7\)/);
  const dir = await temporary(t);
  await atomic(path.join(dir, 'nested/file'), 'ok');
  assert.equal(await readFile(path.join(dir, 'nested/file'), 'utf8'), 'ok');
});

test('static server MIME, HEAD, range, empty files, traversal, hidden and escaping symlinks', async t => {
  const dir = await temporary(t), root = path.join(dir, 'site');
  await mkdir(root); await writeFile(path.join(root, 'index.html'), '<h1>scene</h1>');
  await writeFile(path.join(root, 'clip.mp3'), '0123456789'); await writeFile(path.join(root, 'empty'), '');
  await writeFile(path.join(dir, 'secret'), 'private'); await symlink(path.join(dir, 'secret'), path.join(root, 'escape'));
  await writeFile(path.join(root, '.env'), 'private');
  const server = await localServer(root); t.after(() => server.close());
  const get = (url, options) => fetch(server.url + url, options);
  assert.equal((await get('/')).status, 200);
  const range = await get('/clip.mp3', {headers: {range: 'bytes=2-5'}});
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await range.text(), '2345');
  assert.equal(await (await get('/clip.mp3', {headers: {range: 'bytes=-3'}})).text(), '789');
  assert.equal((await get('/clip.mp3', {headers: {range: 'bytes=99-'}})).status, 416);
  const head = await get('/clip.mp3', {method: 'HEAD'}); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
  assert.match(head.headers.get('cache-control'), /no-cache/);
  assert.equal((await get('/empty')).headers.get('content-length'), '0');
  for (const url of ['/escape', '/.env', '/%2e%2e%2fsecret']) assert.equal((await get(url)).status, 403);
  assert.equal((await get('/', {method: 'POST'})).status, 405);
  await assert.rejects(startServer({root, host: '192.0.2.1'}), /loopback/);
  for (const [file, expected] of [['x.mjs', 'text/javascript'], ['x.wasm', 'application/wasm'], ['x.wasm.bin', 'application/wasm'],
    ['x.task.bin', 'application/octet-stream'], ['x.json', 'application/json'], ['x.mp3', 'audio/mpeg'], ['x.woff2', 'font/woff2']]) assert.ok(mime(file).startsWith(expected));
  for (const header of ['bytes=-0', 'bytes=5-2', 'bytes=0-1,3-4', 'items=1-2', 'bytes=-']) assert.throws(() => byteRange(header, 10));
});

test('image measurements, labelled contact sheets and QA detect frozen/black/mismatched/missing frames', async t => {
  const dir = await temporary(t), frames = path.join(dir, 'frames'), compare = path.join(dir, 'compare');
  await mkdir(frames); await mkdir(compare);
  const black = await sharp({create: {width: 32, height: 24, channels: 3, background: '#000000'}}).png().toBuffer();
  const white = await sharp({create: {width: 32, height: 24, channels: 3, background: '#ffffff'}}).png().toBuffer();
  for (let i = 0; i < 3; i++) {
    const name = `frame-${String(i).padStart(6, '0')}.png`;
    await writeFile(path.join(frames, name), black); await writeFile(path.join(compare, name), i === 1 ? white : black);
  }
  assert.equal((await imageStats(black)).meanLstar, 0); assert.ok(Math.abs((await imageStats(white)).meanLstar - 100) < 1e-6);
  assert.equal(lightness(luminance(0, 0, 0)), 0);
  assert.equal(intersects({x: 0, y: 0, width: 10, height: 10}, {x: 10, y: 0, width: 10, height: 10}), false);
  const result = await qaFrames({frames, compare, fps: 1, freezeSeconds: 1});
  for (const type of ['black', 'freeze', 'banding-candidate', 'determinism']) assert.ok(result.issues.some(i => i.type === type));
  await contactSheet([path.join(frames, 'frame-000000.png')], path.join(dir, 'sheet.png'), {labels: ['<frame>&"'], width: 80, columns: 1});
  assert.equal((await sharp(path.join(dir, 'sheet.png')).metadata()).width, 80);
  await rm(path.join(frames, 'frame-000001.png'));
  assert.ok((await qaFrames({frames})).issues.some(i => i.type === 'missing-frame'));
  await assert.rejects(encode({frames, out: path.join(dir, 'never.mp4'), count: 3}), /Missing frame/);
});

test('One Euro filter smooths, follows faster motion, resets and rejects reversed clocks', () => {
  const filter = new OneEuro(); assert.equal(filter.filter(0, 0), 0);
  const a = filter.filter(1, .1); assert.ok(a > 0 && a < 1);
  assert.throws(() => filter.filter(2, .1), /increase/); filter.reset(); assert.equal(filter.filter(2, .1), 2);
  assert.throws(() => new OneEuro({minCutoff: 0}));
});

test('event metrics maximize one-to-one matches; duplicate events and wrong hands are not hidden', () => {
  assert.equal(matchEvents([{t: 0}, {t: .2}], [{t: .1}, {t: .3}], .11).length, 2);
  const m = evaluateEvents([{t: 1, hand: 'L', type: 'a'}, {t: 1.01, hand: 'L', type: 'a'}, {t: 2, hand: 'R'}],
    [{t: 1, hand: 'L', type: 'a'}, {t: 2, hand: 'L'}]);
  assert.equal(m.matched, 1); assert.equal(m.falsePositives, 2); assert.equal(m.handAccuracy, .5);
  assert.equal(evaluateEvents([], []).recall, null);
  assert.throws(() => matchEvents([{t: NaN}], []));
});

test('local fileset uses explicit .bin URLs; telemetry patches require exact hash and count', () => {
  const files = localFileset('https://example.com/version/vendor/');
  assert.equal(files.wasmBinaryPath, 'https://example.com/version/vendor/vision_wasm_internal.wasm.bin');
  const original = 'const telemetry = true;';
  const p = {expectedSha256: sha256(Buffer.from(original)), find: 'true', replace: 'false', count: 1};
  assert.equal(patchRuntime(original, p), 'const telemetry = false;');
  assert.throws(() => patchRuntime(original + ' ', p), /hash changed/);
  assert.throws(() => patchRuntime(original, {...p, count: 2}), /match count/);
});

test('pose harness preserves acquisition timestamp and invokes real detector boundary', async () => {
  globalThis.window = {};
  const received = [];
  installHarness({landmarker: {detectForVideo(bitmap, t) { received.push(t); return {landmarks: [[{x: .5}]]}; }},
    detectEvents(points, t) { return [{t, count: points.length}]; }});
  const result = await window.__poseEval.detect({}, 1200);
  assert.equal(result.events[0].t, 1.2); assert.deepEqual(received, [1200]);
  assert.equal(result.lost, false); delete globalThis.window;
});

test('optional licensed video missing is explicit SKIP, mandatory input is an error', async t => {
  const dir = await temporary(t);
  const args = {video: path.join(dir, 'absent'), url: 'http://127.0.0.1:39920', out: path.join(dir, 'eval')};
  assert.equal((await evaluateVideo({...args, allowMissing: true})).status, 'SKIP');
  await assert.rejects(evaluateVideo(args));
});
