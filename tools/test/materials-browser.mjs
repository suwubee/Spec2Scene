// Browser acceptance for kits/materials: compile every shader in a real WebGL2 context, capture the five bench views,
// check seek determinism and run picture-qa on the captures. Usage:
//   node tools/test/materials-browser.mjs --out <ignored dir>      (ports 39920-39929, own server + browser, closed by handle)
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {localServer} from './helpers.mjs';
import {analyzeFile, writeReport, validateConfig} from '../picture-qa/picture-qa.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const BENCH_VIEWS = [{t: 1, name: 'snow-grazing'}, {t: 5, name: 'snow-above'}, {t: 9, name: 'ice'}, {t: 13, name: 'rammed-wall'}, {t: 17, name: 'snow-drift'}];
// The wall courses are a designed regular texture: declared exactly as a project shot config would.
export const BENCH_CONFIG = validateConfig({defaults: {sky: 'auto'}, scenes: {bench: {shots: [
  {name: 'snow from above', t: [4, 8], sky: 'none', exempt: ['non-sky-region'], _why: 'looking down from 30 m: the frame holds no horizon and no sky',
    notes: 'material inspection view of a snowfield from 30 m; dark boulders give the frame its darkest area (thresholds are not relaxed)'},
  {name: 'ice from above', t: [8, 12], sky: 'none', skip: ['halo'], skipWhy: 'no figure or dark object outline in frame; bright snow-powder wisps on black ice are a documented halo false positive',
    exempt: ['designed-texture', 'non-sky-region'], _why: 'looking down at ice: no sky; the bright snow-on-ice wisps are the designed texture, not an outline'},
  {name: 'rammed wall', t: [12, 16], exempt: ['designed-texture'], _why: 'rammed-earth courses are the designed regular texture of the wall',
    allowStripes: [{rect: [0.15, 0.1, 0.68, 0.72], why: 'designed rammed-earth courses (regular horizontal texture)'}]},
]}}}, 'BENCH_CONFIG');

export async function validateMaterials(out) {
  await mkdir(out, {recursive: true});
  const server = await localServer(root, {min: 39920, max: 39929});
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], ...(process.env.SCENE_CHROMIUM ? {executablePath: process.env.SCENE_CHROMIUM} : {})});
  const report = {server: server.url, serverPid: process.pid, browserPid: browser.process?.()?.pid ?? null, views: [], errors: []};
  try {
    const page = await browser.newPage({viewport: {width: 960, height: 402}});
    page.setDefaultTimeout(180000);
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' || /shader|THREE\.WebGLProgram/i.test(m.text())) report.errors.push(m.text()); });
    await page.goto(server.url + '/tracks/music-video/kits/materials/example.html?t=1');
    await page.waitForFunction(() => window.__scene?.ready === true);
    const shot = async t => Buffer.from(await page.evaluate(tt => { __scene.seek(tt); return __scene.capture().split(',')[1]; }, t), 'base64');
    const files = [];
    for (const v of BENCH_VIEWS) {
      const png = await shot(v.t), file = path.join(out, `bench_t${v.t.toFixed(3).padStart(7, '0')}.png`);
      await writeFile(file, png); files.push(file);
      report.views.push({...v, file, sha256: createHash('sha256').update(png).digest('hex')});
    }
    const again = createHash('sha256').update(await shot(BENCH_VIEWS[2].t)).digest('hex');
    report.deterministic = again === report.views[2].sha256;
    report.inspect = await page.evaluate(() => __scene.inspect());
    const {shotOpts} = await import('../picture-qa/picture-qa.mjs');
    const qaDir = path.join(out, 'qa'); await mkdir(qaDir, {recursive: true});
    const results = files.map(f => analyzeFile(f, shotOpts(f, BENCH_CONFIG, {}), null, qaDir));
    writeReport(qaDir, results, {config: 'BENCH_CONFIG (tools/test/materials-browser.mjs)'});
    report.qa = results.map(r => ({file: path.basename(r.file), pass: r.pass, failed: r.failed, stripes: r.checks.stripes.frac, flat: r.checks.flat.largest, luma: r.checks.luma.mean}));
  } finally {
    await browser.close(); await server.close();
  }
  await writeFile(path.join(out, 'materials-report.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf('--out');
  if (i < 0) { console.error('Usage: node tools/test/materials-browser.mjs --out <dir>'); process.exit(2); }
  const r = await validateMaterials(path.resolve(process.argv[i + 1]));
  console.log(JSON.stringify({errors: r.errors, deterministic: r.deterministic, inspect: r.inspect, qa: r.qa}, null, 1));
  try { assert.deepEqual(r.errors, []); assert.equal(r.deterministic, true); assert.ok(r.qa.every(q => q.pass), 'picture-qa must pass on every bench view'); }
  catch (e) { console.error('FAIL', e.message); process.exitCode = 1; }
}
