#!/usr/bin/env node
// Author: suwubee
// Debug snapshots of an MV page at chosen times.
//
//   node tools/cinematic/snap.mjs --page index.html --query "set=valley&quality=preview" --t 0,3.5,12 --w 960 --h 540 --out DIR [--sheet]
//
// Options
//   --page P        page path relative to the project root (default index.html)
//   --query Q       extra query string (w/h are appended automatically)
//   --t LIST        seconds: "0,3.5,12" or ranges "0:12:2" (inclusive) or both "0,5:8:1"   (default 0)
//   --frames LIST   alternatively frame indices (t = f / fps), same syntax
//   --w W --h H     viewport size, also passed as ?w=&h= (default 960x540)
//   --full          capture the whole viewport composited by Chromium (page.screenshot: includes DOM overlays)
//                   instead of the page's canvas pixels
//   --out DIR       output directory (default <project>/work/snap; env MV_WORK moves <project>/work)
//   --prefix S      file name prefix (default: value of set= in --query + "_")
//   --sheet         also write a labelled contact sheet  <out>/<prefix>sheet.png
//   --cols N        contact sheet columns (default min(4, n))
//   --method M      pixels (default) | blob | dataurl | cdp | screenshot
//   --cpus LIST     pin Chromium with taskset (e.g. "6,7,14,15"); or just run the whole command under taskset
//   --gl B          native (this machine's GPU; default on macOS/Windows) | llvmpipe (Linux server default; Mesa via a
//                   private Xvfb) | swiftshader  (env MV_GL also works)
//                   native-mode options: --channel chrome|msedge|chromium  --chrome PATH  --angle d3d11|gl|metal|vulkan  --headless
//   --flags "..."   extra Chromium flags
//   --timeout S     per-seek timeout seconds (default 180), --ready-timeout S (default 300)
//   --echo all      echo every console message (default: errors/warnings only)
//   --lenient       do not fail on console.error (still fails on page errors, shader errors, 404s)
// Exit code: 0 ok, 1 page/shader/console errors or failed requests, 2 fatal (ready/seek failed or timed out).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer } from './serve.mjs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { launchBrowser, openMvPage, parseArgs, parseTimes, problemCount, killBrowserByPidFile, glRenderer, SOFTWARE_GL_RE } from './lib/browser.mjs';
import { FrameSink, seekAndCapture } from './lib/capture.mjs';

const a = parseArgs(process.argv.slice(2), ['full', 'sheet', 'lenient', 'help', 'headless']);
if (a.help) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n')); process.exit(0); }
const W = +(a.w || 960), H = +(a.h || 540);
if(!a.root)throw Error('--root project directory required');
const WORK = process.env.MV_WORK || path.join(path.resolve(a.root),'out');
const outDir = path.resolve(a.out || path.join(WORK, 'snap'));
const setName = new URLSearchParams(a.query || '').get('set');
const prefix = a.prefix ?? (setName ? setName + '_' : '');
const method = a.full ? 'screenshot' : (a.method || 'pixels');
const seekTimeout = +(a.timeout || 180) * 1000;
fs.mkdirSync(outDir, { recursive: true });

