import path from 'node:path';
import {readdir} from 'node:fs/promises';
import {cli, isMain, number, run, atomic} from './lib/cli.mjs';
import {imageStats} from './lib/images.mjs';

export async function qaFrames({frames, compare, fps = 24, freezeSeconds = 1}) {
  number(fps, 'fps', 1, 240); number(freezeSeconds, 'freeze-seconds', 0.01, 3600);
  const files = (await readdir(frames)).filter(f => /^frame-\d+\.png$/.test(f)).sort();
  if (!files.length) throw new Error('No frames');
  const issues = [], stats = [];
  let previous, frozen = 0, previousNumber;
  const comparison = compare ? (await readdir(compare)).filter(f => /^frame-\d+\.png$/.test(f)).sort() : null;
  if (comparison && JSON.stringify(files) !== JSON.stringify(comparison)) issues.push({type: 'determinism-file-set', severity: 'fail'});
  for (const file of files) {
    const index = Number(/\d+/.exec(file)[0]);
    if (previousNumber !== undefined && index !== previousNumber + 1) issues.push({type: 'missing-frame', file, severity: 'fail'});
    previousNumber = index;
    const s = await imageStats(path.join(frames, file));
    stats.push({file, ...s});
    if (s.blackFraction > 0.98) issues.push({type: 'black', file, severity: 'warning'});
    if (s.grayLevels < 32 && s.meanLstar < 40) issues.push({type: 'banding-candidate', file, severity: 'warning'});
    frozen = previous === s.pixelHash ? frozen + 1 : 0;
    if (frozen === Math.ceil(fps * freezeSeconds)) issues.push({type: 'freeze', file, severity: 'warning'});
    previous = s.pixelHash;
    if (compare) {
      try {
        const other = await imageStats(path.join(compare, file));
        if (other.pixelHash !== s.pixelHash || other.width !== s.width || other.height !== s.height) {
          issues.push({type: 'determinism', file, severity: 'fail'});
        }
      } catch { issues.push({type: 'missing-comparison', file, severity: 'fail'}); }
    }
  }
  return {frames: files.length, issues, stats};
}
export async function qaVideo(file, maxAv = 0.05) {
  const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])).stdout);
  const video = probe.streams.find(s => s.codec_type === 'video');
  const audio = probe.streams.find(s => s.codec_type === 'audio');
  if (!video) throw new Error('No video stream');
  const issues = [];
  const avDelta = audio ? Math.abs(Number(video.duration) - Number(audio.duration)) : null;
  const startDelta = audio ? Math.abs(Number(video.start_time || 0) - Number(audio.start_time || 0)) : null;
  if (audio && (!Number.isFinite(avDelta) || avDelta > maxAv || startDelta > maxAv)) issues.push({type: 'av-duration-or-start', severity: 'fail'});
  if (video.pix_fmt !== 'yuv420p' || video.color_space !== 'bt709') issues.push({type: 'format', severity: 'warning'});
  const decoded = await run('ffmpeg', ['-hide_banner', '-nostdin', '-xerror', '-threads', '1', '-i', file,
    '-vf', 'blackdetect=d=0.1:pix_th=0.05,freezedetect=n=-60dB:d=1', '-threads', '1', '-f', 'null', '-']);
  for (const line of decoded.stderr.split('\n')) {
    if (/black_start:|freeze_start:/.test(line)) issues.push({type: 'video-visual', detail: line, severity: 'warning'});
  }
  return {duration: Number(video.duration), avDelta, startDelta, audio: Boolean(audio), decode: 'PASS', issues};
}
if (isMain(import.meta.url)) {
  const a = cli({frames: {type: 'string'}, compare: {type: 'string'}, video: {type: 'string'}, out: {type: 'string'},
    fps: {type: 'string', default: '24'}, 'freeze-seconds': {type: 'string', default: '1'}, strict: {type: 'boolean'}},
  'Usage: node tools/qa.mjs [--frames DIR --compare DIR --fps 24 --freeze-seconds 1] [--video FILE] [--out REPORT.json --strict]\n黑场、冻结、色带是候选警告；需审片确认有意事件。--strict 将警告也视为失败。');
  if (a) {
    if (!a.frames && !a.video) throw new Error('Provide --frames or --video');
    const report = {};
    if (a.frames) report.frames = await qaFrames({frames: a.frames, compare: a.compare, fps: Number(a.fps), freezeSeconds: Number(a['freeze-seconds'])});
    if (a.video) report.video = await qaVideo(a.video);
    const issues = Object.values(report).flatMap(r => r.issues);
    report.status = issues.some(i => i.severity === 'fail' || a.strict) ? 'FAIL' : 'PASS';
    if (a.out) await atomic(a.out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'FAIL') process.exitCode = 1;
  }
}
