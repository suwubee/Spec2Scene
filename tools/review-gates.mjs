import {readFile} from 'node:fs/promises';
import {cli,isMain,required} from './lib/cli.mjs';
export function reviewGate(record,gate){
  const order=record.schema===2?['G1','G1b','G2G3','FINAL']:['G1','G2','G3'];
  if(!order.includes(gate))throw new Error('known gate required for review schema');
  if(!record.revision||!record.implementer)throw new Error('revision and implementer required');
  for(const name of order.slice(0,order.indexOf(gate)+1)){
    const g=record.gates?.[name];
    if(!g||g.status!=='PASS')throw new Error(`${name} requires independent PASS`);
    if(!g.reviewer||g.reviewer===record.implementer)throw new Error(`${name}: self-review cannot pass`);
    if(g.revision!==record.revision||!g.reviewedAt||!Array.isArray(g.evidence)||!g.evidence.length||!Array.isArray(g.findings)||!g.findings.length)throw new Error(`${name}: current revision, evidence and signed findings required`);
    if(record.schema===2&&(!g.scope||!g.reviewFile||!g.gateFile))throw new Error(`${name}: scope, reviewFile and gateFile required`);
  }
  return {status:'PASS',gate,revision:record.revision,scope:'Record validation only; reviewer identity and actual inspection remain the orchestrator responsibility.'};
}
if(isMain(import.meta.url)){
  const args=cli({record:{type:'string'},gate:{type:'string'}},'Usage: node tools/review-gates.mjs --record review.json --gate G1|G1b|G2G3|FINAL\nSchema 2 uses the four current gates; legacy records retain G1/G2/G3. 不生成或代签审核结论。');
  if(args)console.log(JSON.stringify(reviewGate(JSON.parse(await readFile(required(args.record,'record'),'utf8')),required(args.gate,'gate'))));
}
