// picture-qa region scope (--mask/--exclude/--erode), ⑧ surface paired bounds, ⑨ silhouette and the pure helpers in
// tools/picture-qa/region.mjs. Synthetic fixtures only (no film frames, no image files in the repo).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateConfig, compareConfigs, analyzeImage, shotOpts} from '../picture-qa/picture-qa.mjs';
import {parseMaskDefs, regionMask, erodeMask, validateBounds, pairedBounds, mergeBounds, widenedBounds, bimodality, starfield, edgeSoftness,
  patchSizeSpread, cavityCorrelation, facetFraction, highpassStd, findPatches, widthProfile, facingAngle} from '../picture-qa/region.mjs';
import {renderScene, renderSilhouette} from '../picture-qa/synth.mjs';
import {imageToPNG, encodePNG} from '../picture-qa/png.mjs';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../picture-qa/picture-qa.mjs', import.meta.url));
const run = async (args) => { try { const r = await exec(process.execPath, [CLI, ...args]); return {code: 0, out: r.stdout + r.stderr}; } catch (e) { return {code: e.code, out: (e.stdout || '') + (e.stderr || '')}; } };
const count = (m) => m.reduce((a, b) => a + b, 0);
const hash = (x, y, s) => { let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(s, 0x9e3779b1)) >>> 0; h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0; return ((h ^ (h >>> 13)) >>> 0) / 4294967296; };
const field = (w, h, f) => { const Y = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Y[y * w + x] = f(x, y); return Y; };

test('facingAngle: angle between heading and the figure→camera vector; 180° = back to camera', () => {
  assert.equal(facingAngle([0, 0, 1], [0, 0, 0], [0, 1.6, -6]), 180);     // walking away from a camera behind her
  assert.equal(facingAngle([0, 0, 1], [0, 0, 0], [0, 1.6, 6]), 0);        // walking towards the camera
  assert.equal(Math.round(facingAngle([1, 0], [0, 0], [0, 5])), 90);     // profile
  assert.ok(facingAngle([0.5, 0, 1], [2, 0, 3], [1.5, 1.7, -4]) >= 120);   // over-the-shoulder back view
  // The inverted definition (camera→figure vector) would call the back view 0°: the helper must not.
  const back = facingAngle([0, 0, 1], [0, 0, 0], [0, 0, -6]);
  assert.ok(back > 170);
  assert.throws(() => facingAngle(0.3, [0, 0, 0], [0, 0, 5]), /direction vector, not a yaw/);
  assert.throws(() => facingAngle([0, 1, 0], [0, 0, 0], [0, 0, 5]), /zero length/);
  assert.throws(() => facingAngle([0, 0, 1], [1, 0, 1], [1, 5, 1]), /undefined/);
});

test('paired bounds: one-sided perceptual bounds need a stated reason; evaluation reports the failing side', () => {
  assert.deepEqual(validateBounds({bounds: {ratio: [1.2, 2.0], midFrac: [0.4, 1]}}), []);
  assert.match(validateBounds({bounds: {ratio: [null, 2.0]}}).join('\n'), /one-sided bound needs oneSided\.ratio/);
  assert.deepEqual(validateBounds({bounds: {ratio: [null, 2.0]}, oneSided: {ratio: 'lower side is the physical noise floor'}}), []);
  assert.match(validateBounds({bounds: {sharpness: [0, 1]}}).join('\n'), /unknown metric/);
  assert.match(validateBounds({bounds: {ratio: [3, 2]}}).join('\n'), /lo 3 > hi 2/);
  assert.match(validateBounds({bounds: {ratio: [null, null]}}).join('\n'), /both sides null/);
  const ev = pairedBounds({ratio: 2.6, midFrac: 0.1, hpStd: 0.01, softPx: null}, {ratio: [1.2, 2.0], midFrac: [0.4, 1], hpStd: [0.002, 0.02], softPx: [3, 40]});
  assert.equal(ev.pass, false);
  assert.deepEqual(ev.rows.map((r) => [r.metric, r.side]), [['ratio', 'high'], ['midFrac', 'low'], ['hpStd', null], ['softPx', 'unmeasured']]);
  assert.deepEqual(mergeBounds({bounds: {ratio: [1, 2], p50: [0.07, 0.16]}}, {bounds: {ratio: [1.1, 1.9]}}).bounds, {ratio: [1.1, 1.9], p50: [0.07, 0.16]});
  assert.deepEqual(widenedBounds({bounds: {ratio: [1.1, 1.9], p50: [0.07, 0.16]}}, {bounds: {ratio: [1.0, 1.9]}}).map((x) => [x.metric, x.note]), [['ratio', 'bound widened'], ['p50', 'bound removed']]);
});

