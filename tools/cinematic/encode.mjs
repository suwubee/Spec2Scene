#!/usr/bin/env node
// Author: suwubee
// Frames directory -> final MP4 (H.264 High, yuv420p, BT.709 matrix + tags, AAC 320k 48 kHz, +faststart).
//
//   node tools/cinematic/encode.mjs --frames work/frames --out work/film.mp4
//   node tools/cinematic/encode.mjs --frames DIR --range 1200:1440 --out work/preview_1200.mp4    # partial + audio slice
//   node tools/cinematic/encode.mjs --frames DIR --pad ...    # frames are 1920x804 picture-only -> pad onto 1920x1080 (138 px bars)
//
// Options
//   --frames DIR        f%05d.png|jpg files (absolute frame indices, as written by render_frames.mjs)
//   --out FILE          output .mp4 (default <frames>/../<basename>.mp4)
//   --fps N             24
//   --range A:B         encode frames A..B-1 (default: lowest..highest frame found). Audio is sliced to match.
//   --every K           explicit sparse-frame stride (default 1); output fps = fps/K
//   --pad               pad WxH picture to 1920x1080 centred (black bars) - for picture-only frames
//   --crf 14 --preset slow
//   --x264 PARAMS       default "aq-mode=3:psy-rd=1.0,0.15:deblock=-1,-1" (chosen in dev/bench_encode.mjs, tools/cinematic/README.md)
//   --maxrate 50M --bufsize 62.5M   VBV cap (keeps High@4.1 compliant), "--maxrate 0" disables
//   --allow-missing     fill missing frames with the previous frame (default: fail and list them)
//   --threads N         x264 threads (default: auto)
//   --dry-run           print the ffmpeg command only
// The audio is padded with silence to the exact video duration (frames/fps) so |A-V| < 1 AAC frame.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from './lib/browser.mjs';

const a = parseArgs(process.argv.slice(2), ['pad', 'no-audio', 'allow-missing', 'dry-run', 'help']);
if (a.help || !a.frames) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
  process.exit(a.help ? 0 : 1);
}
const framesDir = path.resolve(a.frames);
const fps = +(a.fps || 24);
const out = path.resolve(a.out || path.join(path.dirname(framesDir), path.basename(framesDir) + '.mp4'));

// ---- frame inventory ----
const found = new Map();
for (const n of fs.readdirSync(framesDir)) {
  const m = /^f(\d{5,})\.(png|jpg)$/.exec(n);
  if (m) found.set(+m[1], n);
}
if (!found.size) { console.error(`[encode] no f#####.png|jpg frames in ${framesDir}`); process.exit(1); }
const all = [...found.keys()].sort((x, y) => x - y);
let [A, B] = a.range ? String(a.range).split(':').map(Number) : [all[0], all.at(-1) + 1];
// A missing regular subsequence must not silently become a lower-frame-rate film.
const every = +(a.every ?? 1);
if(![fps,A,B,every].every(Number.isFinite)||fps<=0||fps>120||A<0||B<=A||![A,B,every].every(Number.isInteger)||every<1||(B-A)/every>100000)throw new Error('invalid encode range/fps/every');
const wanted = [];
for (let f = A; f < B; f += every) wanted.push(f);
const missing = wanted.filter((f) => !found.has(f));
if (missing.length && !a['allow-missing']) {
  console.error(`[encode] ${missing.length} missing frame(s) in ${A}:${B} step ${every}: ${missing.slice(0, 40).join(',')}${missing.length > 40 ? ',...' : ''}  (use --allow-missing to duplicate neighbours)`);
  process.exit(3);
}
const outFps = fps / every;
const durSec = wanted.length / outFps;

