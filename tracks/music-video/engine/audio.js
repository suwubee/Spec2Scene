// Author: suwubee
// engine/audio.js — song data access for Sets (NOT audio playback; the player uses an <audio> tag).
// Everything is a pure function of time t (seconds, film time == song time).
//
//   const song = await loadSong('data/song.json');
//   const audio = createAudio(song);
//   audio.energy('strings', t)            // 0..1, smoothly interpolated
//   audio.notes('plucks', t0, t1)          // notes with start in [t0,t1)
//   audio.lastNote('strings', t)          // last note started at or before t (or null)
//   audio.pluck('strings', t, {decay:0.6})// summed exp-decay envelope of recent notes (string vibration)
//   audio.beatPhase(t), audio.barIndex(t), audio.sectionAt(t) ...
import { lastIndexLE, sampleArrayCR, clamp } from './util.js';

const INSTRUMENTS = []; // Instrument names are supplied by the project.

/** Fetch and normalize explicitly supplied song data. Missing input rejects; no synthetic fallback. */
export async function loadSong(url = 'data/song.json', { base } = {}) {
  const tryLoad = async (u) => {
    const r = await fetch(base ? new URL(u, base) : u, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
    return r.json();
  };
  const raw = await tryLoad(url);
  return normalizeSong(raw);
}

/** fetch data/events.json (curated sync cues). Missing file → empty list (never throws). */
export async function loadEvents(url = 'data/events.json', { base } = {}) {
  try {
    const r = await fetch(base ? new URL(url, base) : url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return normalizeEvents(await r.json());
  } catch (e) {
    console.warn('[audio] no events:', url, '-', e.message);
    return [];
  }
}

/** events.json → sorted [{t, kind, d, s, n, note, target, to, ...}] (accepts {events:[…]} or a bare array; k|kind) */
export function normalizeEvents(raw) {
  const list = Array.isArray(raw) ? raw : (raw && raw.events) || [];
  return list.map((e, i) => ({ ...e, index: i, t: +e.t, kind: e.k || e.kind || 'event', d: e.d ?? 0, s: e.s ?? 1, n: e.n ?? 1 }))
    .filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
}

/** Accepts the brief's schema with some tolerance (name/id, start/end, objects vs numbers). */
export function normalizeSong(raw) {
  const s = raw || {};
  const num = (v) => (typeof v === 'number' ? v : v && typeof v.t === 'number' ? v.t : NaN);
  const beats = (s.beats || []).map(num).filter(Number.isFinite).sort((a, b) => a - b);
  const bars = (s.bars || []).map(num).filter(Number.isFinite).sort((a, b) => a - b);
  const sections = (s.sections || []).map((x, i) => {
    const id = x.id || x.name || x.label || `s${i}`;
    return { ...x, id, name: id, label: x.label || id, t0: x.t0 ?? x.start ?? 0, t1: x.t1 ?? x.end ?? 0, kind: x.kind || '', index: i };
  }).sort((a, b) => a.t0 - b.t0);
  const notes = {};
  for (const k of new Set([...INSTRUMENTS, ...Object.keys(s.notes || {})])) {
    notes[k] = ((s.notes && s.notes[k]) || []).map((n) => ({ ...n, t: n.t ?? n.t0 ?? 0, dur: n.dur ?? (n.t1 != null ? n.t1 - n.t0 : 0.3), midi: n.midi ?? 60, vel: n.vel ?? 0.7 }))
      .sort((a, b) => a.t - b.t);
  }
  const E = s.energy || {};
  const energy = { fps: E.fps || s.energyFps || 25 };
  for (const k of Object.keys(E)) if (Array.isArray(E[k])) energy[k] = E[k];
  const lyrics = (s.lyrics || []).map((l, i) => {
    const text = l.text || (l.chars || []).map((c) => c.c).join('');
    let chars = l.chars;
    if (!chars || !chars.length) { // distribute evenly
      const g = [...text].filter((c) => c.trim());
      chars = g.map((c, k) => ({ c, t0: l.t0 + (l.t1 - l.t0) * k / g.length, t1: l.t0 + (l.t1 - l.t0) * (k + 1) / g.length }));
    }
    return { ...l, index: i, text, t0: l.t0 ?? chars[0].t0, t1: l.t1 ?? chars[chars.length - 1].t1, chars };
  }).sort((a, b) => a.t0 - b.t0);
  const duration = s.duration || Math.max(beats[beats.length - 1] || 0, ...(sections.map((x) => x.t1)), 1);
  return { ...s, title: s.title || '', duration, bpm: s.bpm || (beats.length > 1 ? 60 / medianPeriod(beats) : 60), beats, bars, sections, notes, energy, lyrics, mock: !!s.mock };
}

function medianPeriod(arr) {
  if (arr.length < 2) return 1;
  const d = [];
  for (let i = 1; i < arr.length; i++) d.push(arr[i] - arr[i - 1]);
  d.sort((a, b) => a - b);
  return d[d.length >> 1];
}

/** phase/index helper on an (irregular) grid with extrapolation by the median period */
function gridPos(grid, period, t) {
  if (!grid.length) return { index: Math.floor(t / period), phase: ((t / period) % 1 + 1) % 1, t0: Math.floor(t / period) * period, t1: Math.floor(t / period) * period + period };
  if (t < grid[0]) {
    const k = Math.ceil((grid[0] - t) / period);
    const t0 = grid[0] - k * period;
    return { index: -k, phase: (t - t0) / period, t0, t1: t0 + period };
  }
  const i = lastIndexLE(grid, t);
  if (i >= grid.length - 1) {
    const last = grid[grid.length - 1];
    const k = Math.floor((t - last) / period);
    const t0 = last + k * period;
    return { index: grid.length - 1 + k, phase: (t - t0) / period, t0, t1: t0 + period };
  }
  const t0 = grid[i], t1 = grid[i + 1];
  return { index: i, phase: (t - t0) / (t1 - t0), t0, t1 };
}

export function createAudio(song, eventList = []) {
  const S = song.beats ? song : normalizeSong(song);
  const EV = Array.isArray(eventList) && eventList.length && eventList[0].kind === undefined ? normalizeEvents(eventList) : (eventList || []);
  const evByKind = new Map();
  for (const e of EV) { if (!evByKind.has(e.kind)) evByKind.set(e.kind, []); evByKind.get(e.kind).push(e); }
  const evList = (kind) => (kind === undefined || kind === null || kind === '*' ? EV : Array.isArray(kind) ? EV.filter((e) => kind.includes(e.kind)) : evByKind.get(kind) || []);
  // knock-like events (n strikes spread over d) expand into individual strikes for pulse()
  const strikes = (e) => (e.n > 1 && e.d > 0 ? Array.from({ length: e.n }, (_, i) => e.t + (e.d * i) / (e.n - 1)) : [e.t]);
  const sstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  // window envelope: rises over `attack` from e.t, holds to e.t+d, releases over `release`
  const windowEnv = (list, t, attack, release) => {
    let v = 0;
    for (const e of list) {
      if (e.t - 0.001 > t) break;
      const end = e.t + e.d;
      if (t > end + release) continue;
      const a = sstep((t - e.t) / attack), r = t <= end ? 1 : 1 - sstep((t - end) / release);
      v = Math.max(v, e.s * a * r);
    }
    return v;
  };
  const beatPeriod = medianPeriod(S.beats) || 60 / (S.bpm || 60);
  const barPeriod = S.bars.length > 1 ? medianPeriod(S.bars) : beatPeriod * 4;
  const noteStarts = {};
  for (const k of Object.keys(S.notes)) noteStarts[k] = S.notes[k].map((n) => n.t);
  const list = (inst) => {
    const a = S.notes[inst];
    if (!a) throw new Error(`[audio] unknown instrument '${inst}' (have: ${Object.keys(S.notes).join(', ')})`);
    return a;
  };

  const api = {
    song: S,
    duration: S.duration,
    bpm: S.bpm,
    beatPeriod,
    barPeriod,
    instruments: Object.keys(S.notes),

    /** energy curve value at t (Catmull-Rom interpolated), 0 if the curve is missing */
    energy(name, t) {
      const arr = S.energy[name];
      if (!arr) return 0;
      return sampleArrayCR(arr, t * S.energy.fps);
    },
    /** average of an energy curve over [t-w, t] — a cheap "smoothed" reading (w seconds) */
    energyAvg(name, t, w = 0.5, steps = 8) {
      let s = 0;
      for (let i = 0; i < steps; i++) s += api.energy(name, t - w * (i + 0.5) / steps);
      return s / steps;
    },
    /** notes of `inst` whose start is in [t0, t1) */
    notes(inst, t0, t1) {
      const a = list(inst), st = noteStarts[inst];
      let i = lastIndexLE(st, t0 - 1e-9) + 1;
      const out = [];
      for (; i < a.length && a[i].t < t1; i++) out.push(a[i]);
      return out;
    },
    /** last note started at or before t, or null */
    lastNote(inst, t) {
      const i = lastIndexLE(noteStarts[inst] || [], t);
      return i >= 0 ? list(inst)[i] : null;
    },
    /** first note starting after t, or null */
    nextNote(inst, t) {
      const i = lastIndexLE(noteStarts[inst] || [], t) + 1;
      const a = list(inst);
      return i < a.length ? a[i] : null;
    },
    /**
     * Summed exponential-decay envelope of notes started at or before t:
     *   Σ vel * (1-exp(-dt/attack)) * exp(-dt/decay)
     * opts: decay (s, default 0.6), attack (s, default 0.004), gain,
     *       midi (only notes within ±midiTol semitones of this pitch — e.g. one string), midiTol (0.5),
     *       midiRange [lo,hi], filter(note)=>bool, maxAge (default 7*decay)
     */
    pluck(inst, t, opts = {}) {
      const { decay = 0.6, attack = 0.004, gain = 1, midi, midiTol = 0.5, midiRange, filter, maxAge = 7 * (opts.decay || 0.6) } = opts;
      const a = list(inst), st = noteStarts[inst];
      let i = lastIndexLE(st, t);
      let sum = 0;
      for (; i >= 0; i--) {
        const n = a[i], dt = t - n.t;
        if (dt > maxAge) break;
        if (midi !== undefined && Math.abs(n.midi - midi) > midiTol) continue;
        if (midiRange && (n.midi < midiRange[0] || n.midi > midiRange[1])) continue;
        if (filter && !filter(n)) continue;
        sum += n.vel * (attack > 0 ? 1 - Math.exp(-dt / attack) : 1) * Math.exp(-dt / decay);
      }
      return sum * gain;
    },
    /** beat position: {index, phase, t0, t1}; phase in [0,1) */
    beat(t) { return gridPos(S.beats, beatPeriod, t); },
    beatPhase(t) { return gridPos(S.beats, beatPeriod, t).phase; },
    beatIndex(t) { return gridPos(S.beats, beatPeriod, t).index; },
    /** bar position: {index, phase, t0, t1} */
    bar(t) { return gridPos(S.bars, barPeriod, t); },
    barIndex(t) { return gridPos(S.bars, barPeriod, t).index; },
    barPhase(t) { return gridPos(S.bars, barPeriod, t).phase; },
    /** section containing t: {id, label, t0, t1, kind, index, u (0..1 progress)} */
    sectionAt(t) {
      const secs = S.sections;
      if (!secs.length) return { id: 'all', name: 'all', label: '', t0: 0, t1: S.duration, kind: '', index: 0, u: clamp(t / S.duration) };
      let i = lastIndexLE(secs, t, (s) => s.t0);
      if (i < 0) i = 0;
      const s = secs[i];
      return { ...s, u: clamp((t - s.t0) / Math.max(1e-6, s.t1 - s.t0)) };
    },
    /** lyric line active at t (t0 <= t <= t1), or null */
    lyricAt(t) {
      const i = lastIndexLE(S.lyrics, t, (l) => l.t0);
      if (i < 0) return null;
      const l = S.lyrics[i];
      return t <= l.t1 ? l : null;
    },
    // ---------------- curated events (data/events.json) ----------------
    /** all events (normalised, sorted) */
    eventList: EV,
    /** events of `kind` ('hush'|'hit'|…|'*'|[kinds]) with start in [t0, t1) */
    events(kind, t0 = -Infinity, t1 = Infinity) { return evList(kind).filter((e) => e.t >= t0 && e.t < t1); },
    /** last event of `kind` started at or before t (or null) */
    lastEvent(kind, t) { const a = evList(kind); const i = lastIndexLE(a, t, (e) => e.t); return i >= 0 ? a[i] : null; },
    /** first event of `kind` starting after t (or null) */
    nextEvent(kind, t) { const a = evList(kind); const i = lastIndexLE(a, t, (e) => e.t) + 1; return i < a.length ? a[i] : null; },
    /** 0..1 inside hush windows (accompaniment near silence): 0.35 s attack, 0.5 s release, × s */
    hush(t, { attack = 0.35, release = 0.5 } = {}) { return windowEnv(evList('hush'), t, attack, release); },
    /** 0..1 over shimmer (tremolo) windows: smooth 0.15 s attack, 0.45 s release, × s */
    shimmer(t, { attack = 0.15, release = 0.45 } = {}) { return windowEnv(evList('shimmer'), t, attack, release); },
    /**
     * pluck()-style summed exp-decay of events of `kind`, weighted by s:
     *   Σ s·(1−e^{−dt/attack})·e^{−dt/decay}   (knock events with n>1, d>0 expand into n strikes over d)
     * opts: attack (s, 0.01), decay (s, 0.6), filter(e)=>bool, maxAge (7·decay)
     */
    pulse(kind, t, { attack = 0.01, decay = 0.6, filter, maxAge } = {}) {
      const a = evList(kind), age = maxAge ?? 7 * decay;
      let sum = 0;
      for (let i = lastIndexLE(a, t, (e) => e.t); i >= 0; i--) {
        const e = a[i];
        if (t - (e.t + e.d) > age) { if (t - e.t > age + 30) break; continue; }
        if (filter && !filter(e)) continue;
        for (const ts of strikes(e)) {
          const dt = t - ts;
          if (dt < 0 || dt > age) continue;
          sum += e.s * (attack > 0 ? 1 - Math.exp(-dt / attack) : 1) * Math.exp(-dt / decay);
        }
      }
      return sum;
    },

    /** 0..1 how "sung" the moment is (vocal note envelope, 60 ms attack, holds for the note) */
    vocalActive(t) {
      const n = api.lastNote('vocal', t);
      if (!n) return 0;
      const dt = t - n.t;
      if (dt > n.dur + 0.6) return 0;
      return clamp(dt / 0.06) * (dt < n.dur ? 1 : Math.exp(-(dt - n.dur) / 0.2));
    },
  };
  return api;
}
