import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, mkdir, rm, copyFile, realpath, rename} from 'node:fs/promises';
import {cli, required, run, atomic} from '../tools/lib/cli.mjs';

const a = cli({project: {type: 'string'}, kind: {type: 'string', default: 'pose'}},
  'Usage: scripts/fetch-models.sh --project projects/NAME [--kind pose|hand|face]\n仅下载到现有 projects 子项目；官方包校验 npm integrity，模型固定版本并记录 SHA-256 与许可来源。不提交模型。');
if (a) {
  if (!['pose', 'hand', 'face'].includes(a.kind)) throw new Error('Unknown kind');
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const projects = await realpath(path.join(repo, 'projects'));
  const project = await realpath(required(a.project, 'project'));
  if (!project.startsWith(projects + path.sep) || path.dirname(project) !== projects) throw new Error('Project must be a direct projects child');
  const staging = await mkdtemp(path.join(os.tmpdir(), 'scene-models-'));
  const version = '0.10.32';
  async function download(url) {
    const response = await fetch(url, {signal: AbortSignal.timeout(120000)});
    if (!response.ok) throw new Error(`Official download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  try {
    const metadata = JSON.parse((await download(`https://registry.npmjs.org/@mediapipe/tasks-vision/${version}`)).toString());
    const archive = await download(metadata.dist.tarball);
    const [algorithm, expected] = metadata.dist.integrity.split('-');
    if (!['sha512', 'sha256'].includes(algorithm) || createHash(algorithm).update(archive).digest('base64') !== expected) throw new Error('npm integrity mismatch');
    const tar = path.join(staging, 'runtime.tgz');
    await atomic(tar, archive);
    await run('tar', ['-xzf', tar, '-C', staging, 'package/vision_bundle.mjs', 'package/wasm/vision_wasm_internal.js',
      'package/wasm/vision_wasm_internal.wasm']);
    const bundle = await readFile(path.join(staging, 'package/vision_bundle.mjs'), 'utf8');
    // This pinned release is audited for known telemetry markers; unknown upgrades require a new review.
    if (/odml\.pa|\/v1\/log|sendBeacon/.test(bundle)) throw new Error('Telemetry marker found: review and apply a hash-pinned patch before distribution');
    const modelId = {pose: 'pose_landmarker_lite', hand: 'hand_landmarker', face: 'face_landmarker'}[a.kind];
    const modelURL = `https://storage.googleapis.com/mediapipe-models/${a.kind}_landmarker/${modelId}/float16/1/${modelId}.task`;
    const model = await download(modelURL);
    const target = path.join(project, 'vendor');
    await mkdir(path.join(target, 'vision'), {recursive: true});
    await mkdir(path.join(target, 'models'), {recursive: true});
    for (const [from, to] of [['vision_bundle.mjs', 'vision_bundle.mjs'], ['wasm/vision_wasm_internal.js', 'vision_wasm_internal.js'],
      ['wasm/vision_wasm_internal.wasm', 'vision_wasm_internal.wasm.bin']]) {
      await copyFile(path.join(staging, 'package', from), path.join(target, 'vision', to));
    }
    await atomic(path.join(target, 'models', `${a.kind}.task.bin`), model);
    const license = await download('https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/LICENSE');
    await atomic(path.join(target, 'vision', 'LICENSE'), license);
    const manifest = {runtime: {version, integrity: metadata.dist.integrity, license: metadata.license},
      model: {kind: a.kind, version: 1, sha256: createHash('sha256').update(model).digest('hex'), source: modelURL},
      licenseReview: 'Review the official model card and applicable terms before redistribution',
      modelCard: 'https://ai.google.dev/edge/mediapipe/solutions/vision',
      privacy: 'Known telemetry markers absent in pinned bundle; enforce CSP and repeat browser network audit after upgrades'};
    await atomic(path.join(target, `${a.kind}-sources.json`), JSON.stringify(manifest, null, 2));
    console.log(`PASS local ${a.kind} model and runtime installed; review vendor/${a.kind}-sources.json`);
  } finally { await rm(staging, {recursive: true, force: true}); }
}
