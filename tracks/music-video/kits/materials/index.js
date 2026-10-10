// kits/materials — generic snow / ice / rammed-earth material library (world-space / triplanar, parameterised, deterministic).
// Read README.md before changing or using it; every delivered frame must pass tools/picture-qa.
export {getMaterialNoise, bakeMaterialNoise, disposeMaterialNoise, MATERIAL_NOISE_SIZE} from './noise.js';
export {MAT_GLSL, MAT_GLSL_COMMON, MAT_GLSL_SNOW, MAT_GLSL_ICE} from './glsl.js';
export {materialUniforms, snowParams, iceParams, SNOW_DEFAULTS, SNOW_RANGES, SNOW_PRESETS, ICE_DEFAULTS, ICE_RANGES, ICE_PRESETS, WIND_ASPECT} from './params.js';
export {injectMaterialLibrary} from './inject.js';
export {snowMaterial, iceMaterial, setMaterialLight} from './surfaces.js';
export {rammedEarthMaterial, bakeRammedEarth, bakeRammedEarthTextures, RAMMED_DEFAULTS, RAMMED_RANGES} from './rammed.js';
export {snowDriftGeometry, driftHeightField, maxSlopeDegrees} from './drift.js';
