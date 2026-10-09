import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, writeFile, rm, access, cp, symlink} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {run} from '../tools/lib/cli.mjs';
import {validateRealtime} from '../tools/test/realtime-browser.mjs';
import {validatePlayback} from '../tools/test/playback-browser.mjs';
import {browser} from '../tools/lib/browser.mjs';
import {renderFrames} from '../tools/render-frames.mjs';
import {encode} from '../tools/encode.mjs';
import {qaFrames, qaVideo} from '../tools/qa.mjs';
import {contactSheet} from '../tools/contact-sheet.mjs';
import {snap} from '../tools/snap.mjs';
import {evaluateVideo} from '../tools/pose/evaluate-video.mjs';
import {makeRelease} from '../tools/package/make-release.mjs';

if(process.argv.includes('--help')){console.log('Usage: node scripts/validate-projects.mjs [--isolated] [--offline]\nIsolated mode generates fixtures in a temporary repository. Offline mode skips model download/inference.');process.exit(0);}
const root = fileURLToPath(new URL('../', import.meta.url));
// An isolated temporary repository keeps the working checkout's projects/ read-only.
if(process.argv.includes('--isolated')){
  const fixture=await mkdtemp(path.join(os.tmpdir(),'scene-fixture-'));
  try{
    for(const name of ['scripts','templates','tracks','tools','playbook','package.json','package-lock.json','.gitignore'])await cp(path.join(root,name),path.join(fixture,name),{recursive:true});
    await mkdir(path.join(fixture,'projects'));await symlink(path.join(root,'node_modules'),path.join(fixture,'node_modules'),'dir');
    await run('git',['init','--quiet'],{cwd:fixture});
    const child=spawn(process.execPath,[path.join(fixture,'scripts/validate-projects.mjs'),...(process.argv.includes('--offline')?['--offline']:[])],{cwd:fixture,stdio:'inherit'});
    console.log(`OWNED isolated validator pid=${child.pid}`);const completed=once(child,'exit');
    try{const [code]=await completed;if(code!==0)throw new Error(`Isolated browser validation failed (${code})`);}
    finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await completed;}}
  }finally{await rm(fixture,{recursive:true,force:true});}
  process.exit(0);
}
const offline=process.argv.includes('--offline');
const evidenceBase = process.env.SCENE_EVIDENCE_DIR || os.tmpdir();
await mkdir(evidenceBase, {recursive: true});
const evidence = await mkdtemp(path.join(evidenceBase, 'scene-validation-'));
const definitions = [['motion-games', 'demo-a'], ['music-video', 'demo-b'], ['3d-simulation', 'demo-c']];
const owned = [], servers = [];
let chromium, observationTimer;

async function serve(directory) {
  for (let port = 39920; port <= 39929; port++) {
    const child = spawn(process.execPath, [path.join(root, 'tools/serve.mjs'), '--root', directory, '--port', String(port)], {stdio: ['ignore', 'pipe', 'pipe']});
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const started = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Server ready timeout')); }, 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.stdout.on('data', chunk => { if (chunk.toString().includes('READY')) { clearTimeout(timeout); resolve(true); } });
      child.once('exit', () => { clearTimeout(timeout); resolve(false); });
    });
    if (started) { servers.push(child); console.log(`PASS loopback server port=${port} owned-pid=${child.pid}`); return `http://127.0.0.1:${port}`; }
    if (!errors.includes('EADDRINUSE')) throw new Error(errors);
  }
  throw new Error('No free assigned port');
}

