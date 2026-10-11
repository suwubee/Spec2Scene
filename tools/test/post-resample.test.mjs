// post.lens.resample: optional Catmull-Rom reconstruction in the develop pass. The default must stay bilinear and leave
// every existing output unchanged. Unit part runs everywhere; the WebGL2 part (SCENE_PICTURE_BROWSER=1) renders a 1-px
// test pattern through createPost and checks: default == explicit 'bilinear' == the pre-option develop sampling
// (byte-identical), 'catrom' differs and keeps more 1-px contrast.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {DEFAULT_POST, mergePost, resampleMode} from '../../tracks/music-video/engine/post.js';
import {localServer} from './helpers.mjs';

const engineDir = fileURLToPath(new URL('../../tracks/music-video/engine/', import.meta.url));

// JS mirror of the GLSL crWeights() (Keys cubic, B = 0, C = 0.5).
const crW = (t) => { const t2 = t * t, t3 = t2 * t; return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2]; };
const sample1D = (row, x, kind) => {           // x in texel space, texel centres at integers
  const i = Math.floor(x), f = x - i, at = (k) => row[Math.max(0, Math.min(row.length - 1, k))];
  if (kind === 'bilinear') return at(i) * (1 - f) + at(i + 1) * f;
  const w = crW(f); return w[0] * at(i - 1) + w[1] * at(i) + w[2] * at(i + 1) + w[3] * at(i + 2);
};

test('lens.resample defaults to bilinear and only accepts bilinear | catrom', () => {
  assert.equal(DEFAULT_POST.lens.resample, 'bilinear');
  assert.equal(mergePost({}).lens.resample, 'bilinear');
  assert.equal(mergePost({lens: {resample: 'catrom'}}).lens.resample, 'catrom');
  assert.equal(resampleMode(undefined), 0);
  assert.equal(resampleMode('bilinear'), 0);
  assert.equal(resampleMode('catrom'), 1);
  assert.throws(() => resampleMode('lanczos'), /bilinear' or 'catrom/);
});

test('develop shader keeps the bilinear fetch as the default branch and the uniform starts at 0', async () => {
  const src = await readFile(path.join(engineDir, 'post.js'), 'utf8');
  assert.match(src, /if \(uResample == 0\) return textureLod\(tSharp, uv, 0\.0\)\.rgb;/);
  assert.match(src, /uResample: U\(0\)/);
  assert.match(src, /col = vec3\(sampleSharp\(uvR\)\.r, sampleSharp\(uvG\)\.g, sampleSharp\(uvB\)\.b\);/);
  assert.equal((src.match(/textureLod\(tSharp, uv[RGB]/g) || []).length, 0, 'every geometric tSharp fetch goes through sampleSharp');
});

test('Catmull-Rom weights interpolate, reproduce ramps and keep more 1-px contrast than bilinear', () => {
  for (const t of [0, 0.1, 0.25, 0.5, 0.8, 0.999]) {
    const w = crW(t);
    assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-12, 'partition of unity');
    assert.ok(Math.abs(w[0] * -1 + w[2] * 1 + w[3] * 2 - t) < 1e-12, 'reproduces a linear ramp');
  }
  assert.deepEqual(crW(0).map((v) => Math.abs(v)), [0, 1, 0, 0], 'interpolating at texel centres');
  const row = Array.from({length: 64}, (_, i) => i % 2);          // 1-px stripes
  const contrast = (kind, off) => { const v = []; for (let x = 8; x < 56; x++) v.push(sample1D(row, x + off, kind)); let s = 0; for (let k = 1; k < v.length; k++) s += Math.abs(v[k] - v[k - 1]); return s / (v.length - 1); };
  for (const off of [0.15, 0.25, 0.35]) assert.ok(contrast('catrom', off) > contrast('bilinear', off) * 1.25, `offset ${off}: catrom ${contrast('catrom', off)} vs bilinear ${contrast('bilinear', off)}`);
});

