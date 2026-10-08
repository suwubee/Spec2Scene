import {characterBounds} from './composition.js';
// Author: suwubee
// engine/core.js — the deterministic film engine. One code path for the real-time player and the
// offline frame renderer: renderFrame(t) is a pure function of t (film seconds).
//
//   const engine = await createEngine({ canvas, width:1920, height:1080, pictureHeight:804, fps:24, quality:'final' });
//   await engine.seek(12.5);      // renders the full composited frame (scene + post + lyrics) and syncs the GPU
import * as THREE from './vendor/three.module.js';
import { createPost, mergePost, DEFAULT_POST } from './post.js';
import { loadSong, loadEvents, createAudio, normalizeSong } from './audio.js';
import { createLyrics, loadFonts } from './lyrics.js';
import { makeRng, hashString, gnoise1, hash11 } from './noise.js';
import { evalCam, applyCamState, evalFocus, handheld, breathe, focalFromFov, fovFromFocal, viewDepth } from './camera.js';
import { lerpParams, hexToLinear, kelvinToLinear, deepMerge } from './util.js';
import {createTimeline} from './timeline.js';
import {resolveQuality} from './core/quality.js';
const TIMELINE = createTimeline([]);

// ---------------------------------------------------------------------------------------------
// Colour language (brief §3) — hex (sRGB) and linear triples for materials / lights.
// ---------------------------------------------------------------------------------------------
const HEX = {
  nightDeep: '#0a1420', nightTeal: '#16303f', moon: '#9fb8d6', moonHi: '#dbe8f5',
  lantern: '#ffb35a', lanternCore: '#ff8a2a', plum: '#f4ece6', plumPink: '#f0c9c9', mist: '#8a9a94',
  duskGold: '#ffcf8a', duskShadow: '#5a5a8a',
};
export const PALETTE = Object.fromEntries(Object.entries(HEX).map(([k, v]) => [k, { hex: v, linear: hexToLinear(v) }]));
PALETTE.kelvin = kelvinToLinear;        // PALETTE.kelvin(2200) -> linear rgb (luminance 1)
PALETTE.lanternK = 2200; PALETTE.moonK = 7800; PALETTE.duskK = 3200;

// ---------------------------------------------------------------------------------------------
// Built-in default world (used when src/world.js is missing or incomplete).
// ---------------------------------------------------------------------------------------------
export const DEFAULT_WORLD_STATE = {
  sunElev: -25, sunAzim: 250, moonElev: 32, moonAzim: 135, moonPhaseGlow: 0.92,
  cloudCover: 0.35, rain: 0.55, mist: 0.5, wind: 0.3, windDir: [1, 0, 0.35],
  bloomAmount: 0.15, petalFall: 0.25, parameters: {}, steam: 0.3,
  skyGrade: null, exposureBias: 0, timeOfDay: 'night',
};
export const defaultWorld = { at: () => ({ ...DEFAULT_WORLD_STATE }), isDefault: true };

export function shotPostAt(state,global,shot,tLocal,override={}){
  const worldPost=deepMerge(state.post||{},state.grade?{grade:state.grade}:{});
  const params=mergePost(worldPost,global||{},typeof shot.post==='function'?shot.post(tLocal,state):shot.post||{},shot.grade?{grade:shot.grade}:{},override);
  params.exposure+=state.exposureBias||0;
  return params;
}

/**
 * ctx.rng — two conventions in one deterministic object:
 *   ctx.rng()            → next float of the Set's private stream (seeded by the set id; use in create() only)
 *   ctx.rng('stars')     → a NEW generator ()=>[0,1) seeded only by the label (LIB_COMMON `rng(seed)` factory):
 *                          identical in every Set → use it for shared world content (sky, terrain, props)
 *   ctx.rng.float/int/pick/chance/normal/fork/shuffle — helpers on the private stream
 */
function ctxRng(setId) {
  const base = makeRng(hashString('set:' + setId));
  const f = (label) => (label === undefined ? base() : makeRng(typeof label === 'number' ? label : hashString(String(label))));
  for (const k of ['float', 'int', 'pick', 'chance', 'sign', 'normal', 'jitter', 'fork', 'shuffle', 'seed']) f[k] = base[k];
  return f;
}

