// Author: suwubee. Engine/kits evidence; character audit belongs to its own validator.
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {startServer} from '../tools/cinematic/serve.mjs';
import {launchBrowser,openMvPage,parseArgs,allowedCpus} from '../tools/cinematic/lib/browser.mjs';
import {FrameSink,seekAndCapture} from '../tools/cinematic/lib/capture.mjs';
import {contactSheet} from '../tools/contact-sheet.mjs';
import {run} from '../tools/lib/cli.mjs';
import {tree,treeHash} from '../tools/lib/tree.mjs';
const a=parseArgs(process.argv.slice(2),['quick','help','benches-only']);
if(a.help){console.log('node scripts/validate-cinematic.mjs [--root projects/NAME] [--out DIR] [--w 1920 --h 1080 --port 39920] [--quick | --benches-only]');process.exit(0);}
const project=path.resolve(a.root||`projects/v03-validation-${process.pid}`);
if(!a.root)await run('bash',['scripts/new-project.sh','music-video',path.basename(project)]);
const out=path.resolve(a.out||path.join(project,'out','cinematic')),W=+(a.w||1920),H=+(a.h||1080);
await fs.mkdir(out,{recursive:true});
const report={status:'RUNNING',pid:process.pid,autoplay:'default',size:[W,H],quality:'final',frames:[],benches:[],errors:[],external:[],review:{G1:'PENDING independent review',G2:'SKIP separate character task',G3:'PENDING independent review'},audio:'SKIP no project music',hardware:'SKIP no target GPU/device'};
const sink=new FrameSink();let server,b;
async function open(pagePath,query='quality=final'){
 const o=await openMvPage(b,{baseUrl:server.url,page:pagePath,query,w:W,h:H,readyTimeout:90000,diag:{echo:'problems'}});
 return o;
}
async function capture(o,t,file){
 const r=await seekAndCapture(o.page,t,{sink});await fs.writeFile(path.join(out,file),await r.encode);
 const errors=await o.page.evaluate(()=>window.__scene?.errors||[]);
 report.external.push(...o.stats.requests.filter(url=>!url.startsWith(server.url+'/')));
 assert.deepEqual([...o.stats.pageErrors,...o.stats.shaderErrors,...o.stats.consoleErrors,...o.stats.failedRequests,...errors],[]);
 return {time:t,file,seekMs:Math.round(r.seekMs)};
}
async function sequence(o,name,times){
 const rows=[];for(const t of times)rows.push(await capture(o,t,`${name}-${String(t).replaceAll('.','_')}.png`));
 await contactSheet(rows.map(r=>path.join(out,r.file)),path.join(out,`${name}-sheet.png`),{columns:2,width:960,labels:rows.map(r=>`${name} ${r.time}s`)});return rows;
}
try{
 report.runtimeDigest=treeHash(await tree(project,{runtime:true,includeMedia:true}));
 server=await startServer({root:project,port:+(a.port||39920),handler:sink.handler});
 b=await launchBrowser({cpus:allowedCpus().slice(0,2).join(','),nproc:2});report.browser=b.version();report.backend=b.mvGL;
 if(!a['benches-only']){
  const o=await open('index.html');report.frames=await sequence(o,'key',[0,6,15,24,29,30.6,35,41,46,50,57,59.9]);
  if(!a.quick){
   report.crane=await sequence(o,'crane',[0,4,8,12,16,20,24,28,29.9]);
   report.dissolve=await sequence(o,'dissolve',[29.9,30,30.2,30.4,30.6,30.8,31,31.2]);
   report.rain=await sequence(o,'rain',[35,35+1/24,35+2/24,35+3/24,35+4/24,35+5/24,35+6/24,35+7/24]);
  }
  const times=[];for(const t of [4,15,28,36,47,58]){const r=await seekAndCapture(o.page,t,{sink});await r.encode;times.push(r.seekMs);}times.sort((x,y)=>x-y);
  report.performance={warmSeekMs:times,p50:times[3],max:times.at(-1),scope:'await seek + GPU readback; shader initialization excluded; software only'};
  await o.page.evaluate(async()=>{await window.__scene.resize(640,360);await window.__scene.seek(15);if(window.__scene.canvas.width!==640)throw Error('resize');});
  report.resize='PASS';await o.page.close();
 }
 for(const kind of (a.quick?[]:a.kits?String(a.kits).split(','):['snowfield','station','river','interior','architecture','garden','vegetation','sky','materials','particles'])){
  const day=['garden','vegetation','materials'].includes(kind)?'&day=1':'';
  const o=await open(`kits/bench/${kind}.html`,'quality=final'+day);
  report.benches.push({...await capture(o,4,`kit-${kind}.png`),kind});await o.page.close();
  console.log(`PASS kit ${kind}`);
 }
 if(report.benches.length)await contactSheet(report.benches.map(r=>path.join(out,r.file)),path.join(out,'kits-sheet.png'),{columns:2,width:960,labels:report.benches.map(r=>r.kind)});
 assert.deepEqual(report.external,[]);report.status='PASS';console.log(JSON.stringify(report));
}catch(e){report.status='FAIL';report.failure=e.stack;process.exitCode=1;console.error(e);}
finally{if(b)await b.close();if(server)await server.close();report.ownedProcessesClosed=true;await fs.writeFile(path.join(out,'browser-report.json'),JSON.stringify(report,null,2)+'\n');}
