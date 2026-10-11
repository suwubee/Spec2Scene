// Author: suwubee
// engine/first-sample-prime.js — "first-frame double render" for resident scenes.
//
// Measured problem: the very first render of a scene instance can differ from every later render of the same frame by a few
// to ~20 code values, although all JS state is identical (lazy pipeline initialisation in the browser / driver: first use of
// render targets, shadow maps, programs). In a resident multi-scene film the first frame rendered for each scene depends on
// seek order, so two renders of the same frame in different orders differ — a determinism failure that no scene code causes.
//
// Fix: the first sample of every scene instance is rendered twice and the first result is discarded. It is applied once per
// instance (not per frame), costs one extra sample per scene during warm-up, and is recorded (count + ids) so QA can see it.
//
// It is NOT a licence to hide JS-state bugs: caches computed on first use, Math.random, Date, accumulated state, render
// targets that keep the previous frame — those differ on EVERY order change, not only on an instance's first sample, and
// remain failures. Diagnose with the prime off (engine option primeFirstSample:false / ?prime=0): a difference that vanishes
// with the prime on and only ever affects an instance's first sample is pipeline laziness; anything else is a bug to fix.

/** createFirstSamplePrime({enabled}) -> {enabled, before(inst, id, renderOnce), count, ids()} */
export function createFirstSamplePrime({enabled = true} = {}) {
  const primed = new WeakSet(), ids = [];
  let count = 0, active = false;
  return {
    enabled,
    /** Call at the top of a sample render. On an instance's first sample it runs renderOnce() (the full sample) and returns. */
    before(inst, id, renderOnce) {
      if (!enabled || active || !inst || primed.has(inst)) return false;
      primed.add(inst); ids.push(id); count++;
      active = true;
      try { renderOnce(); } finally { active = false; }
      return true;
    },
    get count() { return count; },
    ids: () => ids.slice(),
  };
}