/**
 * createEngine(opts)
 *   canvas, width=1920, height=1080, pictureHeight=round(width/2.388), fps=24, quality='final'|'preview'
 *   timeline (module-like {shots, resolve, globalFade, lyricsConfig, DURATION}) — default ../timeline.js
 *   songUrl, world (object with at(t)) — defaults loaded automatically
 *   lyrics: true/false, msaa: samples (default 4 final, 0 preview), setsBase (URL for set modules)
 */
export async function createEngine(opts = {}) {
  const width = opts.width || 1920;
  const height = opts.height || 1080;
  const pictureHeight = Math.min(height, opts.pictureHeight || Math.round(width / 2.38806));
  const fps = opts.fps || TIMELINE.FPS || 24;
  let quality = opts.quality === 'preview' ? 'preview' : 'final';
  const canvas = opts.canvas || document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const errors = [];

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // post writes display-referred values itself
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.autoClear = true;
  const gl = renderer.getContext();
  const caps = { webgl2: renderer.capabilities.isWebGL2, floatRT: !!gl.getExtension('EXT_color_buffer_float') };
  if (!caps.floatRT) console.warn('[engine] EXT_color_buffer_float missing — HDR targets may fail');

  const qualityInfo = resolveQuality(opts.quality || 'auto', gl);
  quality = qualityInfo.pipeline;
  const timeline = opts.timeline || TIMELINE;
  const [song, world, events] = await Promise.all([
    opts.song ? Promise.resolve(opts.song) : opts.songUrl ? loadSong(opts.songUrl) : Promise.resolve({duration: opts.duration || timeline.DURATION || 60, lines: [], beats: [], sections: []}),
    opts.world ? Promise.resolve(opts.world) : Promise.resolve(defaultWorld),
    opts.events ? Promise.resolve(opts.events) : opts.eventsUrl ? loadEvents(opts.eventsUrl) : Promise.resolve([]),
  ]);
  const audio = createAudio(normalizeSong(song), events);
  const duration = opts.duration || timeline.DURATION || song.duration;
  const frames = Math.ceil(duration * fps - 1e-9);

  let lyrics = null;
  let fontInfo = [];
  if (opts.lyrics === true) {
    const F = await loadFonts(opts.fonts || {});
    fontInfo = F.faces;
    for (const f of F.faces) if (!f.ok) errors.push(`font failed to load: ${f.file}`);
    lyrics = createLyrics({ width, height, pictureHeight, song:opts.alignment||song, config: timeline.lyricsConfig || {}, coverage: F.coverage, onMissing: (m) => errors.push(m) });
  }

  const msaa = opts.msaa ?? qualityInfo.msaa;
  const post = createPost(renderer, { width, height: pictureHeight, canvasWidth: width, canvasHeight: height, quality, msaa, renderScale: opts.renderScale ?? qualityInfo.renderScale, hdrType: opts.hdrType });
  const aspect = width / pictureHeight;

  // ---- shared context handed to every Set ----
  const baseCtx = {
    THREE, renderer, audio, world, quality, width, height, pictureHeight, fps, palette: PALETTE,
    aspect, duration, qualityInfo,
    // per-frame fields (valid inside update()):
    t: 0, frame: 0, state: { ...DEFAULT_WORLD_STATE }, shot: null, tLocal: 0,
    lens: { distance: 10, fstop: 2.8, focal: 35, near: 0.1, far: 1000 },
    // shared uniforms Sets may reference in their own ShaderMaterials (values updated every frame)
    uniforms: {
      uTime: { value: 0 }, uFrame: { value: 0 }, uTLocal: { value: 0 },
      uLens: { value: new THREE.Vector4(10, 0, 0.1, 1000) }, // focus dist (m), CoC scale (px radius @ full-res at ∞), near, far
      uRes: { value: new THREE.Vector2(post.internalSize.width, post.internalSize.height) },
    },
    /** CoC radius in full-res pixels for a view-space depth z (m) — for self-defocusing sprites */
    cocPx(z) { const L = baseCtx.lens; return (L.cocScalePx || 0) * (1 - L.distance / Math.max(1e-3, z)); },
    /** recompute ctx.lens / uLens / cocPx from the camera's CURRENT state (call after moving/zooming it in update()) */
    refreshLens() { return baseCtx.lens; },
    errors,
  };

  // ---- FX layer (post-DOF particles; engine/README.md §2) ----
  const FX_LAYER = 7;
  const fxPassOn = opts.fxPass !== false;
  baseCtx.fxLayer = fxPassOn ? FX_LAYER : undefined;   // particles.js puts its FX objects on this layer
  baseCtx.FX_LAYER = FX_LAYER;
  let fxShared = null;                                  // particles.js shared uniforms (manual soft depth test)
  if (fxPassOn) {
    try {
      const PX = await import('./particles.js');
      if (typeof PX.particlesFX === 'function') { renderer.__mvTHREE = THREE; fxShared = PX.particlesFX(renderer, THREE); }
    } catch (e) { console.info('[engine] particles.js unavailable for the FX pass (', e && e.message, ')'); }
  }

  // ---- Sets: lazy import + lazy create, cached per id; failures reject the render ----
  const setModules = new Map(Object.entries(opts.sets || {}));
  const setInstances = new Map();
  const setsBase = opts.setsBase || new URL('../sets/', import.meta.url).href;
  const reportedSets = new Set();
  function setError(id, what, e) {
    const msg = `[engine] set '${id}' ${what}: ${e && e.message ? e.message : e}`;
    errors.push(msg);
    if (!reportedSets.has(id + what)) { reportedSets.add(id + what); console.error(msg); }
  }
  async function getSet(id) {
    if (setInstances.has(id)) return setInstances.get(id);
    let mod = setModules.get(id);
    let failure = null;
    if (!mod) {
      try { mod = await import(new URL(`${id}.js`, setsBase).href); }
      catch (e) { setError(id, 'failed to import', e); failure = `import failed: ${e && e.message}`; mod = null; }
      setModules.set(id, mod);
    }
    let inst = null;
    if (mod && typeof mod.create === 'function') {
      const ctx = Object.create(baseCtx);   // shares live per-frame fields, own rng
      ctx.rng = ctxRng(id);
      ctx.setId = id;
      try {
        inst = await mod.create(ctx);
        if (!inst || !inst.scene || !inst.camera) throw new Error('create() must return {scene, camera, update}');
        inst.ctx = ctx;
        inst.meta = mod.meta || { id };
        inst.scene.matrixWorldAutoUpdate = true;
        inst.baseFov = inst.camera.fov;
        if (!inst.cameraAt && typeof mod.cameraAt === 'function') inst.cameraAt = mod.cameraAt;   // pure camera(t) (optional)
        inst.cam0 = snapCamera(inst.camera);                                                    // create-time pose
      } catch (e) { setError(id, 'create() failed', e); failure = `create() failed: ${e && e.message}`; inst = null; }
    } else if (mod) { setError(id, 'has no create()', 'missing export'); failure = 'module has no create()'; }
    if (!inst) throw new Error(`Set ${id}: ${failure || 'missing'}`);
    setInstances.set(id, inst);
    return inst;
  }

  async function preload(ids) { for (const id of ids) await getSet(id); }

  const _q = new THREE.Quaternion(), _p = new THREE.Vector3();
  const emptyScene = new THREE.Scene(), emptyCam = new THREE.PerspectiveCamera(30, aspect, 0.1, 10);
  const px1 = new Uint8Array(4);
  const fadeOf = (t) => (timeline.globalFade ? timeline.globalFade(t) : 1);

  // ---- camera state hygiene: every sample starts from the camera's create-time pose (never leftover state) ----
  function snapCamera(c) {
    return { pos: c.position.clone(), quat: c.quaternion.clone(), up: c.up.clone(), fov: c.fov, near: c.near, far: c.far, zoom: c.zoom, mask: c.layers.mask };
  }
  function resetCamera(inst) {
    const c = inst.camera, s0 = inst.cam0;
    if (!s0) return;
    c.position.copy(s0.pos); c.quaternion.copy(s0.quat); c.up.copy(s0.up);
    c.fov = s0.fov; c.near = s0.near; c.far = s0.far; c.zoom = s0.zoom; c.layers.mask = s0.mask; c.aspect = aspect;
    c.updateProjectionMatrix(); c.updateMatrixWorld();
  }
  /** Set-provided camera state {pos, target, fov|focal, roll, up, near, far, focus} → engine camera state */
  function normCamState(cs) {
    const fov = cs.fov !== undefined ? cs.fov : cs.focal !== undefined ? fovFromFocal(cs.focal, aspect) : undefined;
    return { pos: cs.pos, target: cs.target, fov, roll: cs.roll || 0, up: cs.up || [0, 1, 0], near: cs.near, far: cs.far };
  }

  // ---- per-sample helpers ----
  function setFrameTime(tt, frame) {
    baseCtx.t = tt; baseCtx.frame = frame; baseCtx.state = world.at(tt);
    baseCtx.uniforms.uTime.value = tt; baseCtx.uniforms.uFrame.value = frame;
  }
  /** shutter of a shot: {samples, time}; ?shutter=N / opts.shutter overrides samples for every shot */
  let shutterOverride = null;   // per-seek override (seek(t, {shutter})) — diagnostics
  function shutterOf(shot) {
    let sh = shot.shutter ?? timeline.SHUTTER ?? 1;
    if (typeof sh === 'number') sh = { samples: sh };
    const samples = Math.max(1, Math.min(16, Math.round(shutterOverride ?? opts.shutter ?? sh.samples ?? 1)));
    const angle = Math.max(1, Math.min(360, sh.angle ?? 180));
    return { samples, time: angle / 360 / fps };
  }
  /** stratified sample indices (midpoints of N equal sub-intervals), centre-most last */
  function shutterOrder(n) {
    const c = n % 2 ? (n - 1) / 2 : n / 2;
    const out = [];
    for (let k = 0; k < n; k++) if (k !== c) out.push(k);
    out.push(c);
    return out;
  }
  /** Render one scene sample of a layer at film time tt / shot-local tl into post.sceneTarget (+ FX pass if `withFx`). */
  function renderSample(L, Pl, tt, tl, withFx) {
    const shot = L.shot, inst = L.inst, cam = inst.camera, dur = shot.t1 - shot.t0;
    setFrameTime(tt, baseCtx.frame);
    baseCtx.shot = shot; baseCtx.tLocal = tl;
    baseCtx.uniforms.uTLocal.value = tl;
    // 0) start from the create-time pose: no camera state may leak from another frame, shot or sample
    resetCamera(inst);
    // 1) this sample's camera: timeline rig > the Set's pure cameraAt() > create-time pose (Set may refine in update)
    let camSt = null, camFocus = null;
    if (!inst.isPlaceholder) {
      if (shot.cam) camSt = evalCam(shot.cam, tl, dur, aspect);
      else if (inst.cameraAt) {
        const cs = inst.cameraAt(tl, shot, baseCtx);
        if (cs && cs.pos && cs.target) { camSt = normCamState(cs); camFocus = cs.focus || null; }
      }
      if (camSt) {
        applyCamState(THREE, cam, camSt);
        if (camSt.near !== undefined || camSt.far !== undefined) { cam.near = camSt.near ?? cam.near; cam.far = camSt.far ?? cam.far; cam.updateProjectionMatrix(); }
      }
    }
    if (cam.aspect !== aspect) { cam.aspect = aspect; cam.updateProjectionMatrix(); }
    // 2) lens of THIS sample (camera above + focus: shot.focus > Set.focus() > cameraAt().focus > rig target distance)
    //    — published before update() in ctx.lens / ctx.cocPx / uLens; ctx.refreshLens() recomputes it on demand
    const lensFor = () => {
      cam.updateMatrixWorld();
      const fromSet = inst.focus ? inst.focus(tl, shot, baseCtx) : null;
      const dist = camSt ? Math.max(0.1, viewDepth(cam, camSt.target)) : 10;
      const fromShot = evalFocus(shot.focus, tl, cam, undefined);
      return { distance: dist, fstop: 2.8, ...(camFocus || {}), ...(fromSet || {}), ...(fromShot || {}) };
    };
    const breathing = shot.cam?.breathing ?? shot.breathing ?? 0.02;
    const hh = shot.cam?.handheld ?? shot.handheld ?? 0;
    const setLens = (ln) => {
      const fovB = breathe(cam.fov, ln.distance, breathing);
      ln.focal = ln.focal ?? focalFromFov(fovB, aspect, Pl.dof.sensorWidth);
      ln.near = cam.near; ln.far = cam.far;
      const sensorH = Pl.dof.sensorWidth / aspect;
      const S1 = Math.max(ln.distance * 1000, ln.focal * 1.05);
      ln.cocScalePx = ((ln.focal * ln.focal) / (Math.max(0.7, ln.fstop) * (S1 - ln.focal)) / sensorH) * post.internalSize.height * 0.5 * (Pl.dof.scale ?? 1) * (ln.dofScale ?? 1);
      baseCtx.lens = ln;
      baseCtx.uniforms.uLens.value.set(ln.distance, ln.cocScalePx, ln.near, ln.far);
      return fovB;
    };
    let lens = lensFor();
    setLens(lens);
    baseCtx.refreshLens = () => { const ln = lensFor(); setLens(ln); return ln; };   // after a Set moves/zooms the camera
    // 3) Set update (pure function of its local time)
    try { inst.update && inst.update(tl, shot, baseCtx); }
    catch (e) { errors.push(`update ${shot.set}@${tt.toFixed(3)}: ${e.message}`); console.error(e); }
    if (cam.aspect !== aspect) { cam.aspect = aspect; cam.updateProjectionMatrix(); }
    lens = lensFor();
    // 4) temporary lens/camera modifiers: focus breathing + handheld micro-shake
    const fov0 = cam.fov;
    _q.copy(cam.quaternion); _p.copy(cam.position);
    const fovB = setLens(lens);
    if (Math.abs(fovB - fov0) > 1e-9) { cam.fov = fovB; cam.updateProjectionMatrix(); }
    if (hh > 0) {
      const h = handheld(tl + shot.t0 * 0.37, hh, shot.cam?.seed ?? shot.id);
      cam.rotateY(h.yaw); cam.rotateX(h.pitch); cam.rotateZ(h.roll);
      cam.translateX(h.dx); cam.translateY(h.dy); cam.translateZ(h.dz);
    }
    cam.updateMatrixWorld();
    // 5) scene → HDR target (FX layer excluded when the FX pass is on)
    const mask0 = cam.layers.mask;
    if (fxPassOn) cam.layers.disable(FX_LAYER); else cam.layers.enable(FX_LAYER);
    renderer.setRenderTarget(post.sceneTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    renderer.render(inst.scene, cam);
    cam.layers.mask = mask0;
    // 6) FX pass: layer 7 after DOF-independent depth, no MSAA, depth-tested against the scene depth
    const fx = withFx ? renderFxPass(inst.scene, cam) : false;
    if (inst.afterRender) { try { inst.afterRender(tl, shot, baseCtx); } catch (e) { errors.push(e.message); } }
    // 7) restore camera (no state leaks into the next sample/frame)
    cam.quaternion.copy(_q); cam.position.copy(_p);
    if (cam.fov !== fov0) { cam.fov = fov0; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
    return { lens, fovY: fovB, fx };
  }
  /** FX (layer 7) objects → post.fxTarget; returns true if anything was rendered */
  function renderFxPass(scene, cam) {
    if (!fxPassOn) return false;
    let n = 0;
    scene.traverseVisible((o) => { if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && o.layers.isEnabled(FX_LAYER)) n++; });
    if (!n) return false;
    scene.traverse((o) => { if (o.isLight) o.layers.enable(FX_LAYER); });   // lights must be visible to the FX camera mask
    const bg = scene.background, mask0 = cam.layers.mask, sau = renderer.shadowMap.autoUpdate, ac = renderer.autoClear;
    scene.background = null;
    cam.layers.set(FX_LAYER);
    renderer.shadowMap.autoUpdate = false;                // shadow maps from the main pass are still valid
    post.fxBegin();                                       // target = FX RT (cleared), scene depth copied in
    if (fxShared) fxShared.begin(post.depthTexture);      // particles.js: soft manual depth test
    renderer.autoClear = false;
    renderer.render(scene, cam);
    if (fxShared) fxShared.end();
    renderer.autoClear = ac; renderer.shadowMap.autoUpdate = sau; cam.layers.mask = mask0; scene.background = bg;
    return true;
  }

  /**
   * Render the complete frame for film time t into the canvas. Pure function of t.
   * opts: { sync: true (readPixels), lyrics: true, post: {...override}, debug }
   */
  async function renderFrame(t, ropts = {}) {
    if (!Number.isFinite(t)) throw new TypeError('finite scene time required');
    shutterOverride = ropts.shutter ?? null;
    t = Math.min(Math.max(0, t), duration);
    const frame = Math.round(t * fps);
    let layers = ropts.layers || timeline.resolve(t);
    if (!layers.length) layers = [{ shot: { id: 'empty', t0: 0, t1: duration, set: null }, tLocal: t, weight: 1, gain: 1, fade: 1 }];
    for (const L of layers) L.inst = L.shot.set ? await getSet(L.shot.set) : null;

    const state = world.at(t);
    baseCtx.t = t; baseCtx.frame = frame; baseCtx.state = state;
    baseCtx.uniforms.uTime.value = t; baseCtx.uniforms.uFrame.value = frame;
    const multi = layers.length > 1;
    // gate weave (deterministic per frame; the same for every layer of the frame)
    const weave = [0.7 * gnoise1(frame * 0.137, 71) + 0.3 * (hash11(frame, 5) * 2 - 1), 0.7 * gnoise1(frame * 0.113, 73) + 0.3 * (hash11(frame, 9) * 2 - 1)];
    post.begin();
    let P = null, wsum = 0, fovY = 30, gain = 1, lfade = 1;
    for (const L of layers) {
      const shot = L.shot, inst = L.inst;
      const Pl = shotPostAt(state, opts.postOverride, shot, L.tLocal, ropts.post || {});
      if (!inst) {
        renderer.setRenderTarget(post.sceneTarget); renderer.setClearColor(0x000000, 1); renderer.autoClear = true;
        renderer.render(emptyScene, emptyCam);
        post.layer({ lens: null, weight: L.weight, gain: L.gain, params: mergePost(Pl, { dof: { enabled: false } }), frame, multi, fovY: 30, weave });
      } else {
        if (inst.isPlaceholder) Pl.dof.enabled = false;
        // ---- sub-frame motion blur: N scene samples across the shutter, accumulated in linear light ----
        const sh = shutterOf(shot);
        const order = shutterOrder(sh.samples);
        let res = null, color = null;
        for (let i = 0; i < order.length; i++) {
          const dt = sh.samples > 1 ? ((order[i] + 0.5) / sh.samples - 0.5) * sh.time : 0;
          const last = i === order.length - 1;         // the centre-most sample is rendered last: its depth drives DOF,
          res = renderSample(L, Pl, t + dt, L.tLocal + dt, last); // its camera/state drive the FX pass
          if (sh.samples > 1) color = post.accumulateScene(i, sh.samples);
        }
        if (sh.samples > 1) setFrameTime(t, frame);   // leave ctx at the frame's own time
        fovY = res.fovY;
        post.layer({ lens: Pl.dof.enabled === false ? null : res.lens, weight: L.weight, gain: L.gain, params: Pl, frame, multi, color: color || undefined, fx: res.fx, fovY: res.fovY, weave });
      }
      // blend post params across layers by weight
      wsum += L.weight;
      P = P ? lerpParams(P, Pl, L.weight / Math.max(1e-6, wsum)) : Pl;
      gain = L.gain ?? 1; lfade = Math.min(lfade, L.fade ?? 1);
    }
    P = { ...P, fade: (P.fade ?? 1) * fadeOf(t) * lfade };
    if (ropts.debug !== undefined) P.debug = ropts.debug;
    // lyrics overlay (after post, crisp)
    const subjects = lyrics && ropts.lyrics === true ? layers.flatMap(L => L.inst ? characterBounds(L.inst.camera,L.inst.characters || (L.inst.character?.object ? [L.inst.character.object] : [])) : []) : [];
    const lyrBox = lyrics && ropts.lyrics === true ? lyrics.draw(t, {characterBounds:subjects}) : null;
    post.uploadLyrics(lyrics ? lyrics.canvas : null, lyrBox);
    post.finish({ params: P, frame, multi, gain, fovY, weave });
    if (ropts.sync !== false) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1);
    return { t, frame, layers: layers.map((L) => ({ id: L.shot.id, set: L.shot.set, tLocal: L.tLocal, weight: L.weight })) };
  }

  // serialise seeks (the renderer is single-threaded state)
  let chain = Promise.resolve();
  function seek(t, ropts) {
    const p = chain.then(() => renderFrame(t, ropts));
    chain = p.catch(() => {});
    return p;
  }

  /** timing helper: {sceneMs, postMs, totalMs} averaged over n renders of frame t (GPU-synced) */
  async function bench(t, n = 3) {
    await seek(t);
    const now = () => performance.now(); // benchmarking only — never used for rendering
    let tot = 0;
    for (let i = 0; i < n; i++) { const a = now(); await renderFrame(t); tot += now() - a; }
    // post only: re-run the post chain on the existing scene target
    const layers = timeline.resolve(t);
    let postMs = 0;
    const P = mergePost(layers[0].shot.post || {}, layers[0].shot.grade ? { grade: layers[0].shot.grade } : {});
    for (let i = 0; i < n; i++) {
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1);
      const a = now();
      post.begin();
      post.layer({ lens: { ...baseCtx.lens }, weight: 1, gain: 1, params: P, frame: 0, multi: false });
      post.finish({ params: P, frame: 0, multi: false, gain: 1, fovY: 30, weave: [0, 0] });
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1);
      postMs += now() - a;
    }
    await renderFrame(t);
    return { totalMs: tot / n, postMs: postMs / n, sceneMs: tot / n - postMs / n };
  }

  /** detailed per-pass profile of one frame (GPU-synced after every pass; slow, diagnostics only) */
  async function profileFrame(t) {
    await seek(t);
    const now = () => performance.now();
    const prof = {};
    post.profile = prof;
    const origRender = renderer.render.bind(renderer);
    let sceneMs = 0;
    const px = new Uint8Array(4);
    renderer.render = (sc, cam) => {
      if (sc && sc.isScene && renderer.getRenderTarget() === post.sceneTarget) {
        renderer.setRenderTarget(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); renderer.setRenderTarget(post.sceneTarget);
        const a = now(); origRender(sc, cam);
        renderer.setRenderTarget(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        sceneMs += now() - a; renderer.setRenderTarget(post.sceneTarget);
      } else origRender(sc, cam);
    };
    const a = now();
    await renderFrame(t);
    const total = now() - a;
    renderer.render = origRender;
    post.profile = null;
    const postMs = Object.values(prof).reduce((x, y) => x + y, 0);
    return { total, sceneRender: sceneMs, post: postMs, passes: prof, other: total - sceneMs - postMs };
  }

  const engine = {
    profileFrame,
    renderer, canvas, post, audio, song, world, lyrics, timeline, fontInfo, caps, errors,
    width, height, pictureHeight, fps, duration, frames, quality, qualityInfo, ctx: baseCtx,
    seek, renderFrame, bench, getSet, preload,
    setIds() { return [...new Set((timeline.shots || []).map((s) => s.set))]; },
    dispose() {
      for (const inst of setInstances.values()) if (inst && inst.dispose) inst.dispose();
      post.dispose(); lyrics && lyrics.dispose(); renderer.dispose();
    },
  };
  return engine;
}

/** make a one-shot timeline that shows a single Set for the whole film (debug: ?set=<id>) */
export function singleSetTimeline(base, setId, setMeta) {
  const shots = setMeta && Array.isArray(setMeta.shots) && setMeta.shots.length
    ? setMeta.shots.map((s, i) => ({ id: s.id || `${setId}-${i}`, set: setId, ...s }))
    : [{ id: `set:${setId}`, t0: 0, t1: base.DURATION || 1e6, set: setId }];
  return {
    ...base, shots,
    resolve: (t) => base.resolve(t, shots),
    globalFade: () => 1,
    lyricsConfig: base.lyricsConfig,
  };
}
