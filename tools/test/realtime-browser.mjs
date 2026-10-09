import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import {launch, instrument, playbackFixture} from './playback-browser.mjs';
import {localServer} from './helpers.mjs';
import {checkFlicker} from '../flicker-check.mjs';

export async function validateRealtime({url, out, kinds = ['default', 'strict-5s', 'strict-25s', 'retry']}) {
  await mkdir(out, {recursive: true});
  const report = {status: 'RUNNING', renderSize: [160, 90], backend: 'Chromium SwiftShader, two CPUs/shader workers', runs: [], limits: ['SKIP target GPU: software browser only', 'SKIP human listening: decoded analyser signal only', 'SKIP independent review and deployment: not part of library regression']};
  const browsers = new Map();
  try {
    for (const [kind, delay, strict] of [['default', 0, false], ['strict-5s', 5000, true], ['strict-25s', 25000, true], ['retry', 0, true]]) {
      if (!kinds.includes(kind)) continue;
      const directory = path.join(out, kind); await mkdir(directory);
      if (!browsers.has(strict)) browsers.set(strict, await launch(directory, {strict}));
      const browser = browsers.get(strict);
      const page = await browser.newPage({viewport: {width: 760, height: 750}});
      page.setDefaultTimeout(90000);
      const row = {kind, delay, browser: browser.version(), autoplay: strict ? 'document-user-activation-required' : 'default', errors: [], requests: 0}; report.runs.push(row);
      page.on('pageerror', error => row.errors.push(error.message));
      await instrument(page);
      await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
          const media = document.querySelector('#music');
          media.play().then(() => { window.__untrusted = 'unexpected'; media.pause(); }, error => { window.__untrusted = error.name; });
        }, {once: true});
      });
      if (delay || kind === 'retry') await page.route('**/assets/demo.wav', async route => {
        try {
          row.requests++;
          if (kind === 'retry' && row.requests === 1) { await route.fulfill({status: 404, body: 'missing test source'}); return; }
          if (delay) {
            // The software engine can warm longer than 25s. Hold the response until
            // warmup ends, then inject the full delay so wall-clock takeover is exercised.
            await page.waitForFunction(() => window.__player?.warm?.done, null, {timeout: 240000});
            await new Promise(resolve => setTimeout(resolve, delay));
          }
          await route.continue();
        } catch (error) {
          row.errors.push(`Audio fault-injection fixture: ${error.message}`);
          await route.abort().catch(() => {});
        }
      });
      try {
        await page.goto(url + '?w=160&h=90', {waitUntil: 'domcontentloaded'});
        await page.waitForFunction(() => window.__player?.transport);
        assert.equal(await page.evaluate(() => __player.mode), 'resident');
        assert.equal(await page.evaluate(() => typeof window.__scene), 'undefined');
        if (strict) assert.equal(await page.evaluate(() => navigator.webdriver), false);
        await page.waitForFunction(() => window.__untrusted);
        row.untrusted = await page.evaluate(() => __untrusted);
        assert.equal(row.untrusted, 'NotAllowedError');
        await page.locator('#play').click();
        await page.waitForFunction(() => __player.warm?.steps > 0 || __player.errors.length);
        assert.deepEqual(await page.evaluate(() => __player.errors), []);
        assert.equal(await page.evaluate(() => __player.media.paused), true, 'audio must wait for representative-frame warmup');
        await page.screenshot({path: path.join(directory, 'warmup.png')});
        await page.waitForFunction(() => __player.warm?.done || __player.errors.length);
        assert.deepEqual(await page.evaluate(() => __player.errors), []);
        if (kind === 'retry') {
          await page.waitForFunction(() => __player.sound === 'failed');
          assert.match(await page.locator('#sound').textContent(), /失败.*重试/);
          await page.screenshot({path: path.join(directory, 'failed.png')});
          await page.locator('#sound').click();
        }
        if (delay === 25000) {
          await page.waitForFunction(() => __player.frames?.length >= 2);
          row.waiting = await page.evaluate(() => ({sound: __player.sound, clock: __player.clock, t: __player.lastRenderedTime}));
          assert.equal(row.waiting.sound, 'loading'); assert.equal(row.waiting.clock, 'wall'); assert.ok(row.waiting.t > 0);
          assert.match(await page.locator('#sound').textContent(), /载入中/);
          await page.screenshot({path: path.join(directory, 'loading.png')});
        }
        await page.waitForFunction(() => __probe.clicks[0]?.signal !== undefined && __player.sound === 'playing');
        // A completed frame stores the exact media time chosen before the draw.
        await page.waitForFunction(() => __player.frames.length >= 3);
        await page.waitForFunction(() => __player.frames.at(-1)?.clock === 'audio');
        row.result = await page.evaluate(() => ({sound: __player.sound, clock: __player.clock, mediaTime: __player.media.currentTime, frameTime: __player.lastRenderedTime, clockTime: __player.lastClockTime, frame: __player.frames.at(-1), click: __probe.clicks[0], warm: __player.warm, newPrograms: __player.newPrograms, muted: __player.media.muted, transitions: __player.transport.state.transitions}));
        assert.equal(row.result.clock, 'audio'); assert.equal(row.result.muted, false);
        assert.equal(row.result.click.trusted, true);
        assert.equal(await page.evaluate(() => __player.userActivation), true);
        assert.ok(row.result.click.signal >= row.result.click.at);
        assert.ok(Math.abs(row.result.clockTime - row.result.frameTime) <= .019, 'only cut guard may offset sampled audio time');
        assert.ok(Math.abs(row.result.frame.audioTime - row.result.frame.t) < .05, 'render sample must follow media currentTime at submission');
        row.presentationLagSeconds = row.result.mediaTime - row.result.frameTime;
        row.presentationBudget = Math.abs(row.presentationLagSeconds) < .6 ? 'within 0.6s software observation window' : 'FAIL software presentation budget; target GPU acceptance remains pending';
        assert.equal(row.result.warm.steps, row.result.warm.total); assert.equal(row.result.warm.scenes, 2);
        assert.equal(row.result.newPrograms, 0);
        if (delay) assert.equal(row.result.transitions.some(t => t.sound === 'failed' || t.sound === 'blocked'), false);
        await page.screenshot({path: path.join(directory, 'playing.png')});
        if (kind === 'default') {
          row.clock = await page.evaluate(() => new Promise(resolve => {
            const start = performance.now(), audio = __player.media.currentTime;
            setTimeout(() => resolve({wall: (performance.now() - start) / 1000, audio: __player.media.currentTime - audio, rate: __player.media.playbackRate}), 20000);
          }));
          // Main-thread software draws may delay the timer callback. Preserve the
          // actual interval and compare clock rates instead of calling it exactly 20s.
          row.clock.normalizedAudio20s = row.clock.audio / row.clock.wall * 20;
          assert.ok(Math.abs(row.clock.audio - row.clock.wall) < .15);
          assert.ok(row.clock.normalizedAudio20s >= 19.6 && row.clock.normalizedAudio20s <= 20.4);
          assert.equal(row.clock.rate, 1);
          await page.locator('#play').click();
          const paused = await page.evaluate(() => __player.transport.time()); await page.waitForTimeout(200);
          assert.equal(await page.evaluate(() => __player.transport.time()), paused);
          await page.locator('#restart').click(); assert.equal(await page.evaluate(() => __player.transport.time()), 0);
          await page.locator('#subtitles').uncheck(); assert.equal(await page.locator('#subtitle').isVisible(), false);
          await page.locator('#subtitles').check();
          row.sweep = [];
          for (const t of [0, 15, 29.95, 30, 30.6, 35, 40, 44, 48, 51, 54, 57, 59.95]) {
            await page.locator('#timeline').fill(String(t)); await page.locator('#timeline').dispatchEvent('input');
            await page.waitForFunction(t => Math.abs(__player.lastRenderedTime - t) <= .019, t);
            row.sweep.push(await page.evaluate(() => ({t: __player.lastRenderedTime, newPrograms: __player.newPrograms})));
          }
          assert.ok(row.sweep.every(s => s.newPrograms === 0));
          await page.setViewportSize({width: 390, height: 844}); await page.screenshot({path: path.join(directory, 'mobile.png')});
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
        assert.deepEqual(row.errors, []); row.status = 'PASS';
        console.log(`PASS resident ${kind}: signal=${(row.result.click.signal - row.result.click.at).toFixed(1)}ms warm=${row.result.warm.steps} audio=${row.result.mediaTime.toFixed(3)}`);
      } catch (error) { row.status = 'FAIL'; row.failure = error.stack; await page.screenshot({path: path.join(directory, 'failure.png')}).catch(() => {}); throw error; }
      finally { await page.context().close(); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); }
    }
    // Exercise both flicker routes against the actual generated engine, including a hard cut.
    const directory = path.join(out, 'flicker-browser'); await mkdir(directory);
    const browser = await launch(directory);
    try {
      const result = await checkFlicker({url, out: path.join(out, 'flicker'), start: 39.9, end: 40.1, width: 320, height: 180, timeout: 240000, browser});
      assert.equal(result.status, 'COMPLETE'); assert.equal(result.rows.filter(r => r.cut === 40).length, 12);
      assert.ok(result.rows.some(r => r.mode === 'realtime' && r.t !== r.rendered));
      report.flicker = {status: result.status, frames: result.rows.length, candidates: result.candidates};
    } finally { await browser.close(); }
    report.status = 'PASS'; return report;
  } catch (error) { report.status = 'FAIL'; report.failure = error.stack; throw error; }
  finally { for (const browser of browsers.values()) await browser.close(); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); }
}

export async function validateGeneratedRealtime(out, options = {}) {
  const fixture = await playbackFixture(); let server;
  try { server = await localServer(fixture.project, {min: 39920, max: 39929}); console.log(`OWNED resident server ${server.url} pid=${process.pid}`); return await validateRealtime({url: server.url, out, ...options}); }
  finally { await server?.close(); await fixture.close(); }
}
