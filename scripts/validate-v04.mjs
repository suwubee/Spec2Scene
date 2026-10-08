import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {localServer} from '../tools/test/helpers.mjs';
import {launchBrowser,allowedCpus} from '../tools/cinematic/lib/browser.mjs';
import {contactSheet} from '../tools/contact-sheet.mjs';
if(process.argv.includes('--help')){console.log('Usage: node scripts/validate-v04.mjs OUTPUT [cloud,water,rock,mountain,sky,fog,shaft,subtitle,character]\nSCENE_REVIEW_WIDTH/HEIGHT set viewport pixels. SCENE_TEST_PORT_MIN/MAX set assigned loopback ports.');process.exit(0);}
const W=Number(process.env.SCENE_REVIEW_WIDTH||960),H=Number(process.env.SCENE_REVIEW_HEIGHT||540);
if(!Number.isInteger(W)||!Number.isInteger(H)||W<320||W>3840||H<180||H>2160)throw new Error('invalid review size');
const out=path.resolve(process.argv[2]||'out/v04'),selection=process.argv[3];await mkdir(out,{recursive:true});
const root=fileURLToPath(new URL('../',import.meta.url)),report={status:'RUNNING',pid:process.pid,autoplay:'default',backend:'swiftshader',size:[W,H],frames:[],errors:[],external:[],hardware:'SKIP target GPU unavailable',independentReview:'PENDING'};let server,browser;
const digest=b=>createHash('sha256').update(b).digest('hex');
try{
  server=await localServer(root);browser=await launchBrowser({gl:'swiftshader',cpus:allowedCpus().slice(0,2).join(','),nproc:2});report.browser=browser.version();report.port=server.port;
  const page=await browser.newPage({viewport:{width:W,height:H}});page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});page.on('request',r=>{if(!r.url().startsWith(server.url+'/'))report.external.push(r.url());});
  const cases=[['cloud',[0,2,4]],['water',[0,2,4]],['rock',[0]],['mountain',[0,3]],['sky',[0,2,4,6]],['fog',[0,4]],['shaft',[0,1,2,3]],['subtitle',[1,3]],...['sitKnees','hugKnees','blend'].flatMap(action=>['front','side'].map(view=>[`character&action=${action}&view=${view}`,[0,1,2,3,4]]))];
  for(const [mode,times] of cases){
    if(selection&&!selection.split(',').some(s=>mode.startsWith(s)))continue;
    const name=mode.replaceAll(/[=&]/g,'-');await page.goto(`${server.url}/tracks/music-video/kits/bench/v04.html?mode=${mode}&w=${W}&h=${H}${mode==='shaft'?'&quality=final&msaa=4':''}`);
    await page.waitForFunction(()=>window.__scene?.ready||window.__sceneError,null,{timeout:120000});assert.ok(!await page.evaluate(()=>window.__sceneError),await page.evaluate(()=>window.__sceneError));
    const hashes=new Map(),files=[];
    for(const t of times){const start=Date.now();await page.evaluate(t=>window.__scene.seek(t),t);assert.deepEqual(await page.evaluate(()=>window.__scene.errors||[]),[]);const info=await page.evaluate(()=>window.__scene.inspect());if(info.anatomy)assert.deepEqual(info.anatomy.errors,[]);if(mode==='sky'){assert.equal(info.phase,t*25);assert.ok(Math.max(...info.radiance)-Math.min(...info.radiance)<1e-8);}if(mode==='subtitle')assert.ok(info.placements.length&&info.placements.every(p=>p.resolved));
      const png=await page.screenshot(),file=`${name}-${t}.png`;await writeFile(path.join(out,file),png);hashes.set(t,digest(png));files.push(path.join(out,file));report.frames.push({mode,time:t,file,info,elapsedMs:Date.now()-start});
      // A second render at the same time catches first-frame FX state leakage.
      await page.evaluate(t=>window.__scene.seek(t),t);const repeated=await page.screenshot();if(digest(repeated)!==hashes.get(t))await writeFile(path.join(out,`${name}-${t}-repeat-failed.png`),repeated);assert.equal(digest(repeated),hashes.get(t),`same-time pixels ${mode} ${t}`);
    }
    for(const t of [...times].reverse()){await page.evaluate(t=>window.__scene.seek(t),t);const png=await page.screenshot();if(digest(png)!==hashes.get(t))await writeFile(path.join(out,`${name}-${t}-reverse-failed.png`),png);assert.equal(digest(png),hashes.get(t),`reverse pixels ${mode} ${t}`);}
    await contactSheet(files,path.join(out,`${name}-sheet.png`),{columns:Math.min(3,files.length),width:480,labels:times.map(t=>`${mode} ${t}s`)});console.log(`PASS ${mode}: ${times.length} frames; same-time and reverse pixels`);
  }
  assert.ok(report.frames.length);assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);report.status='PASS';
}catch(error){report.status='FAIL';report.failure=error.stack;console.error(error);process.exitCode=1;}
finally{if(browser)await browser.close();if(server)await server.close();report.ownedProcessesClosed=true;await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(report.status);}
