// Far ranges / horizon layer: polar ridged heightfield bands that recede in layers, with snow line and bare rock, aerial
// perspective by distance and by layer, foot fog that separates the layers, and silhouette slots (ruined tower, low village).
//
//   import {createFarRanges, FAR_PRESETS} from './kits/far/index.js';
//   const far = createFarRanges(THREE, {...FAR_PRESETS.layeredArc, baseY: (x, z) => groundY(x, z), atmos});   // create() only
//   scene.add(far.object);
//   far.update({lights: [moon]});           // every sample, after the lights are final ('three' lighting convention)
//   far.update({});                          // engine atmosphere convention (atmos given, no lights): vDirect of the engine
//
// Why polar bands (README E1/E2): a square grid of 70-170 m cells with one large noise amplitude turns into flat-shaded
// triangles ("paper folds") at long focal lengths, and a band cut off vertically shows a paper edge. Here the band is
// subdivided along the ARC (5-13 m), the crest line only lives near the crest (otherwise every peak is dragged down to the
// foot = a row of vertical "curtain folds"), octaves finer than the row spacing fade to their mean, slopes steeper than
// ~42 deg are relaxed, and the band edges sink 3 m into the plain. Everything depends only on (seed, x, z): no time, no
// Math.random, geometry built once.
import {gnoise1, gnoise2} from '../../engine/noise.js';
import {layerParams, airParams, lightParams, slotParams, SNOW_COLOR_DEFAULTS} from './params.js';
import {makeFarMaterial} from './shade.js';

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };
const mix = (a, b, t) => a + (b - a) * t;
const D2R = Math.PI / 180;
/** Azimuth of a direction, degrees clockwise from north (-z); +x (east) = 90. */
export const azOf = (dx, dz) => { let a = Math.atan2(dx, -dz) / D2R; if (a < 0) a += 360; return a; };
export const angDiff = (a, b) => { let d = a - b; d -= 360 * Math.round(d / 360); return d; };

function inArc(L, az) {
  const span = ((L.az1 - L.az0) % 360 + 360) % 360 || 360;
  if (span >= 359.9) return 1;
  const a = ((az - L.az0) % 360 + 360) % 360;
  return a <= span ? smooth(0, L.edge, a) * smooth(0, L.edge, span - a) : 0;
}
// Azimuthal crest line: only two octaves. Higher azimuthal octaves dragged radially read as vertical curtain folds (E2);
// fine silhouette teeth come from the isotropic 2D ridged field instead.
function ridged1(x, seed, sharp) {
  let s = 0, amp = 1, f = 1, n = 0;
  const wx = x + 0.38 * gnoise1(x * 0.41 + seed * 1.7, seed + 9);
  for (let o = 0; o < 2; o++) { const v = 1 - Math.abs(gnoise1(wx * f + seed * 7.13 + o * 3.1, seed + o)); s += amp * Math.pow(v, sharp); n += amp; amp *= 0.45; f *= 2.17; }
  return s / n;
}
// 2D ridged multifractal with domain warp. minLam = shortest resolvable wavelength (in units of lam): finer octaves fade to
// their mean, because detail below the row spacing only becomes column-to-column normal flips = vertical stripes (E2/E3).
function ridged2(x, z, seed, sharp, oct = 5, minLam = 0) {
  const wx = x + 0.55 * gnoise2(x * 0.37 + seed * 3.1, z * 0.37 - seed);
  const wz = z + 0.55 * gnoise2(x * 0.37 - 7.7 - seed, z * 0.37 + 2.9 + seed);
  let s = 0, amp = 1, f = 1, n = 0, w = 1;
  for (let o = 0; o < oct; o++) {
    let v = Math.pow(1 - Math.abs(gnoise2(wx * f + seed * 1.37 + o * 17.1, wz * f - seed * 2.11 + o * 5.3)), sharp);
    v = mix(0.62, v, minLam > 0 ? smooth(minLam, minLam * 1.8, 1 / f) : 1);
    s += amp * v * w; n += amp; w = clamp(v * 1.6); amp *= 0.5; f *= 2.07;
  }
  return s / n;
}
function layerRelAt(L, r, az, x, z, dr = 0) {
  const k = inArc(L, az);
  if (k <= 0) return -3;
  const seed = L.seed;
  const Rc = L.R * (1 + 0.05 * gnoise1(az / 17 + seed * 3.3, seed + 20));
  const t = (r - Rc) / L.W;
  const env = t < 0 ? Math.exp(-t * t * 0.8) : Math.exp(-t * t * 1.9);     // gentle front, steeper back, smooth to zero
  const broad = 0.5 + 0.5 * gnoise1(az / (L.peakLen * 2.3) + seed * 5.1, seed + 30);
  const peak = ridged1(az / L.peakLen, seed, L.sharp);
  let Hp = mix(L.H0, L.H1, clamp(0.55 * broad + 0.62 * peak - 0.12));       // crest (peaks and saddles along azimuth)
  let Hm = mix(L.H0, L.H1, 0.3 + 0.45 * broad);                               // massif (large scale only)
  for (const g of L.gaps) { const gk = 1 - g.depth * Math.exp(-Math.pow(angDiff(az, g.az) / g.w, 2)); Hp *= gk; Hm *= gk; }
  const minLam = dr > 0 ? 2.4 * dr / L.lam : 0;
  // spurs: the envelope coordinate is displaced by a LOW-frequency ridged field (2 octaves, 2 lam); higher frequencies here
  // create vertical cliffs between neighbouring spurs
  const rmLo = ridged2(x / (L.lam * 2), z / (L.lam * 2), seed + 0.5, 1.4, 2, minLam / 2);
  const t2 = t - 0.55 * (rmLo - 0.5) * L.relief;
  const env2 = t2 < 0 ? Math.exp(-t2 * t2 * 0.8) : Math.exp(-t2 * t2 * 1.9);
  const envB = mix(env, env2, 0.75);
  const crestK = Math.exp(-Math.pow(t2 / 0.42, 2));                          // crest relief only near the crest (E2)
  const rm = ridged2(x / L.lam, z / L.lam, seed, L.sharp, 5, minLam);
  const h = Math.max(0, Hm * envB + (Hp - Hm) * crestK * envB) * k * mix(1, 0.55 + 0.7 * rm, L.relief * 0.8);
  return h - 3 * (1 - smooth(0, 6, h));                                       // band edges sink 3 m into the plain
}
/** Height of one (normalised) layer above the plain at world (x, z); negative outside the band (buried). Pure. */
export function layerRelHeight(L, cx, cz, x, z) {
  const dx = x - cx, dz = z - cz;
  return layerRelAt(L, Math.hypot(dx, dz), azOf(dx, dz), x, z);
}

