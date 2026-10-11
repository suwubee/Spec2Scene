import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runSelftest, analyzeImage, validateConfig, shotOpts, frameKey, CHECKS, TH, EXEMPT_KINDS, TEMPLATE_DEFAULTS, configRelaxations, compareConfigs, declaredSkyArea} from '../picture-qa/picture-qa.mjs';
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
  const big = {defaults: {allowStripes: [{rect: [0, 0, .7, .6], why: 'too large on purpose'}], exempt: ['designed-texture'], _why: 'too large on purpose (cap test)'}};
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

test('exemptions rest only on designed texture, a real light or a real non-sky region, each with exempt + _why', () => {
  assert.deepEqual([...EXEMPT_KINDS], ['designed-texture', 'real-light', 'non-sky-region']);
  assert.deepEqual(TEMPLATE_DEFAULTS.luma, template.defaults.luma, 'TEMPLATE_DEFAULTS mirrors the template file');
  assert.equal(TEMPLATE_DEFAULTS.warmMax, template.defaults.warmMax);
  const _why = 'the lamp in frame is a real light source';
  // every exemption type without exempt/_why is rejected
  for (const L of [{sky: 'none'}, {sky: {rects: [[0, 0, 1, .3]]}}, {sky: .4}, {warmMax: .2}, {luma: {p99min: .12}}, {luma: {drmin: .1}}, {luma: {lo: .01}}, {luma: {hi: .6}}, {luma: {p01max: .2}},
    {skip: ['halo'], skipWhy: 'lamp glow is physical'}, {allowStripes: [{rect: [0, 0, .2, .2], why: 'designed lattice'}]}]) {
    assert.throws(() => validateConfig({defaults: L}), /exempt/, JSON.stringify(L));
    assert.throws(() => validateConfig({defaults: {...L, exempt: ['designed-texture', 'real-light', 'non-sky-region']}}), /_why/, JSON.stringify(L));
  }
  // the basis must match the exemption: a sky mask can only be justified by a real non-sky region, stripes only by design
  assert.throws(() => validateConfig({defaults: {sky: 'none', exempt: ['real-light'], _why}}), /non-sky-region/);
  assert.throws(() => validateConfig({defaults: {allowStripes: [{rect: [0, 0, .2, .2], why: 'lamp'}], exempt: ['real-light'], _why}}), /designed-texture/);
  assert.throws(() => validateConfig({defaults: {warmMax: .3, exempt: ['convenience'], _why}}), /exempt: non-empty array/);
  assert.throws(() => validateConfig({defaults: {warmMax: .3, exempt: ['real-light'], _why: 'short'}}), /_why/);
  validateConfig({defaults: {warmMax: .3, exempt: ['real-light'], _why}});
  // stricter-than-template values are not exemptions; relaxing fix verification is never allowed
  validateConfig({scenes: {a: {shots: [{name: 'tight', t: [0, 4], luma: {lo: .06, hi: .2, p99min: .3}, warmMax: .02}]}}});
  assert.throws(() => validateConfig({defaults: {requireChange: .005, exempt: ['real-light'], _why}}), /requireChange/);
  assert.throws(() => validateConfig({defaults: {skip: ['diff'], skipWhy: 'no', exempt: ['real-light'], _why}}), /diff check cannot be skipped/);
  // the audit trail lists every relaxation of the template
  const rel = configRelaxations(template);
  assert.ok(rel.some(r => r.field === 'warmMax' && r.exempt.includes('real-light') && r.why.length >= 12));
  assert.ok(rel.every(r => r.exempt.length && r.why.length >= 12));
  const o = shotOpts('dawn_t030.000.png', template, {});
  assert.ok(o.exemptions.some(e => e.fields.includes('warmMax')) && o.exemptions.some(e => e.fields.includes('sky')));
});

