// kits/far — distant ranges / horizon layer + building-block structure helpers (generic, parameterised, deterministic).
// Read README.md before using or changing it; every bench view and every delivered frame must pass tools/picture-qa.
export {LAYER_DEFAULTS, LAYER_RANGES, AIR_DEFAULTS, AIR_RANGES, LIGHT_DEFAULTS, LIGHT_RANGES, FAR_PRESETS, MAX_ELEVATION_DEG, MAX_STEP_DEG, SLOT_KINDS, layerParams, airParams, lightParams} from './params.js';
export {createFarRanges, buildLayerArrays, slotArrays, layerRelHeight, farOptions, crestAt, slotPosition, azOf, angDiff} from './ranges.js';
export {makeFarMaterial, FAR_ENGINE_SYMBOLS, FAR_FS_BODY} from './shade.js';
export {GeoBatch, blockBatches, orientIndex, finishBatch, inspectBatch, withAtmosFog, frame, quad, boxF, wallWithOpenings, snowCap, flatRoofHouse, fortWall, rammedTowerGeometry, plankHull, buildBlockMeshes, HOLE_COLORS} from './blocks.js';
export {plankWoodMaterial, openingMaterial, blockMaterials} from './surfaces.js';
