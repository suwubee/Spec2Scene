// Author: suwubee
import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {run} from '../lib/cli.mjs';
import {contactSheet} from '../contact-sheet.mjs';
import {parseArgs} from './lib/browser.mjs';
import {finite,rangeFrames} from './lib/plan.mjs';
const a=parseArgs(process.argv.slice(2),['help']);
if(a.help){console.log('node tools/cinematic/preview.mjs --root projects/NAME --start 0 --end 8 --every 4 --out projects/NAME/out/preview [--fps 24 --w 1920 --h 1080 --port 39920]\nHalf-resolution full-pipeline sparse MP4 + large contact sheet. PREVIEW, NOT FINAL.');process.exit(0);}
if(!a.root||!a.out)throw Error('--root and --out required');
const start=finite(+(a.start||0),'start',0,3600),end=finite(+(a.end||8),'end',start+.01,3600),fps=finite(+(a.fps||24),'fps',1,60),every=finite(+(a.every||4),'every',1,240,true);
const A=Math.round(start*fps),B=Math.round(end*fps),frames=rangeFrames(A,B,every),out=path.resolve(a.out),dir=path.join(out,'frames'),here=path.dirname(fileURLToPath(import.meta.url));
const call=async(file,args)=>{const r=await run(process.execPath,[path.join(here,file),...args]);await fs.writeFile(path.join(out,file+'.log'),r.stdout.toString()+r.stderr);console.log(r.stdout.toString());};
await fs.mkdir(out,{recursive:true});
await call('render_frames.mjs',['--root',a.root,'--out',dir,'--port',String(a.port||39920),'--range',`${A}:${B}`,'--fps',String(fps),'--every',String(every),'--w',String(a.w||1920),'--h',String(a.h||1080),'--scale','.5','--quality','final','--workers','1','--nproc','2','--retries','0']);
await call('encode.mjs',['--frames',dir,'--out',path.join(out,'preview-not-final.mp4'),'--range',`${A}:${B}`,'--fps',String(fps),'--every',String(every),'--threads','2',...(a.audio?['--audio',a.audio]:[])]);
const sample=frames.filter((_,i)=>i%Math.max(1,Math.ceil(frames.length/40))===0);
await contactSheet(sample.map(f=>path.join(dir,`f${String(f).padStart(5,'0')}.png`)),path.join(out,'preview-sheet.png'),{columns:2,width:960,labels:sample.map(f=>`PREVIEW / NOT FINAL — ${(f/fps).toFixed(3)}s`)});
await fs.writeFile(path.join(out,'preview.json'),JSON.stringify({label:'预览非成片',start,end,fps,every,frames:frames.length,scale:.5,audio:a.audio?'project supplied':'SKIP no project audio',file:'preview-not-final.mp4'},null,2)+'\n');
console.log('PASS preview (not final) '+out);
