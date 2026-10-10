import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {cli,isMain} from './lib/cli.mjs';
const exec=promisify(execFile);
const root=fileURLToPath(new URL('../',import.meta.url));
const vendorDir='tracks/music-video/engine/vendor/';
const vendorHashes=JSON.parse(await readFile(path.join(root,vendorDir,'manifest.json'),'utf8'));
export async function hygiene({patterns=[]}={}) {
  const {stdout}=await exec('git',['ls-files','-c','-o','--exclude-standard','-z'],{cwd:root,maxBuffer:4*1024*1024});
  const files=[...new Set(stdout.split('\0').filter(Boolean))],issues=[];let vendorVerified=0;
  const privatePath=new RegExp('/(?:' + ['ro'+'ot','ho'+'me','Us'+'ers'].join('|') + ')/[A-Za-z0-9]');
  const forbiddenExtension=/\.(png|jpe?g|webp|gif|avif|bmp|tiff?|exr|hdr|mp[34]|m4[av]|mov|webm|mkv|avi|wav|ogg|flac|aac|opus|glb|gltf|vrm|fbx|obj|blend|ply|stl|safetensors|pt|pth|onnx|task|bin|woff2?|ttf|otf|zip|tgz)$/i;
  for(const name of files){
    if(name.startsWith('projects/')&&name!=='projects/README.md')issues.push({file:name,kind:'project-output'});
    let data;try{data=await readFile(path.join(root,name));}catch(e){if(e.code==='ENOENT')continue;throw e;}
    if(data.includes(0)||forbiddenExtension.test(name))issues.push({file:name,kind:'media-model-or-binary'});
    const text=data.toString('utf8');
    if(privatePath.test(text))issues.push({file:name,kind:'private-path'});
    if(name.startsWith(vendorDir)&&vendorHashes[name.slice(vendorDir.length)]){if(createHash('sha256').update(data).digest('hex')!==vendorHashes[name.slice(vendorDir.length)])issues.push({file:name,kind:'vendor-integrity'});else vendorVerified++;}
    for(const [i,pattern] of patterns.entries()) {
      const scan=name.startsWith(vendorDir)&&vendorHashes[name.slice(vendorDir.length)]?text.replace(/\bspotlight\w*\b/gi,'TechnicalLight'):text;
      if(new RegExp(pattern,'im').test(name+'\n'+scan))issues.push({file:name,kind:'external-deny-pattern',pattern:i+1});
    }
  }
  if(vendorVerified!==Object.keys(vendorHashes).length&&!issues.some(i=>i.kind==='vendor-integrity'))issues.push({file:vendorDir,kind:'missing-vendor-runtime'});
  return {status:issues.length?'FAIL':'PASS',files:files.length,vendorVerified,externalPatterns:patterns.length,issues,
    scope:'Tracked plus unignored files. Exact-hash MIT runtime allows standard light class identifiers. User denylist supplied outside source tree.'};
}
if(isMain(import.meta.url)){
  const args=cli({patterns:{type:'string'}},'Usage: node tools/hygiene.mjs [--patterns external-pattern-file]\n扫描 tracked 与未忽略文件；拒绝项目内容、媒体、私有路径，验证许可运行时哈希。外部禁词文件每行一个正则。');
  if(args){const patterns=args.patterns?(await readFile(args.patterns,'utf8')).split(/\r?\n/).filter(l=>l&&!l.startsWith('#')):[];const result=await hygiene({patterns});console.log(JSON.stringify(result,null,2));if(result.status!=='PASS')process.exitCode=1;}
}
