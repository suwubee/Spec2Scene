import path from 'node:path';
import {readdir, mkdir, readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {cli, isMain, number, required} from './lib/cli.mjs';
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[c]));

export async function contactSheet(files, out, {columns = 4, width = 240, labels = []} = {}) {
  if (!files.length || files.length > 80) throw new Error('A sheet requires 1–80 images; paginate larger reviews');
  number(columns, 'columns', 1, 12, true); number(width, 'width', 64, 1024, true);
  const height = Math.round(width * 9 / 16), cellHeight = height + 30;
  const layers = [];
  for (const [i, file] of files.entries()) {
    const left = i % columns * width, top = Math.floor(i / columns) * cellHeight;
    const thumb = await sharp(file).resize(width, height, {fit: 'contain', background: '#f1f5f9'}).png().toBuffer();
    const label = Buffer.from(`<svg width="${width}" height="30"><rect width="100%" height="100%" fill="#f1f5f9"/><text x="6" y="20" font-family="sans-serif" font-size="13" fill="#152f46">${escape(labels[i] ?? path.basename(file))}</text></svg>`);
    layers.push({input: thumb, left, top}, {input: label, left, top: top + height});
  }
  await mkdir(path.dirname(out), {recursive: true});
  await sharp({create: {width: columns * width, height: Math.ceil(files.length / columns) * cellHeight,
    channels: 3, background: '#f1f5f9'}}).composite(layers).png().toFile(out);
}
if (isMain(import.meta.url)) {
  const a = cli({dir: {type: 'string'}, files: {type: 'string'}, out: {type: 'string'}, labels: {type: 'string'},
    columns: {type: 'string', default: '4'}, width: {type: 'string', default: '240'}},
  'Usage: node tools/contact-sheet.mjs (--dir DIR | --files FILE,FILE) --out SHEET.png [--labels JSON --columns 4 --width 240]\n标签 JSON 为字符串数组；最多 80 图，请分批。');
  if (a) {
    if (Boolean(a.dir) === Boolean(a.files)) throw new Error('Choose --dir or --files');
    const files = a.files ? a.files.split(',') : (await readdir(a.dir)).filter(f => /\.(png|jpe?g)$/i.test(f)).sort().map(f => path.join(a.dir, f));
    await contactSheet(files, required(a.out, 'out'), {columns: Number(a.columns), width: Number(a.width),
      labels: a.labels ? JSON.parse(await readFile(a.labels, 'utf8')) : []});
    console.log(`PASS contact-sheet images=${files.length}`);
  }
}
