import path from 'node:path';
import {readdir, lstat, readFile, mkdir, copyFile, chmod} from 'node:fs/promises';
import {sha256} from './images.mjs';

const excluded = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.cache', 'dist', 'out', 'work', 'tests', 'review', 'research']);
const secret = /(?:^\.env(?:\.|$)|\.(?:key|pem|p12|pfx)$)/i;
const media = /\.(?:mp3|mp4|png|jpe?g|wav|task|bin|vrm|glb|webm|ogg)$/i;
export async function tree(root, {includeMedia = false, runtime = false} = {}) {
  const files = [];
  async function walk(dir, prefix = '') {
    for (const entry of (await readdir(dir)).sort()) {
      if (excluded.has(entry) || secret.test(entry) || entry.startsWith('.') || entry === 'CONTENTS.sha256') continue;
      if (runtime && ['tools', 'tools.local', 'docs', 'scripts'].includes(entry)) continue;
      const file = path.join(dir, entry), rel = prefix + entry;
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error(`Symlink not allowed in release: ${rel}`);
      if (info.isDirectory()) await walk(file, rel + '/');
      else if (info.isFile() && (includeMedia || !media.test(entry)) && !(runtime && /\.(md|py|sh|test\.mjs)$/i.test(entry))) {
        if (/[\r\n\\]/.test(rel)) throw new Error('Unsafe release filename');
        files.push({path: rel, sha256: sha256(await readFile(file)), mode: info.mode & 0o777});
      }
    }
  }
  await walk(root);
  return files;
}
export const treeHash = files => sha256(Buffer.from(JSON.stringify(files)));
export async function copyTree(source, destination, files) {
  for (const entry of files) {
    const target = path.join(destination, entry.path);
    await mkdir(path.dirname(target), {recursive: true});
    await copyFile(path.join(source, entry.path), target);
    await chmod(target, entry.mode);
  }
}
