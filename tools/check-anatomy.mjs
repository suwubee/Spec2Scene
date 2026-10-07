import {createSkeleton,applyPose,inspectRig,limits,hingeAxis} from '../tracks/music-video/character/rig.js';
import {createCharacter} from '../tracks/music-video/character/index.js';
import {actions,poseAt} from '../tracks/music-video/character/motion.js';
import {cli,isMain,atomic} from './lib/cli.mjs';
export function checkAnatomy({duration=8,hz=60}={}) {
  const failures=[],summary=[];let samples=0;
  for(const action of actions){const rig=createSkeleton();let previous;let checked=0;
    for(let i=0;i<=duration*hz;i++){const t=i/hz,pose=poseAt(action,t);applyPose(rig,pose);const report=inspectRig(rig,pose,previous);samples++;checked++;
      if(report.errors.length)failures.push({action,t,errors:report.errors});previous=report;}
    summary.push({action,samples:checked});}
  const proportions=[];
  for(const body of ['masculine','feminine'])for(const height of [1.55,1.9]){
    const actor=createCharacter({body,height,shoulderWidth:body==='feminine'?.95:1.05});let count=0;
    for(const action of actions){let previous;for(let i=0;i<=duration*30;i++){const t=i/30,pose=actor.update(action,t),r=inspectRig(actor.rig,pose,previous);count++;if(r.errors.length)failures.push({body,height,action,t,errors:r.errors});previous=r;}}
    proportions.push({body,height,samples:count});actor.object.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});
  }
  return {status:failures.length?'FAIL':'PASS',samples,proportions,summary,limits,hingeAxis,failures,
    scope:'Base rig sampled at 60 Hz; four body/height combinations at 30 Hz. Analytic stance coordinates and fixed bone lengths. Visual review and clothing collision still required.'};
}
if(isMain(import.meta.url)) {
  const args=cli({out:{type:'string'}},'Usage: node tools/check-anatomy.mjs [--out report.json]\n人体结构采样；所有动作、铰链方向、限位、骨长、躯干/地面与滑步。');
  if(args){const result=checkAnatomy();if(args.out)await atomic(args.out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(result.status!=='PASS')process.exitCode=1;}
}
