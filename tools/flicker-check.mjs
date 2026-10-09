import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import {browser as launchBrowser} from './lib/browser.mjs';
import {cli, isMain, number, required} from './lib/cli.mjs';
import {contactSheet} from './contact-sheet.mjs';

sharp.concurrency(1);
sharp.cache({memory: 32, files: 0, items: 64});
const WIDTH = 64, HEIGHT = 36, COLS = 16, ROWS = 9;
export function frameDifference(a, b) {
  if (a.length !== WIDTH * HEIGHT * 3 || b.length !== a.length) throw new RangeError('Expected 64x36 RGB thumbnails');
  const blocks = Array(COLS * ROWS).fill(0);
  let total = 0;
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const i = (y * WIDTH + x) * 3;
    const delta = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    total += delta; blocks[Math.floor(y / 4) * COLS + Math.floor(x / 4)] += delta / 16;
  }
  return {mean: total / (WIDTH * HEIGHT), blocks};
}

/** Scores in 8-bit RGB units. A spike returns to its neighbours; a step persists. */
export function scoreSequence(frames, {globalThreshold = 12, localThreshold = 28, ratio = 3} = {}) {
  if (![globalThreshold, localThreshold, ratio].every(Number.isFinite) || !(globalThreshold > 0 && localThreshold > 0 && ratio > 1)) throw new RangeError('Invalid thresholds');
  const diffs = frames.map((f, i) => i ? frameDifference(frames[i - 1].pixels, f.pixels) : {mean: 0, blocks: Array(144).fill(0)});
  return frames.map((f, i) => {
    const before = diffs[i], after = diffs[i + 1], bridge = i && i + 1 < frames.length ? frameDifference(frames[i - 1].pixels, frames[i + 1].pixels) : null;
    const flags = [], localBlocks = [];
    if (bridge && Math.min(before.mean, after.mean) > globalThreshold && Math.min(before.mean, after.mean) > ratio * Math.max(1, bridge.mean)) flags.push('spike');
    if (i && before.mean > globalThreshold && before.mean > ratio * Math.max(1, diffs[i - 1].mean, after?.mean || 0)) flags.push('step');
    if (bridge) for (let b = 0; b < 144; b++) if (Math.min(before.blocks[b], after.blocks[b]) > localThreshold && Math.min(before.blocks[b], after.blocks[b]) > ratio * Math.max(1, bridge.blocks[b])) localBlocks.push([b % COLS, Math.floor(b / COLS)]);
    if (localBlocks.length) flags.push('local-spike');
    const {pixels, png, ...metadata} = f;
    return {...metadata, difference: before.mean, localDifference: Math.max(...before.blocks), bridge: bridge?.mean ?? null, localBlocks, flags};
  });
}

export function sampleTimes(start, end, hz) {
  if (![start, end, hz].every(Number.isFinite) || start < 0 || end < start || hz <= 0) throw new RangeError('Invalid sample interval');
  return Array.from({length: Math.floor((end - start) * hz + 1e-7) + 1}, (_, i) => start + i / hz);
}
export const cutOffsets = [-.025, -.0045, -.001, .001, .0045, .025];

