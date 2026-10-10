// Parameters, legal ranges and presets of the snow / ice library. Values outside the legal range throw: the ranges are the
// measured limits beyond which the picture breaks (see README "Parameters"), so they are constraints, not suggestions.
import {getMaterialNoise} from './noise.js';

/** Wind-ripple length:width ratio along the wind. Must stay <= 3 (README R3): longer streaks converge into radial stripes. */
export const WIND_ASPECT = 2.6;

/** W cross-wind ripple wavelength (m) · ridge ripple strength · grain close grain · glint glint density · macro large light/dark ·
 *  crust wind-crust mottling · glintGain glint brightness */
export const SNOW_DEFAULTS = Object.freeze({W: 0.6, ridge: 1.0, grain: 1.0, glint: 0.4, macro: 0.22, crust: 0.16, glintGain: 5.0});
export const SNOW_RANGES = Object.freeze({W: [0.35, 1.2], ridge: [0, 1.5], grain: [0, 1.5], glint: [0, 1], macro: [0, 0.3], crust: [0, 0.3], glintGain: [0, 8]});
export const SNOW_PRESETS = Object.freeze({
  field: {},                                                                                // open snowfield / slope
  compacted: {W: 0.45, ridge: 0.45, grain: 0.8, glint: 0.35, macro: 0.08, crust: 0.06},    // trodden / driven-over street snow
  bank: {W: 0.7, ridge: 1.1, macro: 0.18, crust: 0.14},                                     // windward bank / slope
  drift: {W: 0.5, ridge: 0.8, macro: 0.1, crust: 0.08},                                     // drifts and cornices (geometry carries the form)
  far: {ridge: 0.6, grain: 0.0, macro: 0.2, crust: 0.14},                                   // distant terrain (fine detail already faded)
});
/** cell crack cell (m) · crack crack strength · bubbles bubble density · milky milky-ice share · polish polish contrast ·
 *  dark blackness (1 = darkest, most transparent) · gain albedo gain for the host lighting convention */
export const ICE_DEFAULTS = Object.freeze({cell: 3.5, crack: 0.8, bubbles: 0.6, milky: 0.3, polish: 0.6, dark: 0.6, gain: 1.0});
export const ICE_RANGES = Object.freeze({cell: [1.5, 8], crack: [0, 1], bubbles: [0, 1], milky: [0, 1], polish: [0, 1], dark: [0, 1], gain: [0.5, 3]});
export const ICE_PRESETS = Object.freeze({
  clear: {},
  black: {milky: 0.1, dark: 0.85, crack: 0.9},
  shore: {milky: 0.55, cell: 2.2, bubbles: 0.35},
});

function pick(defs, ranges, presets, v, kind) {
  if (typeof v === 'string' && !presets[v]) throw new RangeError(`unknown ${kind} preset "${v}" (${Object.keys(presets).join(', ')})`);
  const out = {...defs, ...(typeof v === 'string' ? presets[v] : (v || {}))};
  for (const [k, val] of Object.entries(out)) {
    if (!(k in ranges)) throw new RangeError(`unknown ${kind} parameter "${k}"`);
    const [lo, hi] = ranges[k];
    if (!Number.isFinite(val) || val < lo || val > hi) throw new RangeError(`${kind}.${k}=${val} outside legal range [${lo}, ${hi}]`);
  }
  return out;
}
export const snowParams = (v) => pick(SNOW_DEFAULTS, SNOW_RANGES, SNOW_PRESETS, v, 'snow');
export const iceParams = (v) => pick(ICE_DEFAULTS, ICE_RANGES, ICE_PRESETS, v, 'ice');

/** Uniforms used by the GLSL library; p = {snow: preset|fields, ice: preset|fields}. Create at scene construction. */
export function materialUniforms(THREE, p = {}) {
  const s = snowParams(p.snow), i = iceParams(p.ice);
  return {
    uMatNoise: {value: getMaterialNoise(THREE)},
    uSnowP: {value: new THREE.Vector4(s.W, s.ridge, s.grain, s.glint)},
    uSnowP2: {value: new THREE.Vector4(s.macro, s.crust, s.glintGain, 0)},
    uIceP: {value: new THREE.Vector4(i.cell, i.crack, i.bubbles, i.milky)},
    uIceP2: {value: new THREE.Vector4(i.polish, i.dark, i.gain, 0)},
  };
}
