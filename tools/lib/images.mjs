import sharp from 'sharp';
import {createHash} from 'node:crypto';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const linear = x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
export function luminance(r, g, b) { return 0.2126 * linear(r / 255) + 0.7152 * linear(g / 255) + 0.0722 * linear(b / 255); }
export const lightness = y => y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : y * (24389 / 27);
export function intersects(a, b) {
  return Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
}
export async function pixels(input) {
  return sharp(input).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject: true});
}
export async function imageStats(input) {
  const {data, info} = await pixels(input);
  let sum = 0, black = 0;
  const bins = new Set();
  for (let i = 0; i < data.length; i += 3) {
    const y = luminance(data[i], data[i + 1], data[i + 2]);
    sum += lightness(y);
    if (y < 0.003) black++;
    bins.add(Math.round((data[i] + data[i + 1] + data[i + 2]) / 3));
  }
  return {width: info.width, height: info.height, meanLstar: sum / (info.width * info.height),
    blackFraction: black / (info.width * info.height), grayLevels: bins.size, pixelHash: sha256(data)};
}
