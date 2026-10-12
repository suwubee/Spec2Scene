import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkSheet, matchTile, skyUp, tileRects, fittedRect, orient, lumaGrid, SHEET_DEFAULTS} from '../sheet-orient.mjs';
import {imageToPNG, decodePNG} from '../picture-qa/png.mjs';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../sheet-orient.mjs', import.meta.url));

const blank = (w, h, v = 0) => ({w, h, R: new Float32Array(w * h).fill(v), G: new Float32Array(w * h).fill(v), B: new Float32Array(w * h).fill(v)});
const set = (img, x, y, v) => { const i = y * img.w + x; img.R[i] = v; img.G[i] = v; img.B[i] = v * 1.05; };
// Synthetic night exterior, asymmetric both ways: moonlit sky gradient on top, dark ground, a moon on the left,
// a lit post on the right; `k` moves the moon and the post so every frame is distinct.
function frame(k, w = 192, h = 108) {
  const img = blank(w, h), horizon = Math.round(h * 0.55);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = y < horizon ? 0.42 - 0.22 * y / horizon : 0.06 + 0.02 * Math.sin(x * 0.3) * Math.cos(y * 0.4);
    const mx = 22 + 14 * k, my = 18;
    if ((x - mx) ** 2 + (y - my) ** 2 < 64) v = 0.95;
    const px = w - 30 - 11 * k;
    if (x >= px && x < px + 6 && y > horizon - 25 && y < h - 6) v = 0.55;
    set(img, x, y, v);
  }
  return img;
}
const transform = (img, how) => {
  const out = blank(img.w, img.h);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const sx = how === 'hflip' || how === 'rot180' ? img.w - 1 - x : x, sy = how === 'vflip' || how === 'rot180' ? img.h - 1 - y : y;
    const i = y * img.w + x, j = sy * img.w + sx; out.R[i] = img.R[j]; out.G[i] = img.G[j]; out.B[i] = img.B[j];
  }
  return out;
};
// Paste images (box-downsampled by 2) into a grid sheet with gaps — what a sheet tool would produce.
function sheetOf(images, cols, {gap = [6, 4], bg = 0.9} = {}) {
  const tw = images[0].w / 2, th = images[0].h / 2, rows = Math.ceil(images.length / cols);
  const sheet = blank(cols * tw + (cols - 1) * gap[0], rows * th + (rows - 1) * gap[1], bg);
  images.forEach((img, n) => {
    const ox = (n % cols) * (tw + gap[0]), oy = Math.floor(n / cols) * (th + gap[1]);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const j = (2 * y + dy) * img.w + 2 * x + dx; r += img.R[j]; g += img.G[j]; b += img.B[j]; }
      const i = (oy + y) * sheet.w + ox + x; sheet.R[i] = r / 4; sheet.G[i] = g / 4; sheet.B[i] = b / 4;
    }
  });
  return {sheet, layout: {cols, rows, gap}};
}

test('orientation primitives: grid maths, tile rectangles and contain fitting', () => {
  const g = Float64Array.from([1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...orient(g, 3, 2, 'vflip')], [4, 5, 6, 1, 2, 3]);
  assert.deepEqual([...orient(g, 3, 2, 'hflip')], [3, 2, 1, 6, 5, 4]);
  assert.deepEqual([...orient(g, 3, 2, 'rot180')], [6, 5, 4, 3, 2, 1]);
  const img = frame(0);
  assert.ok(Math.abs(lumaGrid(img, {x: 0, y: 0, w: img.w, h: 10}, 1, 1)[0] - lumaGrid(img, {x: 0, y: 0, w: img.w, h: img.h}, 1, 1)[0]) > 0.05);
  assert.deepEqual(tileRects({w: 206, h: 112}, {cols: 2, rows: 2, gap: [6, 4]}).map(r => [r.x, r.y, r.w, r.h]), [[0, 0, 100, 54], [106, 0, 100, 54], [0, 58, 100, 54], [106, 58, 100, 54]]);
  assert.throws(() => tileRects({w: 100, h: 50}, {cols: 2, rows: 1, tile: [60, 50]}), /exceeds/);
  assert.throws(() => tileRects({w: 100, h: 50}, {cols: 0, rows: 1}), /integer cols/);
  assert.deepEqual(fittedRect({x: 0, y: 0, w: 240, h: 135}, {w: 239, h: 100}, 'contain'), {x: 0, y: (135 - 240 * 100 / 239) / 2, w: 240, h: 240 * 100 / 239});
  assert.throws(() => fittedRect({x: 0, y: 0, w: 1, h: 1}, {w: 1, h: 1}, 'cover'), /contain or fill/);
});

test('frames mode: flipped, rotated, wrong and blank tiles are reported by index; correct tiles pass', () => {
  const frames = [0, 1, 2, 3, 4, 5].map(k => frame(k));
  const tiles = [frames[0], frames[1], transform(frames[2], 'vflip'), frames[3], transform(frames[4], 'rot180'), frames[5]];
  const good = sheetOf(frames, 3), bad = sheetOf(tiles, 3);
  const ok = checkSheet(good.sheet, {layout: good.layout, frames});
  assert.equal(ok.pass, true, JSON.stringify(ok.problems));
  for (const t of ok.tiles) assert.ok(t.scores.normal < 0.01 && t.scores.vflip > 0.05, JSON.stringify(t.scores));
  const r = checkSheet(bad.sheet, {layout: bad.layout, frames});
  assert.equal(r.pass, false);
  assert.deepEqual(r.problems, [{index: 2, verdict: 'flipped'}, {index: 4, verdict: 'rot180'}]);
  assert.deepEqual(r.flipped, [2, 4]);
  // A tile holding a different picture (wrong order / broken composite) and a black tile.
  const inverted = frames[1]; const neg = {...inverted, R: inverted.R.map(v => 1 - v), G: inverted.G.map(v => 1 - v), B: inverted.B.map(v => 1 - v)};
  const odd = sheetOf([frames[0], neg, frames[2], blank(192, 108, 0), frames[4], frames[5]], 3);
  const o = checkSheet(odd.sheet, {layout: odd.layout, frames});
  assert.deepEqual(o.problems, [{index: 1, verdict: 'mismatch'}, {index: 3, verdict: 'blank'}]);
  assert.throws(() => checkSheet(good.sheet, {layout: {cols: 1, rows: 1}, frames}), /6 frames but only 1 tiles/);
});