/**
 * Geometry of one layer as plain typed arrays (pure, node-testable): polar grid (azimuth columns x radial rows).
 * Returns {pos, nor, far (vec4: altitude factor, foot y, layer haze, kind 0), col (crest, macro, rock), idx, nA, nR, maxSlopeDeg}.
 */
export function buildLayerArrays(layer, center = [0, 0], baseY = () => 0) {
  const L = layerParams(layer);
  const C = center;
  const span = ((L.az1 - L.az0) % 360 + 360) % 360 || 360;
  const nA = Math.max(8, Math.ceil(span * D2R * L.R / L.step) + 1), nR = L.rows;
  const tMin = -2.5, tMax = 1.7, N = nA * nR;
  const pos = new Float32Array(N * 3), far = new Float32Array(N * 4), col = new Float32Array(N * 3), nor = new Float32Array(N * 3), H = new Float32Array(N);
  for (let i = 0; i < nA; i++) {
    const az = L.az0 + span * i / (nA - 1), sa = Math.sin(az * D2R), ca = -Math.cos(az * D2R);
    const Rc = L.R * (1 + 0.05 * gnoise1(az / 17 + L.seed * 3.3, L.seed + 20));
    for (let j = 0; j < nR; j++) {
      // rows densify near the crest (cubic u -> t); dr = this row spacing -> shortest resolvable octave
      const u = j / (nR - 1), uu = u * 2 - 1;
      const tt = mix(tMin, tMax, 0.5 + 0.5 * (0.45 * uu + 0.55 * uu * uu * uu));
      const dr = (tMax - tMin) * 0.5 * (0.45 + 1.65 * uu * uu) * (2 / (nR - 1)) * L.W;
      const r = Rc + tt * L.W, x = C[0] + sa * r, z = C[1] + ca * r;
      const rel = layerRelAt(L, r, az, x, z, dr), by = baseY(x, z), q = i * nR + j;
      pos[q * 3] = x; pos[q * 3 + 1] = by + rel; pos[q * 3 + 2] = z; H[q] = rel;
      far[q * 4] = smooth(L.snowLine - 0.08, L.snowLine + 0.35, rel / Math.max(L.H1, 1));
      far[q * 4 + 1] = by; far[q * 4 + 2] = L.haze; far[q * 4 + 3] = 0;
      col[q * 3] = ridged2(x / L.lam, z / L.lam, L.seed, L.sharp, 5, 2.4 * dr / L.lam);   // crest-ness (wind-scoured rock)
      col[q * 3 + 1] = 0.5 + 0.5 * gnoise2(x / 1400 + L.seed, z / 1400 - L.seed);         // 1.4 km albedo blocks
      col[q * 3 + 2] = L.rock;
    }
  }
  // slope limit (~42 deg): relax steep vertices towards their 4 neighbours; distant ranges never show vertical walls
  for (let it = 0; it < 4; it++) for (let i = 1; i < nA - 1; i++) for (let j = 1; j < nR - 1; j++) {
    const q = i * nR + j;
    let worst = 0, avg = 0;
    for (const p of [(i - 1) * nR + j, (i + 1) * nR + j, q - 1, q + 1]) {
      const dxy = Math.hypot(pos[p * 3] - pos[q * 3], pos[p * 3 + 2] - pos[q * 3 + 2]) || 1;
      worst = Math.max(worst, Math.abs(pos[p * 3 + 1] - pos[q * 3 + 1]) / dxy); avg += pos[p * 3 + 1] / 4;
    }
    if (worst > 0.9) { pos[q * 3 + 1] = mix(pos[q * 3 + 1], avg, clamp((worst - 0.9) / 0.6) * 0.6); H[q] = pos[q * 3 + 1] - far[q * 4 + 1]; }
  }
  // normals: finite differences on the grid, always pointing up (never zero: E5)
  for (let i = 0; i < nA; i++) for (let j = 0; j < nR; j++) {
    const q = i * nR + j, qa = Math.max(0, i - 1) * nR + j, qb = Math.min(nA - 1, i + 1) * nR + j, qc = i * nR + Math.max(0, j - 1), qd = i * nR + Math.min(nR - 1, j + 1);
    const ex = [pos[qb * 3] - pos[qa * 3], pos[qb * 3 + 1] - pos[qa * 3 + 1], pos[qb * 3 + 2] - pos[qa * 3 + 2]];
    const ey = [pos[qd * 3] - pos[qc * 3], pos[qd * 3 + 1] - pos[qc * 3 + 1], pos[qd * 3 + 2] - pos[qc * 3 + 2]];
    let n = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
    if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
    const l = Math.hypot(n[0], n[1], n[2]);
    if (!(l > 1e-12)) n = [0, 1, 0]; else n = [n[0] / l, n[1] / l, n[2] / l];
    nor[q * 3] = n[0]; nor[q * 3 + 1] = n[1]; nor[q * 3 + 2] = n[2];
  }
  const idx = [];
  let maxSlope = 0;
  for (let i = 0; i < nA - 1; i++) for (let j = 0; j < nR - 1; j++) {
    const a = i * nR + j, b = (i + 1) * nR + j, c = a + 1, d = b + 1;
    if (Math.max(H[a], H[b], H[c], H[d]) < -2.5) continue;                      // fully buried cells are dropped
    idx.push(a, c, b, b, c, d);
    for (const [p, q2] of [[a, b], [a, c]]) {
      const run = Math.hypot(pos[q2 * 3] - pos[p * 3], pos[q2 * 3 + 2] - pos[p * 3 + 2]) || 1;
      maxSlope = Math.max(maxSlope, Math.atan(Math.abs(pos[q2 * 3 + 1] - pos[p * 3 + 1]) / run) / D2R);
    }
  }
  return {pos, nor, far, col, idx: nA * nR > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), nA, nR, verts: N, maxSlopeDeg: maxSlope};
}