// input: contiguous run -> image2 sequence; otherwise a symlinked, renumbered sequence
let inputArgs;
const ext = path.extname(found.get(wanted.find((f) => found.has(f)))).slice(1);
const contiguous = every === 1 && !missing.length && wanted.every((f) => path.extname(found.get(f)) === '.' + ext);
let tmpDir = null;
if (contiguous) {
  inputArgs = ['-framerate', String(outFps), '-start_number', String(A), '-i', path.join(framesDir, `f%05d.${ext}`)];
} else {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '.encode-seq-'));
  process.once('exit',()=>fs.rmSync(tmpDir,{recursive:true,force:true}));
  let last = null, linkOk = true;
  wanted.forEach((f, i) => {
    const src = found.has(f) ? path.join(framesDir, found.get(f)) : last;
    if (!src) throw new Error(`first frame ${f} missing, cannot fill`);
    last = src;
    const dst = path.join(tmpDir, `s${String(i).padStart(6, '0')}.${ext}`);
    if (linkOk) { try { fs.symlinkSync(src, dst); return; } catch { linkOk = false; } }   // Windows without symlink rights: copy instead
    fs.copyFileSync(src, dst);
  });
  inputArgs = ['-framerate', String(outFps), '-start_number', '0', '-i', path.join(tmpDir, `s%06d.${ext}`)];
}

// ---- filters ----
const vf = [];
if (a.pad) vf.push('pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black');
// explicit BT.709 matrix, limited range, accurate rounding + full chroma interpolation (swscale defaults to BT.601!)
vf.push('scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int+full_chroma_inp', 'format=yuv420p',
  // the PNG sRGB chunk would otherwise propagate transfer=iec61966-2-1 into the stream; standard web video tag is bt709
  'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709');

const x264 = a.x264 || 'aq-mode=3:psy-rd=1.0,0.15:deblock=-1,-1';
const args = ['-hide_banner', '-loglevel', 'warning', '-stats', '-y', ...inputArgs];
const audio = a['no-audio'] ? null : (a.audio || null);
if (audio) {
  const t0 = A / fps;
  args.push('-ss', t0.toFixed(6), '-t', durSec.toFixed(6), '-i', audio);
}
args.push('-map', '0:v:0', '-frames:v', String(wanted.length));
if (audio) args.push('-map', '1:a:0');
args.push('-vf', vf.join(','),
  '-c:v', 'libx264', '-preset', a.preset || 'slow', '-crf', String(a.crf ?? 14), '-profile:v', 'high', '-level:v', '4.1',
  '-x264-params', x264, '-pix_fmt', 'yuv420p',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-chroma_sample_location', 'left');
if (String(a.maxrate ?? '50M') !== '0') args.push('-maxrate', String(a.maxrate || '50M'), '-bufsize', String(a.bufsize || '62.5M'));
args.push('-threads', String(a.threads || 2), '-filter_threads','2');
if (audio) args.push('-af', `apad=whole_dur=${durSec.toFixed(6)}`, '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2');
args.push('-metadata',`comment=mv_start_frame=${A};mv_every=${every};mv_fps=${fps}`, '-movflags','+faststart',out);
// Film frame numbering is read back by QA.

console.error(`[encode] ${wanted.length} frames ${A}..${B - 1} step ${every} @ ${outFps} fps = ${durSec.toFixed(3)} s${audio ? `, audio ${path.basename(audio)} from ${(A / fps).toFixed(3)} s` : ', no audio'}${a.pad ? ', padded to 1920x1080' : ''}`);
console.error('[encode] ffmpeg ' + args.map((x) => (/[\s;,()]/.test(x) ? `'${x}'` : x)).join(' '));
if (a['dry-run']) process.exit(0);
fs.mkdirSync(path.dirname(out), { recursive: true });
const t0 = Date.now();
const p = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
const code = await new Promise((r) => p.on('close', r));
if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
if (code !== 0) { console.error(`[encode] ffmpeg failed (${code})`); process.exit(code || 1); }
const sec = (Date.now() - t0) / 1000;
console.error(`[encode] wrote ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB) in ${sec.toFixed(1)} s (${(wanted.length / sec).toFixed(1)} fps)`);
console.log(out);
