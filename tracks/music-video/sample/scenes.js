// Author: suwubee
import {createSnowfield,snowHeight} from '../kits/snowfield.js';
import {createStation} from '../kits/station.js';
import {createCharacter} from '../character/index.js';
export function createScenes() {
  return {snow(ctx){const kit=createSnowfield(ctx),character=createCharacter({coat:true,scarf:true});kit.scene.add(character.object);
    return {...kit,character,update(t,w,c){const z=-28-t*.22;character.update('windWalk',t,{distance:t*.22});character.object.position.set(.4,snowHeight(.4,z),z+t*.22);kit.update(t,w,c);}};},
    station(ctx){const kit=createStation(ctx),character=createCharacter({coat:true,scarf:false});character.object.position.set(-3,.04,-17);kit.scene.add(character.object);character.object.traverse(o=>o.layers.enable(kit.film.mirrorLayer));
      return {...kit,character,update(t,w,c){character.update('stand',t);kit.update(t,w,c);}};}};
}