test('config change alarm: shrinking the sky mask or loosening a threshold vs the previous config is flagged', () => {
  const base = {defaults: {sky: 'auto'}, scenes: {s: {shots: [{name: 'A', t: [0, 4]}, {name: 'B', t: [4, 8], sky: {rects: [[0, 0, 1, .4]]}, exempt: ['non-sky-region'], _why: 'below 40% is the ridge, not sky'}]}}};
  assert.deepEqual(compareConfigs(base, base), []);
  const shrunk = structuredClone(base); shrunk.scenes.s.shots[1].sky = {rects: [[0, 0, 1, .25]]};
  assert.deepEqual(compareConfigs(base, shrunk).map(a => [a.shot, a.field]), [['s:B', 'sky']]);
  const declared = structuredClone(base); Object.assign(declared.scenes.s.shots[0], {sky: {rects: [[0, 0, 1, .3]]}, exempt: ['non-sky-region'], _why: 'the lower part is a snow slope'});
  assert.match(compareConfigs(base, declared)[0].note, /automatic sky replaced/);
  const loose = structuredClone(base); Object.assign(loose.scenes.s.shots[0], {luma: {p99min: .15, drmin: .1}, warmMax: .2, skip: ['clouds'], skipWhy: 'x', exempt: ['real-light'], _why: 'only a lamp lights this frame'});
  assert.deepEqual(compareConfigs(base, loose).map(a => a.field).sort(), ['luma.drmin', 'luma.p99min', 'skip', 'warmMax']);
  const tighter = structuredClone(base); tighter.scenes.s.shots[1].sky = {rects: [[0, 0, 1, .5]]}; tighter.scenes.s.shots[0].luma = {p99min: .3};
  assert.deepEqual(compareConfigs(base, tighter), []);
  assert.equal(declaredSkyArea('auto'), null); assert.equal(declaredSkyArea('none'), 0); assert.ok(Math.abs(declaredSkyArea({rects: [[0, 0, 1, .25]]}) - .25) < .02);
});

test('sky audit: a declared sky that hides cumulus from the automatic sky raises a config warning', () => {
  const scene = {seed: 4, layers: [{type: 'blob', cx: .3, cy: .14, rx: .06, amp: .08}, {type: 'blob', cx: .62, cy: .18, rx: .07, amp: .08}, {type: 'blob', cx: .45, cy: .1, rx: .05, amp: .08}]};
  const img = renderScene(scene);
  const auto = analyzeImage(img, {only: ['clouds']});
  assert.equal(auto.checks.clouds.pass, false, 'reference: cumulus detected with the automatic sky');
  const cfg = validateConfig({defaults: {sky: {rects: [[0, 0, 1, .05]]}, exempt: ['non-sky-region'], _why: 'pretend the clouds are not sky (gaming)'}});
  const r = analyzeImage(img, {...shotOpts('t1.png', cfg, {}), only: ['clouds']});
  assert.equal(r.checks.clouds.pass, true);
  assert.equal(r.checks.clouds.maskedByConfig, true);
  assert.ok(r.configWarnings.some(w => /sky mask shrunk/.test(w)) && r.configWarnings.some(w => /only under the declared sky mask/.test(w)), JSON.stringify(r.configWarnings));
  assert.ok(r.exemptions[0].why.includes('gaming'));
});

test('CLI --check-config --baseline exits 4 on a relaxed config and 0 when nothing got looser', {timeout: 60000}, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'picture-qa-cfg-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const looser = structuredClone(template); looser.scenes.dawn.shots[0].sky = {rects: [[0, 0, 1, .5]]};
  await writeFile(path.join(dir, 'old.json'), JSON.stringify(template)); await writeFile(path.join(dir, 'new.json'), JSON.stringify(looser));
  await assert.rejects(exec(process.execPath, [CLI, '--check-config', path.join(dir, 'new.json'), '--baseline', path.join(dir, 'old.json')]), e => e.code === 4 && /ALERT dawn:B1 upward sky: sky/.test(e.stdout));
  const same = await exec(process.execPath, [CLI, '--check-config', path.join(dir, 'old.json'), '--baseline', path.join(dir, 'old.json')]);
  assert.match(same.stdout, /no relaxation vs baseline/); assert.match(same.stdout, /EXEMPT scenes\.dawn: warmMax/);
});
