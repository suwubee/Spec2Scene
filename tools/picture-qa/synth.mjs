// Synthetic regression frames for picture-qa. Every sample is generated from a declarative JSON scene (samples.json):
// no rendered film frame, photo or image file is stored anywhere. Deterministic (integer hash noise, fixed seeds).
//
// scene = { w=960, h=402, seed, sky: false | {horizon, top:[r,g,b], bottom:[r,g,b]}, ground: {color:[r,g,b], amp, scale, gradient},
//           layers: [ ... ], grain: sigma in 1/255 }
// layers (applied in order):
//   {type:'stripes', rect, period, angle, amp}         straight sinusoidal lines (angle = line direction in degrees, 90 = vertical)
//   {type:'flat', rect, color}                         untextured polygon (flat shading)
//   {type:'figure', cx, foot, height, color, halo:{width, gain, color}}   dark silhouette with optional bright outer ring
//   {type:'blob', cx, cy, rx, ry, amp, color}          soft additive blob (cloud, glow)
//   {type:'streak', cx, cy, len, thick, amp, angle}    thin elongated additive streak (cirrus)
//   {type:'disk', cx, cy, r, color}                    hard disk (moon / lamp core)
//   {type:'fog', level, k}                             global veil: v = v*(1-k) + level*k
//   {type:'tint', rect, color, k}                      blend a colour over a rect (warm light pools etc.)
// All positions are normalised 0..1 of width/height; sizes in normalised height unless noted.