/** Silhouette slot geometry: ruined rammed tower (beacon) on a crest, or a low flat-roofed village on the plain in front. */
export function slotArrays(S, at) {
  const P = [], N = [], F = [], Cc = [], I = [];
  const V = (p, n, f, c) => { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); F.push(...f); Cc.push(c[0], c[1], c[2]); return P.length / 3 - 1; };
  const quad = (a, b, c, d, n, f, col) => { const i0 = V(a, n, f, col), i1 = V(b, n, f, col), i2 = V(c, n, f, col), i3 = V(d, n, f, col); I.push(i0, i1, i2, i0, i2, i3); };
  const box = (cx, y0, cz, w, d, h, yaw, wallCol, topK, foot, taper = 1, topJag = 0, seed = 0) => {
    const c = Math.cos(yaw), s = Math.sin(yaw), y1 = y0 + h;
    const P0 = (sx, sz, y, k) => [cx + (sx * w / 2 * c - sz * d / 2 * s) * k, y, cz + (sx * w / 2 * s + sz * d / 2 * c) * k];
    const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    const tops = corners.map((q, k) => y1 - topJag * (0.5 + 0.5 * Math.sin(seed * 3.7 + k * 2.1)));
    for (let k = 0; k < 4; k++) {
      const q0 = corners[k], q1 = corners[(k + 1) % 4];
      const a = P0(q0[0], q0[1], y0, 1), b = P0(q1[0], q1[1], y0, 1), bt = P0(q1[0], q1[1], tops[(k + 1) % 4], taper), at2 = P0(q0[0], q0[1], tops[k], taper);
      const ex = b[0] - a[0], ez = b[2] - a[2], el = Math.hypot(ex, ez) || 1;
      quad(a, b, bt, at2, [ez / el, 0.12, -ex / el], [0.05, foot, 0, 1], wallCol);
    }
    const tp = corners.map((q, k) => P0(q[0], q[1], tops[k] + 0.02, taper));
    quad(tp[3], tp[2], tp[1], tp[0], [0, 1, 0], [0.9, foot, 0, 2], [topK, topK, topK]);
  };
  if (S.kind === 'beacon') {
    const b = S.base ?? 7, h = S.h ?? 9, earth = [0.105, 0.085, 0.064];
    box(at[0], at[1] - 1.5, at[2], b, b, h + 1.5, S.yaw ?? 0.3, earth, 0.75, at[1], 0.62, h * 0.12, S.az ?? 0);
    box(at[0], at[1] - 1.5, at[2], b * 1.8, b * 1.6, 2.2, (S.yaw ?? 0.3) + 0.2, earth, 0.75, at[1], 0.8, 0.4, (S.az ?? 0) + 1);   // slumped base
  } else {
    const n = S.n ?? 7, spread = S.spread ?? 60;
    for (let k = 0; k < n; k++) {
      const a = (k * 2.399 + (S.az ?? 0) * 0.1) % (Math.PI * 2), rr = spread * Math.sqrt((k + 0.5) / n);
      const w = 7 + 4 * (0.5 + 0.5 * Math.sin(k * 7.3)), d = 5 + 2 * (0.5 + 0.5 * Math.cos(k * 3.1)), h = 3.2 + 0.8 * (0.5 + 0.5 * Math.sin(k * 1.9));
      box(at[0] + Math.cos(a) * rr, at[1] - 1, at[2] + Math.sin(a) * rr * 0.7, w, d, h + 1, k * 0.37, [0.07, 0.06, 0.05], 0.8, at[1], 1, 0, k);
    }
  }
  return {pos: new Float32Array(P), nor: new Float32Array(N), far: new Float32Array(F), col: new Float32Array(Cc), idx: P.length / 3 > 65535 ? new Uint32Array(I) : new Uint16Array(I)};
}

