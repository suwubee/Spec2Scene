// Dedicated character acceptance: no cinematic engine changes or other task ports.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {browser} from '../lib/browser.mjs';
import {tree,treeHash} from '../lib/tree.mjs';
import {cli,required,run} from '../lib/cli.mjs';
import {actions,handPoses} from '../../tracks/music-video/character/motion.js';
import {checkAnatomy} from '../check-anatomy.mjs';
const args=cli({out:{type:'string'},port:{type:'string',default:'39930'},quick:{type:'boolean'},sequence:{type:'string'}},'Usage: node tools/test/character-browser.mjs --out IGNORED_DIR [--port 39930] [--quick] [--sequence ACTION]\nGray studio, 600x800 frames, front/side action sequences, hands and face; default autoplay.');
if(!args)process.exit(0);
if(args.sequence&&!actions.includes(args.sequence))throw new Error('unknown sequence action');
const root=fileURLToPath(new URL('../../',import.meta.url)),out=path.resolve(required(args.out,'out')),port=Number(args.port);
if(!Number.isInteger(port)||port<39930||port>39939)throw new Error('character ports: 39930–39939');
await run('git',['check-ignore',out],{cwd:root});await mkdir(out,{recursive:false});
const report={status:'RUNNING',autoplay:'default',frames:[],errors:[],external:[],review:'PENDING independent review',assetRegression:'SKIP: no licensed user GLB/glTF/VRM was supplied; synthetic mappings tested separately',hardware:'SKIP: SwiftShader only'};
const projectName=`character-review-${process.pid}`,project=path.join(root,'projects',projectName);let generated=false,server,b;
sharp.concurrency(1);
try{
 await run('bash',['scripts/new-project.sh','music-video',projectName],{cwd:root});generated=true;
 const runtime=await tree(path.join(project,'character'),{runtime:true});report.characterDigest=treeHash(runtime);await writeFile(path.join(out,'character-manifest.json'),JSON.stringify(runtime,null,2));
 const projectTest=await run('npm',['test'],{cwd:project});await writeFile(path.join(out,'project-test.txt'),projectTest.stdout);report.projectTest='PASS';
 server=spawn(process.execPath,['tools/serve.mjs','--root',project,'--port',String(port)],{cwd:root,stdio:['ignore','pipe','pipe']});
 let stderr='';server.stderr.on('data',c=>stderr+=c);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server startup timeout')),10000);server.once('error',e=>{clearTimeout(timer);reject(e);});server.once('exit',()=>{clearTimeout(timer);reject(new Error(stderr));});server.stdout.on('data',c=>{if(c.toString().includes('READY')){clearTimeout(timer);resolve();}});});
 report.serverPid=server.pid;console.log(`READY owned-pid=${server.pid} port=${port}`);
 const url=`http://127.0.0.1:${port}`;
 b=await browser({args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--renderer-process-limit=1']});report.browser=b.version();
 const page=await b.newPage({viewport:{width:900,height:960}});
 page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});page.on('response',r=>{if(r.status()>=400)report.errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);});page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(url+'/'))report.external.push(r.url());});
 await page.goto(url+'/character/review.html');await page.waitForFunction(()=>window.__characterReview?.ready,null,{timeout:60000});
 const frame=async(name,options)=>{
  const start=performance.now();const metrics=await page.evaluate(options=>window.__characterReview.frame(options),options);
  assert.deepEqual(metrics.anatomy.errors,[],`${name} anatomy`);
  const data=await page.evaluate(()=>window.__characterReview.capture()),buffer=Buffer.from(data.split(',')[1],'base64');
  await writeFile(path.join(out,name+'.png'),buffer);report.frames.push({file:name+'.png',options,ms:performance.now()-start,calls:metrics.calls,triangles:metrics.triangles});return buffer;
 };
 const sheet=async(name,frames,labels,columns=8)=>{
  const layers=[];
  for(let i=0;i<frames.length;i++){
   const left=(i%columns)*600,top=Math.floor(i/columns)*832,file=path.join(out,frames[i]+'.png');
   const meta=await sharp(file).metadata();assert.equal(meta.width,600);assert.equal(meta.height,800);
   const label=labels[i].replace(/[<>&]/g,'');
   layers.push({input:file,left,top},{input:Buffer.from(`<svg width="600" height="32"><rect width="600" height="32" fill="#eee"/><text x="10" y="23" font-size="18" font-family="sans-serif">${label}</text></svg>`),left,top:top+800});
  }
  await sharp({create:{width:columns*600,height:Math.ceil(frames.length/columns)*832,channels:3,background:'#858585'}}).composite(layers).png().toFile(path.join(out,name+'.png'));
  await sharp(path.join(out,name+'.png')).resize({width:Math.min(columns*600,1600)}).png().toFile(path.join(out,name+'-preview.png'));
 };
 const base=await frame('determinism-forward',{action:'walk',t:1.3});await frame('determinism-away',{action:'pushWindow',t:2.4,handPose:'carry'});assert.ok(base.equals(await frame('determinism-reverse',{action:'walk',t:1.3})));
 await page.reload();await page.waitForFunction(()=>window.__characterReview?.ready);assert.ok(base.equals(await frame('determinism-fresh',{action:'walk',t:1.3})));report.determinism={status:'PASS',sha256:createHash('sha256').update(base).digest('hex')};
 if(!args.sequence){
 const turn=[],turnLabels=[];
 for(const [angle,label] of [[0,'front'],[Math.PI/2,'side']])for(const body of ['feminine','masculine'])for(const coatStyle of ['long','cloak','short','body']){
  const coat=coatStyle!=='body',name=`turn-${label}-${body}-${coatStyle}`;await frame(name,{angle,body,coat,coatStyle:coat?coatStyle:'long'});turn.push(name);turnLabels.push(`${label} ${body} ${coatStyle}`);
 }
 await sheet('turntable-front-side',turn,turnLabels,8);
 for(const body of ['feminine','masculine']){const ids=turn.map((v,i)=>v.includes(body)?i:-1).filter(i=>i>=0);await sheet(`turntable-${body}`,ids.map(i=>turn[i]),ids.map(i=>turnLabels[i]),4);}
 const orbit=[];for(let i=0;i<8;i++){const name=`turntable-${i*45}`;await frame(name,{angle:i*Math.PI/4});orbit.push(name);}await sheet('turntable-eight-directions',orbit,orbit.map((_,i)=>`${i*45} deg`));
 }
 for(const action of args.sequence?[args.sequence]:args.quick?['walk','pushWindow']:actions){
  const clips=(!args.quick&&['walk','lanternWalk','pushDoor','pushWindow','windWalk'].includes(action))?[false,true]:[false];
  for(const coat of clips){const frames=[],labels=[];
   for(const [angle,view] of [[0,'front'],[action==='lanternWalk'?-Math.PI/2:Math.PI/2,'side']])for(let i=0;i<8;i++){
    const t=['walk','windWalk','lanternWalk','bagWalk'].includes(action)?i*(.9/.38)/8:action==='stop'?1.3+i*.28:i*3/7;
    const name=`${action}-${coat?'coat':'body'}-${view}-${i}`;await frame(name,{action,t,angle,coat});frames.push(name);labels.push(`${view} ${action} ${t.toFixed(3)}s`);
   }
   await sheet(`action-${action}-${coat?'coat':'body'}`,frames,labels);console.log(`CAPTURE ${action} ${coat?'coat':'body'} 8 x front/side`);
  }
 }
 if(!args.sequence){
 const face=[],faceLabels=[];for(const body of ['feminine','masculine'])for(const [angle,label] of [[0,'front'],[Math.PI/4,'three-quarter'],[Math.PI/2,'side']]){const name=`face-${body}-${label}`;await frame(name,{angle,body,detail:'face'});face.push(name);faceLabels.push(`${body} ${label}`);}await sheet('face-closeups',face,faceLabels,3);
 const hair=[],hairLabels=[];for(const hairStyle of ['shoulder','ponytail','bun'])for(const [angle,label] of [[0,'front'],[Math.PI/2,'side'],[Math.PI,'back']]){const name=`hair-${hairStyle}-${label}`;await frame(name,{angle,hairStyle,detail:'face'});hair.push(name);hairLabels.push(`${hairStyle} ${label}`);}await sheet('hair-styles',hair,hairLabels,3);
 const shoes=[];for(const [angle,label] of [[0,'front'],[Math.PI/2,'side']]){const name=`shoe-${label}`;await frame(name,{angle,detail:'shoe'});shoes.push(name);}await sheet('shoe-closeups',shoes,['front','side'],2);
 }
 const props=[],propLabels=[];for(const [angle,label] of [[0,'front'],[Math.PI/2,'side']])for(const prop of ['lantern','bag','cup','phone']){const name=`prop-${prop}-${label}`;await frame(name,{angle:prop==='lantern'&&label==='side'?-Math.PI/2:angle,prop});props.push(name);propLabels.push(`${prop} ${label}`);}await sheet('prop-poses',props,propLabels,4);
 // Each action has eight consecutive times, in both far and medium-long shots.
 for(const action of args.sequence?[args.sequence]:args.quick?['lanternWalk']:actions)for(const coatStyle of (args.quick||!['walk','lanternWalk','windWalk'].includes(action))?['long']:['long','cloak']){
  const frames=[],labels=[];
  for(const distance of ['far','medium'])for(let i=0;i<8;i++){
   const t=['walk','windWalk','lanternWalk','bagWalk'].includes(action)?i*(.9/.38)/8:action==='stop'?1.3+i*.28:i*3/7;
   const name=`snow-${action}-${coatStyle}-${distance}-${i}`;await frame(name,{action,coatStyle,t,angle:-Math.PI/3,stage:'snow',distance,wind:1.1,prop:action==='lanternWalk'?'lantern':'none',hairStyle:coatStyle==='cloak'?'bun':'ponytail'});frames.push(name);labels.push(`${action} ${coatStyle} ${distance} ${t.toFixed(3)}s`);
  }
  await sheet(`silhouette-${action}-${coatStyle}`,frames,labels);console.log(`CAPTURE snow ${action} ${coatStyle} 8 x far/medium`);
 }
 if(!args.sequence){
 const hands=[],labels=[];for(const angle of [Math.PI/2,0])for(const handPose of ['relaxed','carry','open','touch','smooth']){const name=`hand-${angle!==0?'front':'side'}-${handPose}`;await frame(name,{angle,detail:'hand',handPose,handView:angle!==0?'palm':'side'});hands.push(name);labels.push(`${angle!==0?'front':'side'} ${handPose}`);}await sheet('hand-closeups',hands,labels,5);
 }
 // Inspect real GPU-skinned joint positions and repeat gestures after reverse seek.
 for(const handPose of Object.keys(handPoses)){await page.evaluate(handPose=>window.__characterReview.frame({handPose}),handPose);}
 report.render=await page.evaluate(()=>{const r=window.__characterReview.renderer,gl=r.getContext(),e=gl.getExtension('WEBGL_debug_renderer_info');return {renderer:e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),frame:[600,800]};});
 if(!args.quick&&!args.sequence){const anatomy=checkAnatomy();await writeFile(path.join(out,'anatomy.json'),JSON.stringify(anatomy,null,2));assert.equal(anatomy.status,'PASS');report.anatomy='PASS';}
 await page.goto(url);await page.waitForFunction(()=>window.__scene?.ready,null,{timeout:60000});
 for(const t of [0,15,35,50]){await page.evaluate(t=>window.__scene.seek(t),t);}report.sampleIntegration='PASS: generated sample seeks at 0, 15, 35 and 50 seconds';
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);report.status='PASS';console.log(`PASS character browser; ${report.frames.length} full-size frames`);
}catch(e){report.status='FAIL';report.failure=e.stack;throw e;}
finally{
 if(b)await b.close();if(server&&server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;console.log(`CLEAN owned-pid=${server.pid} waited`);}
 if(generated)await rm(project,{recursive:true,force:true});
 await writeFile(path.join(out,'browser-report.json'),JSON.stringify(report,null,2)+'\n');
}
