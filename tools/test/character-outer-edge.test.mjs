import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../tracks/music-video/engine/vendor/three.module.js';
import {createOuterEdgeMaskPass, attachOuterEdgePass, OUTER_EDGE_LAYER, OUTER_EDGE_PROGRAM} from '../../tracks/music-video/character/real/rim.js';

// Minimal stand-in for WebGLRenderer: records what the mask pass would draw (camera, layers, target, size) without a GPU.
function mockRenderer({width = 1920, height = 804} = {}) {
  let rt = null, clearAlpha = 0.25;
  const clearColor = new THREE.Color(0.1, 0.2, 0.3), log = [];
  return {log, shadowMap: {autoUpdate: true}, autoClear: false,
    getDrawingBufferSize(v) { return v.set(width, height); },
    getRenderTarget: () => rt, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
    setRenderTarget(t) { rt = t; },
    getClearColor(c) { return c.copy(clearColor); }, getClearAlpha: () => clearAlpha, setClearColor(c, a) { clearColor.set(c); clearAlpha = a; },
    clear() { log.push({op: 'clear', target: rt}); },
    render(scene, camera) {
      const drawn = [];
      scene.traverseVisible(o => { if (o.isMesh && o.layers.test(camera.layers)) drawn.push(o.name); });
      log.push({op: 'render', target: rt, size: rt ? [rt.width, rt.height] : null, cameraX: camera.matrixWorld.elements[12], layers: camera.layers.mask, override: scene.overrideMaterial?.name, background: scene.background, fog: scene.fog, shadowAuto: this.shadowMap.autoUpdate, drawn});
    },
  };
}
// Three calls scene.onBeforeRender(renderer, scene, camera, currentRenderTarget) at the start of every render().
function mainPass(renderer, scene, camera, target = null) { scene.onBeforeRender(renderer, scene, camera, target); }

function fixture() {
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0, 0, 0.1); scene.fog = new THREE.Fog(0, 1, 2);
  const holder = new THREE.Group(); holder.name = 'set-root'; scene.add(holder);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(.25, 1.2, 4, 8), new THREE.MeshPhysicalMaterial({roughness: 1, specularIntensity: 0})); body.name = 'body';
  const object = new THREE.Group(); object.add(body); holder.add(object);                 // actor nested below the scene root
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()); wall.name = 'wall'; scene.add(wall);
  const camera = new THREE.PerspectiveCamera(30, 2.39, .1, 100); camera.position.set(0, 1.4, 6); camera.updateMatrixWorld();
  return {scene, actor: {object}, camera, body, wall};
}

test('outer-edge mask is drawn in the main pass with the FINAL camera, at the main target size, and fully cleared', () => {
  const {scene, actor, camera} = fixture(), renderer = mockRenderer();
  const pass = attachOuterEdgePass(actor);
  assert.equal(pass.programKey, OUTER_EDGE_PROGRAM);
  actor.beforeRender(renderer, scene, camera);                       // legacy call from set.update(): installs only, draws nothing
  assert.equal(renderer.log.length, 0, 'beforeRender must not draw the mask (camera is not final yet)');
  camera.position.x += 0.137; camera.updateMatrixWorld();             // engine applies handheld/focus breathing after set.update()
  const main = new THREE.WebGLRenderTarget(1920, 804);
  mainPass(renderer, scene, camera, main);
  const draws = renderer.log.filter(e => e.op === 'render');
  assert.equal(draws.length, 1);
  assert.equal(draws[0].cameraX, camera.matrixWorld.elements[12], 'mask uses the camera of the main pass');
  assert.deepEqual(draws[0].size, [1920, 804], 'mask target follows the main pass size (no fixed square)');
  assert.deepEqual(pass.uniforms.uOTexel.value.toArray(), [1 / 1920, 1 / 804]);
  assert.equal(renderer.log[0].op, 'clear', 'every mask render starts from a cleared target');
  assert.equal(draws[0].layers, 1 << OUTER_EDGE_LAYER);
  assert.deepEqual(draws[0].drawn, ['body'], 'only the actor (even when nested) is in the mask');
  assert.equal(draws[0].override, 'character-outer-edge-mask');
  assert.equal(draws[0].background, null); assert.equal(draws[0].fog, null); assert.equal(draws[0].shadowAuto, false);
  // state restored for the main pass
  assert.equal(camera.layers.mask, 1); assert.ok(scene.background.isColor); assert.ok(scene.fog); assert.equal(scene.overrideMaterial, null);
  assert.equal(renderer.getRenderTarget(), null); assert.equal(renderer.shadowMap.autoUpdate, true); assert.equal(renderer.getClearAlpha(), .25);
  assert.equal(pass.uniforms.uOOn.value, 1);
  pass.dispose(); main.dispose();
});

