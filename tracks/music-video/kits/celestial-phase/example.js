import * as THREE from '../../engine/vendor/three.module.js';
import {createCelestialPhase} from './index.js';
const canvas = document.querySelector('canvas');
const renderer = new THREE.WebGLRenderer({canvas, antialias: false, preserveDrawingBuffer: true});
const body = createCelestialPhase(THREE);
const params = new URLSearchParams(location.search);
function seek(t) {
  body.update(t, {phase: t / 12, cloud: .1});
  renderer.render(body.scene, body.camera); renderer.getContext().finish();
}
function resize(w, h) { renderer.setSize(w, h, false); body.resize(w, h); }
resize(960, 540); seek(Number(params.get('t')) || 0);
window.__scene = {ready: Promise.resolve(), canvas, seek, resize, duration: 12, fps: 24,
  capture: () => canvas.toDataURL('image/png'), inspect: () => ({calls: renderer.info.render.calls, triangles: renderer.info.render.triangles})};
window.addEventListener('pagehide', () => { body.dispose(); renderer.dispose(); }, {once: true});
