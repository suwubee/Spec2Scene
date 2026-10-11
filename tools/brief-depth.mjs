#!/usr/bin/env node
// Design-depth gate (model-free, no dependencies). The designer writes set briefs, the storyboard and the asset
// bible to a minimum depth; implementers only backfill results. This tool parses the markdown and FAILS when:
//   · a set brief lacks a core heading (平面/尺寸, 构件表, 灯光, 镜头预设, 验收, 回填/实现结果);
//   · the component table lacks a column (件 | 尺寸 | 材质(色值) | 程序做法 | L1 | L2 | L3 | 来源) that cannot be recovered
//     from referenced sections, or a row has an empty cell, a material without a colour value (#hex, numbers or a named
//     palette colour), a procedure without a named library function, or no source tag (REUSE/ADAPT/NEW-GLM/NEW-HARD) —
//     unless the row references a component section (ID such as A6 / E2b, or a heading naming it) that supplies it;
//   · a NEW-HARD part has no recipe, or the recipe lacks one of the eight parts ①–⑧ (inline or one per line);
//   · a storyboard shot lacks a frame bill of materials field (前景/中景/远景/天空/二级运动 ≥ 2/人物屏高/主光/轮廓光/构图);
//   · designer-owned text contains delegation phrases (DELEGATION below) or unfilled <placeholders>;
//   · a set brief has fewer designer-written bytes than --min-bytes (template lines and implementer sections do not count).
// Equivalent but differently phrased content (synonym labels, cells filled by reference, a single figure height without
// a tolerance, a missing purpose section) is reported as WARN and does not fail. Sections whose heading marks them as the
// implementer's (回填 / 实现结果 / 会话自写 …) are excluded from all checks.
import {readFile, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {isMain} from './lib/cli.mjs';

export const DEFAULTS = Object.freeze({minBytes: 10000, minRows: 8});
export const SET_HEADINGS = Object.freeze([
  ['平面与尺寸', /平面|尺寸|空间|plan|layout/i], ['构件表', /构件|道具|component/i], ['灯光与氛围', /灯光|光照|光$|light/i],
  ['镜头预设', /镜头预设|预设|机位|camera preset|lens/i], ['验收清单', /验收|acceptance/i], ['回填', /回填|backfill|实现结果|记录区|implementer/i]]);
const PURPOSE = /目的|边界|purpose/i;
const IMPLEMENTER = /回填|backfill|实现结果|记录区|会话.{0,8}自写|实现者.{0,4}自写|实现级设计|implementer/i;
export const COLUMNS = Object.freeze([
  ['件', /件|component|part/i], ['尺寸', /尺寸|size|dimension/i], ['材质', /材质|material/i], ['程序做法', /做法|procedure|method|function/i],
  ['L1', /^L1\b/i], ['L2', /^L2\b/i], ['L3', /^L3\b/i], ['来源', /来源|source/i]]);
export const SOURCES = Object.freeze(['REUSE', 'ADAPT', 'NEW-GLM', 'NEW-HARD']);
export const RECIPE_PARTS = Object.freeze(['① 步骤', '② 几何与拓扑', '③ 函数', '④ 材质数值', '⑤ 检查台', '⑥ 数值验收', '⑦ 失败模式与检测', '⑧ 降级方案']);
const MARKS = [...'①②③④⑤⑥⑦⑧'];
export const BOM_FIELDS = Object.freeze([
  ['前景', ['前景', 'foreground', 'fg']], ['中景', ['中景', 'midground', 'mid']], ['远景', ['远景', 'background', 'far']],
  ['天空', ['天空', '天', 'sky']], ['二级运动', ['二级运动源', '二级运动', 'secondary motion', 'motion']],
  ['人物屏高', ['人物屏幕高度', '人物屏高', '人物', 'figure']], ['主光', ['主光', 'key light', 'key']], ['轮廓光', ['轮廓光', '轮廓', 'rim light', 'rim']]]);
/** Labels that carry the same field in other phrasing: accepted with a WARN. */
export const BOM_SYNONYMS = Object.freeze([
  ['前景', ['近景']], ['远景', ['背景', '后景']], ['二级运动', ['次级运动', '运动源', '运动']],
  ['主光', ['主光源', '光线', '灯光', '照明', '光源', '光', '灯']], ['轮廓光', ['边光', '勾边', '逆光', '分离', 'separation']]]);
export const DELEGATION = Object.freeze(['由实现者回填', '实现者回填', '由实现者决定', '实现者决定', '实现者自定', '交给实现者', '留给实现者', '细节由实现者',
  '自行决定', '自行发挥', '自由发挥', '实现时再定', '后续补充', '待定', '精简版', 'TBD', 'TODO']);
const NEGATION = /(?:不|禁止|不得|不许|严禁|勿|不能|不要|\bnever|\bno|\bnot)\s*(?:写|用|出现|留|使用|允许|接受|write|use)?\s*[“"'「（(]?\s*$/i;
const PLACEHOLDER = /<(?=[^\s<>=])[^<>\n]{0,80}(?<=[^\s<>=-])>/g;
const EMPTY = /^(?:[-—–…?？]+|\.{2,}|n\/?a)?$/i;
const BARE_NONE = /^(?:无|none|n\/a)[。.]?$/i;
const ID = /(?<![A-Za-z0-9])([A-Z]{1,2}\d{1,3}[a-z]?)(?![A-Za-z0-9])/g;

// ---------- markdown helpers ----------
const clean = s => s.replace(/`/g, '').replace(/\*\*/g, '').replace(PLACEHOLDER, '').trim();
const isEmpty = s => EMPTY.test(clean(s));
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function stripFences(lines) { let inFence = false; return lines.map(l => { if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; return ''; } return inFence ? '' : l; }); }
function splitRow(line) {
  const cells = [];
  let cur = '';
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') { cur += '|'; i++; } else if (body[i] === '|') { cells.push(cur.trim()); cur = ''; } else cur += body[i];
  }
  cells.push(cur.trim());
  return cells;
}
/** Tables in a block of lines (fenced code ignored): [{line, header:[…], rows:[{line, cells}]}] */
export function tables(lines, offset = 0) {
  const plain = stripFences(lines), out = [];
  for (let i = 0; i < plain.length; i++) {
    if (!/^\s*\|/.test(plain[i]) || !/^\s*\|?\s*:?-{2,}/.test(plain[i + 1] || '')) continue;
    const t = {line: offset + i + 1, header: splitRow(plain[i]), rows: []};
    let j = i + 2;
    for (; j < plain.length && /^\s*\|/.test(plain[j]); j++) t.rows.push({line: offset + j + 1, cells: splitRow(plain[j])});
    out.push(t); i = j - 1;
  }
  return out;
}
/** Sections by heading level: [{level, title, start, end, lines}] (start/end are 0-based line indexes, end exclusive). */
export function sections(text) {
  const lines = text.split(/\r?\n/), plain = stripFences(lines), heads = [];
  plain.forEach((l, i) => { const m = l.match(/^(#{1,6})\s+(.*)$/); if (m) heads.push({level: m[1].length, title: m[2].trim(), start: i}); });
  for (let k = 0; k < heads.length; k++) {
    let end = lines.length;
    for (let n = k + 1; n < heads.length; n++) if (heads[n].level <= heads[k].level) { end = heads[n].start; break; }
    heads[k].end = end; heads[k].lines = lines.slice(heads[k].start, end); heads[k].first = k === 0;
  }
  return heads;
}
/** Implementer-owned section: a level-1/2 heading (not the document title) marked 回填 / 实现结果 / 会话自写 … */
const isBackfill = s => s.level <= 2 && !s.first && IMPLEMENTER.test(s.title);
function designerMask(text) {
  const lines = text.split(/\r?\n/), mask = lines.map(() => true);
  for (const s of sections(text)) if (isBackfill(s)) for (let i = s.start; i < s.end; i++) mask[i] = false;
  return mask;
}
const idsIn = text => [...new Set([...String(text).matchAll(ID)].map(m => m[1]).filter(id => !/^L[123]$/.test(id)))];
/** IDs named as NEW-HARD: the ID just before a NEW-HARD tag (“透镜 E2b NEW-HARD” → E2b). */
function hardIdsIn(text) {
  const out = [], s = clean(String(text));
  for (const m of s.matchAll(/NEW-HARD/g)) { const before = s.slice(Math.max(0, m.index - 28), m.index); const ids = idsIn(before); if (ids.length) out.push(ids.at(-1)); }
  return out;
}
const tagsIn = text => SOURCES.filter(t => new RegExp(`(^|[^A-Z-])${t}($|[^A-Z-])`).test(clean(String(text)).toUpperCase()));
const hasColour = s => /#[0-9a-f]{3,8}\b|\d*\.\d+|\b\d+\s*K\b|\[\s*\d|\(\s*\d*\.\d/i.test(s);
const FN = [/[A-Za-z_$][\w$.]*\s*\(/, /`[A-Za-z_$][\w$./:-]*`/, /(?<![\w$])[a-z]+[A-Z][A-Za-z0-9]*/, /(?<![\w$.])[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*/];
const hasFunction = (s, library) => FN.some(re => re.test(s)) || (!!library && [...String(s).matchAll(/(?<![\w$])([A-Za-z_$][\w$]{2,})(?![\w$])/g)].some(m => library.has(m[1])));
const identifiers = s => [...String(s).matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)/g)].map(m => m[1]).filter(n => /[a-z][A-Z]|^[A-Z][a-z]+[A-Z]/.test(n) || n.length > 3);

// ---------- cross-document index ----------
/** Index of component sections (by ID in the heading), palette colour names and recipes over all documents. */
export function buildIndex(docs, {exports = null, library = null} = {}) {
  const refs = new Map(), palette = new Set(), allRecipes = [];
  for (const d of docs) {
    for (const s of sections(d.text)) {
      if (s.level < 2 || isBackfill(s)) continue;
      for (const id of idsIn(s.title)) { if (!refs.has(id)) refs.set(id, []); refs.get(id).push({file: d.file, title: s.title, text: s.lines.join('\n')}); }
    }
    for (const t of tables(d.text.split(/\r?\n/))) for (const r of t.rows) if (r.cells.some(c => /#[0-9a-f]{6}\b/i.test(c))) {
      const name = clean(r.cells[0] || ''); if (!name || /#/.test(name)) continue;
      palette.add(name); const short = name.split(/[（(\s]/)[0]; if (short.length >= 1) palette.add(short);
    }
    for (const r of recipes(d.text)) allRecipes.push({...r, file: d.file});
  }
  return {refs, palette, recipes: allRecipes, exports, library: new Set([...(library || []), ...(exports || [])])};
}

// ---------- checks ----------
export function delegationHits(text, mask) {
  const hits = [], lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (mask && !mask[i]) return;
    for (const phrase of DELEGATION) {
      const re = new RegExp(/^[A-Z]+$/.test(phrase) ? `\\b${phrase}\\b` : esc(phrase), /^[A-Z]+$/.test(phrase) ? 'g' : 'gi');
      for (const m of line.matchAll(re)) if (!NEGATION.test(line.slice(Math.max(0, m.index - 8), m.index))) hits.push({line: i + 1, phrase, text: line.trim().slice(0, 120)});
    }
  });
  return hits;
}
/** Unfilled template placeholders; a <name> used as a variable inside a path (…/<set>/…) is not a placeholder. */
export function placeholders(line) {
  const pathVars = new Set([...line.matchAll(/[/\\](<[^<>\s]+>)|(<[^<>\s]+>)[/\\]/g)].map(m => m[1] || m[2]));
  return (line.match(PLACEHOLDER) || []).filter(p => !pathVars.has(p));
}

function columnIndex(header) {
  const idx = {};
  for (const [name, re] of COLUMNS) { const i = header.findIndex(h => re.test(clean(h)) && !(name === '件' && /来源|source/i.test(clean(h)))); if (i >= 0) idx[name] = i; }
  return idx;
}
export const componentKey = cell => clean(cell).split(/[\s×x*（(,，/、:：]+/).filter(Boolean)[0] || clean(cell);

/** Text of the sections a row points to: IDs in any cell, or a heading (level ≥ 3) naming the component. */
function rowReference(cells, index, nameIdx, ownTitle) {
  if (!index) return {ids: [], titles: [], text: ''};
  const ids = idsIn(cells.join(' ')), hits = [];
  for (const id of ids) for (const e of index.refs.get(id) || []) if (e.title !== ownTitle) hits.push(e);
  const key = componentKey(cells[nameIdx] || '');
  if (key && key.length >= 2 && !ids.includes(key)) for (const list of index.refs.values()) for (const e of list) if (e.title.includes(key) && e.title !== ownTitle && !hits.includes(e)) hits.push(e);
  return {ids, titles: hits.map(h => h.title), text: hits.map(h => h.text).join('\n')};
}

/** Check one component table; returns {rows, missingColumns, problems:[…], warnings:[…], newHard:[{key, line}]} */
export function checkComponentTable(table, {index = null, ownTitle = null} = {}) {
  const idx = columnIndex(table.header), problems = [], warnings = [], newHard = [];
  let missingColumns = COLUMNS.map(c => c[0]).filter(c => idx[c] === undefined);
  const nameIdx = idx['件'] ?? 0, noSource = [];
  const palette = index?.palette || new Set();
  for (const row of table.rows) {
    const cells = row.cells, name = clean(cells[nameIdx] || '') || `row ${row.line}`, at = `line ${row.line} ${name}`;
    const ref = rowReference(cells, index, nameIdx, ownTitle), byRef = ref.text.length > 0;
    const absent = cells.slice(1).some(c => /^(无|none|不建|不做)\s*[（(:：].{4,}/.test(clean(c)));
    if (absent) { warnings.push(`${at}: declared absent in this set (${cells.slice(1).map(clean).find(c => /^(无|none|不建|不做)/.test(c)).slice(0, 40)})`); continue; }
    const empties = table.header.map((h, c) => [clean(h) || String(c + 1), c]).filter(([, c]) => isEmpty(cells[c] ?? ''));
    for (const [h] of empties) (byRef ? warnings : problems).push(`${at}: empty cell "${h}"${byRef ? ` (supplied by ${ref.ids.join('/') || ref.titles[0]})` : ''}`);
    const cell = name => (idx[name] === undefined ? '' : cells[idx[name]] ?? '');
    if (idx['尺寸'] !== undefined && !isEmpty(cell('尺寸')) && !/\d/.test(cell('尺寸')) && !(byRef && /\d/.test(ref.text))) problems.push(`${at}: size has no number`);
    const mat = cell('材质');
    if (idx['材质'] !== undefined && !isEmpty(mat) && !hasColour(mat) && ![...palette].some(p => p.length >= 1 && mat.includes(p)) && !(byRef && hasColour(ref.text))) problems.push(`${at}: material has no colour value (#hex, numbers or a palette colour name)`);
    const proc = cell('程序做法');
    if (idx['程序做法'] !== undefined && !isEmpty(proc) && !hasFunction(proc, index?.library) && !(byRef && hasFunction(ref.text, index?.library))) problems.push(`${at}: procedure names no library function`);
    if (index?.exports && idx['程序做法'] !== undefined && !isEmpty(proc)) {
      const names = identifiers(proc);
      if (names.length && !names.some(n => index.exports.has(n))) warnings.push(`${at}: none of ${names.slice(0, 4).join(', ')} is exported under --src`);
    }
    let tags = tagsIn(cell('来源'));
    if (!tags.length) tags = tagsIn(ref.titles.join(' '));
    if (!tags.length) { if (idx['来源'] !== undefined && !isEmpty(cell('来源'))) problems.push(`${at}: source must be REUSE/ADAPT/NEW-GLM/NEW-HARD`); else noSource.push(name); }
    if (tags.includes('NEW-HARD')) {
      const own = idx['来源'] !== undefined && tagsIn(cell('来源')).includes('NEW-HARD');
      const ids = own ? hardIdsIn(cells.join(' ')) : hardIdsIn(ref.titles.join(' '));
      for (const key of (ids.length ? ids : [own ? (idsIn(cells[nameIdx])[0] || componentKey(cells[nameIdx] || '')) : ref.ids[0] || componentKey(cells[nameIdx] || '')])) newHard.push({key, line: row.line});
    }
  }
  if (idx['来源'] === undefined) {
    if (noSource.length) problems.push(`component table (line ${table.line}): no 来源 column and no source tag in referenced sections for: ${noSource.join(', ')}`);
    else warnings.push(`component table (line ${table.line}): no 来源 column; sources taken from referenced component headings`);
    missingColumns = missingColumns.filter(c => c !== '来源');
  } else if (noSource.length) for (const n of noSource) problems.push(`${n}: empty cell "来源"`);
  return {rows: table.rows.length, missingColumns, problems, warnings, newHard};
}

/** Recipe blocks: a heading tagged NEW-HARD (level ≥ 3, or level 2 naming an ID), a 配方/recipe heading naming an ID,
 *  or any ### under a 难件配方 section. The parts ①–⑧ are found in order anywhere in the heading's span (inline or per line). */
export function recipes(text) {
  const out = [], secs = sections(text);
  const parentOf = s => secs.filter(p => p.level < s.level && p.start < s.start && p.end >= s.end).at(-1);
  const candidate = s => {
    if (s.level < 2 || isBackfill(s)) return false;
    const parent = parentOf(s);
    if (parent && isBackfill(parent)) return false;
    const ids = idsIn(s.title);
    if (/NEW-HARD/i.test(s.title)) return s.level >= 3 || ids.length > 0;
    if (/配方|recipe/i.test(s.title) && ids.length) return true;
    return s.level >= 3 && !!parent && /难件|配方|recipe/i.test(parent.title);
  };
  for (const s of secs) {
    if (!candidate(s)) continue;
    if (secs.some(c => c.start > s.start && c.end <= s.end && c.level > s.level && candidate(c))) continue;   // container of recipes
    const body = s.lines.slice(1).join('\n'), at = [];
    let pos = 0;
    for (const mk of MARKS) { const i = body.indexOf(mk, pos); at.push(i < 0 ? -1 : i + mk.length); if (i >= 0) pos = i + mk.length; }
    const parts = MARKS.map((mk, k) => {
      if (at[k] < 0) return {part: RECIPE_PARTS[k], problem: 'missing'};
      const next = Math.min(...at.filter(x => x > at[k]).map(x => x - 1), body.length);
      const content = clean(body.slice(at[k], next)).replace(/^[^：:\n]{0,16}[：:]/, '').trim();
      const backRef = /见上|见下|同上|见\s*§|see above|see below/i.test(content) && /\d/.test(body.slice(0, Math.max(0, at[0] - 1)));
      let problem = null;
      if (content.length < 8 && !backRef) problem = 'empty';
      else if (k === 5 && !/\d/.test(content)) problem = 'no numeric threshold';
      else if (k === 6 && !/→|->|检测|看法|detect|判读|测/i.test(content)) problem = 'no detection (write symptom → how it is detected → cause)';
      return {part: RECIPE_PARTS[k], problem};
    });
    const hard = hardIdsIn(s.title);
    out.push({title: s.title, line: s.start + 1, names: hard.length ? hard : idsIn(s.title), parts, missing: parts.filter(p => p.problem).map(p => `${p.part} ${p.problem}`)});
  }
  return out;
}

const figureBand = v => /\d+(?:\.\d+)?\s*%?\s*H?\s*(?:[–\-~～→]|to)\s*\d+(?:\.\d+)?\s*%/.test(v);
const figureTolerance = v => /\d+(?:\.\d+)?\s*%\s*H?\s*(?:[（(]\s*)?[±]\s*\d/.test(v);
const figureNone = v => BARE_NONE.test(v) || /^(无|空镜|none|0\s*%)/i.test(v) || /不入画|画外/.test(v);

/** Shot blocks of a storyboard text and their bill-of-materials problems (missing) and phrasing notes (warnings). */
export function shots(text, {sectionRe = null} = {}) {
  const secs = sections(text);
  let pool = secs.filter(s => s.level === 3);
  const scope = sectionRe ? secs.filter(s => s.level <= 2 && sectionRe.test(s.title)) : secs.filter(s => s.level <= 2 && /镜头表|逐镜|物料清单|shot ?list|shots/i.test(s.title));
  if (sectionRe || scope.length) pool = pool.filter(s => scope.some(p => s.start > p.start && s.end <= p.end));
  const labels = [...BOM_FIELDS.flatMap(([field, names]) => names.map(n => ({field, n, syn: false}))), ...BOM_SYNONYMS.flatMap(([field, names]) => names.map(n => ({field, n, syn: true})))].sort((a, b) => b.n.length - a.n.length);
  const one = labels.map(l => l.n.replace(/ /g, '\\s+')).join('|');
  const re = new RegExp(`(?:^|[\\s；;，,。：:(（*-])((?:${one})(?:\\s*[/／、&]\\s*(?:${one}))*)\\s*[：:=]`, 'gi');
  const find = n => labels.find(l => new RegExp(`^${l.n.replace(/ /g, '\\s+')}$`, 'i').test(n.trim()));
  return pool.map(s => {
    const body = s.lines.slice(1).join('\n'), plain = stripFences(s.lines.slice(1)).join('\n'), missing = [], warnings = [];
    const marks = [...plain.matchAll(re)].map(m => ({labels: m[1].split(/\s*[/／、&]\s*/).map(find).filter(Boolean), at: m.index + m[0].length, from: m.index}));
    const values = {};
    marks.forEach((m, k) => {
      const nl = plain.indexOf('\n', m.at);
      const next = Math.min(marks[k + 1]?.from ?? Infinity, nl === -1 ? Infinity : nl);
      const v = plain.slice(m.at, next === Infinity ? undefined : next).replace(/[；;。]\s*$/, '').trim();
      for (const l of m.labels) {
        const prev = values[l.field];
        if (!prev || (prev.syn && !l.syn) || (isEmpty(prev.v) && !isEmpty(v))) values[l.field] = {v, syn: l.syn, label: l.n};
      }
    });
    const fig = values['人物屏高'] ? clean(values['人物屏高'].v) : '';
    for (const [field] of BOM_FIELDS) {
      const e = values[field];
      if (!e) { if (field === '轮廓光' && fig && figureNone(fig)) warnings.push('轮廓光 not stated (no figure in shot)'); else missing.push(`${field} missing`); continue; }
      const v = e.v;
      if (isEmpty(v)) { missing.push(`${field} empty`); continue; }
      if (e.syn) warnings.push(`${field} present but phrased differently ("${e.label}")`);
      if (BARE_NONE.test(clean(v)) && !['天空', '人物屏高'].includes(field)) missing.push(`${field} is bare "无" (name the components or give the reason)`);
      if (field === '二级运动' && clean(v).split(/[、，,；;/／]|\s\+\s|\s和\s/).filter(x => clean(x).length > 0).length < 2) missing.push('二级运动 needs ≥ 2 sources');
      if (field === '人物屏高' && !figureNone(clean(v)) && !figureBand(v) && !figureTolerance(v)) {
        if (/\d+(?:\.\d+)?\s*%/.test(v)) warnings.push('人物屏高 is a single value; give a band (12–18% H) or a tolerance (15% H ±1%)');
        else missing.push('人物屏高 needs a band like 12–18% H, a tolerance like 15% H ±1%, or 无 for an empty shot');
      }
    }
    const fences = [...body.matchAll(/(```|~~~)[^\n]*\n([\s\S]*?)\1/g)].filter(m => m[2].split('\n').filter(l => l.trim()).length >= 2);
    if (!fences.length) missing.push('构图 sketch missing (fenced block ≥ 2 lines)');
    return {shot: s.title, line: s.start + 1, missing, warnings};
  });
}

// ---------- per file ----------
export function kindOf(file) {
  const b = path.basename(file);
  if (/^SET[-_ ].+\.md$/i.test(b) && !/^SET-brief\.md$/i.test(b)) return 'set';
  if (/^STORYBOARD.*\.md$/i.test(b)) return 'storyboard';
  if (/^CONCEPT.*\.md$/i.test(b)) return 'concept';
  if (/^ASSET[-_ ]?BIBLE.*\.md$/i.test(b)) return 'bible';
  return null;
}

export function designerBytes(text, mask, templateLines = new Set()) {
  return text.split(/\r?\n/).reduce((n, line, i) => {
    if (!mask[i]) return n;
    const t = line.trim();
    if (!t || templateLines.has(t) || /^\|?[\s:|-]+\|?$/.test(t)) return n;
    return n + Buffer.byteLength(t.replace(PLACEHOLDER, ''), 'utf8');
  }, 0);
}

/** Check one document. ctx: {kind, minBytes, minRows, templateLines, index (buildIndex over all docs), recipeTitles, needShots} */
export function checkDocument(text, ctx = {}) {
  const kind = ctx.kind, mask = designerMask(text), missing = [], warnings = [], secs = sections(text), lines = text.split(/\r?\n/);
  const index = ctx.index || buildIndex([{file: 'doc', text}]);
  const result = {kind, designerBytes: designerBytes(text, mask, ctx.templateLines), rows: 0, newHard: 0, recipes: 0, shots: 0, missing, warnings};
  for (const h of delegationHits(text, mask)) missing.push(`line ${h.line}: delegation phrase "${h.phrase}"`);
  const ownRecipes = recipes(text);
  result.recipes = ownRecipes.length;
  for (const r of ownRecipes) for (const m of r.missing) missing.push(`recipe "${r.title}": ${m}`);
  const compTables = [];
  if (kind === 'set') {
    const top = secs.filter(s => s.level === 2);
    for (const [name, re] of SET_HEADINGS) if (!top.some(s => re.test(s.title))) missing.push(`heading missing: ${name}`);
    if (!top.some(s => PURPOSE.test(s.title))) warnings.push('no 目的与边界 section (state the narrative function and what the set does not contain)');
    for (const s of top.filter(s => !isBackfill(s) && SET_HEADINGS.slice(0, 5).some(([, re]) => re.test(s.title)))) {
      const n = s.lines.reduce((a, l) => a + placeholders(l).length, 0);
      if (n) missing.push(`section "${s.title}": ${n} unfilled <placeholder>`);
    }
    const comp = top.find(s => /构件|道具|component/i.test(s.title));
    if (comp) {
      const t = tables(comp.lines, comp.start)[0];
      if (!t) missing.push('component table missing');
      else compTables.push({t, title: comp.title});
    }
    if (result.designerBytes < ctx.minBytes) missing.push(`designer-written ${result.designerBytes} B < ${ctx.minBytes} B minimum`);
  } else {
    for (const t of tables(lines)) { const c = columnIndex(t.header); if (c['来源'] !== undefined && c['件'] !== undefined) compTables.push({t, title: null}); }
  }
  const hard = [];
  for (const {t, title} of compTables) {
    const r = checkComponentTable(t, {index, ownTitle: title});
    result.rows += r.rows;
    if (r.missingColumns.length) missing.push(`component table (line ${t.line}) lacks columns: ${r.missingColumns.join(', ')}`);
    missing.push(...r.problems); warnings.push(...r.warnings);
    hard.push(...r.newHard);
  }
  if (kind === 'set' && compTables.length && result.rows < ctx.minRows) missing.push(`component table has ${result.rows} rows < ${ctx.minRows}`);
  result.newHard = new Set(hard.map(h => h.key)).size;
  const known = [...index.recipes, ...ownRecipes, ...(ctx.recipeTitles || []).map(title => ({title, names: idsIn(title)}))];
  const seen = new Set();
  for (const h of hard) {
    if (seen.has(h.key)) continue; seen.add(h.key);
    const k = h.key.toLowerCase();
    if (!known.some(r => (r.names || []).some(n => n.toLowerCase() === k) || r.title.toLowerCase().includes(k))) missing.push(`NEW-HARD "${h.key}" (line ${h.line}) has no recipe ①–⑧ (a section naming "${h.key}" here or in the asset bible)`);
  }
  if (kind === 'storyboard' || (kind === 'concept' && ctx.needShots)) {
    const list = kind === 'concept' ? shots(text, {sectionRe: /物料清单|bill of materials|逐镜/i}) : shots(text);
    result.shots = list.length;
    if (!list.length) missing.push(kind === 'concept' ? 'heading missing: 逐镜画面物料清单 with ### shot blocks' : 'no shot blocks (### <shot> under the shot list)');
    for (const s of list) { for (const m of s.missing) missing.push(`shot "${s.shot}" (line ${s.line}): ${m}`); for (const w of s.warnings) warnings.push(`shot "${s.shot}" (line ${s.line}): ${w}`); }
  }
  result.pass = missing.length === 0;
  return result;
}

async function templateLinesFor(dir, explicit) {
  const candidates = explicit ? [explicit] : [path.join(dir, 'SET-brief.md'), fileURLToPath(new URL('../templates/SET-brief.md', import.meta.url))];
  for (const c of candidates) { try { return new Set((await readFile(c, 'utf8')).split(/\r?\n/).map(l => l.trim()).filter(Boolean)); } catch {} }
  return new Set();
}

/** Exported names under a source directory (export function/const/class, export {a, b as c}). */
export async function sourceExports(dir) {
  const names = new Set();
  const walk = async d => {
    for (const e of await readdir(d, {withFileTypes: true})) {
      if (e.name === 'node_modules' || e.name === 'vendor' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.m?js$/.test(e.name)) {
        const s = await readFile(p, 'utf8');
        for (const m of s.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
        for (const m of s.matchAll(/export\s*(?:const|let)\s*\{([^}]*)\}/g)) for (const n of m[1].split(',')) { const x = n.split(':')[0].trim(); if (x) names.add(x); }
        for (const m of s.matchAll(/export\s*\{([^}]*)\}/g)) for (const n of m[1].split(',')) { const x = n.trim().split(/\s+as\s+/).pop().trim(); if (x) names.add(x); }
      }
    }
  };
  await walk(dir);
  return names;
}

/** Names exported by the engine, kits and character modules next to this tool (repository or generated project layout). */
export async function engineLibrary() {
  const names = new Set();
  for (const rel of ['../tracks/music-video/engine', '../tracks/music-video/kits', '../tracks/music-video/character', '../engine', '../kits', '../character']) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    try { if ((await stat(dir)).isDirectory()) for (const n of await sourceExports(dir)) names.add(n); } catch {}
  }
  return names;
}

/** Check a list of files (or a directory). Returns {pass, files:[{file, …result}]}. */
export async function checkBriefs({dir, files = [], minBytes = DEFAULTS.minBytes, minRows = DEFAULTS.minRows, template, src} = {}) {
  let list = [...files];
  if (dir) list.push(...(await readdir(dir)).filter(f => kindOf(f)).sort().map(f => path.join(dir, f)));
  list = [...new Set(list)];
  if (!list.length) throw new Error('no set brief / storyboard / concept / asset bible files found');
  const docs = [];
  for (const file of list) {
    if (!(await stat(file)).isFile()) continue;
    docs.push({file, kind: kindOf(file) || 'set', text: await readFile(file, 'utf8')});
  }
  const templateLines = await templateLinesFor(dir || path.dirname(list[0]), template);
  const index = buildIndex(docs, {exports: src ? await sourceExports(src) : null, library: await engineLibrary()});
  const hasStoryboard = docs.some(d => d.kind === 'storyboard');
  const out = docs.map(d => ({file: d.file, ...checkDocument(d.text, {kind: d.kind, minBytes, minRows, templateLines, index, needShots: !hasStoryboard})}));
  if (dir && !docs.some(d => d.kind === 'set')) out.push({file: '(set briefs)', kind: 'set', designerBytes: 0, rows: 0, newHard: 0, recipes: 0, shots: 0, missing: ['no set brief found (name them SET-<scene>.md)'], warnings: [], pass: false});
  return {pass: out.every(r => r.pass), minBytes, minRows, files: out};
}

export function formatReport(report, {warnings = true} = {}) {
  const lines = [];
  for (const r of report.files) {
    lines.push(`${r.pass ? 'PASS' : 'FAIL'} ${r.file} [${r.kind}] designer ${r.designerBytes} B${r.kind === 'set' ? ` (min ${report.minBytes})` : ''} · rows ${r.rows} · NEW-HARD ${r.newHard} · recipes ${r.recipes}${r.shots ? ` · shots ${r.shots}` : ''} · missing ${r.missing.length} · warn ${r.warnings.length}`);
    for (const m of r.missing.slice(0, 60)) lines.push(`    - ${m}`);
    if (r.missing.length > 60) lines.push(`    … ${r.missing.length - 60} more`);
    if (warnings) { for (const w of r.warnings.slice(0, 20)) lines.push(`    WARN ${w}`); if (r.warnings.length > 20) lines.push(`    WARN … ${r.warnings.length - 20} more`); }
  }
  lines.push(`${report.pass ? 'PASS' : 'FAIL'} brief-depth · ${report.files.length} files`);
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  const {values: a, positionals} = parseArgs({allowPositionals: true, options: {dir: {type: 'string'}, 'min-bytes': {type: 'string'}, 'min-rows': {type: 'string'}, template: {type: 'string'}, src: {type: 'string'}, json: {type: 'boolean'}, quiet: {type: 'boolean'}, help: {type: 'boolean', short: 'h'}}});
  if (a.help) console.log('Usage: node tools/brief-depth.mjs [--dir docs] [FILE.md …] [--min-bytes 10000] [--min-rows 8] [--template SET-brief.md] [--src src] [--json] [--quiet]\n' +
    'Discovers SET-<scene>.md (not the blank SET-brief.md), STORYBOARD*.md, CONCEPT*.md, ASSET-BIBLE*.md. Fails on missing core headings, incomplete\n' +
    'component tables, NEW-HARD parts without an eight-part recipe, shots without a bill of materials, delegation phrases or placeholders in\n' +
    'designer-owned sections, and set briefs below the designer-written byte minimum. Content supplied by a referenced component section or\n' +
    'phrased with synonym labels is a WARN. --src DIR warns when a procedure names no function exported there. --quiet hides WARN lines. Exit 1 on FAIL.');
  else {
    try {
      const report = await checkBriefs({dir: a.dir ?? (positionals.length ? undefined : 'docs'), files: positionals, minBytes: a['min-bytes'] ? Number(a['min-bytes']) : DEFAULTS.minBytes, minRows: a['min-rows'] ? Number(a['min-rows']) : DEFAULTS.minRows, template: a.template, src: a.src});
      console.log(a.json ? JSON.stringify(report, null, 2) : formatReport(report, {warnings: !a.quiet}));
      process.exitCode = report.pass ? 0 : 1;
    } catch (error) { console.error(`[brief-depth] ${error.message}`); process.exitCode = 2; }
  }
}
