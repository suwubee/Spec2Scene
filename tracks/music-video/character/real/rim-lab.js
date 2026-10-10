// Outer-edge rim lab: a dark silhouette on snow, moon BEHIND it (the hardest case for white outlines), and an engine-style
// handheld offset applied AFTER the set update. ?mode=final (default) uses attachOuterEdgePass (mask in the main pass with the
// final camera, main-pass size, light-driven 1-2 px rim). ?mode=legacy reproduces the old failure: mask drawn during update
// with the pre-shake camera into a fixed 512² target and a constant-strength rim. ?light=front puts the moon behind the camera.
// window.__scene = {ready, seek(t), capture()}; picture-qa ② halo must PASS in final mode and catches legacy mode.
import * as THREE from '../../engine/vendor/three.module.js';
import {createSilhouetteMaterial} from '../look.js';
import {attachOuterEdgePass} from './rim.js';

const q = new URLSearchParams(location.search), mode = q.get('mode') === 'legacy' ? 'legacy' : 'final', front = q.get('light') === 'front';
const canvas = document.querySelector('canvas');
const renderer = new THREE.WebGLRenderer({canvas, antialias: false, preserveDrawingBuffer: true});
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.setSize(960, 402, false);
const scene = new THREE.Scene(); scene.background = new THREE.Color().setRGB(0.02, 0.03, 0.06);
const camera = new THREE.PerspectiveCamera(30, 960 / 402, 0.1, 500);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 300, 1, 1), new THREE.MeshStandardMaterial({color: new THREE.Color().setRGB(0.5, 0.53, 0.6), roughness: 0.9}));
ground.rotation.x = -Math.PI / 2; scene.add(ground);
const moon = new THREE.DirectionalLight(new THREE.Color().setRGB(0.7, 0.78, 0.92), 1.6);
moon.position.set(front ? 2 : -2, 3, front ? 10 : -10); scene.add(moon, moon.target, new THREE.HemisphereLight(0x1a2438, 0x080808, 0.6));
const dark = createSilhouetteMaterial({}, {color: [0.04, 0.042, 0.048]});
const object = new THREE.Group(); object.name = 'lab-actor';
const cloak = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.38, 1.35, 32, 1), dark); cloak.position.y = 0.68;
const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16), dark.clone()); head.position.y = 1.5;
const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.5, 4, 12), dark.clone()); arm.position.set(0.22, 0.95, 0.12); arm.rotation.z = 0.12;
object.add(cloak, head, arm); scene.add(object);
const actor = {object};
const pass = attachOuterEdgePass(actor);
if (mode === 'final') pass.install(scene);
else { pass.uninstall(); pass.uniforms.uRimGain.value = 1.0; }

function seek(t) {
  // set.update(): base camera from t
  const a = 0.15 * Math.sin(t * 0.7);
  camera.position.set(Math.sin(a) * 5, 1.25, Math.cos(a) * 5); camera.lookAt(0, 0.95, 0); camera.updateMatrixWorld();
  if (mode === 'legacy') pass.render(renderer, scene, camera, {width: 512, height: 512});   // old bug: pre-shake camera, fixed square
  // engine: handheld shake + focus breathing applied after the set update (deterministic in t)
  camera.position.x += 0.035 * Math.sin(t * 13.1); camera.position.y += 0.02 * Math.sin(t * 9.7 + 1); camera.fov = 30 * (1 + 0.01 * Math.sin(t * 3));
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  renderer.render(scene, camera); renderer.getContext().finish();
}
seek(Number(q.get('t')) || 1);
window.__scene = {ready: true, canvas, seek, duration: 10, mode, capture: () => canvas.toDataURL('image/png'), inspect: () => ({maskRenders: pass.renders, mask: [pass.target.width, pass.target.height]})};
