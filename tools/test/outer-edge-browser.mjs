// Pixel regression for the character outer-edge rim: renders rim-lab in final and legacy mode (backlit + front-lit) in a real
// WebGL2 context and runs picture-qa ② halo on the captures. Final must PASS everywhere; legacy (old behaviour) must FAIL backlit.
//   node tools/test/outer-edge-browser.mjs --out <ignored dir>      (own server on 39920-39929 and own browser, closed by handle)
import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {localServer} from './helpers.mjs';
import {analyzeFile} from '../picture-qa/picture-qa.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export async function validateOuterEdge(out) {
  await mkdir(out, {recursive: true});
  const server = await localServer(root, {min: 39920, max: 39929});
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], ...(process.env.SCENE_CHROMIUM ? {executablePath: process.env.SCENE_CHROMIUM} : {})});
  const rows = [], errors = [];
  try {
    for (const [mode, light] of [['final', 'back'], ['final', 'front'], ['legacy', 'back']]) {
      const page = await browser.newPage({viewport: {width: 960, height: 402}});
      page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(`${server.url}/tracks/music-video/character/real/rim-lab.html?mode=${mode}&light=${light}`);
      await page.waitForFunction(() => window.__scene?.ready === true);
      for (const t of [1, 2.5, 4]) {
        const png = Buffer.from(await page.evaluate(tt => { __scene.seek(tt); return __scene.capture().split(',')[1]; }, t), 'base64');
        const file = path.join(out, `rim-${mode}-${light}_t${t.toFixed(3).padStart(7, '0')}.png`); await writeFile(file, png);
        const r = analyzeFile(file, {only: ['halo']}, null, out);
        rows.push({mode, light, t, halo: r.checks.halo.pass, worst: r.checks.halo.worst[0] || null, inspect: await page.evaluate(() => __scene.inspect())});
      }
      await page.close();
    }
  } finally { await browser.close(); await server.close(); }
  const report = {errors, rows};
  await writeFile(path.join(out, 'outer-edge-report.json'), JSON.stringify(report, null, 2));
  return report;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf('--out');
  if (i < 0) { console.error('Usage: node tools/test/outer-edge-browser.mjs --out <dir>'); process.exit(2); }
  const r = await validateOuterEdge(path.resolve(process.argv[i + 1]));
  console.log(JSON.stringify(r, null, 1));
  const ok = !r.errors.length && r.rows.filter(x => x.mode === 'final').every(x => x.halo) && r.rows.filter(x => x.mode === 'legacy').some(x => !x.halo);
  if (!ok) { console.error('FAIL outer-edge regression'); process.exitCode = 1; }
}
