// Pure-JS PNG codec for picture-qa (node:zlib only; no sharp, no model, no GPU).
// decodePNG(buffer) -> {w, h, R, G, B} with Float32 channels in encoded 0..1 (sRGB-encoded values, not linearised).
// encodePNG(rgba, w, h) -> Buffer (8-bit RGBA, filter 0).
import zlib from 'node:zlib';

export function decodePNG(buf, name = 'image') {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`not a PNG: ${name}`);
  let p = 8, w, h, bd, ct, il, palette = null, trns = null;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; il = d[12]; }
    else if (type === 'PLTE') palette = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!w || !h) throw new Error(`PNG without IHDR: ${name}`);
  if (il) throw new Error(`interlaced PNG not supported: ${name}`);
  const ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct];
  if (!ch) throw new Error(`unsupported PNG colour type ${ct}: ${name}`);
  if (ct === 3 ? ![1, 2, 4, 8].includes(bd) : ![8, 16].includes(bd)) throw new Error(`unsupported PNG bit depth ${bd}: ${name}`);
  const bitsPP = ch * bd, bpp = Math.max(1, bitsPP >> 3), stride = Math.ceil(w * bitsPP / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < h * (stride + 1)) throw new Error(`truncated PNG data: ${name}`);
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++], line = raw.subarray(pos, pos + stride); pos += stride;
    const o = y * stride, po = o - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0, b = y > 0 ? out[po + x] : 0, c = x >= bpp && y > 0 ? out[po + x - bpp] : 0;
      let v;
      if (f === 0) v = line[x]; else if (f === 1) v = line[x] + a; else if (f === 2) v = line[x] + b; else if (f === 3) v = line[x] + ((a + b) >> 1);
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else throw new Error(`bad PNG filter ${f}: ${name}`);
      out[o + x] = v & 255;
    }
  }
  const n = w * h, R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), k = 1 / 255;
  if (ct === 3) {
    if (!palette) throw new Error(`palette PNG without PLTE: ${name}`);
    const per = 8 / bd, mask = (1 << bd) - 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const byte = out[y * stride + Math.floor(x / per)], idx = (byte >> (8 - bd * (x % per + 1))) & mask, i = y * w + x;
      R[i] = palette[idx * 3] * k; G[i] = palette[idx * 3 + 1] * k; B[i] = palette[idx * 3 + 2] * k;
    }
    void trns;
  } else {
    const s8 = bd === 16 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const o = i * bpp;
      if (ch >= 3) { R[i] = out[o] * k; G[i] = out[o + s8] * k; B[i] = out[o + 2 * s8] * k; }
      else R[i] = G[i] = B[i] = out[o] * k;
    }
  }
  return {w, h, R, G, B};
}

const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** rgba: Uint8Array/Buffer of w*h*4 bytes, top row first. Deterministic output (fixed zlib level). */
export function encodePNG(rgba, w, h) {
  if (rgba.length !== w * h * 4) throw new Error('encodePNG: rgba length must be w*h*4');
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, {level: 6})), chunk('IEND', Buffer.alloc(0))]);
}
/** Float channel image {w,h,R,G,B} (0..1) -> PNG buffer. */
export function imageToPNG(img) {
  const n = img.w * img.h, rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) { rgba[i * 4] = Math.round(Math.min(1, Math.max(0, img.R[i])) * 255); rgba[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, img.G[i])) * 255); rgba[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, img.B[i])) * 255); rgba[i * 4 + 3] = 255; }
  return encodePNG(rgba, img.w, img.h);
}
