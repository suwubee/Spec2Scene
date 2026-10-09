// Classic script, deliberately dependency-free. Bind sound before loading any renderer.
(() => {
  const entry=document.currentScript;
  const params=new URLSearchParams(location.search);
  const capture=params.get('mode')==='capture'||params.get('quality')==='final';
  const media=document.querySelector('#music'), play=document.querySelector('#play');
  const progress=document.querySelector('#music-progress'), status=document.querySelector('#status');
  const slider=document.querySelector('#timeline');
  const state=window.__player={mode:capture?'capture':'realtime',media,errors:[],buttonReadyMs:0,requested:false,warm:null,waiting:false};
  let pending=false, failure='', waitTimer=null, unlocking=false;
  const modeSelect=document.querySelector('#startmode');
  if(modeSelect&&['a','b','auto'].includes(params.get('start')))modeSelect.value=params.get('start');
  const warmText=w=>w?`正在准备画面 ${Math.round(w.progress*100)}% · 场景 ${w.scenes}/${w.sceneTotal} · 程序 ${w.programs}/${w.programTotalEstimated?'≈':''}${w.programTotal??'?'} · 步 ${w.steps}/${w.total}`:'正在准备画面…';
  state.warmInfo=()=>state.warm||{done:false,etaMs:null};
  const show=()=>{
    let buffered=0;
    for(let i=0;i<media.buffered.length;i++) buffered+=media.buffered.end(i)-media.buffered.start(i);
    const percent=Number.isFinite(media.duration)&&media.duration>0?Math.min(100,Math.floor(buffered/media.duration*100)):0;
    state.bufferedPercent=percent;
    if(Number.isFinite(media.duration)&&media.duration>0)slider.max=media.duration;
    progress.value=percent;progress.setAttribute('aria-valuetext',`音乐已缓冲 ${percent}%`);
    if(state.waiting){play.textContent='正在准备画面 · 点此直接播放';status.textContent=warmText(state.warm);return;}
    play.textContent=failure?'重试播放':!media.paused?'暂停':pending?'取消等待':media.readyState<3?`播放 · 音乐载入 ${percent}%`:'播放';
    status.textContent=failure||(media.readyState<3?`正在载入音乐 ${percent}%${pending?' · 已请求播放':''}`:`${media.currentTime.toFixed(1)} / ${Number.isFinite(media.duration)?media.duration.toFixed(0):'—'} 秒`);
  };
  state.show=show;
  const playNow=()=>{
    pending=true;state.requested=true;
    const started=media.play();
    started?.then(()=>{pending=false;show();}).catch(error=>{pending=false;state.requested=false;if(error.name!=='AbortError')failure=`无法播放音乐：${error.message}`;show();});
    show();
  };
  const waitForWarm=()=>{
    if(state.warm?.done){playNow();return;}
    state.waiting=true;pending=true;state.requested=true;state.startMode='b';
    const t0=media.currentTime;media.muted=true;unlocking=true;
    // This call remains synchronously inside the trusted click stack. It unlocks
    // the element; the audible play happens from onWarmReady below.
    const unlock=media.play();
    const stop=()=>{unlocking=false;if(!state.waiting)return;media.pause();media.currentTime=t0;media.muted=false;pending=false;show();if(state.warmPresented)state.onWarmReady();};
    unlock.then(stop,error=>{unlocking=false;clearInterval(waitTimer);waitTimer=null;state.waiting=false;media.muted=false;pending=false;state.requested=false;failure=`无法启用声音：${error.message}`;show();});
    waitTimer=setInterval(show,250);show();
  };
  state.onWarmReady=()=>{if(!state.waiting||unlocking)return;clearInterval(waitTimer);waitTimer=null;state.waiting=false;media.muted=false;playNow();};
  state.onWarmError=message=>{if(state.waiting){state.waiting=false;pending=false;state.requested=false;clearInterval(waitTimer);waitTimer=null;media.pause();media.muted=false;failure=`画面准备失败：${message}；可选择立即播放音乐`;show();}};
  const autoMode=()=>{const w=state.warmInfo?.();return w?.done||!(Number.isFinite(w?.etaMs)&&w.etaMs<=20000)?'a':'b';};
  play.addEventListener('click',()=>{
    failure='';state.lastClickAt=performance.now();state.userActivation=navigator.userActivation?.isActive;
    if(state.waiting){clearInterval(waitTimer);waitTimer=null;state.waiting=false;media.muted=false;pending=false;playNow();return;}
    if(!media.paused||pending){pending=false;state.requested=false;media.pause();show();return;}
    if(media.ended)media.currentTime=0;
    const requested=modeSelect?.value||params.get('start');const mode=['a','b'].includes(requested)?requested:autoMode();state.startMode=mode;
    if(mode==='b'&&!state.warm?.done){waitForWarm();return;}
    playNow();
  });
  document.querySelector('#restart').addEventListener('click',()=>{media.currentTime=0;});
  slider.addEventListener('input',()=>{media.currentTime=Number(slider.value);});
  for(const event of ['progress','loadedmetadata','canplay','waiting','playing','pause','ended','timeupdate']) media.addEventListener(event,show);
  media.addEventListener('error',()=>{state.waiting=false;clearInterval(waitTimer);waitTimer=null;media.muted=false;pending=false;state.requested=false;failure='音乐载入失败，请检查音频地址并重新载入页面';show();});
  state.buttonReadyMs=performance.now();play.disabled=false;
  if(capture) {
    media.removeAttribute('src');media.load();
    document.querySelector('.transport').hidden=true;document.querySelector('#render-status').hidden=true;document.querySelector('#subtitle').hidden=true;document.querySelector('#hud').textContent='确定性截图 · 固定高画质';
    import(new URL(entry.dataset.capture,location.href).href).catch(error=>{window.__sceneError=error.stack;status.textContent=error.message;});
  } else {
    media.preload='auto';media.load();show();
    import(new URL('./live.js',entry.src).href).then(({startPlayer})=>startPlayer({state,entry})).catch(error=>{state.errors.push(error.message);document.querySelector('#render-status').textContent=`画面无法启动：${error.message}`;});
  }
  window.addEventListener('pagehide',()=>{clearInterval(waitTimer);media.pause();},{once:true});
})();
