// Wind-drift snow mound as a HEIGHTFIELD (README R5): every vertex is y = f(x, z), so the mound can never grow a vertical wall
// that a ground projection would stretch into stripes. Shape in wind coordinates (a downwind, c crosswind): long gentle windward
// slope -> slightly lee-shifted sharp crest (cornice) -> short steep lee face -> soft tail; Gaussian cross-section with a
// meandering crest; noisy outline; the rim sinks 3 cm into the ground so there is no seam.
//   const geo = snowDriftGeometry(THREE, {r: 2.5, h: 1.2, windDir: [0.94, 0.34], seed: 3});
//   const mound = new THREE.Mesh(geo, snowMaterial(THREE, {preset: 'drift'})); mound.position.set(x, groundY, z);
// Keep large props (drifts, cairns) more than 3x their height away from the camera unless designed as a foreground frame (R12).
import {makeRng} from '../../engine/noise.js';

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const sstep = (e0, e1, x) => { const u = clamp((x - e0) / (e1 - e0)); return u * u * (3 - 2 * u); };

/** Height function of the drift in local metres (x, z relative to the centre). Pure. */
export function driftHeightField({r = 2.5, h = 1.2, seed = 1, elong = 1.7, tail = 0.35, ripple = 0.05, windDir = [0.94, 0.34]} = {}) {
  if (!(r >= 0.3 && r <= 30) || !(h > 0 && h <= r)) throw new RangeError('drift needs 0.3 <= r <= 30 and 0 < h <= r');
  const rng = makeRng('drift:' + seed), wl = Math.hypot(windDir[0], windDir[1]) || 1, wx = windDir[0] / wl, wz = windDir[1] / wl;
  const ph1 = rng() * 6.28, ph2 = rng() * 6.28, ph3 = rng() * 6.28, ph4 = rng() * 6.28;
  const Lu = r * elong, Ld = r * 0.75, Lt = r * tail, ac = r * 0.12;
  const edgeN = (ang) => 1 + 0.10 * Math.sin(ang * 2 + ph1) + 0.07 * Math.sin(ang * 3 + ph2) + 0.04 * Math.sin(ang * 5 + ph3);
  const hAt = (a, c) => {
    const cm = c - 0.12 * r * Math.sin(a / r * 1.3 + ph4), k = edgeN(Math.atan2(cm, a)), q = Math.exp(-Math.pow(cm / (r * k), 2) * 2.0);
    let p;
    if (a <= ac) p = Math.pow(sstep(-Lu * k, ac, a), 1.35);
    else {
      const u = (a - ac) / (Ld * k);
      p = Math.max(0, 1 - Math.pow(Math.min(u, 1), 0.85)) * (1 - 0.12 * Math.min(u, 1));
      p = Math.max(p, 0.16 * Math.exp(-(a - ac - Ld * 0.6) / Math.max(Lt, 0.05)) * sstep(ac, ac + Ld * 0.6, a));
    }
    let y = h * p * q;
    y += ripple * Math.sin(a * 9.0 / r + ph2) * sstep(-Lu, -Lu * 0.4, a) * (1 - sstep(-Lu * 0.4, 0, a)) * q;
    return y - 0.03 * (1 - sstep(0.0, 0.08, y));
  };
  return {wx, wz, extent: {a0: -Lu * 1.25, a1: ac + Ld * 1.3 + Lt * 2.2, c0: -r * 1.45, c1: r * 1.45}, heightAt: (x, z) => hAt(x * wx + z * wz, -x * wz + z * wx), hAt};
}

/** BufferGeometry (position, normal) of the drift; local origin at the ground under the centre. Cells fully below ground are dropped. */
export function snowDriftGeometry(THREE, opts = {}) {
  const f = driftHeightField(opts), {a0, a1, c0, c1} = f.extent, r = opts.r ?? 2.5;
  const step = opts.step ?? Math.max(0.06, Math.min(0.22, r / 14));
  const na = Math.ceil((a1 - a0) / step), nc = Math.ceil((c1 - c0) / step), e = step * 0.5;
  const pos = new Float32Array((na + 1) * (nc + 1) * 3), nor = new Float32Array(pos.length), hs = new Float32Array((na + 1) * (nc + 1));
  for (let j = 0; j <= nc; j++) for (let i = 0; i <= na; i++) {
    const a = a0 + (a1 - a0) * i / na, c = c0 + (c1 - c0) * j / nc, y = f.hAt(a, c), k = j * (na + 1) + i;
    hs[k] = y;
    const dha = (f.hAt(a + e, c) - f.hAt(a - e, c)) / (2 * e), dhc = (f.hAt(a, c + e) - f.hAt(a, c - e)) / (2 * e);
    let nx = -(dha * f.wx + dhc * -f.wz), nz = -(dha * f.wz + dhc * f.wx), ny = 1;
    const l = Math.hypot(nx, ny, nz);
    pos.set([a * f.wx - c * f.wz, y, a * f.wz + c * f.wx], k * 3); nor.set([nx / l, ny / l, nz / l], k * 3);
  }
  const index = [];
  for (let j = 0; j < nc; j++) for (let i = 0; i < na; i++) {
    const k0 = j * (na + 1) + i;
    if (Math.max(hs[k0], hs[k0 + 1], hs[k0 + na + 1], hs[k0 + na + 2]) < -0.025) continue;
    const v00 = k0, v10 = k0 + 1, v01 = k0 + na + 1, v11 = k0 + na + 2;
    index.push(v00, v01, v10, v01, v11, v10);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); geo.setIndex(index);
  geo.computeBoundingSphere(); geo.name = 'kits.materials.snowDrift';
  return geo;
}

/** Steepest face of any triangle, in degrees from horizontal (heightfield drifts must stay <= ~60°). */
export function maxSlopeDegrees(geometry) {
  const p = geometry.attributes.position.array, idx = geometry.index ? geometry.index.array : null, n = idx ? idx.length : p.length / 3;
  let worst = 0;
  for (let t = 0; t < n; t += 3) {
    const [a, b, c] = idx ? [idx[t], idx[t + 1], idx[t + 2]] : [t, t + 1, t + 2];
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
    if (l > 1e-12) worst = Math.max(worst, Math.acos(Math.min(1, Math.abs(ny) / l)) * 180 / Math.PI);
  }
  return worst;
}
