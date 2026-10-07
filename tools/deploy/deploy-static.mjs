import path from 'node:path';
import {readFile, mkdir, rename, rm, lstat, realpath} from 'node:fs/promises';
import {cli, isMain, required, atomic} from '../lib/cli.mjs';
import {tree, treeHash, copyTree} from '../lib/tree.mjs';
import {sha256} from '../lib/images.mjs';
import {mime} from '../serve.mjs';

const exists = async file => { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
function validateConfig(config) {
  if (!config.source || !config.destination || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(config.version || '')) throw new Error('source, destination and safe version required');
  if (!Array.isArray(config.smoke) || !config.smoke.length) throw new Error('Nonempty smoke list required');
  for (const item of config.smoke) {
    if (!item.path || item.path.startsWith('/') || item.path.split('/').includes('..') || /[?#\\]/.test(item.path)) throw new Error('Smoke paths must be relative files');
  }
}

export async function deploy(config, {activate = false} = {}) {
  validateConfig(config);
  const source = await realpath(config.source), destination = path.resolve(config.destination);
  if (destination === source || destination.startsWith(source + path.sep) || source.startsWith(destination + path.sep)) throw new Error('Source and destination must be disjoint');
  const files = await tree(source, {runtime: true, includeMedia: true});
  const evidence = JSON.parse(await readFile(required(config.testEvidence, 'testEvidence'), 'utf8'));
  if (evidence.status !== 'PASS' || evidence.exitCode !== 0 || evidence.treeHash !== treeHash(files)) throw new Error('Missing, failed or stale test evidence');
  if (!files.some(f => f.path === 'index.html')) throw new Error('Missing index.html');
  // The entire runtime tree receives a version URL. Absolute local paths would escape that version.
  for (const file of files.filter(f => /\.(html|css|m?js)$/.test(f.path))) {
    const text = await readFile(path.join(source, file.path), 'utf8');
    if (/(?:["'`]\/(?!\/)|url\(\s*\/)/.test(text)) throw new Error(`Use relative runtime URLs: ${file.path}`);
  }
  const ledgerPath = path.join(destination, 'immutable.json');
  let ledger;
  const immutable = config.immutable || ['assets', 'vendor'];
  await mkdir(destination, {recursive: true});
  const lock = path.join(destination, '.deploy-lock');
  await mkdir(lock); // Concurrent preparations/activations must not race the ledger or index.
  const release = path.join(destination, 'releases', config.version);
  let stage;
  try {
    ledger = await exists(ledgerPath) ? JSON.parse(await readFile(ledgerPath, 'utf8')) : {};
  for (const file of files) {
    if (!immutable.some(prefix => file.path.startsWith(prefix + '/'))) continue;
    if (ledger[file.path] && ledger[file.path] !== file.sha256) throw new Error(`Immutable name changed: ${file.path}`);
  }
    if (await exists(release)) {
      if (treeHash(await tree(release, {runtime: true, includeMedia: true})) !== treeHash(files)) throw new Error('Version already contains different bytes');
    } else {
      stage = path.join(destination, `stage-${config.version}-${process.pid}`);
      await mkdir(stage);
      await copyTree(source, stage, files);
      if (treeHash(await tree(stage, {runtime: true, includeMedia: true})) !== treeHash(files)) throw new Error('Staging byte mismatch');
      await mkdir(path.dirname(release), {recursive: true});
      await rename(stage, release);
      stage = null;
    }
    for (const file of files) if (immutable.some(p => file.path.startsWith(p + '/'))) ledger[file.path] = file.sha256;
    await atomic(ledgerPath, JSON.stringify(ledger, null, 2));
    if (!activate) return {status: 'PREPARED', version: config.version, files: files.length};
    const base = new URL(required(config.baseUrl, 'baseUrl'));
    if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Production verification requires HTTPS');
    const checks = [];
    for (const item of config.smoke) {
      const entry = files.find(f => f.path === item.path);
      if (!entry) throw new Error(`Smoke file absent: ${item.path}`);
      const url = new URL(`releases/${config.version}/${item.path}`, base.href.endsWith('/') ? base : new URL(base.href + '/'));
      const response = await fetch(url, {signal: AbortSignal.timeout(15000), redirect: 'error'});
      const bytes = Buffer.from(await response.arrayBuffer());
      const expectedMime = (item.mime || mime(item.path)).split(';')[0];
      if (response.status !== 200 || !response.headers.get('content-type')?.startsWith(expectedMime) || sha256(bytes) !== entry.sha256) {
        throw new Error(`Smoke status/MIME/bytes failed: ${item.path}`);
      }
      if (item.cache && !response.headers.get('cache-control')?.includes(item.cache)) throw new Error(`Cache header failed: ${item.path}`);
      checks.push({path: item.path, status: response.status, sha256: sha256(bytes), mime: response.headers.get('content-type')});
    }
    const index = path.join(destination, 'index.html');
    if (await exists(index)) await atomic(path.join(destination, 'previous-index.html'), await readFile(index));
    const target = `./releases/${config.version}/index.html`;
    await atomic(index, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title>打开场景</title><a href="${target}">打开场景</a></html>\n`);
    await atomic(path.join(destination, 'active.json'), JSON.stringify({version: config.version, checks}, null, 2));
    return {status: 'ACTIVATED', version: config.version, checks};
  } finally {
    if (stage) await rm(stage, {recursive: true, force: true});
    await rm(lock, {recursive: true, force: true});
  }
}
if (isMain(import.meta.url)) {
  const a = cli({config: {type: 'string'}, activate: {type: 'boolean'}},
  'Usage: tools/deploy/deploy-static.sh --config CONFIG.json [--activate]\n默认仅准备版本；激活前按 smoke 核对线上候选的状态、MIME、缓存头与字节。测试证据须匹配发布树。不会修改代理/服务管理器。');
  if (a) console.log(JSON.stringify(await deploy(JSON.parse(await readFile(required(a.config, 'config'), 'utf8')), a), null, 2));
}
