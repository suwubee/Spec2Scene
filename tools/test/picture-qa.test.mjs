import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runSelftest, analyzeImage, validateConfig, shotOpts, frameKey, CHECKS, TH} from '../picture-qa/picture-qa.mjs';
import {renderScene} from '../picture-qa/synth.mjs';
import {decodePNG, imageToPNG} from '../picture-qa/png.mjs';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../picture-qa/picture-qa.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../picture-qa/shots.template.json', import.meta.url));
const template = JSON.parse(await readFile(TEMPLATE, 'utf8'));

test('picture-qa synthetic regression set: every check has a FAIL and a PASS sample and all expectations hold', {timeout: 300000}, async () => {
  const lines = [];
  const r = await runSelftest({log: line => lines.push(line)});
  assert.equal(r.bad, 0, lines.filter(l => l.startsWith('MISS')).join('\n'));
  for (const check of CHECKS) assert.deepEqual(r.covered[check], ['FAIL', 'PASS'], `check ${check} must have FAIL and PASS samples`);
});

test('picture-qa is deterministic and model-free: identical input gives identical JSON', () => {
  const scene = {seed: 9, layers: [{type: 'figure', cx: .4, foot: .9, height: .45, halo: {width: 3, gain: .4}}, {type: 'blob', cx: .7, cy: .15, rx: .06, amp: .07}]};
  const a = analyzeImage(renderScene(scene)), b = analyzeImage(renderScene(scene));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(a.failed.sort(), ['clouds', 'halo']);
  const halo = a.checks.halo.worst[0];
  assert.equal(halo.px.length, 4); assert.ok(halo.px[0] < halo.px[2] && halo.px[1] < halo.px[3]);
});

test('PNG codec round-trips 8-bit frames and letterbox is cropped before analysis', () => {
  const img = renderScene({w: 320, h: 180, seed: 2, layers: [{type: 'flat', rect: [0, 0, 1, .12], color: [0, 0, 0]}, {type: 'flat', rect: [0, .88, 1, 1], color: [0, 0, 0]}], grain: 0});
  const back = decodePNG(imageToPNG(img));
  assert.equal(back.w, 320); assert.equal(back.h, 180);
  for (let i = 0; i < img.R.length; i += 97) assert.ok(Math.abs(back.R[i] - img.R[i]) < 1e-6);
  const r = analyzeImage(back, {only: ['luma']});
  assert.equal(r.crop[1] > 15 && r.crop[3] < 160, true);
});

test('per-shot config: exemptions need reasons, area cap holds, frame names map to shots', () => {
  validateConfig(template);
  assert.throws(() => validateConfig({defaults: {allowStripes: [{rect: [0, 0, .2, .2]}]}}), /why/);
  assert.throws(() => validateConfig({defaults: {skip: ['halo']}}), /skipWhy/);
  assert.throws(() => validateConfig({defaults: {lumaa: {}}}), /unknown key/);
  assert.throws(() => validateConfig({scenes: {a: {shots: [{name: 'x', t: [5, 2]}]}}}), /t0 < t1/);
  const big = {defaults: {allowStripes: [{rect: [0, 0, .7, .6], why: 'too large on purpose'}]}};
  validateConfig(big);
  assert.throws(() => shotOpts('a_t1.png', big, {}), /35%/);
  const cfg = {fps: 24, defaults: {warmMax: .05}, scenes: {exterior: {warmMax: .02, shots: [{name: 'A2', t: [8, 20], luma: {lo: .06}}]}}, shots: [{name: 'whole', t: [0, 100], warmMax: .3}]};
  assert.deepEqual(frameKey('exterior_t012.500.png'), {scene: 'exterior', t: 12.5});
  assert.deepEqual(frameKey('frame-000048.png', {fps: 24}), {scene: null, t: 2});
  const o = shotOpts('exterior_t012.500.png', cfg, {});
  assert.equal(o.shotName, 'exterior:A2'); assert.equal(o.warmMax, .02); assert.equal(o.luma.lo, .06);
  assert.equal(shotOpts('frame-000048.png', cfg, {}).warmMax, .3);
  assert.equal(TH.allowMaxArea, .35);
});

test('CLI: claim without compare is a usage error; compare+claim catches an unchanged fix', {timeout: 120000}, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'picture-qa-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const stripes = {seed: 3, layers: [{type: 'stripes', rect: [.05, .4, .6, 1], period: 11, angle: 90, amp: .03}]};
  await writeFile(path.join(dir, 'prev.png'), imageToPNG(renderScene(stripes)));
  await writeFile(path.join(dir, 'same.png'), imageToPNG(renderScene(stripes)));
  await writeFile(path.join(dir, 'fixed.png'), imageToPNG(renderScene({seed: 3})));
  await assert.rejects(exec(process.execPath, [CLI, path.join(dir, 'same.png'), '--claim', 'stripes', '--out', path.join(dir, 'a')]), e => e.code === 2);
  await assert.rejects(exec(process.execPath, [CLI, path.join(dir, 'same.png'), '--compare', path.join(dir, 'prev.png'), '--claim', 'stripes', '--out', path.join(dir, 'b')]), e => e.code === 1);
  const report = JSON.parse(await readFile(path.join(dir, 'b', 'report.json'), 'utf8'));
  assert.equal(report.results[0].checks.diff.pass, false);
  assert.ok(report.results[0].checks.diff.problems.some(p => p.check === 'stripes' && p.verdict === 'unchanged' && p.claimed));
  const ok = await exec(process.execPath, [CLI, path.join(dir, 'fixed.png'), '--compare', path.join(dir, 'prev.png'), '--claim', 'stripes', '--out', path.join(dir, 'c')]);
  assert.match(ok.stdout, /PASS {2}fixed\.png/);
  await exec(process.execPath, [CLI, '--check-config', TEMPLATE]);
});
