import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp, mkdir, readFile} from 'node:fs/promises';
import * as THREE from '../../tracks/music-video/engine/vendor/three.module.js';
import * as F from '../../tracks/music-video/kits/far/index.js';
import {validateFar, FAR_CONFIG} from './far-browser.mjs';
import {validateConfig, configRelaxations} from '../picture-qa/picture-qa.mjs';

const near = F.FAR_PRESETS.layeredArc.layers[0];

test('far layer parameters: presets are legal, out-of-range values throw with the reason', () => {
  for (const p of Object.values(F.FAR_PRESETS)) { const o = F.farOptions(p); assert.ok(o.layers.length >= 1); }
  assert.throws(() => F.layerParams({...near, sharp: 2.8}), /sharp.*legal range/);
  assert.throws(() => F.layerParams({...near, W: near.R * 0.5}), /W=.*x R/);
  assert.throws(() => F.layerParams({...near, H1: 400}), /crest elevation .* > 5 deg/);
  assert.throws(() => F.layerParams({...near, step: 20}), /silhouette folds/);
  assert.throws(() => F.layerParams({...near, H0: 200, H1: 150}), /H0 must be below H1/);
  assert.throws(() => F.layerParams({...near, gaps: [{az: 10, w: 0, depth: 0.5}]}), /gaps\[0\]/);
  assert.throws(() => F.layerParams({...near, heigth: 3}), /unknown far layer parameter/);
  assert.throws(() => F.farOptions({layers: [near], slots: [{kind: 'castle', az: 3}]}), /kind must be/);
  assert.throws(() => F.farOptions({layers: []}), /need layers/);
  assert.throws(() => F.airParams({vis: 100}), /air.vis/);
});

test('ridge layer geometry: deterministic, finite, upward non-zero normals, slopes limited, edges buried in the plain', () => {
  const L = {...near, az0: 240, az1: 300, rows: 40};
  const a = F.buildLayerArrays(L, [10, -20], () => 2), b = F.buildLayerArrays(L, [10, -20], () => 2);
  assert.deepEqual(a.pos, b.pos); assert.deepEqual(a.idx, b.idx);
  for (const v of a.pos) assert.ok(Number.isFinite(v));
  for (let k = 0; k < a.nor.length; k += 3) { assert.ok(Math.abs(Math.hypot(a.nor[k], a.nor[k + 1], a.nor[k + 2]) - 1) < 1e-4); assert.ok(a.nor[k + 1] > 0); }
  assert.ok(a.maxSlopeDeg <= 60, `max slope ${a.maxSlopeDeg}`);
  // azimuthal arc step honours `step` (silhouette resolution) and every band edge row sits below the plain (no paper edge)
  assert.ok(a.nA >= Math.ceil(60 * Math.PI / 180 * L.R / L.step));
  let edgeMax = -Infinity;
  for (let i = 0; i < a.nA; i++) for (const j of [0, a.nR - 1]) edgeMax = Math.max(edgeMax, a.pos[(i * a.nR + j) * 3 + 1] - 2);
  for (let j = 0; j < a.nR; j++) for (const i of [0, a.nA - 1]) edgeMax = Math.max(edgeMax, a.pos[(i * a.nR + j) * 3 + 1] - 2);
  assert.ok(edgeMax <= 0.01, `band edges must sink into the plain (max ${edgeMax.toFixed(2)} m above)`);
  // crest elevation stays under 5 degrees from the centre
  let maxEl = 0;
  for (let q = 0; q < a.verts; q++) { const dx = a.pos[q * 3] - 10, dz = a.pos[q * 3 + 2] + 20; maxEl = Math.max(maxEl, Math.atan2(a.pos[q * 3 + 1] - 2, Math.hypot(dx, dz)) * 180 / Math.PI); }
  assert.ok(maxEl <= F.MAX_ELEVATION_DEG, `elevation ${maxEl}`);
});

test('slots: a beacon sits on the crest of its layer, a village on the plain in front; heightAt matches the layers', () => {
  const o = F.farOptions({layers: [{...near, az0: 230, az1: 290}], slots: [{kind: 'beacon', layer: 0, az: 260, h: 10}, {kind: 'village', layer: 0, az: 265}], baseY: 0});
  const crest = F.crestAt(o, 0, 260);
  for (const dr of [-60, 60]) {
    const r = Math.hypot(crest[0], crest[2]) + dr, x = Math.sin(260 * Math.PI / 180) * r, z = -Math.cos(260 * Math.PI / 180) * r;
    assert.ok(F.layerRelHeight(o.layers[0], 0, 0, x, z) <= crest[1] + 1e-6, 'crest is the highest point along the azimuth');
  }
  const village = F.slotPosition(o, o.slots[1]);
  assert.ok(Math.hypot(village[0], village[2]) < o.layers[0].R - o.layers[0].W, 'village stands in front of the range');
  const s = F.slotArrays(o.slots[0], crest);
  assert.ok(s.idx.length >= 60 && s.far.length / 4 === s.pos.length / 3);
});

