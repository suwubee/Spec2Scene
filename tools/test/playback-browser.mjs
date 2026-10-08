import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,cp,symlink,writeFile,readFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright';
import {localServer} from './helpers.mjs';
import {percentile} from '../../tracks/music-video/player/quality.js';
import {contactSheet} from '../contact-sheet.mjs';
const exec=promisify(execFile),root=fileURLToPath(new URL('../../',import.meta.url));

/** Use the real generator in a temporary repository; never write the checkout's projects/. */
export async function playbackFixture() {
  const fixture=await mkdtemp(path.join(os.tmpdir(),'scene-playback-fixture-'));
  try {
    for(const name of ['scripts','templates','tracks','tools','playbook','package.json','package-lock.json'])await cp(path.join(root,name),path.join(fixture,name),{recursive:true});
    await mkdir(path.join(fixture,'projects'));await symlink(path.join(root,'node_modules'),path.join(fixture,'node_modules'),'dir');
    await exec('bash',['scripts/new-project.sh','music-video','sample'],{cwd:fixture,timeout:30000});
    return {root:fixture,project:path.join(fixture,'projects/sample'),close:()=>rm(fixture,{recursive:true,force:true})};
  } catch(error) {await rm(fixture,{recursive:true,force:true});throw error;}
}

// Limit software shader workers, raster threads and browser CPU affinity; record only our own PID.
async function launch(out) {
  let executablePath=process.env.SCENE_CHROMIUM||chromium.executablePath(),env={...process.env,LP_NUM_THREADS:'2',OMP_NUM_THREADS:'2'};
  if(process.platform==='linux') {
    const shim=path.join(out,'nproc.so');
    await exec('cc',['-shared','-fPIC','-O2','-o',shim,path.join(root,'tools/cinematic/lib/nproc_shim.c'),'-ldl'],{timeout:30000});
    const affinity=await exec('taskset',['-pc',String(process.pid)],{timeout:5000});
    const list=affinity.stdout.trim().split(':').at(-1).trim(),cpus=[];
    for(const item of list.split(',')){const [a,b=a]=item.split('-').map(Number);for(let i=a;i<=b&&cpus.length<2;i++)cpus.push(i);if(cpus.length===2)break;}
    const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
    const wrapper=path.join(out,'browser.sh');
    await writeFile(wrapper,`#!/bin/sh\necho $$ > ${quote(path.join(out,'browser.pid'))}\nexec taskset -c ${cpus.join(',')} env LD_PRELOAD=${quote(shim)} MV_NPROC=2 ${quote(executablePath)} "$@"\n`,{mode:0o700});
    executablePath=wrapper;
  }
  const browser=await chromium.launch({headless:true,executablePath,env,timeout:30000,ignoreDefaultArgs:['--mute-audio'],
    args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--num-raster-threads=2','--renderer-process-limit=2']});
  if(process.platform==='linux')console.log(`OWNED playback browser pid=${(await readFile(path.join(out,'browser.pid'),'utf8')).trim()}`);
  return browser;
}

async function instrument(page) {
  await page.addInitScript(()=>{
    window.__probe={clicks:[],samples:[]};
    document.addEventListener('click',event=>{
      if(event.target.id!=='play')return;
      const p=window.__probe,media=document.querySelector('#music');
      if(!media.paused)return;
      if(!p.context) {
        p.context=new AudioContext();p.analyser=p.context.createAnalyser();p.analyser.fftSize=256;
        p.context.createMediaElementSource(media).connect(p.analyser);p.analyser.connect(p.context.destination);
      }
      p.context.resume();
      const click={at:performance.now(),t:media.currentTime,trusted:event.isTrusted,readyState:media.readyState};p.clicks.push(click);
      const wave=new Float32Array(256);
      const timer=setInterval(()=>{
        const now=performance.now();
        if(media.currentTime>click.t && click.advance===undefined)click.advance=now;
        p.analyser.getFloatTimeDomainData(wave);
        if(wave.some(v=>Math.abs(v)>.0001)&&click.signal===undefined)click.signal=now;
        if(click.advance!==undefined&&click.signal!==undefined||now-click.at>20000)clearInterval(timer);
      },5);
    },true);
  });
}

export async function validatePlayback({url,out}) {
  await mkdir(out,{recursive:true});const browser=await launch(out);
  const report={status:'RUNNING',pid:process.pid,browser:browser.version(),autoplay:'default',muted:false,backend:'SwiftShader; 2 shader workers / 2 CPUs on Linux',runs:[],limits:['SKIP target Windows/ANGLE D3D11: no target device','SKIP human speaker listening: analyser measures decoded signal only','SKIP independent aesthetic review: implementation regression only']};
  try {
    for(const kind of ['normal','weak','slow']) {
      const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:1});
      const page=await context.newPage(),errors=[];page.setDefaultTimeout(30000);
      page.on('pageerror',e=>errors.push(e.message));
      await instrument(page);
      if(kind==='normal')await page.addInitScript(()=>{
        document.addEventListener('DOMContentLoaded',()=>{
          const media=document.querySelector('#music');
          media.play().then(()=>{window.__autoplayTest='unexpected playback';media.pause();},error=>{window.__autoplayTest=error.name;});
        },{once:true});
      });
      const cdp=await context.newCDPSession(page);
      if(kind==='weak')await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
      if(kind==='slow') {
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:100,downloadThroughput:250000,uploadThroughput:125000});
        await page.route('**/assets/demo.wav',async route=>{await new Promise(resolve=>setTimeout(resolve,3000));await route.continue();});
        await page.route('**/player/worker.js',async route=>{await new Promise(resolve=>setTimeout(resolve,6000));await route.continue();});
      }
      const row={kind,errors};report.runs.push(row);
      try {
        await page.goto(url,{waitUntil:'domcontentloaded'});
        await page.waitForFunction(()=>window.__player?.buttonReadyMs>0);
        row.buttonReadyMs=await page.evaluate(()=>__player.buttonReadyMs);
        assert.ok(row.buttonReadyMs<=1000,`${kind} button ready ${row.buttonReadyMs} ms`);
        assert.equal(await page.locator('#play').isEnabled(),true);
        assert.equal(await page.evaluate(()=>__player.media.paused),true);
        assert.equal(await page.evaluate(()=>typeof window.__scene),'undefined');
        if(kind==='normal') {
          await page.waitForFunction(()=>window.__autoplayTest);
          assert.equal(await page.evaluate(()=>__autoplayTest),'NotAllowedError','default autoplay must reject an untrusted start');
        }
        if(kind!=='slow') await page.waitForFunction(()=>__player.media.readyState>=3);
        if(kind==='slow') {
          row.loadingText=await page.locator('#status').textContent();assert.match(row.loadingText,/正在载入音乐 \d+%/);
          await page.evaluate(()=>document.querySelector('#music').addEventListener('canplay',()=>{__probe.canplay=performance.now();},{once:true}));
        }
        await page.locator('#play').click();
        await page.waitForFunction(()=>__probe.clicks[0]?.signal!==undefined&&__probe.clicks[0]?.advance!==undefined,null,{timeout:20000});
        row.click=await page.evaluate(()=>__probe.clicks[0]);
        row.clickToSignalMs=row.click.signal-row.click.at;row.clickToAdvanceMs=row.click.advance-row.click.at;
        assert.equal(row.click.trusted,true);assert.equal(await page.evaluate(()=>__player.userActivation),true);
        assert.ok(row.clickToSignalMs>=0);assert.ok(row.clickToAdvanceMs>=0);
        if(kind==='slow') {
          row.canplayToSignalMs=await page.evaluate(()=>__probe.clicks[0].signal-__probe.canplay);
          assert.ok(row.clickToSignalMs>1000,'slow fixture must exercise media wait');
          assert.ok(row.canplayToSignalMs<=1000,'queued playback must start after buffering');
          row.progress=await page.locator('#music-progress').getAttribute('aria-valuetext');
          await page.screenshot({path:path.join(out,'slow.png')});
        } else {
          assert.ok(row.clickToSignalMs<=1000,`${kind} click to decoded signal ${row.clickToSignalMs} ms`);
          row.clock=await page.evaluate(()=>new Promise(resolve=>{
            const media=__player.media,start=performance.now(),t=media.currentTime;
            setTimeout(()=>resolve({wall:(performance.now()-start)/1000,audio:media.currentTime-t,rate:media.playbackRate,paused:media.paused}),20000);
          }));
          assert.ok(row.clock.wall>=19.6&&row.clock.wall<=20.4,`20 s wall window: ${JSON.stringify(row.clock)}`);
          assert.ok(row.clock.audio>=19.6&&row.clock.audio<=20.4,`20 s audio window: ${JSON.stringify(row.clock)}`);
          assert.equal(row.clock.rate,1);assert.equal(row.clock.paused,false);
          await page.waitForFunction(()=>__player.frames.length>=3,null,{timeout:60000});
          row.playback=await page.evaluate(()=>({frames:__player.frames,quality:__player.quality,renderSize:__player.renderSize,changes:__player.changes,compiles:__player.compiles,capabilities:__player.capabilities,fps:__player.fps,p90:__player.p90,firstFrameMs:__player.firstFrameMs,dropped:__player.dropped,errors:__player.errors}));
          assert.deepEqual(row.playback.errors,[]);assert.ok(row.playback.fps>0,'HUD must measure completed frames');
          const frameMs=row.playback.frames.map(f=>f.ms),steady=row.playback.frames.filter(f=>f.kind==='steady').map(f=>f.ms);
          row.frameSummary={count:frameMs.length,mean:frameMs.reduce((a,b)=>a+b,0)/frameMs.length,p90:percentile(frameMs),steadyP90:percentile(steady)};
          row.hud=await page.locator('#hud').textContent();assert.ok(!row.hud.includes(' 0 fps'));
          await page.screenshot({path:path.join(out,`${kind}.png`)});
          if(kind==='normal') {
            await page.waitForFunction(()=>__player.compiles.some(c=>c.set==='station'),null,{timeout:20000});
            row.prewarm=await page.evaluate(()=>({audioTime:__player.media.currentTime,compiles:__player.compiles}));
            assert.ok(row.prewarm.audioTime<30,'next scene should compile in the idle lookahead window');
          }
          await page.locator('#play').click();
          const paused=await page.evaluate(()=>__player.media.currentTime);await page.waitForTimeout(250);
          assert.ok(Math.abs((await page.evaluate(()=>__player.media.currentTime))-paused)<.08);
          await page.locator('#restart').click();await page.waitForFunction(()=>__player.media.currentTime<.1);
          await page.locator('#subtitles').uncheck();assert.equal(await page.locator('#subtitle').isVisible(),false);
          await page.locator('#subtitles').check();
          // Actual input seek, then a second scene and mobile layout. No render stubs.
          await page.locator('#timeline').fill('35');await page.locator('#timeline').dispatchEvent('input');
          await page.waitForFunction(()=>Math.abs(__player.lastRenderedTime-35)<.1,null,{timeout:60000});
          assert.match(await page.locator('#subtitle').textContent(),/雨/);
          await page.screenshot({path:path.join(out,`${kind}-station.png`)});
          if(kind==='normal') {
            await page.locator('#quality').selectOption('medium');
            await page.waitForFunction(()=>__player.quality==='medium');
            await page.locator('#quality').selectOption('high');
            await page.waitForFunction(()=>__player.quality==='high'||__player.errors.length,null,{timeout:90000});
            assert.deepEqual(await page.evaluate(()=>__player.errors),[]);
            assert.equal(await page.evaluate(()=>__player.choice),'high');
            await page.screenshot({path:path.join(out,'manual-high.png')});
            await page.locator('#quality').selectOption('low');
            await page.waitForFunction(()=>__player.quality==='low');
            await page.waitForFunction(()=>document.querySelector('#hud').textContent.startsWith('低 ·')&&document.querySelector('#hud').textContent.includes('640×360'));
            await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'mobile.png')});
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
          }
        }
        assert.deepEqual(errors,[]);row.status='PASS';
        console.log(`PASS playback ${kind}: button=${row.buttonReadyMs.toFixed(1)}ms signal=${row.clickToSignalMs.toFixed(1)}ms audio=${row.clock?.audio??'buffer wait'} quality=${row.playback?.quality??'pending'}`);
      } catch(error) {row.status='FAIL';row.failure=error.stack;await page.screenshot({path:path.join(out,`${kind}-failure.png`)}).catch(()=>{});throw error;}
      finally {await context.close();await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
    }
    const capture=await browser.newPage({viewport:{width:640,height:520}});
    capture.setDefaultTimeout(90000);
    const captureErrors=[];capture.on('pageerror',error=>captureErrors.push(error.message));
    await capture.goto(url+'?mode=capture&w=480&h=270',{waitUntil:'domcontentloaded'});
    await capture.waitForFunction(()=>window.__scene?.ready);
    assert.equal(await capture.evaluate(()=>__player.mode),'capture');
    assert.equal(await capture.evaluate(()=>__player.media.getAttribute('src')),null);
    assert.equal(await capture.evaluate(()=>__scene.qualityInfo.actual),'high');
    assert.equal(await capture.evaluate(()=>__player.frames),undefined);
    const pixels=await capture.evaluate(async()=>{
      await __scene.seek(6);const a=__scene.capture();await __scene.seek(35);const b=__scene.capture();
      await __scene.seek(6);const reverse=__scene.capture();return {same:a===reverse,different:a!==b};
    });
    assert.equal(pixels.same,true);assert.equal(pixels.different,true);
    await capture.screenshot({path:path.join(out,'capture.png')});
    assert.deepEqual(captureErrors,[]);report.capture={status:'PASS',quality:'high',reversePixelsIdentical:true,audio:false,adaptive:false};
    // Review the actual distant mesh from three directions over consecutive motion samples.
    await capture.evaluate(async base=>{
      __scene.dispose();
      const THREE=await import(base+'/engine/vendor/three.module.js');
      const {createDistantCharacter}=await import(base+'/sample/distant-character.js');
      const canvas=document.createElement('canvas');document.body.replaceChildren(canvas);
      const renderer=new THREE.WebGLRenderer({canvas,antialias:false,preserveDrawingBuffer:true});renderer.setSize(320,360);renderer.toneMapping=THREE.ACESFilmicToneMapping;
      const scene=new THREE.Scene();scene.background=new THREE.Color(0x454c56);scene.add(new THREE.HemisphereLight(0xc9dcf8,0x39312b,2));
      const lamp=new THREE.DirectionalLight(0xffe4cc,2);lamp.position.set(3,5,4);scene.add(lamp);
      const actor=createDistantCharacter();scene.add(actor.object);
      const camera=new THREE.PerspectiveCamera(35,320/360,.05,50);camera.position.set(0,1,3.6);camera.lookAt(0,.95,0);
      window.__distantFrame=(angle,t)=>{actor.object.rotation.y=angle;actor.update('windWalk',t,{distance:t*.22});renderer.render(scene,camera);return canvas.toDataURL('image/png').split(',')[1];};
    },url);
    const images=[],labels=[];
    for(const [view,angle] of [['front',0],['side',Math.PI/2],['back',Math.PI]])for(const t of [1,1.125,1.25]) {
      const file=path.join(out,`distant-${view}-${t}.png`);
      await writeFile(file,Buffer.from(await capture.evaluate(({angle,t})=>__distantFrame(angle,t),{angle,t}),'base64'));images.push(file);labels.push(`${view} / ${t}s`);
    }
    await contactSheet(images,path.join(out,'distant-sequence.png'),{columns:3,width:240,labels});
    report.distantReview={views:3,frames:9,file:'distant-sequence.png',scope:'distant preview geometry, same production rig and poses; not close-up character approval'};
    await capture.close();
    report.status='PASS';return report;
  } catch(error) {report.status='FAIL';report.failure=error.stack;throw error;}
  finally {await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser.close();console.log('CLEAN playback browser closed and waited');}
}

export async function validateGeneratedPlayback(out) {
  const fixture=await playbackFixture();let server;
  try {server=await localServer(fixture.project,{min:39920,max:39929});console.log(`OWNED playback loopback ${server.url} in pid=${process.pid}`);return await validatePlayback({url:server.url,out});}
  finally {await server?.close();await fixture.close();}
}
