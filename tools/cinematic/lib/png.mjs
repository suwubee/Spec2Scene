// Author: suwubee
// Minimal, fast PNG encoder for RGBA readPixels buffers (drops alpha, optional vertical flip).
// Filtering runs in JS (~5-10 ms for 1920x1080), deflate runs in libuv's thread pool (async) so it
// overlaps with rendering of the next frame. Measured choice (1920x1080 grainy frame): filter 'sub' + level 1
// = best size/speed (2.5 MB, ~70 ms deflate); see tools/cinematic/README.md.
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FILTERS = { none: 0, sub: 1, up: 2, avg: 3, paeth: 4 };

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(data, zlib.crc32(head.subarray(4, 8))) >>> 0, 0);
  return [head, data, crc];
}

/**
 * RGBA (w*h*4) -> PNG scanlines (RGB, 1 filter byte per row).
 * @param {Uint8Array} src  RGBA pixels
 * @param {boolean} flip   true for GL readPixels (bottom-up rows)
 * @param {'none'|'sub'|'up'|'avg'|'paeth'} filter
 */
export function filterRGBA(src, w, h, flip = true, filter = 'sub') {
  const ft = FILTERS[filter] ?? 1;
  const stride = w * 3;
  const out = Buffer.allocUnsafe(h * (stride + 1));
  if (src.byteOffset % 4) src = new Uint8Array(src); // need 4-byte alignment for the 32-bit view
  const s32 = new Uint32Array(src.buffer, src.byteOffset, w * h);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride); // used by up/avg/paeth
  for (let y = 0; y < h; y++) {
    let si = (flip ? h - 1 - y : y) * w;
    let o = y * (stride + 1);
    out[o++] = ft;
    if (ft === 0 || ft === 1) {
      let pr = 0, pg = 0, pb = 0;
      const sub = ft === 1;
      for (let x = 0; x < w; x++) {
        const v = s32[si++];
        const r = v & 255, g = (v >>> 8) & 255, b = (v >>> 16) & 255;
        if (sub) { out[o] = r - pr; out[o + 1] = g - pg; out[o + 2] = b - pb; pr = r; pg = g; pb = b; }
        else { out[o] = r; out[o + 1] = g; out[o + 2] = b; }
        o += 3;
      }
      continue;
    }
    for (let di = 0; di < stride; di += 3) {
      const v = s32[si++];
      cur[di] = v & 255; cur[di + 1] = (v >>> 8) & 255; cur[di + 2] = (v >>> 16) & 255;
    }
    if (ft === 2) {
      for (let i = 0; i < stride; i++) out[o + i] = cur[i] - prev[i];
    } else if (ft === 3) {
      for (let i = 0; i < 3; i++) out[o + i] = cur[i] - (prev[i] >> 1);
      for (let i = 3; i < stride; i++) out[o + i] = cur[i] - ((cur[i - 3] + prev[i]) >> 1);
    } else {
      for (let i = 0; i < 3; i++) out[o + i] = cur[i] - prev[i];
      for (let i = 3; i < stride; i++) {
        const a = cur[i - 3], b = prev[i], c = prev[i - 3];
        const p = a + b - c;
        const pa = p > a ? p - a : a - p, pb = p > b ? p - b : b - p, pc = p > c ? p - c : c - p;
        out[o + i] = cur[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
    }
    const t = prev; prev = cur; cur = t;
  }
  return out;
}

function assemble(w, h, idat) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB, no interlace
  const srgb = Buffer.from([0]); // sRGB chunk, perceptual intent
  return Buffer.concat([SIG, ...chunk('IHDR', ihdr), ...chunk('sRGB', srgb), ...chunk('IDAT', idat), ...chunk('IEND', Buffer.alloc(0))]);
}

const zopts = (raw, level, strategy) => ({ level, memLevel: 9, strategy, chunkSize: Math.max(1 << 16, raw.length + (raw.length >> 6) + 4096) });

/** Async encode (deflate in the libuv pool; one big output chunk => a single callback). */
export function encodePNG(rgba, w, h, { flip = true, filter = 'sub', level = 1, strategy = zlib.constants.Z_DEFAULT_STRATEGY } = {}) {
  const raw = filterRGBA(rgba, w, h, flip, filter);
  return new Promise((resolve, reject) => {
    zlib.deflate(raw, zopts(raw, level, strategy), (err, idat) => (err ? reject(err) : resolve(assemble(w, h, idat))));
  });
}

export function encodePNGSync(rgba, w, h, { flip = true, filter = 'sub', level = 1, strategy = zlib.constants.Z_DEFAULT_STRATEGY } = {}) {
  const raw = filterRGBA(rgba, w, h, flip, filter);
  return assemble(w, h, zlib.deflateSync(raw, zopts(raw, level, strategy)));
}

/** Cheap completeness check of a PNG file buffer tail/head (signature + IEND). */
export function looksLikeCompletePNG(head8, tail12) {
  return head8.equals(SIG) && tail12.subarray(4, 8).toString('latin1') === 'IEND';
}