const FIXTURE = `<!doctype html><meta charset="utf-8"><canvas id="c" width="480" height="200"></canvas>
<script type="module">
const q = new URLSearchParams(location.search);
const THREE = await import('./engine/vendor/three.module.js');
const {createPost, mergePost} = await import('./' + q.get('engine') + '/post.js');
const W = 480, H = 200, canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({canvas, antialias: false, preserveDrawingBuffer: true});
renderer.setPixelRatio(1); renderer.setSize(W, H, false);
const post = createPost(renderer, {width: W, height: H, canvasWidth: W, canvasHeight: H, quality: 'final', msaa: 0, renderScale: 1});
const data = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, v = x < W / 2 ? (x % 2) * 200 + 20 : ((x + y) % 2) * 170 + 30; data[i] = v; data[i + 1] = v; data[i + 2] = Math.min(255, v + 15); data[i + 3] = 255; }
const tex = new THREE.DataTexture(data, W, H); tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({map: tex})));
window.renderWith = (resample) => {
  const over = {grain: {amount: 0}, dither: 0, weave: 6, dof: {enabled: false}};
  if (resample !== null) over.lens = {resample};
  const P = mergePost(over), weave = [0.61, -0.37];
  renderer.setRenderTarget(post.sceneTarget); renderer.setClearColor(0x000000, 1); renderer.autoClear = true; renderer.render(scene, cam);
  post.begin();
  post.layer({lens: null, weight: 1, gain: 1, params: P, frame: 3, multi: false, fovY: 30, weave});
  post.finish({params: P, frame: 3, multi: false, gain: 1, fovY: 30, weave});
  const gl = renderer.getContext(), px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let h = 2166136261 >>> 0; for (let i = 0; i < px.length; i++) h = Math.imul(h ^ px[i], 16777619) >>> 0;
  let s = 0, n = 0; for (let y = 60; y < 140; y++) for (let x = 40; x < 200; x++) { const i = (y * W + x) * 4; s += Math.abs(px[i + 1] - px[i + 5]); n++; }
  return {hash: h.toString(16), hf: s / n};
};
window.ready = true;
</script>`;

test('WebGL2: default develop output is byte-identical to the pre-option sampling; catrom keeps more 1-px contrast', {timeout: 300000, skip: !process.env.SCENE_PICTURE_BROWSER && 'set SCENE_PICTURE_BROWSER=1 (needs Playwright Chromium; ports 39920-39929)'}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'post-resample-'));
  const {chromium} = await import('playwright');
  let server = null, browser = null;
  try {
    await cp(engineDir, path.join(dir, 'engine'), {recursive: true});
    // Legacy: the develop pass exactly as it sampled before the option existed (direct bilinear textureLod fetches).
    await cp(engineDir, path.join(dir, 'legacy'), {recursive: true});
    const cur = await readFile(path.join(engineDir, 'post.js'), 'utf8');
    const legacy = cur
      .replace('col = vec3(sampleSharp(uvR).r, sampleSharp(uvG).g, sampleSharp(uvB).b);', 'col = vec3(textureLod(tSharp, uvR, 0.0).r, textureLod(tSharp, uvG, 0.0).g, textureLod(tSharp, uvB, 0.0).b);')
      .replace('else col = sampleSharp(uvG);', 'else col = textureLod(tSharp, uvG, 0.0).rgb;');
    assert.notEqual(legacy, cur);
    await writeFile(path.join(dir, 'legacy', 'post.js'), legacy);
    await writeFile(path.join(dir, 'index.html'), FIXTURE);
    server = await localServer(dir, {min: 39920, max: 39929});
    browser = await chromium.launch({headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], ...(process.env.SCENE_CHROMIUM ? {executablePath: process.env.SCENE_CHROMIUM} : {})});
    const run = async (engine, modes) => {
      const page = await browser.newPage({viewport: {width: 480, height: 200}});
      const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(`${server.url}/index.html?engine=${engine}`);
      await page.waitForFunction(() => window.ready === true, null, {timeout: 120000});
      const out = {}; for (const m of modes) out[m ?? 'default'] = await page.evaluate((mm) => window.renderWith(mm), m);
      await page.close();
      assert.deepEqual(errors, []);
      return out;
    };
    const L = await run('legacy', [null]);
    const C = await run('engine', [null, 'bilinear', 'catrom']);
    assert.equal(C.default.hash, L.default.hash, 'default output unchanged vs the pre-option develop pass');
    assert.equal(C.bilinear.hash, C.default.hash, "explicit 'bilinear' == default");
    assert.notEqual(C.catrom.hash, C.default.hash, 'catrom changes the picture');
    assert.ok(C.catrom.hf > C.default.hf * 1.05, `catrom 1-px contrast ${C.catrom.hf} vs bilinear ${C.default.hf}`);
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    await rm(dir, {recursive: true, force: true});
  }
});
