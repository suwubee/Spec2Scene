// Classic script, deliberately dependency-free. Bind sound before loading any renderer.
(() => {
  const entry=document.currentScript;
  const params=new URLSearchParams(location.search);
  const capture=params.get('mode')==='capture'||params.get('quality')==='final';
  const media=document.querySelector('#music'), play=document.querySelector('#play');
  const progress=document.querySelector('#music-progress'), status=document.querySelector('#status');
  const slider=document.querySelector('#timeline');
  const state=window.__player={mode:capture?'capture':'realtime',media,errors:[],buttonReadyMs:0,requested:false};
  let pending=false, failure='';
  const show=()=>{
    let buffered=0;
    for(let i=0;i<media.buffered.length;i++) buffered+=media.buffered.end(i)-media.buffered.start(i);
    const percent=Number.isFinite(media.duration)&&media.duration>0?Math.min(100,Math.floor(buffered/media.duration*100)):0;
    state.bufferedPercent=percent;
    if(Number.isFinite(media.duration)&&media.duration>0)slider.max=media.duration;
    progress.value=percent;
    progress.setAttribute('aria-valuetext',`音乐已缓冲 ${percent}%`);
    play.textContent=failure?'重试播放':!media.paused?'暂停':pending?'取消等待':media.readyState<3?`播放 · 音乐载入 ${percent}%`:'播放';
    status.textContent=failure || (media.readyState<3?`正在载入音乐 ${percent}%${pending?' · 已请求播放':''}`:`${media.currentTime.toFixed(1)} / ${Number.isFinite(media.duration)?media.duration.toFixed(0):'—'} 秒`);
  };
  play.addEventListener('click',()=>{
    failure='';
    if(!media.paused || pending) {pending=false;state.requested=false;media.pause();show();return;}
    if(media.ended) media.currentTime=0;
    state.lastClickAt=performance.now();state.userActivation=navigator.userActivation?.isActive;
    pending=true;state.requested=true;
    // Must stay in this trusted event stack, before imports, promises or scene work.
    const started=media.play();
    started.then(()=>{pending=false;show();}).catch(error=>{
      pending=false;state.requested=false;
      if(error.name!=='AbortError') failure=`无法播放音乐：${error.message}`;
      show();
    });
    show();
  });
  document.querySelector('#restart').addEventListener('click',()=>{media.currentTime=0;});
  slider.addEventListener('input',()=>{media.currentTime=Number(slider.value);});
  for(const event of ['progress','loadedmetadata','canplay','waiting','playing','pause','ended','timeupdate']) media.addEventListener(event,show);
  media.addEventListener('error',()=>{pending=false;state.requested=false;failure='音乐载入失败，请检查音频地址并重新载入页面';show();});
  state.buttonReadyMs=performance.now();play.disabled=false;
  if(capture) {
    media.removeAttribute('src');media.load();
    document.querySelector('.transport').hidden=true;
    document.querySelector('#render-status').hidden=true;
    document.querySelector('#subtitle').hidden=true;
    document.querySelector('#hud').textContent='确定性截图 · 固定高画质';
    import(new URL(entry.dataset.capture,location.href).href).catch(error=>{window.__sceneError=error.stack;status.textContent=error.message;});
  } else {
    media.preload='auto';media.load();show();
    import(new URL('./live.js',entry.src).href).then(({startPlayer})=>startPlayer({state,entry})).catch(error=>{
      state.errors.push(error.message);document.querySelector('#render-status').textContent=`画面无法启动：${error.message}`;
    });
  }
  window.addEventListener('pagehide',()=>media.pause(),{once:true});
})();