const pidFile = path.join(outDir, `owned-snap-${process.pid}.pid`);
const sink = new FrameSink();
const server = await startServer({ root:a.root, port:+(a.port||39920), handler: sink.handler });
let browser, exitCode = 0, stats = null;
const written = [];
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms / 1000}s: ${what}`)), ms).unref())]);
try {
  browser = await launchBrowser({ cpus: a.cpus || null, gl: a.gl || null, pidFile, channel: a.channel || null, angle: a.angle || null, headless: !!a.headless, executablePath: a.chrome || null, flags: a.flags ? String(a.flags).split(/\s+/).filter(Boolean) : [] });
  const t0 = Date.now();
  const opened = await openMvPage(browser, {
    baseUrl: server.url, page: a.page || 'index.html', query: a.query || '', w: W, h: H,
    readyTimeout: +(a['ready-timeout'] || 300) * 1000, diag: { echo: a.echo === 'all' ? 'all' : 'problems' },
  });
  stats = opened.stats;
  const { page, info } = opened;
  if (browser.mvGL === 'native') {
    const renderer = await glRenderer(page);
    console.error(`[snap] GPU: ${renderer}${SOFTWARE_GL_RE.test(renderer) ? '   <-- WARNING: software renderer, no GPU acceleration (check driver / try --angle gl / --channel chrome)' : ''}`);
  }
  console.error(`[snap] ready in ${((Date.now() - t0) / 1000).toFixed(2)} s  ${opened.url}\n[snap] __mv: fps=${info.fps} duration=${info.duration} frames=${info.frames} canvas=${info.canvas && info.canvas.w + 'x' + info.canvas.h} preserveDrawingBuffer=${info.preserveDrawingBuffer} gl=${browser.mvGL}`);
  const fps = info.fps || 24;
  const times = a.frames ? parseTimes(a.frames).map((f) => f / fps) : parseTimes(a.t ?? '0');
  const shots = [];
  for (const t of times) {
    const t1 = Date.now();
    const r = await withTimeout(seekAndCapture(page, t, { method, sink, format: 'png', full: !!a.full }), seekTimeout, `seek(${t})`);
    const buf = await r.encode;
    const file = path.join(outDir, `${prefix}t${t.toFixed(3).padStart(7, '0')}.png`);
    fs.writeFileSync(file, buf);
    written.push(file);
    shots.push({ t, buf });
    console.log(file);
    console.error(`[snap] t=${t.toFixed(3)} seek ${r.seekMs.toFixed(0)} ms, capture ${r.capMs.toFixed(0)} ms, total ${Date.now() - t1} ms, ${r.w}x${r.h}`);
  }
  if (a.sheet && shots.length) {
    const file = path.join(outDir, `${prefix}sheet.png`);
    makeSheet(shots, file, +(a.cols || Math.min(4, shots.length)));
    console.log(file);
  }
} catch (e) {
  console.error(`[snap] FATAL: ${e.message}`);
  exitCode = 2;
} finally {
  if (browser) await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 10000).unref())]);
  await killBrowserByPidFile(pidFile); // no-op if it already exited; guarantees no orphan after a hang
  try { fs.unlinkSync(pidFile); } catch {}
  await server.close();
}
if (stats) {
  const n = problemCount(stats, { strictConsole: !a.lenient });
  console.error(`[snap] ${written.length} image(s); page errors ${stats.pageErrors.length}, shader errors ${stats.shaderErrors.length}, console errors ${stats.consoleErrors.length}, warnings ${stats.warnings.length}, failed requests ${stats.failedRequests.length}${stats.crashed ? ', RENDERER CRASHED' : ''}`);
  if (n && !exitCode) exitCode = 1;
}
process.exit(exitCode);

/** Contact sheet with ffmpeg: each image labelled with its time, tiled cols x rows. */
function makeSheet(shots, file, cols) {
  const label = s => `,drawtext=font=monospace:text='t ${s.t.toFixed(2)}s':x=6:y=6:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=3`;
  const rows = Math.ceil(shots.length / cols);
  const tmp = fs.mkdtempSync(path.join(path.dirname(file), '.sheet-'));
  const args = ['-threads','2','-filter_complex_threads','2','-v', 'error', '-y'];
  shots.forEach((s, i) => { const f = path.join(tmp, `${i}.png`); fs.writeFileSync(f, s.buf); args.push('-i', f); });
  const tileW = 480;
  const chains = shots.map((s, i) => `[${i}:v]scale=${tileW}:-2${label(s)},setsar=1[v${i}]`);
  const filter = chains.join(';') + ';' + shots.map((_, i) => `[v${i}]`).join('') + `concat=n=${shots.length}:v=1:a=0,tile=${cols}x${rows}:padding=4:margin=4:color=0x202020[out]`;
  args.push('-filter_complex', filter, '-map', '[out]', '-frames:v', '1', '-update', '1', file);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0) throw new Error('contact sheet failed: ' + r.stderr);
}
