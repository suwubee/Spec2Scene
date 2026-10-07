export class OneEuro {
  constructor({minCutoff = 1, beta = 0.05, derivativeCutoff = 1} = {}) {
    if (!(minCutoff > 0 && beta >= 0 && derivativeCutoff > 0)) throw new Error('Invalid filter parameters');
    Object.assign(this, {minCutoff, beta, derivativeCutoff});
    this.reset();
  }
  reset() { this.time = null; this.value = null; this.raw = null; this.derivative = 0; }
  filter(value, seconds) {
    if (!Number.isFinite(value) || !Number.isFinite(seconds)) throw new Error('Finite sample and timestamp required');
    if (this.time === null) {
      this.time = seconds; this.value = value; this.raw = value;
      return value;
    }
    if (seconds <= this.time) throw new Error('Timestamps must increase');
    const dt = seconds - this.time;
    const alpha = cutoff => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    const velocity = (value - this.raw) / dt;
    this.derivative += alpha(this.derivativeCutoff) * (velocity - this.derivative);
    this.value += alpha(this.minCutoff + this.beta * Math.abs(this.derivative)) * (value - this.value);
    this.raw = value; this.time = seconds;
    return this.value;
  }
}
