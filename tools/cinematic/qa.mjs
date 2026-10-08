#!/usr/bin/env node
// Author: suwubee
// QA of an encoded MV file.
//
//   node tools/cinematic/qa.mjs work/film.mp4 [--cuts data/cuts.json] [--out DIR] [--strict]
//
// Checks
//   1 ffprobe: 1 H.264 High yuv420p video + 1 AAC 48 kHz stereo audio, fps, resolution, BT.709 tags (range tv),
//     |audio-video| duration < 50 ms, optional expected --frames / --duration, faststart (moov before mdat)
//   2 full decode (ffmpeg -xerror, video + audio) must be error-free
//   3 contact sheet: 1 frame / --sheet-every seconds (default 2), timestamps burnt in -> <out>/<name>_sheet.png
//   4 frame-difference spike scan on the picture area (grey 160x68, mean |diff|): frame i flagged when
//     diff > --spike-k (3) x median of its +-6 neighbours and > --spike-floor (1.5 levels); frames within +-1 of an
//     intended cut (--cuts JSON: [frame,...] or {cuts:[...]} or [{frame}|{f}|{t0}...]) are ignored.
//     "isolated" = single odd frame (i differs from i-1 and i+1 while i-1 ~ i+1): almost always a real glitch.
//   5 black/blank frames (mean Y <= 20 and flat) and frozen runs (bit-identical consecutive frames, > 2)
//   6 luminance summary (per 2 s: mean / p1 / p99 of Y, crushed <=16 and clipped >=235 %) + global histogram
//   7 dark-gradient banding: on full-res samples, dark 16x16 blocks that are flat (std < 0.5) and step by
//     0.5..4 levels against a flat neighbour = contour bands. Reports the worst sample times.
// Options: --fps 24 --w 1920 --h 1080 --frames N --duration S --bars 138 (letterbox rows excluded; auto for 1080p)
//          --start-frame F --every K: film numbering of video frame 0 (read automatically from the comment tag that
//          encode.mjs writes), so --cuts and all reported frames use FILM frame numbers even for partial encodes
//          --sheet-every 2 --cols 10 --strict (warnings also fail) --json (print JSON report to stdout)
// Exit: 0 pass, 1 FAIL (format/decode/duration), 2 warnings with --strict.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from './lib/browser.mjs';

const a = parseArgs(process.argv.slice(2), ['strict', 'json', 'help', 'silent']);
const input = a._[0] && path.resolve(a._[0]);
if (a.help || !input) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
  process.exit(a.help ? 0 : 1);
}
const name = path.basename(input).replace(/\.[^.]+$/, '');
const outDir = path.resolve(a.out || path.join(path.dirname(input), name + '_qa'));
fs.mkdirSync(outDir, { recursive: true });
let FPS = +(a.fps || 24);   // expected video fps (for --every K previews: derived from the encode tag)
let FILM_FPS = 24;
const fails = [], warns = [], info = [];
const report = { file: input, checks: {} };
const fail = (m) => { fails.push(m); console.log('FAIL  ' + m); };
const warn = (m) => { warns.push(m); console.log('WARN  ' + m); };
const ok = (m) => { info.push(m); console.log('ok    ' + m); };

