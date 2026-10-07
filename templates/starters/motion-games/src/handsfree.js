export class HoldConfirm {
  constructor({seconds = 3, grace = .3} = {}) { this.seconds = seconds; this.grace = grace; this.reset(); }
  reset() { this.start = null; this.lastGood = null; this.done = false; }
  update(good, t) {
    if (this.done) return {progress: 1, confirmed: false};
    if (!good && this.lastGood !== null && t - this.lastGood > this.grace) this.reset();
    if (good) { this.start ??= t; this.lastGood = t; }
    const progress = this.start === null ? 0 : Math.min(1, (t - this.start) / this.seconds);
    const confirmed = good && progress >= 1;
    if (confirmed) this.done = true;
    return {progress, confirmed};
  }
}
export class DwellClick {
  constructor({seconds = 1.2, cooldown = 1} = {}) { this.seconds = seconds; this.cooldown = cooldown; this.target = null; this.since = 0; this.until = 0; }
  update(target, t) {
    if (t < this.until) return null;
    if (target !== this.target) { this.target = target; this.since = t; }
    if (target && t - this.since >= this.seconds) { this.until = t + this.cooldown; this.target = null; return target; }
    return null;
  }
}
export function bothHandsUp(points) {
  return [0, 15, 16].every(i => points[i]) && points[15].y < points[0].y && points[16].y < points[0].y;
}
