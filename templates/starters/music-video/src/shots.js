import {createWorld} from '../engine/world/index.js';
export const world=createWorld({hour:[[0,23],[60,23.5]],weather:[[0,0],[29,0],[31,1]],wind:[[0,.25],[30,.4],[60,.55]],fog:[[0,.010],[30,.010],[33,.025]],light:[[0,1]],season:[[0,1]],motif:[[0,0],[60,1]]});
export const worldAt=t=>world.at(t);