test('far material: world-space, footprint-windowed, no time/random, mean-sky haze target; engine symbols exist in the engine', async () => {
  const body = F.FAR_FS_BODY.replace(/\/\/.*$/gm, '');
  for (const banned of [/\bvUv\b/, /gl_FragCoord/, /\buTime\b|\bvTime\b/, /random/i, /vHazeColor/]) assert.doesNotMatch(body, banned);
  assert.match(body, /farWin\(90\.0, fp\)/); assert.match(body, /160\.0 \/ fp/); assert.match(body, /220\.0 \/ fp/);
  assert.match(body, /vec2\(90\.0, 200\.0\)/);   // gully streaks 90 x 200 m: anisotropy <= 3:1 (2.2)
  const engineSrc = (await readFile(new URL('../../tracks/music-video/engine/terrain.js', import.meta.url), 'utf8')) + (await readFile(new URL('../../tracks/music-video/engine/sky.js', import.meta.url), 'utf8'));
  for (const sym of F.FAR_ENGINE_SYMBOLS) assert.match(engineSrc, new RegExp(`\\b${sym}\\b`), `engine provides ${sym}`);
  const standalone = F.makeFarMaterial(THREE, {}), engine = F.makeFarMaterial(THREE, {atmos: {glsl: '/*engine*/', uniforms: {vCam: {value: null}}}});
  try {
    assert.equal(standalone.customProgramCacheKey(), 'kits.far.v1.standalone'); assert.equal(engine.customProgramCacheKey(), 'kits.far.v1.engine');
    assert.match(standalone.fragmentShader, /uFarSkyUp/); assert.doesNotMatch(standalone.fragmentShader, /vApplyAtmos/);
    assert.match(engine.fragmentShader, /^\/\*engine\*\//); assert.match(engine.fragmentShader, /vApplyAtmos\(col, W\)/); assert.ok('vCam' in engine.uniforms);
    standalone.userData.farUpdate({gain: 0.8, air: {vis: 6000}});
    assert.equal(standalone.uniforms.uFarGain.value, 0.8); assert.ok(Math.abs(standalone.uniforms.uFarAir.value.x - 1 / 6000) < 1e-12);
    assert.throws(() => standalone.userData.farUpdate({gain: 9}), /legal range/);
    assert.throws(() => F.makeFarMaterial(THREE, {atmos: {}}), /engine atmosphere/);
  } finally { standalone.dispose(); engine.dispose(); }
  const far = F.createFarRanges(THREE, {...F.FAR_PRESETS.distantRing});
  try { assert.equal(far.meshes.length, 2); assert.ok(far.stats.verts > 10000); assert.ok(Number.isFinite(far.heightAt(0, -6200))); } finally { far.dispose(); }
});

test('block structure: real openings, heightfield snow caps with cornice, consistent winding, no NaN or zero normals', () => {
  const b = F.blockBatches();
  F.flatRoofHouse(b, {pos: [0, 0, 0], w: 7, d: 5, h: 3.2, wind: 1, seed: 2, doors: [{face: '+c', u: 2.2, w: 1.1, h: 2}], windows: [{face: '+c', u: 5, y: 1.1, w: 0.9, h: 0.9, lit: true}], chimney: {a: 2, c: 0.5, h: 0.9}, yard: {len: 4}});
  F.fortWall(b, {pos: [40, 0, 0], len: 40, h: 8, gY: () => 0, seed: 3});
  F.plankHull(b, {pos: [0, 0, 30], len: 6, beam: 2, depth: 0.6, snow: 0.2});
  for (const [k, batch] of Object.entries(b)) {
    F.finishBatch(batch);
    const r = F.inspectBatch(batch);
    assert.deepEqual([r.nan, r.zeroNormals, r.against], [0, 0, 0], `${k}: ${JSON.stringify(r)}`);
  }
  // the window is a hole: no wall triangle covers the opening centre on the +c face (z = 2.5), and the lit back exists
  const P = b.wall.p, I = b.wall.i, cx = 3.5 - 5, cy = 1.55;          // +c face runs from a1 towards a0: u = 5 -> x = -1.5
  const inside = (ax, ay, bx, by, qx, qy, rx, ry) => { const d = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3); const d1 = d(cx, cy, ax, ay, bx, by), d2 = d(cx, cy, bx, by, qx, qy), d3 = d(cx, cy, qx, qy, ax, ay); return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)); };
  const covers = (y) => { let n = 0; for (let t = 0; t < I.length; t += 3) { const v = [I[t], I[t + 1], I[t + 2]].map((i) => [P[i * 3], P[i * 3 + 1] - (y - cy), P[i * 3 + 2]]); if (v.every((p) => Math.abs(p[2] - 2.5) < 1e-6) && inside(v[0][0], v[0][1], v[1][0], v[1][1], v[2][0], v[2][1])) n++; } return n; };
  assert.equal(covers(cy), 0, 'wall face must not cover the window');
  assert.ok(covers(2.7) > 0, 'solid wall above the window is covered (the test sees the face)');
  assert.ok(b.hole.c.some((c, i) => i % 3 === 0 && c > 1), 'lit window back is emissive warm');
  assert.ok(b.wood.count > 1000, 'door boards, mullions, rafters and planks');
  // snow cap: thick in the middle, cornice overhangs the downwind (+a) edge of the roof slab (eave 0.35 -> a = 3.85)
  const ys = [], xs = [];
  for (let i = 0; i < b.snow.count; i++) if (Math.abs(b.snow.p[i * 3 + 2]) < 3 && b.snow.p[i * 3 + 1] > 3.3 && b.snow.p[i * 3 + 1] < 4) { xs.push(b.snow.p[i * 3]); ys.push(b.snow.p[i * 3 + 1]); }
  assert.ok(Math.max(...xs) > 3.85 + 0.3, 'leeward cornice beyond the roof edge');
  assert.ok(Math.max(...ys) - (3.2 + 0.22) > 0.2, 'snow cap has thickness');
  assert.throws(() => F.flatRoofHouse(F.blockBatches(), {pos: [0, 0, 0], w: 3, d: 3, h: 3, windows: [{face: '+c', u: 2.9, y: 1, w: 1, h: 1}]}), /does not fit/);
  assert.throws(() => F.plankHull(F.blockBatches(), {pos: [0, 0, 0], strakes: 1}), /strakes/);
  assert.throws(() => F.snowCap(new F.GeoBatch(), F.frame([0, 0, 0]), 0, 1, 0, 1, 0, {thick: 3}), /thick/);
});

