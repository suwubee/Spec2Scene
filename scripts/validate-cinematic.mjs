import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {browser} from '../tools/lib/browser.mjs';
import {run,cli,required} from '../tools/lib/cli.mjs';
import {contactSheet} from '../tools/contact-sheet.mjs';
import {checkAnatomy} from '../tools/check-anatomy.mjs';
import {tree,treeHash} from '../tools/lib/tree.mjs';
import {createHash} from 'node:crypto';
import {actions} from '../tracks/music-video/character/motion.js';
const args=cli({out:{type:'string'},quick:{type:'boolean'}},'Usage: node scripts/validate-cinematic.mjs --out validation/v0.2/artifacts/<run> [--quick]\n生成独立样片项目，使用 Chromium 软件后端，保留关键帧/转台/序列/人体报告/性能。仅结束自己的 PID。');
if(!args)process.exit(0);
const root=fileURLToPath(new URL('../',import.meta.url)),out=path.resolve(required(args.out,'out'));
await mkdir(out,{recursive:true});
const name=`v02-validation-${process.pid}`,project=path.join(root,'projects',name),servers=[];
let owned=false,b;
const report={status:'RUNNING',backend:'Chromium headless / ANGLE SwiftShader',autoplay:'default',frames:[],errors:[],external:[],review:{G1:'PENDING',G2:'PENDING',G3:'PENDING'}};
async function serve(){for(let port=39920;port<=39939;port++){
  const child=spawn(process.execPath,['tools/serve.mjs','--root',project,'--port',String(port)],{cwd:root,stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',c=>error+=c);
  const started=await new Promise((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>{if(!settled){child.kill('SIGTERM');reject(new Error('server startup timeout'));}},10000);
    child.once('error',reject);child.stdout.on('data',c=>{if(c.toString().includes('READY')){settled=true;clearTimeout(timer);resolve(true);}});child.once('exit',()=>{clearTimeout(timer);resolve(false);});});
  if(started){servers.push(child);console.log(`READY owned-pid=${child.pid} port=${port}`);return `http://127.0.0.1:${port}`;}if(!error.includes('EADDRINUSE'))throw new Error(error);
}throw new Error('No assigned port available');}
try{
  await run('bash',['scripts/new-project.sh','music-video',name],{cwd:root});owned=true;await run('npm',['test'],{cwd:project});
  const runtime=await tree(project,{runtime:true});report.runtimeDigest=treeHash(runtime);await writeFile(path.join(out,'runtime-manifest.json'),JSON.stringify(runtime,null,2));
  const url=await serve();b=await browser({args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--renderer-process-limit=2']});report.browser=b.version();
  const page=await b.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});
  page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(url+'/'))report.external.push(r.url());});
  page.on('response',r=>{if(r.status()>=400)report.errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);});
  await page.goto(url);await page.waitForFunction(()=>window.__scene?.ready,null,{timeout:60000});
  const capture=async(file,t)=>{await page.evaluate(t=>window.__scene.seek(t),t);const data=await page.evaluate(()=>window.__scene.capture());const buffer=Buffer.from(data.split(',')[1],'base64');await writeFile(path.join(out,file),buffer);return buffer;};
  const times=[0,15,29.9,35,41,46,50,57];
  for(const t of times){const name=`key-${String(t).replace('.','-')}.png`;await capture(name,t);const composition=await page.evaluate(()=>window.__scene.composition());if(t<30)assert.ok(composition.characterAreaFraction<.03,'snow character must occupy less than 3%');report.frames.push({time:t,file:name,composition});}
  await contactSheet(report.frames.map(f=>path.join(out,f.file)),path.join(out,'keyframes.png'),{width:480,columns:2,labels:report.frames.map(f=>`${f.time.toFixed(2)} s`)});
  const base=await capture('determinism-forward.png',15);await page.evaluate(()=>window.__scene.seek(57));const reverse=await capture('determinism-reverse.png',15);assert.ok(base.equals(reverse),'same-session seek must be byte identical');
  await page.reload();await page.waitForFunction(()=>window.__scene?.ready);const fresh=await capture('determinism-fresh.png',15);assert.ok(base.equals(fresh),'fresh-session seek must be byte identical');report.determinism={status:'PASS',scope:'same session and fresh page PNG identity',sha256:createHash('sha256').update(base).digest('hex')};
  const rawCanvas=async file=>{const data=await page.evaluate(()=>window.__scene.canvas.toDataURL('image/png'));await writeFile(file,Buffer.from(data.split(',')[1],'base64'));};
  const tFiles=[];
  for(let i=0;i<8;i++){await page.evaluate(i=>window.__scene.characterFrame('stand',1,i*Math.PI/4),i);const file=path.join(out,`turntable-${i}.png`);await rawCanvas(file);tFiles.push(file);}
  await contactSheet(tFiles,path.join(out,'turntable.png'),{width:320,columns:4,labels:tFiles.map((_,i)=>`${i*45} deg`)});
  if(!args.quick){
    const sequences=[[12,12.2,12.4,12.6,12.8,13],[41,41.5,42,42.5,43,43.5],[42.3,42.7,43.1,43.5,43.9,44.3],[29.9,30,30.3,30.6,30.9,31.2]];
    for(let i=0;i<sequences.length;i++){const files=[];for(const t of sequences[i]){const file=`sequence-${i}-${t}.png`;await capture(file,t);files.push(path.join(out,file));}await contactSheet(files,path.join(out,`sequence-${i}.png`),{width:320,columns:3,labels:sequences[i].map(t=>`${t}s`)});}
    // Diagnostic anatomy view removes the coat, then captures every clip from the side.
    await page.goto(url+'/?anatomy=1&width=800&height=450');await page.waitForFunction(()=>window.__scene?.ready);
    for(const action of actions){const files=[];for(const t of [0,.6,1.2,1.8,2.4,3]){await page.evaluate(({action,t})=>window.__scene.characterFrame(action,t,Math.PI/2),{action,t});const file=path.join(out,`action-${action}-${t}.png`);await rawCanvas(file);files.push(file);}await contactSheet(files,path.join(out,`action-${action}.png`),{width:240,columns:3,labels:[0,.6,1.2,1.8,2.4,3].map(t=>`${action} ${t}s`)});}
    await page.goto(url);await page.waitForFunction(()=>window.__scene?.ready);
    await page.locator('#play').click();await page.waitForFunction(()=>Number(document.querySelector('#timeline').value)>.05);await page.locator('#play').click();
    await page.locator('#restart').click();assert.equal(await page.locator('#timeline').inputValue(),'0');
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'mobile.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(out,'desktop.png')});
  }
  const raf=await page.evaluate(async()=>{const values=[];let previous;for(let i=0;i<25;i++){const now=await new Promise(requestAnimationFrame);window.__scene.seek(35+i/24);window.__scene.renderer.getContext().finish();if(previous!==undefined)values.push(now-previous);previous=now;}return values.sort((a,b)=>a-b);});
  const timings=[];
  for(const t of [3,9,16,23,35,38,41,43,46,50,53,58]){const ms=await page.evaluate(t=>{const start=performance.now();window.__scene.seek(t);window.__scene.renderer.getContext().finish();return performance.now()-start;},t);timings.push(ms);}
  timings.sort((a,b)=>a-b);report.performance={width:1280,height:720,samples:timings.length,p50ms:timings[Math.floor(timings.length*.5)],p95ms:timings.at(-1),rafP50ms:raf[Math.floor(raf.length*.5)],rafP95ms:raf[Math.floor(raf.length*.95)],timingScope:'CPU submission plus finish; RAF intervals measured separately',hardwareRealtime:'SKIP: software renderer only; target device not available'};
  const anatomy=checkAnatomy();await writeFile(path.join(out,'anatomy.json'),JSON.stringify(anatomy,null,2));assert.equal(anatomy.status,'PASS');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);report.status='PASS';report.scope='Automated checks and implementer evidence, not independent G1/G2/G3 approval';
  console.log(JSON.stringify(report.performance));console.log('PASS cinematic browser, determinism, local-only resources, anatomy, evidence');
}catch(error){report.status='FAIL';report.failure=error.message;throw error;}
finally{
  await writeFile(path.join(out,'browser-report.json'),JSON.stringify(report,null,2)+'\n');
  if(b)await b.close();for(const child of servers){if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;}console.log(`CLEAN owned-pid=${child.pid} waited`);}
  if(owned)await rm(project,{recursive:true,force:true});
}
