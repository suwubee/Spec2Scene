import path from 'node:path';
import {mkdir, readdir, readFile, access} from 'node:fs/promises';
import {cli, isMain, required, number, run, atomic} from '../lib/cli.mjs';
import {browser, auditPage, prepare} from '../lib/browser.mjs';
import {evaluateEvents} from './metrics.mjs';
import {contactSheet} from '../contact-sheet.mjs';
import {sha256} from '../lib/images.mjs';

export async function evaluateVideo({video, url, out, labels, fps = 25, allowMissing = false}) {
  required(video, 'video'); required(url, 'url'); required(out, 'out'); number(fps, 'fps', 1, 60);
  try { await access(video); } catch (e) {
    if (e.code !== 'ENOENT' || !allowMissing) throw e;
    return {status: 'SKIP', reason: 'Optional licensed video is absent; real recognition not validated'};
  }
  const framesDir = path.join(out, 'frames');
  await mkdir(out, {recursive: true});
  await mkdir(framesDir); // Refuse to mix previous evaluation frames.
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', video,
    '-vf', `fps=${fps},scale=640:-2`, '-threads', '1', path.join(framesDir, '%06d.png')]);
  const files = (await readdir(framesDir)).filter(f => f.endsWith('.png')).sort();
  if (!files.length) throw new Error('No decoded frames');
  const session = await browser();
  const events = [], frames = [];
  try {
    const page = await session.newPage();
    const check = auditPage(page);
    const unexpected = [];
    const origin = new URL(url).origin;
    page.on('request', req => { if (/^https?:/.test(req.url()) && new URL(req.url()).origin !== origin) unexpected.push(req.url()); });
    await prepare(page, url);
    await page.waitForFunction(() => window.__poseEval?.ready);
    for (const [i, file] of files.entries()) {
      const bytes = await readFile(path.join(framesDir, file));
      const result = await page.evaluate(async ({png, t}) => {
        const blob = await (await fetch(`data:image/png;base64,${png}`)).blob();
        const bitmap = await createImageBitmap(blob);
        try { return await window.__poseEval.detect(bitmap, t * 1000); }
        finally { bitmap.close(); }
      }, {png: bytes.toString('base64'), t: i / fps});
      if (!Array.isArray(result.events)) throw new Error('Harness must return {events:[], lost:boolean}');
      events.push(...result.events);
      frames.push({t: i / fps, lost: Boolean(result.lost)});
    }
    check();
    if (unexpected.length) throw new Error('Unexpected external request');
    const truth = labels ? JSON.parse(await readFile(labels, 'utf8')).events : null;
    const report = {status: 'PASS', inputSha256: sha256(await readFile(video)), fps, events, frames,
      lostRatio: frames.filter(f => f.lost).length / frames.length, metrics: truth ? evaluateEvents(events, truth) : null,
      acceptance: 'metrics only; project SPEC must apply its own thresholds'};
    await atomic(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    const selected = events.length ? events.map(e => Math.min(files.length - 1, Math.max(0, Math.round(e.t * fps)))) :
      Array.from({length: Math.min(12, files.length)}, (_, i) => Math.floor(i * files.length / Math.min(12, files.length)));
    for (let offset = 0; offset < selected.length; offset += 24) {
      const indices = selected.slice(offset, offset + 24);
      await contactSheet(indices.map(i => path.join(framesDir, files[i])), path.join(out, `sheet-${offset / 24}.png`),
        {labels: indices.map((i, j) => `${(i / fps).toFixed(2)}s ${events[offset + j]?.type || 'sample'}`)});
    }
    return report;
  } finally { await session.close(); }
}
if (isMain(import.meta.url)) {
  const a = cli({video: {type: 'string'}, url: {type: 'string'}, out: {type: 'string'}, labels: {type: 'string'},
    fps: {type: 'string', default: '25'}, 'allow-missing': {type: 'boolean'}},
  'Usage: node tools/pose/evaluate-video.mjs --video FILE --url HARNESS_URL --out NEW_DIR [--labels JSON --fps 25 --allow-missing]\n页面实现 __poseEval={ready,detect(bitmap,timestampMs)}；模型与检测器由项目实现，数据缺失可显式 SKIP。');
  if (a) console.log(JSON.stringify(await evaluateVideo({...a, fps: Number(a.fps), allowMissing: a['allow-missing']}), null, 2));
}
