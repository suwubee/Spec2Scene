import * as THREE from './vendor/three.module.js';

export const MOON_DISPLAY_MAX = 0.88;
export const MOON_CLAMP_K = 0.62;
const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const luminance = rgb => Array.isArray(rgb) ? 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] : Number(rgb) || 0;

/** 0 = full moon, 180 = new moon. Invalid values are rejected rather than wrapped. */
export function clampMoonPhase(angle = 0) {
  if (!Number.isFinite(angle)) throw new TypeError('finite moon phase required');
  return clamp(angle, 0, 180);
}

export function moonLitFraction(angle = 0) {
  return (1 + Math.cos(clampMoonPhase(angle) * DEG)) * 0.5;
}

/**
 * Compute a display-safe radiance without mutating the caller's sky options.
 * The cap is intentionally conservative because the disc is followed by
 * halos, bloom and the display transform.
 */
export function clampMoonRadiance({ requested = 28, exposure = 0, transmittance = 1, tint = [1, 1, 1], whiteBalance = [1, 1, 1], max = MOON_DISPLAY_MAX, k = MOON_CLAMP_K } = {}) {
  const trans = Array.isArray(transmittance) ? luminance(transmittance) : transmittance;
  if (![requested, exposure, trans, max, k].every(Number.isFinite)) throw new TypeError('finite moon display parameters required');
  const req = Math.max(0, requested);
  const denominator = Math.max(1e-4, Math.pow(2, exposure) * Math.max(1e-4, trans) * Math.max(1e-4, luminance(tint)) * Math.max(1e-4, luminance(whiteBalance)));
  const cap = Math.max(0, k * max / denominator);
  return { requested: req, effective: Math.min(req, cap), cap, transmittance: trans, tint: luminance(tint), whiteBalance: luminance(whiteBalance) };
}

/** Disc radius and the two halo amplitudes used by both sky and set adapters. */
export function moonDiscParameters({ phase = 0, scale = 1, radiance = 28, exposure = 0, transmittance = 1, tint = [1, 1, 1], whiteBalance = [1, 1, 1], halo = 1 } = {}) {
  const p = clampMoonPhase(phase), display = clampMoonRadiance({ requested: radiance, exposure, transmittance, tint, whiteBalance });
  const lit = moonLitFraction(p), radius = Math.max(0.01, Number(scale) || 1) * 0.2655 * DEG;
  return { phase: p, lit, radius, radiance: display.effective, display, halos: {
    inner: Math.max(0, halo) * display.effective * lit * 0.05,
    outer: Math.max(0, halo) * display.effective * lit * 0.0085,
    innerRadius: 3.5 * DEG,
    outerRadius: 17 * DEG,
  } };
}

/**
 * A small, camera-facing two-layer halo. It is intentionally independent of
 * the procedural lunar texture, so a scene can use it in a preview adapter.
 */
export function createMoonHalo(THREEImpl = THREE, { color = [0.86, 0.9, 1], innerRadius = 3.5 * DEG, outerRadius = 17 * DEG } = {}) {
  if (!THREEImpl?.Vector3) { const options = THREEImpl || {}; THREEImpl = THREE; ({ color = [0.86, 0.9, 1], innerRadius = 3.5 * DEG, outerRadius = 17 * DEG } = options); }
  const uniforms = { uDir: { value: new THREEImpl.Vector3(0, 0.2, -1) }, uColor: { value: new THREEImpl.Color(...color) }, uAmp: { value: new THREEImpl.Vector2() }, uRadius: { value: new THREEImpl.Vector2(innerRadius, outerRadius) }, uDistance: { value: 2000 } };
  const material = new THREEImpl.ShaderMaterial({ uniforms, transparent: true, depthWrite: false, depthTest: true, blending: THREEImpl.AdditiveBlending, toneMapped: false,
    vertexShader: 'uniform vec3 uDir; uniform float uDistance; varying vec3 vWorld; void main(){ vec3 c=cameraPosition+normalize(uDir)*uDistance; vec3 r=vec3(viewMatrix[0][0],viewMatrix[1][0],viewMatrix[2][0]); vec3 u=vec3(viewMatrix[0][1],viewMatrix[1][1],viewMatrix[2][1]); vec3 p=c+(r*position.x+u*position.y)*uDistance*.75; vWorld=p; gl_Position=projectionMatrix*viewMatrix*vec4(p,1.); }',
    fragmentShader: 'uniform vec3 uDir,uColor; uniform vec2 uAmp,uRadius; varying vec3 vWorld; void main(){ vec3 d=normalize(vWorld-cameraPosition); float a=acos(clamp(dot(d,normalize(uDir)),-1.,1.)); float i=uAmp.x*exp(-pow(a/uRadius.x,1.6))+uAmp.y*exp(-pow(a/uRadius.y,2.)); gl_FragColor=vec4(uColor*i,1.); }' });
  const mesh = new THREEImpl.Mesh(new THREEImpl.PlaneGeometry(2, 2), material);
  mesh.name = 'moon-two-layer-halo'; mesh.frustumCulled = false; mesh.renderOrder = 1;
  return { object: mesh, uniforms, update(state = {}, disc, camera) {
    const legacy = arguments.length > 1;
    const { direction = legacy ? (state.moonDir || [0, 0.2, -1]) : [0, 0.2, -1], radiance = legacy ? (disc || 0) : 0, phase = legacy ? (state.moonPhaseAngle || 0) : 0, halo = 1, cameraFar = legacy ? (camera?.far || 30000) : 30000 } = legacy ? {} : state;
    uniforms.uDir.value.set(...direction).normalize(); const lit = moonLitFraction(phase); uniforms.uAmp.value.set(radiance * halo * 0.05 * lit, radiance * halo * 0.0085 * lit); uniforms.uDistance.value = Math.min(6000, cameraFar * 0.6); mesh.visible = radiance > 0 && direction[1] > -0.02;
  }, dispose() { mesh.geometry.dispose(); material.dispose(); } };
}

export function moonHalo(optionsOrThree = {}, options = {}) {
  // Support both `moonHalo(THREE, options)` and the convenient
  // `moonHalo(options)` adapter form.
  return optionsOrThree?.Vector3 ? createMoonHalo(optionsOrThree, options) : createMoonHalo(THREE, optionsOrThree);
}
