export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const mix = (a, b, t) => a + (b - a) * t;
export const smooth = x => { const t = clamp(x); return t * t * (3 - 2 * t); };
export const mod = (a, n) => ((a % n) + n) % n;
export function hash(n, seed = 1) {
  let x = (n ^ seed) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}
export function curve(keys, t) {
  if (!keys.length || keys.some(k => !Number.isFinite(k[0]))) throw new Error('finite time keys required');
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (t < keys[i][0]) {
    const [a, b] = [keys[i - 1], keys[i]], u = smooth((t - a[0]) / (b[0] - a[0]));
    return Array.isArray(a[1]) ? a[1].map((v, j) => mix(v, b[1][j], u)) : mix(a[1], b[1], u);
  }
  return keys.at(-1)[1];
}
export const noise = (t, seed = 1) => mix(hash(Math.floor(t), seed), hash(Math.floor(t) + 1, seed), smooth(mod(t, 1))) * 2 - 1;
