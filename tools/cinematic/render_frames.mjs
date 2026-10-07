#!/usr/bin/env node
// Author: suwubee
// Parallel, resumable, deterministic frame renderer.
//
//   node tools/cinematic/render_frames.mjs --page index.html --fps 24 --range 0:1440 --workers 4 --taskset 0-15 \
//        --out work/frames --format png --quality final [--resume] [--every 1] [--scale 1]
//
// Frame f is rendered at t = f / fps (never wall-clock). Files: <out>/f%05d.<ext> (absolute frame index).
// Workers = independent Chromium processes pulling contiguous chunks (--chunk frames) from a shared queue
// (locality inside a chunk + dynamic load balancing across heavy/light shots).
//
// Options
//   --page P            page path relative to project root (default index.html)
//   --query Q           extra query (quality=, w=, h= are added)
//   --quality final|preview   (default final)
//   --fps N             default 24
//   --range A:B         frames A..B-1 (default 0:1440)
//   --frames LIST       explicit frame list instead of --range ("0,10,20:30")
//   --every K           every K-th frame of the range (previews)
//   --w W --h H         canvas/viewport size before --scale (default 1920x1080)
//   --scale S           multiply w/h (e.g. 0.5 -> 960x540)
//   --workers N         Chromium processes (default 1)
//   --taskset LIST      CPUs for the workers (default: this process' affinity)
//   --pin split|shared  split = disjoint CPU subsets per worker, siblings kept together (default); shared = all share LIST
//   --nproc auto|off|N  SwiftShader worker threads per Chromium (LD_PRELOAD shim, see tools/cinematic/lib/nproc_shim.c);
//                       auto = size of the worker's CPU set (default), off = Chromium default (16 = all CPUs)
//   --out DIR           output directory (required)
//   --format png|jpg    png = readPixels + Node PNG (lossless, default); jpg = Chromium JPEG (--jpg-quality 95)
//   --method M          override capture method (pixels|blob|cdp|dataurl|screenshot)
//   --png-level L       zlib level 1..9 (default 1)   --png-filter sub|up|paeth|none (default sub)
//   --chunk N           frames per work unit (default 24)
//   --resume            skip frames whose file exists and is complete
//   --frame-timeout S   per-frame timeout (default 600); hung/crashed worker is killed, restarted and the frame retried
//   --ready-timeout S   page startup timeout (default 600)
//   --retries N         retries per frame (default 3)
//   --lenient           keep going on page errors / shader errors (default: abort the render on them)
//   --flags "..."       extra Chromium flags
//   --gl B              native | llvmpipe | swiftshader; env MV_GL. NEVER mix backends inside one film render
//                       (last-bit differences, see PERF.md).
//                       native     = this machine's real GPU (Chrome/Chromium window, no Xvfb/taskset). DEFAULT on macOS/Windows,
//                                    and on Linux desktops without Xvfb. 1-3 workers are plenty (they share the GPU).
//                       llvmpipe   = Mesa software GL on a private Xvfb per worker (DEFAULT on Linux servers; no GPU needed)
//                       swiftshader= slow software fallback
//   native-mode options: --channel chrome|msedge|chromium (use an installed browser instead of Playwright's Chromium)
//                        --chrome PATH (explicit browser binary)  --angle d3d11|gl|metal|vulkan (force ANGLE backend)
//                        --headless (new headless mode, no window; headed is the default)
//   --log-every S       progress line period (default 15)
// State: <out>/render_state.json (rewritten every few seconds), per-frame log: <out>/render_log.jsonl
// Exit: 0 all frames present, 3 frames missing/failed, 4 aborted on page error, 130 interrupted.
process.env.UV_THREADPOOL_SIZE ||= '2';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startServer } from './serve.mjs';
import { launchBrowser, openMvPage, parseArgs, parseTimes, allowedCpus, parseCpuList, splitCpus, killBrowserByPidFile, glRenderer, SOFTWARE_GL_RE, DEFAULT_GL } from './lib/browser.mjs';
import {finite,rangeFrames,renderIdentity,checkResume} from './lib/plan.mjs';
import { FrameSink, seekAndCapture } from './lib/capture.mjs';

