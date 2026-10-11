// Far-range + building-block bench: six fixed views of one world, all resident; view = floor(t / 4):
//   0 long lens on layered ranges (85 mm)   1 low distant ring with a tower slot and a village slot (35 mm)
//   2 flat-roofed houses with real openings and snow caps   3 fortified wall with an arched gate and gate house
//   4 ruined rammed tower   5 clinker plank hull on snow
// ?t=1|5|9|13|17|21. window.__scene = {ready, seek, resize, capture, inspect}. Stand-alone three.js (no engine atmosphere):
// the ranges use their own haze; MeshStandard parts use scene fog of the same horizon colour. Run picture-qa on the captures
// after any change to this kit (README "Acceptance").
import * as THREE from '../../engine/vendor/three.module.js';
import {snowMaterial, setMaterialLight} from '../materials/index.js';
import {createFarRanges, FAR_PRESETS, blockBatches, flatRoofHouse, fortWall, plankHull, rammedTowerGeometry, buildBlockMeshes, blockMaterials, azOf} from './index.js';

const canvas = document.querySelector('canvas');
const renderer = new THREE.WebGLRenderer({canvas, antialias: false, preserveDrawingBuffer: true});
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const HORIZON = [0.040, 0.052, 0.085], ZENITH = [0.004, 0.007, 0.018];
const sky = new THREE.Mesh(new THREE.SphereGeometry(20000, 48, 24), new THREE.ShaderMaterial({side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: {uH: {value: new THREE.Vector3(...HORIZON)}, uZ: {value: new THREE.Vector3(...ZENITH)}},
  vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform vec3 uH, uZ; varying vec3 vD; void main(){ float h = clamp(vD.y, 0.0, 1.0); gl_FragColor = vec4(mix(uH, uZ, pow(h, 0.42)), 1.0); }'}));
sky.renderOrder = -20; sky.frustumCulled = false; scene.add(sky);
scene.fog = new THREE.FogExp2(new THREE.Color().setRGB(0.030, 0.042, 0.072), 0.0006);   // = the ranges' haze target: the plain and the mountain foot meet without a seam
const camera = new THREE.PerspectiveCamera(30, 960 / 402, 0.1, 40000);
const moonDir = new THREE.Vector3();
const moon = new THREE.DirectionalLight(new THREE.Color().setRGB(0.70, 0.78, 0.92), 1.2); moon.castShadow = true; moon.shadow.mapSize.set(2048, 2048); moon.shadow.bias = -0.0004;
const hemi = new THREE.HemisphereLight(new THREE.Color().setRGB(0.10, 0.14, 0.24), new THREE.Color().setRGB(0.03, 0.03, 0.04), 0.6);   // cold sky fill: shaded faces never dead black (E8)
scene.add(moon, moon.target, hemi);

const wind = [0.94, 0.34];
const ground = new THREE.Mesh(new THREE.PlaneGeometry(30000, 30000), snowMaterial(THREE, {preset: 'far', params: {ridge: 0.2, macro: 0.08, crust: 0.05}, wind, light: [0.4, 0.35, 0.85]}));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const skyAmb = {up: [0.030, 0.042, 0.072], low: [0.010, 0.012, 0.018]};
const ranges = createFarRanges(THREE, {...FAR_PRESETS.layeredArc, baseY: 0, sky: skyAmb, light: {gain: 0.6, ambient: 1.3, subsurface: 0.5, airGlow: 1.9}});
const ring = createFarRanges(THREE, {...FAR_PRESETS.distantRing, baseY: 0, sky: skyAmb, light: {gain: 0.6, ambient: 1.3, airGlow: 1.7},
  slots: [{kind: 'beacon', layer: 0, az: 262, h: 12}, {kind: 'village', layer: 0, az: 284, r: 2600, n: 9, spread: 90}]});
scene.add(ranges.object, ring.object);

// ---- building blocks: one group per view, placed in front of the ranges (looking west) ----
const mats = blockMaterials(THREE, {top: 4, wind});
const dirOf = (az) => [Math.sin(az * Math.PI / 180), -Math.cos(az * Math.PI / 180)];
const groupOf = (b, mt = mats) => { const g = new THREE.Group(); for (const m of Object.values(buildBlockMeshes(THREE, b, mt))) g.add(m); return g; };
const houses = blockBatches();
const hd = dirOf(115);   // looks east, away from the ranges: 35-50 mm from a low camera stacks distant ridges into bands (README limits)
for (const [k, off, side, yawK] of [[0, 52, -6, 0.2], [1, 60, 9, -0.15], [2, 71, -1, 0.05]]) {
  const x = hd[0] * off - hd[1] * side, z = hd[1] * off + hd[0] * side, yaw = Math.atan2(hd[0], -hd[1]) + yawK;   // +c face towards the camera
  flatRoofHouse(houses, {pos: [x, 0, z], yaw, w: 7 + k, d: 5 + 0.5 * k, h: 3.1 + 0.3 * k, wind: 1, seed: 11 + k, chimney: k !== 1 ? {a: 1.6, c: 0.4, h: 0.9} : null,
    doors: [{face: '+c', u: 2.2 + k * 0.4, w: 1.1, h: 2.0}], windows: [{face: '+c', u: 4.6 + k * 0.5, y: 1.1, w: 0.9, h: 0.9, lit: k === 1}, {face: '-a', u: 2.4, y: 1.2, w: 0.8, h: 0.8}],
    yard: k === 0 ? {len: 5, h: 1.8} : null});
}
const fort = blockBatches();
const fd = dirOf(245), fortAt = [fd[0] * 160, 0, fd[1] * 160], fortYaw = Math.atan2(-fd[0], fd[1]);   // outside (-c) faces the camera
fortWall(fort, {pos: fortAt, yaw: fortYaw, len: 90, h: 8, gY: () => 0, seed: 5});
const towerAt = [-26, -2.5], tw = rammedTowerGeometry({center: towerAt, base: 6.5, top: 4.2, h: 8, yaw: 0.35, wind, seed: 9, collapses: [{az: 20, w: 2.2, depth: 1.6, bite: 1.3}], rubble: [{az: 20, r: 1.8, h: 1.0}]});
const tg = new THREE.BufferGeometry();
tg.setAttribute('position', new THREE.Float32BufferAttribute(tw.pos, 3)); tg.setAttribute('normal', new THREE.Float32BufferAttribute(tw.nrm, 3));
tg.setAttribute('color', new THREE.Float32BufferAttribute(tw.ao.flatMap((a) => [a, a, a]), 3)); tg.setIndex(tw.idx);
const towerMat = blockMaterials(THREE, {top: 8, wind, wall: {topSnow: 0}}).wall; towerMat.vertexColors = true;
const towerMesh = new THREE.Mesh(tg, towerMat); towerMesh.castShadow = towerMesh.receiveShadow = true;
const hull = blockBatches();
plankHull(hull, {pos: [-9, 0, 0.6], yaw: 0.5, len: 6.5, beam: 2.0, depth: 0.6, snow: 0.25});
const views = [
  // cameras stand on a low rise (long lenses at 1-2 m above a snow plain compress ripples into bands: materials README R6/R10)
  {group: new THREE.Group(), cam: [0, 40, 0], look: dirOf(268), lookY: 75, dist: 2400, fov: 10.1, moon: [0.6, 0.42, 0.68], exposure: 1.3},
  {group: new THREE.Group(), cam: [0, 9, 0], look: dirOf(270), lookY: 60, dist: 2600, fov: 18, moon: [0.3, 0.38, 0.88], exposure: 1.4, ring: true},
  {group: groupOf(houses), cam: [0, 6, 0], look: dirOf(115), lookY: 3, dist: 62, fov: 17, moon: [-0.75, 0.42, 0.15], exposure: 1.15},
  {group: groupOf(fort), cam: [0, 5, 0], look: dirOf(245), lookY: 7, dist: 160, fov: 17, moon: [0.88, 0.3, -0.12], exposure: 1.15},
  {group: new THREE.Group().add(towerMesh), cam: [0, 2.5, 0], look: dirOf(275), lookY: 4.5, dist: 26, fov: 34, moon: [0.95, 0.26, 0.15], exposure: 1.15},
  {group: groupOf(hull), cam: [0, 2.6, 0], look: dirOf(276), lookY: -0.4, dist: 9.5, fov: 38, moon: [0.75, 0.42, -0.45], exposure: 1.05},
];
for (const v of views) { v.group.visible = false; scene.add(v.group); }

function seek(t) {
  const i = Math.max(0, Math.min(views.length - 1, Math.floor(Number(t) / 4) || 0)), v = views[i];
  views.forEach((x, k) => { x.group.visible = k === i; });
  ranges.object.visible = !v.ring; ring.object.visible = !!v.ring;
  const tgt = [v.cam[0] + v.look[0] * v.dist, v.lookY, v.cam[2] + v.look[1] * v.dist];
  camera.position.set(...v.cam); camera.fov = v.fov; camera.updateProjectionMatrix(); camera.lookAt(...tgt); camera.updateMatrixWorld();
  moonDir.set(...v.moon).normalize(); renderer.toneMappingExposure = v.exposure;
  const near = v.dist < 200 ? tgt : [v.cam[0] + v.look[0] * 30, 0, v.cam[2] + v.look[1] * 30];
  const r = Math.min(v.dist * 0.75, 60);
  Object.assign(moon.shadow.camera, {left: -r, right: r, top: r, bottom: -r, near: 1, far: 400}); moon.shadow.camera.updateProjectionMatrix();
  moon.target.position.set(near[0], 0, near[2]); moon.position.copy(moon.target.position).addScaledVector(moonDir, 150); moon.target.updateMatrixWorld();
  setMaterialLight(ground.material, moonDir.toArray()); setMaterialLight(mats.snow, moonDir.toArray());
  ranges.update({lights: [moon]}); ring.update({lights: [moon]});
  renderer.render(scene, camera); renderer.getContext().finish();
}
function resize(w, h) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
resize(960, 402);
for (let t = 0; t < views.length * 4; t += 4) seek(t);          // compile every view once before ready (no lazy programs)
seek(Number(new URLSearchParams(location.search).get('t')) || 1);
window.__scene = {ready: true, canvas, seek, resize, duration: views.length * 4, fps: 24, views: views.length,
  capture: () => canvas.toDataURL('image/png'),
  inspect: () => ({calls: renderer.info.render.calls, programs: renderer.info.programs.length, verts: ranges.stats.verts + ring.stats.verts, maxSlopeDeg: Math.max(ranges.stats.maxSlopeDeg, ring.stats.maxSlopeDeg), slots: ring.slots.map((s) => [s.kind, Math.round(azOf(s.at[0], s.at[2]))])})};
window.addEventListener('pagehide', () => { renderer.dispose(); ranges.dispose(); ring.dispose(); }, {once: true});