/** Normalised options (validated). Exposed for tests and for callers that want geometry without THREE. */
export function farOptions(opts = {}) {
  if (!Array.isArray(opts.layers) || !opts.layers.length) throw new RangeError('far ranges need layers:[...] (see FAR_PRESETS)');
  const layers = opts.layers.map((l, i) => layerParams(l, `layers[${i}]`));
  const center = opts.center || [0, 0];
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) throw new RangeError('center must be [x, z]');
  const baseY = typeof opts.baseY === 'function' ? opts.baseY : (() => opts.baseY ?? 0);
  const slots = (opts.slots || []).map((s, i) => slotParams(s, layers, i));
  return {layers, center, baseY, slots, air: airParams(opts.air), light: lightParams(opts.light), snow: {...SNOW_COLOR_DEFAULTS, ...(opts.snow || {})}};
}
/** Crest point of a layer at an azimuth (world [x, y, z]). Pure. */
export function crestAt(o, li, az) {
  const L = o.layers[li], C = o.center, sa = Math.sin(az * D2R), ca = -Math.cos(az * D2R);
  let best = null;
  for (let r = L.R - L.W * 1.2; r <= L.R + L.W * 0.8; r += Math.max(4, L.W / 60)) {
    const x = C[0] + sa * r, z = C[1] + ca * r, h = layerRelHeight(L, C[0], C[1], x, z);
    if (!best || h > best.h) best = {x, z, h};
  }
  return [best.x, o.baseY(best.x, best.z) + best.h, best.z];
}
export function slotPosition(o, S) {
  if (S.pos) return [S.pos[0], S.pos[1] ?? o.baseY(S.pos[0], S.pos[2]), S.pos[2]];
  if (S.kind === 'beacon') return crestAt(o, S.layer ?? 0, S.az);
  const L = o.layers[S.layer ?? 0], r = S.r ?? (L.R - 1.7 * L.W);
  const x = o.center[0] + Math.sin(S.az * D2R) * r, z = o.center[1] - Math.cos(S.az * D2R) * r;
  return [x, o.baseY(x, z) + Math.max(0, layerRelHeight(L, o.center[0], o.center[1], x, z)), z];
}

