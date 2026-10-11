// Browser acceptance for kits/far: compile the far-range and block shaders in a real WebGL2 context, capture the six bench
// views, check seek determinism (same view twice, and after other views) and run picture-qa on the captures. Usage:
//   node tools/test/far-browser.mjs --out <ignored dir>      (ports 39920-39929, own server + browser, closed by handle)
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {localServer} from './helpers.mjs';
import {analyzeFile, writeReport, validateConfig, shotOpts} from '../picture-qa/picture-qa.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const FAR_VIEWS = [{t: 1, name: 'ranges-85mm'}, {t: 5, name: 'distant-ring'}, {t: 9, name: 'houses'}, {t: 13, name: 'fort-gate'}, {t: 17, name: 'tower'}, {t: 21, name: 'hull'}];
// Exemptions are declared exactly as a project shot config must declare them: only designed texture / real light / real
// non-sky region, each with exempt + _why; no threshold is relaxed beyond the template defaults.
export const FAR_CONFIG = validateConfig({defaults: {sky: 'auto'}, scenes: {bench: {shots: [
  {name: 'houses', t: [8, 12], exempt: ['designed-texture'], _why: 'rammed-earth courses and eave / roof-slab lines of the three houses are designed regular structure',
    allowStripes: [{rect: [0.19, 0.33, 0.58, 0.74], why: 'rammed courses + eave lines, left houses'}, {rect: [0.60, 0.33, 0.86, 0.72], why: 'rammed courses + eave lines, right house'},
      {rect: [0.43, 0.22, 0.60, 0.36], why: 'roof slab and snow cap edge, rear house'}]},
  {name: 'fort gate', t: [12, 16], exempt: ['designed-texture'], _why: 'rammed-earth courses on the battered wall face are the designed regular texture of the material library',
    allowStripes: [{rect: [0.0, 0.42, 0.92, 0.74], why: 'designed rammed-earth courses and the foot drift line of the wall'}]},
]}}}, 'FAR_CONFIG');

export async function validateFar(out) {
  await mkdir(out, {recursive: true});
  const server = await localServer(root, {min: 39920, max: 39929});
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], ...(process.env.SCENE_CHROMIUM ? {executablePath: process.env.SCENE_CHROMIUM} : {})});
  const report = {server: server.url, browserPid: browser.process?.()?.pid ?? null, views: [], errors: []};
  try {
    const page = await browser.newPage({viewport: {width: 960, height: 402}});
    page.setDefaultTimeout(300000);
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' || /shader|THREE\.WebGLProgram/i.test(m.text())) report.errors.push(m.text()); });
    await page.goto(server.url + '/tracks/music-video/kits/far/example.html?t=1');
    await page.waitForFunction(() => window.__scene?.ready === true || window.__sceneError, null, {timeout: 300000});
    const shot = async t => Buffer.from(await page.evaluate(tt => { __scene.seek(tt); return __scene.capture().split(',')[1]; }, t), 'base64');
    const files = [];
    for (const v of FAR_VIEWS) {
      const png = await shot(v.t), file = path.join(out, `bench_t${v.t.toFixed(3).padStart(7, '0')}.png`);
      await writeFile(file, png); files.push(file);
      report.views.push({...v, file, sha256: createHash('sha256').update(png).digest('hex')});
    }
    const again = [createHash('sha256').update(await shot(FAR_VIEWS[0].t)).digest('hex'), createHash('sha256').update(await shot(FAR_VIEWS[3].t)).digest('hex')];
    report.deterministic = again[0] === report.views[0].sha256 && again[1] === report.views[3].sha256;
    report.inspect = await page.evaluate(() => __scene.inspect());
    const qaDir = path.join(out, 'qa'); await mkdir(qaDir, {recursive: true});
    const results = files.map(f => analyzeFile(f, shotOpts(f, FAR_CONFIG, {scene: 'bench'}), null, qaDir));
    writeReport(qaDir, results, {config: 'FAR_CONFIG (tools/test/far-browser.mjs)'});
    report.qa = results.map(r => ({file: path.basename(r.file), pass: r.pass, failed: r.failed, stripes: r.checks.stripes?.frac, flat: r.checks.flat?.largest, luma: r.checks.luma?.mean, p99: r.checks.luma?.p99, warm: r.checks.warm?.frac, warnings: r.configWarnings || []}));
  } finally {
    await browser.close(); await server.close();
  }
  await writeFile(path.join(out, 'far-report.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf('--out');
  if (i < 0) { console.error('Usage: node tools/test/far-browser.mjs --out <dir>'); process.exit(2); }
  const r = await validateFar(path.resolve(process.argv[i + 1]));
  console.log(JSON.stringify({errors: r.errors, deterministic: r.deterministic, inspect: r.inspect, qa: r.qa}, null, 1));
  try { assert.deepEqual(r.errors, []); assert.equal(r.deterministic, true); assert.ok(r.qa.every(q => q.pass), 'picture-qa must pass on every bench view'); }
  catch (e) { console.error('FAIL', e.message); process.exitCode = 1; }
}
