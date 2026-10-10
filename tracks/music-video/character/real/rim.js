/**
 * Outer-edge mask + cold rim for character silhouettes.
 *
 * Rules learned the hard way (character/README "外缘轮廓光"):
 * 1. The mask is drawn from `scene.onBeforeRender`, i.e. at the start of the real main pass, with the camera and target size
 *    of THAT pass. A mask drawn in the set's update() uses a camera that the engine later moves (focus breathing, handheld
 *    shake): mask and picture no longer register and the misregistered band is lit as "outer edge" -> a thick white outline.
 * 2. The mask target always has the main pass size (no fixed 512², no aspect stretch), and is fully cleared every time.
 * 3. Outer edge = 1.5 / 2.6 / 4.2 mask pixels outside the silhouette in one of 8 directions: a ~1.5 px band. Narrow gaps
 *    (< ~4 px, e.g. arm against body) have the figure on both sides and do not count.
 * 4. Rim strength = Σ scene directional lights × lit side × backlight × gain (0.06): a thin cold line when backlit, ~0 when
 *    front-lit, nothing without a directional light. No constant white overlay.
 * 5. Everything is created once (target, materials, program key); per render only uniforms and the target size change.
 *    No state depends on render order; the pass draws nothing until the main pass asks for it.
 */
import * as THREE from '../../engine/vendor/three.module.js';

export const OUTER_EDGE_LAYER = 30;
export const OUTER_EDGE_PROGRAM = 'character-outer-edge-v2';
const HOOKS = Symbol.for('spec2scene.outerEdgeHooks');

const VS_DECL = 'varying vec4 vOClip;\nvarying vec3 vONormV;\n';
const VS_MAIN = 'vOClip = gl_Position;\nvONormV = transformedNormal;\n';
const FS_DECL = `
uniform sampler2D uOMask; uniform vec2 uOTexel; uniform float uOOn; uniform float uRimGain; uniform vec3 uRimTint;
varying vec4 vOClip; varying vec3 vONormV;
float characterOuterEdge(){
  vec2 uv = vOClip.xy / vOClip.w * 0.5 + 0.5; float best = 0.0;
  for (int i = 0; i < 8; i++) { float a = float(i) * 0.785398; vec2 d = vec2(cos(a), sin(a)) * uOTexel;
    float o = (1.0 - texture2D(uOMask, uv + d * 1.5).r) * (1.0 - texture2D(uOMask, uv + d * 2.6).r) * (1.0 - texture2D(uOMask, uv + d * 4.2).r);
    best = max(best, o); }
  return smoothstep(0.35, 0.95, best);
}
`;
const FS_APPLY = `
#if NUM_DIR_LIGHTS > 0
if (uOOn > 0.5 && uRimGain > 0.0) {
  float eg = characterOuterEdge();
  if (eg > 0.0) {
    vec3 nv = normalize(vONormV); if (!gl_FrontFacing) nv = -nv;
    vec2 n2 = nv.xy; float ln = length(n2); n2 = ln > 1e-4 ? n2 / ln : vec2(0.0);
    for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
      vec3 L = directionalLights[i].direction;
      vec2 l2 = L.xy; float ll = length(l2); l2 = ll > 1e-4 ? l2 / ll : vec2(0.0);
      float back = smoothstep(-0.15, 0.75, -L.z);
      float side = mix(smoothstep(-0.1, 0.6, dot(n2, l2)), 1.0, smoothstep(0.75, 0.97, back));
      outgoingLight += directionalLights[i].color * uRimTint * (eg * side * mix(0.08, 1.0, back) * uRimGain);
    }
  }
}
#endif
`;

function isVisible(object) { for (let o = object; o; o = o.parent) if (!o.visible) return false; return true; }
function rootScene(object) { let r = object; while (r?.parent) r = r.parent; return r?.isScene ? r : null; }

/** Inject the outer-edge rim into a lit three material (Standard/Physical/Lambert…). Idempotent; fixed program key. */
export function applyOuterEdgeRim(material, uniforms) {
  if (!material?.isMaterial || material.userData.outerEdgeRim) return material;
  const previousCompile = material.onBeforeCompile, previousKey = material.customProgramCacheKey?.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile?.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + VS_DECL).replace('#include <project_vertex>', '#include <project_vertex>\n' + VS_MAIN);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + FS_DECL).replace('#include <opaque_fragment>', FS_APPLY + '#include <opaque_fragment>');
  };
  material.customProgramCacheKey = () => `${previousKey ? previousKey() : ''}|${OUTER_EDGE_PROGRAM}`;
  material.userData.outerEdgeRim = true;
  material.needsUpdate = true;
  return material;
}

/**
 * Create the pass at actor creation time. `actor.object` is put on OUTER_EDGE_LAYER (in addition to its layers).
 * The pass renders only when installed on a scene and that scene's main pass starts (onBeforeRender).
 */
