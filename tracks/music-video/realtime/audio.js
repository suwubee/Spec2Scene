/** Media errors select another source; network time is never a failure criterion. */
export function createAudioTransport({media, sources, duration, onChange = () => {}, now = () => performance.now() / 1000}) {
  if (!Number.isFinite(duration) || duration <= 0) throw new RangeError('Positive film duration required');
  let index = 0, wallT = 0, wallAt = now(), running = false, master = false;
  let pending = false, generation = 0, disposed = false;
  const state = {sound: 'loading', sourceIndex: 0, clock: 'wall', started: false, paused: true, transitions: []};
  const listeners = [];
  const time = () => Math.max(0, Math.min(duration, master ? media.currentTime : wallT + (running ? now() - wallAt : 0)));
  function show(sound) {
    state.sound = sound; state.clock = master ? 'audio' : 'wall'; state.paused = !running;
    if (state.transitions.at(-1)?.sound !== sound || state.transitions.at(-1)?.clock !== state.clock) {
      state.transitions.push({sound, clock: state.clock, t: time()});
      if (state.transitions.length > 100) state.transitions.shift();
    }
    onChange(state);
  }
  function wall() { wallT = time(); wallAt = now(); master = false; }
  function selectSource() {
    generation++; pending = false; master = false;
    state.sourceIndex = index;
    if (!sources[index]) { show('failed'); return; }
    media.src = sources[index]; media.preload = 'auto'; media.load(); show('loading');
  }
  function attempt() {
    if (disposed || !running || master || pending || state.sound === 'failed') return;
    if (media.readyState < 1) { show('loading'); return; }
    const token = generation;
    try {
      media.muted = false;
      if (Math.abs(media.currentTime - time()) > .05) media.currentTime = time();
      pending = true;
      Promise.resolve(media.play()).catch(error => {
        if (disposed || token !== generation || !running) return;
        if (error.name === 'NotAllowedError') show('blocked');
        else if (error.name !== 'AbortError') show('retry');
      }).finally(() => { if (token === generation) pending = false; });
    } catch { pending = false; show('retry'); }
  }
  function listen(type, fn) { media.addEventListener(type, fn); listeners.push([type, fn]); }
  listen('loadedmetadata', attempt);
  listen('canplay', attempt);
  listen('playing', () => {
    if (!running || disposed) { media.pause(); return; }
    // play() can wait on network after metadata. Align at actual takeover too.
    const target = time();
    if (!master && Math.abs(media.currentTime - target) > .08) media.currentTime = target;
    master = true; show('playing');
  });
  listen('waiting', () => { if (running) { wall(); show('loading'); } });
  listen('error', () => { wall(); index++; selectSource(); });
  listen('ended', () => { wallT = duration; master = false; running = false; show('ended'); });
  selectSource();
  return {
    state, time,
    setDuration(value) {
      if (!Number.isFinite(value) || value <= 0) throw new RangeError('Positive film duration required');
      duration = value; wallT = Math.min(wallT, duration);
    },
    // Must be called before the first await inside the trusted click handler.
    unlock() { try { const request = media.play(); media.pause(); request?.catch(() => {}); } catch { show('blocked'); } },
    start() { state.started = true; running = true; wallAt = now(); show(state.sound); attempt(); },
    pause() { wall(); running = false; generation++; pending = false; media.pause(); show(state.sound === 'playing' ? 'paused' : state.sound); },
    seek(t) {
      if (!Number.isFinite(t)) throw new TypeError('Finite time required');
      wallT = Math.max(0, Math.min(duration, t)); wallAt = now();
      if (media.readyState >= 1) media.currentTime = wallT;
      if (running) attempt();
      onChange(state);
    },
    retry() {
      if (state.sound === 'failed') { index = 0; selectSource(); }
      if (state.sound === 'failed') return; // No configured sources: keep the actionable failure visible.
      // Retry also unlocks synchronously when the previous source failed before metadata.
      this.unlock(); master = false; pending = false; generation++; show('loading'); attempt();
    },
    dispose() { disposed = true; generation++; media.pause(); for (const [type, fn] of listeners) media.removeEventListener(type, fn); }
  };
}
