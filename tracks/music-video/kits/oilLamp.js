// Author: suwubee

// cup, a twisted cotton wick resting on the rim, a small open flame with 1/f flicker (FX layer, self-defocusing:
// the flame is sharp when focused and becomes an energy-conserving soft disc when out of focus), the warm
// PointLight (materials.makeLampLight: 0.2 cd × world.localLight), a glowing ember + a thin smoke wisp after the flame

//

//   scene.add(lamp.object);  lamp.update(t, world, camera, { flicker, glow });
//   lamp.flamePos (world THREE.Vector3), lamp.light (PointLight)
import * as THREE_NS from '../engine/vendor/three.module.js';
import * as G from '../engine/geo.js';
import { makeLampLight } from '../engine/materials.js';
import { createSteam } from '../engine/particles.js';
import { pink1, gnoise1, hashString } from '../engine/noise.js';
import { hexLin } from '../engine/procTex.js';

const FLAME_VS = /* glsl */ `
uniform vec3 uC;          // flame base centre (world)
uniform vec4 uF;          // x height (m), y width (m), z lean x (m at the tip, camera-right), w lean z
uniform vec4 uLens;       // engine lens: focus (m), CoC px @inf, near, far
uniform vec2 uRes;
varying vec2 vQ;          // flame-local coords: x across (m), y up (m, 0 = base)
varying float vBlur;      // blur radius (m, world at the flame)
void main(){
  vec4 vc = viewMatrix * vec4(uC + vec3(0.0, uF.x * 0.45, 0.0), 1.0);
  float z = max(-vc.z, 1e-3);
  float coc = abs(uLens.y * (1.0 - uLens.x / z));
  float fpx = projectionMatrix[1][1] * 0.5 * uRes.y;
  float blur = min(coc, 48.0) * z / fpx;
  vBlur = blur;
  // cylindrical billboard: x axis = camera right projected horizontally
  vec3 camR = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]) + 1e-6);
  vec2 hs = vec2(uF.y * 0.9 + blur * 1.4 + 0.004, uF.x * 0.75 + blur * 1.4 + 0.004);
  vec2 q = position.xy * hs + vec2(0.0, uF.x * 0.45);
  vQ = q;
  float tip = clamp(q.y / max(uF.x, 1e-4), 0.0, 1.2);
  vec3 w = uC + camR * (q.x + uF.z * tip * tip) + vec3(0.0, q.y, 0.0) + vec3(0.0, 0.0, uF.w * tip * tip);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
const FLAME_FS = /* glsl */ `
uniform vec4 uF;
uniform vec4 uE;          // x core radiance, y outer radiance, z blue base, w ember
varying vec2 vQ; varying float vBlur;
float teardrop(vec2 q, float H, float W){
  // signed-ish distance to a smooth teardrop: r(y) ∝ sqrt(y)(1−y)^1.1 (round base, widest at 31 % of the height,
  // smoothly tapering to the tip) from y0 = −0.08H to the tip at H; closed above the tip / below the base
  float y0 = -0.08 * H, h = 1.08 * H;
  float yn = clamp((q.y - y0) / h, 0.0, 1.0);
  float r = W * 0.5 * sqrt(yn) * pow(1.0 - yn, 1.1) / 0.370;
  float d = abs(q.x) - r;
  d = max(d, q.y - (y0 + h));
  d = max(d, y0 - q.y);
  return d;
}
void main(){
  float H = max(uF.x, 1e-4), W = uF.y;
  float soft = 0.0011 + vBlur;
  float d = teardrop(vQ, H, W);
  float cov = smoothstep(soft, -soft * 0.9, d);            // a luminous zone fades out (no hard rim)
  // inner core (smaller teardrop), blue base, outer glow
  float dc = teardrop(vQ - vec2(0.0, H * 0.06), H * 0.72, W * 0.55);
  float core = smoothstep(soft * 0.8, -soft * 0.6, dc);
  float y = vQ.y / H;
  float blue = smoothstep(0.25, 0.0, y) * smoothstep(-0.08, 0.05, y);
  vec3 outer = vec3(1.0, 0.42, 0.10) * uE.y * (0.55 + 0.45 * smoothstep(1.0, 0.3, y));
  vec3 inner = vec3(1.0, 0.86, 0.58) * uE.x;
  vec3 col = mix(outer, inner, core) * cov + vec3(0.25, 0.4, 1.0) * uE.z * blue * cov;
  // ember at the wick (after the flame dies)
  float er = length(vQ - vec2(0.0, -0.0006));
  col += vec3(1.0, 0.25, 0.04) * uE.w * smoothstep(0.0016 + vBlur, 0.0, er);
  // energy conservation when defocused: the same flux spread over the blurred area
  float A0 = H * W * 0.6, A1 = (H + 2.0 * vBlur) * (W + 2.0 * vBlur) * 0.7;
  col *= A0 / max(A1, A0);
  if (max(col.r, max(col.g, col.b)) < 1e-4) discard;
  gl_FragColor = vec4(col, 0.0);
}`;

export function createOilLamp(ctx, M, opts = {}) {
  const THREE = ctx.THREE || THREE_NS;
  const P = opts.position || [0, 0, 0];
  const group = new THREE.Group(); group.name = 'interior.oilLamp';
  group.position.set(P[0], P[1], P[2]);
  // ---------------- ceramic stand (tenmoku glaze) ----------------
  const prof = [[0, 0.0015], [0.046, 0.0015], [0.048, 0.0], [0.051, 0.001], [0.052, 0.006], [0.047, 0.012], [0.03, 0.02], [0.016, 0.028],
    [0.0105, 0.04], [0.0095, 0.07], [0.0105, 0.1], [0.012, 0.118], [0.0165, 0.124],                  // stem with a knop
    [0.041, 0.128], [0.046, 0.133], [0.045, 0.137], [0.036, 0.135], [0.014, 0.136],                  // drip tray
    [0.0125, 0.15], [0.0135, 0.168], [0.02, 0.174], [0.034, 0.18], [0.0375, 0.1875], [0.0368, 0.19],  // oil cup outside + rim
    [0.033, 0.1885], [0.022, 0.18], [0.0, 0.1775]];                                                     // inside of the cup
  const dark = hexLin('#2f1d14'), porc = hexLin('#eeede8');
  const glaze = M.ceramic('porcelain', { seed: 13, objSeed: 131, clearcoatRoughness: 0.06, color: new THREE.Color().setRGB(dark[0] / porc[0], dark[1] / porc[1], dark[2] / porc[2]) });
  const standGeo = G.lathe(prof, { segments: 56, wobble: 0.004, seed: 131, uvPeriod: 0.06 });
  const stand = new THREE.Mesh(standGeo, glaze); stand.name = 'lampStand'; stand.castShadow = true; stand.receiveShadow = true;
  group.add(stand);
  // oil surface (dark amber, glossy) inside the cup
  const oilGeo = new THREE.CircleGeometry(0.0305, 40); oilGeo.rotateX(-Math.PI / 2); oilGeo.translate(0, 0.1835, 0);
  const oilMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color().setRGB(0.05, 0.025, 0.006), roughness: 0.03, ior: 1.47, specularIntensity: 1 });
  const oil = new THREE.Mesh(oilGeo, oilMat); oil.name = 'lampOil'; oil.receiveShadow = true; group.add(oil);
  // wick: twisted cotton from the oil over the rim, tip rising a little above the rim (charred)
  const wickC = new THREE.CatmullRomCurve3([new THREE.Vector3(-0.012, 0.182, 0.004), new THREE.Vector3(0.006, 0.1845, 0.001), new THREE.Vector3(0.022, 0.1875, 0.0),
    new THREE.Vector3(0.0305, 0.1905, 0.0), new THREE.Vector3(0.0335, 0.1945, 0.0)]);
  const wickMat = M.linen({ seed: 21, objSeed: 132, color: new THREE.Color().setRGB(0.62, 0.52, 0.4), translucency: 0.0 });
  const wick = new THREE.Mesh(G.tubeAlongCurve(wickC, (u) => 0.0014 * (1 - 0.3 * u), { tubular: 20, radial: 7 }), wickMat); wick.name = 'wick';
  wick.castShadow = true; group.add(wick);
  const charMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.012, 0.01, 0.008), roughness: 0.9 });
  const tipPos = wickC.getPointAt(1);
  const char = new THREE.Mesh(new THREE.SphereGeometry(0.0013, 8, 6), charMat); char.position.copy(tipPos); char.scale.set(1, 1.6, 1); group.add(char);
  // ---------------- flame (FX layer) ----------------
  const flameC = tipPos.clone().add(new THREE.Vector3(0, 0.0012, 0));
  const lensU = ctx.uniforms && ctx.uniforms.uLens ? ctx.uniforms.uLens : { value: new THREE.Vector4(1, 0, 0.05, 100) };
  const resU = ctx.uniforms && ctx.uniforms.uRes ? ctx.uniforms.uRes : { value: new THREE.Vector2(1920, 804) };
  const FU = { uC: { value: new THREE.Vector3() }, uF: { value: new THREE.Vector4(0.024, 0.0085, 0, 0) }, uE: { value: new THREE.Vector4(40, 9, 2.5, 0) }, uLens: lensU, uRes: resU };
  const flameMat = new THREE.ShaderMaterial({ uniforms: FU, vertexShader: FLAME_VS, fragmentShader: FLAME_FS, transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
  const flame = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 1, 1), flameMat); flame.name = 'lampFlame'; flame.frustumCulled = false; flame.renderOrder = 60;
  flame.layers.set(ctx.FX_LAYER ?? 7);
  group.add(flame);
  // ---------------- light + smoke ----------------
  const flameWorld = flameC.clone().add(new THREE.Vector3(P[0], P[1] + 0.009, P[2]));
  const rig = makeLampLight(ctx, { position: flameWorld.toArray(), seed: 7, parameter: opts.parameter || 'localLight', gain: opts.lightGain ?? 1 });
  rig.light.userData.radius = 0.01;               // NB: the caller adds lamp.lightObject to the scene ROOT (world position)
  const smoke = createSteam(ctx, { seed: 'lampSmoke', origin: flameWorld.toArray(), radius: 0.0012, height: 0.3, rise: 0.07, ribbons: ctx.quality === 'final' ? 4 : 3,
    width: 0.0011, curl: 0.9, opacity: 1.6, g: 0.5, draft: [0.004, 0, -0.002] });
  smoke.object.name = 'lampSmoke';
  group.add(smoke.object);                        // shader uses world coordinates (modelMatrix ignored)
  const seedF = hashString('lampFlame:7') % 100000;
  return {
    object: group, flame, light: rig.light, lightObject: rig.object, rig, smoke, flamePos: flameWorld,
    /**
     * t = film time; world = world.at(t). x: { glow (override localLight 0..1), outAt (film s the flame dies, default Infinity),
     *   gain (flame radiance ×), still (0..1: calmer flame) }
     */
    update(t, world, camera, x = {}) {
      const glow = x.glow ?? (world?.parameters?.[opts.parameter || 'localLight'] ?? .55);
      const outAt = x.outAt ?? opts.outAt ?? Infinity;
      // guttering: violent flicker as the oil runs out (≈0.4 s before outAt), collapse at outAt
      const gut = Math.max(0, Math.min(1, (t - (outAt - 0.45)) / 0.45)) * (t < outAt + 0.2 ? 1 : 0);
      const still = x.still ?? 0;
      const f1 = pink1(t * 1.9, seedF, { octaves: 6, fmin: 0.3 }), f2 = pink1(t * 7.3, seedF + 17, { octaves: 4, fmin: 1 });
      const fl = 1 + (0.06 + 0.35 * gut) * (1 - 0.5 * still) * f1 + (0.03 + 0.25 * gut) * f2;
      const alive = t < outAt ? 1 : Math.max(0, 1 - (t - outAt) / 0.09);
      const lvl = Math.min(1, glow / 0.55);                              // flame size follows the lamp level
      const H = 0.0165 * Math.max(0, (0.35 + 0.65 * lvl)) * fl * (1 - 0.45 * gut) * alive;
      const Wd = 0.0092 * (0.6 + 0.4 * lvl) * (1 + 0.08 * f2) * (alive > 0 ? 1 : 0);
      FU.uF.value.set(H, Wd, 0.0025 * (f1 + 0.6 * gnoise1(t * 0.7, 3)) * (1 + 3 * gut), 0.0015 * gnoise1(t * 0.9, 5));
      const e = (x.gain ?? 1) * alive;
      FU.uE.value.set(15 * e * (1 - 0.35 * gut), 4.2 * e, 1.6 * e, 6 * Math.max(0, t - outAt < 0 ? 0 : Math.exp(-(t - outAt) / 0.9)) * (t >= outAt ? 1 : 0));
      group.updateMatrixWorld(true);
      FU.uC.value.copy(flameC).applyMatrix4(group.matrixWorld);
      flame.visible = H > 1e-5 || FU.uE.value.w > 1e-3;
      rig.update(t, { ...world, parameters:{...world.parameters,[opts.parameter || 'localLight']:glow * alive * (1 + 0.25 * gut * f2)} });
      // smoke: a wisp for ~6 s after the flame dies
      const sm = t > outAt ? Math.min(1, (t - outAt) / 0.25) * Math.exp(-(t - outAt) / 3.5) : 0;
      smoke.update(t, { ...world, steam: sm }, camera);
      smoke.object.visible = sm > 0.01;
    },
    dispose() { standGeo.dispose(); oilGeo.dispose(); flame.geometry.dispose(); flameMat.dispose(); smoke.dispose(); rig.dispose(); },
  };
}
export default createOilLamp;
