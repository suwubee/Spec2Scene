import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {mkdir, writeFile, rename} from 'node:fs/promises';
import path from 'node:path';

export const isMain = url => Boolean(process.argv[1]) && url === pathToFileURL(path.resolve(process.argv[1])).href;

export function cli(options, help, args = process.argv.slice(2)) {
  const result = parseArgs({args, options: {help: {type: 'boolean', short: 'h'}, ...options}});
  if (result.values.help) {
    console.log(help);
    return null;
  }
  return result.values;
}

export function number(value, name, min = 0, max = Infinity, integer = false) {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(`${name}: expected ${integer ? 'integer' : 'number'} in [${min}, ${max}]`);
  }
  return n;
}

export function required(value, name) {
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

export async function atomic(file, data) {
  await mkdir(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, file);
}

export async function run(program, args, {maxBytes = 64 * 1024 * 1024, ...options} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {stdio: ['ignore', 'pipe', 'pipe'], ...options});
    let size = 0;
    const stdout = [], stderr = [];
    const collect = list => chunk => {
      size += chunk.length;
      if (size > maxBytes) child.kill('SIGTERM');
      else list.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', reject);
    child.once('close', code => {
      const result = {stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString(), code};
      if (code !== 0 || size > maxBytes) reject(new Error(`${program} failed (${code}): ${result.stderr.slice(-4000)}`));
      else resolve(result);
    });
  });
}