test('outer-edge pass is order independent, keeps previous scene hooks and skips FX-only or hidden passes', () => {
  const {scene, actor, camera} = fixture(), renderer = mockRenderer({width: 1280, height: 536});
  let previousCalls = 0; scene.onBeforeRender = () => { previousCalls++; };
  const pass = attachOuterEdgePass(actor); pass.install(scene); pass.install(scene);
  const fx = camera.clone(); fx.layers.set(7);
  mainPass(renderer, scene, fx);
  assert.equal(renderer.log.length, 0, 'FX-only camera never redraws the mask');
  mainPass(renderer, scene, camera); mainPass(renderer, scene, camera);
  const draws = renderer.log.filter(e => e.op === 'render');
  assert.equal(draws.length, 2, 'installed once even when install() is repeated');
  assert.deepEqual(draws[0], draws[1], 'same inputs -> same mask draw, no carried state');
  assert.deepEqual(draws[0].size, [1280, 536], 'canvas size used when the main pass renders to screen');
  assert.equal(previousCalls, 3, 'a previous scene.onBeforeRender keeps running');
  actor.object.parent.visible = false; mainPass(renderer, scene, camera);
  assert.equal(pass.uniforms.uOOn.value, 0, 'hidden actor turns the rim off instead of using a stale mask');
  pass.dispose(); mainPass(renderer, scene, camera);
  assert.equal(renderer.log.filter(e => e.op === 'render').length, 2, 'disposed pass is uninstalled');
});

test('rim shader: light-driven 1-2 px outer band with multi-radius taps and a fixed program key', () => {
  const {actor, body} = fixture();
  const pass = attachOuterEdgePass(actor);
  const shader = {uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader};
  body.material.onBeforeCompile(shader);
  assert.match(shader.vertexShader, /vOClip = gl_Position;/);
  assert.match(shader.fragmentShader, /d \* 1\.5\).*d \* 2\.6\).*d \* 4\.2\)/s, 'narrow gaps (< ~4 px) are not outer edge');
  assert.match(shader.fragmentShader, /directionalLights\[i\]\.direction/, 'strength follows the scene directional lights');
  assert.match(shader.fragmentShader, /mix\(0\.08, 1\.0, back\)/, 'front light gives ~0, back light a thin line');
  assert.ok(shader.fragmentShader.indexOf('characterOuterEdge();') < shader.fragmentShader.indexOf('#include <opaque_fragment>'));
  assert.equal(shader.uniforms.uRimGain.value, .06);
  assert.match(body.material.customProgramCacheKey(), new RegExp(`\\|${OUTER_EDGE_PROGRAM}$`));
  attachOuterEdgePass(actor); assert.equal(actor.outerEdgePass, pass, 'idempotent');
  assert.throws(() => createOuterEdgeMaskPass({width: 0}), /positive/);
  pass.dispose();
});

test('rim lab in WebGL2: final rim passes picture-qa halo backlit and front-lit; the legacy pre-shake 512² mask is caught', {timeout: 600000, skip: !process.env.SCENE_PICTURE_BROWSER && 'set SCENE_PICTURE_BROWSER=1 (needs Playwright Chromium; ports 39920-39929)'}, async () => {
  const os = await import('node:os'), path = await import('node:path'), fs = await import('node:fs/promises');
  const {validateOuterEdge} = await import('./outer-edge-browser.mjs');
  const base = process.env.SCENE_EVIDENCE_DIR || os.tmpdir(); await fs.mkdir(base, {recursive: true});
  const out = await fs.mkdtemp(path.join(base, 'scene-outer-edge-')); console.log(`outer-edge evidence retained: ${out}`);
  const r = await validateOuterEdge(out);
  assert.deepEqual(r.errors, []);
  for (const row of r.rows.filter(x => x.mode === 'final')) assert.ok(row.halo, `final ${row.light} t=${row.t}: ${JSON.stringify(row.worst)}`);
  assert.ok(r.rows.filter(x => x.mode === 'legacy').every(x => !x.halo), 'legacy behaviour must be caught by ②');
  assert.ok(r.rows.filter(x => x.mode === 'final').every(x => x.inspect.mask[0] === 960 && x.inspect.mask[1] === 402));
});
