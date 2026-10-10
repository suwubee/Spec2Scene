// Material bench: five fixed views, all resident; view = floor(t / 4): 0 snow at a grazing long lens, 1 snow from 30 m above,
// 2 ice with snow tongues, 3 rammed-earth wall, 4 heightfield snow drift. ?t=1|5|9|13|17. window.__scene = {ready, seek, resize,
// capture, inspect}. Run picture-qa on the five captures after any change to this kit (README "Acceptance").
import * as THREE from '../../engine/vendor/three.module.js';
import {snowMaterial, iceMaterial, rammedEarthMaterial, snowDriftGeometry, setMaterialLight} from './index.js';

const canvas = document.querySelector('canvas');
const renderer = new THREE.WebGLRenderer({canvas, antialias: false, preserveDrawingBuffer: true});
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
// Gradient night sky dome (zenith -> horizon), so the frame has a readable horizon and no flat backdrop.
const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), new THREE.ShaderMaterial({side: THREE.BackSide, depthWrite: false,
  vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'varying vec3 vD; void main(){ float h = clamp(vD.y, 0.0, 1.0); vec3 c = mix(vec3(0.030, 0.042, 0.075), vec3(0.004, 0.007, 0.018), pow(h, 0.45)); gl_FragColor = vec4(c, 1.0); }'}));
sky.renderOrder = -1; scene.add(sky);
// Aerial perspective: distant ground fades into the horizon colour (no razor-hard horizon, no compressed far-field bands).
scene.fog = new THREE.FogExp2(new THREE.Color().setRGB(0.030, 0.042, 0.075), 0.011);
const camera = new THREE.PerspectiveCamera(30, 960 / 402, 0.05, 2000);
const moonDir = new THREE.Vector3();
const moon = new THREE.DirectionalLight(new THREE.Color().setRGB(0.70, 0.78, 0.92), 1.15); moon.castShadow = true; moon.shadow.mapSize.set(1024, 1024);
Object.assign(moon.shadow.camera, {left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 160}); moon.shadow.bias = -0.0004;
scene.add(moon, moon.target, new THREE.HemisphereLight(new THREE.Color().setRGB(0.10, 0.14, 0.24), new THREE.Color().setRGB(0.03, 0.03, 0.04), 0.35));

const wind = [0.94, 0.34], light = [0.4, 0.35, 0.85];
const snow = snowMaterial(THREE, {preset: 'field', wind, light});
const ice = iceMaterial(THREE, {preset: 'black', cover: 0.42, wind, light});
const wall = rammedEarthMaterial(THREE, {groundY: 0, top: 5, layer: 0.12, footSnow: 0.25});
const drift = snowMaterial(THREE, {preset: 'drift', wind, light});
const plane = (mat, size = 800) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat); m.rotation.x = -Math.PI / 2; m.receiveShadow = true; return m; };
const views = [
  // moon = direction towards the moon, chosen per view so relief reads and the specular hot spot stays out of frame
  {group: new THREE.Group(), cam: [0, 1.25, 6], look: [0, 0.2, -40], fov: 24, moon: [-0.55, 0.22, -0.8]},
  {group: new THREE.Group(), cam: [0, 30, 22], look: [0, 0, -12], fov: 40, moon: [0.9, 0.22, -0.3], exposure: 0.8},
  {group: new THREE.Group(), cam: [0, 7, 7], look: [0, 0, -9], fov: 40, moon: [0.75, 0.42, -0.5]},
  {group: new THREE.Group(), cam: [-2, 1.7, 7], look: [0.5, 2.0, -6], fov: 40, moon: [0.45, 0.4, 0.8]},
  {group: new THREE.Group(), cam: [-4.5, 1.6, 5], look: [0, 0.5, -10], fov: 34, moon: [0.8, 0.28, -0.45]},
];
views[0].group.add(plane(snow)); views[1].group.add(plane(snow));
views[2].group.add(plane(ice));
const wallMesh = new THREE.Mesh(new THREE.BoxGeometry(14, 5, 1.2), wall); wallMesh.position.set(0, 2.5, -8); wallMesh.rotation.y = 0.32; wallMesh.castShadow = wallMesh.receiveShadow = true;
views[3].group.add(plane(snow), wallMesh);
const mound = new THREE.Mesh(snowDriftGeometry(THREE, {r: 2.6, h: 1.25, windDir: wind, seed: 3}), drift); mound.position.set(0, 0, -10); mound.castShadow = mound.receiveShadow = true;
views[4].group.add(plane(snow), mound);
for (const v of views) { v.group.visible = false; scene.add(v.group); }

function seek(t) {
  const i = Math.max(0, Math.min(views.length - 1, Math.floor(Number(t) / 4) || 0)), v = views[i];
  views.forEach((x, k) => { x.group.visible = k === i; });
  camera.position.set(...v.cam); camera.fov = v.fov; camera.updateProjectionMatrix(); camera.lookAt(...v.look); camera.updateMatrixWorld();
  moonDir.set(...v.moon).normalize(); renderer.toneMappingExposure = v.exposure ?? 1.0;
  moon.target.position.set(v.look[0], 0, v.look[2]); moon.position.copy(moon.target.position).addScaledVector(moonDir, 60); moon.target.updateMatrixWorld();
  for (const m of [snow, ice, drift]) setMaterialLight(m, moonDir.toArray());
  renderer.render(scene, camera); renderer.getContext().finish();
}
function resize(w, h) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
resize(960, 402);
// Compile every view once before declaring ready (no lazy shader creation during seeks).
for (let t = 0; t < 20; t += 4) seek(t);
seek(Number(new URLSearchParams(location.search).get('t')) || 1);
window.__scene = {ready: true, canvas, seek, resize, duration: 20, fps: 24, views: views.length,
  capture: () => canvas.toDataURL('image/png'), inspect: () => ({calls: renderer.info.render.calls, programs: renderer.info.programs.length})};
window.addEventListener('pagehide', () => { renderer.dispose(); }, {once: true});
