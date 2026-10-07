// Author: suwubee
// engine/camera.js — camera rig helpers. All pure functions of t (no accumulated state).
//
// Camera spec (timeline shot.cam or Set-local), all angles in DEGREES, distances in metres:
//   { keys: [ {t|u, pos:[x,y,z], target:[x,y,z] | pan, tilt, fov | focal, roll}, ... ],
//     ease: 'cine',            // used when there are exactly 2 keys (else monotone-cubic timing)
//     easeIn: true, easeOut: true,   // zero velocity at the first / last key
//     handheld: 0.4,           // 0..1  (1 == ±0.15° peak, 1/f spectrum)
//     breathing: 0.02,         // focus breathing strength (fraction of FOV per dioptre)
//     seed: 'shotA' }
//   { from:{pos,target,fov,roll}, to:{...}, t0, t1, ease }       // 2-key shorthand (t0/t1 shot-local)
//   { pos, target, fov }                                        // locked-off
// `t` in keys is shot-local seconds; `u` is normalised 0..1 over the shot duration.
import { catmullRom, monotoneCubic, getEase, clamp, saturate, DEG, evalCurve } from './util.js';
import { pink1, hashString } from './noise.js';

/** Super-35 4-perf width. Scope picture height = width / 2.39. */
export const SENSOR_WIDTH_MM = 24.89;

export function sensorHeightMM(aspect = 1920 / 804, sensorWidth = SENSOR_WIDTH_MM) { return sensorWidth / aspect; }
/** focal length (mm) of a vertical FOV (deg) on the given sensor */
export function focalFromFov(fovDeg, aspect = 1920 / 804, sensorWidth = SENSOR_WIDTH_MM) {
  return (sensorHeightMM(aspect, sensorWidth) / 2) / Math.tan((fovDeg * DEG) / 2);
}
/** vertical FOV (deg) of a focal length (mm) */
export function fovFromFocal(mm, aspect = 1920 / 804, sensorWidth = SENSOR_WIDTH_MM) {
  return (2 * Math.atan((sensorHeightMM(aspect, sensorWidth) / 2) / mm)) / DEG;
}

const v3 = (a) => [a[0], a[1], a[2]];
function dirFromPanTilt(pan = 0, tilt = 0) {
  const p = pan * DEG, q = tilt * DEG;
  return [Math.sin(p) * Math.cos(q), Math.sin(q), -Math.cos(p) * Math.cos(q)];
}

function normKey(k, dur, aspect) {
  const t = k.t !== undefined ? k.t : k.u !== undefined ? k.u * dur : 0;
  const pos = v3(k.pos || [0, 1.6, 5]);
  let target;
  if (k.target) target = v3(k.target);
  else {
    const d = dirFromPanTilt(k.pan || 0, k.tilt || 0);
    target = [pos[0] + d[0] * 10, pos[1] + d[1] * 10, pos[2] + d[2] * 10];
  }
  const fov = k.fov !== undefined ? k.fov : k.focal !== undefined ? fovFromFocal(k.focal, aspect) : undefined;
  return { t, pos, target, fov, roll: k.roll || 0 };
}

/** Normalise any camera spec to {keys:[...], opts} */
export function normalizeCamSpec(spec, dur, aspect) {
  if (!spec) return null;
  let keys;
  if (spec.keys) keys = spec.keys.map((k) => normKey(k, dur, aspect));
  else if (spec.from && spec.to) {
    const t0 = spec.t0 !== undefined ? spec.t0 : 0, t1 = spec.t1 !== undefined ? spec.t1 : dur;
    keys = [normKey({ ...spec.from, t: t0 }, dur, aspect), normKey({ ...spec.to, t: t1 }, dur, aspect)];
  } else if (spec.pos) keys = [normKey({ ...spec, t: 0 }, dur, aspect)];
  else return null;
  keys.sort((a, b) => a.t - b.t);
  // fill missing fov forward/backward
  let lastFov = keys.find((k) => k.fov !== undefined)?.fov ?? 30;
  for (const k of keys) { if (k.fov === undefined) k.fov = lastFov; lastFov = k.fov; }
  return { keys, spec };
}

/**
 * Evaluate a camera spec at shot-local time t. Returns plain data:
 *   { pos:[x,y,z], target:[x,y,z], fov, roll, handheld, breathing, seed }
 */
