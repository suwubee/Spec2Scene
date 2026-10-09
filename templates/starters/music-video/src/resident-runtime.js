import {createEngine} from '../engine/core/index.js';
import {createScenes} from '../sample/scenes.js';
import {world} from './shots.js';

export async function createRuntime({canvas}) {
  const params = new URLSearchParams(location.search);
  const width = Number(params.get('w') || 1280), height = Number(params.get('h') || 720);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 160 || width > 4096 || height < 90 || height > 2160) throw new RangeError('预览尺寸超出范围');
  const response = await fetch(new URL('../sample/shots.json', import.meta.url));
  if (!response.ok) throw new Error('镜头表读取失败');
  return createEngine({canvas, shots: await response.json(), scenes: createScenes(), world, width, height, quality: 'final'});
}
