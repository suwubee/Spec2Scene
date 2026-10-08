// Author: suwubee
import {createTerrainLibrary} from '../engine/terrain.js';
import {createWater} from '../engine/water.js';
import {environment} from './common.js';
export function createRiver(ctx,options={}) {
  const E=environment(ctx,{fog:0,...options.environment}),lib=createTerrainLibrary(options.terrain),atmos=lib.createAtmosphere(ctx,{sky:E.sky});
  const terrain=lib.createTerrain(ctx,{atmos,...options.ground}),water=createWater(ctx,{atmos,sky:E.sky,...options.water});
  E.scene.add(terrain.object,water.object);terrain.object.traverse(o=>o.layers.enable(water.mirrorLayer));
  return {...E,terrain,water,atmos,update(t,w,c){E.update(t,w,c);atmos.update(t,w,c,options.atmosphere);terrain.update(t,w,c);water.update(t,w,c,{renderer:ctx.renderer,scene:E.scene,...options.surface});},dispose(){terrain.dispose();water.dispose();atmos.dispose();E.dispose();}};
}
