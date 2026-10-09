import * as THREE from '../engine/vendor/three.module.js';
import {createEngine} from '../engine/core.js';
import {createTimeline,cameraFromShot} from '../engine/timeline.js';
import {PRESETS,postForQuality} from './quality.js';
import {programCount,programIdentitySet} from './compile-monitor.js';
import {estimateGpuMemory} from './memory.js';

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


/** One renderer and one resident instance per factory for the lifetime of a page.
 * previewScenes is selected ONCE, for all real-time tiers. Capture has its own entry.
 * Factories allocate their maximum budget, then use applyQuality(q) for runtime knobs.
 */
export async function createFilmPlayer({canvas,width,height,quality='medium',shots,scenes,previewScenes=null,world,progress=()=>{},compile=()=>{}}) {
  if(!PRESETS[quality])throw new Error('Unknown quality');
  const timeline=createTimeline(shots),factories=previewScenes||scenes,instances=new Map(),prepared=new Set();
  let level=quality,current=0,baseline=null,known=new Set(),disposed=false;
  const diagnostics={rebuilds:0,compiles:[],switches:[],programs:[],newPrograms:0,removedPrograms:0,sceneCreates:0};
  const retain=(list,row)=>{list.push(row);if(list.length>600)list.shift();};
  const sets=Object.fromEntries(Object.entries(factories).map(([id,factory])=>[id,{async create(ctx){
    await yieldTask();ctx.playback={...PRESETS.high};
    const inst=await factory(ctx);inst.camera ||= new THREE.PerspectiveCamera(35,ctx.aspect,.05,30000);
    const update=inst.update;
    const wrapped={...inst,cameraAt(t,shot){return cameraFromShot(shot,shot.t0+t);},update(t,shot,c){update?.(c.t,c.state,inst.camera,shot,c);}};
    instances.set(id,wrapped);diagnostics.sceneCreates++;
    return wrapped;
  }}]));
  // Pipeline and sample count are immutable, independent of the initial tier.
  const engine=await createEngine({canvas,width,height,timeline,sets,world,lyrics:false,quality:'final',renderScale:1,msaa:0,shutter:1});
  const renderer=engine.renderer;
  const ids=Object.keys(factories),plan=ids.map(id=>({kind:'scene',id}));
  for(const shot of timeline.shots){
    const times=new Set([shot.t0, (shot.t0+shot.t1)/2,Math.max(shot.t0,shot.t1-.001)]);
    if(shot.dissolve)times.add(shot.t0+shot.dissolve/2);
    for(const t of times)plan.push({kind:'frame',t,shot:shot.id});
  }
  const warm={done:false,phase:'scenes',scenes:0,sceneTotal:ids.length,programs:0,programTotal:null,programTotalEstimated:true,steps:0,total:plan.length,elapsedMs:0,etaMs:null,progress:0};
  const started=performance.now();
  function reportWarm(){
    warm.scenes=instances.size;warm.programs=programCount(renderer);warm.elapsedMs=performance.now()-started;
    warm.progress=warm.done?1:warm.steps/warm.total;
    warm.etaMs=warm.done?0:warm.steps>0?warm.elapsedMs/warm.steps*(warm.total-warm.steps):null;
    warm.programTotal=warm.done?warm.programs:warm.steps?Math.max(warm.programs,Math.ceil(warm.programs/warm.progress)):null;
    warm.programTotalEstimated=!warm.done;
    progress({...warm});return {...warm};
  }
  function materials(){const out=new Map();for(const inst of instances.values())inst.scene.traverse(o=>{for(const m of [o.material,o.customDepthMaterial,o.customDistanceMaterial].flat().filter(Boolean))out.set(m.uuid,{defines:JSON.stringify(m.defines||{}),version:m.version});});return out;}
  function applyTo(inst,q){
    Object.assign(inst.ctx.playback,q);
    inst.scene.traverse(o=>{
      if(o.isLight&&o.shadow&&!o.userData.fixedLightPlaceholder){
        o.shadow.mapSize.setScalar(q.shadow); // Never disable shadowMap/castShadow or discard a bound map.
      }
    });
    inst.applyQuality?.(q,inst.ctx);
  }
  async function applyQuality(next,{record=true,scale=PRESETS[next]?.scale}={}){
    if(!PRESETS[next])throw new Error('Unknown quality');
    const before=materials(),from=level,programsBefore=programCount(renderer);
    const w=Math.max(16,Math.round(width*scale)),h=Math.max(16,Math.round(height*scale));
    if(engine.width!==w||engine.height!==h)await engine.resize(w,h,{renderScale:1});
    for(const inst of instances.values())applyTo(inst,PRESETS[next]);
    level=next;
    if(record&&from!==next){
      const after=materials(),changed=[...before].some(([id,value])=>JSON.stringify(after.get(id))!==JSON.stringify(value));
      retain(diagnostics.switches,{from,to:next,rebuilt:engine.renderer!==renderer,definesChanged:changed,programsBefore,programsAfter:programCount(renderer)});
      if(changed)throw new Error('Quality hook changed shader defines or material version');
    }
  }
  async function prepare(id){
    const inst=await engine.getSet(id);if(prepared.has(id))return inst;
    applyTo(inst,PRESETS[level]);const start=performance.now(),beforePrograms=programCount(renderer);
    inst.scene.userData.fixedLightRig?.update(inst.camera);
    await renderer.compileAsync(inst.scene,inst.camera);prepared.add(id);
    const row={set:id,ms:performance.now()-start,parallel:renderer.extensions.has('KHR_parallel_shader_compile'),beforePrograms,afterPrograms:programCount(renderer)};
    diagnostics.compiles.push(row);compile(row);return inst;
  }
  function observe(t){
    const now=programIdentitySet(renderer),added=[...now].filter(p=>!known.has(p)).length,removed=[...baseline].filter(p=>!now.has(p)).length;
    for(const p of now)known.add(p);diagnostics.newPrograms+=added;diagnostics.removedPrograms=Math.max(diagnostics.removedPrograms,removed);
    retain(diagnostics.programs,{t,count:now.size,newPrograms:added,removedPrograms:removed});
  }
  async function draw(t){
    const result=await engine.seek(t,{sync:false,post:postForQuality(level)});await gpuComplete(renderer);
    if(baseline)observe(t);return result;
  }
  function memory(){return estimateGpuMemory({scenes:[...new Set([...instances.values()].map(i=>i.scene))],renderTargets:[...engine.post.renderTargets,...[...instances.values()].flatMap(i=>{const targets=[];i.scene.traverse(o=>{if(o.shadow?.map)targets.push(o.shadow.map);});return targets;})]});}
  await applyQuality(quality,{record:false});reportWarm();
  const api={shots,diagnostics,warm,capabilities:{worker:true,parallelShaderCompile:renderer.extensions.has('KHR_parallel_shader_compile'),renderer:engine.qualityInfo.renderer,compileMeasurement:true,qualitySwitchRebuildCheck:'enabled',residentScenes:true,msaa:0},
    async render(t,next=level){
      if(disposed)throw new Error('player disposed');
      if(next!==level)await applyQuality(next);
      for(const layer of timeline.resolve(t))await prepare(layer.shot.set);
      const result=await draw(t);current=result.t;
      return {t:result.t,shot:result.layers.at(-1).id,cold:!warm.done,programs:programCount(renderer),quality:level,rebuilds:0,warm:{...warm},diagnostics,memory:memory(),internalSize:{...engine.post.internalSize}};
    },
    async warmStep(t=current,next=level){
      if(warm.done)return api.render(t,next);
      if(next!==level)await applyQuality(next);
      const step=plan[warm.steps],restoreLevel=level;
      warm.phase=step.kind;reportWarm();
      if(step.kind==='scene')await prepare(step.id);
      else {
        for(const layer of timeline.resolve(step.t))await prepare(layer.shot.set);
        const culled=[];for(const inst of instances.values())inst.scene.traverse(o=>{if(o.frustumCulled){culled.push(o);o.frustumCulled=false;}});
        try {
          // Warm enabled and skipped-pass combinations; no need to allocate maximum resolution.
          for(const name of ['high','medium','low']){await applyQuality(name,{record:false,scale:PRESETS[restoreLevel].scale});await draw(step.t);}
        } finally {culled.forEach(o=>o.frustumCulled=true);await applyQuality(restoreLevel,{record:false});}
      }
      for(const layer of timeline.resolve(t))await prepare(layer.shot.set);
      const restoredResult=await draw(t);current=t; // Only this restored frame is ever transferred to the display.
      warm.steps++;
      if(warm.steps===warm.total){warm.done=true;warm.phase='ready';baseline=programIdentitySet(renderer);known=new Set(baseline);}
      reportWarm();
      return {t:restoredResult.t,shot:restoredResult.layers.at(-1)?.id||'empty',cold:true,programs:programCount(renderer),quality:level,rebuilds:0,warm:{...warm},diagnostics,memory:memory(),internalSize:{...engine.post.internalSize}};
    },
    async idle(t){await api.warmStep(t);},
    dispose(){if(disposed)return;disposed=true;for(const inst of instances.values())inst.scene.userData.fixedLightRig?.dispose();engine.dispose();},
  };
  return api;
}
