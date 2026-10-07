import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp, writeFile, readFile, mkdir, rm, access, symlink} from 'node:fs/promises';
import {localServer} from './helpers.mjs';
import {tree} from '../lib/tree.mjs';
import {run} from '../lib/cli.mjs';
import {recordEvidence} from '../deploy/test-evidence.mjs';
import {deploy} from '../deploy/deploy-static.mjs';
import {makeRelease} from '../package/make-release.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'scene-release-test-'));
  t.after(() => rm(base, {recursive: true, force: true}));
  const source = path.join(base, 'source'); await mkdir(source); await mkdir(path.join(source, 'src'));
  await mkdir(path.join(source, 'assets')); await writeFile(path.join(source, 'index.html'), '<script type="module" src="./src/main.js"></script>');
  await writeFile(path.join(source, 'src/main.js'), 'export const value = 1;');
  await writeFile(path.join(source, 'assets/item.json'), '{"v":1}');
  return {base, source};
}

test('release excludes cache, secrets and media; validates extraction; hook failure prevents package', async t => {
  const {base, source} = await fixture(t);
  for (const dir of ['tests', 'node_modules']) { await mkdir(path.join(source, dir)); await writeFile(path.join(source, dir, 'data'), 'excluded'); }
  for (const name of ['.env', 'private.key', 'image.png']) await writeFile(path.join(source, name), 'excluded');
  const out = path.join(base, 'release.tar.gz');
  const result = await makeRelease({source, out}); assert.equal(result.status, 'PASS');
  const listing = (await run('tar', ['-tzf', out])).stdout.toString();
  assert.match(listing, /CONTENTS.sha256/); assert.doesNotMatch(listing, /node_modules|private.key|image.png|\.env|tests\//);
  assert.match(await readFile(out + '.sha256', 'utf8'), /^[a-f0-9]{64}  release.tar.gz/);
  await assert.rejects(makeRelease({source, out}), /exists/);
  const hook = path.join(base, 'fail.sh'); await writeFile(hook, '#!/bin/sh\nexit 9\n', {mode: 0o755});
  await assert.rejects(makeRelease({source, out: path.join(base, 'bad.tar.gz'), verifyHook: hook}), /failed \(9\)/);
  await assert.rejects(access(path.join(base, 'bad.tar.gz')));
  await symlink(out, path.join(source, 'escape')); await assert.rejects(tree(source), /Symlink/);
});

test('deploy gates tests, versions runtime, rejects immutable edits and compares served bytes before activation', async t => {
  const {base, source} = await fixture(t), destination = path.join(base, 'public');
  const evidence = path.join(base, 'evidence.json');
  const config = {source, destination, testEvidence: evidence, version: 'v1', smoke: [{path: 'index.html', cache: 'no-cache'}, {path: 'src/main.js'}]};
  await assert.rejects(deploy(config));
  await assert.rejects(recordEvidence(source, [process.execPath, '-e', 'process.exit(1)'], evidence));
  await assert.rejects(access(evidence));
  await recordEvidence(source, [process.execPath, '-e', 'console.log("tests passed")'], evidence);
  assert.equal((await deploy(config)).status, 'PREPARED');
  await assert.rejects(access(path.join(destination, 'index.html')));
  const server = await localServer(destination); t.after(() => server.close());
  config.baseUrl = server.url + '/';
  assert.equal((await deploy(config, {activate: true})).status, 'ACTIVATED');
  assert.match(await readFile(path.join(destination, 'index.html'), 'utf8'), /releases\/v1\/index.html/);
  await writeFile(path.join(source, 'src/main.js'), 'export const value = 2;');
  await assert.rejects(deploy({...config, version: 'v2'}), /stale/);
  await recordEvidence(source, [process.execPath, '-e', 'process.exit(0)'], evidence);
  assert.equal((await deploy({...config, version: 'v2'}, {activate: true})).status, 'ACTIVATED');
  assert.match(await readFile(path.join(destination, 'previous-index.html'), 'utf8'), /releases\/v1/);
  await writeFile(path.join(source, 'assets/item.json'), '{"v":2}');
  await recordEvidence(source, [process.execPath, '-e', 'process.exit(0)'], evidence);
  await assert.rejects(deploy({...config, version: 'v3'}), /Immutable name changed/);
  assert.match(await readFile(path.join(destination, 'index.html'), 'utf8'), /releases\/v2/);
  await assert.rejects(deploy({...config, version: '../escape'}));
});
