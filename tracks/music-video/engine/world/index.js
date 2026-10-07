import {curve} from '../core/math.js';
export function createWorld(channels = {}) {
  const defaults = {hour: [[0, 23]], season: [[0, 1]], wind: [[0, .3]], fog: [[0, .018]], light: [[0, 1]], weather: [[0, 0]], motif: [[0, 0], [60, 1]]};
  const keys = structuredClone({...defaults, ...channels});
  for(const values of Object.values(keys)) {
    if(!Array.isArray(values)||!values.length)throw new Error('nonempty world channel required');
    for(let i=0;i<values.length;i++){const [time,value]=values[i];if(!Number.isFinite(time)||(i&&time<=values[i-1][0])||(Array.isArray(value)?value:[value]).some(v=>!Number.isFinite(v)))throw new Error('world keys must be finite and increase');}
  }
  return {at(t) {
    if (!Number.isFinite(t)) throw new TypeError('finite world time required');
    return Object.fromEntries(Object.entries(keys).map(([name, value]) => [name, curve(value, t)]));
  }};
}
