#!/usr/bin/env node
// Camera stability check (model-free). Reads the FINAL camera the engine rendered with — after the scene's
// update(), lens breathing and engine handheld — and reports high-frequency jitter in screen pixels at a
// reference width (default 1920). A smooth pan/dolly is not jitter: the view direction of each sample is
// compared with its own centred moving average (window --win seconds). Shot changes and in-shot hard cuts
// start a new segment; only samples whose full window lies inside one segment are scored.
//
// Two inputs:
//   --url  http://127.0.0.1:39920/   a running project page; the tool adds mode=capture&w=192&h=108 when absent,
//          seeks every frame through window.__scene.seek(t) and reads window.__scene.lastCamera().
//   --samples FILE.json              [{t, shot, e:[16 column-major matrixWorld], fov (vertical deg), aspect}, …]
//          for projects that record cameras themselves (same fields as engine.lastCamera()).
// The analysis itself is the pure function analyzeCamera(samples, options) exported below.
//
// Gimbal / orientation-jump check: a camera path that passes close to the zenith or nadir flips its yaw (and, for
// look-at rigs, its roll) in a single frame — the whole picture spins although the jitter metric hardly moves,
// because yaw is scaled by cos(pitch) and the jump is often split off as an in-shot cut. Any adjacent same-shot
// pair whose |pitch| exceeds --gimbal-pitch (default 80°) on either side and whose yaw or roll changes by more than
// --gimbal-deg (default 3°) FAILS and is reported with its time and frame. Keep |pitch| ≤ 80° on camera paths.
import {readFile} from 'node:fs/promises';
import {cli, isMain, number, atomic} from './lib/cli.mjs';

export const CAM_DEFAULTS = Object.freeze({refWidth: 1920, win: 0.5, hfP95: 1.5, rms: 1.5, peak: 4, cutPxFrac: 0.04, cutM: 0.3, cutRatio: 5, nbS: 0.5, gimbalDeg: 3, gimbalPitch: 80});

/** One engine camera record → {t, shot, yaw, pitch, roll, pos, pxPerRad}. Forward is −Z of matrixWorld; roll is
 * atan2(right.y, up.y) (0 for a level camera at any pitch; undefined at exactly ±90°, which is the point). */
export function decomposeCamera(cam, refWidth = CAM_DEFAULTS.refWidth) {
  const e = cam.e;
  if (!Array.isArray(e) && !ArrayBuffer.isView(e)) throw new TypeError('camera sample needs e (16-element matrixWorld)');
  if (e.length !== 16 || !e.every(Number.isFinite)) throw new RangeError('camera matrix must have 16 finite numbers');
  if (!(cam.fov > 0 && cam.fov < 180) || !(cam.aspect > 0)) throw new RangeError('camera sample needs fov (0–180 deg) and aspect > 0');
  const fwd = [-e[8], -e[9], -e[10]], len = Math.hypot(...fwd) || 1;
  const f = fwd.map(v => v / len);
  const hfov = 2 * Math.atan(Math.tan(cam.fov * Math.PI / 360) * cam.aspect);
  return {t: Number(cam.t), shot: String(cam.shot ?? ''), yaw: Math.atan2(f[0], -f[2]), pitch: Math.asin(Math.max(-1, Math.min(1, f[1]))), roll: Math.atan2(e[1], e[5]), pos: [e[12], e[13], e[14]], pxPerRad: refWidth / hfov};
}

/** Build a camera record from yaw/pitch/roll (radians) and position — used by tests and by projects that log angles. */
export function cameraRecord({t, shot, yaw = 0, pitch = 0, roll = 0, pos = [0, 0, 0], fov = 30, aspect = 2.388}) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  const f = [sy * cp, sp, -cy * cp], r0 = [cy, 0, sy], u0 = [-sp * sy, cp, sp * cy];   // level right/up for this view
  const right = r0.map((v, k) => v * cr + u0[k] * sr), up = u0.map((v, k) => v * cr - r0[k] * sr);
  const e = [...right, 0, ...up, 0, -f[0], -f[1], -f[2], 0, pos[0], pos[1], pos[2], 1];
  return {t, shot, e, fov, aspect};
}

/**
 * gimbalCheck(samples, {gimbalDeg, gimbalPitch, fps}) → {pass, thresholds, maxPitchDeg, events:[{shot, t, frame, prevT, pitchDeg, dYawDeg, dRollDeg}]}
 * samples: decomposed cameras in time order. Adjacent pairs in the same shot are compared; a pair is an event when
 * max(|pitch|) > gimbalPitch and |Δyaw| or |Δroll| > gimbalDeg (wrapped to ±180°). Roll is skipped when absent.
 */
