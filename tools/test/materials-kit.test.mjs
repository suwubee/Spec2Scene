import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp, mkdir} from 'node:fs/promises';
import * as THREE from '../../tracks/music-video/engine/vendor/three.module.js';
import * as M from '../../tracks/music-video/kits/materials/index.js';
import {validateMaterials} from './materials-browser.mjs';

test('material noise bake is deterministic, tileable and uses the full range', () => {
  const a = M.bakeMaterialNoise(), b = M.bakeMaterialNoise(), N = M.MATERIAL_NOISE_SIZE;
  assert.deepEqual(a, b);
  for (const c of [0, 1, 3]) {
    let seam = 0, inner = 0, lo = 255, hi = 0;
    for (let j = 0; j < N; j++) {
      seam += Math.abs(a[(j * N + N - 1) * 4 + c] - a[(j * N) * 4 + c]);
      inner += Math.abs(a[(j * N + 100) * 4 + c] - a[(j * N + 101) * 4 + c]);
    }
    for (let k = 0; k < N * N; k++) { lo = Math.min(lo, a[k * 4 + c]); hi = Math.max(hi, a[k * 4 + c]); }
    assert.ok(seam < inner * 2.5 + N, `channel ${c} must wrap without a seam (${seam} vs ${inner})`);
    assert.ok(hi - lo > 200, `channel ${c} uses the range`);
  }
  assert.throws(() => M.bakeMaterialNoise(100), /power of two/);
  assert.equal(M.getMaterialNoise(THREE), M.getMaterialNoise(THREE), 'one shared texture per THREE instance');
});

test('GLSL follows the world-space rules: no mesh UV, screen space, time or randomness; wind aspect <= 3', () => {
  const src = M.MAT_GLSL;
  for (const banned of [/\bvUv\b/, /\bv\w*MapUv\b/, /gl_FragCoord/, /\buTime\b|\btime\b/i, /random/i]) assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), banned);
  assert.match(src, /texelFetch\(uMatNoise/);
  assert.match(src, /float grazK/);
  assert.ok(M.WIND_ASPECT <= 3);
  assert.match(src, new RegExp(`\\(${M.WIND_ASPECT} \\* W\\)`));
  for (const m of src.matchAll(/vec2\(a \/ ([\d.]+), c \/ ([\d.]+)\)/g)) assert.ok(+m[1] / +m[2] <= 3, `snow-on-ice pattern ${m[0]} must stay <= 3:1`);
});

test('parameters are validated against their legal ranges; presets are legal', () => {
  for (const name of Object.keys(M.SNOW_PRESETS)) M.snowParams(name);
  for (const name of Object.keys(M.ICE_PRESETS)) M.iceParams(name);
  assert.throws(() => M.snowParams({ridge: 2}), /legal range/);
  assert.throws(() => M.snowParams({W: 0.1}), /legal range/);
  assert.throws(() => M.snowParams('street-of-somewhere'), /unknown snow preset/);
  assert.throws(() => M.iceParams({cell: 20}), /legal range/);
  assert.throws(() => M.snowParams({ridgee: 1}), /unknown snow parameter/);
  assert.throws(() => M.rammedEarthMaterial(THREE, {layer: 0.3}), /legal range/);
});