export function createOuterEdgeMaskPass({actor = null, width = 1, height = 1, layer = OUTER_EDGE_LAYER, rimGain = 0.06, tint = [0.80, 0.90, 1.08]} = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new TypeError('positive mask dimensions required');
  if (!Number.isInteger(layer) || layer < 1 || layer > 31) throw new RangeError('mask layer must be 1..31');
  const target = new THREE.WebGLRenderTarget(width, height, {type: THREE.UnsignedByteType, depthBuffer: true, stencilBuffer: false});
  target.texture.name = 'character-outer-edge-mask'; target.texture.generateMipmaps = false;
  target.texture.minFilter = target.texture.magFilter = THREE.LinearFilter;
  const maskMaterial = new THREE.MeshBasicMaterial({color: 0xffffff, side: THREE.DoubleSide}); maskMaterial.name = 'character-outer-edge-mask';
  const uniforms = {uOMask: {value: target.texture}, uOTexel: {value: new THREE.Vector2(1 / width, 1 / height)}, uOOn: {value: 0}, uRimGain: {value: rimGain}, uRimTint: {value: new THREE.Vector3(...tint)}};
  const clear = new THREE.Color(), size = new THREE.Vector2();
  let busy = false, installedOn = null;
  if (actor?.object) actor.object.traverse(o => o.layers.enable(layer));
  const pass = {target, maskMaterial, uniforms, actor, layer, signature: OUTER_EDGE_PROGRAM, programKey: OUTER_EDGE_PROGRAM, ready: false, renders: 0,
    get installedOn() { return installedOn; },
    /** Materials of the actor get the rim shader (called once at creation by attachOuterEdgePass). */
    applyTo(material) { return applyOuterEdgeRim(material, uniforms); },
    resize(w, h) { if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new TypeError('positive mask dimensions required'); if (target.width !== w || target.height !== h) target.setSize(w, h); uniforms.uOTexel.value.set(1 / w, 1 / h); },
    /** Chain onto scene.onBeforeRender (keeps any previous handler). Installation only; draws nothing. */
    install(scene) {
      if (!scene?.isScene || installedOn === scene) return pass;
      if (installedOn) pass.uninstall();
      if (!scene[HOOKS]) {
        const hooks = [], previous = scene.onBeforeRender;
        scene.onBeforeRender = function (renderer, sc, camera, renderTarget) {
          if (typeof previous === 'function') previous.call(this, renderer, sc, camera, renderTarget);
          for (const fn of hooks.slice()) fn(renderer, sc, camera, renderTarget);
        };
        scene[HOOKS] = hooks;
      }
      scene[HOOKS].push(pass.render);
      installedOn = scene; return pass;
    },
    uninstall() { const hooks = installedOn?.[HOOKS]; if (hooks) { const i = hooks.indexOf(pass.render); if (i >= 0) hooks.splice(i, 1); } installedOn = null; uniforms.uOOn.value = 0; return pass; },
    warm(renderer, scene, camera) { if (renderer?.compile && scene && camera) renderer.compile(scene, camera); pass.ready = true; return pass; },
    /** Main-pass hook: (renderer, scene, camera, renderTarget) exactly as three passes them to scene.onBeforeRender. */
    render(renderer, scene, camera, renderTarget = null) {
      if (busy || !renderer || !scene || !camera?.isCamera || !actor?.object) return pass;
      if (!camera.layers.isEnabled(0)) return pass;                     // FX-only passes (e.g. layer 7) never redraw the mask
      if (!isVisible(actor.object)) { uniforms.uOOn.value = 0; return pass; }
      let w, h;
      if (renderTarget && renderTarget.width) { w = renderTarget.width; h = renderTarget.height; }
      else { renderer.getDrawingBufferSize(size); w = size.x; h = size.y; }
      pass.resize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
      busy = true;
      const prev = {rt: renderer.getRenderTarget(), face: renderer.getActiveCubeFace?.() ?? 0, mip: renderer.getActiveMipmapLevel?.() ?? 0, mask: camera.layers.mask,
        shadow: renderer.shadowMap?.autoUpdate, autoClear: renderer.autoClear, alpha: renderer.getClearAlpha(), bg: scene.background, fog: scene.fog, override: scene.overrideMaterial};
      renderer.getClearColor(clear);
      try {
        camera.layers.set(layer); scene.background = null; scene.fog = null; scene.overrideMaterial = maskMaterial;
        if (renderer.shadowMap) renderer.shadowMap.autoUpdate = false;
        renderer.autoClear = true;
        renderer.setRenderTarget(target); renderer.setClearColor(0x000000, 1); renderer.clear(true, true, true);
        renderer.render(scene, camera);
        pass.renders++;
      } finally {
        camera.layers.mask = prev.mask; scene.background = prev.bg; scene.fog = prev.fog; scene.overrideMaterial = prev.override;
        if (renderer.shadowMap) renderer.shadowMap.autoUpdate = prev.shadow;
        renderer.autoClear = prev.autoClear; renderer.setClearColor(clear, prev.alpha);
        renderer.setRenderTarget(prev.rt, prev.face, prev.mip);
        busy = false;
      }
      uniforms.uOOn.value = 1; actor.object.userData.outerEdgeMask = target.texture; pass.ready = true;
      return pass;
    },
    dispose() { pass.uninstall(); target.dispose(); maskMaterial.dispose(); pass.ready = false; },
  };
  pass.render = pass.render.bind(pass);
  return pass;
}
export const createRimOutlinePass = createOuterEdgeMaskPass;

/**
 * Create the pass for an actor at creation time, put the rim shader on all of its lit materials, and replace
 * actor.beforeRender with a compatibility installer (it never draws: drawing happens in the main pass hook).
 */
export function attachOuterEdgePass(actor, options = {}) {
  if (!actor?.object) throw new TypeError('actor.object is required');
  if (actor.outerEdgePass) return actor.outerEdgePass;
  const pass = createOuterEdgeMaskPass({actor, ...options});
  actor.object.traverse(node => { if (!node.isMesh || !node.material) return; for (const m of Array.isArray(node.material) ? node.material : [node.material]) if (m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial) pass.applyTo(m); });
  actor.outerEdgePass = pass;
  actor.beforeRender = (renderer, scene) => pass.install(scene?.isScene ? scene : rootScene(actor.object));
  actor.installOuterEdge = scene => pass.install(scene?.isScene ? scene : rootScene(actor.object));
  return pass;
}
