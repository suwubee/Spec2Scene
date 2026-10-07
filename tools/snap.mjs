import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import sharp from 'sharp';
import {cli, isMain, atomic, number, required} from './lib/cli.mjs';
import {browser, prepare, auditPage} from './lib/browser.mjs';
import {imageStats, intersects} from './lib/images.mjs';

export async function snap({url, out, viewports = '1920x1080,1366x768,390x844', selectors = '', lstar = false, roi, time}) {
  required(url, 'url'); required(out, 'out');
  await mkdir(out, {recursive: true});
  const session = await browser();
  const reports = [];
  try {
    for (const viewport of viewports.split(',')) {
      const [width, height] = viewport.split('x').map(Number);
      number(width, 'width', 100, 8192, true); number(height, 'height', 100, 8192, true);
      const page = await session.newPage({viewport: {width, height}, deviceScaleFactor: 1});
      const check = auditPage(page);
      await prepare(page, url);
      if (time !== undefined) await page.evaluate(async t => { await window.__scene.seek(t); }, Number(time));
      const boxes = [];
      for (const selector of selectors.split(',').filter(Boolean)) {
        const locator = page.locator(selector);
        if (await locator.count() !== 1) throw new Error(`Missing or ambiguous selector: ${selector}`);
        const box = await locator.boundingBox();
        if (!box) throw new Error(`Missing/hidden selector: ${selector}`);
        boxes.push({selector, ...box});
      }
      const overlaps = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        if (intersects(boxes[i], boxes[j])) overlaps.push([boxes[i].selector, boxes[j].selector]);
      }
      const overflow = boxes.filter(b => b.x < 0 || b.y < 0 || b.x + b.width > width + 0.5 || b.y + b.height > height + 0.5);
      const png = await page.screenshot({path: path.join(out, `${viewport}.png`), animations: 'disabled'});
      let region = png;
      if (roi) {
        const [left, top, w, h] = roi.split(',').map(Number);
        region = await sharp(png).extract({left, top, width: w, height: h}).png().toBuffer();
      }
      reports.push({viewport, boxes, overlaps, overflow, ...(lstar ? {image: await imageStats(region)} : {})});
      check();
      await page.close();
    }
    await atomic(path.join(out, 'snap.json'), JSON.stringify(reports, null, 2));
    return reports;
  } finally { await session.close(); }
}
if (isMain(import.meta.url)) {
  const a = cli({url: {type: 'string'}, out: {type: 'string'}, viewports: {type: 'string'}, selectors: {type: 'string'},
    lstar: {type: 'boolean'}, roi: {type: 'string'}, time: {type: 'string'}},
  'Usage: node tools/snap.mjs --url URL --out DIR [--viewports 1920x1080,1366x768,390x844 --selectors SELECTOR,SELECTOR --lstar --roi x,y,w,h --time SECONDS]\n所选元素逐对检查相交，隐藏/缺失也失败；ROI 亮度为 CIE L*。');
  if (a) {
    const reports = await snap(a);
    console.log(JSON.stringify(reports, null, 2));
    if (reports.some(r => r.overlaps.length || r.overflow.length)) process.exitCode = 1;
  }
}
