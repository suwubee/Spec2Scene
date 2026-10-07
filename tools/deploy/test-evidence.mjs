import path from 'node:path';
import {cli, isMain, required, run, atomic} from '../lib/cli.mjs';
import {tree, treeHash} from '../lib/tree.mjs';

export async function recordEvidence(source, command, out) {
  if (!Array.isArray(command) || !command.length || !command.every(x => typeof x === 'string')) throw new Error('Command must be a JSON argv array');
  const before = treeHash(await tree(source, {includeMedia: true, runtime: true}));
  const result = await run(command[0], command.slice(1), {cwd: path.resolve(source)});
  const after = treeHash(await tree(source, {includeMedia: true, runtime: true}));
  if (before !== after) throw new Error('Runtime artifact changed during tests; rebuild and retest');
  const evidence = {status: 'PASS', exitCode: result.code, treeHash: after, command,
    stdout: result.stdout.toString(), stderr: result.stderr};
  await atomic(out, JSON.stringify(evidence, null, 2));
  return evidence;
}
if (isMain(import.meta.url)) {
  const a = cli({source: {type: 'string'}, command: {type: 'string'}, out: {type: 'string'}},
    'Usage: node tools/deploy/test-evidence.mjs --source SITE --command \'["npm","test"]\' --out EVIDENCE.json\n在 source 中运行测试，失败不生成通过证据；out 放在 source 外。');
  if (a) { await recordEvidence(required(a.source, 'source'), JSON.parse(required(a.command, 'command')), required(a.out, 'out'));
    console.log('PASS test evidence recorded'); }
}
