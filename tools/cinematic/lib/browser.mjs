// Author: suwubee
// Shared Chromium/Playwright helpers for the MV tools (snap, render_frames, verify_determinism, benches).
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import net from 'node:net';
import {once} from 'node:events';
const ownedTemp=fs.mkdtempSync(path.join(os.tmpdir(),'scene-render-'));
const ownedBrowsers=new Map();
let launchSequence=0;
const shellQuote=s=>"'"+String(s).replaceAll("'","'\"'\"'")+"'";
process.on('exit',()=>fs.rmSync(ownedTemp,{recursive:true,force:true}));

/** Flags required for software WebGL2 (SwiftShader via ANGLE) in the headless shell. */
export const SWIFTSHADER_FLAGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-webgl',
];
/** Extra flags that are harmless for offline rendering (measured effect: see tools/cinematic/README.md). */
export const RENDER_FLAGS = [
  '--disable-gpu-compositing', // compositor in software: -3..5 % frame time, -6 ms capture, faster startup (PERF.md)
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--mute-audio',
  '--js-flags=--max-old-space-size=2048',
];

/** 'native' backend = the machine's real GPU through Chromium's own ANGLE (D3D11 on Windows, Metal on macOS, GL/Vulkan on Linux). */
export const NATIVE_FLAGS = [
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--enable-webgl',
  '--force_high_performance_gpu', // dual-GPU laptops: prefer the discrete GPU
];
export const NATIVE_RENDER_FLAGS = RENDER_FLAGS.filter((f) => f !== '--disable-gpu-compositing');
/** WebGL renderer strings that mean "no hardware GPU" (used to warn in --gl native mode). */
export const SOFTWARE_GL_RE = /swiftshader|llvmpipe|softpipe|software|microsoft basic|mesa offscreen/i;

export function headlessShellPath() {return null;}

/**
 * Launch Chromium.
 *  cpus   "0-3,8-11": pin the browser and its whole process tree (GPU, renderer) with taskset (via a wrapper script).
 *  nproc  'auto' (default) | N | 'off': LD_PRELOAD tools/cinematic/lib/nproc_shim.c into Chromium: SwiftShader gets N worker
 *         threads and cannot re-pin them (marl pins its workers to CPU *indices* 0..N-1 = the WRONG CPUs whenever
 *         Chromium runs under taskset). 'auto' = number of CPUs in `cpus` (or in this process' affinity).
 *  pidFile  file that receives the browser PID (for hard kills).
 *  gl     'llvmpipe' (DEFAULT_GL: full Chrome headful on a private Xvfb display, ANGLE->OpenGL->Mesa llvmpipe, 4-7x
 *         faster, see tools/cinematic/README.md) or 'swiftshader' (headless shell, ANGLE->Vulkan->SwiftShader). Env MV_GL overrides.
 *         'native' (alias 'gpu'): the machine's real GPU (headed Chromium/Chrome, no Xvfb/taskset/LD_PRELOAD; works on
 *         Windows, macOS and Linux desktops). Extra options for it: channel ('chrome'|'msedge'|'chromium'), angle
 *         ('d3d11'|'gl'|'metal'|'vulkan'|'default' -> --use-angle=), headless (new headless; headed is the default),
 *         executablePath (a specific Chrome/Chromium binary).
 *  mode   'shell' (chrome-headless-shell, default) or 'new' (full Chrome, new headless mode) - swiftshader only.
 */
