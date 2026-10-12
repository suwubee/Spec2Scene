#!/usr/bin/env node
// Contact-sheet orientation check (model-free, pure JS PNG decode). WebGL readPixels returns rows bottom-up, so a
// sheet assembled from raw readbacks comes out upside down while the source frames are fine. Two modes:
//
//   frames  --frames a.png,b.png,… | --frames-dir DIR   each tile is compared with its own capture-tool frame at a
//           small common size in four orientations (normal, vflip, hflip, rot180). A tile whose best match is not
//           "normal" (by more than --margin) is FLIPPED; a tile that matches none (MAE > --match-max) is MISMATCH
//           (wrong frame, wrong order or a broken tile); a near-constant tile is BLANK. Authoritative.
//   sky-up  (no frames) heuristic: mean luma of the top --band of each tile against the bottom band. A tile whose
//           bottom is brighter by more than --margin is reported DOWN (probably flipped). Only valid for exterior
//           shots whose sky is brighter than the ground; interiors and lit floors need frames mode.
//
// Layout: --grid COLSxROWS with optional --offset x,y --gap gx,gy --tile WxH (default: the sheet divided evenly), or
// --layout contact-sheet[:WIDTH] for sheets from tools/contact-sheet.mjs (WIDTH×WIDTH·9/16 thumbnails, 30 px label
// band under each, frames fitted with "contain"). --fit contain|fill says how frames were scaled into tiles.
// Exit 0 PASS, 3 flipped/mismatch/blank/down tiles, 2 usage error.
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {decodePNG} from './picture-qa/png.mjs';
import {cli, isMain, number, atomic} from './lib/cli.mjs';

export const SHEET_DEFAULTS = Object.freeze({grid: 48, margin: 0.02, matchMax: 0.08, blankStd: 0.004, band: 0.2, skyMargin: 0.02});
export const ORIENTATIONS = Object.freeze(['normal', 'vflip', 'hflip', 'rot180']);

const lumaAt = (img, i) => 0.2126 * img.R[i] + 0.7152 * img.G[i] + 0.0722 * img.B[i];

/** Box-average the rect {x,y,w,h} of img to a gw×gh luma grid (Float64Array, row-major, top row first). */
export function lumaGrid(img, rect, gw, gh) {
  const out = new Float64Array(gw * gh), cnt = new Float64Array(gw * gh);
  const x0 = Math.max(0, Math.round(rect.x)), y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(img.w, Math.round(rect.x + rect.w)), y1 = Math.min(img.h, Math.round(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0) throw new RangeError(`tile ${JSON.stringify(rect)} lies outside the ${img.w}×${img.h} sheet`);
  for (let y = y0; y < y1; y++) {
    const gy = Math.min(gh - 1, Math.floor((y - y0) * gh / (y1 - y0)));
    for (let x = x0; x < x1; x++) {
      const gx = Math.min(gw - 1, Math.floor((x - x0) * gw / (x1 - x0))), k = gy * gw + gx;
      out[k] += lumaAt(img, y * img.w + x); cnt[k]++;
    }
  }
  for (let k = 0; k < out.length; k++) out[k] = cnt[k] ? out[k] / cnt[k] : 0;
  return out;
}

export function orient(grid, gw, gh, how) {
  if (how === 'normal') return grid;
  const out = new Float64Array(grid.length);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const sx = how === 'hflip' || how === 'rot180' ? gw - 1 - x : x, sy = how === 'vflip' || how === 'rot180' ? gh - 1 - y : y;
    out[y * gw + x] = grid[sy * gw + sx];
  }
  return out;
}

const mae = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
const std = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };

/** Tile rectangles in reading order. layout: {cols, rows, offset:[x,y], gap:[gx,gy], tile:[w,h]}. */
export function tileRects(sheet, {cols, rows, offset = [0, 0], gap = [0, 0], tile} = {}) {
  if (!(Number.isInteger(cols) && cols >= 1 && Number.isInteger(rows) && rows >= 1)) throw new RangeError('grid needs integer cols and rows ≥ 1');
  const tw = tile?.[0] ?? (sheet.w - offset[0] - (cols - 1) * gap[0]) / cols, th = tile?.[1] ?? (sheet.h - offset[1] - (rows - 1) * gap[1]) / rows;
  if (!(tw >= 4 && th >= 4)) throw new RangeError(`tiles of ${tw}×${th} px are too small`);
  const rects = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const rect = {x: offset[0] + c * (tw + gap[0]), y: offset[1] + r * (th + gap[1]), w: tw, h: th};
    if (rect.x + rect.w > sheet.w + 0.5 || rect.y + rect.h > sheet.h + 0.5) throw new RangeError(`tile ${rects.length} (${JSON.stringify(rect)}) exceeds the ${sheet.w}×${sheet.h} sheet; check --grid/--gap/--offset`);
    rects.push(rect);
  }
  return rects;
}

