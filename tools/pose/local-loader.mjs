export function localFileset(baseURL) {
  const base = new URL(baseURL);
  return {
    wasmLoaderPath: new URL('vision_wasm_internal.js', base).href,
    wasmBinaryPath: new URL('vision_wasm_internal.wasm.bin', base).href,
  };
}
export async function createLocalLandmarker({baseURL, modelURL, kind = 'pose', delegate = 'CPU', mode = 'VIDEO'}) {
  const base = new URL(baseURL), model = new URL(modelURL);
  if (base.origin !== location.origin || model.origin !== location.origin) throw new Error('Models and runtime must be same-origin');
  if (!['pose', 'hand', 'face'].includes(kind)) throw new Error('Unsupported landmarker kind');
  const vision = await import(new URL('vision_bundle.mjs', base).href);
  const Constructor = {pose: vision.PoseLandmarker, hand: vision.HandLandmarker, face: vision.FaceLandmarker}[kind];
  const options = {baseOptions: {modelAssetPath: model.href, delegate}, runningMode: mode};
  if (kind === 'pose') options.numPoses = 1;
  if (kind === 'hand') options.numHands = 2;
  if (kind === 'face') options.outputFacialTransformationMatrixes = true;
  return Constructor.createFromOptions(localFileset(base), options);
}
