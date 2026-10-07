import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {localServer} from './helpers.mjs';
import {launchBrowser,allowedCpus} from '../cinematic/lib/browser.mjs';
import {contactSheet} from '../contact-sheet.mjs';
const selection=process.argv[3]||null;
const out=path.resolve(process.argv[2]||'out/feedback-browser');await mkdir(out,{recursive:true});
const root=fileURLToPath(new URL('../../',import.meta.url)),report={status:'RUNNING',autoplay:'default',pid:process.pid,errors:[],external:[],frames:[],checks:[],hardware:'SKIP no target hardware',review:'PENDING independent human review'};
let server,browser;
try{
 server=await localServer(root);report.url=server.url;
 browser=await launchBrowser({cpus:allowedCpus().slice(0,2).join(','),nproc:2});report.browser=browser.version();report.backend=browser.mvGL;
 const page=await browser.newPage({viewport:{width:960,height:640}});page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});page.on('request',r=>{if(!r.url().startsWith(server.url))report.external.push(r.url());});
 const rows=[['apartment',[2,9]],['props',[0,2,4]],['glass',[0,4]],['snow',[0,4,8,14,25]],['character&action=sit',[0,1,2,4]],['character&action=sit&view=side',[0,1,2,4]],['character&action=lie',[0,1,2,4]],['character&action=lie&view=side',[0,1,2,4]],['character&action=shout',[0,1,2,4]],['character&action=shout&view=side',[0,1,2,4]],['character&action=contact',[0,1,2,4]],['character&action=contact&view=side',[0,1,2,4]],['lyrics',[2,8]],['lyrics&direction=vertical',[2,8]]];
 for(const [mode,times] of rows){
  if(selection&&!mode.startsWith(selection))continue;
  await page.goto(`${server.url}/tracks/music-video/kits/bench/feedback.html?mode=${mode}`);await page.waitForFunction(()=>window.__scene?.ready||window.__sceneError,{},{timeout:120000});const error=await page.evaluate(()=>window.__sceneError);assert.ok(!error,error);
  const files=[];let expected;
  for(const t of times){const start=Date.now();await page.evaluate(t=>window.__scene.seek(t),t);const info=await page.evaluate(()=>window.__scene.inspect());if(info.anatomy)assert.deepEqual(info.anatomy.errors,[],JSON.stringify(info));assert.equal(info.quality.actual,'high');if(mode.startsWith('lyrics'))assert.equal(info.alphaPixels>0,t===2);
   const file=`${mode.replaceAll(/[=&]/g,'-')}-${t}.png`;await page.screenshot({path:path.join(out,file)});files.push(path.join(out,file));report.frames.push({mode,time:t,file,seekMs:Date.now()-start,info});if(t===times[0])expected=info;
  }
  await page.evaluate(t=>window.__scene.seek(t),times[0]);assert.deepEqual(await page.evaluate(()=>window.__scene.inspect()),expected,`reverse seek ${mode}`);
  const sheet=mode.replaceAll(/[=&]/g,'-')+'-sheet.png';await contactSheet(files,path.join(out,sheet),{columns:times.length,width:480,labels:times.map(t=>`${mode} t=${t}`)});report.checks.push({mode,reverseSeek:'PASS',sheet});
 }
 // Exercise actual cinematic sky/FX shaders beyond six minutes, at bounded preview resolution.
 for(const [kind,query,times] of [['sky','preset=coldNight',[4]],['sky','preset=dawn',[4]],['particles','',[360,600]],['snowfield','',[4,360]]]){
  if(selection&&kind!==selection)continue;
  await page.goto(`${server.url}/tracks/music-video/kits/bench/${kind}.html?w=640&h=360&quality=medium&${query}`);await page.waitForFunction(()=>window.__scene?.ready||window.__sceneError,{},{timeout:180000});assert.ok(!await page.evaluate(()=>window.__sceneError));
  const files=[];for(const t of times){await page.evaluate(t=>window.__scene.seek(t),t);const file=`${kind}-${query.replace('=','-')}-${t}.png`;await page.screenshot({path:path.join(out,file)});files.push(path.join(out,file));report.frames.push({mode:kind,time:t,file});}
  await contactSheet(files,path.join(out,`${kind}-${query.replace('=','-')}-sheet.png`),{columns:times.length,width:640});
 }
 assert.ok(report.frames.length,'selection must match a bench');assert.deepEqual(report.external,[]);assert.deepEqual(report.errors,[]);report.status='PASS';console.log(`PASS ${report.frames.length} browser frames; selection=${selection||'all'}; default autoplay; zero browser errors and external requests`);
}catch(error){report.status='FAIL';report.failure=error.stack;console.error(error);process.exitCode=1;}
finally{if(browser)await browser.close();if(server)await server.close();report.ownedProcessesClosed=true;await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
