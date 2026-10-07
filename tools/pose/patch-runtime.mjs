import {readFile} from 'node:fs/promises';
import {cli, isMain, required, atomic, number} from '../lib/cli.mjs';
import {sha256} from '../lib/images.mjs';

export function patchRuntime(input, {expectedSha256, find, replace, count}) {
  if (sha256(Buffer.from(input)) !== expectedSha256) throw new Error('Upstream hash changed; review the runtime again');
  if (!find || !Number.isInteger(count) || count < 1) throw new Error('Exact nonempty match and positive count required');
  const parts = input.split(find);
  if (parts.length - 1 !== count) throw new Error('Unexpected patch match count');
  return parts.join(replace);
}
if (isMain(import.meta.url)) {
  const a = cli({input: {type: 'string'}, output: {type: 'string'}, patch: {type: 'string'}},
    'Usage: node tools/pose/patch-runtime.mjs --input FILE --output FILE --patch JSON\nJSON={expectedSha256,find,replace,count}；由审核者针对固定版本提供补丁，不盲改压缩符号。');
  if (a) {
    const input = await readFile(required(a.input, 'input'), 'utf8');
    const patch = JSON.parse(await readFile(required(a.patch, 'patch'), 'utf8'));
    number(patch.count, 'count', 1, 1000, true);
    const output = patchRuntime(input, patch);
    await atomic(required(a.output, 'output'), output);
    console.log(JSON.stringify({before: sha256(Buffer.from(input)), after: sha256(Buffer.from(output)), count: patch.count}));
  }
}
