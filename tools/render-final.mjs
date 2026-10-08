import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {reviewGate} from './review-gates.mjs';
import {renderFrames} from './render-frames.mjs';
import {cli,isMain,required} from './lib/cli.mjs';
export async function requireFinalReview(recordPath,identity){
  const record=JSON.parse(await readFile(recordPath,'utf8'));reviewGate(record,record.schema===2?'FINAL':'G3');
  if(record.revision!==identity)throw new Error('Final identity must match independently reviewed revision');
  for(const gate of Object.values(record.gates))for(const evidence of [...gate.evidence,...(record.schema===2?[gate.reviewFile,gate.gateFile]:[])]){
    if(typeof evidence!=='string'||!(await stat(path.resolve(path.dirname(recordPath),evidence))).isFile())throw new Error('Review evidence must name an existing file');
  }
  return record;
}
if(isMain(import.meta.url)){
  const args=cli({review:{type:'string'},url:{type:'string'},out:{type:'string'},identity:{type:'string'},fps:{type:'string',default:'24'},count:{type:'string',default:'1440'},width:{type:'string',default:'1280'},height:{type:'string',default:'720'}},
    'Usage: node tools/render-final.mjs --review review.json --url URL --out DIR --identity REVISION [--fps 24 --count 1440 --width 1280 --height 720]\n音乐视频正式渲染要求 schema 2 独立 G1→G1b→G2G3→FINAL（兼容旧 G1–G3）、当前版本和可访问证据；预览用 render-frames.mjs。');
  if(args){await requireFinalReview(required(args.review,'review'),required(args.identity,'identity'));for(const key of ['fps','count','width','height'])args[key]=Number(args[key]);await renderFrames({...args,workers:1});console.log('PASS independently gated final render');}
}
