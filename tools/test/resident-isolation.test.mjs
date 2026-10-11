import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSharedScope} from '../../tracks/music-video/engine/shared-state.js';
import {scopeSharedSky, SKY_DEFAULTS} from '../../tracks/music-video/engine/sky.js';
import {createFirstSamplePrime} from '../../tracks/music-video/engine/first-sample-prime.js';
import {creditTitles, normalizeCredits, undeclaredCredits, CREDIT_FIELDS} from '../../tracks/music-video/engine/credits.js';
import {walkPath} from '../../tracks/music-video/character/walk-path.js';
import {walkPath as walkPathExport} from '../../tracks/music-video/character/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFile(path.join(root, p), 'utf8');

// A shared object that records what each update actually saw (stands in for one sky shared by resident scenes).
function fakeSky(defaults) {
  const o = {...defaults}, seen = [];
  return {options: o, seen, setOptions(p) { Object.assign(o, p); }, update(t, w, cam) { seen.push({cam, ...o}); }};
}

test('shared object without isolation: the second scene renders on the first scene\'s values (the leak this guards against)', () => {
  const D = {mie: 14, cloudDensity: 0.022, cirrus: 0.3};
  const sky = fakeSky(D);
  const renderA = () => { sky.setOptions({mie: 7, cloudDensity: 0}); sky.update(0, {}, 'A'); };   // A writes a subset, never restores
  const renderB = () => sky.update(0, {}, 'B');                                                   // B writes nothing
  renderB(); const bFirst = sky.seen.at(-1);
  renderA(); renderB(); const bAfterA = sky.seen.at(-1);
  assert.notDeepEqual({...bFirst, cam: 0}, {...bAfterA, cam: 0}, 'without isolation the same frame of B depends on render history');
});

