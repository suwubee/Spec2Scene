/**
 * The wardrobe builder lives beside the adapter so projects can import one
 * stable entry point.  It is intentionally exposed through the adapter's
 * `garments` result; this module documents the supported option names without
 * bundling a model or a texture.
 */
export {createProceduralWardrobe, adaptRealCharacter, prepareRealCharacter, prepareRealChar} from './index.js';