export function gimbalCheck(samples, options = {}) {
  const o = {...CAM_DEFAULTS, ...options}, deg = 180 / Math.PI, events = [];
  let maxPitch = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i], p = samples[i - 1];
    maxPitch = Math.max(maxPitch, Math.abs(s.pitch) * deg);
    if (!p || p.shot !== s.shot) continue;
    const pitch = Math.max(Math.abs(s.pitch), Math.abs(p.pitch)) * deg;
    if (!(pitch > o.gimbalPitch)) continue;
    const dYaw = Math.abs(wrap(s.yaw - p.yaw)) * deg;
    const dRoll = Number.isFinite(s.roll) && Number.isFinite(p.roll) ? Math.abs(wrap(s.roll - p.roll)) * deg : null;
    if (dYaw > o.gimbalDeg || (dRoll != null && dRoll > o.gimbalDeg)) {
      events.push({shot: s.shot, t: s.t, frame: o.fps ? Math.round(s.t * o.fps) : i, prevT: p.t, pitchDeg: +((Math.abs(s.pitch) >= Math.abs(p.pitch) ? s.pitch : p.pitch) * deg).toFixed(2),
        dYawDeg: +dYaw.toFixed(2), dRollDeg: dRoll == null ? null : +dRoll.toFixed(2)});
    }
  }
  return {pass: events.length === 0, thresholds: {gimbalDeg: o.gimbalDeg, gimbalPitchDeg: o.gimbalPitch}, maxPitchDeg: +maxPitch.toFixed(2), events};
}

const wrap = d => { while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const median = values => { const v = values.filter(x => x != null).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : 0; };
const quantile = (values, q) => { if (!values.length) return 0; const v = [...values].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(q * (v.length - 1) + 0.5))]; };

/**
 * analyzeCamera(samples, {fps, refWidth, win, hfP95, rms, peak}) → {pass, thresholds, segments:[…]}
 * samples: engine camera records ({e, fov, aspect, t, shot}) or decomposed ({yaw, pitch, pos, pxPerRad, t, shot}), in time order.
 * Segments: per shot, split again at in-shot discontinuities (a step > cutRatio × the median step of the ±nbS s
 * neighbours and above cutPxFrac × refWidth or cutM metres). Per segment: rmsPx, peakPx (+peakT), hfP95Px,
 * posJitterMm, scored sample count. A segment shorter than one full window is reported with scored 0 (not judged).
 */