const _normCache = new WeakMap();
export function evalCam(spec, t, dur = 10, aspect = 1920 / 804) {
  if (!spec) return null;
  let ns = _normCache.get(spec);
  if (!ns || ns.dur !== dur || ns.aspect !== aspect) {
    ns = normalizeCamSpec(spec, dur, aspect);
    if (!ns) return null;
    ns.dur = dur; ns.aspect = aspect;
    _normCache.set(spec, ns);
  }
  const { keys } = ns;
  const o = ns.spec || {};
  let s;
  if (keys.length === 1) s = 0;
  else if (keys.length === 2) {
    const u = saturate((t - keys[0].t) / Math.max(1e-6, keys[1].t - keys[0].t));
    const e = o.easeIn === false && o.easeOut === false ? getEase('linear')
      : o.easeIn === false ? getEase('outSine') : o.easeOut === false ? getEase('inSine') : getEase(o.ease);
    s = e(u);
  } else {
    // monotone cubic: time -> key index; zero velocity at the ends unless disabled
    const xs = keys.map((k) => k.t), ys = keys.map((_, i) => i);
    const f = monotoneCubic(xs, ys, { endSlope: o.easeIn === false || o.easeOut === false ? 'free' : 'zero' });
    s = f(t);
  }
  const pos = catmullRom(keys.map((k) => k.pos), s);
  const target = catmullRom(keys.map((k) => k.target), s);
  const fov = catmullRom(keys.map((k) => [k.fov]), s)[0];
  const roll = catmullRom(keys.map((k) => [k.roll]), s)[0];
  return { pos, target, fov, roll, handheld: o.handheld || 0, breathing: o.breathing ?? 0.02, seed: o.seed ?? 'cam', up: o.up || [0, 1, 0] };
}

/**
 * Handheld micro-shake: 1/f noise, amplitude <= 0.15° at amount=1 (soft-clipped), plus mm-scale sway.
 * Returns {yaw, pitch, roll} in RADIANS and {dx,dy,dz} in metres (camera-local).
 */
export function handheld(t, amount = 0.3, seed = 'hh') {
  if (!amount) return { yaw: 0, pitch: 0, roll: 0, dx: 0, dy: 0, dz: 0 };
  const s = typeof seed === 'number' ? seed : hashString(String(seed));
  const maxRad = 0.15 * DEG * clamp(amount, 0, 1.5);
  const sc = (x) => Math.tanh(1.3 * x); // soft clip to ±1
  return {
    yaw: maxRad * sc(pink1(t, s + 11, { fmin: 0.18, octaves: 6 })),
    pitch: maxRad * 0.85 * sc(pink1(t, s + 23, { fmin: 0.22, octaves: 6 })),
    roll: maxRad * 0.5 * sc(pink1(t, s + 37, { fmin: 0.15, octaves: 5 })),
    dx: 0.004 * amount * pink1(t, s + 41, { fmin: 0.12, octaves: 4 }),
    dy: 0.003 * amount * pink1(t, s + 53, { fmin: 0.15, octaves: 4 }),
    dz: 0.002 * amount * pink1(t, s + 67, { fmin: 0.1, octaves: 3 }),
  };
}

/** FOV after focus breathing: focusing closer narrows the view by `amount` per dioptre. */
export function breathe(fovDeg, focusDistance, amount = 0.02) {
  if (!amount) return fovDeg;
  return fovDeg * (1 - amount / Math.max(0.25, focusDistance));
}

/** Rack focus between two distances over [t0,t1] — interpolated in dioptres (like a focus ring). */
export function rackFocus(t, from, to, t0, t1, easeName = 'inOutSine') {
  const u = getEase(easeName)(saturate((t - t0) / Math.max(1e-6, t1 - t0)));
  const d0 = 1 / Math.max(0.05, from), d1 = 1 / Math.max(0.05, to);
  return 1 / (d0 + (d1 - d0) * u);
}

/** Interpolate a keyed focus distance list [[t, dist], ...] in dioptre space */
export function focusKeys(keys, t, easeName = 'inOutSine') {
  if (!keys.length) return 10;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    if (t < keys[i + 1][0]) return rackFocus(t, keys[i][1], keys[i + 1][1], keys[i][0], keys[i + 1][0], easeName);
  }
  return keys[keys.length - 1][1];
}