test('shot config: surface bounds validate, merge per metric and widening raises a --baseline alert', () => {
  assert.throws(() => validateConfig({defaults: {surface: {bounds: {hpStd: [null, 0.02]}}}}), /one-sided bound/);
  const base = validateConfig({defaults: {surface: {bounds: {ratio: [1.2, 2.0], hpStd: [0.002, 0.02]}}}, shots: [{name: 'A', t: [0, 4], surface: {bounds: {p50: [0.07, 0.16]}}}]});
  const o = shotOpts('t1.png', base, {});
  assert.deepEqual(o.surface.bounds, {ratio: [1.2, 2.0], hpStd: [0.002, 0.02], p50: [0.07, 0.16]});
  const next = validateConfig({defaults: {surface: {bounds: {ratio: [1.2, 2.6], hpStd: [0.002, 0.02]}}}, shots: [{name: 'A', t: [0, 4], surface: {bounds: {p50: [0.07, 0.16]}}}]});
  const alerts = compareConfigs(base, next);
  assert.deepEqual(alerts.map((a) => a.field), ['surface.ratio']);
  assert.deepEqual(compareConfigs(base, base), []);
});

test('region masks: union, exclusion and erosion in analysis tiles; bad definitions are errors', () => {
  const defs = parseMaskDefs({sand: [0, 0.5, 1, 1], pool: [[0.4, 0.6, 0.6, 0.8]], _why: 'pool is the neighbouring water component'});
  assert.deepEqual(Object.keys(defs), ['sand', 'pool']);
  const w = 960, h = 400, all = regionMask(defs, ['sand'], {w, h});
  assert.equal(count(all), 960 * 200);
  const ex = regionMask(defs, ['sand'], {w, h, exclude: ['pool']});
  assert.equal(count(ex), 960 * 200 - 192 * 80);
  const er = regionMask(defs, ['sand'], {w, h, erode: 2});              // 2 tiles = 32 px at 960 wide, frame edges count as outside
  assert.equal(count(er), (960 - 64) * (200 - 64));
  const er1920 = regionMask(defs, ['sand'], {w: 1920, h: 800, erode: 2});  // scales with the measured width
  assert.equal(count(er1920), (1920 - 128) * (400 - 128));
  assert.throws(() => regionMask(defs, ['rock'], {w, h}), /unknown mask "rock"/);
  assert.throws(() => regionMask(defs, ['pool'], {w, h, erode: 20}), /is empty/);
  assert.throws(() => parseMaskDefs({sand: [0, 0.5, 1.2, 1]}), /normalised/);
  assert.equal(count(erodeMask(Uint8Array.from([1, 1, 1, 1, 1]), 5, 1, 0)), 5);
});

