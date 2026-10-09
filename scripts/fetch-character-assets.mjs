#!/usr/bin/env node
/**
 * Fetch licensed character inputs into one generated project.
 *
 * Nothing is downloaded by npm install or by importing the character module.
 * Every file is written through a temporary sibling, checked with the pinned
 * SHA-256, then renamed into projects/<name>/assets/char or tools.  A Blender
 * export is an explicit final step and runs with --background in the project
 * directory, so it cannot alter a system installation.
 */
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const NAME=/^[a-z][a-z0-9-]{0,62}$/;
export const CHARACTER_ASSET_MANIFEST=Object.freeze({
  blender:{version:'4.5.9',url:'https://download.blender.org/release/Blender4.5/blender-4.5.9-linux-x64.tar.xz',sha256:'dcdc3eca6c9825bb35a8033b689c053f3cb5a9b0cd2a61b2eac2a49436b4ad3d',file:'blender-4.5.9-linux-x64.tar.xz',kind:'tool'},
  mpfb2:{version:'2.0.17',url:'https://github.com/makehumancommunity/mpfb2/archive/refs/tags/v2.0.17.zip',sha256:'d08e726c798fdc4eefb02b06b6c4efe37d40b5439777e53cf96dce0e5073297d',file:'mpfb2-2.0.17.zip',kind:'asset'},
  makehuman:{version:'cc0-2020-09',url:'https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip',sha256:'b542127a8e25547c7c29c19f2d1d2adb9a664c80396ecd694095dbc8028a0107',file:'makehuman_system_assets_cc0.zip',kind:'asset'},
  ual:{version:'standard',url:'https://quaternius.itch.io/universal-animation-library',sha256:'cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724',file:'Universal_Animation_Library-Standard.zip',kind:'asset',signedUrlRequired:true},
});

const sha256=async file=>{const hash=createHash('sha256');const data=await readFile(file);hash.update(data);return hash.digest('hex');};
export function validateProjectPath(project){
  const absolute=path.resolve(ROOT,project||'');const rel=path.relative(path.join(ROOT,'projects'),absolute);const parts=rel.split(path.sep);
  if(!rel||parts.length!==1||!NAME.test(parts[0]))throw new Error('project must be an existing projects/<lowercase-name> directory');
  return absolute;
}
async function ensureProject(project){const dir=validateProjectPath(project);const info=await stat(dir).catch(()=>null);if(!info?.isDirectory())throw new Error(`project does not exist: ${project}`);return dir;}
async function isValid(file,expected){try{return (await sha256(file))===expected;}catch{return false;}}

async function download(entry,dest,{offline=false,force=false}={}){
  await mkdir(path.dirname(dest),{recursive:true});
  if(!force&&await isValid(dest,entry.sha256))return {status:'CACHED',file:dest,sha256:entry.sha256};
  if(offline)throw new Error(`offline and pinned asset is missing or invalid: ${entry.file}`);
  if(entry.signedUrlRequired)throw new Error(`the ${entry.file} source uses a signed download URL; pass --ual-url and --ual-sha256 after checking its CC0 license`);
  const tmp=`${dest}.part-${process.pid}`;await rm(tmp,{force:true});
  const response=await fetch(entry.url,{redirect:'follow',signal:AbortSignal.timeout(900_000)});if(!response.ok)throw new Error(`download ${response.status}: ${entry.url}`);
  const hash=createHash('sha256');const stream=createWriteStream(tmp);try{
    if(!response.body)throw new Error('download returned no body');
    for await(const chunk of response.body){hash.update(chunk);if(!stream.write(chunk))await new Promise(resolve=>stream.once('drain',resolve));}
    await new Promise((resolve,reject)=>{stream.end(resolve);stream.on('error',reject);});
    const actual=hash.digest('hex');if(actual!==entry.sha256)throw new Error(`SHA-256 mismatch for ${entry.file}: expected ${entry.sha256}, got ${actual}`);
    await rename(tmp,dest);return {status:'DOWNLOADED',file:dest,sha256:actual};
  }catch(error){stream.destroy();await rm(tmp,{force:true});throw error;}
}

