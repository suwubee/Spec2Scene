import {createCutSafe, hardCuts, warmupTimes, shotStart, shotEnd} from './timing.js';

/** One engine, one frame in flight, all shot resources warmed before playback. */
export async function createResidentPlayer({runtime, canvas, transport, state, progress, present}) {
  const preparationStarted = performance.now();
  const engine = await runtime({canvas});
  transport.setDuration(engine.duration);
  const shots = engine.timeline.shots;
  const cutSafe = createCutSafe(hardCuts(shots), {fps: engine.fps, duration: engine.duration});
  const times = warmupTimes(shots, engine.fps);
  state.engine = engine; state.shots = shots;
  state.warm = {steps: 0, total: times.length, done: false, startedAt: preparationStarted};
  let stopped = false, busy = false, raf = 0, dirty = true;
  try {
    for (const t of times) {
      progress(state.warm);
      await engine.renderFrame(t, {sync: true});
      state.warm.steps++;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await engine.renderFrame(transport.time(), {sync: true});
    state.warm.done = true;
    state.warm.completedAt = performance.now();
    state.warm.ms = state.warm.completedAt - preparationStarted;
    state.warm.programs = engine.renderer.info.programs.length;
    state.warm.scenes = engine.setIds().length;
    state.programBaseline = new Set(engine.renderer.info.programs);
    progress(state.warm);
  } catch (error) { engine.dispose(); throw error; }
  state.frames = []; state.newPrograms = 0;
  async function renderRealtime(t, {sync = false} = {}) {
    const safe = cutSafe(t);
    const result = await engine.renderFrame(safe, {sync});
    state.lastRenderedTime = safe; state.lastClockTime = t;
    state.newPrograms = engine.renderer.info.programs.filter(p => !state.programBaseline.has(p)).length;
    return result;
  }
  async function tick() {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    if (busy || (transport.state.paused && !dirty)) return;
    busy = true; dirty = false;
    try {
      const start = performance.now(), t = transport.time();
      const audioTime = state.media.currentTime, clock = transport.state.clock;
      await renderRealtime(t);
      state.frames.push({t, audioTime, clock, rendered: state.lastRenderedTime, at: performance.now(), ms: performance.now() - start});
      if (state.frames.length > 600) state.frames.shift();
      const shot = shots.find(s => t >= shotStart(s) && t < shotEnd(s)) || shots.at(-1);
      present({t, shot, frames: state.frames});
      if (t >= engine.duration) transport.pause();
    } catch (error) {
      transport.pause(); stopped = true; state.errors.push(error.message); progress({...state.warm, error: error.message});
    } finally { busy = false; }
  }
  raf = requestAnimationFrame(tick);
  return {engine, cutSafe, renderRealtime, refresh() { dirty = true; }, dispose() { stopped = true; cancelAnimationFrame(raf); transport.dispose(); engine.dispose(); }};
}