test('createSharedScope: full key vector in, previous vector back, history-independent, strict about keys and nesting', () => {
  const D = {mie: 14, cloudDensity: 0.022, cirrus: 0.3};
  const sky = fakeSky(D), scope = createSharedScope(sky, D, {name: 'sky', read: (s, k) => s.options[k], write: (s, v) => s.setOptions(v)});
  const A = scope.bind('A', {mie: 7, cloudDensity: 0}), B = scope.bind('B', {});
  const frame = (bound, id) => bound.run(() => sky.update(0, {}, id));
  const orders = [['A', 'B'], ['B', 'A', 'B'], ['B', 'B', 'A', 'A', 'B']];
  const results = orders.map((order) => { for (const id of order) frame(id === 'A' ? A : B, id); return sky.seen.filter((s) => s.cam === 'B').map(({cam, ...v}) => v); });
  for (const r of results) for (const v of r) assert.deepEqual(v, D, 'B always renders on the defaults, whatever ran before');
  for (const v of sky.seen.filter((s) => s.cam === 'A')) assert.deepEqual({mie: v.mie, cloudDensity: v.cloudDensity, cirrus: v.cirrus}, {mie: 7, cloudDensity: 0, cirrus: 0.3});
  assert.deepEqual(sky.options, D, 'the shared object is restored after every scope');
  assert.throws(() => scope.bind('C', {mei: 1}), /unknown key "mei"/);
  const tk = scope.enter('A', {}); assert.equal(scope.active(), 'A');
  assert.throws(() => scope.enter('B', {}), /still holds/);
  scope.exit(tk); assert.equal(scope.active(), null);
  assert.throws(() => scope.exit(tk), /without the matching enter/);
  // an exception inside the scene still restores the shared object
  assert.throws(() => A.run(() => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(sky.options, D); assert.equal(scope.active(), null);
});

test('scopeSharedSky: every update writes all SKY_DEFAULTS keys (subset overrides cannot leak) and restores them', () => {
  const sky = fakeSky(SKY_DEFAULTS);
  sky.setOptions({mie: 3, cirrus: 0.9});                                     // left over by some unscoped scene
  const sceneA = scopeSharedSky(sky, {mie: 7, cloudDensity: 0}, 'A'), sceneB = scopeSharedSky(sky, {}, 'B');
  sceneA.update(1, {}, 'A'); sceneB.update(1, {}, 'B'); sceneA.update(1, {}, 'A');
  const seenB = sky.seen.find((s) => s.cam === 'B'), seenA = sky.seen.filter((s) => s.cam === 'A');
  for (const k of Object.keys(SKY_DEFAULTS)) assert.deepEqual(seenB[k], SKY_DEFAULTS[k], `scene B sees default ${k}`);
  assert.equal(seenA[0].mie, 7); assert.equal(seenA[0].cirrus, SKY_DEFAULTS.cirrus); assert.deepEqual(seenA[0], seenA[1]);
  assert.equal(sky.options.mie, 3, 'previous (unscoped) values restored after the scope');
  assert.throws(() => scopeSharedSky(sky, {cloudDensty: 0}), /unknown key/);
});

test('engine sky/core wiring: getSharedSky reports ignored options; renderSample primes; API exposes primed scenes', async () => {
  const sky = await read('tracks/music-video/engine/sky.js'), core = await read('tracks/music-video/engine/core.js'), player = await read('tracks/music-video/realtime/player.js');
  assert.match(sky, /options ignored/); assert.match(sky, /export function scopeSharedSky/);
  const body = core.slice(core.indexOf('function renderSample('), core.indexOf('resetCamera(inst);', core.indexOf('function renderSample(')));
  assert.match(body, /prime\.before\(inst, shot\.set, \(\) => renderSample\(L, Pl, tt, tl, withFx\)\)/, 'prime runs the full sample before the kept one');
  assert.match(core, /primeFirstSample !== false/); assert.match(core, /primedSets: \(\) => prime\.ids\(\)/);
  assert.match(player, /state\.warm\.primed = engine\.primedSets/);
  for (const f of ['templates/starters/music-video/src/main.js', 'templates/starters/music-video/src/resident-runtime.js']) assert.match(await read(f), /primeFirstSample: ?params\.get\('prime'\) ?!== ?'0'/, f);
});

test('first-sample prime: once per scene instance, full sample rendered twice with the first discarded, re-entrant safe', () => {
  // A pipeline whose first render of each instance is off by a few code values (lazy initialisation), independent of JS state.
  const lazyPipeline = () => { const warmed = new Set(); return (inst, t) => { const v = Math.round(t * 10) + (warmed.has(inst) ? 0 : 7); warmed.add(inst); return v; }; };
  const renderOrder = (order, enabled) => {
    const draw = lazyPipeline(), prime = createFirstSamplePrime({enabled}), insts = {a: {}, b: {}}, out = {};
    const sample = (id, t) => { prime.before(insts[id], id, () => sample(id, t)); return draw(insts[id], t); };
    for (const [id, t] of order) out[`${id}@${t}`] = sample(id, t);
    return {out, prime};
  };
  const o1 = [['a', 1], ['b', 2], ['a', 3]], o2 = [['b', 2], ['a', 3], ['a', 1]];
  const off1 = renderOrder(o1, false).out, off2 = renderOrder(o2, false).out;
  assert.notDeepEqual(off1, off2, 'without the prime the same frames differ with seek order');
  const on1 = renderOrder(o1, true), on2 = renderOrder(o2, true);
  assert.deepEqual(on1.out, on2.out, 'with the prime every frame is identical in any order');
  assert.equal(on1.prime.count, 2); assert.deepEqual(on1.prime.ids(), ['a', 'b']); assert.deepEqual(on2.prime.ids(), ['b', 'a']);
  // a JS-state bug (value depends on what rendered before, every time) is NOT hidden by the prime
  const prime = createFirstSamplePrime(), inst = {}; let last = 0;
  const buggy = (t) => { prime.before(inst, 'x', () => buggy(t)); const v = t + last; last = t; return v; };
  assert.notEqual((buggy(1), buggy(5)), (buggy(9), buggy(5)), 'accumulated state still breaks determinism with the prime on');
});

test('walkPath: distance = walking time x speed (not 1 m/s), pauses hold position, footprints align with the walker', () => {
  assert.equal(walkPathExport, walkPath);
  const p = walkPath([[0, 0, 0], [-40, 0, 2], [-70, 0, 1.5]], {t0: 2, speed: 1.68, stride: 0.45, pauses: [[10, 3]]});
  assert.ok(Math.abs(p.at(7).dist - 5 * 1.68) < 1e-9, 'speed must scale the walked distance');
  assert.ok(Math.abs(p.at(7).dist - 5) > 3, 'a 1 m/s walker would be metres behind');
  assert.deepEqual(p.at(11).pos, p.at(12.9).pos, 'paused: same position'); assert.equal(p.at(11.5).speed, 0); assert.ok(p.at(11.5).walkW < 1e-6); assert.ok(p.at(11.5).paused);
  assert.ok(Math.abs(p.at(15).dist - (15 - 2 - 3) * 1.68) < 1e-9, 'walking resumes after the pause');
  let worst = 0;
  for (const fp of p.prints()) { const w = p.at(fp.birth); worst = Math.max(worst, Math.abs(w.dist - fp.dist), Math.hypot(w.pos[0] - fp.pos[0], w.pos[2] - fp.pos[2])); }
  assert.ok(worst < 1e-9, `print birth must be the moment she stands on it (error ${worst})`);
  assert.equal(p.prints().length, Math.floor(p.length / 0.45 + 1e-9));
  assert.equal(p.at(p.tEnd + 10).dist, p.length); assert.equal(p.at(0).dist, 0); assert.equal(p.at(0).walkW, 0);
  const seq = [3, 50, 11, 3, 7].map((t) => JSON.stringify(p.at(t)));
  assert.equal(seq[0], seq[3], 'pure function of t (seek order does not matter)');
  const dir = walkPath([[0, 0, 0], [0, 0, 10]]).at(1); assert.ok(Math.abs(dir.yaw) < 1e-12, '+Z-forward rig: yaw 0 walks +z');
  assert.ok(Math.abs(walkPath([[0, 0, 0], [10, 0, 0]]).at(1).heading) < 1e-12, '+X-forward convention: heading 0 walks +x');
  assert.throws(() => walkPath([[0, 0, 0]]), /two/); assert.throws(() => walkPath([[0, 0, 0], [1, 0, 0]], {speed: 0}), /speed/);
  assert.throws(() => walkPath([[0, 0, 0], [1, 0, 0]], {pauses: [[1, 2], [2, 1]]}), /overlap/);
});

test('credits come only from explicit project fields: empty -> no card; placeholders rejected; undeclared cards reported', () => {
  assert.deepEqual(creditTitles(), []); assert.deepEqual(creditTitles({}), []);
  assert.deepEqual(creditTitles({title: {text: ''}, roles: [['', '']], creator: {name: '  '}}), [], 'blank fields generate nothing');
  const t = creditTitles({title: {text: 'Night Road'}, roles: [['Direction', 'A. Person']]}, {duration: 60});
  assert.deepEqual(t.map((c) => c.kind), ['title', 'roles']); assert.equal(t[1].t1, 59);
  for (const bad of ['TODO', '作者', '{{author}}', '<name>', '${AUTHOR}']) assert.throws(() => creditTitles({creator: {name: bad}}), /placeholder/, bad);
  assert.throws(() => normalizeCredits({studio: 'x'}), /unknown field/);
  assert.deepEqual([...CREDIT_FIELDS], ['title', 'roles', 'creator']);
  // a card copied from another work into the timeline is reported, a declared one is not, captions are not credits
  const titles = [{kind: 'title', text: 'Night Road'}, {kind: 'creator', name: 'Someone Else'}, {kind: 'text', text: 'a caption'}];
  assert.deepEqual(undeclaredCredits(titles, {title: {text: 'Night Road'}}), [{index: 1, kind: 'creator', text: 'Someone Else'}]);
  assert.deepEqual(undeclaredCredits(titles.slice(0, 1), {}).map((u) => u.text), ['Night Road'], 'no declared credits -> every credit card is undeclared');
});

test('templates and starter carry no credits: starter credits are empty, no title/credit cards are generated', async () => {
  const {credits} = await import('../../templates/starters/music-video/src/credits.js');
  assert.deepEqual(credits, {}); assert.deepEqual(creditTitles(credits), []);
  for (const f of ['templates/starters/music-video/src/main.js', 'templates/starters/music-video/src/resident-runtime.js']) assert.match(await read(f), /import \{credits\} from '\.\/credits\.js'/);
  // no file shipped to a new project draws a title / creator / roles card or hard-codes lyricsConfig titles
  const files = [];
  const walk = async (d) => { for (const e of await readdir(path.join(root, d), {withFileTypes: true})) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else if (/\.(js|mjs|json|html)$/.test(e.name)) files.push(p); } };
  for (const d of ['templates/starters', 'tracks/music-video/sample']) await walk(d);
  files.push('scripts/new-project.mjs');
  for (const f of files) {
    const s = await read(f);
    assert.doesNotMatch(s, /kind\s*:\s*['"](?:creator|roles|credits)['"]/, `${f} must not ship a credit card`);
    assert.doesNotMatch(s, /lyricsConfig\s*[:=]\s*\{[^}]*titles/, `${f} must not hard-code title cards`);
  }
});