test('ruined tower: one continuous surface, no degenerate fan, deterministic, outward normals', () => {
  const o = {center: [5, -3], base: 6, top: 4, h: 7, seed: 4, collapses: [{az: 30, w: 2, depth: 1.5}], rubble: [{az: 30}]};
  const a = F.rammedTowerGeometry(o), b = F.rammedTowerGeometry(o);
  assert.deepEqual(a.pos, b.pos);
  let minArea = Infinity;
  for (let t = 0; t < a.idx.length; t += 3) {
    const [p, q, r] = [a.idx[t], a.idx[t + 1], a.idx[t + 2]].map((i) => a.pos.slice(i * 3, i * 3 + 3));
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    minArea = Math.min(minArea, Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2);
  }
  assert.ok(minArea > 1e-7, `no degenerate triangle (${minArea})`);
  for (let k = 0; k < a.nrm.length; k += 3) assert.ok(Math.abs(Math.hypot(a.nrm[k], a.nrm[k + 1], a.nrm[k + 2]) - 1) < 1e-3);
  assert.ok(a.ao.every((v) => v >= 0.32 && v <= 1));
  assert.throws(() => F.rammedTowerGeometry({center: [0, 0], top: 9, base: 6}), /top <= base/);
});

test('far bench config uses only legal exemptions (designed texture), each with exempt + _why', () => {
  validateConfig(FAR_CONFIG);
  const rel = configRelaxations(FAR_CONFIG);
  assert.ok(rel.length > 0 && rel.every((r) => r.field === 'allowStripes' && r.exempt.includes('designed-texture')));
});

test('far bench compiles in WebGL2, seeks deterministically and passes picture-qa', {timeout: 900000, skip: !process.env.SCENE_PICTURE_BROWSER && 'set SCENE_PICTURE_BROWSER=1 (needs Playwright Chromium; ports 39920-39929)'}, async () => {
  const base = process.env.SCENE_EVIDENCE_DIR || os.tmpdir(); await mkdir(base, {recursive: true});
  const out = await mkdtemp(path.join(base, 'scene-far-')); console.log(`far evidence retained: ${out}`);
  const r = await validateFar(out);
  assert.deepEqual(r.errors, []);
  assert.equal(r.deterministic, true);
  for (const q of r.qa) { assert.ok(q.pass, `${q.file}: ${q.failed.join(',')}`); assert.deepEqual(q.warnings, [], `${q.file}: config warnings`); }
});