test('distribution and morphology helpers separate the failure shapes they were written for', () => {
  const w = 300, h = 200;
  const smooth = field(w, h, (x, y) => 0.12 + 0.02 * Math.sin(x * 0.05) + 0.02 * Math.cos(y * 0.07) + 0.004 * (hash(x, y, 1) - 0.5));
  const zebra = field(w, h, (x) => ((x >> 3) & 1 ? 0.22 : 0.06));
  assert.ok(bimodality(smooth).midFrac > 0.4); assert.ok(bimodality(zebra).midFrac < 0.05); assert.ok(bimodality(zebra).bc > 0.555);
  assert.ok(highpassStd(smooth, w, h) < 0.004); assert.ok(highpassStd(field(w, h, (x, y) => 0.1 + 0.1 * hash(x, y, 2)), w, h) > 0.02);
  const stars = Float32Array.from(smooth); for (let k = 0; k < 120; k++) stars[(4 + Math.floor(hash(k, 1, 3) * (h - 8))) * w + 4 + Math.floor(hash(k, 2, 3) * (w - 8))] += 0.3;
  assert.equal(starfield(smooth, w, h).count, 0); assert.ok(starfield(stars, w, h).count >= 110);
  assert.equal(starfield(zebra, w, h).count, 0, 'band corners are not isolated points');
  const discs = (soft, vary) => { const Y = Float32Array.from(smooth); for (let k = 0; k < 24; k++) { const cx = 25 + (k % 6) * 50 + (hash(k, 3, 5) - 0.5) * 10, cy = 25 + Math.floor(k / 6) * 50 + (hash(k, 4, 5) - 0.5) * 10, r = vary ? 3 + hash(k, 6, 5) * 14 : 7; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const d = Math.hypot(x - cx, y - cy), a = soft ? Math.min(1, Math.max(0, (r + soft / 2 - d) / soft)) : d <= r ? 1 : 0; Y[y * w + x] += 0.08 * a; } } return Y; };
  const hard = discs(0, false), soft = discs(6, true);
  const pHard = findPatches(hard, w, h, null, {radius: 16}), pSoft = findPatches(soft, w, h, null, {radius: 16});
  assert.ok(edgeSoftness(hard, w, h, pHard).medianPx < 1.5); assert.ok(edgeSoftness(soft, w, h, pSoft).medianPx > 3);
  assert.ok(patchSizeSpread(pHard, w, h).cv < 0.4); assert.ok(patchSizeSpread(pSoft, w, h).cv > 0.5);
  const cavity = field(w, h, (x) => x / w);                               // deepest on the right
  const right = new Uint8Array(w * h), left = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < 30; x++) { right[y * w + w - 1 - x] = 1; left[y * w + x] = 1; }
  assert.equal(cavityCorrelation(right, cavity).share, 1); assert.equal(cavityCorrelation(left, cavity).share, 0);
  const facets = field(w, h, (x, y) => 0.08 + 0.15 * hash(Math.floor((x + 0.6 * y) / 40), Math.floor((x - 0.8 * y + 400) / 50), 3));
  assert.ok(facetFraction(facets, w, h).share > 0.02); assert.equal(facetFraction(smooth, w, h).share, 0); assert.equal(facetFraction(field(w, h, (x, y) => 0.1 + 0.1 * hash(x, y, 4)), w, h).share, 0);
});

test('silhouette width profile: tent and missing waist/limb fail, a body with shoulders, waist and a free arm passes', () => {
  const tent = renderSilhouette({shape: 'tent'}), body = renderSilhouette({shape: 'body'}), noArm = renderSilhouette({shape: 'body', arms: false});
  const t = widthProfile(tent.mask, tent.w, tent.h), b = widthProfile(body.mask, body.w, body.h);
  assert.equal(t.tent, true); assert.equal(t.pass, false);
  assert.equal(b.tent, false); assert.equal(b.pass, true); assert.ok(b.shoulderWaist > 1.1 && b.waistHem <= 0.75 && b.limbSeparated);
  assert.equal(widthProfile(noArm.mask, noArm.w, noArm.h).pass, false);
  assert.equal(widthProfile(noArm.mask, noArm.w, noArm.h, {requireLimb: false}).pass, true);
  const tiny = new Uint8Array(100 * 100); for (let y = 40; y < 70; y++) for (let x = 45; x < 55; x++) tiny[y * 100 + x] = 1;
  assert.match(widthProfile(tiny, 100, 100).fails[0], /cannot be measured/);
});

