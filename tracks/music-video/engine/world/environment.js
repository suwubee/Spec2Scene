// Author: suwubee
import {createWorld} from './index.js';
const direction=(e,a)=>{const r=Math.PI/180;return [Math.sin(a*r)*Math.cos(e*r),Math.sin(e*r),-Math.cos(a*r)*Math.cos(e*r)];};
/** Physical environment channels + an arbitrary named parameter registry for practical lights/props. */
export function createEnvironment(channels={},parameters={},options={}) {
  const curves=createWorld({sunElev:[[0,-24]],sunAzim:[[0,240]],moonElev:[[0,22]],moonAzim:[[0,325]],moonlight:[[0,1]],
    cloudCover:[[0,.35]],rain:[[0,0]],mist:[[0,.35]],wind:[[0,.22]],windDir:[[0,[1,0,.2]]],day:[[0,0]],moonGap:[[0,.7]],bloomAmount:[[0,0]],petalFall:[[0,0]],...channels});
  const registry=createWorld(parameters,{defaults:false});
  return {particleTimeDomain:options.particleTimeDomain,at(t){const s=curves.at(t);return {...s,moonDir:direction(s.moonElev,s.moonAzim),sunDir:direction(s.sunElev,s.sunAzim),parameters:registry.at(t)};}};
}
export const defaultEnvironment=createEnvironment();