export async function launchBrowser({ cpus = null, flags = [], mode = 'shell', executablePath = null, env = null, timeout = 60000, pidFile = null, baseFlags = null, nproc = 'auto', gl = null, channel = null, angle = null, headless = null } = {}) {
  gl = gl || process.env.MV_GL || DEFAULT_GL;
  if (gl === 'gpu' || gl === 'hw') gl = 'native';
  if (!['swiftshader', 'llvmpipe', 'native'].includes(gl)) throw new Error(`unknown gl backend '${gl}' (native|llvmpipe|swiftshader)`);
  if (gl === 'llvmpipe' && !llvmpipeAvailable()) {
    // no Xvfb/Mesa (macOS, Windows, most Linux desktops): use the real GPU when there is a display, else the slow software fallback
    const next = (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ? 'native' : 'swiftshader';
    if (!launchBrowser.warnedGL) console.error(`[mv-tools] WARNING: llvmpipe backend unavailable (needs Linux + Xvfb on PATH + Mesa + full Chromium) -> using ${next}`);
    launchBrowser.warnedGL = true;
    gl = next;
  }
  pidFile ||= path.join(ownedTemp,`owned-browser-${++launchSequence}.pid`);
  if (gl === 'native') return launchNative({ flags, executablePath, env, timeout, baseFlags, channel, angle, headless, pidFile });
  let exe = executablePath;
  if (!exe) exe = gl === 'llvmpipe' || mode === 'new' ? chromium.executablePath() : (headlessShellPath() || chromium.executablePath());
  if (nproc === 'off' || nproc === '0') nproc = 0;
  if (nproc === 'auto') nproc = Math.min(4, cpus ? parseCpuList(cpus).length : allowedCpus().length);
  if(cpus) cpus=parseCpuList(cpus).join(',');
  let preload = null;
  if (nproc) {
    try { preload = nprocShim(); } catch (e) { if (!launchBrowser.warned) console.error('[mv-tools] WARNING: ' + e.message + ' (SwiftShader threads will not be confined to the CPU set)'); launchBrowser.warned = true; }
  }
  env = { ...(env || {}) };
  let xvfb = null;
  if (gl === 'llvmpipe') {
    xvfb = await startXvfb(cpus);
    Object.assign(env, { DISPLAY: xvfb.display, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe', MESA_SHADER_CACHE_DISABLE: 'true' });
    if (nproc) env.LP_NUM_THREADS = String(nproc);
  }
  if (cpus || pidFile || preload) {
    // wrapper: records the browser PID (exec keeps it), pins the process tree, and applies LD_PRELOAD to Chromium
    // only (taskset itself must not see the shim, otherwise its own sched_setaffinity becomes a no-op).
    const dir = ownedTemp;
    fs.mkdirSync(dir, { recursive: true });
    const body = '#!/bin/sh\n[ -n "$MV_PIDFILE" ] && echo $$ > "$MV_PIDFILE"\n'
      + `exec ${cpus ? `taskset -c ${cpus} ` : ''}${preload ? `env LD_PRELOAD=${shellQuote(preload)} MV_NPROC=${+nproc} ` : ''}${shellQuote(exe)} "$@"\n`;
    const key = crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
    const wrapper = path.join(dir, `chrome-${key}.sh`);
    if (!fs.existsSync(wrapper)) {
      const tmp = wrapper + '.' + process.pid;
      fs.writeFileSync(tmp, body, { mode: 0o755 });
      fs.renameSync(tmp, wrapper);
    }
    exe = wrapper;
    if (pidFile) env.MV_PIDFILE = pidFile;
  }
  const args = [...(baseFlags || [...(gl === 'llvmpipe' ? LLVMPIPE_FLAGS : SWIFTSHADER_FLAGS), ...RENDER_FLAGS]), ...flags];
  let browser;
  try {
    browser = await chromium.launch({ headless: gl !== 'llvmpipe', executablePath: exe || undefined, args, timeout, env: Object.keys(env).length ? { ...process.env, ...env } : undefined });
  } catch (e) {
    if (xvfb) await xvfb.kill();
    throw e;
  }
  const close=browser.close.bind(browser);
  browser.close=async()=>{try{await close();}finally{if(xvfb)await xvfb.kill();if(pidFile){console.error(`[owned] browser PID ${ownedBrowsers.get(pidFile)} closed and waited`);ownedBrowsers.delete(pidFile);}}};
  if(pidFile){ownedBrowsers.set(pidFile,Number(fs.readFileSync(pidFile,'utf8')));console.error(`[owned] browser PID ${ownedBrowsers.get(pidFile)}`);}
  browser.mvGL = gl;
  return browser;
}

/** 'native' backend: real GPU. Headed by default (a browser window is visible while rendering), --headless = new headless mode. */
async function availableControlPort() {
  for(let port=39929;port>=39920;port--){
    const free=await new Promise((resolve,reject)=>{
      const probe=net.createServer();
      probe.once('error',e=>e.code==='EADDRINUSE'?resolve(false):reject(e));
      probe.listen(port,'127.0.0.1',()=>probe.close(()=>resolve(true)));
    });
    if(free)return port;
  }
  throw Error('No free assigned loopback port for browser control');
}
async function launchNative({ flags = [], executablePath = null, env = null, timeout = 60000, baseFlags = null, channel = null, angle = null, headless = null, pidFile } = {}) {
  const useHeadless = !!headless;
  const args = [...(baseFlags || [...NATIVE_FLAGS, ...NATIVE_RENDER_FLAGS]), ...(angle && angle !== 'default' ? [`--use-angle=${angle}`] : []), ...flags];
  const opts = { headless: useHeadless, args, timeout };
  if (env && Object.keys(env).length) opts.env = { ...process.env, ...env };
  if (executablePath) opts.executablePath = executablePath;
  else if (channel) opts.channel = channel;
  else if (useHeadless) opts.channel = 'chromium'; // Playwright's opt-in to the NEW headless mode (full Chromium, real GPU); the old headless shell is software-only on some platforms
  let browser, server;
  try {
    const port=await availableControlPort();
    server = await chromium.launchServer({...opts,host:'127.0.0.1',port});
    const pid = server.process().pid;
    ownedBrowsers.set(pidFile,pid);
    fs.writeFileSync(pidFile,String(pid));
    console.error(`[owned] browser PID ${pid}, control 127.0.0.1:${port}`);
    browser = await chromium.connect(server.wsEndpoint());
  }
  catch (e) {
    if(server)await server.close();
    ownedBrowsers.delete(pidFile);
    if (/Executable doesn't exist|browserType\.launch: Failed to launch/.test(e.message) && !executablePath && !channel) {
      throw new Error(e.message + '\n[mv-tools] Chromium is not installed for Playwright: run `npx playwright install chromium`, or use your own Chrome: --channel chrome (or --chrome "<path to chrome>")');
    }
    throw e;
  }
  const close=browser.close.bind(browser);
  browser.close=async()=>{try{await close();}finally{await server.close();console.error(`[owned] browser PID ${ownedBrowsers.get(pidFile)} closed and waited`);ownedBrowsers.delete(pidFile);}};
  browser.mvGL = 'native';
  return browser;
}

/** UNMASKED_RENDERER of a page's WebGL2 context (tells you whether a real GPU or a software rasteriser is in use). */
export async function glRenderer(page) {
  try {
    return await page.evaluate(() => {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl2') || c.getContext('webgl');
      if (!g) return 'no WebGL';
      const e = g.getExtension('WEBGL_debug_renderer_info');
      return String(e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER));
    });
  } catch (e) { return 'unknown (' + String(e.message).split('\n')[0] + ')'; }
}

/** Default WebGL backend of all tools (override per call with {gl} / --gl, or globally with env MV_GL).
 *  Linux (the render server, Xvfb + Mesa llvmpipe): 'llvmpipe'; macOS / Windows: 'native' (the machine's GPU). */
export const DEFAULT_GL = process.platform === 'linux' ? 'llvmpipe' : 'native';

export function llvmpipeAvailable() {return spawnSync('Xvfb',['-help'],{stdio:'ignore'}).status===0 && fs.existsSync(chromium.executablePath());}

/** Flags for ANGLE on desktop GL (Mesa llvmpipe through GLX on Xvfb). */
export const LLVMPIPE_FLAGS = [
  '--use-gl=angle',
  '--use-angle=gl',
  '--ignore-gpu-blocklist',
  '--enable-webgl',
  '--window-position=0,0',
  '--window-size=2200,1400',
];

const xvfbProcs = new Set();
process.on('exit', () => { for (const p of xvfbProcs) { try { p.kill('SIGTERM'); } catch {} } });

/** Start a private Xvfb server (pinned like the browser; display number chosen by Xvfb itself via -displayfd). */
export async function startXvfb(cpus = null) {
  const { spawn } = await import('node:child_process');
  const cmd = cpus ? 'taskset' : 'Xvfb';
  const args = [...(cpus ? ['-c', cpus, 'Xvfb'] : []), '-displayfd', '3', '-screen', '0', '2560x1600x24', '-nolisten', 'tcp', '-noreset', '-dpi', '96'];
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
  xvfbProcs.add(p);console.error(`[owned] Xvfb PID ${p.pid}`);
  let err = '';
  p.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
  const display = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Xvfb did not report a display within 10 s: ' + err.slice(-500))), 10000);
    p.stdio[3].on('data', (d) => { buf += d; const m = /(\d+)\s*\n/.exec(buf); if (m) { clearTimeout(timer); resolve(':' + m[1]); } });
    p.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Xvfb exited (${code}): ${err.slice(-500)}`)); });
  }).catch(async(e) => { if(p.exitCode===null&&p.signalCode===null){const done=once(p,'exit');p.kill('SIGKILL');await done;}xvfbProcs.delete(p);throw e; });
  p.on('exit', () => xvfbProcs.delete(p));
  return {display,pid:p.pid,kill:async()=>{if(p.exitCode!==null||p.signalCode!==null)return;const done=once(p,'exit');p.kill('SIGTERM');const timer=setTimeout(()=>{if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');},2000);await done;clearTimeout(timer);console.error(`[owned] Xvfb PID ${p.pid} closed and waited`);}};
}

/** Build (once) the LD_PRELOAD shim that makes sysconf(_SC_NPROCESSORS_ONLN) return $MV_NPROC. */
export function nprocShim() {
  const src = fileURLToPath(new URL('./nproc_shim.c', import.meta.url));
  const dir = ownedTemp;
  const so = path.join(dir, 'libmvnproc.so');
  if (!fs.existsSync(so) || fs.statSync(so).mtimeMs < fs.statSync(src).mtimeMs) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = so + '.' + process.pid;
    const r = spawnSync('gcc', ['-O2', '-shared', '-fPIC', '-o', tmp, src, '-ldl'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('cannot build nproc shim: ' + r.stderr);
    fs.renameSync(tmp, so);
  }
  return so;
}

/** Hard-kill a browser launched with a pidFile (whole process group, then the pid). */
export async function killBrowserByPidFile(pidFile) {
  const pid=ownedBrowsers.get(pidFile);if(!pid)return false;
  try {process.kill(pid,'SIGKILL');}catch{}
  for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{ownedBrowsers.delete(pidFile);return true;}await new Promise(r=>setTimeout(r,50));}
  throw new Error('owned browser did not exit');
}

/** Expand "0-3,8-11" -> [0,1,2,3,8,9,10,11]. */
export function parseCpuList(s) {
  if(!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(String(s)))throw Error('invalid CPU list');
  const out = [];
  for (const part of String(s).split(',').map((x) => x.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map(Number);
    if(a>4096||(b!=null&&(b<a||b>4096)))throw Error('CPU range out of bounds');
    for (let c = a; c <= (Number.isFinite(b) ? b : a); c++) out.push(c);
  }
  return [...new Set(out)].sort((x, y) => x - y);
}

/** CPUs this process may run on (from /proc/self/status Cpus_allowed_list). */
export function allowedCpus() {
  try {
    const m = /Cpus_allowed_list:\s*(\S+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'));
    if (m) return parseCpuList(m[1]);
  } catch {}
  return [...Array(os.cpus().length).keys()];
}

/**
 * Split a CPU list into n disjoint sets, keeping hyperthread siblings together when there are enough cores.
 * e.g. splitCpus([0..15], 4) -> ["0,1,8,9", "2,3,10,11", "4,5,12,13", "6,7,14,15"]
 */
export function splitCpus(cpus, n) {
  const coreOf = (c) => {
    try { return fs.readFileSync(`/sys/devices/system/cpu/cpu${c}/topology/core_id`, 'utf8').trim() + ':' + fs.readFileSync(`/sys/devices/system/cpu/cpu${c}/topology/physical_package_id`, 'utf8').trim(); }
    catch { return String(c); }
  };
  const groups = new Map();
  for (const c of cpus) { const k = coreOf(c); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  let units = [...groups.values()];
  if (units.length < n) units = cpus.map((c) => [c]); // more workers than cores: split siblings
  const sets = Array.from({ length: n }, () => []);
  const per = units.length / n;
  units.forEach((u, i) => sets[Math.min(n - 1, Math.floor(i / per))].push(...u));
  return sets.map((s) => s.sort((a, b) => a - b).join(','));
}

/**
 * In-page helper installed before any page script runs:
 *  - wraps WebGL linkProgram to report shader compile/link errors WITH the offending source lines;
 *  - reports WebGL context loss;
 *  - window.__mvTools: canvas picking + seek-and-capture primitives used by the tools.
 */
export const initScript = ({ forcePDB = true } = {}) => `(() => {
  const SHOW = 2;
  const FORCE_PDB = ${forcePDB ? 'true' : 'false'};
  function report(gl, prog) {
    try {
      const parts = [];
      for (const sh of (gl.getAttachedShaders(prog) || [])) {
        if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) continue;
        const log = (gl.getShaderInfoLog(sh) || '').trim();
        const src = (gl.getShaderSource(sh) || '').split('\\n');
        const type = gl.getShaderParameter(sh, gl.SHADER_TYPE) === gl.VERTEX_SHADER ? 'VERTEX' : 'FRAGMENT';
        const ctx = [];
        const seen = new Set();
        for (const m of log.matchAll(/(?:ERROR|WARNING):\\s*\\d+:(\\d+):/g)) {
          const ln = +m[1]; if (seen.has(ln)) continue; seen.add(ln);
          for (let k = Math.max(1, ln - SHOW); k <= Math.min(src.length, ln + SHOW); k++)
            ctx.push((k === ln ? '>' : ' ') + String(k).padStart(5) + ': ' + src[k - 1]);
          ctx.push('  ---');
        }
        parts.push(type + ' shader compile error:\\n' + log + (ctx.length ? '\\n' + ctx.join('\\n') : ''));
      }
      const plog = (gl.getProgramInfoLog(prog) || '').trim();
      console.error('[mv-shader-error] ' + (parts.length ? parts.join('\\n') : 'program link error: ' + plog));
    } catch (e) { console.error('[mv-shader-error] (could not fetch log) ' + e); }
  }
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!C || C.prototype.__mvWrapped) continue;
    C.prototype.__mvWrapped = true;
    const link = C.prototype.linkProgram;
    C.prototype.linkProgram = function (prog) {
      link.call(this, prog);
      try { if (!this.getProgramParameter(prog, this.LINK_STATUS)) report(this, prog); } catch (e) {}
    };
  }
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    // Force preserveDrawingBuffer so a capture can never see a buffer that was already presented+cleared
    // (e.g. when seek() awaits a macrotask after rendering). No visual effect for pages that clear each frame.
    if (FORCE_PDB && /webgl/.test(type)) attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
    const ctx = gc.call(this, type, attrs);
    if (ctx && /webgl/.test(type) && !this.__mvLostHook) {
      this.__mvLostHook = true;
      this.addEventListener('webglcontextlost', () => console.error('[mv-webgl-context-lost] canvas ' + this.width + 'x' + this.height));
    }
    return ctx;
  };

  const T = window.__mvTools = {
    canvas() {
      const mv = window.__mv;
      if (mv && mv.canvas) return mv.canvas;
      let best = null, area = -1;
      for (const c of document.querySelectorAll('canvas')) { const a = c.width * c.height; if (a > area) { area = a; best = c; } }
      return best;
    },
    rect() {
      const c = T.canvas(); if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height, cw: c.width, ch: c.height };
    },
    glOf(c) {
      // Returns the existing context of this canvas (getContext with the same type returns it; other types give null).
      return c.getContext('webgl2') || c.getContext('webgl');
    },
    // Seek, then capture with the given method *in the same task* (safe even without preserveDrawingBuffer).
    async seekCapture(t, method, opt) {
      opt = opt || {};
      const now = () => performance.now();   // tool-side timing only
      const t0 = now();
      await window.__mv.seek(t);
      if(window.__mv.errors?.length)throw Error(window.__mv.errors.join('; '));
      const t1 = now();
      const c = T.canvas();
      const res = { w: c.width, h: c.height, seekMs: t1 - t0 };
      const glc = T.glOf(c);
      const checkLost = () => { if (glc && glc.isContextLost()) throw new Error('WebGL context lost during capture (frame discarded)'); };
      checkLost();
      if (method === 'none') {
      } else if (method === 'dataurl') {
        res.data = c.toDataURL(opt.mime || 'image/png', opt.quality);
        checkLost();
      } else if (method === 'blob') {
        const blob = await new Promise((r) => c.toBlob(r, opt.mime || 'image/png', opt.quality));
        checkLost();
        const t2 = now();
        const resp = await fetch(opt.url, { method: 'POST', body: blob });
        if (!resp.ok) throw new Error('upload failed ' + resp.status);
        await resp.arrayBuffer();
        res.encMs = t2 - t1; res.bytes = blob.size;
      } else if (method === 'pixels') {
        const gl = T.glOf(c);
        let px;
        if (gl) {
          const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
          px = (T._px && T._px.length === w * h * 4) ? T._px : (T._px = new Uint8Array(w * h * 4));
          const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
          const target = isGL2 ? gl.READ_FRAMEBUFFER : gl.FRAMEBUFFER;
          const prevFb = gl.getParameter(isGL2 ? gl.READ_FRAMEBUFFER_BINDING : gl.FRAMEBUFFER_BINDING);
          const prevPbo = isGL2 ? gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) : null;
          if (prevPbo) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          gl.bindFramebuffer(target, null);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          gl.bindFramebuffer(target, prevFb);
          if (prevPbo) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prevPbo);
          checkLost();
          const err = gl.getError();
          if (err) console.warn('[mv-capture] GL error after readPixels: 0x' + err.toString(16));
          res.w = w; res.h = h; res.flip = 1;
        } else {
          const g = c.getContext('2d');
          px = new Uint8Array(g.getImageData(0, 0, c.width, c.height).data.buffer);
          res.flip = 0;
        }
        const t2 = now();
        // NB: wrap in a Blob - posting a bare Uint8Array is ~10x slower in Chromium (228 vs 20 ms for 2 MB).
        const up = fetch(opt.url + '?w=' + res.w + '&h=' + res.h + '&flip=' + res.flip, { method: 'POST', body: new Blob([px]) })
          .then(async (resp) => { await resp.arrayBuffer(); if (!resp.ok) throw new Error('upload failed ' + resp.status); });
        if (opt.nowait) up.catch((e) => console.error('[mv-upload] ' + e)); // Node side waits for the upload itself
        else await up;
        res.readMs = t2 - t1; res.bytes = px.length;
      } else {
        throw new Error('unknown capture method ' + method);
      }
      res.capMs = now() - t1;
      return res;
    },
  };
})();`;

/**
 * Attach console / error listeners. Returns a stats object that accumulates problems.
 * opts.echo: 'all' (print every console message), 'problems' (errors+warnings, default), 'none'
 */
export function attachDiagnostics(page, { label = '', echo = 'problems', maxEcho = 200, log = (s) => console.error(s) } = {}) {
  const stats = { pageErrors: [], consoleErrors: [], warnings: [], shaderErrors: [], failedRequests: [], requests: [], crashed: false, echoed: 0 };
  const pfx = label ? `[${label}] ` : '';
  const say = (s) => { if (echo !== 'none' && stats.echoed++ < maxEcho) log(pfx + s); };
  page.on('console', (m) => {
    const type = m.type();
    const text = m.text();
    const loc = m.location && m.location();
    const where = loc && loc.url ? ` (${loc.url.replace(/^https?:\/\/[^/]+/, '')}:${loc.lineNumber})` : '';
    if (type === 'error') {
      const isShader = /\[mv-shader-error\]|Shader Error|VALIDATE_STATUS false|shader compile/i.test(text);
      (isShader ? stats.shaderErrors : stats.consoleErrors).push(text);
      say(`[console.error]${where} ${text}`);
    } else if (type === 'warning') {
      // ANGLE performance chatter ("GPU stall due to ReadPixels") is expected for our sync readPixels: ignore.
      if (/GL Driver Message \(OpenGL, Performance/.test(text)) { stats.perfNotes = (stats.perfNotes || 0) + 1; return; }
      stats.warnings.push(text);
      say(`[console.warn]${where} ${text}`);
    } else if (echo === 'all') {
      say(`[console.${type}] ${text}`);
    }
  });
  page.on('pageerror', (e) => { stats.pageErrors.push(e.stack || e.message); say(`[pageerror] ${e.stack || e.message}`); });
  page.on('request', r => { if(/^https?:/.test(r.url())) stats.requests.push(r.url()); });
  page.on('requestfailed', (r) => { const s = `${r.url()} ${r.failure() ? r.failure().errorText : ''}`; stats.failedRequests.push(s); say(`[requestfailed] ${s}`); });
  page.on('response', (r) => {
    if (r.status() >= 400) {
      const s = `${r.status()} ${r.url()}`;
      stats.failedRequests.push(s); say(`[http ${r.status()}] ${r.url()}`);
    }
  });
  page.on('crash', () => { stats.crashed = true; say('[crash] renderer process crashed'); });
  return stats;
}

export function problemCount(stats, { strictConsole = true } = {}) {
  return stats.pageErrors.length + stats.shaderErrors.length + stats.failedRequests.length + (stats.crashed ? 1 : 0)
    + (strictConsole ? stats.consoleErrors.length : 0);
}

/**
 * Open the MV page and wait for window.__mv.ready.
 * Returns { page, context, stats, info, url }.
 */
export async function openMvPage(browser, { baseUrl, page: pagePath = 'index.html', query = '', w = 1920, h = 1080, readyTimeout = 300000, diag = {}, forcePDB = true } = {}) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, bypassCSP: false });
  const page = await context.newPage();
  page.setDefaultTimeout(readyTimeout);
  await page.addInitScript(initScript({ forcePDB }));
  const stats = attachDiagnostics(page, diag);
  const q = new URLSearchParams(query || '');
  q.set('w', String(w));
  q.set('h', String(h));
  const url = baseUrl.replace(/\/$/, '') + '/' + pagePath.replace(/^\//, '') + '?' + q.toString();
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  try {
    await page.waitForFunction(() => window.__sceneError || (window.__mv && window.__mv.ready), null, { timeout: readyTimeout, polling: 100 });
  } catch (e) {
    throw new Error(`window.__mv.ready never appeared on ${url} (${e.message.split('\n')[0]})`);
  }
  const info = await page.evaluate(async () => {
    if(window.__sceneError)throw new Error(window.__sceneError);
    await window.__mv.ready;
    const mv = window.__mv;
    const c = window.__mvTools.canvas();
    return {
      duration: mv.duration, fps: mv.fps, width: mv.width, height: mv.height, frames: mv.frames,
      canvas: c ? { w: c.width, h: c.height } : null,
      preserveDrawingBuffer: (() => { try { const g = window.__mvTools.glOf(c); return g ? !!g.getContextAttributes().preserveDrawingBuffer : null; } catch (e) { return null; } })(),
    };
  });
  return { page, context, stats, info, url };
}

/** Parse "0,3.5,12" or "0:10:2" (start:end:step, end inclusive) or mixtures "0,5:8:1". */
export function parseTimes(spec) {
  const out = [];
  for (const part of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    if (part.includes(':')) {
      const [a, b, s = 1] = part.split(':').map(Number);
      if(part.split(':').length>3 || ![a,b,s].every(Number.isFinite) || a<0 || b<a || s<=0 || (b-a)/s>100000) throw new Error('invalid time range');
      for (let t = a, i = 0; t <= b + 1e-9 && i < 100000; i++, t = a + i * s) out.push(+t.toFixed(6));
    } else out.push(Number(part));
  }
  if (!out.length || out.length>100000 || out.some((x) => !Number.isFinite(x) || x<0)) throw new Error('bad --t spec: ' + spec);
  return out;
}

/** Minimal argv parser: --key value, --flag (boolean), --key=value. */
export function parseArgs(argv, booleans = []) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { o[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    if (booleans.includes(k) || i + 1 >= argv.length || (argv[i + 1].startsWith('--') && argv[i + 1].length > 2)) o[k] = true;
    else o[k] = argv[++i];
  }
  return o;
}
