/** Shot tables may use either the JSON adapter or native engine names. */
export const shotStart = shot => shot.start ?? shot.t0;
export const shotEnd = shot => shot.end ?? shot.t1;
export function transitionDuration(shot) {
  if (shot.dissolve > 0) return shot.dissolve;
  const transition = shot.transitionIn;
  return transition?.type && transition.type !== 'cut' ? Math.max(0, transition.dur || 0) : 0;
}
export function hardCuts(shots) {
  return shots.slice(1).filter(shot => !transitionDuration(shot)).map(shotStart);
}

/** Keep real-time samples on their side of a cut, outside world/shutter jumps.
 * Offline seek must NOT use this policy. Closely spaced guard windows are rejected.
 */
export function createCutSafe(cuts, {jump = .008, fps = 24, shutterAngle = 180, epsilon = .0001, duration = Infinity} = {}) {
  if (!(fps > 0) || !Number.isFinite(fps) || !Number.isFinite(jump) || jump < 0 || !(shutterAngle >= 0 && shutterAngle <= 360) || !Number.isFinite(epsilon) || epsilon < 0 || !(duration > 0)) throw new RangeError('Invalid cut guard');
  const guard = jump + shutterAngle / 360 / fps / 2 + epsilon;
  const sorted = [...new Set(cuts)].sort((a, b) => a - b);
  if (sorted.some((c, i) => !Number.isFinite(c) || c <= 0 || c >= duration || (i && c - sorted[i - 1] <= guard * 2))) throw new RangeError('Invalid or overlapping cut windows');
  const cutSafe = t => {
    if (!Number.isFinite(t)) throw new TypeError('Finite time required');
    t = Math.max(0, Math.min(duration, t));
    for (const cut of sorted) if (Math.abs(t - cut) < guard) return Math.max(0, Math.min(duration, t < cut ? cut - guard : cut + guard));
    return t;
  };
  cutSafe.guard = guard;
  return cutSafe;
}

/** True renders include shot boundaries, midpoints, end frames and both dissolve layers. */
export function warmupTimes(shots, fps = 24) {
  if (!Number.isFinite(fps) || fps <= 0) throw new RangeError('Positive fps required');
  return [...new Set(shots.flatMap(shot => {
    const a = shotStart(shot), b = shotEnd(shot), dissolve = transitionDuration(shot);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a) throw new RangeError('Invalid shot interval');
    return [a, (a + b) / 2, Math.max(a, b - 1 / fps), ...(dissolve ? [a + Math.min(dissolve, b - a) / 2] : [])];
  }))].sort((a, b) => a - b);
}

/** Map choreography time while world sampling stays on the real film timeline.
 * frame is the REAL engine frame number, never rounded after remapping.
 * A frozen preset samples the current real world time (its inverse is not unique).
 */
export function remapShotClock({t, frame, fps = 24, start, end, from, to, world}) {
  if (![t, frame, fps, start, end, from, to].every(Number.isFinite) || !Number.isInteger(frame) || fps <= 0 || end <= start) throw new RangeError('Invalid clock mapping');
  const scale = (to - from) / (end - start);
  const map = real => from + (real - start) * scale;
  const inverse = preset => scale === 0 ? t : start + (preset - from) / scale;
  return {t: map(t), frameT: map(frame / fps), realFrameT: frame / fps, toReal: inverse,
    world: world?.at ? {...world, at: preset => world.at(inverse(preset))} : world};
}
