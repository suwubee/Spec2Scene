// Author: suwubee
// engine/credits.js — opening / closing credits only from explicit project fields.
//
// Rule: templates, starters and generated projects never carry a work title, an author, a studio or a credit card of their
// own. A title or credit card exists only when the project fills the matching field in its credits config; an empty or
// missing field generates nothing. A credit card found in a timeline that the project's credits do not declare (e.g. a card
// copied from an earlier work) is reported as an engine error.
//
//   import {creditTitles} from './engine/credits.js';
//   lyricsConfig.titles = creditTitles(project.credits, {duration});   // {} -> []
//
// Fields (all optional, all explicit): title {text, sub?, t0?, t1?} · roles [[role, name], ...] with {t0?, t1?, heading?} via
// rolesCard · creator {name, label?} — never defaulted, never inferred from the environment, package.json or git.

export const CREDIT_FIELDS = Object.freeze(['title', 'roles', 'creator']);
const PLACEHOLDER = /^(?:todo|tbd|xxx+|n\/?a|none|placeholder|作者|署名|片名|作品名|名字|姓名|待定|待填)$|\{\{|\}\}|<[^>]*>|\$\{/i;
const CREDIT_KINDS = new Set(['title', 'credits', 'creator', 'roles']);

function text(v, where) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new TypeError(`${where}: string required`);
  const s = v.trim();
  if (s && PLACEHOLDER.test(s)) throw new RangeError(`${where}: "${s}" looks like a placeholder; leave the field empty to generate no card`);
  return s;
}
/** Normalise the explicit credit fields; empty strings / empty lists count as "not filled". Throws on placeholders and bad types. */
export function normalizeCredits(credits = {}) {
  if (credits === null || typeof credits !== 'object' || Array.isArray(credits)) throw new TypeError('credits must be an object');
  for (const k of Object.keys(credits)) if (!k.startsWith('_') && !CREDIT_FIELDS.includes(k)) throw new RangeError(`credits: unknown field "${k}" (${CREDIT_FIELDS.join(', ')})`);
  const out = {};
  if (credits.title) { const t = text(credits.title.text, 'credits.title.text'); if (t) out.title = {text: t, sub: text(credits.title.sub, 'credits.title.sub'), t0: credits.title.t0, t1: credits.title.t1}; }
  if (Array.isArray(credits.roles)) {
    const rows = credits.roles.map((r, i) => { if (!Array.isArray(r) || r.length !== 2) throw new TypeError(`credits.roles[${i}]: [role, name] required`); return [text(r[0], `credits.roles[${i}][0]`), text(r[1], `credits.roles[${i}][1]`)]; }).filter(([a, b]) => a && b);
    if (rows.length) out.roles = rows;
  }
  if (credits.creator) { const n = text(credits.creator.name, 'credits.creator.name'); if (n) out.creator = {name: n, label: text(credits.creator.label, 'credits.creator.label')}; }
  return out;
}
/** Title / credit cards for the lyric overlay, generated only from filled fields. timing: {duration, title:[t0,t1], end:[t0,t1]}. */
export function creditTitles(credits = {}, {duration = 60, title = null, end = null} = {}) {
  const c = normalizeCredits(credits), out = [];
  const endT = end || [Math.max(0, duration - 8), Math.max(0, duration - 1)];
  if (c.title) out.push({kind: 'title', text: c.title.text, ...(c.title.sub ? {sub: c.title.sub} : {}), t0: c.title.t0 ?? (title ? title[0] : 2), t1: c.title.t1 ?? (title ? title[1] : 7)});
  if (c.roles) out.push({kind: 'roles', rows: c.roles, t0: endT[0], t1: endT[1]});
  if (c.creator) out.push({kind: 'creator', name: c.creator.name, ...(c.creator.label ? {label: c.creator.label} : {}), t0: endT[0], t1: endT[1]});
  return out;
}
/** Every credit-like text drawn by a titles list (title text/sub, credit lines, creator, roles). */
function cardTexts(T) {
  if (T.kind === 'title') return [T.text, T.sub];
  if (T.kind === 'creator') return [T.name, T.small, T.label, typeof T.seal === 'string' ? T.seal : ''];
  if (T.kind === 'roles') return [T.heading, ...[...(T.rows || []), ...(T.pages || []).flatMap((p) => p.rows || [])].flat()];
  if (T.kind === 'credits') return (T.lines || []).map((l) => (typeof l === 'object' ? l.text : l));
  return [];
}
/**
 * Credit cards in a titles list that the explicit credits do not declare: [{index, kind, text}]. Plain 'text' cards (captions)
 * are not credits and are ignored. Use in tests / QA; the engine records each one as an error.
 */
export function undeclaredCredits(titles = [], credits = {}) {
  const c = normalizeCredits(credits);
  const allowed = new Set([c.title?.text, c.title?.sub, ...(c.roles || []).flat(), c.creator?.name, c.creator?.label].filter(Boolean));
  const bad = [];
  (titles || []).forEach((T, index) => {
    if (!T || !CREDIT_KINDS.has(T.kind)) return;
    for (const s of cardTexts(T)) { const v = typeof s === 'string' ? s.trim() : ''; if (v && !allowed.has(v)) bad.push({index, kind: T.kind, text: v}); }
  });
  return bad;
}
