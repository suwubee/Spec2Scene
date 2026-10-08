import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readdir,stat,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {cli,isMain,required} from './lib/cli.mjs';
const excluded=new Set(['node_modules','.git','out','cache','.venv','__pycache__']);
export async function projectStamp(root){
  const rows=[];
  async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink()||excluded.has(entry.name)||entry.name.endsWith('.log'))continue;const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile()){const s=await stat(file);rows.push(`${path.relative(root,file)}:${s.mtimeMs}:${s.size}`);}}}
  await walk(root);return rows.sort().join('\n');
}
/** Only owns the timeout supervisor PID it spawns. timeout forwards TERM to its own command group. */
export async function watchdog({root,context,report,command,idleSeconds=3600,commandSeconds=7200,pollSeconds=15,restarts=1}){
  if(!command?.length||![idleSeconds,commandSeconds,pollSeconds].every(v=>Number.isFinite(v)&&v>0)||!Number.isInteger(restarts)||restarts<0||restarts>10)throw new Error('invalid watchdog limits');
  if(!(await readFile(context,'utf8')).trim())throw new Error('nonempty restart context required');
  const events=[];let result;
  for(let attempt=0;attempt<=restarts;attempt++){
    const child=spawn('timeout',['--signal=TERM','--kill-after=10s',`${commandSeconds}s`,...command],{cwd:root,stdio:'inherit',env:{...process.env,SCENE_RESTART_CONTEXT:path.resolve(context),SCENE_RESTART_ATTEMPT:String(attempt)}});
    const completion=once(child,'close');let closed=false;child.once('close',()=>closed=true);
    events.push({attempt,pid:child.pid,event:'start'});let stamp=await projectStamp(root),changed=Date.now(),stalled=false;
    const stop=()=>{if(!closed)child.kill('SIGTERM');};process.once('SIGTERM',stop);process.once('SIGINT',stop);
    let timer;
    try{
      while(!closed){await Promise.race([completion,new Promise(r=>timer=setTimeout(r,Math.min(60000,pollSeconds*1000)))]);clearTimeout(timer);if(closed)break;const next=await projectStamp(root);if(next!==stamp){stamp=next;changed=Date.now();}if(Date.now()-changed>=idleSeconds*1000){stalled=true;events.push({attempt,pid:child.pid,event:'stalled',idleSeconds,contextBytes:(await stat(context)).size});stop();break;}}
      const [code,signal]=await completion;events.push({attempt,pid:child.pid,event:'closed',code,signal});result={status:!stalled&&code===0?'PASS':stalled?'STALLED':'FAIL',events};
    }finally{clearTimeout(timer);process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);if(!closed){stop();await completion;}}
    if(report)await writeFile(report,JSON.stringify(result,null,2)+'\n');
    if(!stalled)break;
  }
  return result;
}
if(isMain(import.meta.url)){
  const split=process.argv.indexOf('--'),command=split<0?[]:process.argv.splice(split).slice(1);
  const a=cli({root:{type:'string'},context:{type:'string'},report:{type:'string'},idle:{type:'string',default:'3600'},timeout:{type:'string',default:'7200'},restarts:{type:'string',default:'1'}},'Usage: node tools/watchdog.mjs --root DIR --context FILE --report FILE [--idle 3600 --timeout 7200 --restarts 1] -- COMMAND ARGS\nThe command must consume SCENE_RESTART_CONTEXT on every attempt. Only source changes reset the idle timer.');
  if(a){const result=await watchdog({root:required(a.root,'root'),context:required(a.context,'context'),report:required(a.report,'report'),command,idleSeconds:+a.idle,commandSeconds:+a.timeout,restarts:+a.restarts});console.log(JSON.stringify(result));if(result.status!=='PASS')process.exitCode=1;}
}
