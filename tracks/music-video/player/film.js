import * as THREE from '../engine/vendor/three.module.js';
import {createEngine} from '../engine/core.js';
import {createTimeline,cameraFromShot} from '../engine/timeline.js';
import {PRESETS} from './quality.js';
import {createPreviewEngine} from './preview.js';
import {programCount, createCompileMonitor} from './compile-monitor.js';

const yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0));
async function gpuComplete(renderer) {
  const gl=renderer.getContext(),fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);
  if(!fence) throw new Error('GPU fence unavailable');
  gl.flush();const start=performance.now();
  try {
    for(;;) {
      const status=gl.clientWaitSync(fence,0,0);
      if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED) return;
      if(status===gl.WAIT_FAILED||gl.isContextLost()) throw new Error('GPU context lost');
      if(performance.now()-start>30000) throw new Error('GPU frame exceeded 30 s');
      await new Promise(resolve=>setTimeout(resolve,2));
    }
  } finally {gl.deleteSync(fence);}
}

/** Scene factories receive ctx.playback with the actual preset. Never used for deterministic capture. */
export async function createFilmPlayer({canvas,width,height,quality,shots,scenes,previewScenes=null,world,progress=()=>{},compile=()=>{}}) {
  const timeline=createTimeline(shots),ordered=[...timeline.shots].sort((a,b)=>a.t0-b.t0);
  let engine,level,prepared=new Set(),drawn=new Set(),cold=true;
  // Keep the worker-facing report structured-cloneable. The renderer itself is
  // intentionally private; only numeric counts and plain records cross the worker boundary.
  const diagnostics={rebuilds:0,compiles:[],switches:[],programs:[]};
  const monitor={...diagnostics,renderer:null};
  let previousEngine=null;
  async function rebuild(next) {
    const q=PRESETS[next];if(!q)throw new Error('Unknown quality');
    progress(`正在准备${next}画质`);
    const before=engine;
    engine?.dispose();prepared.clear();drawn.clear();level=next;cold=true;
    const usePreview=Boolean(q.simplified&&previewScenes);
    const sets=Object.fromEntries(Object.entries(usePreview?previewScenes:scenes).map(([id,factory])=>[id,{async create(ctx){
      await yieldTask();ctx.playback={...q,simplified:usePreview};
      const inst=await factory(ctx);inst.camera ||= new THREE.PerspectiveCamera(35,ctx.aspect,.05,30000);
      const update=inst.update;
      return {...inst,cameraAt(t,shot){return cameraFromShot(shot,shot.t0+t);},update(t,shot,c){update?.(c.t,c.state,inst.camera,shot,c);}};
    }}]));
    engine=usePreview?await createPreviewEngine({canvas,width,height,timeline,sets,world,preset:q}):await createEngine({canvas,width,height,shots,timeline,sets,world,lyrics:false,quality:q.pipeline,renderScale:q.scale,msaa:q.msaa,
      postOverride:q.dof?{}:{dof:{enabled:false},grain:{amount:0},bloom:{strength:.025},halation:{strength:0},streak:{strength:0}},shutter:1});
    engine.ctx.qualityInfo={...engine.ctx.qualityInfo,...q};
    monitor.renderer=engine.renderer; diagnostics.programs.push({quality:next,count:programCount(engine.renderer)});
    if (before) { diagnostics.rebuilds++; diagnostics.switches.push({from:before.ctx?.qualityInfo?.name || null,to:next,rebuilt:true,definesChanged:false,programsBefore:programCount(before.renderer),programsAfter:programCount(engine.renderer)}); }
    engine.renderer.shadowMap.enabled=q.shadow>0;
  }
  async function prepare(shot) {
    if(prepared.has(shot.set))return false;
    progress(`正在准备镜头 ${shot.id}`);await yieldTask();const start=performance.now();
    const inst=await engine.getSet(shot.set);
    const beforePrograms=programCount(engine.renderer); await engine.renderer.compileAsync(inst.scene,inst.camera); const afterPrograms=programCount(engine.renderer);
    prepared.add(shot.set);
    const measurement={shot:shot.id,set:shot.set,quality:level,ms:performance.now()-start,parallel:engine.renderer.extensions.has('KHR_parallel_shader_compile'),beforePrograms,afterPrograms,newPrograms:beforePrograms===null||afterPrograms===null?null:Math.max(0,afterPrograms-beforePrograms)};
    diagnostics.compiles.push(measurement); compile(measurement);
    return true;
  }
  await rebuild(quality);
  const api={shots,capabilities:{worker:true,parallelShaderCompile:engine.renderer.extensions.has('KHR_parallel_shader_compile'),renderer:engine.qualityInfo.renderer,compileMeasurement:true,qualitySwitchRebuildCheck:'PENDING'}, diagnostics,
    async render(t,next) {
      if(next!==level)await rebuild(next);
      let isCold=cold;cold=false;
      for(const layer of timeline.resolve(t)) {
        isCold=!drawn.has(layer.shot.set)||isCold;
        await prepare(layer.shot);drawn.add(layer.shot.set);
      }
      const result=await engine.seek(t,{sync:false});await gpuComplete(engine.renderer);
      return {t:result.t,shot:result.layers.at(-1).id,cold:isCold,programs:programCount(engine.renderer),quality:level,rebuilds:diagnostics.rebuilds};
    },
    async idle(t) {
      const next=ordered.find(s=>s.t0>t&&s.t0-t<=8&&!prepared.has(s.set));
      if(next)await prepare(next);
    },
    dispose(){engine.dispose();}
  };
  return api;
}
