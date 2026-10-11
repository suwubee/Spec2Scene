// Author: suwubee
// character/walk-path.js — closed-form walking along a polyline: position, facing, gait distance and footprints, with pauses.
//
//   const path = walkPath([[0, 0, 0], [-40, 0, 2], [-70, 0, 1.5]], {t0: 4, speed: 1.05, stride: 0.45, pauses: [[12, 2.5]]});
//   const p = path.at(t);                         // {pos, yaw, heading, speed, dist, phase, walkW, paused}
//   actor.object.position.fromArray(p.pos); actor.object.rotation.y = p.yaw;
//   actor.update(p.walkW > 0.5 ? 'walk' : 'stand', t, {distance: p.dist, speed: p.speed});
//   for (const fp of path.prints()) ...           // {pos, yaw, heading, foot 'L'|'R', birth} — birth = time she stands on it
//
// Speed rule (measured failure): walked distance = (t - t0 - time paused so far) x speed. An implementation that forgets the
// speed factor walks at 1 m/s whatever `speed` says; at 1.68 m/s the walker lags metres behind where the shot, the camera rig
// and the footprints expect her, the camera frames an empty landscape and footprints appear ahead of her feet. Footprints and
// position must come from the SAME distance function: at(print.birth).dist === print index x stride, exactly.
// Everything is a pure function of t (no accumulated state), so seeks in any order give the same pose.

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };

/**
 * walkPath(points, {speed 1.05 m/s, t0 0, stride 0.45 m (one step; the built-in gait cycle is 0.9 m = two steps),
 *                   pauses [[tStart, duration], ...] (film seconds), ease 0.4 s stop / 0.45 s restart of walkW})
 * yaw = rotation.y for a +Z-forward rig (this character); heading = atan2(-dz, dx) for +X-forward rigs.
 */
export function walkPath(points, {speed = 1.05, t0 = 0, stride = 0.45, pauses = [], easeIn = 0.4, easeOut = 0.45} = {}) {
  if (!Array.isArray(points) || points.length < 2 || !points.every((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) throw new TypeError('walkPath: at least two [x, y, z] points required');
  if (!(speed > 0 && speed <= 3)) throw new RangeError('walkPath: speed must be in (0, 3] m/s');
  if (!(stride >= 0.2 && stride <= 1.2)) throw new RangeError('walkPath: stride (one step) must be 0.2..1.2 m');
  if (!Number.isFinite(t0)) throw new RangeError('walkPath: t0 must be finite');
  const P = (pauses || []).map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0]);
  for (const [pt, d] of P) if (!Number.isFinite(pt) || !(d > 0)) throw new RangeError('walkPath: pauses are [tStart, duration > 0]');
  for (let i = 1; i < P.length; i++) if (P[i][0] < P[i - 1][0] + P[i - 1][1]) throw new RangeError('walkPath: pauses must not overlap');
  const pts = points.map((p) => [...p]), segLen = [], cum = [0];
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]); segLen.push(l); L += l; cum.push(L); }
  if (!(L > 0)) throw new RangeError('walkPath: zero-length path');
  // only pauses that start after t0 stop the walker; paused time is counted up to t
  const active = P.filter(([pt]) => pt >= t0);
  const pausedBefore = (t) => { let s = 0; for (const [pt, d] of active) { if (t <= pt) break; s += clamp(t - pt, 0, d); } return s; };
  const pausedAt = (t) => active.some(([pt, d]) => t > pt && t < pt + d);
  const distAt = (t) => clamp((t - t0 - pausedBefore(t)) * speed, 0, L);     // THE distance function (speed included)
  const sampleAt = (s) => {
    s = clamp(s, 0, L);
    let i = 0; while (i < segLen.length - 1 && cum[i + 1] < s) i++;
    const u = segLen[i] > 1e-12 ? clamp((s - cum[i]) / segLen[i]) : 0, a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dz = b[2] - a[2];
    return {pos: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u], yaw: Math.atan2(dx, dz), heading: Math.atan2(-dz, dx)};
  };
  // exact inverse of distAt (monotone, flat during pauses): the first time the walker reaches distance s
  const timeAtDistance = (s) => {
    s = clamp(s, 0, L);
    let t = t0 + s / speed;
    for (const [pt, d] of active) if (pt < t) t += d; else break;   // each pause that began before arrival delays it
    return t;
  };
  const tEnd = timeAtDistance(L);
  const walkW = (t) => {
    if (t < t0 || t > tEnd + easeIn) return 0;
    let w = smooth(t0 - 1e-6, t0 + easeOut, t) * (1 - smooth(tEnd, tEnd + easeIn, t));
    for (const [pt, d] of active) w *= 1 - smooth(pt - easeIn, pt, t) * (1 - smooth(pt + d, pt + d + easeOut, t));
    return w;
  };
  return {
    length: L, t0, speed, stride, tEnd, timeAtDistance,
    at(t) {
      const dist = distAt(t), {pos, yaw, heading} = sampleAt(dist), paused = pausedAt(t);
      const moving = t >= t0 && !paused && dist < L - 1e-9;
      return {pos, yaw, heading, speed: moving ? speed : 0, dist, phase: dist / stride, walkW: walkW(t), paused};
    },
    /** One print per step along the path; birth = the moment the walker is on it (same distance function as at()). */
    prints() {
      const out = [], n = Math.floor(L / stride + 1e-9);
      for (let k = 1; k <= n; k++) { const s = k * stride, {pos, yaw, heading} = sampleAt(s); out.push({pos, yaw, heading, foot: k % 2 ? 'L' : 'R', dist: s, birth: timeAtDistance(s)}); }
      return out;
    },
  };
}
