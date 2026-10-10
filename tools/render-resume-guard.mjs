import {readdir, stat, readFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {cli, isMain, number, required} from './lib/cli.mjs';

export function resumeCommand(argv) {
  if (!Array.isArray(argv) || !argv.length || !argv.every(v => typeof v === 'string' && !/[\0\r\n]/.test(v))) throw new Error('Command must be a nonempty JSON string array');
  const result = [], workers = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--resume') continue;
    if (argv[i] === '--workers') { workers.push(Number(argv[++i])); continue; }
    if (argv[i].startsWith('--workers=')) { workers.push(Number(argv[i].split('=')[1])); continue; }
    result.push(argv[i]);
  }
  if (workers.some(w => !Number.isSafeInteger(w) || w < 1) || workers.length > 1) throw new Error('Invalid worker count');
  result.push('--resume', '--workers', String(Math.max(1, Math.floor((workers[0] || 1) / 2))));
  return result.map(v => "'" + v.replaceAll("'", "'\"'\"'") + "'").join(' ');
}

export async function inventory(directory) {
  const result = new Map();
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (!entry.isFile() || !/^(?:frame-\d{6,}|f\d{5,})\.(?:png|jpg)$/.test(entry.name)) continue;
    try {
      const file = await stat(path.join(directory, entry.name));
      if (file.size) result.set(entry.name, `${file.size}:${file.mtimeMs}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}

export function progressTracker({minutes = 3, now = Date.now()} = {}) {
  number(minutes, 'minutes', .001, 1440);
  let last = now, previous;
  return (frames, time = Date.now()) => {
    const progressed = previous && [...frames].some(([name, stamp]) => previous.get(name) !== stamp);
    if (progressed) last = time;
    previous = frames;
    return {frames: frames.size, idleSeconds: (time - last) / 1000, stalled: time - last >= minutes * 60000};
  };
}

export async function watchRender({frames, minutes = 3, pollSeconds = 5, command, expected, signal, report = console.log}) {
  required(frames, 'frames'); number(pollSeconds, 'poll-seconds', .01, 60);
  if (expected !== undefined) number(expected, 'expected', 1, 1e8, true);
  const resume = resumeCommand(command), update = progressTracker({minutes});
  while (!signal?.aborted) {
    const state = update(await inventory(frames));
    // Count is a progress hint, never a substitute for manifest/decode QA.
    if (expected !== undefined && state.frames >= expected) { report(JSON.stringify({...state, status: 'COUNT_REACHED', qaRequired: true})); return 0; }
    if (state.stalled) {
      report(JSON.stringify({...state, status: 'STALLED', action: 'Send INT to your recorded render PID, wait for exit, then resume with the same identity/backend/configuration.', resume}));
      return 2;
    }
    await delay(pollSeconds * 1000, undefined, {signal});
  }
  return 130;
}

if (isMain(import.meta.url)) {
  const a = cli({frames: {type: 'string'}, command: {type: 'string'}, minutes: {type: 'string', default: '3'},
    'poll-seconds': {type: 'string', default: '5'}, expected: {type: 'string'}},
  'Usage: node tools/render-resume-guard.mjs --frames DIR --command argv.json [--minutes 3 --poll-seconds 5 --expected N]\nOnly watches complete frame filenames; reports a safely quoted resume command with fewer workers. Never signals processes or executes the command.');
  if (a) {
    const controller = new AbortController();
    for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
    try {
      process.exitCode = await watchRender({frames: a.frames, command: JSON.parse(await readFile(required(a.command, 'command'), 'utf8')),
        minutes: Number(a.minutes), pollSeconds: Number(a['poll-seconds']), expected: a.expected === undefined ? undefined : Number(a.expected), signal: controller.signal});
    } catch (error) { if (error.name === 'AbortError') process.exitCode = 130; else throw error; }
  }
}
