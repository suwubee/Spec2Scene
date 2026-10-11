import {createCutSafe, hardCuts, warmupTimes, warmProgress, shotStart, shotEnd} from './timing.js';

/** One engine, one frame in flight, all shot resources warmed before playback.
 * The selected start frame is rendered and shown first (firstPictureMs): the loading screen sits over a
 * real picture with percentage and ETA, never over an empty page. budgetMs flags a slow warm-up.
 */
export async function createResidentPlayer({runtime, canvas, transport, state, progress, present, warmPlan = 'shot', warmKey, budgetMs = 60000}) {
  const preparationStarted = performance.now();
  const engine = await runtime({canvas});
  transport.setDuration(engine.duration);
  const shots = engine.timeline.shots;
  const cutSafe = createCutSafe(hardCuts(shots), {fps: engine.fps, duration: engine.duration});
  const times = warmupTimes(shots, engine.fps, {per: warmPlan, ...(warmKey ? {key: warmKey} : {})});
  state.engine = engine; state.shots = shots;
  state.warm = {steps: 0, total: times.length + 1, done: false, plan: warmPlan, budgetMs, startedAt: preparationStarted, engineMs: performance.now() - preparationStarted, pct: 0, etaMs: null};
  let stopped = false, busy = false, raf = 0, dirty = true;
  const step = () => {
    state.warm.steps++;
    Object.assign(state.warm, warmProgress({steps: state.warm.steps, total: state.warm.total, startedAt: preparationStarted + state.warm.engineMs, now: performance.now()}));
    progress(state.warm);
  };
  try {
    progress(state.warm);
    await engine.renderFrame(cutSafe(transport.time()), {sync: true});   // first picture: what the viewer will see first
    state.warm.firstPictureMs = performance.now() - preparationStarted;
    state.warm.preview = true;
    step();
    for (const t of times) {
      await engine.renderFrame(t, {sync: true});
      step();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await engine.renderFrame(cutSafe(transport.time()), {sync: true});
    state.warm.done = true;
    state.warm.completedAt = performance.now();
    state.warm.ms = state.warm.completedAt - preparationStarted;
    state.warm.overBudget = state.warm.ms > budgetMs;
    state.warm.programs = engine.renderer.info.programs.length;
    state.warm.scenes = engine.setIds().length;
    state.warm.primed = engine.primedSets ? engine.primedSets() : [];   // first sample of each scene rendered twice (engine/first-sample-prime.js)
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
