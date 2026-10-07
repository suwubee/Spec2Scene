import {clamp, curve, noise, smooth} from '../core/math.js';
export const focalToFov = (focal, sensorHeight = 24) => 2 * Math.atan(sensorHeight / (2 * focal)) * 180 / Math.PI;
export function validateShots(shots) {
  if (!shots.length || shots[0].start !== 0) throw new Error('shots must begin at zero');
  shots.forEach((s, i) => {
    if (![s.start,s.end].every(Number.isFinite) || !(s.end > s.start) || (i && s.start !== shots[i - 1].end)) throw new Error('shots must cover a contiguous timeline');
    for (const key of ['position', 'target', 'focal', 'focus', 'fstop']) {
      if (!Array.isArray(s[key]) || !s[key].length) throw new Error(`missing camera curve ${key}`);
      s[key].forEach((k, j) => {
        if (['position','target'].includes(key)&&(!Array.isArray(k[1])||k[1].length!==3))throw new Error('camera vectors need three coordinates');
        if (!Number.isFinite(k[0]) || (j && k[0] <= s[key][j-1][0])) throw new Error('camera keys must increase');
        if ((Array.isArray(k[1]) ? k[1] : [k[1]]).some(v => !Number.isFinite(v))) throw new Error('invalid camera value');
        if (['focal','focus','fstop'].includes(key) && k[1] <= 0) throw new Error('positive lens values required');
      });
    }
    if ((s.dissolve || 0) < 0 || (s.dissolve || 0) > s.end - s.start) throw new Error('invalid dissolve');
  });
  return shots;
}
export function shotAt(shots, t) {
  const time = clamp(t, 0, shots.at(-1).end);
  const index = Math.max(0, shots.findIndex(s => time < s.end));
  const i = time === shots.at(-1).end ? shots.length - 1 : index;
  const shot = shots[i], elapsed = time - shot.start;
  const previous = i > 0 && time < shot.start + (shot.dissolve || 0) ? shots[i - 1] : null;
  return {shot, previous, blend: previous ? smooth(elapsed / shot.dissolve) : 1};
}
export function cameraAt(shot, t) {
  const u = clamp(t - shot.start, 0, shot.end - shot.start);
  const position = curve(shot.position, u).slice();
  if (shot.breath) for (let i = 0; i < 3; i++) position[i] += noise(t * .7 + i * 17, 31) * shot.breath;
  return {position, target: curve(shot.target, u), focal: curve(shot.focal, u), focus: curve(shot.focus, u), fstop: curve(shot.fstop, u)};
}
export function applyCamera(camera, state) {
  camera.position.fromArray(state.position); camera.lookAt(...state.target);
  camera.fov = focalToFov(state.focal); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
}
export function orbit(center, radius, height, angle) { return [center[0] + Math.sin(angle) * radius, center[1] + height, center[2] + Math.cos(angle) * radius]; }
