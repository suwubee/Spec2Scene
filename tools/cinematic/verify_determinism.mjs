#!/usr/bin/env node
// Author: suwubee
// Determinism check: the frame for time t must be bit-identical regardless of order, process and CPU set.
//
//   node tools/cinematic/verify_determinism.mjs --page index.html --k 8 [--range 0:1440] [--seed 1] [--w 1920 --h 1080]
//        [--query "quality=final"] [--cpus-a 0-3 --cpus-b 8-11] [--out work/determinism]   (Linux only: pins with taskset)
//        [--gl swiftshader|llvmpipe]   (--gl-b to use a different backend for run B = cross-backend comparison)
//
// Run A: fresh Chromium on CPU set A renders the K frames in shuffled order.
// Run B: another fresh Chromium on CPU set B renders them in a different order, each preceded by a random
//        "distractor" frame (catches state leaking between frames), and finally re-renders the first two targets
//        again in the same process (catches accumulation).
// sha256 of the raw RGBA pixels are compared; for mismatches it reports #pixels differing, max |diff|, bbox, and
// writes A/B/diff PNGs to --out. Exit 0 = all identical, 1 = mismatch, 2 = error.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer } from './serve.mjs';
import { launchBrowser, openMvPage, parseArgs, parseTimes, allowedCpus, splitCpus } from './lib/browser.mjs';
import { FrameSink, seekAndCapture } from './lib/capture.mjs';
import { encodePNGSync } from './lib/png.mjs';

const a = parseArgs(process.argv.slice(2), ['help']);
if (a.help) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n')); process.exit(0); }
const K = +(a.k || 8), seed = +(a.seed || 1), fps = +(a.fps || 24);
const [R0, R1] = String(a.range || '0:1440').split(':').map(Number);
const W = +(a.w || 1920), H = +(a.h || 1080);
if(!a.root)throw Error('--root project directory required');
const outDir = path.resolve(a.out || path.join(a.root,'out','determinism'));
const query = new URLSearchParams(a.query || '');
if (!query.get('quality')) query.set('quality', 'final');
const [defA, defB] = splitCpus(allowedCpus().slice(0,4), 2);
const cpusA = a['cpus-a'] || defA, cpusB = a['cpus-b'] || defB;