function hash32(x, y, s) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0; h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const fade = (t) => t * t * (3 - 2 * t);
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = fade(x - xi), fy = fade(y - yi);
  const a = hash32(xi, yi, s), b = hash32(xi + 1, yi, s), c = hash32(xi, yi + 1, s), d = hash32(xi + 1, yi + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
/** Isotropic value-noise fbm in pixels; base = largest feature size (px). Returns roughly −0.5..0.5. */
export function fbm(x, y, base, seed, octaves = 5) {
  let s = 0, n = 0, f = 1 / base, a = 1;
  for (let o = 0; o < octaves; o++) { s += a * (vnoise(x * f + o * 17.3, y * f - o * 9.1, seed + o * 101) - 0.5); n += a; f *= 2.03; a *= 0.55; }
  return s / n;
}
const inRect = (u, v, r) => u >= r[0] && u <= r[2] && v >= r[1] && v <= r[3];

export function renderScene(scene = {}) {
  const w = scene.w || 960, h = scene.h || 402, seed = scene.seed ?? 1, n = w * h;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  const sky = scene.sky === false ? null : {horizon: 0.36, top: [0.012, 0.018, 0.045], bottom: [0.075, 0.095, 0.15], ...(scene.sky || {})};
  const ground = {color: [0.24, 0.27, 0.33], amp: 0.5, scale: 90, gradient: 0.35, ...(scene.ground || {})};
  const hz = sky ? Math.round(sky.horizon * h) : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (sky && y < hz) {
      const t = y / Math.max(1, hz - 1);
      R[i] = sky.top[0] + (sky.bottom[0] - sky.top[0]) * t; G[i] = sky.top[1] + (sky.bottom[1] - sky.top[1]) * t; B[i] = sky.top[2] + (sky.bottom[2] - sky.top[2]) * t;
    } else {
      const d = (y - hz) / Math.max(1, h - hz);                       // 0 at horizon .. 1 at bottom
      const k = (1 + ground.gradient * (0.5 - d)) * (1 + ground.amp * (fbm(x, y * 1.6, ground.scale, seed) + 0.5 * fbm(x, y, ground.scale / 6, seed + 7)));
      R[i] = ground.color[0] * k; G[i] = ground.color[1] * k; B[i] = ground.color[2] * k;
    }
  }
  const add = (i, c, a) => { R[i] += c[0] * a; G[i] += c[1] * a; B[i] += c[2] * a; };
  const set = (i, c) => { R[i] = c[0]; G[i] = c[1]; B[i] = c[2]; };
  for (const L of scene.layers || []) {
    if (L.type === 'stripes') {
      const th = (L.angle ?? 90) * Math.PI / 180, nx = -Math.sin(th), ny = Math.cos(th);   // normal to the line direction
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!inRect(x / w, y / h, L.rect)) continue;
        const s = Math.sin(2 * Math.PI * (x * nx + y * ny) / L.period), i = y * w + x, k = 1 + L.amp * s / Math.max(0.02, 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i]);
        R[i] *= k; G[i] *= k; B[i] *= k;
      }
    } else if (L.type === 'flat') {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inRect(x / w, y / h, L.rect)) set(y * w + x, L.color);
    } else if (L.type === 'tint') {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inRect(x / w, y / h, L.rect)) { const i = y * w + x, k = L.k ?? 1; R[i] += (L.color[0] - R[i]) * k; G[i] += (L.color[1] - G[i]) * k; B[i] += (L.color[2] - B[i]) * k; }
    } else if (L.type === 'figure') {
      const H = L.height * h, cx = L.cx * w, foot = L.foot * h, inside = new Uint8Array(n);
      const head = {x: cx, y: foot - H * 0.9, r: H * 0.085};
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = (foot - y) / H;                                       // 0 at feet .. 1 at top
        const halfW = v >= 0 && v <= 0.82 ? H * (0.2 - 0.12 * v) : -1;  // A-shaped cloak
        if ((halfW > 0 && Math.abs(x - cx) <= halfW) || Math.hypot(x - head.x, y - head.y) <= head.r) inside[y * w + x] = 1;
      }
      const halo = L.halo, ring = halo ? Math.ceil(halo.width) : 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (inside[i]) { set(i, L.color || [0.012, 0.013, 0.016]); continue; }
        if (!ring) continue;
        let near = false;
        for (let dy = -ring; dy <= ring && !near; dy++) for (let dx = -ring; dx <= ring; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && inside[yy * w + xx] && dx * dx + dy * dy <= halo.width * halo.width) { near = true; break; } }
        if (near) add(i, halo.color || [0.85, 0.92, 1.0], halo.gain);
      }
    } else if (L.type === 'blob') {
      const cx = L.cx * w, cy = L.cy * h, rx = L.rx * h, ry = (L.ry ?? L.rx) * h, c = L.color || [1, 1, 1];
      for (let y = Math.max(0, Math.floor(cy - 3 * ry)); y < Math.min(h, cy + 3 * ry); y++) for (let x = Math.max(0, Math.floor(cx - 3 * rx)); x < Math.min(w, cx + 3 * rx); x++) {
        const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2; add(y * w + x, c, L.amp * Math.exp(-e));
      }
    } else if (L.type === 'streak') {
      const cx = L.cx * w, cy = L.cy * h, len = L.len * w, th = (L.angle ?? 0) * Math.PI / 180, ux = Math.cos(th), uy = Math.sin(th), thick = L.thick * h;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dx = x - cx, dy = y - cy, a = dx * ux + dy * uy, b = -dx * uy + dy * ux;
        if (Math.abs(a) > len) continue;
        add(y * w + x, [1, 1, 1], L.amp * Math.exp(-((b / thick) ** 2)) * (1 - (a / len) ** 2));
      }
    } else if (L.type === 'disk') {
      const cx = L.cx * w, cy = L.cy * h, r = L.r * h;
      for (let y = Math.max(0, Math.floor(cy - r - 1)); y < Math.min(h, cy + r + 1); y++) for (let x = Math.max(0, Math.floor(cx - r - 1)); x < Math.min(w, cx + r + 1); x++) if (Math.hypot(x - cx, y - cy) <= r) set(y * w + x, L.color || [0.95, 0.95, 0.9]);
    } else if (L.type === 'fog') {
      for (let i = 0; i < n; i++) { R[i] += (L.level - R[i]) * L.k; G[i] += (L.level - G[i]) * L.k; B[i] += (L.level * 1.08 - B[i]) * L.k; }
    } else throw new Error(`unknown synthetic layer: ${L.type}`);
  }
  const g = (scene.grain ?? 1.6) / 255;
  for (let i = 0; i < n; i++) {
    const e = g * (hash32(i, 3, seed + 991) + hash32(i, 5, seed + 977) + hash32(i, 7, seed + 953) - 1.5) * 2;   // ≈ gaussian, σ ≈ g
    R[i] = Math.round(Math.min(1, Math.max(0, R[i] + e)) * 255) / 255;
    G[i] = Math.round(Math.min(1, Math.max(0, G[i] + e)) * 255) / 255;
    B[i] = Math.round(Math.min(1, Math.max(0, B[i] + e)) * 255) / 255;
  }
  return {w, h, R, G, B};
}