export function analyzeCamera(samples, options = {}) {
  const o = {...CAM_DEFAULTS, ...options};
  if (!Array.isArray(samples) || !samples.length) throw new Error('no camera samples');
  const ss = samples.map(s => (s.e ? decomposeCamera(s, o.refWidth) : {...s, pxPerRad: s.pxPerRad ?? o.refWidth / (s.hfov ?? 1)}));
  for (let i = 1; i < ss.length; i++) if (!(ss[i].t > ss[i - 1].t)) throw new Error(`samples must be in increasing time order (index ${i})`);
  const dt = median(ss.slice(1).map((s, i) => s.t - ss[i].t));
  const fps = o.fps || (dt > 0 ? 1 / dt : 24);
  const gimbal = gimbalCheck(ss, {...o, fps});
  const steps = ss.map((s, i) => {
    const p = ss[i - 1];
    if (!p || p.shot !== s.shot) return null;
    return {px: Math.hypot(wrap(s.yaw - p.yaw) * Math.cos(s.pitch), s.pitch - p.pitch) * s.pxPerRad, m: Math.hypot(...s.pos.map((v, k) => v - p.pos[k]))};
  });
  const nb = Math.max(1, Math.round(o.nbS * fps));
  const segments = new Map();
  let seg = 0;
  for (let i = 0; i < ss.length; i++) {
    const st = steps[i];
    if (!st) seg = 0;
    else {
      const around = [];
      for (let j = Math.max(1, i - nb); j <= Math.min(ss.length - 1, i + nb); j++) if (j !== i && steps[j]) around.push(steps[j]);
      const mPx = median(around.map(x => x.px)), mM = median(around.map(x => x.m));
      if (st.px > Math.max(o.cutPxFrac * o.refWidth, o.cutRatio * mPx) || st.m > Math.max(o.cutM, o.cutRatio * mM)) seg++;
    }
    const key = seg ? `${ss[i].shot}#${seg}` : ss[i].shot;
    if (!segments.has(key)) segments.set(key, []);
    segments.get(key).push(ss[i]);
  }
  const half = Math.max(1, Math.round(o.win * fps / 2));
  const rows = [];
  for (const [id, list] of segments) {
    const yaw = list.map(s => s.yaw);
    for (let i = 1; i < yaw.length; i++) yaw[i] = yaw[i - 1] + wrap(yaw[i] - yaw[i - 1]);
    const residuals = [];
    let peak = 0, peakT = null, posSum = 0;
    for (let i = half; i + half < list.length; i++) {   // full window only: segment edges are not jitter
      let my = 0, mp = 0; const mpos = [0, 0, 0];
      for (let j = i - half; j <= i + half; j++) { my += yaw[j]; mp += list[j].pitch; for (let k = 0; k < 3; k++) mpos[k] += list[j].pos[k]; }
      const m = 2 * half + 1;
      const px = Math.hypot((yaw[i] - my / m) * Math.cos(list[i].pitch), list[i].pitch - mp / m) * list[i].pxPerRad;
      residuals.push(px);
      if (px > peak) { peak = px; peakT = list[i].t; }
      posSum += Math.hypot(...list[i].pos.map((v, k) => v - mpos[k] / m)) ** 2;
    }
    const n = residuals.length;
    const row = {segment: id, shot: list[0].shot, t0: list[0].t, t1: list.at(-1).t, samples: list.length, scored: n,
      rmsPx: n ? +Math.sqrt(residuals.reduce((a, x) => a + x * x, 0) / n).toFixed(3) : 0,
      peakPx: +peak.toFixed(3), peakT, hfP95Px: +quantile(residuals, 0.95).toFixed(3),
      posJitterMm: n ? +(Math.sqrt(posSum / n) * 1000).toFixed(2) : 0};
    row.pass = row.rmsPx <= o.rms && row.peakPx <= o.peak && row.hfP95Px <= o.hfP95;
    rows.push(row);
  }
  return {pass: rows.every(r => r.pass) && gimbal.pass, thresholds: {refWidth: o.refWidth, winS: o.win, hfP95Px: o.hfP95, rmsPx: o.rms, peakPx: o.peak, gimbalDeg: o.gimbalDeg, gimbalPitchDeg: o.gimbalPitch}, fps, segments: rows, gimbal};
}

export function formatReport(report) {
  const lines = report.segments.map(r => `${r.pass ? 'PASS' : 'FAIL'} ${r.segment.padEnd(24)} ${r.t0.toFixed(2)}–${r.t1.toFixed(2)}s rms ${r.rmsPx}px peak ${r.peakPx}px${r.peakT == null ? '' : '@' + r.peakT.toFixed(2)} p95 ${r.hfP95Px}px pos ${r.posJitterMm}mm${r.scored ? '' : ' (shorter than one window, not judged)'}`);
  const g = report.gimbal;
  if (g) {
    for (const ev of g.events) lines.push(`FAIL gimbal ${ev.shot.padEnd(18)} t=${ev.t.toFixed(3)}s (frame ${ev.frame}) Δyaw ${ev.dYawDeg}°${ev.dRollDeg == null ? '' : ` Δroll ${ev.dRollDeg}°`} at pitch ${ev.pitchDeg}° — path passes near zenith/nadir; keep |pitch| ≤ ${g.thresholds.gimbalPitchDeg}° or move the target off the pole`);
    lines.push(`${g.pass ? 'PASS' : 'FAIL'} gimbal · ${g.events.length} orientation jumps · max |pitch| ${g.maxPitchDeg}° · threshold Δyaw/Δroll ≤ ${g.thresholds.gimbalDeg}° while |pitch| > ${g.thresholds.gimbalPitchDeg}°`);
  }
  lines.push(`${report.pass ? 'PASS' : 'FAIL'} cam-check · ${report.segments.length} segments · thresholds p95 ≤ ${report.thresholds.hfP95Px}px, rms ≤ ${report.thresholds.rmsPx}px, peak ≤ ${report.thresholds.peakPx}px @ ${report.thresholds.refWidth} px width`);
  return lines.join('\n');
}