async function runBlender({blender,input,output,project}){
  if(!blender||!input||!output)throw new Error('--blender, --export-input and --export-output are required for --export');
  const inputAbs=path.resolve(project,input),outputAbs=path.resolve(project,output);if(!inputAbs.startsWith(`${project}${path.sep}`)||!outputAbs.startsWith(`${project}${path.sep}`))throw new Error('export paths must stay inside the project');
  await mkdir(path.dirname(outputAbs),{recursive:true});
  const expression=`import bpy; bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(inputAbs)}); bpy.ops.export_scene.gltf(filepath=${JSON.stringify(outputAbs)},export_format='GLB',export_yup=True,export_apply=False,export_skins=True,export_animations=True)`;
  await new Promise((resolve,reject)=>{const child=spawn(blender,['--background','--factory-startup','--python-expr',expression],{cwd:project,stdio:['ignore','pipe','pipe'],env:{...process.env,BLENDER_USER_RESOURCES:path.join(project,'tools','blender-user')}});let stderr='';child.stderr.on('data',b=>{stderr+=b;});const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Blender export timed out after 900 seconds'));},900_000);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error(`Blender export failed (${code}): ${stderr.slice(-1200)}`));});});
  const digest=await sha256(outputAbs);return {status:'EXPORTED',file:outputAbs,sha256:digest};
}

function help(){console.log(`Usage: scripts/fetch-character-assets.sh --project projects/<name> [options]

Downloads pinned CC0 inputs into the ignored project output:
  --asset blender|mpfb2|makehuman|ual|all   (default: all; UAL needs a signed URL)
  --ual-url URL --ual-sha256 HASH            signed UAL file URL and its pinned hash
  --offline                                  verify existing files only
  --dry-run                                  print the pinned plan without writing
  --export --blender PATH --export-input FILE --export-output FILE
  --selftest                                 validate manifest and path guards
`);}

function args(argv){const out={asset:'all'};for(let i=0;i<argv.length;i++){const a=argv[i];if(a==='--help'||a==='-h')return {help:true};if(a==='--selftest'){out.selftest=true;continue;}if(a==='--offline'||a==='--dry-run'||a==='--force'||a==='--export'){out[a.slice(2).replace('-','')]=true;continue;}if(a.startsWith('--')){const key=a.slice(2).replaceAll('-','');if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error(`value required for ${a}`);out[key]=argv[++i];continue;}throw new Error(`unknown argument ${a}`);}return out;}

export async function main(argv=process.argv.slice(2)){
  const options=args(argv);if(options.help){help();return {status:'HELP'};}
  if(options.selftest){if(Object.keys(CHARACTER_ASSET_MANIFEST).length!==4||Object.values(CHARACTER_ASSET_MANIFEST).some(x=>!/^[a-f0-9]{64}$/.test(x.sha256)))throw new Error('invalid pinned manifest');for(const bad of ['projects/../outside','projects/Bad_Name','/tmp/project'])await import('node:assert/strict').then(({default:assert})=>assert.throws(()=>validateProjectPath(bad)));return {status:'PASS',assets:Object.keys(CHARACTER_ASSET_MANIFEST)};}
  const project=await ensureProject(options.project);if(options.dryrun){return {status:'DRY-RUN',project,plan:Object.entries(CHARACTER_ASSET_MANIFEST).map(([name,x])=>({name,version:x.version,file:x.file,sha256:x.sha256}))};}
  const selected=options.asset==='all'?Object.keys(CHARACTER_ASSET_MANIFEST):[options.asset];if(selected.some(name=>!CHARACTER_ASSET_MANIFEST[name]))throw new Error(`unknown --asset; choose ${Object.keys(CHARACTER_ASSET_MANIFEST).join(', ')}`);
  const results=[],resolvedEntries={};for(const name of selected){let entry=CHARACTER_ASSET_MANIFEST[name];if(name==='ual'&&options.ualurl){if(!/^[a-f0-9]{64}$/.test(options.ualsha256||''))throw new Error('--ual-sha256 must be a 64-character lowercase SHA-256');entry={...entry,url:options.ualurl,sha256:options.ualsha256,signedUrlRequired:false};}resolvedEntries[name]=entry;const destination=entry.kind==='tool'?path.join(project,'tools','downloads',entry.file):path.join(project,'assets','char','downloads',entry.file);results.push(await download(entry,destination,{offline:options.offline,force:options.force}));}
  if(options.export)results.push(await runBlender({blender:options.blender,input:options.exportinput,output:options.exportoutput,project}));
  const licenses=path.join(project,'assets','char','LICENSES.md');await mkdir(path.dirname(licenses),{recursive:true});await writeFile(licenses,`# Character asset records\n\nGenerated by fetch-character-assets.sh. Verify the upstream license again before shipping.\n\n| item | version | SHA-256 | license |\n|---|---|---|---|\n${selected.map(name=>{const x=resolvedEntries[name];return `| ${name} | ${x.version} | ${x.sha256} | ${name==='blender'?'GPL-2.0-or-later (tool)':'CC0 1.0 (asset/output)'} |`;}).join('\n')}\n`);
  return {status:'PASS',project,results,licenses};
}

if(import.meta.url===`file://${process.argv[1]}`){try{const result=await main();if(result.status==='HELP')process.exitCode=0;else console.log(JSON.stringify(result,null,2));}catch(error){console.error(`fetch-character-assets: ${error.message}`);process.exitCode=1;}}
