import {createAudioTransport} from './audio.js';
import {createControls} from './controls.js';
const params = new URLSearchParams(location.search);
const media = document.querySelector('#music'), play = document.querySelector('#play');
const status = document.querySelector('#status'), sound = document.querySelector('#sound');
const slider = document.querySelector('#timeline'), hud = document.querySelector('#hud');
const renderStatus = document.querySelector('#render-status');
const capture = params.get('mode') === 'capture' || params.get('quality') === 'final';
const state = window.__player = {mode: capture ? 'capture' : 'resident', media, errors: [], buttonReadyMs: performance.now()};

if (params.get('player') === 'experimental' && !capture) {
  location.replace(new URL(`./experimental.html${location.search}`, location.href));
} else if (capture) {
  media.removeAttribute('src'); media.load();
  document.querySelector('.transport').hidden = true; renderStatus.hidden = true;
  document.querySelector('#subtitle').hidden = true; hud.textContent = '确定性截图 · 固定高画质';
  import(new URL('../src/main.js', import.meta.url)).catch(error => { window.__sceneError = error.stack; });
} else {
  let player, controls, starting = false;
  document.querySelector('.transport').hidden = false;
  const labels = {loading: '声音载入中…', blocked: '点击启用声音', failed: '声音载入失败 · 点击重试', retry: '声音播放失败 · 点击重试', playing: '声音已启用', paused: '已暂停', ended: '播放结束'};
  const transport = createAudioTransport({media, sources: [media.getAttribute('src'), ...Array.from(media.querySelectorAll('source'), s => s.getAttribute('src'))].filter(Boolean), duration: Number(slider.max), onChange(s) {
    state.sound = s.sound; state.clock = s.clock; controls?.show();
    sound.textContent = labels[s.sound]; sound.hidden = ['playing', 'paused', 'ended'].includes(s.sound);
    play.textContent = starting ? '正在预热镜头…' : s.paused ? '播放' : '暂停';
    const clockLabel = s.paused ? (s.started ? '画面已暂停' : '点击播放后预热') : s.clock === 'audio' ? '音频驱动' : '画面先行，等待声音';
    status.textContent = `${labels[s.sound]} · ${clockLabel}`;
  }});
  state.transport = transport;
  controls = createControls({root: document.querySelector('.transport'), slider, download: document.querySelector('#download'), time: document.querySelector('#time'), transport, refresh: () => player?.refresh(), isWarming: () => starting});
  state.controls = controls;
  function progress(warm) {
    renderStatus.textContent = warm.error ? `画面失败：${warm.error} · 点击播放重试` : warm.done ? `镜头预热完成 ${warm.steps}/${warm.total}` : `正在预热镜头 ${warm.steps}/${warm.total}`;
  }
  async function toggle() {
    if (starting) return;
    state.userActivation = navigator.userActivation?.isActive;
    if (player && !transport.state.paused) { transport.pause(); return; }
    if (transport.time() >= Number(slider.max)) transport.seek(0);
    transport.unlock(); // synchronous play()+pause(), before imports or renderer work
    if (!player) {
      starting = true; play.disabled = true; play.textContent = '正在预热镜头…';
      document.querySelector('.screen').classList.add('warming');
      try {
        const [{createResidentPlayer}, {createRuntime}] = await Promise.all([import('./player.js'), import(new URL('../src/resident-runtime.js', import.meta.url))]);
        player = await createResidentPlayer({runtime: createRuntime, canvas: document.querySelector('canvas'), transport, state, progress, present({t, shot, frames}) {
          controls.present(t);
          document.querySelector('#subtitle').textContent = shot.caption || '';
          const elapsed = (frames.at(-1).at - frames[0].at) / 1000;
          hud.textContent = `${t.toFixed(2)} 秒 · ${elapsed > 0 ? ((frames.length - 1) / elapsed).toFixed(1) : '—'} 绘制 fps`;
        }});
        state.player = player;
        slider.max = player.engine.duration;
        document.querySelector('.screen').classList.remove('warming');
      } catch (error) { state.errors.push(error.message); progress({error: error.message}); return; }
      finally { starting = false; play.disabled = false; play.textContent = '播放'; }
    }
    transport.start(); player.refresh();
  }
  play.disabled = false; play.addEventListener('click', toggle);
  sound.addEventListener('click', () => transport.retry());
  document.querySelector('#restart').addEventListener('click', () => controls.seek(0));
  document.querySelector('#subtitles').addEventListener('change', event => { document.querySelector('#subtitle').hidden = !event.target.checked; });
  for (const name of ['progress', 'loadedmetadata']) media.addEventListener(name, () => {
    let seconds = 0;
    for (let i = 0; i < media.buffered.length; i++) seconds += media.buffered.end(i) - media.buffered.start(i);
    const percent = Number.isFinite(media.duration) && media.duration > 0 ? Math.min(100, seconds / media.duration * 100) : 0;
    const bar = document.querySelector('#music-progress'); bar.value = percent; bar.setAttribute('aria-valuetext', `音乐已缓冲 ${Math.floor(percent)}%`);
  });
  window.addEventListener('keydown', event => {
    if (/INPUT|BUTTON|SELECT|A/.test(event.target.tagName)) return;
    if (event.code === 'Space') { event.preventDefault(); toggle(); }
    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') { event.preventDefault(); controls.seek(transport.time() + (event.code === 'ArrowLeft' ? -5 : 5)); }
  });
  window.addEventListener('pagehide', () => { controls.dispose(); if (player) player.dispose(); else transport.dispose(); }, {once: true});
}