test('a whole sheet assembled from bottom-up readbacks (every row reversed) fails every tile', () => {
  const frames = [0, 1, 2, 3].map(k => frame(k));
  const {sheet, layout} = sheetOf(frames, 4);
  const readback = transform(sheet, 'vflip');   // single row: tiles stay in place, every tile is upside down
  const r = checkSheet(readback, {layout, frames});
  assert.deepEqual(r.flipped, [0, 1, 2, 3]);
  const sky = checkSheet(readback, {layout});
  assert.equal(sky.mode, 'sky-up'); assert.deepEqual(sky.flipped, [0, 1, 2, 3]);
});

test('sky-up heuristic: bright sky above passes, an upside-down tile reads DOWN, flat tiles are not judged', () => {
  const frames = [0, 1, 2, 3].map(k => frame(k));
  const {sheet, layout} = sheetOf([frames[0], transform(frames[1], 'vflip'), blank(192, 108, 0.3), frames[3]], 2);
  const r = checkSheet(sheet, {layout});
  assert.deepEqual(r.tiles.map(t => t.verdict), ['up', 'down', 'blank', 'up']);
  assert.deepEqual(r.problems.map(p => p.index), [1, 2]);
  const t = skyUp(sheet, tileRects(sheet, layout)[0]);
  assert.ok(t.top > t.bottom + SHEET_DEFAULTS.skyMargin);
  const tile = matchTile(sheet, tileRects(sheet, layout)[0], frames[0]);
  assert.equal(tile.verdict, 'ok');
});

test('sheet-orient CLI: grid and contact-sheet layouts, exit codes and JSON report', {timeout: 120000}, async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'sheet-orient-'));
  try {
    const frames = [0, 1, 2, 3].map(k => frame(k));
    const files = [];
    for (const [i, f] of frames.entries()) { const file = path.join(d, `frame-${i}.png`); await writeFile(file, imageToPNG(f)); files.push(file); }
    const bad = sheetOf([frames[0], frames[1], transform(frames[2], 'vflip'), frames[3]], 2);
    await writeFile(path.join(d, 'bad.png'), imageToPNG(bad.sheet));
    const run = args => exec(process.execPath, [CLI, ...args]).then(r => ({code: 0, ...r}), e => ({code: e.code, stdout: e.stdout, stderr: e.stderr}));
    const r = await run(['--sheet', path.join(d, 'bad.png'), '--grid', '2x2', '--gap', '6,4', '--frames', files.join(','), '--out', path.join(d, 'r.json')]);
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stdout, /FAIL tile  2 \(row 1\) flipped/);
    assert.match(r.stdout, /FAIL sheet-orient bad\.png · mode frames · 4 tiles · 1 problems · flipped tiles: 2/);
    assert.deepEqual(JSON.parse(await readFile(path.join(d, 'r.json'), 'utf8')).flipped, [2]);
    const sky = await run(['--sheet', path.join(d, 'bad.png'), '--grid', '2x2', '--gap', '6,4']);
    assert.equal(sky.code, 3); assert.match(sky.stdout, /mode sky-up \(heuristic\)/);
    assert.equal((await run(['--sheet', path.join(d, 'bad.png')])).code, 2, 'layout is required');
    assert.equal((await run(['--sheet', path.join(d, 'bad.png'), '--grid', '2x2', '--layout', 'contact-sheet'])).code, 2);
    // A sheet from tools/contact-sheet.mjs (letterboxed 2.39:1 frames, label bands), one input pre-flipped like a raw readback.
    const {contactSheet} = await import('../contact-sheet.mjs');
    const wide = [0, 1, 2].map(k => frame(k, 239, 100));
    const wideFiles = [];
    for (const [i, f] of wide.entries()) { const file = path.join(d, `wide-${i}.png`); await writeFile(file, imageToPNG(f)); wideFiles.push(file); }
    await writeFile(path.join(d, 'wide-1-readback.png'), imageToPNG(transform(wide[1], 'vflip')));
    await contactSheet([wideFiles[0], path.join(d, 'wide-1-readback.png'), wideFiles[2]], path.join(d, 'contact.png'), {columns: 2, width: 240});
    assert.equal(decodePNG(await readFile(path.join(d, 'contact.png'))).w, 480);
    const c = await run(['--sheet', path.join(d, 'contact.png'), '--layout', 'contact-sheet:240', '--columns', '2', '--frames', wideFiles.join(',')]);
    assert.equal(c.code, 3, c.stdout + c.stderr);
    assert.match(c.stdout, /flipped tiles: 1$/m);
    await contactSheet(wideFiles, path.join(d, 'contact-ok.png'), {columns: 2, width: 240});
    const okc = await run(['--sheet', path.join(d, 'contact-ok.png'), '--layout', 'contact-sheet:240', '--columns', '2', '--frames', wideFiles.join(',')]);
    assert.equal(okc.code, 0, okc.stdout);
  } finally { await rm(d, {recursive: true, force: true}); }
});