// ---------------- 1. ffprobe ----------------
const pr = spawnSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-count_packets', '-of', 'json', input], { encoding: 'utf8', maxBuffer: 1 << 26 });
if (pr.status !== 0) { fail('ffprobe failed: ' + pr.stderr.trim()); finish(); }
const probe = JSON.parse(pr.stdout);
const tagM = /mv_start_frame=(\d+);mv_every=(\d+)(?:;mv_fps=([\d.]+))?/.exec((probe.format.tags && probe.format.tags.comment) || '');
if (tagM && tagM[3]) FILM_FPS = +tagM[3];
if (!a.fps && tagM) FPS = FILM_FPS / +tagM[2];
const vs = probe.streams.filter((s) => s.codec_type === 'video');
const as = probe.streams.filter((s) => s.codec_type === 'audio');
const v = vs[0], au = as[0];
const W = +(a.w || 1920), H = +(a.h || 1080);
report.checks.probe = { format: probe.format.format_name, video: v && { codec: v.codec_name, profile: v.profile, level: v.level, w: v.width, h: v.height, pix_fmt: v.pix_fmt, r_frame_rate: v.r_frame_rate, avg_frame_rate: v.avg_frame_rate, color_range: v.color_range, color_space: v.color_space, color_transfer: v.color_transfer, color_primaries: v.color_primaries, duration: +v.duration, frames: +(v.nb_read_packets || v.nb_frames), bit_rate: +v.bit_rate }, audio: au && { codec: au.codec_name, sample_rate: +au.sample_rate, channels: au.channels, duration: +au.duration, bit_rate: +au.bit_rate } };
if (vs.length !== 1) fail(`expected exactly 1 video stream, found ${vs.length}`);
if (!a.silent && as.length !== 1) fail(`expected exactly 1 audio stream, found ${as.length}`);
if (v) {
  const pv = report.checks.probe.video;
  const eq = (k, got, exp) => (String(got) === String(exp) ? ok(`${k} = ${got}`) : fail(`${k} = ${got}, expected ${exp}`));
  eq('video codec', v.codec_name, 'h264');
  if (v.profile !== 'High') warn(`H.264 profile ${v.profile} (expected High)`);
  if (v.level > 41) warn(`H.264 level ${v.level / 10} > 4.1`);
  eq('resolution', `${v.width}x${v.height}`, `${W}x${H}`);
  eq('pix_fmt', v.pix_fmt, 'yuv420p');
  const fr = (s) => { const [n, d] = String(s).split('/').map(Number); return d ? n / d : n; };
  if (Math.abs(fr(v.r_frame_rate) - FPS) > 1e-6 || Math.abs(fr(v.avg_frame_rate) - FPS) > 1e-3) fail(`fps r=${v.r_frame_rate} avg=${v.avg_frame_rate}, expected ${FPS}`); else ok(`fps = ${v.r_frame_rate}`);
  eq('color_range', v.color_range, 'tv');
  eq('color_space', v.color_space, 'bt709');
  eq('color_primaries', v.color_primaries, 'bt709');
  eq('color_transfer', v.color_transfer, 'bt709');
  if (a.frames) eq('frame count', pv.frames, +a.frames); else ok(`frame count = ${pv.frames} (${(pv.frames / FPS).toFixed(3)} s)`);
  if (Math.abs(pv.frames / FPS - pv.duration) > 1.5 / FPS) warn(`video duration ${pv.duration} != frames/fps ${(pv.frames / FPS).toFixed(4)}`);
  if (a.duration && Math.abs(pv.duration - +a.duration) > 1 / FPS + 1e-6) fail(`video duration ${pv.duration} s, expected ${a.duration} s (+-1 frame)`);
  ok(`video bitrate ${(pv.bit_rate / 1e6).toFixed(1)} Mbit/s, size ${(+probe.format.size / 1e6).toFixed(1)} MB`);
}
if (!au && a.silent) report.checks.audioSync={status:'SKIP',reason:'No project audio supplied; visual preview only'};
if (au) {
  if (au.codec_name !== 'aac') fail(`audio codec ${au.codec_name}, expected aac`); else ok('audio codec = aac');
  if (+au.sample_rate !== 48000) fail(`audio sample rate ${au.sample_rate}, expected 48000`); else ok('audio 48000 Hz');
  if (au.channels !== 2) warn(`audio channels ${au.channels}`);
  if (v) {
    const d = Math.abs(+au.duration - +v.duration) * 1000;
    report.checks.probe.avDiffMs = +d.toFixed(2);
    if (d >= 50) fail(`audio/video duration mismatch ${d.toFixed(1)} ms (audio ${au.duration}, video ${v.duration})`); else ok(`A/V duration diff ${d.toFixed(1)} ms (audio ${au.duration} s, video ${v.duration} s)`);
  }
}
// faststart: top-level 'moov' must come before 'mdat'
{
  const fd = fs.openSync(input, 'r');
  const size = fs.fstatSync(fd).size;
  let off = 0, order = [];
  const hb = Buffer.alloc(16);
  while (off + 8 <= size && order.length < 20) {
    fs.readSync(fd, hb, 0, 16, off);
    let len = hb.readUInt32BE(0);
    const type = hb.toString('latin1', 4, 8);
    if (len === 1) len = Number(hb.readBigUInt64BE(8)); else if (len === 0) len = size - off;
    order.push(type);
    if (len < 8) break;
    off += len;
  }
  fs.closeSync(fd);
  report.checks.atoms = order;
  const im = order.indexOf('moov'), id = order.indexOf('mdat');
  if (im < 0 || id < 0) warn(`atoms: ${order.join(',')}`);
  else if (im < id) ok('faststart (moov before mdat)'); else fail('not faststart: moov after mdat (use -movflags +faststart)');
}
if (fails.length && !v) finish();

