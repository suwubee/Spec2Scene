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
  let applied=adaptive.level, nextIdleAt=0;
  const frames=[],completed=[],compiles=[];
  Object.assign(state,{quality:adaptive.level,choice:adaptive.choice,frames,compiles,changes:adaptive.history,dropped:0,firstFrameMs:null,fps:null,p90:null,programs:[],qualitySwitches:[],qualityRebuilds:0});
  canvas.width=width;canvas.height=height;
  const display=canvas.getContext('bitmaprenderer');
  if(!display)throw new Error('当前浏览器不支持后台画面显示');
  const worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
  const offscreen=new OffscreenCanvas(width,height);
  worker.postMessage({type:'init',canvas:offscreen,width,height,quality:adaptive.level,module:new URL(entry.dataset.runtime,location.href).href},[offscreen]);
  choice.value=adaptive.choice;
  choice.addEventListener('change',()=>{adaptive.select(choice.value);state.choice=adaptive.choice;dirty=true;});
  subtitleToggle.addEventListener('change',()=>{subtitle.hidden=!subtitleToggle.checked;});
  const fail=message=>{ready=false;busy=false;state.errors.push(message);renderStatus.textContent=`画面错误：${message}`;};
  worker.addEventListener('error',event=>fail(event.message));
  worker.addEventListener('message',({data})=>{
    if(data.type==='error') {fail(data.message);return;}
    if(data.type==='progress') {renderStatus.textContent=data.message;return;}
    if(data.type==='compile') {compiles.push(data);if(compiles.length>100)compiles.shift();return;}
    if(data.type==='ready') {ready=true;busy=false;dirty=true;state.capabilities=data.capabilities;state.shots=data.shots;state.diagnostics=data.diagnostics;return;}
    if(data.type==='idle') {busy=false;nextIdleAt=performance.now()+1000;return;}
    if(data.type==='frame') {
      state.renderSize=[data.bitmap.width,data.bitmap.height];
      if (Number.isFinite(data.programs)) state.programs.push({at:performance.now(),quality:data.quality,count:data.programs});
      state.qualityRebuilds=data.rebuilds||0;
      display.transferFromImageBitmap(data.bitmap);
      const now=performance.now(),ms=now-startedAt;
      busy=false;state.firstFrameMs ??= now;state.lastRenderedTime=data.t;state.quality=applied;
      const row={at:now,t:data.t,ms,quality:applied,kind:data.cold?'cold':'steady'};
      frames.push(row);if(frames.length>2400) frames.shift();
      if(!media.paused && !document.hidden) {
        completed.push(now);if(completed.length>600)completed.shift();
        // Completion-to-completion includes GPU and scheduling; exclude idle paused time.
        if(lastPresent!==null) adaptive.sample(Math.max(ms,now-lastPresent),now);
        lastPresent=now;
      }
      renderStatus.textContent=`${data.shot} · ${data.cold?'场景已准备':'实时画面'}`;
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
      state.p90=percentile(frames.filter(f=>f.at>now-4000).map(f=>f.ms));
      const rate=media.paused?'已暂停':state.fps===null?'正在测量帧率':`${state.fps.toFixed(state.fps<1?2:1)} fps`;
      hud.textContent=`${adaptive.choice==='auto'?'自动 · ':''}${{high:'高',medium:'中',low:'低'}[state.quality]} · ${rate}${state.p90===null?'':` · p90 ${state.p90.toFixed(1)} ms`}${state.renderSize?` · ${state.renderSize.join('×')}`:''}`;
      lastHUD=now;
    }
    if(ready&&!busy) {
      if(!dirty&&frames.length&&now>=nextIdleAt) {busy=true;worker.postMessage({type:'idle',t});}
      else if(dirty||!media.paused) {
        busy=true;dirty=false;startedAt=performance.now();applied=adaptive.level;
        worker.postMessage({type:'frame',t,quality:applied});
      }
    } else if(ready&&!media.paused) state.dropped++;
    raf=requestAnimationFrame(tick);
  }
  raf=requestAnimationFrame(tick);
  // No __scene in real time: frame tools must explicitly request mode=capture.
  state.dispose=()=>{disposed=true;cancelAnimationFrame(raf);worker.terminate();};
  window.addEventListener('pagehide',state.dispose,{once:true});
}