/** The part of a tile that holds the frame when it was scaled with "contain" (letterboxed) or "fill". */
export function fittedRect(rect, frame, fit = 'fill') {
  if (fit === 'fill') return rect;
  if (fit !== 'contain') throw new RangeError(`fit must be contain or fill, got ${fit}`);
  const s = Math.min(rect.w / frame.w, rect.h / frame.h), w = frame.w * s, h = frame.h * s;
  return {x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h};
}

/** Compare one tile with its source frame in the four orientations. */
export function matchTile(sheet, rect, frame, options = {}) {
  const o = {...SHEET_DEFAULTS, ...options};
  const inner = fittedRect(rect, frame, o.fit);
  const gw = o.grid, gh = Math.max(4, Math.round(o.grid * inner.h / inner.w));
  const tile = lumaGrid(sheet, inner, gw, gh), src = lumaGrid(frame, {x: 0, y: 0, w: frame.w, h: frame.h}, gw, gh);
  const scores = Object.fromEntries(ORIENTATIONS.map(how => [how, +mae(orient(tile, gw, gh, how), src).toFixed(5)]));
  const best = ORIENTATIONS.reduce((a, b) => (scores[b] < scores[a] ? b : a));
  let verdict;
  if (std(tile) < o.blankStd && std(src) >= o.blankStd) verdict = 'blank';
  else if (scores[best] > o.matchMax) verdict = 'mismatch';
  else if (best !== 'normal' && scores.normal - scores[best] > o.margin) verdict = best === 'vflip' ? 'flipped' : best;
  else verdict = 'ok';
  return {verdict, best, scores, symmetric: best === 'normal' && Math.min(scores.vflip, scores.hflip, scores.rot180) - scores.normal <= o.margin};
}

/** Sky-up heuristic for one tile: top band vs bottom band mean luma. */
export function skyUp(sheet, rect, options = {}) {
  const o = {...SHEET_DEFAULTS, ...options};
  const bandH = Math.max(1, rect.h * o.band);
  const mean = r => { const g = lumaGrid(sheet, r, 1, 1); return g[0]; };
  const top = mean({x: rect.x, y: rect.y, w: rect.w, h: bandH}), bottom = mean({x: rect.x, y: rect.y + rect.h - bandH, w: rect.w, h: bandH});
  const g = lumaGrid(sheet, rect, 16, 9);
  const verdict = std(g) < o.blankStd ? 'blank' : top - bottom > o.skyMargin ? 'up' : bottom - top > o.skyMargin ? 'down' : 'flat';
  return {verdict, top: +top.toFixed(4), bottom: +bottom.toFixed(4)};
}

/**
 * checkSheet(sheet, {layout, frames?, fit, ...}) → {pass, mode, tiles:[{index, rect, verdict, …}], flipped:[indices], problems:[…]}
 * sheet/frames: decoded images {w,h,R,G,B}. With frames, tile i is compared with frames[i] (extra tiles are padding).
 */
export function checkSheet(sheet, {layout, frames, ...options} = {}) {
  const rects = tileRects(sheet, layout);
  const tiles = [];
  if (frames?.length) {
    if (frames.length > rects.length) throw new RangeError(`${frames.length} frames but only ${rects.length} tiles in the grid`);
    frames.forEach((frame, i) => tiles.push({index: i, rect: rects[i], ...matchTile(sheet, rects[i], frame, options)}));
  } else rects.forEach((rect, i) => tiles.push({index: i, rect, ...skyUp(sheet, rect, options)}));
  const mode = frames?.length ? 'frames' : 'sky-up';
  const bad = mode === 'frames' ? t => t.verdict !== 'ok' : t => t.verdict === 'down' || t.verdict === 'blank';
  const problems = tiles.filter(bad).map(t => ({index: t.index, verdict: t.verdict}));
  const flipped = tiles.filter(t => ['flipped', 'rot180', 'hflip', 'down'].includes(t.verdict)).map(t => t.index);
  return {pass: problems.length === 0, mode, cols: layout.cols, tiles, flipped, problems};
}

export function formatSheetReport(report, name = 'sheet') {
  const lines = report.tiles.map(t => {
    const where = `tile ${String(t.index).padStart(2)} (row ${Math.floor(t.index / (report.cols || 1))})`;
    if (report.mode === 'frames') return `${t.verdict === 'ok' ? 'ok  ' : 'FAIL'} ${where} ${t.verdict.padEnd(8)} normal ${t.scores.normal} vflip ${t.scores.vflip} hflip ${t.scores.hflip} rot180 ${t.scores.rot180}${t.symmetric ? ' (near-symmetric tile: orientation weakly determined)' : ''}`;
    return `${t.verdict === 'down' || t.verdict === 'blank' ? 'FAIL' : 'ok  '} ${where} ${t.verdict.padEnd(5)} top ${t.top} bottom ${t.bottom}`;
  });
  const fl = report.flipped.length ? ` · flipped tiles: ${report.flipped.join(', ')}` : '';
  lines.push(`${report.pass ? 'PASS' : 'FAIL'} sheet-orient ${name} · mode ${report.mode}${report.mode === 'sky-up' ? ' (heuristic)' : ''} · ${report.tiles.length} tiles · ${report.problems.length} problems${fl}`);
  return lines.join('\n');
}

