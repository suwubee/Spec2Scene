import path from 'node:path';
import {readdir, mkdir} from 'node:fs/promises';
import {cli, isMain, number, required, run} from './lib/cli.mjs';

export async function encode({frames, out, fps = 24, start = 0, count, audio, crf = 18}) {
  required(frames, 'frames'); required(out, 'out');
  number(fps, 'fps', 1, 240); number(start, 'start', 0, 1e8, true); number(crf, 'crf', 0, 51, true);
  const files = new Set(await readdir(frames));
  count ??= [...files].filter(file => /^frame-\d{6,}\.png$/.test(file)).length;
  number(count, 'count', 1, 1e8, true);
  for (let i = start; i < start + count; i++) {
    if (!files.has(`frame-${String(i).padStart(6, '0')}.png`)) throw new Error(`Missing frame ${i}`);
  }
  await mkdir(path.dirname(out), {recursive: true});
  const args = ['-hide_banner', '-loglevel', 'error', '-n', '-threads', '1', '-framerate', String(fps),
    '-start_number', String(start), '-i', path.join(frames, 'frame-%06d.png')];
  if (audio) args.push('-ss', String(start / fps), '-i', audio);
  args.push('-map', '0:v:0');
  if (audio) args.push('-map', '1:a:0', '-af', 'apad', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  args.push('-t', String(count / fps), '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-threads', '1', '-crf', String(crf), '-preset', 'medium',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', out);
  await run('ffmpeg', args);
  return {frames: count, duration: count / fps};
}
if (isMain(import.meta.url)) {
  const a = cli({frames: {type: 'string'}, out: {type: 'string'}, audio: {type: 'string'},
    fps: {type: 'string', default: '24'}, start: {type: 'string', default: '0'}, count: {type: 'string'},
    crf: {type: 'string', default: '18'}}, 'Usage: node tools/encode.mjs --frames DIR --out FILE [--audio FILE --fps 24 --start 0 --count N --crf 18]');
  if (a) { for (const key of ['fps', 'start', 'count', 'crf']) if (a[key] !== undefined) a[key] = Number(a[key]);
    console.log(JSON.stringify(await encode(a))); }
}
