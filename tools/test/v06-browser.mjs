import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir, writeFile, readFile, copyFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {localServer} from './helpers.mjs';
import {launch, playbackFixture} from './playback-browser.mjs';
import {contactSheet} from '../contact-sheet.mjs';
import {sha256} from '../lib/images.mjs';
import {encode} from '../encode.mjs';
import {qaVideo} from '../qa.mjs';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const baseline = '6696f0276a69b5a07cff06e88386d3b140b9709b';

export async function validateV06(out) {
  await mkdir(out, {recursive: true});
  const fixture = await playbackFixture();
  let server, browser;
  const report = {status: 'RUNNING', pid: process.pid, baseline, autoplay: 'default', phase: [], terrain: [],
    limits: ['SKIP target GPU and human listening: software browser and synthetic assets', 'SKIP production and independent aesthetic gates: library regression only']};
  try {
    const legacy = (await exec('git', ['show', `${baseline}:tracks/music-video/engine/terrain.js`], {cwd: root, timeout: 10000, maxBuffer: 500000})).stdout;
    await writeFile(path.join(fixture.project, 'engine/terrain-baseline.js'), legacy);
    await writeFile(path.join(fixture.project, 'terrain-test.html'), '<!doctype html><canvas width="480" height="270"></canvas><script type="module" src="./terrain-test.js"></script>');
    await copyFile(new URL('./v06-terrain-fixture.js', import.meta.url), path.join(fixture.project, 'terrain-test.js'));
    server = await localServer(fixture.project, {min: 39920, max: 39929});
    report.port = server.port; console.log(`OWNED v06 server ${server.url} pid=${process.pid}`);
    browser = await launch(out); report.browser = browser.version();
    const page = await browser.newPage({viewport: {width: 1000, height: 780}}), errors = [];
    page.setDefaultTimeout(90000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /THREE|shader|WebGL/i.test(message.text())) errors.push(message.text()); });
    await page.goto(server.url + '/kits/celestial-phase/example.html?t=3');
    await page.waitForFunction(() => window.__scene);
    const frames = [];
    for (const t of [0, 1.5, 3, 4.5, 6, 7.5, 9, 10.5]) {
      const start = performance.now();
      const png = Buffer.from(await page.evaluate(t => { __scene.seek(t); return __scene.capture().split(',')[1]; }, t), 'base64');
      const file = path.join(out, `phase-${t}.png`); await writeFile(file, png); frames.push(file);
      const stats = await sharp(png).stats();
      report.phase.push({t, ms: performance.now() - start, hash: sha256(png), brightness: stats.channels.slice(0, 3).reduce((s, c) => s + c.mean, 0) / 3});
      assert.deepEqual(await page.evaluate(() => __scene.inspect()), {calls: 1, triangles: 1});
    }
    const repeat = Buffer.from(await page.evaluate(() => { __scene.seek(3); return __scene.capture().split(',')[1]; }), 'base64');
    assert.equal(sha256(repeat), report.phase.find(r => r.t === 3).hash);
    assert.ok(report.phase.find(r => r.t === 6).brightness > report.phase.find(r => r.t === 0).brightness * 1.5);
    await contactSheet(frames, path.join(out, 'phase-sheet.png'), {columns: 4, width: 380, labels: report.phase.map(r => `phase t=${r.t}`)});
    const sequence = [];
    for (let i = 0; i < 12; i++) {
      const png = Buffer.from(await page.evaluate(t => { __scene.seek(t); return __scene.capture().split(',')[1]; }, 2.8 + i / 24), 'base64');
      const file = path.join(out, `phase-sequence-${i}.png`); await writeFile(file, png); sequence.push(file);
    }
    await contactSheet(sequence, path.join(out, 'phase-sequence.png'), {columns: 4, width: 380});
    await page.goto(server.url + '/terrain-test.html'); await page.waitForFunction(() => window.__terrain);
    for (const [kind, times] of [['terrain', [0]], ['surface', [4]]]) for (const t of times) {
      const row = await page.evaluate(async ({kind, t}) => __terrain.compare(kind, t), {kind, t});
      assert.equal(row.before, row.after, `${kind} t=${t}: legacy pixels must remain byte-identical`);
      const png = Buffer.from(row.after.split(',')[1], 'base64');
      await writeFile(path.join(out, `${kind}-${t}.png`), png);
      report.terrain.push({kind, t, hash: sha256(png), identical: true});
    }
    const slope = await page.evaluate(() => __terrain.slope());
    await writeFile(path.join(out, 'slope.png'), Buffer.from(slope.split(',')[1], 'base64'));
    assert.deepEqual(errors, []);

    // Create a real synthetic MP4 to exercise MIME, Range and browser download bytes.
    const videoFrames = path.join(out, 'video-frames'); await mkdir(videoFrames);
    for (let i = 0; i < 8; i++) await sharp(frames[i]).resize(320, 180).toFile(path.join(videoFrames, `frame-${String(i).padStart(6, '0')}.png`));
    const video = path.join(out, 'share.mp4');
    await encode({frames: videoFrames, out: video, fps: 4, audio: path.join(fixture.project, 'assets/demo.wav'), crf: 19});
    report.video = await qaVideo(video); assert.equal(report.video.decode, 'PASS'); assert.equal(report.video.issues.some(i => i.severity === 'fail'), false);
    await page.goto(server.url + '/?w=160&h=90'); await page.waitForFunction(() => window.__player?.controls);
    assert.equal(await page.locator('#download').getAttribute('aria-disabled'), 'true');
    assert.equal(await page.locator('#download').getAttribute('href'), null);
    await page.screenshot({path: path.join(out, 'download-pending.png')});
    await copyFile(video, path.join(fixture.project, 'assets/video/share.mp4'));
    await page.evaluate(() => __player.controls.checkDownload());
    assert.equal(await page.locator('#download').getAttribute('aria-disabled'), 'false');
    const head = await fetch(server.url + '/assets/video/share.mp4', {method: 'HEAD'});
    assert.equal(head.headers.get('content-type'), 'video/mp4'); assert.equal(head.headers.get('accept-ranges'), 'bytes');
    const partial = await fetch(server.url + '/assets/video/share.mp4', {headers: {Range: 'bytes=10-29'}});
    assert.equal(partial.status, 206); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), (await readFile(video)).subarray(10, 30));
    assert.equal((await fetch(server.url + '/assets/video/share.mp4', {headers: {Range: 'bytes=999999999-'}})).status, 416);
    const downloadEvent = page.waitForEvent('download'); await page.locator('#download').click();
    const download = await downloadEvent; const saved = path.join(out, 'download.mp4'); await download.saveAs(saved);
    assert.equal(sha256(await readFile(saved)), sha256(await readFile(video)));
    report.downloadHash = sha256(await readFile(saved));
    // Seek before and during real engine warmup, then ensure that time survives startup.
    await page.locator('#timeline').fill('7'); await page.locator('#timeline').dispatchEvent('input');
    assert.equal(await page.evaluate(() => __player.transport.time()), 7);
    await page.locator('#play').click(); await page.waitForFunction(() => __player.warm?.steps > 0);
    await page.locator('#timeline').fill('12'); await page.locator('#timeline').dispatchEvent('input');
    assert.equal(await page.evaluate(() => __player.transport.time()), 12);
    await page.screenshot({path: path.join(out, 'seek-warmup.png')});
    await page.waitForFunction(() => __player.warm?.done && __player.sound === 'playing');
    assert.ok(await page.evaluate(() => __player.transport.time()) >= 12);
    await page.locator('canvas').click();
    await page.waitForFunction(() => document.querySelector('.transport').classList.contains('idle'));
    await page.mouse.move(20, 20); assert.equal(await page.locator('.transport').evaluate(e => e.classList.contains('idle')), false);
    await page.locator('#play').click({force: true}); await page.waitForFunction(() => __player.transport.state.paused); assert.equal(await page.evaluate(() => __player.transport.state.paused), true);
    await page.locator('#timeline').focus(); await page.keyboard.press('ArrowRight');
    const box = await page.locator('#timeline').boundingBox();
    await page.mouse.click(box.x + box.width * .3, box.y + box.height / 2);
    assert.ok(Math.abs(await page.evaluate(() => __player.transport.time()) - 18) < 2);
    await page.mouse.move(box.x + box.width * .3, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .6, box.y + box.height / 2, {steps: 6}); await page.mouse.up();
    assert.ok(Math.abs(await page.evaluate(() => __player.transport.time()) - 36) < 2);
    await page.setViewportSize({width: 390, height: 780});
    for (const selector of ['#play', '#restart', '#timeline', '#download', '.subtitle-control']) {
      const rect = await page.locator(selector).boundingBox(); assert.ok(rect.height >= 44 && rect.width >= 44, selector);
    }
    await page.screenshot({path: path.join(out, 'mobile-controls.png')});
    let videoRequests = 0; page.on('request', req => { if (req.url().includes('/assets/video/')) videoRequests++; });
    await page.goto(server.url + '/?mode=capture&w=160&h=90'); await page.waitForFunction(() => window.__scene?.ready);
    assert.equal(await page.locator('.transport').isVisible(), false); assert.equal(videoRequests, 0);
    assert.deepEqual(errors, []);
    report.controls = 'PASS pending/ready/download, prewarm/warming/click/drag/keyboard seek, idle wake, mobile targets, capture';
    report.status = 'PASS'; return report;
  } catch (error) { report.status = 'FAIL'; report.failure = error.stack; throw error; }
  finally { await browser?.close(); await server?.close(); await fixture.close(); report.ownedProcessesClosed = true; await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); }
}