// ---------------- 2-7. one decoding pass ----------------
const vH = v.height, vW = v.width;
const START = a['start-frame'] != null ? +a['start-frame'] : tagM ? +tagM[1] : 0;
const EVERY = a.every != null ? +a.every : tagM ? +tagM[2] : 1;
const filmF = (i) => START + i * EVERY;           // video frame index -> film frame index
const filmT = (i) => +(filmF(i) / FILM_FPS).toFixed(3); // film time (s)
if (START || EVERY !== 1) ok(`film numbering: video frame 0 = film frame ${START}, step ${EVERY}`);
const bars = a.bars != null ? +a.bars : Math.round(138 * vH / 1080) * (vW / vH > 1.7 ? 1 : 0);
const picH = vH - 2 * bars;
const SW = 160, SH = 68;
const sheetEvery = +(a['sheet-every'] || 2);
const sampleStep = Math.max(1, Math.round(sheetEvery * FPS));
const nFrames = report.checks.probe.video.frames;
const nSamples = Math.ceil(nFrames / sampleStep);
const cols = Math.max(1, Math.min(+(a.cols || 10), nSamples)), rows = Math.max(1, Math.ceil(nSamples / cols));
const sheetFile = path.join(outDir, `${name}_sheet.png`);
const bandFile = path.join(outDir, `.${name}_band.gray`);
const font = a.font || 'monospace';
const fc = [
  `[0:v]split=3[a][b][c]`,
  `[a]crop=iw:${picH}:0:${bars},scale=${SW}:${SH}:flags=area,format=gray[small]`,
  `[b]select='not(mod(n\\,${sampleStep}))',scale=192:-2,drawtext=font=${font}:text='%{pts\\:hms\\:${(START / FILM_FPS).toFixed(3)}}':x=3:y=3:fontsize=12:fontcolor=white:box=1:boxcolor=black@0.6,tile=${cols}x${rows}:padding=2:margin=2:color=0x202020[sheet]`,
  `[c]select='not(mod(n\\,${sampleStep}))',crop=iw:${picH}:0:${bars},format=gray[band]`,
].join(';');
const args = ['-threads','2','-filter_complex_threads','2','-v', 'error', '-xerror', '-nostdin', '-y', '-i', input, '-filter_complex', fc,
  '-map', '[small]', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1',
  '-map', '[sheet]', '-frames:v', '1', '-update', '1', sheetFile,
  '-map', '[band]', '-fps_mode', 'passthrough', '-f', 'rawvideo', bandFile];
