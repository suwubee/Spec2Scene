import {AdaptiveQuality,percentile} from './quality.js';

export function startPlayer({state,entry}) {
  const {media}=state, canvas=document.querySelector('canvas');
  const params=new URLSearchParams(location.search);
  if(typeof OffscreenCanvas==='undefined' || typeof Worker==='undefined') throw new Error('当前浏览器不支持后台三维画面；音乐控件仍可使用');
  const width=Number(params.get('w')||params.get('width')||1280),height=Number(params.get('h')||params.get('height')||720);
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<160||width>4096||height<90||height>2160) throw new Error('预览尺寸超出范围');
  const adaptive=new AdaptiveQuality(params.get('quality')||'auto');
  const choice=document.querySelector('#quality'),hud=document.querySelector('#hud'),renderStatus=document.querySelector('#render-status');
  const subtitle=document.querySelector('#subtitle'),subtitleToggle=document.querySelector('#subtitles'),slider=document.querySelector('#timeline');
  let ready=false,busy=true,disposed=false,dirty=true,raf=0,lastPresent=null,lastHUD=0,startedAt=0;
  let applied=adaptive.level;
  const frames=[],completed=[],compiles=[];
  const taskStats={supported:PerformanceObserver.supportedEntryTypes?.includes('longtask')||false,scope:'main thread PerformanceObserver; worker render latency is reported separately',warmup:{count:0,over200:0,maxMs:0},playback:{count:0,over200:0,maxMs:0},paused:{count:0,over200:0,maxMs:0}};
  const phases=[{at:0,phase:'warmup'}];
  const phase=()=>{const value=!state.warm?.done?'warmup':media.paused?'paused':'playback';if(phases.at(-1).phase!==value)phases.push({at:performance.now(),phase:value});};
  for(const e of ['play','pause'])media.addEventListener(e,phase);
  const observer=taskStats.supported?new PerformanceObserver(list=>{for(const e of list.getEntries()){const p=phases.findLast(p=>p.at<=e.startTime)?.phase||'warmup',bucket=taskStats[p];bucket.count++;if(e.duration>200)bucket.over200++;bucket.maxMs=Math.max(bucket.maxMs,e.duration);}}):null;
  observer?.observe({type:'longtask',buffered:true});state.longTasks=taskStats;
  const warmText=w=>`预热 ${Math.round(w.progress*100)}% · 场景 ${w.scenes}/${w.sceneTotal} · 程序 ${w.programs}/${w.programTotalEstimated?'≈':''}${w.programTotal??'?'} · 步 ${w.steps}/${w.total}`;
  Object.assign(state,{quality:adaptive.level,choice:adaptive.choice,frames,compiles,changes:adaptive.history,dropped:0,firstFrameMs:null,fps:null,p90:null,programs:[],qualitySwitches:[],qualityRebuilds:0,lastFps:null,lastP90:null});
  canvas.width=width;canvas.height=height;
  const display=canvas.getContext('bitmaprenderer');
  if(!display)throw new Error('当前浏览器不支持后台画面显示');
  const worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
  const offscreen=new OffscreenCanvas(width,height);
  worker.postMessage({type:'init',canvas:offscreen,width,height,quality:adaptive.level,module:new URL(entry.dataset.runtime,location.href).href},[offscreen]);
  choice.value=adaptive.choice;
  choice.addEventListener('change',()=>{adaptive.select(choice.value);state.choice=adaptive.choice;dirty=true;});
  subtitleToggle.addEventListener('change',()=>{subtitle.hidden=!subtitleToggle.checked;});
  const fail=message=>{ready=false;busy=false;state.onWarmError?.(message);state.errors.push(message);renderStatus.textContent=`画面错误：${message}`;};
  worker.addEventListener('error',event=>fail(event.message));
  worker.addEventListener('message',({data})=>{
    if(data.type==='error') {fail(data.message);return;}
    if(data.type==='progress') {state.warm=data.warm;renderStatus.textContent=warmText(data.warm);state.show?.();return;}
    if(data.type==='compile') {compiles.push(data);if(compiles.length>100)compiles.shift();return;}
    if(data.type==='ready') {ready=true;busy=false;dirty=true;state.capabilities=data.capabilities;state.shots=data.shots;state.diagnostics=data.diagnostics;return;}
    if(data.type==='frame') {
      state.renderSize=[data.bitmap.width,data.bitmap.height];
      if (Number.isFinite(data.programs)) state.programs.push({at:performance.now(),quality:data.quality,count:data.programs});
      state.qualityRebuilds=data.rebuilds||0;state.diagnostics=data.diagnostics;state.memory=data.memory;state.internalSize=data.internalSize;
      state.qualitySwitches=data.diagnostics?.switches||[];
      if(state.programs.length>2400)state.programs.shift();
      state.warm=data.warm;
      display.transferFromImageBitmap(data.bitmap);
      const now=performance.now(),ms=now-startedAt;
      if(data.warm?.done&&!state.warmPresented){state.warmPresented=true;adaptive.resetSampling();lastPresent=null;state.onWarmReady?.();phase();}
      busy=false;state.firstFrameMs ??= now;state.lastRenderedTime=data.t;state.quality=applied;
      const row={at:now,t:data.t,ms,quality:applied,kind:data.cold?'cold':'steady'};
      frames.push(row);if(frames.length>2400) frames.shift();
      if(!media.paused && !document.hidden) {
        completed.push(now);if(completed.length>600)completed.shift();
        // Completion-to-completion includes GPU and scheduling; exclude idle paused time.
        if(lastPresent!==null && data.warm?.done) adaptive.sample(Math.max(ms,now-lastPresent),now);
        lastPresent=now;
      }
      renderStatus.textContent=data.warm?.done?`${data.shot} · 实时画面`:warmText(data.warm);
    }
  });
  for(const e of ['seeking','loadedmetadata']) media.addEventListener(e,()=>{dirty=true;});
  const resetSampling=()=>{lastPresent=null;completed.length=0;adaptive.resetSampling();};
  for(const e of ['play','pause']) media.addEventListener(e,resetSampling);
  document.addEventListener('visibilitychange',resetSampling);
  function tick(now) {
    if(disposed)return;
    const t=media.currentTime;slider.value=t;
    const line=(state.shots||[]).find(s=>t>=s.start&&t<s.end);
    subtitle.textContent=line?.caption||'';subtitle.hidden=!subtitleToggle.checked;
    if(now-lastHUD>250) {
      const recent=completed.filter(at=>at>now-4000),duration=recent.length>1?(now-recent[0])/1000:0;
      state.fps=duration>0?(recent.length-1)/duration:null;
      if(state.fps!==null)state.lastFps=state.fps;
      state.p90=percentile(frames.filter(f=>f.at>now-4000).map(f=>f.ms));
      if(state.p90!==null)state.lastP90=state.p90;
      const shownFps=state.fps??state.lastFps;
      const rate=media.paused?'已暂停':shownFps===null?'正在测量帧率':`${shownFps.toFixed(shownFps<1?2:1)} fps`;

      hud.textContent=`${adaptive.choice==='auto'?'自动 · ':''}${{high:'高',medium:'中',low:'低'}[state.quality]} · ${rate}${state.p90===null?'':` · p90 ${state.p90.toFixed(1)} ms`}${state.renderSize?` · ${state.renderSize.join('×')}`:''}${state.memory?` · 常驻≈${state.memory.totalMB} MB（纹理 ${state.memory.textureMB} / 几何 ${state.memory.geometryMB} / RT ${state.memory.renderTargetMB}）`:''}`;
      lastHUD=now;
    }
    if(ready&&!busy) {
      if(!state.warm?.done || dirty || !media.paused) {
        busy=true;dirty=false;startedAt=performance.now();applied=adaptive.level;
        worker.postMessage({type:state.warm?.done?'frame':'warm',t,quality:applied});
      }
    } else if(ready&&!media.paused) state.dropped++;
    raf=requestAnimationFrame(tick);
  }
  raf=requestAnimationFrame(tick);
  // No __scene in real time: frame tools must explicitly request mode=capture.
  state.dispose=()=>{disposed=true;cancelAnimationFrame(raf);observer?.disconnect();worker.terminate();};
  window.addEventListener('pagehide',state.dispose,{once:true});
}
