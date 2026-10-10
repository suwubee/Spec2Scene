// A fictional, seamless spherical surface. No mapped landmarks or image inputs.
export function bakeSurface({seed = 31, resolution = 512, craters = 96, relief = 0.006} = {}) {
  if (!Number.isInteger(seed) || !Number.isInteger(resolution) || resolution < 64 || resolution > 1024 ||
      resolution % 2 || !Number.isInteger(craters) || craters < 0 || craters > 256 || !Number.isFinite(relief) || relief < 0 || relief > 0.02) throw new Error('Invalid surface budget');
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const features = Array.from({length: craters}, () => {
    const y = random() * 2 - 1, a = random() * Math.PI * 2, r = Math.sqrt(1 - y * y);
    return {x: r * Math.cos(a), y, z: r * Math.sin(a), radius: 0.018 + random() ** 2 * 0.18};
  });
  const width = resolution, height = resolution / 2, data = new Float32Array(width * height * 4);
  const phase = random() * 6;
  for (let y = 0; y < height; y++) {
    const lat = ((y + .5) / height - .5) * Math.PI, cy = Math.cos(lat), sy = Math.sin(lat);
    for (let x = 0; x < width; x++) {
      const lon = ((x + .5) / width - .5) * Math.PI * 2, nx = cy * Math.cos(lon), nz = cy * Math.sin(lon);
      let noise = 0, amp = .55;
      for (let o = 0; o < 5; o++) {
        const f = 5 * 2 ** o;
        noise += amp * Math.sin(nx * f + phase + o) * Math.sin(sy * f * 1.13 - o) * Math.cos(nz * f * .91 + phase);
        amp *= .48;
      }
      let h = noise * .14;
      for (const c of features) {
        const d2 = Math.max(0, 2 - 2 * (nx * c.x + sy * c.y + nz * c.z));
        if (d2 > c.radius * c.radius * 1.69) continue;
        const d = Math.sqrt(d2) / c.radius;
        h += c.radius * (0.48 * Math.exp(-(((d - 1) / .13) ** 2)) - .65 * Math.max(0, 1 - d * d));
      }
      const i = (y * width + x) * 4;
      data[i] = .38 + .2 * noise + .05 * Math.sin(nx * 12 + nz * 8 + sy * 6);
      data[i + 1] = h * relief;
    }
  }
  const heightAt = (x, y) => data[(Math.max(0, Math.min(height - 1, y)) * width + (x + width) % width) * 4 + 1];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, latitude = ((y + .5) / height - .5) * Math.PI;
    data[i + 2] = (heightAt(x + 1, y) - heightAt(x - 1, y)) / (4 * Math.PI / width * Math.max(.02, Math.cos(latitude)));
    data[i + 3] = (heightAt(x, y + 1) - heightAt(x, y - 1)) / (2 * Math.PI / height);
  }
  return {width, height, data};
}

/** phase=0 new, .5 full, 1 new; light always rotates on the sphere. */
export function phaseLight(phase) {
  if (!Number.isFinite(phase)) throw new Error('phase must be finite');
  const angle = phase * 2 * Math.PI;
  return [Math.sin(angle), 0, -Math.cos(angle)];
}