if (au) args.push('-map', '0:a:0', '-f', 'null', '-');
console.log(`..    decoding ${nFrames} frames (picture area ${vW}x${picH}, bars ${bars}px) ...`);
const t0 = Date.now();
const small = await new Promise((resolve) => {
  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; let err = '';
  p.stdout.on('data', (c) => chunks.push(c));
  p.stderr.on('data', (c) => { err += c; });
  p.on('close', (code) => resolve({ code, buf: Buffer.concat(chunks), err }));
});
const decodeErrors = small.err.split('\n').filter((l) => l.trim());
report.checks.decode = { exitCode: small.code, errors: decodeErrors.slice(0, 50), seconds: (Date.now() - t0) / 1000 };
if (small.code !== 0 || decodeErrors.length) fail(`decode errors (exit ${small.code}): ${decodeErrors.slice(0, 5).join(' | ')}`);
else ok(`full decode clean (${report.checks.decode.seconds.toFixed(1)} s)`);
const FS = SW * SH;
const nf = Math.floor(small.buf.length / FS);
if (nf !== nFrames) warn(`decoded ${nf} frames, probe says ${nFrames}`);
if (fs.existsSync(sheetFile)) { ok(`contact sheet: ${sheetFile}`); report.checks.sheet = sheetFile; }

// ---- 4. spikes ----
const frame = (i) => small.buf.subarray(i * FS, (i + 1) * FS);
const mad = (x, y) => { let s = 0; for (let k = 0; k < FS; k++) s += Math.abs(x[k] - y[k]); return s / FS; };
const diff = new Float64Array(nf);
for (let i = 1; i < nf; i++) diff[i] = mad(frame(i), frame(i - 1));
let cuts = new Set();
if (a.cuts) {
  const j = JSON.parse(fs.readFileSync(a.cuts, 'utf8'));
  const list = Array.isArray(j) ? j : (j.cuts || j.shots || []);
  for (const c of list) {
    const f = typeof c === 'number' ? c : c.frame ?? c.f ?? (c.t0 != null ? Math.round(c.t0 * FPS) : c.t != null ? Math.round(c.t * FPS) : null);
    if (f == null) continue;
    const vi = (Math.round(f) - START) / EVERY;   // film frame -> video frame
    if (Number.isInteger(vi)) cuts.add(vi); else cuts.add(Math.ceil(vi));
  }
}
const K = +(a['spike-k'] || 3), FLOOR = +(a['spike-floor'] || 1.5);
const spikes = [];
for (let i = 1; i < nf; i++) {
  const nb = [];
  for (let j = Math.max(1, i - 6); j <= Math.min(nf - 1, i + 6); j++) if (j !== i) nb.push(diff[j]);
  nb.sort((x, y) => x - y);
  const med = nb.length ? nb[nb.length >> 1] : 0;
  if (diff[i] > K * Math.max(med, 0.05) && diff[i] > FLOOR) {
    const isCut = cuts.has(i) || cuts.has(i - 1) || cuts.has(i + 1);
    let isolated = false;
    if (i + 1 < nf) { const skip = mad(frame(i + 1), frame(i - 1)); isolated = diff[i + 1] > K * Math.max(med, 0.05) && skip < 0.5 * Math.min(diff[i], diff[i + 1]); }
    spikes.push({ frame: filmF(i), t: filmT(i), videoFrame: i, diff: +diff[i].toFixed(2), localMedian: +med.toFixed(2), cut: isCut, isolated });
  }
}
// an isolated frame i also produces a spike at i+1: keep one entry per event
const events = spikes.filter((s, k) => !(k > 0 && spikes[k - 1].isolated && spikes[k - 1].videoFrame === s.videoFrame - 1));
const unexpected = events.filter((s) => !s.cut);
report.checks.spikes = { k: K, floor: FLOOR, cutsGiven: cuts.size, events, unexpected: unexpected.length };
if (!unexpected.length) ok(`frame-diff spikes: none unexpected (${events.length} at intended cuts${cuts.size ? '' : '; no --cuts given'})`);
else {
  const iso = unexpected.filter((s) => s.isolated);
  const msg = `${unexpected.length} unexpected frame-diff spike(s)` + (iso.length ? `, ${iso.length} ISOLATED glitch frame(s): ${iso.slice(0, 10).map((s) => `f${s.frame}@${s.t}s`).join(' ')}` : '') + `; first: ${unexpected.slice(0, 12).map((s) => `f${s.frame}@${s.t}s(${s.diff}/${s.localMedian})`).join(' ')}`;
  warn(msg);
}