const pair = (v, name) => { const m = /^(-?\d+(?:\.\d+)?)[x,](-?\d+(?:\.\d+)?)$/.exec(String(v)); if (!m) throw new Error(`${name}: expected A,B or AxB`); return [Number(m[1]), Number(m[2])]; };
const readPNG = async file => decodePNG(await readFile(file), file);

if (isMain(import.meta.url)) {
  const args = cli({sheet: {type: 'string'}, frames: {type: 'string'}, 'frames-dir': {type: 'string'}, grid: {type: 'string'}, layout: {type: 'string'}, columns: {type: 'string'},
    offset: {type: 'string'}, gap: {type: 'string'}, tile: {type: 'string'}, fit: {type: 'string'}, margin: {type: 'string'}, 'match-max': {type: 'string'}, band: {type: 'string'}, out: {type: 'string'}},
  'Usage: node tools/sheet-orient.mjs --sheet SHEET.png (--grid COLSxROWS [--offset x,y --gap gx,gy --tile WxH] | --layout contact-sheet[:240] [--columns 4])\n' +
  '  [--frames a.png,b.png,… | --frames-dir DIR] [--fit fill|contain] [--margin .02 --match-max .08 --band .2] [--out report.json]\n' +
  'With frames: each tile vs its capture-tool frame in normal/vflip/hflip/rot180 → flipped, mismatch or blank tiles FAIL.\n' +
  'Without frames: sky-up heuristic (top band brighter than bottom band) — exteriors only. PNG input only.\n' +
  'Exit 0 PASS, 3 flipped/mismatch/blank tiles, 2 usage error.');
  if (args) {
    try {
      if (!args.sheet) throw new Error('missing --sheet');
      if (!!args.grid === !!args.layout) throw new Error('give exactly one of --grid or --layout');
      if (args.frames && args['frames-dir']) throw new Error('give --frames or --frames-dir, not both');
      const sheet = await readPNG(args.sheet);
      let frameFiles = [];
      if (args.frames) frameFiles = args.frames.split(',').filter(Boolean);
      if (args['frames-dir']) frameFiles = (await readdir(args['frames-dir'])).filter(f => /\.png$/i.test(f)).sort().map(f => path.join(args['frames-dir'], f));
      if ((args.frames || args['frames-dir']) && !frameFiles.length) throw new Error('no PNG frames found');
      let layout, fit = args.fit ?? 'fill';
      if (args.grid) {
        const [cols, rows] = pair(args.grid, 'grid');
        layout = {cols, rows, offset: args.offset ? pair(args.offset, 'offset') : [0, 0], gap: args.gap ? pair(args.gap, 'gap') : [0, 0], tile: args.tile ? pair(args.tile, 'tile') : undefined};
      } else {
        const m = /^contact-sheet(?::(\d+))?$/.exec(args.layout);
        if (!m) throw new Error('--layout must be contact-sheet[:WIDTH]');
        const width = number(m[1] ?? 240, 'layout width', 64, 1024, true), cols = number(args.columns ?? 4, 'columns', 1, 12, true), th = Math.round(width * 9 / 16);
        layout = {cols, rows: Math.round(sheet.h / (th + 30)), gap: [0, 30], tile: [width, th]};
        fit = args.fit ?? 'contain';
      }
      if (!['fill', 'contain'].includes(fit)) throw new Error('--fit must be fill or contain');
      const frames = [];
      for (const f of frameFiles) frames.push(await readPNG(f));
      const report = checkSheet(sheet, {layout, frames, fit, margin: number(args.margin ?? SHEET_DEFAULTS.margin, 'margin', 0, 1), skyMargin: number(args.margin ?? SHEET_DEFAULTS.skyMargin, 'margin', 0, 1),
        matchMax: number(args['match-max'] ?? SHEET_DEFAULTS.matchMax, 'match-max', 0, 1), band: number(args.band ?? SHEET_DEFAULTS.band, 'band', 0.02, 0.5)});
      report.sheet = args.sheet; report.frames = frameFiles;
      if (args.out) await atomic(args.out, JSON.stringify(report, null, 1) + '\n');
      console.log(formatSheetReport(report, path.basename(args.sheet)));
      process.exitCode = report.pass ? 0 : 3;
    } catch (error) { console.error(`[sheet-orient] ${error.message}`); process.exitCode = 2; }
  }
}
