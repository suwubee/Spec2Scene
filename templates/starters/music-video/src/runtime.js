import {createFilmPlayer} from '../player/film.js';
import {createScenes} from '../sample/scenes.js';
import {createRealtimeScene} from '../sample/realtime.js';
import {world} from './shots.js';

export async function createRuntime(options) {
  const response=await fetch(new URL('../sample/shots.json',import.meta.url));
  if(!response.ok)throw new Error('镜头表读取失败');
  const shots=await response.json(),scenes=createScenes();
  const previewScenes=Object.fromEntries(Object.keys(scenes).map(id=>[id,ctx=>createRealtimeScene(ctx,id)]));
  return createFilmPlayer({...options,shots,scenes,previewScenes,world});
}
