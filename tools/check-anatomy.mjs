import {createSkeleton,applyPose,inspectRig,limits,hingeAxis} from '../tracks/music-video/character/rig.js';
import {createCharacter} from '../tracks/music-video/character/index.js';
import {actions,poseAt,handPoses} from '../tracks/music-video/character/motion.js';
import {cli,isMain,atomic} from './lib/cli.mjs';
export function checkAnatomy({duration=8,hz=60}={}) {
  const failures=[],summary=[];let samples=0;
  const measurements={midStanceKneeDegrees:{min:Infinity,max:0},maxSupportSlipMetres:0,minArmPhaseProduct:Infinity,fingerFlexionDegrees:{min:Infinity,max:0},maxFingerHyperextensionDegrees:0,relaxedMCPDegrees:{index:[],middle:[],ring:[],little:[]}};
  const measure=(rig,pose,report,previous)=>{
    for(const side of ['L','R']){
      const key=side+'leg',g=pose.gait?.[side];
      if(g&&g.settle===0&&g.phase>.14&&g.phase<.46){const degrees=rig.limbs[key].lower.rotation.x*180/Math.PI;measurements.midStanceKneeDegrees.min=Math.min(measurements.midStanceKneeDegrees.min,degrees);measurements.midStanceKneeDegrees.max=Math.max(measurements.midStanceKneeDegrees.max,degrees);}
      if(g&&g.settle===0&&!pose.occupiedArms?.includes(side)&&Math.abs(g.reach)>.035)measurements.minArmPhaseProduct=Math.min(measurements.minArmPhaseProduct,rig.limbs[side+'arm'].upper.rotation.x*g.reach);
      if(previous&&pose.contacts[key]&&previous.contacts[key]&&pose.contactIds[key]===previous.contactIds[key])measurements.maxSupportSlipMetres=Math.max(measurements.maxSupportSlipMetres,Math.hypot(...report.supportPoints[key].map((v,i)=>v-previous.supportPoints[key][i])));
    }
    for(const f of rig.fingers||[])for(const joint of f.joints){const degrees=-joint.rotation.x*180/Math.PI;measurements.fingerFlexionDegrees.min=Math.min(measurements.fingerFlexionDegrees.min,degrees);measurements.fingerFlexionDegrees.max=Math.max(measurements.fingerFlexionDegrees.max,degrees);measurements.maxFingerHyperextensionDegrees=Math.max(measurements.maxFingerHyperextensionDegrees,-degrees);}
    for(const f of rig.fingers||[])if(!f.thumb&&['relaxed','rest'].includes(f.gesture)){
      const list=measurements.relaxedMCPDegrees[['index','middle','ring','little'][f.index-1]],degrees=-f.joints[0].rotation.x*180/Math.PI;
      if(!list.includes(degrees))list.push(degrees);
    }
  };
  for(const action of actions){const rig=createSkeleton();let previous;let checked=0;
    for(let i=0;i<=duration*hz;i++){const t=i/hz,pose=poseAt(action,t);applyPose(rig,pose);const report=inspectRig(rig,pose,previous);samples++;checked++;measure(rig,pose,report,previous);
      if(report.errors.length)failures.push({action,t,errors:report.errors});previous=report;}
    summary.push({action,samples:checked});}
  const proportions=[];
  for(const body of ['masculine','feminine'])for(const height of [1.55,1.9]){
    const actor=createCharacter({body,height,shoulderWidth:body==='feminine'?.95:1.05});let count=0;
    for(const action of actions){let previous;for(let i=0;i<=duration*30;i++){const t=i/30,pose=actor.update(action,t,{deformClothing:false}),r=inspectRig(actor.rig,pose,previous);count++;measure(actor.rig,pose,r,previous);if(r.errors.length)failures.push({body,height,action,t,errors:r.errors});previous=r;}}
    for(const handPose of Object.keys(handPoses)){const pose=actor.update('stand',1,{handPose}),r=inspectRig(actor.rig,pose);measure(actor.rig,pose,r);if(r.errors.length)failures.push({body,height,handPose,errors:r.errors});}
    proportions.push({body,height,samples:count,handPoses:Object.keys(handPoses).length});actor.object.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});
  }
  return {status:failures.length?'FAIL':'PASS',samples,proportions,summary,measurements,limits,hingeAxis,failures,
    scope:'Base rig sampled at 60 Hz; four body/height combinations at 30 Hz. Measured heel/sole/toe anchors, mid-stance knee flexion (0 = straight), unoccupied-arm phase, all finger gestures, explicit 10-degree hyperextension rejection and increasing relaxed MCP flexion. Fixed bone lengths. Clothing deformation is excluded from joint sampling and reviewed in browser sequences. Visual review and clothing collision still required.'};
}
if(isMain(import.meta.url)) {
  const args=cli({out:{type:'string'}},'Usage: node tools/check-anatomy.mjs [--out report.json]\n人体结构采样；所有动作、铰链方向、限位、骨长、躯干/地面与滑步。');
  if(args){const result=checkAnatomy();if(args.out)await atomic(args.out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(result.status!=='PASS')process.exitCode=1;}
}