const a = parseArgs(process.argv.slice(2), ['resume', 'lenient', 'help', 'dry-run', 'headless']);
if (a.help || !a.out) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
  process.exit(a.help ? 0 : 1);
}
const fps = +(a.fps || 24);
const every = +(a.every || 1);
const scale = +(a.scale || 1);
const W = Math.round(+(a.w || 1920) * scale / 2) * 2, H = Math.round(+(a.h || 1080) * scale / 2) * 2;
const format = (a.format || 'png').toLowerCase().replace('jpeg', 'jpg');
const ext = format;
const method = a.method || (format === 'png' ? 'pixels' : 'blob');
const nWorkers = +(a.workers || 1);
const chunkSize = +(a.chunk || 24);
const frameTimeout = +(a['frame-timeout'] || 600) * 1000;
const readyTimeout = +(a['ready-timeout'] || 600) * 1000;
const retries = +(a.retries ?? 3);
const strict = !a.lenient;
const outDir = path.resolve(a.out);
const pageRel = a.page || 'index.html';
const query = new URLSearchParams(a.query || '');
query.set('quality', a.quality || query.get('quality') || 'final');
const extraFlags = a.flags ? String(a.flags).split(/\s+/).filter(Boolean) : [];
const logEvery = +(a['log-every'] || 15) * 1000;
const stateFile = path.join(outDir, 'render_state.json');
fs.mkdirSync(outDir, { recursive: true });

finite(fps,'fps',1,120);finite(every,'every',1,100000,true);finite(scale,'scale',.1,2);
finite(W,'width',16,4096,true);finite(H,'height',16,4096,true);finite(nWorkers,'workers',1,2,true);finite(chunkSize,'chunk',1,1000,true);finite(retries,'retries',0,5,true);
finite(frameTimeout,'frame timeout',1000,600000);finite(readyTimeout,'ready timeout',1000,600000);
if(!['png','jpg'].includes(format))throw Error('format must be png or jpg');
if(!a.root)throw Error('--root project directory required');
// ---- frame list ----
let frames = [];
if (a.frames) frames = parseTimes(a.frames).map((x) => Math.round(x));
else {
  const [r0, r1] = String(a.range || '0:1440').split(':').map(Number);
  frames=rangeFrames(r0,r1,every);
}
if (a.frames && every > 1) frames = frames.filter((_, i) => i % every === 0);
if(!frames.length)throw Error('empty render plan');
frames.forEach(f=>finite(f,'frame',0,1e7,true));
const estimatedGiB=frames.length*W*H*4/(1024**3),maxGiB=finite(+(a['max-gib']||4),'max-gib',.01,32);
if(estimatedGiB>maxGiB)throw Error(`raw frame budget ${estimatedGiB.toFixed(2)} GiB exceeds --max-gib ${maxGiB}`);
const fileOf = (f) => path.join(outDir, `f${String(f).padStart(5, '0')}.${ext}`);

function isComplete(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 64) return false;
    const head = Buffer.alloc(8), tail = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 8, 0);
    fs.readSync(fd, tail, 0, 12, size - 12);
    if (ext === 'png') return head.readUInt32BE(0) === 0x89504e47 && tail.toString('latin1', 4, 8) === 'IEND';
    if (ext === 'jpg') return head[0] === 0xff && head[1] === 0xd8 && tail[10] === 0xff && tail[11] === 0xd9;
    return true;
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

let skipped = 0;
let todo = frames;
if (a.resume) { todo = frames.filter((f) => !isComplete(fileOf(f))); skipped = frames.length - todo.length; }
const queue = [];
for (let i = 0; i < todo.length; i += chunkSize) queue.push(todo.slice(i, i + chunkSize));

