import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {localServer} from './helpers.mjs';
import {renderFrames} from '../render-frames.mjs';
import {snap} from '../snap.mjs';
import {qaFrames, qaVideo} from '../qa.mjs';
import {encode} from '../encode.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scene-browser-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const server = await localServer(directory); t.after(() => server.close());
  return {directory, server};
}

test('browser render, resume, screenshot metrics and encoding work on a deterministic scene', async t => {
  const {directory, server} = await fixture(t);
  await writeFile(path.join(directory, 'index.html'), `<!doctype html><meta charset="utf-8">
    <canvas width="128" height="72"></canvas><button>Start</button><script>
    const canvas=document.querySelector('canvas'), c=canvas.getContext('2d');
    window.__scene={ready:true,canvas,seek(t){
      const g=c.createLinearGradient(0,0,128,72); g.addColorStop(0,'#aaddff'); g.addColorStop(1,'#ffccaa');
      c.fillStyle=g;c.fillRect(0,0,128,72);c.fillStyle='#135768';c.fillRect(t*30,20,15,15);
    }};__scene.seek(0);</script>`);
  const frames = path.join(directory, 'frames'), compare = path.join(directory, 'compare');
  const config = {url: server.url, identity: 'test-scene', fps: 2, count: 3, width: 320, height: 200};
  await renderFrames({...config, out: frames});
  await renderFrames({...config, out: frames, resume: true});
  await renderFrames({...config, out: compare, reverse: true});
  assert.equal((await qaFrames({frames, compare, fps: 2})).issues.length, 0);
  const screen = await snap({url: server.url, out: path.join(directory, 'snap'), viewports: '320x200', selectors: 'canvas,button', lstar: true, time: .25});
  assert.deepEqual(screen[0].overlaps, []); assert.ok(screen[0].image.meanLstar > 50);
  const video = path.join(directory, 'scene.mp4');
  await encode({frames, out: video, fps: 2, count: 3});
  const qa = await qaVideo(video); assert.equal(qa.decode, 'PASS'); assert.equal(qa.audio, false);
  assert.deepEqual(qa.issues, []);
  await assert.rejects(renderFrames({...config, out: frames, resume: true, identity: 'changed'}), /matching/);
});

test('browser audit refuses page errors and missing elements instead of a false screenshot PASS', async t => {
  const {directory, server} = await fixture(t);
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><script>throw new Error("deliberate scene failure")</script>');
  await assert.rejects(snap({url: server.url, out: path.join(directory, 'error'), viewports: '320x200'}), /deliberate scene failure/);
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><p>Scene</p>');
  await assert.rejects(snap({url: server.url, out: path.join(directory, 'missing'), viewports: '320x200', selectors: '#missing'}), /Missing|Timeout/);
});