/** Seek every sampled frame of a running page and collect window.__scene.lastCamera(). */
export async function collectFromPage({url, start = 0, end, fps = 24, every = 1, timeout = 600000, log = () => {}}) {
  const target = new URL(url);
  if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:' || +target.port < 39920 || +target.port > 39939) throw new Error('Use an assigned loopback URL (127.0.0.1:39920–39939)');
  if (!target.searchParams.has('mode')) target.searchParams.set('mode', 'capture');
  if (!target.searchParams.has('w')) { target.searchParams.set('w', '192'); target.searchParams.set('h', '108'); }
  const {browser: launchBrowser} = await import('./lib/browser.mjs');
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeout);
    await page.goto(target.href, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => window.__scene?.ready === true || window.__sceneError, null, {timeout});
    const info = await page.evaluate(() => ({error: window.__sceneError || null, duration: window.__scene?.duration, fps: window.__scene?.fps, has: typeof window.__scene?.lastCamera === 'function'}));
    if (info.error) throw new Error(`scene failed: ${info.error}`);
    if (!info.has) throw new Error('window.__scene.lastCamera() missing: the engine core must record the final camera (engine/core.js)');
    const rate = fps || info.fps || 24, stop = end ?? info.duration;
    const samples = [];
    for (let f = Math.ceil(start * rate - 1e-9); f / rate < stop; f += every) {
      const cam = await page.evaluate(async t => { await window.__scene.seek(t); return window.__scene.lastCamera(); }, f / rate);
      if (cam) samples.push({...cam, t: f / rate});
      if (samples.length % 240 === 0) log(`[cam] t=${(f / rate).toFixed(1)}`);
    }
    return {samples, fps: rate / every};
  } finally { await browser.close(); }
}

if (isMain(import.meta.url)) {
  const args = cli({url: {type: 'string'}, samples: {type: 'string'}, out: {type: 'string'}, start: {type: 'string'}, end: {type: 'string'}, fps: {type: 'string'}, every: {type: 'string'},
    win: {type: 'string'}, 'hf-p95': {type: 'string'}, rms: {type: 'string'}, peak: {type: 'string'}, 'ref-width': {type: 'string'}, 'save-samples': {type: 'string'},
    'gimbal-deg': {type: 'string'}, 'gimbal-pitch': {type: 'string'}},
  'Usage: node tools/cam-check.mjs (--url http://127.0.0.1:39920/ | --samples cams.json) [--out out/cam-check.json]\n' +
  '  [--start 0 --end DURATION --fps 24 --every 1] [--win 0.5] [--hf-p95 1.5 --rms 1.5 --peak 4] [--ref-width 1920] [--save-samples FILE]\n' +
  '  [--gimbal-deg 3 --gimbal-pitch 80]\n' +
  'Final rendered camera (engine.lastCamera(): after scene update, breathing and handheld) → per-shot/segment jitter in px at the reference width.\n' +
  'In-shot hard cuts split segments; only full-window residuals count. Gimbal: any adjacent same-shot frame pair with\n' +
  '|pitch| > --gimbal-pitch whose yaw or roll changes by more than --gimbal-deg FAILS (path near zenith/nadir; frame reported).\n' +
  'Exit 0 PASS, 3 threshold FAIL, 2 error.');
  if (args) {
    try {
      if (!!args.url === !!args.samples) throw new Error('give exactly one of --url or --samples');
      const opts = {win: number(args.win ?? CAM_DEFAULTS.win, 'win', 0.05, 10), hfP95: number(args['hf-p95'] ?? CAM_DEFAULTS.hfP95, 'hf-p95', 0, 1000),
        rms: number(args.rms ?? CAM_DEFAULTS.rms, 'rms', 0, 1000), peak: number(args.peak ?? CAM_DEFAULTS.peak, 'peak', 0, 1000), refWidth: number(args['ref-width'] ?? CAM_DEFAULTS.refWidth, 'ref-width', 16, 16384),
        gimbalDeg: number(args['gimbal-deg'] ?? CAM_DEFAULTS.gimbalDeg, 'gimbal-deg', 0, 180), gimbalPitch: number(args['gimbal-pitch'] ?? CAM_DEFAULTS.gimbalPitch, 'gimbal-pitch', 0, 90)};
      let samples, fps = args.fps ? number(args.fps, 'fps', 1, 240) : undefined;
      if (args.samples) samples = JSON.parse(await readFile(args.samples, 'utf8'));
      else ({samples, fps} = await collectFromPage({url: args.url, start: number(args.start ?? 0, 'start', 0), end: args.end === undefined ? undefined : number(args.end, 'end', 0),
        fps, every: number(args.every ?? 1, 'every', 1, 1000, true), log: m => console.error(m)}));
      if (args['save-samples']) await atomic(args['save-samples'], JSON.stringify(samples));
      const report = analyzeCamera(samples, {...opts, fps});
      if (args.out) await atomic(args.out, JSON.stringify(report, null, 1) + '\n');
      console.log(formatReport(report));
      process.exitCode = report.pass ? 0 : 3;
    } catch (error) { console.error(`[cam-check] ${error.message}`); process.exitCode = 2; }
  }
}