test('CLI: --mask/--exclude/--erode scope, PNG masks, --surface, --silhouette auto, and usage errors', {timeout: 120000}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pqa-region-'));
  try {
    const G = [0.05, 0.5, 0.95, 0.97];
    const zebra = renderScene({seed: 3, layers: [{type: 'disk', cx: 0.8, cy: 0.12, r: 0.025}, {type: 'bands', rect: G, period: 7, amp: 0.45, angle: 20}, {type: 'flat', rect: [0.1, 0.55, 0.45, 0.95], color: [0.03, 0.03, 0.035]}]});
    await writeFile(path.join(dir, 'lab_t1.000.png'), imageToPNG(zebra));
    // PNG mask at frame size: the flat slab is a neighbour component
    const m = new Uint8Array(zebra.w * zebra.h * 4); for (let y = 0; y < zebra.h; y++) for (let x = 0; x < zebra.w; x++) { const i = (y * zebra.w + x) * 4, inside = x >= 0.09 * zebra.w && x < 0.46 * zebra.w && y >= 0.54 * zebra.h && y < 0.96 * zebra.h; m[i] = m[i + 1] = m[i + 2] = inside ? 255 : 0; m[i + 3] = 255; }
    await writeFile(path.join(dir, 'slab_mask.png'), encodePNG(m, zebra.w, zebra.h));
    await writeFile(path.join(dir, 'masks.json'), JSON.stringify({ground: G, slab: 'slab_mask.png', _why: 'slab is the neighbouring component'}));
    const sil = renderSilhouette({shape: 'tent', w: zebra.w, h: zebra.h}), sm = new Uint8Array(sil.w * sil.h * 4);
    for (let i = 0; i < sil.mask.length; i++) { sm[i * 4] = sm[i * 4 + 1] = sm[i * 4 + 2] = sil.mask[i] ? 255 : 0; sm[i * 4 + 3] = 255; }
    await writeFile(path.join(dir, 'lab_t1.000_fig.png'), encodePNG(sm, sil.w, sil.h));
    const out = path.join(dir, 'qa');
    const r = await run(['--dir', dir, '--mask', 'ground', '--exclude', 'slab', '--erode', '1', '--only', 'flat,surface,silhouette', '--surface', JSON.stringify({ratio: [1.05, 2.0], midFrac: [0.4, 1]}), '--silhouette', 'auto', '--out', out]);
    assert.equal(r.code, 1, r.out);
    const rep = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8'));
    assert.equal(rep.results.length, 1, 'mask PNGs and _fig sidecars are not frames');
    const res = rep.results[0];
    assert.deepEqual(res.scope.names, ['ground']); assert.deepEqual(res.scope.exclude, ['slab']); assert.equal(res.scope.erode, 1);
    assert.equal(res.checks.flat.pass, true, 'excluded neighbour slab is not measured');
    assert.equal(res.checks.surface.pass, false); assert.deepEqual(res.checks.surface.rows.map((x) => x.side), ['high', 'low']);
    assert.equal(res.checks.silhouette.pass, false); assert.equal(res.checks.silhouette.tent, true);
    assert.match(await readFile(path.join(out, 'report.md'), 'utf8'), /⑧ surface: ratio .* > 2; midFrac .* < 0\.4/);
    // whole frame without the scope: the slab fails ③
    const whole = await run([path.join(dir, 'lab_t1.000.png'), '--only', 'flat', '--out', path.join(dir, 'qa2')]);
    assert.equal(whole.code, 1);
    // usage errors
    assert.equal((await run(['--dir', dir, '--mask', 'rock', '--out', path.join(dir, 'qa3')])).code, 2);
    assert.equal((await run(['--dir', dir, '--erode', '2', '--out', path.join(dir, 'qa3')])).code, 2);
    assert.equal((await run(['--dir', dir, '--surface', '{"ratio":[null,2]}', '--out', path.join(dir, 'qa3')])).code, 2);
    assert.match((await run(['--dir', dir, '--surface', '{"ratio":[null,2]}', '--out', path.join(dir, 'qa3')])).out, /one-sided bound/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('in-memory analyzeImage: region scope applies to ④ luma and ⑦ warm; outside content does not count', () => {
  const img = renderScene({seed: 3, layers: [{type: 'tint', rect: [0.55, 0.5, 0.85, 0.95], color: [0.55, 0.28, 0.08], k: 0.8}]});
  const region = {defs: parseMaskDefs({left: [0, 0.4, 0.5, 1]}), names: ['left'], exclude: [], erode: 0, baseDir: null};
  const whole = analyzeImage(img, {only: ['warm'], warmMax: 0.05});
  const scoped = analyzeImage(img, {only: ['warm', 'luma'], warmMax: 0.05, region});
  assert.equal(whole.checks.warm.pass, false); assert.equal(scoped.checks.warm.pass, true);
  assert.ok(scoped.scope.coverage > 0.25 && scoped.scope.coverage < 0.35);
});