// ---- CPU layout ----
const cpuList = a.taskset ? parseCpuList(a.taskset) : allowedCpus().slice(0,4);
const pinMode = a.pin || 'split';
const nprocMode = String(a.nproc || 'auto');
const glMode = a.gl || process.env.MV_GL || DEFAULT_GL;
const nativeGL = ['native', 'gpu', 'hw'].includes(String(glMode));   // real GPU: no CPU pinning / thread shim / Xvfb
const cpuSets = nativeGL ? Array(nWorkers).fill(null)
  : pinMode === 'split' && nWorkers <= cpuList.length ? splitCpus(cpuList, nWorkers) : Array(nWorkers).fill(cpuList.join(','));

if(cpuList.length>4)throw Error('shared-server CPU budget: at most four CPUs');
if(nprocMode==='off')throw Error('unbounded threads are disabled; use --nproc 1..4 or auto');
if(nprocMode!=='auto')finite(+nprocMode,'nproc',1,4,true);
const identity=await renderIdentity(a.root,{page:pageRel,query:query.toString(),width:W,height:H,fps,format,method,gl:glMode,cpuSets,nproc:nprocMode,flags:extraFlags,executable:a.chrome||null,channel:a.channel||null,angle:a.angle||null});
const identityFile=await checkResume(outDir,identity,!!a.resume);
const plan = {estimatedGiB:+estimatedGiB.toFixed(3),maxGiB, page: pageRel, query: query.toString(), size: `${W}x${H}`, fps, frames: frames.length, todo: todo.length, skipped, chunks: queue.length, workers: nWorkers, cpuSets, nproc: nprocMode, gl: glMode, method, format, out: outDir };
console.log('[render] plan ' + JSON.stringify(plan));
if (a['dry-run']) process.exit(0);
await fsp.writeFile(identityFile,JSON.stringify(identity,null,2)+'\n');

// ---- state / logging ----
const T0 = Date.now(); // wall clock for progress/ETA display only; never reaches the page
const state = {
  version: 1, pid:process.pid, status: 'running', ...plan, startedAt: new Date(T0).toISOString(), updatedAt: null,
  done: 0, failed: [], restarts: 0, pageErrors: 0, shaderErrors: 0, consoleErrors: 0,
  elapsedSec: 0, framesPerSec: 0, etaSec: null, avgSeekMs: 0, avgCapMs: 0, workers: [],
};
const logStream = fs.createWriteStream(path.join(outDir, 'render_log.jsonl'), { flags: 'a' });
const recent = []; // [wallMs] of recently finished frames, for throughput
let sumSeek = 0, sumCap = 0, nTimed = 0;
const hms = (s) => { if (s == null || !Number.isFinite(s)) return '--:--:--'; s = Math.round(s); return [s / 3600 | 0, (s / 60 | 0) % 60, s % 60].map((x) => String(x).padStart(2, '0')).join(':'); };
function updateStats() {
  const now = Date.now();
  state.elapsedSec = +((now - T0) / 1000).toFixed(1);
  while (recent.length && now - recent[0] > 180000) recent.shift();
  const windowSec = Math.min(180, (now - T0) / 1000);
  const fpsWin = recent.length >= 2 ? recent.length / Math.max(1, (now - recent[0]) / 1000) : state.done / Math.max(1, windowSec);
  state.framesPerSec = +fpsWin.toFixed(3);
  const remaining = todo.length - state.done - state.failed.length;
  state.etaSec = fpsWin > 0 ? Math.round(remaining / fpsWin) : null;
  state.avgSeekMs = nTimed ? Math.round(sumSeek / nTimed) : 0;
  state.avgCapMs = nTimed ? Math.round(sumCap / nTimed) : 0;
  state.updatedAt = new Date(now).toISOString();
}
let stateWriting = false;
async function writeState() {
  if (stateWriting) return;
  stateWriting = true;
  try {
    updateStats();
    const tmp = stateFile + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(state, null, 1));
    await fsp.rename(tmp, stateFile);
  } catch (e) { console.error('[render] state write failed: ' + e.message); } finally { stateWriting = false; }
}
function progressLine() {
  updateStats();
  const pct = ((state.done + skipped) / frames.length * 100).toFixed(1);
  const ws = state.workers.map((w) => `w${w.id}:${w.frame ?? '-'}`).join(' ');
  console.log(`[render] ${hms(state.elapsedSec)} | ${state.done + skipped}/${frames.length} (${pct}%) | ${state.framesPerSec.toFixed(2)} f/s | seek ${(state.avgSeekMs / 1000).toFixed(2)} s/f/worker | cap ${state.avgCapMs} ms | ETA ${hms(state.etaSec)} | restarts ${state.restarts} failed ${state.failed.length} | ${ws}`);
}
const ticker = setInterval(() => { progressLine(); writeState(); }, logEvery);
const stateTicker = setInterval(writeState, 3000);