/**
 * createFarRanges(THREE, opts) -> {object, meshes, material, layers, slots, stats, heightAt(x,z), crestAt(layer,az), update(extra), dispose()}
 * opts: {center:[x,z], layers:[...], baseY:(x,z)=>y | number, air:{vis,strength,footH,foot}, snow:{col,rockCol},
 *        light:{gain,ambient,subsurface,airGlow}, slots:[{kind:'beacon'|'village', layer, az, h, base, pos?}], atmos?}
 * atmos = the engine atmosphere ({glsl, uniforms} from createAtmosphere) -> same aerial perspective as the rest of the scene;
 * without atmos the material uses its own exponential haze towards opts.horizon / sky colours (stand-alone three.js scenes).
 */
export function createFarRanges(THREE, opts = {}) {
  const o = farOptions(opts);
  const material = makeFarMaterial(THREE, {atmos: opts.atmos, air: o.air, snow: o.snow, light: o.light, sky: opts.sky});
  const group = new THREE.Group(); group.name = 'kits.far.ranges';
  const meshes = [];
  let verts = 0, maxSlopeDeg = 0;
  const mk = (G, name, order) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(G.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(G.nor, 3));
    g.setAttribute('aFar', new THREE.BufferAttribute(G.far, 4));
    g.setAttribute('color', new THREE.BufferAttribute(G.col, 3));
    g.setIndex(new THREE.BufferAttribute(G.idx, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    const m = new THREE.Mesh(g, material); m.name = name; m.renderOrder = order; m.frustumCulled = true;
    group.add(m); meshes.push(m); verts += G.pos.length / 3;
  };
  const order = o.layers.map((L, i) => i).sort((a, b) => o.layers[b].R - o.layers[a].R);   // far -> near (overdraw only)
  for (const li of order) { const G = buildLayerArrays(o.layers[li], o.center, o.baseY); maxSlopeDeg = Math.max(maxSlopeDeg, G.maxSlopeDeg); mk(G, 'kits.far.layer' + li, -10 + li); }
  const slots = [];
  if (o.slots.length) {
    const parts = o.slots.map((S) => { const at = slotPosition(o, S); slots.push({...S, at}); return slotArrays(S, at); });
    const cat = (k, T) => { const n = parts.reduce((s, p) => s + p[k].length, 0), out = new T(n); let off = 0; for (const p of parts) { out.set(p[k], off); off += p[k].length; } return out; };
    const nV = parts.reduce((s, p) => s + p.pos.length / 3, 0), idx = [];
    let base = 0; for (const p of parts) { for (const v of p.idx) idx.push(v + base); base += p.pos.length / 3; }
    mk({pos: cat('pos', Float32Array), nor: cat('nor', Float32Array), far: cat('far', Float32Array), col: cat('col', Float32Array), idx: nV > 65535 ? new Uint32Array(idx) : new Uint16Array(idx)}, 'kits.far.slots', 0);
  }
  const heightAt = (x, z) => { let h = -1e9; for (const L of o.layers) h = Math.max(h, layerRelHeight(L, o.center[0], o.center[1], x, z)); return o.baseY(x, z) + h; };
  return {
    object: group, meshes, material, slots, layers: o.layers, heightAt, crestAt: (li, az) => crestAt(o, li, az),
    stats: {verts, layers: o.layers.length, maxSlopeDeg},
    /** extra: {lights:[DirectionalLight, DirectionalLight?] ('three' convention), gain, ambient, airGlow, air:{...}} */
    update(extra = {}) { material.userData.farUpdate(extra); },
    dispose() { for (const m of meshes) m.geometry.dispose(); material.dispose(); },
  };
}
