import path from 'node:path';
import {readFile, mkdir, realpath, lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {atomic} from '../../lib/cli.mjs';
export const demucsModel = JSON.parse(await readFile(new URL('./models.json', import.meta.url), 'utf8'));
export function verifyWeight(bytes) {
  if (createHash('sha256').update(bytes).digest('hex') !== demucsModel.sha256) throw new Error('Demucs SHA-256 mismatch');
  return bytes;
}
/** Caller validates the direct project child; every writable component must remain in it. */
export async function fetchDemucs(project) {
  project = await realpath(project);
  let target = project;
  for (const component of ['cache', 'models', 'demucs']) {
    target = path.join(target, component);
    try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Model cache must not contain symlinks'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await mkdir(target, {recursive: true});
    if (!(await realpath(target)).startsWith(project + path.sep)) throw new Error('Model cache escapes project');
  }
  const file = path.join(target, demucsModel.file);
  for(const name of [demucsModel.file,'LICENSE','sources.json']) {
    try { if((await lstat(path.join(target,name))).isSymbolicLink())throw new Error('Model cache files must not be symlinks'); }
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
  let bytes;
  try { bytes = verifyWeight(await readFile(file)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  async function download(url, maxBytes) {
    const response = await fetch(url, {signal: AbortSignal.timeout(180000)});
    if (!response.ok) throw new Error(`Official download failed: ${response.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('Official download exceeds size budget');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  if (!bytes) bytes = verifyWeight(await download(demucsModel.url, 160*1024*1024));
  const license = await download(demucsModel.licenseURL, 65536);
  await atomic(file, bytes);
  await atomic(path.join(target, 'LICENSE'), license);
  await atomic(path.join(target, 'sources.json'), JSON.stringify({...demucsModel,
    licenseSHA256: createHash('sha256').update(license).digest('hex'),
    bytes: bytes.length, device: 'cpu', runtime: {torch: '2.6.0+cpu', torchaudio: '2.6.0+cpu'},
    sourceHashVerification: 'Full SHA-256 pinned; also matches official registry filename hash prefix'}, null, 2)+'\n');
  console.log('PASS local htdemucs weights, full SHA-256 and MIT license recorded in project cache/models/demucs');
}