// ---- worker ----
const sink = new FrameSink();
const server = await startServer({ root:a.root, port:+(a.port||39920), handler: sink.handler });
let aborted = null, interrupted = false;
const withTimeout = (p, ms, what) => {
  let timer;
  const pp = Promise.resolve(p);
  pp.catch(() => {}); // a late rejection (after we gave up and killed the browser) must not crash the process
  return Promise.race([pp, new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`timeout after ${ms / 1000}s: ${what}`), { timeout: true })), ms); })]).finally(() => clearTimeout(timer));
};
const frameFailures = new Map(); // frame -> failed encode/write attempts
function requeueLost(worker, lost) {
  for (const lf of lost) {
    const n = (frameFailures.get(lf) || 0) + 1;
    frameFailures.set(lf, n);
    if (n > retries) { state.failed.push(lf); worker.log(`frame ${lf} FAILED (encode/write) after ${n} attempts`); }
    else queue.unshift([lf]);
  }
}
process.on('unhandledRejection', (e) => console.error('[render] unhandled rejection (ignored): ' + (e && e.message)));

class Worker {
  constructor(id, cpus) {
    this.id = id; this.cpus = cpus; this.ctx = null; this.pending = [];
    this.pidFile = path.join(outDir, `owned-render-${process.pid}-w${id}.pid`);
    this.st = { id, cpus, status: 'idle', frame: null, framesDone: 0, restarts: 0, lastError: null, readyMs: null };
    state.workers.push(this.st);
  }
  log(s) { console.log(`[w${this.id}] ${s}`); }
  async start() {
    this.st.status = 'starting';
    const t0 = Date.now();
    const nproc = this.cpus == null ? 'off' : nprocMode === 'off' ? 'off' : nprocMode === 'auto' ? parseCpuList(this.cpus).length : +nprocMode;
    const browser = await launchBrowser({
      cpus: this.cpus, flags: extraFlags, pidFile: this.pidFile, nproc, gl: glMode,
      channel: a.channel || null, angle: a.angle || null, headless: !!a.headless, executablePath: a.chrome || null,
    });
    try {
      if(browser.mvGL!==glMode)throw Error('backend fallback refused for an identified render; select the actual backend explicitly');
      const opened = await openMvPage(browser, {
        baseUrl: server.url, page: pageRel, query: query.toString(), w: W, h: H, readyTimeout,
        diag: { label: `w${this.id}`, echo: 'problems', maxEcho: 30, log: (s) => console.log(s) },
      });
      this.ctx = { browser, ...opened, errBase: { p: 0, s: 0, c: 0 } };
      browser.on('disconnected', () => { if (this.ctx && this.ctx.browser === browser) this.ctx.disconnected = true; });
      const { info } = opened;
      if (info.canvas && (info.canvas.w !== W || info.canvas.h !== H)) this.log(`WARNING canvas is ${info.canvas.w}x${info.canvas.h}, expected ${W}x${H}`);
      if (info.fps && info.fps !== fps) this.log(`WARNING page fps=${info.fps} but --fps ${fps}`);
      this.st.readyMs = Date.now() - t0;
      try { this.st.pid = +fs.readFileSync(this.pidFile, 'utf8').trim() || null; } catch { this.st.pid = null; } // native GPU mode has no pid file
      this.st.status = 'ready';
      this.st.gl = browser.mvGL;
      let renderer = '';
      if (browser.mvGL === 'native') {
        this.st.renderer = await glRenderer(opened.page);
        renderer = `, GPU "${this.st.renderer}"`;
        if (SOFTWARE_GL_RE.test(this.st.renderer)) this.log(`WARNING: WebGL is running on a SOFTWARE renderer ("${this.st.renderer}") - no GPU acceleration. Check your GPU driver, or try --angle gl / --channel chrome.`);
      }
      this.log(`ready in ${(this.st.readyMs / 1000).toFixed(1)} s (${this.cpus == null ? 'no cpu pinning' : 'cpus ' + this.cpus}, pid ${this.st.pid}, gl ${browser.mvGL}${renderer})`);
    } catch (e) {
      await this.kill();
      await browser.close().catch(() => {});
      throw e;
    }
  }
  async kill() {
    const ctx = this.ctx; this.ctx = null;

    if (ctx) await withTimeout(ctx.browser.close(), 10000, 'close').catch(async () => {await killBrowserByPidFile(this.pidFile);});
    try { fs.unlinkSync(this.pidFile); } catch {}
  }
  checkErrors() {
    const s = this.ctx.stats;
    if (s.crashed) throw new Error('renderer process crashed (browser will be restarted)');
    const np = s.pageErrors.length, ns = s.shaderErrors.length, nc = s.consoleErrors.length;
    const b = this.ctx.errBase;
    state.pageErrors += np - b.p; state.shaderErrors += ns - b.s; state.consoleErrors += nc - b.c;
    const bad = (np > b.p || ns > b.s);
    const lost = s.consoleErrors.slice(b.c).some((m) => m.includes('mv-webgl-context-lost'));
    this.ctx.errBase = { p: np, s: ns, c: nc };
    if (lost) throw new Error('WebGL context lost (frame discarded, browser will be restarted)');
    if (bad && strict) {
      const msg = (s.shaderErrors.at(-1) || s.pageErrors.at(-1) || '?').slice(0, 2000);
      throw Object.assign(new Error(`page/shader error (use --lenient to ignore): ${msg}`), { fatal: true });
    }
  }
  async renderFrame(f) {
    const t = f / fps; // deterministic time
    const r = await withTimeout(
      seekAndCapture(this.ctx.page, t, { method, sink, format, quality: +(a['jpg-quality'] || 95), pngLevel: +(a['png-level'] || 1), pngFilter: a['png-filter'] || 'sub', uploadTimeoutMs: 60000 }),
      frameTimeout, `frame ${f} (t=${t.toFixed(4)})`);
    this.checkErrors();
    const file = fileOf(f);
    const job = withTimeout(r.encode, frameTimeout, `encode ${f}`).then(async (buf) => {
      const tmp = file + '.tmp' + this.id;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, file);
      state.done++; this.st.framesDone++;
      recent.push(Date.now());
      sumSeek += r.seekMs; sumCap += r.capMs; nTimed++;
      logStream.write(JSON.stringify({ f, w: this.id, seekMs: Math.round(r.seekMs), capMs: Math.round(r.capMs), bytes: buf.length, doneAtMs: Date.now() - T0 }) + '\n');
    });
    this.pending.push({ f, job, uploadId: r.uploadId });
    // keep at most 2 frames in flight per worker (bounded memory)
    while (this.pending.length > 2) await this.settleOldest();
  }
  async settleOldest() {
    const p = this.pending.shift();
    try { await p.job; } catch (e) { this.log(`encode/write failed for frame ${p.f}: ${e.message}`); return p.f; }
    return null;
  }
  async flush() {
    const failedFrames = [];
    while (this.pending.length) { const f = await this.settleOldest(); if (f != null) failedFrames.push(f); }
    return failedFrames;
  }
  async run() {
    let startFailures = 0;
    for (;;) {
      if (aborted || interrupted) break;
      const chunk = queue.shift();
      if (!chunk) {
        const lost = await this.flush();
        if (lost.length) { requeueLost(this, lost); continue; }
        if (queue.length) continue;
        break;
      }
      for (let i = 0; i < chunk.length && !aborted && !interrupted; i++) {
        const f = chunk[i];
        let attempt = 0;
        for (;;) {
          try {
            if (!this.ctx) {
              try { await this.start(); startFailures = 0; }
              catch (e) {
                startFailures++;
                this.st.lastError = e.message.split('\n')[0];
                this.log(`start failed (${startFailures}/${retries+1}): ${e.message.split('\n')[0]}`);
                if (startFailures >= retries+1) {
                  queue.unshift(chunk.slice(i));
                  this.st.status = 'gave up';
                  return;
                }
                if (aborted || interrupted) return;
                await new Promise((r) => setTimeout(r, 2000 * startFailures));
                continue;
              }
            }
            this.st.frame = f; this.st.status = 'rendering';
            await this.renderFrame(f);
            break;
          } catch (e) {
            if (e.fatal) { aborted = e; this.log('ABORT: ' + e.message); await this.flush(); await this.kill(); return; }
            if (interrupted) return;
            attempt++;
            this.st.lastError = `frame ${f}: ${e.message.split('\n')[0]}`;
            this.log(`frame ${f} attempt ${attempt} failed: ${e.message.split('\n')[0]} -> restarting browser`);
            // uploads still in flight from the dying browser: give them 3 s, then give up on them (frames get requeued)
            await Promise.race([Promise.allSettled(this.pending.map((p) => p.job)), new Promise((r) => setTimeout(r, 3000))]);
            this.pending.forEach((p) => p.uploadId && sink.fail(p.uploadId, new Error('browser died before upload')));
            requeueLost(this, await this.flush()); // frames already captured by the dying browser still get written
            await this.kill();
            this.st.restarts++; state.restarts++;
            if (attempt > retries) { state.failed.push(f); this.log(`frame ${f} FAILED after ${attempt} attempts`); break; }
          }
        }
      }
    }
    requeueLost(this, await this.flush());
    this.st.status = 'finished'; this.st.frame = null;
    await this.kill();
  }
}

