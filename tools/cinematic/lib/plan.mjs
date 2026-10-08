// Author: suwubee
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {tree,treeHash} from '../../lib/tree.mjs';
export function finite(value,name,min,max,integer=false){if(!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value)))throw Error(`${name} must be ${integer?'an integer ':''}in [${min},${max}]`);return value;}
export function rangeFrames(start,end,every=1){finite(start,'start',0,1e7,true);finite(end,'end',start+1,1e7,true);finite(every,'every',1,100000,true);if(Math.ceil((end-start)/every)>100000)throw Error('frame count exceeds 100000');return Array.from({length:Math.ceil((end-start)/every)},(_,i)=>start+i*every);}
export async function renderIdentity(root,config){
 if(config.channel && !config.executable)throw Error('--channel requires --chrome for a verifiable browser executable identity');
 const executable=config.executable||chromium.executablePath();
 const executableHash=createHash('sha256').update(await fs.readFile(executable)).digest('hex');
 const files=await tree(path.resolve(root),{runtime:true,includeMedia:true});
 return {version:1,sourceDigest:treeHash(files),executableHash,node:process.versions.node,platform:process.platform,arch:process.arch,...config};
}
export async function checkResume(out,identity,resume){
 const file=path.join(out,'render_identity.json');let previous;
 try{previous=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const hasFrames=(await fs.readdir(out)).some(n=>/^f\d+\.(png|jpg)$/.test(n));
 if(hasFrames&&!resume)throw Error('output contains frames; choose a new output or --resume');
 if(resume&&hasFrames&&!previous)throw Error('resume refused: missing render identity');
 if(resume&&previous&&JSON.stringify(previous)!==JSON.stringify(identity))throw Error('resume refused: source/browser/backend/render configuration changed');
 return file;
}
