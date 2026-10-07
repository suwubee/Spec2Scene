import {createEnvironment} from '../engine/world/environment.js';
export const world=createEnvironment({rain:[[0,0],[29.9,0],[30,.7],[60,.75]],wind:[[0,.32],[30,.4],[60,.5]],mist:[[0,.4],[30,.55],[60,.6]],cloudCover:[[0,.37],[30,.6],[60,.7]],moonElev:[[0,12]],moonAzim:[[0,345]],moonlight:[[0,1],[30,.35]],moonGap:[[0,.72],[30,.1]]});
export const worldAt=t=>world.at(t);
