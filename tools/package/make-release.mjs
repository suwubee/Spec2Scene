import path from 'node:path';
import os from 'node:os';
import {mkdtemp, mkdir, rm, readFile, access} from 'node:fs/promises';
import {cli, isMain, required, run, atomic} from '../lib/cli.mjs';
import {tree, copyTree} from '../lib/tree.mjs';
import {sha256} from '../lib/images.mjs';

export async function makeRelease({source, out, includeMedia = false, verifyHook}) {
  required(source, 'source'); required(out, 'out');
  const input = path.resolve(source), output = path.resolve(out);
  if (output.startsWith(input + path.sep)) throw new Error('Release output must be outside source');
  try { await access(output); throw new Error('Output exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const files = await tree(input, {includeMedia});
  if (!files.length) throw new Error('Empty package');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'scene-release-'));
  try {
    const stage = path.join(temporary, 'stage'), unpacked = path.join(temporary, 'unpacked');
    await mkdir(stage); await mkdir(unpacked);
    await copyTree(input, stage, files);
    await atomic(path.join(stage, 'CONTENTS.sha256'), files.map(f => `${f.sha256}  ${f.path}`).join('\n') + '\n');
    await mkdir(path.dirname(output), {recursive: true});
    const archive = path.join(temporary, 'release.tar.gz');
    await run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', archive, '-C', stage, '.']);
    await run('tar', ['-xzf', archive, '-C', unpacked]);
    for (const entry of files) if (sha256(await readFile(path.join(unpacked, entry.path))) !== entry.sha256) throw new Error('Extracted hash mismatch');
    if (verifyHook) await run(path.resolve(verifyHook), [unpacked]);
    const data = await readFile(archive);
    await atomic(output, data);
    await atomic(output + '.sha256', `${sha256(data)}  ${path.basename(output)}\n`);
    return {status: 'PASS', files: files.length, bytes: data.length, extraction: 'verified', hook: verifyHook ? 'PASS' : 'not configured'};
  } finally { await rm(temporary, {recursive: true, force: true}); }
}
if (isMain(import.meta.url)) {
  const a = cli({source: {type: 'string'}, out: {type: 'string'}, 'include-media': {type: 'boolean'}, 'verify-hook': {type: 'string'}},
  'Usage: tools/package/make-release.sh --source DIR --out FILE.tar.gz [--include-media --verify-hook EXECUTABLE]\n默认排除媒体/模型/测试/缓存/密钥；include-media 仅用于已确认许可的项目资源。钩子接收解压目录参数，失败不生成包。');
  if (a) console.log(JSON.stringify(await makeRelease({source: a.source, out: a.out, includeMedia: a['include-media'], verifyHook: a['verify-hook']})));
}