try {
  for (const [track, name] of definitions) {
    const project = path.join(root, 'projects', name);
    try { await access(project); throw new Error(`Refusing to replace existing ${name}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = await run('bash', ['scripts/new-project.sh', track, name], {cwd: root});
    owned.push(project);
    assert.match(result.stdout.toString(), new RegExp(`CREATED projects/${name}`));
    for (const file of ['SPEC.md', 'AGENTS.md', 'CLAUDE.md', 'assets/README.md', 'src/main.js', 'tests/starter.test.mjs', 'docs/track.md', 'tools.local/serve.mjs', 'package.json']) await access(path.join(project, file));
    await run('npm', ['test'], {cwd: project});
    await run('git', ['check-ignore', `projects/${name}/src/main.js`], {cwd: root});
    console.log(`PASS generated ${track} -> projects/${name}; structure, isolated output, npm test, gitignore`);
  }
  await assert.rejects(run('bash', ['scripts/new-project.sh', 'motion-games', 'demo-a'], {cwd: root}));
  await assert.rejects(run('bash', ['scripts/new-project.sh', 'motion-games', '../escape'], {cwd: root}));
  console.log('PASS generator rejects existing project and path traversal');
  if(!offline){await run('bash', ['scripts/fetch-models.sh', '--project', 'projects/demo-a', '--kind', 'pose'], {cwd: root});
  console.log('PASS official local model/runtime download and integrity verification');}
  else console.log('SKIP pose model download/inference: offline validation forbids model downloads');
  const urls = [];
  for (const project of owned) urls.push(await serve(project));
  chromium = await browser({args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  const context = await chromium.newContext({permissions: ['camera'], viewport: {width: 1366, height: 768}});
  const page = await context.newPage();
  const errors = [], external = [], expectedMissing = [];
  page.on('response', response=>{if(offline&&response.status()===404&&response.url().endsWith('/vision_bundle.mjs'))expectedMissing.push(response.url());});
  page.on('console', message => {
    if(offline&&message.type()==='error'&&message.location().url.endsWith('/vision_bundle.mjs')&&message.text().includes('404'))return;
    if (message.type() === 'error' && message.text() !== 'INFO: Created TensorFlow Lite XNNPACK delegate for CPU.') errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !urls.some(url => request.url().startsWith(url + '/'))) external.push(request.url()); });
  await page.goto(urls[0]);
  await page.waitForFunction(() => window.__starter?.started && window.__starter.points === 33);
  assert.notEqual(await page.evaluate(() => window.__starter.audioState), 'running');
  assert.equal(await page.locator('#sound').isVisible(), true);
  await page.evaluate(() => document.querySelector('#sound').click());
  assert.notEqual(await page.evaluate(() => window.__starter.audioState), 'running');
  await page.locator('#sound').click();
  await page.waitForFunction(() => window.__starter.audioState === 'running' && window.__starter.audio.played > 0);
  await page.screenshot({path: path.join(evidence, 'motion-desktop.png')});
  console.log('PASS motion synthetic skeleton, hands-free hold, default autoplay lock, trusted-click sound');
  await page.locator('#camera').click();
  await page.waitForFunction(() => window.__starter.source === 'camera' || window.__starter.cameraError, null, {timeout: 60000});
  if(offline){assert.ok(await page.evaluate(()=>window.__starter.cameraError));assert.equal(expectedMissing.length,1);console.log('PASS absent local model reports recoverable camera error; real inference SKIP');}
  else{assert.equal(await page.evaluate(() => window.__starter.cameraErrorDetail || ''), '');
    await page.waitForFunction(() => window.__starter.cameraFrames >= 2);console.log('PASS real local model with fake camera initializes');}
  await page.locator('#stop').click();assert.equal(await page.locator('video').evaluate(video => video.srcObject),null);assert.equal(external.length,0);
  // Leave the page alive beyond the historic telemetry timer; do not block the user's tool call.
  console.log(offline?'INFO offline resource isolation checked':'INFO observing local runtime network for 65 seconds while verifying other tracks');
  const observation = new Promise(resolve => { observationTimer = setTimeout(resolve, offline?1:65000); });
  for (const [index, label] of [[1, 'music'], [2, 'simulation']]) {
    const tab = await context.newPage();
    tab.on('pageerror', error => errors.push(error.message));
    await tab.goto(urls[index]+(index===1?'?mode=capture&w=640&h=360':''));
    await tab.waitForFunction(() => window.__scene?.ready, null, {timeout:90000});
    await tab.evaluate(() => window.__scene.seek(1.5));
    if (index === 2) { await tab.locator('#provenance').click(); assert.match(await tab.locator('#status').textContent(), /程序生成/); }
    await tab.screenshot({path: path.join(evidence, `${label}-desktop.png`)});
    await tab.close();
    console.log(`PASS ${label} browser page and scene contract`);
  }
  await validateRealtime({url:urls[1],out:path.join(evidence,'resident')});
  await validatePlayback({url:urls[1],out:path.join(evidence,'playback')});
  const frames = path.join(evidence, 'frames'), repeated = path.join(evidence, 'repeated');
  const config = {url: urls[1]+'?mode=capture&w=800&h=450', identity: 'synthetic-validation-v1', fps: 12, count: 12, width: 800, height: 450};
  await renderFrames({...config, out: frames});
  await renderFrames({...config, out: repeated, reverse: true});
  await renderFrames({...config, out: frames, resume: true});
  const report = await qaFrames({frames, compare: repeated, fps: 12});
  assert.equal(report.issues.length, 0);
  await assert.rejects(renderFrames({...config, out: frames, resume: true, identity: 'changed'}), /matching/);
  const tone = path.join(evidence, 'tone.wav');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-threads', '1', tone]);
  const video = path.join(evidence, 'scene.mp4');
  await encode({frames, out: video, fps: 12, count: 12, audio: tone});
  const videoQa = await qaVideo(video); assert.equal(videoQa.issues.length, 0); assert.ok(videoQa.avDelta <= .05);
  await writeFile(path.join(evidence, 'render-qa.json'), JSON.stringify({frames: report, video: videoQa}, null, 2));
  await contactSheet([0, 3, 6, 9].map(i => path.join(frames, `frame-${String(i).padStart(6, '0')}.png`)), path.join(evidence, 'contact-sheet.png'));
  console.log(`PASS render 12 frames, reverse rerender pixel identity, resume, encode, full decode, AV delta=${videoQa.avDelta.toFixed(6)}s, contact sheet`);
  const snaps = await snap({url: urls[0], out: path.join(evidence, 'viewports'), viewports: '1366x768,390x844,360x780', selectors: 'canvas,#audio-status,#begin', lstar: true});
  assert.ok(snaps.every(s => !s.overlaps.length && !s.overflow.length));
  console.log('PASS desktop/mobile screenshots, CIE L*, selected-element overlap and viewport bounds');
  // Exercise the full frame harness with a clearly synthetic test adapter, not a recognition claim.
  const harness = '<!doctype html><script src="./harness.js"></script>';
  await writeFile(path.join(owned[1], 'harness.html'), harness);
  await writeFile(path.join(owned[1], 'harness.js'), 'window.__poseEval={ready:true,detect:(bitmap,ms)=>({lost:false,events:ms<1?[{t:0,hand:"L",type:"synthetic"}]:[]})};');
  const labels = path.join(evidence, 'labels.json');
  await writeFile(labels, JSON.stringify({events: [{t: 0, hand: 'L', type: 'synthetic'}]}));
  const evaluation = await evaluateVideo({video, url: urls[1] + '/harness.html', out: path.join(evidence, 'eval'), labels, fps: 4});
  assert.equal(evaluation.metrics.recall, 1);
  console.log('PASS video -> extracted frames -> browser harness -> metrics -> contact sheet (synthetic adapter only)');
  const archive = path.join(evidence, 'project.tar.gz');
  await makeRelease({source: owned[2], out: archive});
  const unpacked = path.join(evidence, 'unpacked'); await mkdir(unpacked);
  await run('tar', ['-xzf', archive, '-C', unpacked]);
  const unpackedUrl = await serve(unpacked), tab = await context.newPage();
  await tab.goto(unpackedUrl); await tab.waitForFunction(() => window.__scene?.ready, null, {timeout:90000}); await tab.close();
  console.log('PASS release package hash verification, extraction and independent browser startup');
  await observation;
  assert.equal(external.length, 0); assert.deepEqual(errors, []);
  console.log(offline?'PASS offline pages: external requests=0; page errors=0':'PASS 65-second telemetry observation: external requests=0; page errors=0');
  console.log('SKIP optional licensed real-person recordings: no datasets bundled; no real-person accuracy claim');
} finally {
  clearTimeout(observationTimer);
  if (chromium) await chromium.close();
  for (const child of servers) {
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
    console.log(`CLEAN owned-pid=${child.pid} stopped`);
  }
  for (const project of owned) { await rm(project, {recursive: true, force: true}); console.log(`CLEAN projects/${path.basename(project)} removed`); }
}
console.log('PASS all generated-project and browser validations');