test('built-in material adapters inject into three r186 chunks with fixed program keys', () => {
  const host = lib => ({uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader});
  const mats = [M.snowMaterial(THREE), M.snowMaterial(THREE, {preset: 'compacted'}), M.iceMaterial(THREE, {preset: 'black', cover: .3}), M.iceMaterial(THREE, {coverAttribute: 'snowCover'}), M.rammedEarthMaterial(THREE)];
  try {
    const keys = mats.map(m => m.customProgramCacheKey());
    assert.deepEqual(keys, ['kits.materials.snow.v1', 'kits.materials.snow.v1', 'kits.materials.ice.v1', 'kits.materials.ice.v1.attr', 'kits.materials.rammed.v1']);
    for (const m of mats) {
      assert.ok(m.isMeshStandardMaterial);
      const sh = host(THREE.ShaderLib.standard), before = sh.fragmentShader;
      m.onBeforeCompile(sh);
      assert.notEqual(sh.fragmentShader, before);
      assert.match(sh.fragmentShader, /uniform sampler2D uMatNoise/);
      assert.ok(sh.uniforms.uMatNoise.value.isDataTexture);
      const kind = m.userData.materialKind;
      if (kind !== 'rammed') { assert.match(sh.fragmentShader, /matFootprint\(matP\)/); assert.match(sh.vertexShader, /vMatW = \(modelMatrix \* matWp\)\.xyz/); assert.match(sh.fragmentShader, /totalEmissiveRadiance \+= uMatGlintColor/); }
      else { assert.match(sh.fragmentShader, /ramUV/); assert.match(sh.vertexShader, /vRamW/); }
    }
    M.setMaterialLight(mats[0], [0, 1, 0], [1, 1, 1]);
    assert.deepEqual(mats[0].userData.materialLibrary.uMatLightDir.value.toArray(), [0, 1, 0]);
    assert.throws(() => M.snowMaterial(THREE, {wind: [0, 0]}), /wind/);
    assert.throws(() => M.iceMaterial(THREE, {coverAttribute: 'bad name;'}), /identifier/);
  } finally { for (const m of mats) m.dispose(); }
});

test('rammed earth bake is deterministic with readable, non-alternating courses', () => {
  const a = M.bakeRammedEarth({seed: 'wall-a'}), b = M.bakeRammedEarth({seed: 'wall-a'}), c = M.bakeRammedEarth({seed: 'wall-b'});
  assert.deepEqual(a.albedo, b.albedo); assert.notDeepEqual(a.albedo, c.albedo);
  const rowMean = y => { let s = 0; for (let x = 0; x < a.width; x++) s += a.albedo[(y * a.width + x) * 4 + 1]; return s / a.width; };
  const perCourse = Math.round(a.height * 0.12 / 6), means = [];
  for (let k = 2; k < 30; k++) means.push(rowMean(k * perCourse + (perCourse >> 1)));
  const spread = (Math.max(...means) - Math.min(...means)) / (means.reduce((s, v) => s + v, 0) / means.length);
  assert.ok(spread >= 0.15, `course contrast ${spread.toFixed(3)} must be readable (>= 0.15)`);
  let alternations = 0; for (let k = 2; k < means.length; k++) if (Math.sign(means[k] - means[k - 1]) !== Math.sign(means[k - 1] - means[k - 2])) alternations++;
  assert.ok(alternations < means.length - 3, 'course colours must not strictly alternate');
});

test('snow drift is a heightfield: no face steeper than 60 degrees, deterministic per seed', () => {
  for (const opts of [{}, {r: 1, h: 0.6, seed: 2}, {r: 6, h: 2.5, windDir: [0, 1], seed: 9}]) {
    const g = M.snowDriftGeometry(THREE, opts);
    try { assert.ok(M.maxSlopeDegrees(g) <= 60, `slope ${M.maxSlopeDegrees(g)}`); assert.ok(g.index.count > 300); } finally { g.dispose(); }
  }
  const f = M.driftHeightField({seed: 4}), g = M.driftHeightField({seed: 4});
  assert.equal(f.heightAt(0.3, -0.2), g.heightAt(0.3, -0.2));
  assert.ok(f.heightAt(0, 0) > 0.5);
  assert.throws(() => M.driftHeightField({r: 1, h: 2}), /h <= r/);
});

test('material bench compiles in WebGL2, seeks deterministically and passes picture-qa', {timeout: 600000, skip: !process.env.SCENE_PICTURE_BROWSER && 'set SCENE_PICTURE_BROWSER=1 (needs Playwright Chromium; ports 39920-39929)'}, async () => {
  const base = process.env.SCENE_EVIDENCE_DIR || os.tmpdir(); await mkdir(base, {recursive: true});
  const out = await mkdtemp(path.join(base, 'scene-materials-')); console.log(`materials evidence retained: ${out}`);
  const r = await validateMaterials(out);
  assert.deepEqual(r.errors, []);
  assert.equal(r.deterministic, true);
  for (const q of r.qa) assert.ok(q.pass, `${q.file}: ${q.failed.join(',')}`);
});