/** view-space depth (metres along the view axis) of a world point for a camera state {pos,target} or a THREE camera */
export function viewDepth(camOrState, point) {
  let pos, fwd;
  if (camOrState.isCamera) {
    camOrState.updateMatrixWorld();
    const e = camOrState.matrixWorld.elements;
    pos = [e[12], e[13], e[14]];
    fwd = [-e[8], -e[9], -e[10]];
  } else {
    pos = camOrState.pos;
    const d = [camOrState.target[0] - pos[0], camOrState.target[1] - pos[1], camOrState.target[2] - pos[2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    fwd = [d[0] / l, d[1] / l, d[2] / l];
  }
  const fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
  return ((point[0] - pos[0]) * fwd[0] + (point[1] - pos[1]) * fwd[1] + (point[2] - pos[2]) * fwd[2]) / fl;
}

/**
 * Evaluate a focus spec at shot-local t:
 *   { distance: 4 | [[t,d],...], fstop: 2 | [[t,N],...], pull:{from,to,t0,t1,ease}, target:[x,y,z],
 *     focal: mm (override), dofScale: 1 }
 * `camera` (THREE camera, already placed) is used for `target` focus and as fallback.
 * Returns {distance, fstop, focal?, dofScale?} (undefined fields are left for defaults).
 */
export function evalFocus(spec, t, camera, fallbackDistance) {
  if (!spec) return null;
  if (typeof spec === 'function') return spec(t, camera);
  const out = {};
  if (spec.pull) {
    const p = spec.pull;
    out.distance = rackFocus(t, p.from, p.to, p.t0 ?? 0, p.t1 ?? 1, p.ease);
  } else if (Array.isArray(spec.distance)) out.distance = focusKeys(spec.distance, t, spec.ease);
  else if (typeof spec.distance === 'number') out.distance = spec.distance;
  else if (spec.target && camera) out.distance = Math.max(0.05, viewDepth(camera, spec.target));
  else if (fallbackDistance !== undefined) out.distance = fallbackDistance;
  if (spec.fstop !== undefined) out.fstop = evalCurve(spec.fstop, t, 2.8);
  if (spec.focal !== undefined) out.focal = evalCurve(spec.focal, t);
  if (spec.dofScale !== undefined) out.dofScale = evalCurve(spec.dofScale, t, 1);
  return out;
}

/**
 * Apply an evaluated camera state to a THREE.PerspectiveCamera (position, look-at, roll, fov).
 * Pass `THREE` so this module stays dependency-free.
 */
export function applyCamState(THREE, camera, st) {
  camera.position.set(st.pos[0], st.pos[1], st.pos[2]);
  if (st.up) camera.up.set(st.up[0], st.up[1], st.up[2]);
  camera.lookAt(st.target[0], st.target[1], st.target[2]);
  if (st.roll) camera.rotateZ(st.roll * DEG);
  if (st.fov !== undefined && Math.abs(camera.fov - st.fov) > 1e-9) { camera.fov = st.fov; camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();
}

// ---------------------------------------------------------------------------------------------
// Move generators — return key arrays for common operator moves (all "real" eased moves).
// ---------------------------------------------------------------------------------------------
/** dolly/truck from p0 to p1 keeping a (possibly moving) target */
export const dolly = ({ from, to, target, target1, fov = 30, fov1, t0 = 0, t1 = 1, ease = 'cine' }) =>
  ({ from: { pos: from, target, fov }, to: { pos: to, target: target1 || target, fov: fov1 ?? fov }, t0, t1, ease });

/** crane: vertical move with a tilt that keeps `target` framed */
export const crane = ({ base, h0, h1, target, target1, fov = 30, t0 = 0, t1 = 1, ease = 'cine' }) =>
  ({ from: { pos: [base[0], h0, base[2]], target, fov }, to: { pos: [base[0], h1, base[2]], target: target1 || target, fov }, t0, t1, ease });

/** orbit/arc around `center`: n spline keys from azimuth a0 to a1 (deg), radius r0->r1, height y0->y1 */
export function orbit({ center = [0, 0, 0], a0 = -20, a1 = 20, r0 = 5, r1, y0 = 1.6, y1, fov = 30, t0 = 0, t1 = 1, n = 5, lookAt }) {
  const keys = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const a = (a0 + (a1 - a0) * u) * DEG, r = r0 + ((r1 ?? r0) - r0) * u, y = y0 + ((y1 ?? y0) - y0) * u;
    keys.push({ t: t0 + (t1 - t0) * u, pos: [center[0] + Math.sin(a) * r, y, center[2] + Math.cos(a) * r], target: lookAt || center, fov });
  }
  return { keys };
}