/** Sequential 24/60 Hz TIME sampling; actual wall-clock delivery fps is a separate playback test. */
export async function checkFlicker({url, out, start = 0, end, width = 640, height = 360, maxSamples = 30000, timeout = 300000, globalThreshold = 12, localThreshold = 28, ratio = 3, browser: suppliedBrowser}) {
  const target = new URL(url);
  if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:' || +target.port < 39920 || +target.port > 39929) throw new Error('Use an assigned loopback URL (39920–39929)');
  number(width, 'width', 160, 4096, true); number(height, 'height', 90, 2160, true);
  number(maxSamples, 'maxSamples', 1, 60000, true); number(timeout, 'timeout', 1000, 3600000);
  await mkdir(out, {recursive: true});
  // Refuse evidence overwrite, including failed runs.
  const framesDir = path.join(out, 'thumbnails'); await mkdir(framesDir);
  const report = {status: 'RUNNING', scope: '24 Hz seek and 60 Hz real-time-policy time sampling, not a 60 fps performance claim', thumbnail: [WIDTH, HEIGHT], blocks: [COLS, ROWS], thresholds: {globalThreshold, localThreshold, ratio}, rows: [], errors: []};
  const browser = suppliedBrowser || await launchBrowser();
  const context = await browser.newContext({viewport: {width, height}}), page = await context.newPage();
  page.setDefaultTimeout(Math.min(timeout, 90000));
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  const timer = setTimeout(() => { report.errors.push('Flicker check deadline exceeded'); context.close().catch(() => {}); }, timeout);
  const sheets = [];
  try {
    target.searchParams.set('mode', 'capture'); target.searchParams.set('w', width); target.searchParams.set('h', height);
    await page.goto(target.href, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => window.__scene?.ready === true);
    const info = await page.evaluate(() => ({duration: __scene.duration, cuts: __scene.hardCuts, realtime: typeof __scene.renderRealtime === 'function'}));
    if (!info.realtime || !Array.isArray(info.cuts)) throw new Error('Scene requires renderRealtime(t) and hardCuts for the second path');
    end ??= info.duration;
    number(start, 'start', 0, info.duration); number(end, 'end', start, info.duration);
    const cuts = info.cuts.filter(c => c >= start && c <= end);
    const estimated = Math.floor((end - start) * 24 + 1e-7) + Math.floor((end - start) * 60 + 1e-7) + 2 + cuts.length * 12;
    if (estimated > maxSamples) throw new Error(`Sample budget exceeded (${estimated} > ${maxSamples}); narrow the interval or explicitly raise --max-samples`);
    for (const [mode, hz] of [['seek', 24], ['realtime', 60]]) {
      // Fresh scene state per route: sequential-state faults remain observable.
      if (mode === 'realtime') { await page.reload({waitUntil: 'domcontentloaded'}); await page.waitForFunction(() => window.__scene?.ready === true); }
      const groups = [{name: mode, times: sampleTimes(start, end, hz)}, ...cuts.map(c => ({name: `${mode}-cut-${c}`, cut: c, times: cutOffsets.map(dt => c + dt).filter(t => t >= 0 && t <= info.duration)}))];
      for (const group of groups) {
        const frames = [];
        for (const t of group.times) {
          const result = await page.evaluate(async ({t, mode}) => {
            const result = await (mode === 'seek' ? __scene.seek(t) : __scene.renderRealtime(t, {sync: true}));
            const thumb = document.createElement('canvas'); thumb.width = 64; thumb.height = 36;
            thumb.getContext('2d').drawImage(__scene.canvas, 0, 0, 64, 36);
            return {png: thumb.toDataURL('image/png').split(',')[1], rendered: result?.t ?? t};
          }, {t, mode});
          const png = Buffer.from(result.png, 'base64'), file = `${group.name}-${String(frames.length).padStart(6, '0')}.png`;
          await writeFile(path.join(framesDir, file), png);
          const pixels = await sharp(png).removeAlpha().raw().toBuffer();
          frames.push({t, rendered: result.rendered, mode, group: group.name, cut: group.cut ?? null, expectedCut: cuts.some(c => Math.abs(t - c) <= 1 / hz), file: `thumbnails/${file}`, pixels});
        }
        const rows = scoreSequence(frames, {globalThreshold, localThreshold, ratio}); report.rows.push(...rows);
        const selected = new Set();
        // Keep every candidate and its neighbours, plus twelve overview samples.
        rows.forEach((row, i) => { if (row.flags.length || group.cut !== undefined) for (const j of [i - 1, i, i + 1]) if (rows[j]) selected.add(j); });
        for (let i = 0; i < Math.min(12, rows.length); i++) selected.add(Math.round(i * (rows.length - 1) / Math.max(1, Math.min(12, rows.length) - 1)));
        // Bound contact-sheet disk usage separately from the thumbnail/sample budget.
        const allIndices = [...selected].sort((a, b) => a - b);
        const remaining = Math.max(0, 60 - sheets.length) * 12;
        const indices = allIndices.slice(0, remaining);
        report.omittedContactFrames = (report.omittedContactFrames || 0) + allIndices.length - indices.length;
        for (let offset = 0; offset < indices.length; offset += 12) {
          const batch = indices.slice(offset, offset + 12), file = `${group.name}-sheet-${String(offset / 12).padStart(3, '0')}.png`;
          await contactSheet(batch.map(i => path.join(out, rows[i].file)), path.join(out, file), {columns: 3, width: 320, labels: batch.map(i => `${rows[i].t.toFixed(4)} ${rows[i].flags.join(',') || '-'}${rows[i].expectedCut ? ' CUT' : ''}`)});
          sheets.push(file);
        }
      }
    }
    if (report.errors.length) throw new Error(report.errors.join('\n'));
    report.status = 'COMPLETE'; report.candidates = report.rows.filter(r => r.flags.length).length;
    report.review = report.candidates ? 'REVIEW_REQUIRED: candidates include intended cuts and motion; inspect sheets' : 'No threshold candidates; independent visual review still required';
    return report;
  } catch (error) { report.status = 'FAIL'; report.failure = error.stack; throw error; }
  finally {
    clearTimeout(timer); report.sheets = sheets;
    await writeFile(path.join(out, 'rows.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(out, 'flags.txt'), [report.status, report.review || report.failure, ...report.rows.filter(r => r.flags.length).map(r => `${r.group} t=${r.t.toFixed(6)} rendered=${r.rendered.toFixed(6)} ${r.flags.join(',')} blocks=${JSON.stringify(r.localBlocks)}${r.expectedCut ? ' EXPECTED_CUT_NEARBY' : ''}`)].join('\n') + '\n');
    await context.close(); if (!suppliedBrowser) await browser.close();
  }
}

if (isMain(import.meta.url)) {
  const a = cli({url: {type: 'string'}, out: {type: 'string'}, start: {type: 'string', default: '0'}, end: {type: 'string'}, width: {type: 'string', default: '640'}, height: {type: 'string', default: '360'}, 'max-samples': {type: 'string', default: '30000'}, timeout: {type: 'string', default: '300000'}, 'global-threshold': {type: 'string', default: '12'}, 'local-threshold': {type: 'string', default: '28'}, ratio: {type: 'string', default: '3'}},
    'Usage: node tools/flicker-check.mjs --url http://127.0.0.1:39920 --out out/flicker [--start 0 --end 60 --width 640 --height 360 --timeout 300000]\n24 Hz seek + 60 Hz real-time policy + cut ±1/4.5/25 ms; rows.json, flags.txt and contact sheets. Candidates require visual review. Use a fresh output directory per run.');
  if (a) { const report = await checkFlicker({url: required(a.url, 'url'), out: required(a.out, 'out'), start: Number(a.start), end: a.end === undefined ? undefined : Number(a.end), width: Number(a.width), height: Number(a.height), maxSamples: Number(a['max-samples']), timeout: Number(a.timeout), globalThreshold: Number(a['global-threshold']), localThreshold: Number(a['local-threshold']), ratio: Number(a.ratio)}); console.log(`${report.status} frames=${report.rows.length} candidates=${report.candidates}; ${report.review}`); }
}