const workers = cpuSets.map((c, i) => new Worker(i, c));
const onSignal = async (sig) => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log(`[render] ${sig}: stopping workers (state saved; rerun with --resume)`);
  await Promise.all(workers.map((w) => w.kill()));
  state.status = 'interrupted';
  await writeState();
  process.exit(130);
};
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

// stagger starts slightly so N browsers don't bake their startup textures in lock-step
await Promise.all(workers.map((w, i) => new Promise((r) => setTimeout(r, i * 300)).then(() => w.run())));
clearInterval(ticker); clearInterval(stateTicker);
await server.close();
logStream.end();

// ---- verification ----
const missing = frames.filter((f) => !isComplete(fileOf(f)));
const ranges = (list) => {
  const out = []; let s = null, p = null;
  for (const f of list) { if (s === null) { s = p = f; } else if (f === p + every) { p = f; } else { out.push(s === p ? `${s}` : `${s}-${p}`); s = p = f; } }
  if (s !== null) out.push(s === p ? `${s}` : `${s}-${p}`);
  return out.join(',');
};
state.missing = missing.length;
state.missingFrames = ranges(missing);
state.status = aborted ? 'aborted' : missing.length ? 'incomplete' : 'complete';
progressLine();
await writeState();
const wall = (Date.now() - T0) / 1000;
console.log(`[render] ${state.status}: ${frames.length - missing.length}/${frames.length} frames present in ${outDir} (rendered ${state.done}, resumed ${skipped}) in ${hms(wall)}; ` +
  `${state.done ? (wall / state.done).toFixed(3) : '-'} s/frame wall, avg seek ${state.avgSeekMs} ms, restarts ${state.restarts}, page errors ${state.pageErrors}, shader errors ${state.shaderErrors}, console errors ${state.consoleErrors}`);
if (missing.length) console.log(`[render] MISSING frames: ${state.missingFrames}`);
if (aborted) console.log(`[render] aborted: ${aborted.message}`);
process.exit(aborted ? 4 : missing.length ? 3 : 0);
