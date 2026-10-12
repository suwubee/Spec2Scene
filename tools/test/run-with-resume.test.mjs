import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, chmod} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const exec = promisify(execFile);
const WRAP = fileURLToPath(new URL('../../agents/run-with-resume.sh', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const run = (args, opts = {}) => exec('bash', [WRAP, ...args], {timeout: 60000, ...opts}).then(r => ({code: 0, ...r}), e => ({code: e.code, stdout: e.stdout, stderr: e.stderr}));

async function freePort(min = Number(process.env.SCENE_TEST_PORT_MIN || 39920), max = Number(process.env.SCENE_TEST_PORT_MAX || 39939)) {
  for (let port = max; port >= min; port--) {
    const ok = await new Promise(resolve => { const s = net.createServer().once('error', () => resolve(false)).listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
    if (ok) return port;
  }
  throw new Error('no free assigned loopback port');
}

// Fake launcher: reads the prompt from stdin, records it, and behaves according to a per-attempt script.
async function fakeLauncher(dir, behaviour) {
  const file = path.join(dir, 'fake-launch.sh');
  await writeFile(file, `#!/usr/bin/env bash
set -u
cat > "${dir}/seen-$RESUME_ATTEMPT.md"
printf '%s\\n' "$RESUME_PROMPT_FILE" > "${dir}/arg-$RESUME_ATTEMPT.txt"
printf '%s\\n' "$@" >> "${dir}/arg-$RESUME_ATTEMPT.txt"
${behaviour}
`);
  await chmod(file, 0o755);
  return file;
}

test('run-with-resume: help, syntax and usage errors', async () => {
  await exec('bash', ['-n', WRAP]);
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--retry-after SECONDS/);
  assert.match(help.stdout, /--max-attempts N/);
  assert.match(help.stdout, /by PID/);
  assert.equal((await run(['--log-dir', os.tmpdir(), '--', 'true'])).code, 2, 'missing prompt');
  const d = await mkdtemp(path.join(os.tmpdir(), 'resume-usage-'));
  try {
    await writeFile(path.join(d, 'p.md'), 'task');
    assert.equal((await run(['--prompt', path.join(d, 'p.md'), '--log-dir', d])).code, 2, 'missing launch command');
    assert.equal((await run(['--prompt', path.join(d, 'p.md'), '--log-dir', d, '--ports', 'abc', '--', 'true'])).code, 2, 'bad port');
    assert.equal((await run(['--prompt', path.join(d, 'p.md'), '--log-dir', d, '--pattern', '(', '--', 'true'])).code, 2, 'invalid regex');
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('run-with-resume: transient provider error → orphan server killed by PID, resumed with breakpoint note, then done', {timeout: 60000}, async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'resume-ok-'));
  const port = await freePort();
  let orphan = 0;
  try {
    await writeFile(path.join(d, 'prompt.md'), 'Build the hero part. Round 2.\n');
    // Attempt 1 leaves a detached server on the assigned port (as a cut-off session would) and dies of an overload.
    const launcher = await fakeLauncher(d, `
if [ "$RESUME_ATTEMPT" = 1 ]; then
  setsid ${JSON.stringify(process.execPath)} -e "require('http').createServer((q,s)=>s.end('x')).listen(${port},'127.0.0.1')" >/dev/null 2>&1 < /dev/null &
  echo $! > "${d}/orphan.pid"
  for i in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && break; sleep 0.1; done
  echo "working on step 3"
  echo "stream error: 503 Service Unavailable — model overloaded" >&2
  exit 1
fi
echo "resumed and finished"
exit 0`);
    const r = await run(['--prompt', path.join(d, 'prompt.md'), '--log-dir', path.join(d, 'logs'), '--retry-after', '0', '--max-attempts', '3', '--ports', String(port), '--', launcher, '--prompt-path', '{prompt_file}']);
    orphan = Number((await readFile(path.join(d, 'orphan.pid'), 'utf8')).trim());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`port ${port}: killing orphaned PID`));
    assert.equal(alive(orphan), false, 'orphaned server must be gone');
    const first = await readFile(path.join(d, 'seen-1.md'), 'utf8'), second = await readFile(path.join(d, 'seen-2.md'), 'utf8');
    assert.equal(first, 'Build the hero part. Round 2.\n', 'attempt 1 gets the original prompt');
    assert.match(second, /^断点续跑 \/ Resume from breakpoint/);
    assert.match(second, /attempt 2 of 3/);
    assert.ok(second.endsWith('Build the hero part. Round 2.\n'), 'the original prompt follows the note');
    const args2 = (await readFile(path.join(d, 'arg-2.txt'), 'utf8')).trim().split('\n');
    assert.equal(args2[0], path.join(d, 'logs', 'prompt-2.md'));
    assert.deepEqual(args2.slice(1), ['--prompt-path', path.join(d, 'logs', 'prompt-2.md')], '{prompt_file} is substituted');
    const tsv = (await readFile(path.join(d, 'logs', 'attempts.tsv'), 'utf8')).trim().split('\n').map(l => l.split('\t').slice(0, 3));
    assert.deepEqual(tsv, [['attempt', 'result', 'exit'], ['1', 'transient', '1'], ['2', 'done', '0']]);
  } finally {
    if (orphan && alive(orphan)) process.kill(orphan, 'SIGKILL');
    await rm(d, {recursive: true, force: true});
  }
});

test('run-with-resume: a real task failure is not retried; exhausted attempts exit 75; a failing probe spends attempts', {timeout: 60000}, async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'resume-fail-'));
  try {
    await writeFile(path.join(d, 'prompt.md'), 'task\n');
    const failing = await fakeLauncher(d, 'echo "AssertionError: expected 3 to equal 4"; exit 4');
    const f = await run(['--prompt', path.join(d, 'prompt.md'), '--log-dir', path.join(d, 'a'), '--retry-after', '0', '--', failing]);
    assert.equal(f.code, 4, 'launcher exit code passes through');
    assert.match(f.stderr, /no transient marker; not retrying/);

    const overloaded = await fakeLauncher(d, 'echo "Error: rate limit reached, try later"; exit 0');
    const g = await run(['--prompt', path.join(d, 'prompt.md'), '--log-dir', path.join(d, 'b'), '--retry-after', '0', '--max-attempts', '2', '--', overloaded]);
    assert.equal(g.code, 75, 'a transient marker counts even when the launcher exits 0');
    assert.match(g.stderr, /gave up after 2 attempts/);

    const custom = await fakeLauncher(d, 'echo "upstream said: BUSY-7"; exit 1');
    const h = await run(['--prompt', path.join(d, 'prompt.md'), '--log-dir', path.join(d, 'c'), '--retry-after', '0', '--max-attempts', '3', '--pattern', 'BUSY-[0-9]', '--probe', 'exit 1', '--', custom]);
    assert.equal(h.code, 75);
    const rows = (await readFile(path.join(d, 'c', 'attempts.tsv'), 'utf8')).trim().split('\n').slice(1).map(l => l.split('\t')[1]);
    assert.deepEqual(rows, ['transient', 'probe-failed', 'probe-failed'], 'the probe gates every retry');

    // The launcher writes its own log (like dispatch.sh): the marker is found through --watch; a stale file is ignored.
    const own = await fakeLauncher(d, `if [ "$RESUME_ATTEMPT" = 1 ]; then echo "Reconnecting... 5/5" > "${d}/own.log"; fi; exit 0`);
    const w = await run(['--prompt', path.join(d, 'prompt.md'), '--log-dir', path.join(d, 'w'), '--retry-after', '0', '--max-attempts', '3', '--watch', path.join(d, 'own.log'), '--', own]);
    assert.equal(w.code, 0, w.stderr);
    assert.deepEqual((await readFile(path.join(d, 'w', 'attempts.tsv'), 'utf8')).trim().split('\n').slice(1).map(l => l.split('\t')[1]), ['transient', 'done']);

    const quoted = await fakeLauncher(d, 'echo "earlier test output mentions 503 once"; for i in $(seq 1 30); do echo "step $i ok"; done; exit 0');
    const q = await run(['--prompt', path.join(d, 'prompt.md'), '--log-dir', path.join(d, 'q'), '--retry-after', '0', '--tail', '10', '--', quoted]);
    assert.equal(q.code, 0, 'only the log tail is matched');
  } finally { await rm(d, {recursive: true, force: true}); }
});
