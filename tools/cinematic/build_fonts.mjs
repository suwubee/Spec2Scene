// Author: suwubee. Port of the text collection, fontTools subset and actual-cmap workflow.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseArgs} from './lib/browser.mjs';
import {isMain} from '../lib/cli.mjs';
export function collectCharacters(values,extra=''){
 const chars=new Set();const add=v=>{if(typeof v==='string')for(const c of v)chars.add(c);else if(Array.isArray(v))v.forEach(add);else if(v&&typeof v==='object')Object.values(v).forEach(add);};
 values.forEach(add);add(extra);for(let c=0x20;c<0x7f;c++)chars.add(String.fromCharCode(c));for(const c of ['\n','\r','\t'])chars.delete(c);return [...chars].sort().join('');
}
export async function buildFonts({config,texts,out,python='python3'}){
 const spec=JSON.parse(await fs.readFile(config,'utf8')),base=path.dirname(path.resolve(config));
 if(!Array.isArray(spec.fonts)||!spec.fonts.length)throw Error('fonts array required');
 const values=await Promise.all(texts.map(async file=>{const text=await fs.readFile(file,'utf8');return file.endsWith('.json')?JSON.parse(text):text;}));
 const text=collectCharacters(values,spec.extra||'');await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'charset.txt'),text);
 const files=[],coverage={};
 for(const F of spec.fonts){
  if(!/^[\w-]+\.woff2$/.test(F.out)||typeof F.family!=='string')throw Error('safe .woff2 name and family required');
  const src=path.resolve(base,F.src),dest=path.join(out,F.out),index=F.index||0;
  const result=spawnSync(python,['-m','fontTools.subset',src,`--font-number=${index}`,`--text-file=${path.join(out,'charset.txt')}`,'--flavor=woff2',`--output-file=${dest}`,'--layout-features=*','--no-hinting','--desubroutinize','--name-IDs=*','--name-languages=*'],{encoding:'utf8'});
  if(result.error||result.status!==0)throw Error(result.error?.message||result.stderr);
  const p=spawnSync(python,['-c',"import json,sys;from fontTools.ttLib import TTFont;print(json.dumps(''.join(sorted(chr(c) for c in TTFont(sys.argv[1]).getBestCmap() if c>=32))))",dest],{encoding:'utf8'});
  if(p.status!==0)throw Error(p.stderr);const key=`${F.family}|${F.weight||400}`;coverage[key]=JSON.parse(p.stdout);
  files.push({family:F.family,weight:String(F.weight||400),file:F.out});
  console.log(`${key}: ${coverage[key].length} glyphs; missing ${[...text].filter(c=>c.trim()&&!coverage[key].includes(c)).join('')}`);
 }
 await fs.writeFile(path.join(out,'fonts.json'),JSON.stringify({files,coverage},null,2)+'\n');return {files,coverage};
}
if(isMain(import.meta.url)){
 const a=parseArgs(process.argv.slice(2),['help','selftest']);
 if(a.selftest){const x=collectCharacters([{lyrics:[{text:'示例',chars:[{c:'声'}]}]}]);if(!x.includes('声')||x.includes('\n'))throw Error('collection failed');console.log('PASS font collection selftest; actual subset requires project fonts');}
 else if(a.help)console.log('node tools/cinematic/build_fonts.mjs --config project/fonts.config.json --text project/song.json,project/titles.json --out project/assets/fonts [--python python3]\nconfig: {fonts:[{src:"user.ttf",out:"serif.woff2",family:"MV Serif",weight:400,index:0}],extra:""}. Requires fonttools+brotli; no fonts bundled.');
 else{if(!a.config||!a.text||!a.out)throw Error('--config --text --out required');await buildFonts({config:a.config,texts:String(a.text).split(','),out:a.out,python:a.python});}
}