// ---- 5. black / frozen ----
const runs = (flags) => { const out = []; let s = -1; for (let i = 0; i <= flags.length; i++) { if (i < flags.length && flags[i]) { if (s < 0) s = i; } else if (s >= 0) { out.push([s, i - 1]); s = -1; } } return out; };
const black = new Array(nf).fill(false), frozen = new Array(nf).fill(false);
const lumaStats = [];
for (let i = 0; i < nf; i++) {
  const f = frame(i); let s = 0, s2 = 0;
  for (let k = 0; k < FS; k++) { s += f[k]; s2 += f[k] * f[k]; }
  const m = s / FS, sd = Math.sqrt(Math.max(0, s2 / FS - m * m));
  black[i] = m <= 20 && sd < 2;
  frozen[i] = i > 0 && diff[i] === 0;
  lumaStats.push(m);
}
const blackRuns = runs(black).map(([s, e]) => ({ from: filmF(s), to: filmF(e), t0: filmT(s), t1: filmT(e), frames: e - s + 1, v0: s, v1: e }));
const frozenRuns = runs(frozen).filter(([s, e]) => e - s + 1 > 2).map(([s, e]) => ({ from: filmF(s - 1), to: filmF(e), t0: filmT(s - 1), frames: e - s + 2 }));
report.checks.black = blackRuns; report.checks.frozen = frozenRuns;
const inner = blackRuns.filter((r) => r.v0 > 0 && r.v1 < nf - 1);
if (blackRuns.length) (inner.length ? warn : ok)(`black/blank runs: ${blackRuns.map((r) => `${r.t0}-${r.t1}s(${r.frames}f)`).join(' ')}${inner.length ? ' (inside the film!)' : ' (head/tail only)'}`);
else ok('no black/blank frames');
if (frozenRuns.length) warn(`frozen (bit-identical) runs: ${frozenRuns.slice(0, 10).map((r) => `f${r.from}@${r.t0}s x${r.frames}`).join(' ')}`);
else ok('no frozen runs (>2 identical frames)');

