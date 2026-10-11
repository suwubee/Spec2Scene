// Author: suwubee
// engine/shared-state.js — per-scene isolation for objects that stay resident across scenes.
//
// The resident player creates every scene once and keeps them all; some objects are deliberately shared between scenes (one
// sky per renderer, a shared atmosphere, a shared material). Each scene must see ITS values, whatever rendered before it.
// The classic leak: scene A sets a subset of the sky options, scene B sets nothing (or its options were ignored because the
// shared instance already existed) — B now renders on A's values, or on engine defaults it never chose. The picture then
// depends on render history: full-film frames differ from single-scene frames, seeks in a different order give different
// pixels, and QA "fixes" chase a configuration that is never actually applied.
//
// Rule: a scene writes the FULL key vector (defaults filled in for every key it does not set) before it uses the shared
// object, and restores the previous vector after. createSharedScope does exactly that and refuses unknown keys and nesting.
//
//   const scope = createSharedScope(sky, SKY_DEFAULTS, {name: 'sky', read: (s, k) => s.options[k], write: (s, v) => s.setOptions(v)});
//   const mine = scope.bind('night-field', {mie: 7, cloudDensity: 0});      // create(): validated once
//   update(t) { mine.run(() => sky.update(t, w, camera)); }           // every sample: full vector in, previous vector back

/**
 * createSharedScope(target, defaults, {name, read, write}) -> {keys, vector(overrides), enter(owner, overrides), exit(token),
 * run(owner, overrides, fn), bind(owner, overrides) -> {vector, run(fn)}, active()}
 * read(target, key) / write(target, fullVector) default to plain property access.
 */
export function createSharedScope(target, defaults, {name = 'shared', read = (t, k) => t[k], write = (t, v) => Object.assign(t, v)} = {}) {
  if (!target || typeof target !== 'object') throw new TypeError(`${name}: shared target object required`);
  if (!defaults || typeof defaults !== 'object') throw new TypeError(`${name}: defaults (the full key set) required`);
  const keys = Object.freeze(Object.keys(defaults));
  const known = new Set(keys);
  let current = null;
  const vector = (overrides = {}) => {
    for (const k of Object.keys(overrides)) if (!known.has(k)) throw new RangeError(`${name}: unknown key "${k}" (not in the defaults: a key outside the vector cannot be isolated)`);
    const v = {};
    for (const k of keys) v[k] = Object.prototype.hasOwnProperty.call(overrides, k) ? overrides[k] : defaults[k];
    return v;
  };
  const snapshot = () => { const s = {}; for (const k of keys) s[k] = read(target, k); return s; };
  function enter(owner, overrides) {
    if (current) throw new Error(`${name}: "${owner}" entered while "${current.owner}" still holds the shared object (exit first)`);
    const token = {owner, saved: snapshot(), applied: vector(overrides)};
    write(target, token.applied);
    current = token;
    return token;
  }
  function exit(token) {
    if (!current || token !== current) throw new Error(`${name}: exit without the matching enter`);
    write(target, token.saved);
    current = null;
  }
  function run(owner, overrides, fn) { const tk = enter(owner, overrides); try { return fn(tk.applied); } finally { exit(tk); } }
  function bind(owner, overrides = {}) {
    const fixed = vector(overrides);                 // validated at creation, not on the first frame
    return {owner, vector: fixed, run: (fn) => run(owner, fixed, fn)};
  }
  return {name, keys, vector, enter, exit, run, bind, active: () => (current ? current.owner : null)};
}
