import path from 'node:path';
import {readFile, mkdir} from 'node:fs/promises';
import {cli, isMain, required, number, atomic} from './lib/cli.mjs';
import {browser, prepare, sceneReady, auditPage} from './lib/browser.mjs';
import {sha256, pixels} from './lib/images.mjs';

export async function renderFrames(options) {
  const {url, out, identity, fps = 24, start = 0, count = 24, width = 640, height = 360,
    workers = 1, resume = false, reverse = false} = options;
  required(url, 'url'); required(out, 'out'); required(identity, 'identity');
  number(fps, 'fps', 1, 240); number(start, 'start', 0, 1e8, true); number(count, 'count', 1, 1e8, true);
  number(workers, 'workers', 1, 4, true); number(width, 'width', 16, 8192, true); number(height, 'height', 16, 8192, true);
  const config = {url, identity, fps, start, count, width, height};
  const manifestPath = path.join(out, 'render.json');
  await mkdir(out, {recursive: true});
  let prior;
  try { prior = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (prior && (!resume || JSON.stringify(prior.config) !== JSON.stringify(config))) {
    throw new Error('Existing render: use a new directory or matching --resume configuration');
  }
  const session = await browser();
  const backend = {browser: session.version(), executable: process.env.SCENE_CHROMIUM || 'playwright-chromium', softwareGL: process.env.SCENE_SOFTWARE_GL === '1'};
  if (prior && JSON.stringify(prior.backend) !== JSON.stringify(backend)) {
    await session.close();
    throw new Error('Render backend changed');
  }
  const manifest = {config, backend, frames: {...prior?.frames}};
  const queue = Array.from({length: count}, (_, i) => i + start);
  if (reverse) queue.reverse();
  let next = 0, failed;
  // A single writer serializes the manifest while workers own distinct frame files.
  let pending = atomic(manifestPath, JSON.stringify(manifest, null, 2));
  try {
    await Promise.all(Array.from({length: workers}, async () => {
      const page = await session.newPage({viewport: {width, height}, deviceScaleFactor: 1});
      const check = auditPage(page);
      await prepare(page, url);
      await sceneReady(page);
      await page.evaluate(({width,height}) => window.__scene.resize?.(width,height), {width,height});
      try {
        while (next < queue.length && !failed) {
          const frame = queue[next++];
          const name = `frame-${String(frame).padStart(6, '0')}.png`;
          const dest = path.join(out, name);
          if (resume && manifest.frames[name]) {
            try {
              const saved = await readFile(dest);
              await pixels(saved); // Decode too: a hash alone does not prove a valid frame.
              if (sha256(saved) === manifest.frames[name].sha256) continue;
            } catch { /* A missing/corrupt frame is rerendered. */ }
          }
          let png;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const encoded = await page.evaluate(async ({time, reverse}) => {
                if (reverse) await window.__scene.seek(time + 0.371);
                await window.__scene.seek(time);
                const canvas = window.__scene.canvas;
                if (!(canvas instanceof HTMLCanvasElement)) throw new Error('__scene.canvas is required');
                return canvas.toDataURL('image/png').split(',')[1];
              }, {time: frame / fps, reverse});
              png = Buffer.from(encoded, 'base64');
              await pixels(png);
              check();
              break;
            } catch (error) {
              if (attempt === 2) throw error;
              await page.reload({waitUntil: 'networkidle'});
              await sceneReady(page);
              await page.evaluate(({width,height}) => window.__scene.resize?.(width,height), {width,height});
            }
          }
          await atomic(dest, png);
          manifest.frames[name] = {frame, time: frame / fps, sha256: sha256(png)};
          pending = pending.then(() => atomic(manifestPath, JSON.stringify(manifest, null, 2)));
          await pending;
        }
      } catch (error) { failed = error; throw error; }
      finally { await page.close(); }
    }));
    await pending;
    if (Object.keys(manifest.frames).length !== count) throw new Error('Incomplete render');
    return manifest;
  } finally { await session.close(); }
}

if (isMain(import.meta.url)) {
  const options = cli({url: {type: 'string'}, out: {type: 'string'}, identity: {type: 'string'},
    fps: {type: 'string', default: '24'}, start: {type: 'string', default: '0'}, count: {type: 'string', default: '24'},
    width: {type: 'string', default: '640'}, height: {type: 'string', default: '360'},
    workers: {type: 'string', default: '1'}, resume: {type: 'boolean'}, reverse: {type: 'boolean'}},
  'Usage: node tools/render-frames.mjs --url URL --out DIR --identity REVISION [--fps 24 --start 0 --count 24 --width 640 --height 360 --workers 1 --resume --reverse]\n页面须暴露 __scene={ready,canvas,seek(t)}。identity 应为源码及输入摘要；续渲配置必须一致。');
  if (options) {
    for (const key of ['fps', 'start', 'count', 'width', 'height', 'workers']) options[key] = Number(options[key]);
    const result = await renderFrames(options);
    console.log(`PASS render frames=${Object.keys(result.frames).length}`);
  }
}
