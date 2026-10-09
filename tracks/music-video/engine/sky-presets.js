export { clampMoonPhase, moonLitFraction, clampMoonRadiance, moonDiscParameters, createMoonHalo, moonHalo, MOON_DISPLAY_MAX, MOON_CLAMP_K } from './moon-display.js';

/** Opt-in art direction; cloud extinction keeps luminance but neutralizes lunar reddening. */
export const SKY_PRESETS=Object.freeze({
  coldNight:{sky:{moonLightColor:[.48,.7,1],moonTint:[.65,.8,1],lunarCloudNeutrality:1,mie:4},channels:{sunElev:[[0,-24]],moonElev:[[0,8]],day:[[0,0]]}},
  moonlit:{sky:{moonLightColor:[.7,.83,1],lunarCloudNeutrality:.85,stars:.6,mie:6},channels:{sunElev:[[0,-25]],moonElev:[[0,32]],day:[[0,0]]}},
  dawn:{sky:{sunColor:[1,.84,.7],cirrus:.45,stars:.05},channels:{sunElev:[[0,3]],moonElev:[[0,12]],day:[[0,1]],cloudCover:[[0,.28]]}},
});
export function skyPreset(name){if(!SKY_PRESETS[name])throw new Error('unknown sky preset');return structuredClone(SKY_PRESETS[name]);}
export function lunarTransmittance(rgb,neutrality=0){const k=Math.max(0,Math.min(1,neutrality)),l=rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;return rgb.map(v=>v*(1-k)+l*k);}