// ---- 6 + 7: luminance + banding on full-res samples ----
const bandBuf = fs.existsSync(bandFile) ? fs.readFileSync(bandFile) : Buffer.alloc(0);
const BFS = vW * picH;
const nb = Math.floor(bandBuf.length / BFS);
const hist = new Float64Array(16);
const perSample = [];
for (let si = 0; si < nb; si++) {
  const f = bandBuf.subarray(si * BFS, (si + 1) * BFS);
  const h = new Uint32Array(256);
  for (let k = 0; k < BFS; k++) h[f[k]]++;
  let acc = 0, p1 = -1, p50 = -1, p99 = -1, sum = 0;
  for (let y = 0; y < 256; y++) { acc += h[y]; sum += y * h[y]; if (p1 < 0 && acc >= BFS * 0.01) p1 = y; if (p50 < 0 && acc >= BFS * 0.5) p50 = y; if (p99 < 0 && acc >= BFS * 0.99) p99 = y; hist[Math.min(15, y >> 4)] += h[y]; }
  let crushed = 0, clipped = 0; for (let y = 0; y <= 16; y++) crushed += h[y]; for (let y = 235; y < 256; y++) clipped += h[y];
  // banding: 16x16 blocks
  const B = 16, bw = Math.floor(vW / B), bh = Math.floor(picH / B);
  const bm = new Float32Array(bw * bh), bs = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let s = 0, s2 = 0;
    for (let y = by * B; y < by * B + B; y++) { const o = y * vW + bx * B; for (let x = 0; x < B; x++) { const val = f[o + x]; s += val; s2 += val * val; } }
    const m = s / 256; bm[by * bw + bx] = m; bs[by * bw + bx] = Math.sqrt(Math.max(0, s2 / 256 - m * m));
  }
  let dark = 0, band = 0, flat = 0;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const i = by * bw + bx; if (bm[i] > 70) continue;
    dark++;
    if (bs[i] < 0.5) {
      flat++;
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const x2 = bx + dx, y2 = by + dy; if (x2 < 0 || y2 < 0 || x2 >= bw || y2 >= bh) continue;
        const j = y2 * bw + x2, d = Math.abs(bm[j] - bm[i]);
        if (bs[j] < 1.0 && d >= 0.5 && d <= 4) { band++; break; }
      }
    }
  }
  perSample.push({ t: filmT(si * sampleStep), mean: +(sum / BFS).toFixed(1), p1, p50, p99, crushedPct: +(100 * crushed / BFS).toFixed(2), clippedPct: +(100 * clipped / BFS).toFixed(2), darkBlocks: dark, flatDarkPct: dark ? +(100 * flat / dark).toFixed(2) : 0, bandPct: dark ? +(100 * band / dark).toFixed(2) : 0 });
}
try { fs.unlinkSync(bandFile); } catch {}
const tot = hist.reduce((s, x) => s + x, 0) || 1;
report.checks.luma = { histogram16: [...hist].map((x) => +(100 * x / tot).toFixed(2)), samples: perSample };
if (perSample.length) {
  const bar = (p) => '#'.repeat(Math.round(p / 2));
  console.log('..    luma histogram of the picture area (Y 16-level bins, % of pixels):');
  [...hist].forEach((x, i) => { const p = 100 * x / tot; if (p >= 0.05) console.log(`      ${String(i * 16).padStart(3)}-${String(i * 16 + 15).padStart(3)} ${p.toFixed(1).padStart(5)}% ${bar(p)}`); });
  const avg = (k) => perSample.reduce((s, r) => s + r[k], 0) / perSample.length;
  ok(`luma: mean Y ${avg('mean').toFixed(1)}, crushed(<=16) ${avg('crushedPct').toFixed(2)}%, clipped(>=235) ${avg('clippedPct').toFixed(2)}% (avg of ${perSample.length} samples)`);
  const hot = perSample.filter((r) => r.clippedPct > 2);
  if (hot.length) warn(`>2% clipped highlights at: ${hot.slice(0, 10).map((r) => `${r.t}s(${r.clippedPct}%)`).join(' ')}`);
  const banded = perSample.filter((r) => r.darkBlocks > 50 && r.bandPct > 1).sort((x, y) => y.bandPct - x.bandPct);
  report.checks.banding = { threshold: '>1% of dark blocks are flat steps', worst: banded.slice(0, 10) };
  if (banded.length) warn(`banding risk (flat 1-4 level steps in dark gradients) at: ${banded.slice(0, 8).map((r) => `${r.t}s(${r.bandPct}%)`).join(' ')}`);
  else ok(`banding: no dark-gradient contour steps (max ${Math.max(...perSample.map((r) => r.bandPct)).toFixed(2)}% of dark blocks)`);
}
finish();

function finish() {
  report.fails = fails; report.warnings = warns;
  report.result = fails.length ? 'FAIL' : warns.length ? 'PASS with warnings' : 'PASS';
  const rf = path.join(outDir, `${name}_qa.json`);
  fs.writeFileSync(rf, JSON.stringify(report, null, 1));
  console.log(`\n${report.result}: ${fails.length} fail(s), ${warns.length} warning(s). Report: ${rf}`);
  if (a.json) console.log(JSON.stringify(report));
  process.exit(fails.length ? 1 : warns.length && a.strict ? 2 : 0);
}