// deterministic PRNG (mulberry32) so a failing selection can be reproduced with the same --seed
let s = seed >>> 0;
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = () => R0 + Math.floor(rnd() * (R1 - R0));
let targets = a.frames ? parseTimes(a.frames).map(Math.round) : [];
if(!Number.isInteger(K)||K<1||K>100||R0<0||R1-R0<K)throw new Error('invalid sample count/range');
while (targets.length < K) { const f = pick(); if (!targets.includes(f)) targets.push(f); }
const shuffle = (arr) => { const x = [...arr]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
const orderA = shuffle(targets);
let orderB = shuffle(targets);
if (orderB.join() === orderA.join()) orderB = [...orderA].reverse();
const planB = [];
for (const f of orderB) planB.push({ f: pick(), distractor: true }, { f });
planB.push({ f: orderB[0], repeat: true }, { f: orderB[1] ?? orderB[0], repeat: true });

const sink = new FrameSink();
const server = await startServer({ root:a.root, port:+(a.port||39920), handler: sink.handler });
async function run(label, cpus, plan, gl) {
  const browser = await launchBrowser({ cpus, gl });
  try {
    const { page, stats } = await openMvPage(browser, { baseUrl: server.url, page: a.page || 'index.html', query: query.toString(), w: W, h: H, diag: { label, echo: 'problems' } });
    const res = [];
    for (const step of plan) {
      const r = await seekAndCapture(page, step.f / fps, { method: 'pixels', sink, rawOnly: true });
      const raw = await r.encode;
      if (!step.distractor) res.push({ ...step, raw, sha: crypto.createHash('sha256').update(raw.buf).digest('hex') });
      process.stderr.write(`[${label}] f${step.f}${step.distractor ? ' (distractor)' : step.repeat ? ' (repeat)' : ''} ${r.seekMs.toFixed(0)} ms\n`);
    }
    if (stats.pageErrors.length || stats.shaderErrors.length) throw new Error(`${label}: page errors: ${[...stats.pageErrors, ...stats.shaderErrors][0]}`);
    return res;
  } finally { await browser.close().catch(() => {}); }
}

let exitCode = 0;
const report={status:'RUNNING',frames:targets,size:[W,H],fps,query:query.toString(),cpusA,cpusB,comparisons:[],scope:'Same browser and backend, two fresh processes, shuffled targets, distractors and repeats'};
try {
  console.log(`[determinism] K=${K} seed=${seed} frames=${targets.join(',')} | A on cpus ${cpusA} order ${orderA.join(',')} | B on cpus ${cpusB} (with distractors + repeats)`);
  const resA = await run('A', cpusA, orderA.map((f) => ({ f })), a.gl || null);
  const resB = await run('B', cpusB, planB, a['gl-b'] || a.gl || null);
  const byA = new Map(resA.map((r) => [r.f, r]));
  const rows = [];
  for (const rb of resB) {
    const ra = byA.get(rb.f);
    const same = ra.sha === rb.sha;
    const row = { frame: rb.f, t: +(rb.f / fps).toFixed(4), kind: rb.repeat ? 'B repeat' : 'B', identical: same, sha: ra.sha.slice(0, 16) };
    if (!same) {
      const A8 = ra.raw.buf, B8 = rb.raw.buf, w = ra.raw.w, h = ra.raw.h;
      let n = 0, maxd = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
      const diff = new Uint8Array(A8.length);
      for (let i = 0; i < A8.length; i += 4) {
        const d = Math.max(Math.abs(A8[i] - B8[i]), Math.abs(A8[i + 1] - B8[i + 1]), Math.abs(A8[i + 2] - B8[i + 2]));
        if (d) { n++; maxd = Math.max(maxd, d); const p = i >> 2, x = p % w, y = h - 1 - Math.floor(p / w); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        const v = Math.min(255, d * 32); diff[i] = v; diff[i + 1] = v; diff[i + 2] = v; diff[i + 3] = 255;
      }
      Object.assign(row, { shaB: rb.sha.slice(0, 16), diffPixels: n, diffPct: +(100 * n / (w * h)).toFixed(3), maxAbsDiff: maxd, bbox: `${x0},${y0}-${x1},${y1}` });
      fs.mkdirSync(outDir, { recursive: true });
      const base = path.join(outDir, `f${String(rb.f).padStart(5, '0')}_${rb.repeat ? 'repeat' : 'B'}`);
      fs.writeFileSync(base + '_A.png', encodePNGSync(A8, w, h, { flip: true }));
      fs.writeFileSync(base + '_B.png', encodePNGSync(B8, w, h, { flip: true }));
      fs.writeFileSync(base + '_diffx32.png', encodePNGSync(diff, w, h, { flip: true }));
      row.files = base + '_{A,B,diffx32}.png';
      exitCode = 1;
    }
    rows.push(row);
  }
  console.table(rows.map(({ files, ...r }) => r));
  report.comparisons=rows;report.status=exitCode?'FAIL':'PASS';
  rows.filter((r) => r.files).forEach((r) => console.log(`[determinism] f${r.frame} images: ${r.files}`));
  console.log(exitCode ? `[determinism] FAIL: ${rows.filter((r) => !r.identical).length}/${rows.length} comparisons differ` : `[determinism] PASS: all ${rows.length} comparisons bit-identical (${K} frames, 2 processes, different CPU sets and orders, + distractors/repeats)`);
} catch (e) {
  console.error('[determinism] ERROR ' + e.message);
  exitCode = 2;
  report.status='ERROR';report.error=e.stack;
} finally {
  await server.close();
  fs.mkdirSync(outDir,{recursive:true});fs.writeFileSync(path.join(outDir,'report.json'),JSON.stringify(report,null,2)+'\n');
}
process.exit(exitCode);
