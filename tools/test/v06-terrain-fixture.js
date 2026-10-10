// Test-only geometry; uses the real sky and both versions of the terrain shader.
import * as THREE from './engine/vendor/three.module.js';
import {createSky} from './engine/sky.js';
import {defaultEnvironment} from './engine/world/environment.js';
import * as before from './engine/terrain-baseline.js';
import * as after from './engine/terrain.js';
const canvas = document.querySelector('canvas');
const renderer = new THREE.WebGLRenderer({canvas, preserveDrawingBuffer: true});
renderer.setSize(480, 270, false); renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
const ctx = {THREE, renderer, width: 480, height: 270, quality: 'preview'};
const sky = createSky(ctx, {moonTexSize: 128, budget: 'low'});
const camera = new THREE.PerspectiveCamera(48, 480 / 270, .1, 2000);
const geometry = new THREE.PlaneGeometry(140, 140, 24, 24); geometry.rotateX(-Math.PI / 2);
const count = geometry.attributes.position.count;
geometry.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({length: count}, () => [.3, .24, .17]).flat(), 3));
geometry.setAttribute('aMat', new THREE.Float32BufferAttribute(Array.from({length: count}, () => [.3, .7, .03, .5]).flat(), 4));
const white = new THREE.DataTexture(new Uint8Array([128, 128, 220, 255]), 1, 1); white.needsUpdate = true;
const extraUniforms = {uLeafTex: {value: white}, uGroundAO: {value: white}, uGroundAORect: {value: new THREE.Vector4(-100, -100, 200, 200)}, vFleck: {value: new THREE.Vector4(0, 1000, 1000, 0)}};
const oldAtmos = before.createAtmosphere(ctx, {sky}), newAtmos = after.createAtmosphere(ctx, {sky});
const scene = new THREE.Scene(), mesh = new THREE.Mesh(geometry); mesh.position.set(100, 2, 0); scene.add(mesh);
function render(lib, atmos, kind, t) {
  camera.position.set(110 + t, 24 + t, 46); camera.lookAt(100, 0, 0); camera.updateMatrixWorld();
  const w = defaultEnvironment.at(t); sky.update(t, w, camera); atmos.update(t, w, camera);
  mesh.material = lib.makeValleyMaterial(atmos, kind, {side: THREE.DoubleSide, extraUniforms});
  renderer.render(scene, camera); renderer.getContext().finish();
  const png = canvas.toDataURL(); mesh.material.dispose(); return png;
}
window.__terrain = {
  compare(kind, t) { return {before: render(before, oldAtmos, kind, t), after: render(after, newAtmos, kind, t)}; },
  slope() {
    const atmos = after.createAtmosphere(ctx, {sky, skylineAt: () => -90, waterMist: false, moonColor: [.8, .85, 1]});
    const image = render(after, atmos, 'slope', 4); atmos.dispose(); return image;
  },
};
window.addEventListener('pagehide', () => { geometry.dispose(); white.dispose(); oldAtmos.dispose(); newAtmos.dispose(); sky.dispose(); renderer.dispose(); }, {once: true});
