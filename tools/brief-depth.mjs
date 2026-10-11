#!/usr/bin/env node
// Design-depth gate (model-free, no dependencies). The designer writes set briefs, the storyboard and the asset
// bible to a minimum depth; implementers only backfill results. This tool parses the markdown and fails when:
//   · required headings are missing (set brief);
//   · the component table lacks a column (件 | 尺寸 | 材质(色值) | 程序做法 | L1 | L2 | L3 | 来源) or has empty cells,
//     a material without a colour value, a procedure without a named library function, a source tag that is not
//     REUSE / ADAPT / NEW-GLM / NEW-HARD, or fewer rows than --min-rows;
//   · a NEW-HARD part has no recipe, or the recipe lacks one of the eight parts ①–⑧;
//   · a storyboard shot lacks a frame bill of materials field (前景/中景/远景/天空/二级运动 ≥ 2/人物屏高/主光/轮廓光/构图);
//   · designer-owned text contains delegation phrases (DELEGATION below) or unfilled <placeholders>;
//   · a set brief has fewer designer-written bytes than --min-bytes (lines copied verbatim from the template do not count).
// The section whose heading contains 回填 belongs to the implementer and is excluded from all checks.
import {readFile, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {isMain} from './lib/cli.mjs';

export const DEFAULTS = Object.freeze({minBytes: 10000, minRows: 8});
export const SET_HEADINGS = Object.freeze([
  ['目的与边界', /目的|边界|purpose/i], ['平面与尺寸', /平面|尺寸|plan|layout/i], ['构件表', /构件|道具|component/i],
  ['难件配方', /难件|配方|recipe|NEW-HARD/i], ['灯光与氛围', /灯光|光照|light/i], ['镜头预设', /镜头预设|机位|camera preset|lens/i],
  ['验收清单', /验收|acceptance/i], ['回填', /回填|backfill/i]]);
export const COLUMNS = Object.freeze([
  ['件', /件|component|part/i], ['尺寸', /尺寸|size|dimension/i], ['材质', /材质|material/i], ['程序做法', /做法|procedure|method|function/i],
  ['L1', /^L1\b/i], ['L2', /^L2\b/i], ['L3', /^L3\b/i], ['来源', /来源|source/i]]);
export const SOURCES = Object.freeze(['REUSE', 'ADAPT', 'NEW-GLM', 'NEW-HARD']);
export const RECIPE_PARTS = Object.freeze(['① 步骤', '② 几何与拓扑', '③ 函数', '④ 材质数值', '⑤ 检查台', '⑥ 数值验收', '⑦ 失败模式与检测', '⑧ 降级方案']);
const MARKS = '①②③④⑤⑥⑦⑧';
export const BOM_FIELDS = Object.freeze([
  ['前景', ['前景', 'foreground', 'fg']], ['中景', ['中景', 'midground', 'mid']], ['远景', ['远景', 'background', 'far']],
  ['天空', ['天空', '天', 'sky']], ['二级运动', ['二级运动源', '二级运动', 'secondary motion', 'motion']],
  ['人物屏高', ['人物屏幕高度', '人物屏高', '人物', 'figure']], ['主光', ['主光', 'key light', 'key']], ['轮廓光', ['轮廓光', '轮廓', 'rim light', 'rim']]]);
export const DELEGATION = Object.freeze(['由实现者回填', '实现者回填', '由实现者决定', '实现者决定', '实现者自定', '交给实现者', '留给实现者', '细节由实现者',
  '自行决定', '自行发挥', '自由发挥', '实现时再定', '后续补充', '待定', '精简版', 'TBD', 'TODO']);
const NEGATION = /(?:不|禁止|不得|不许|严禁|勿|不能|不要|\bnever|\bno|\bnot)\s*(?:写|用|出现|留|使用|允许|接受|write|use)?\s*[“"'「（(]?\s*$/i;
const PLACEHOLDER = /<(?=[^\s<>=])[^<>\n]{0,80}(?<=[^\s<>=-])>/g;
const EMPTY = /^(?:[-—–…?？]+|\.{2,}|n\/?a)?$/i;
const BARE_NONE = /^(?:无|none|n\/a)[。.]?$/i;

// ---------- markdown helpers ----------
const clean = s => s.replace(/`/g, '').replace(/\*\*/g, '').replace(PLACEHOLDER, '').trim();
const isEmpty = s => EMPTY.test(clean(s));
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
    heads[k].end = end; heads[k].lines = lines.slice(heads[k].start, end);
  }
  return heads;
}
const isBackfill = s => s.level === 2 && /回填|backfill/i.test(s.title);
/** Lines owned by the designer: everything outside the implementer's backfill section(s). */
function designerMask(text) {
  const lines = text.split(/\r?\n/), mask = lines.map(() => true);
  for (const s of sections(text)) if (isBackfill(s)) for (let i = s.start; i < s.end; i++) mask[i] = false;
  return mask;
}

// ---------- checks ----------
export function delegationHits(text, mask) {
  const hits = [], lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (mask && !mask[i]) return;
    for (const phrase of DELEGATION) {
      const re = new RegExp(/^[A-Z]+$/.test(phrase) ? `\\b${phrase}\\b` : phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), /^[A-Z]+$/.test(phrase) ? 'g' : 'gi');
      for (const m of line.matchAll(re)) if (!NEGATION.test(line.slice(Math.max(0, m.index - 8), m.index))) hits.push({line: i + 1, phrase, text: line.trim().slice(0, 120)});
    }
  });
  return hits;
}

function columnIndex(header) {
  const idx = {};
  for (const [name, re] of COLUMNS) { const i = header.findIndex(h => re.test(clean(h)) && !(name === '件' && /来源|source/i.test(clean(h)))); if (i >= 0) idx[name] = i; }
  return idx;
}
/** Check one component table; returns {rows, missingColumns, problems:[…], newHard:[{key, line}]} */
export function checkComponentTable(table) {
  const idx = columnIndex(table.header), missingColumns = COLUMNS.map(c => c[0]).filter(c => idx[c] === undefined), problems = [], newHard = [];
  for (const row of table.rows) {
    const cells = row.cells, name = clean(cells[idx['件'] ?? 0] || '') || `row ${row.line}`;
    table.header.forEach((h, c) => { if (isEmpty(cells[c] ?? '')) problems.push(`line ${row.line} ${name}: empty cell "${clean(h) || c + 1}"`); });
    if (idx['尺寸'] !== undefined && !isEmpty(cells[idx['尺寸']] ?? '') && !/\d/.test(cells[idx['尺寸']])) problems.push(`line ${row.line} ${name}: size has no number`);
    if (idx['材质'] !== undefined && !isEmpty(cells[idx['材质']] ?? '') && !/#[0-9a-f]{3,8}\b|\d*\.\d+|\b\d+\s*K\b|\[\s*\d/i.test(cells[idx['材质']])) problems.push(`line ${row.line} ${name}: material has no colour value (#hex or numbers)`);
    if (idx['程序做法'] !== undefined && !isEmpty(cells[idx['程序做法']] ?? '') && !/[A-Za-z_$][\w$.]*\s*\(|`[A-Za-z_$][\w$./-]*`/.test(cells[idx['程序做法']])) problems.push(`line ${row.line} ${name}: procedure names no library function`);
    if (idx['来源'] !== undefined) {
      const src = clean(cells[idx['来源']] ?? '').toUpperCase(), tag = SOURCES.find(s => new RegExp(`(^|[^A-Z-])${s}($|[^A-Z-])`).test(src));
      if (!isEmpty(cells[idx['来源']] ?? '') && !tag) problems.push(`line ${row.line} ${name}: source must be REUSE/ADAPT/NEW-GLM/NEW-HARD`);
      if (tag === 'NEW-HARD') newHard.push({key: componentKey(cells[idx['件'] ?? 0] || ''), line: row.line});
    }
  }
  return {rows: table.rows.length, missingColumns, problems, newHard};
}
export const componentKey = cell => clean(cell).split(/[\s×x*（(,，/、]+/).filter(Boolean)[0] || clean(cell);

/** Recipe blocks: headings that contain NEW-HARD (any file) or every ### under a 难件配方 section (set briefs). */
export function recipes(text) {
  const out = [], secs = sections(text);
  for (const s of secs) {
    if (s.level < 3) continue;
    const parent = secs.filter(p => p.level < s.level && p.start < s.start && p.end >= s.end).at(-1);
    if (!/NEW-HARD/i.test(s.title) && !(parent && /难件|配方|recipe/i.test(parent.title))) continue;
    if (isBackfill(s) || (parent && isBackfill(parent))) continue;
    const body = s.lines.slice(1).join('\n'), parts = [];
    const at = [...MARKS].map(mk => { const m = body.match(new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?${mk}`)); return m ? m.index + m[0].length : -1; });
    for (let k = 0; k < MARKS.length; k++) {
      const m = at[k] >= 0;
      const next = Math.min(...at.filter(x => x > at[k]), body.length);
      const content = m ? clean(body.slice(at[k], next)).replace(/^[^：:\n]{0,16}[：:]/, '').trim() : '';
      let problem = null;
      if (!m) problem = 'missing';
      else if (content.length < 8) problem = 'empty';
      else if (k === 5 && !/\d/.test(content)) problem = 'no numeric threshold';
      else if (k === 6 && !/→|->|检测|看法|detect/i.test(content)) problem = 'no detection (write symptom → how it is detected → cause)';
      parts.push({part: RECIPE_PARTS[k], problem});
    }
    out.push({title: s.title, line: s.start + 1, parts, missing: parts.filter(p => p.problem).map(p => `${p.part} ${p.problem}`)});
  }
  return out;
}

/** Shot blocks of a storyboard text and their bill-of-materials problems. */
export function shots(text, {sectionRe = null} = {}) {
  const secs = sections(text);
  let pool = secs.filter(s => s.level === 3);
  const scope = sectionRe ? secs.filter(s => s.level <= 2 && sectionRe.test(s.title)) : secs.filter(s => s.level <= 2 && /镜头表|逐镜|物料清单|shot ?list|shots/i.test(s.title));
  if (sectionRe || scope.length) pool = pool.filter(s => scope.some(p => s.start > p.start && s.end <= p.end));
  return pool.map(s => {
    const body = s.lines.slice(1).join('\n'), plain = stripFences(s.lines.slice(1)).join('\n'), missing = [];
    const labels = BOM_FIELDS.flatMap(([field, names]) => names.map(n => ({field, n}))).sort((a, b) => b.n.length - a.n.length);
    const re = new RegExp(`(?:^|[\\s；;，,。：:(（*-])(${labels.map(l => l.n.replace(/ /g, '\\s+')).join('|')})\\s*[：:=]`, 'gi');
    const marks = [...plain.matchAll(re)].map(m => ({field: labels.find(l => new RegExp(`^${l.n.replace(/ /g, '\\s+')}$`, 'i').test(m[1])).field, at: m.index + m[0].length, from: m.index}));
    const values = {};
    marks.forEach((m, k) => {
      const next = Math.min(...[marks[k + 1]?.from ?? Infinity, plain.indexOf('\n', m.at) === -1 ? Infinity : plain.indexOf('\n', m.at)]);
      const v = plain.slice(m.at, next === Infinity ? undefined : next).replace(/[；;。]\s*$/, '').trim();
      if (!values[m.field] || isEmpty(values[m.field])) values[m.field] = v;
    });
    for (const [field] of BOM_FIELDS) {
      const v = values[field];
      if (v === undefined) { missing.push(`${field} missing`); continue; }
      if (isEmpty(v)) { missing.push(`${field} empty`); continue; }
      if (BARE_NONE.test(clean(v)) && !['天空', '人物屏高'].includes(field)) missing.push(`${field} is bare "无" (name the components or give the reason)`);
      if (field === '二级运动' && clean(v).split(/[、，,；;/／]|\s\+\s|\s和\s/).filter(x => clean(x).length > 0).length < 2) missing.push('二级运动 needs ≥ 2 sources');
      if (field === '人物屏高' && !BARE_NONE.test(clean(v)) && !/^无|空镜|none/i.test(clean(v)) && !/\d+(?:\.\d+)?\s*%?\s*(?:[–\-~～→]|to)\s*\d+(?:\.\d+)?\s*%/.test(v)) missing.push('人物屏高 needs a band like 12–18% H (or 无 for an empty shot)');
    }
    const fences = [...body.matchAll(/(```|~~~)[^\n]*\n([\s\S]*?)\1/g)].filter(m => m[2].split('\n').filter(l => l.trim()).length >= 2);
    if (!fences.length) missing.push('构图 sketch missing (fenced block ≥ 2 lines)');
    return {shot: s.title, line: s.start + 1, missing};
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

/** Check one document. ctx: {kind, minBytes, minRows, templateLines, recipeTitles (from other files), needShots} */
export function checkDocument(text, ctx = {}) {
  const kind = ctx.kind, mask = designerMask(text), missing = [], secs = sections(text), lines = text.split(/\r?\n/);
  const result = {kind, designerBytes: designerBytes(text, mask, ctx.templateLines), rows: 0, newHard: 0, recipes: 0, shots: 0, missing};
  for (const h of delegationHits(text, mask)) missing.push(`line ${h.line}: delegation phrase "${h.phrase}"`);
  const ownRecipes = recipes(text);
  result.recipes = ownRecipes.length;
  for (const r of ownRecipes) for (const m of r.missing) missing.push(`recipe "${r.title}": ${m}`);
  const compTables = [];
  if (kind === 'set') {
    for (const [name, re] of SET_HEADINGS) if (!secs.some(s => s.level === 2 && re.test(s.title))) missing.push(`heading missing: ${name}`);
    const designSecs = secs.filter(s => s.level === 2 && SET_HEADINGS.slice(0, 7).some(([, re]) => re.test(s.title)) && !isBackfill(s));
    for (const s of designSecs) {
      const n = s.lines.join('\n').match(PLACEHOLDER)?.length || 0;
      if (n) missing.push(`section "${s.title}": ${n} unfilled <placeholder>`);
    }
    const comp = secs.find(s => s.level === 2 && /构件|道具|component/i.test(s.title));
    if (comp) {
      const t = tables(comp.lines, comp.start)[0];
      if (!t) missing.push('component table missing');
      else compTables.push(t);
    }
    if (result.designerBytes < ctx.minBytes) missing.push(`designer-written ${result.designerBytes} B < ${ctx.minBytes} B minimum`);
  } else {
    for (const t of tables(lines)) if (columnIndex(t.header)['来源'] !== undefined && columnIndex(t.header)['件'] !== undefined) compTables.push(t);
  }
  const hard = [];
  for (const t of compTables) {
    const r = checkComponentTable(t);
    result.rows += r.rows;
    if (r.missingColumns.length) missing.push(`component table (line ${t.line}) lacks columns: ${r.missingColumns.join(', ')}`);
    missing.push(...r.problems);
    hard.push(...r.newHard);
  }
  if (kind === 'set' && compTables.length && result.rows < ctx.minRows) missing.push(`component table has ${result.rows} rows < ${ctx.minRows}`);
  result.newHard = hard.length;
  const titles = [...ownRecipes.map(r => r.title), ...(ctx.recipeTitles || [])];
  for (const h of hard) if (!titles.some(t => t.toLowerCase().includes(h.key.toLowerCase()))) missing.push(`NEW-HARD "${h.key}" (line ${h.line}) has no recipe ①–⑧ (heading containing "${h.key}" here or in the asset bible)`);
  if (kind === 'storyboard' || (kind === 'concept' && ctx.needShots)) {
    const list = kind === 'concept' ? shots(text, {sectionRe: /物料清单|bill of materials|逐镜/i}) : shots(text);
    result.shots = list.length;
    if (!list.length) missing.push(kind === 'concept' ? 'heading missing: 逐镜画面物料清单 with ### shot blocks' : 'no shot blocks (### <shot> under the shot list)');
    for (const s of list) for (const m of s.missing) missing.push(`shot "${s.shot}" (line ${s.line}): ${m}`);
  }
  result.pass = missing.length === 0;
  return result;
}

async function templateLinesFor(dir, explicit) {
  const candidates = explicit ? [explicit] : [path.join(dir, 'SET-brief.md'), fileURLToPath(new URL('../templates/SET-brief.md', import.meta.url))];
  for (const c of candidates) { try { return new Set((await readFile(c, 'utf8')).split(/\r?\n/).map(l => l.trim()).filter(Boolean)); } catch {} }
  return new Set();
}

/** Check a list of files (or a directory). Returns {pass, files:[{file, …result}]}. */
export async function checkBriefs({dir, files = [], minBytes = DEFAULTS.minBytes, minRows = DEFAULTS.minRows, template} = {}) {
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
  const bibleTitles = docs.filter(d => d.kind === 'bible').flatMap(d => recipes(d.text).map(r => r.title));
  const hasStoryboard = docs.some(d => d.kind === 'storyboard');
  const out = docs.map(d => ({file: d.file, ...checkDocument(d.text, {kind: d.kind, minBytes, minRows, templateLines, recipeTitles: bibleTitles, needShots: !hasStoryboard})}));
  if (dir && !docs.some(d => d.kind === 'set')) out.push({file: '(set briefs)', kind: 'set', designerBytes: 0, rows: 0, newHard: 0, recipes: 0, shots: 0, missing: ['no set brief found (name them SET-<scene>.md)'], pass: false});
  return {pass: out.every(r => r.pass), minBytes, minRows, files: out};
}

export function formatReport(report) {
  const lines = [];
  for (const r of report.files) {
    lines.push(`${r.pass ? 'PASS' : 'FAIL'} ${r.file} [${r.kind}] designer ${r.designerBytes} B${r.kind === 'set' ? ` (min ${report.minBytes})` : ''} · rows ${r.rows} · NEW-HARD ${r.newHard} · recipes ${r.recipes}${r.shots ? ` · shots ${r.shots}` : ''} · missing ${r.missing.length}`);
    for (const m of r.missing.slice(0, 60)) lines.push(`    - ${m}`);
    if (r.missing.length > 60) lines.push(`    … ${r.missing.length - 60} more`);
  }
  lines.push(`${report.pass ? 'PASS' : 'FAIL'} brief-depth · ${report.files.length} files`);
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  const {values: a, positionals} = parseArgs({allowPositionals: true, options: {dir: {type: 'string'}, 'min-bytes': {type: 'string'}, 'min-rows': {type: 'string'}, template: {type: 'string'}, json: {type: 'boolean'}, help: {type: 'boolean', short: 'h'}}});
  if (a.help) console.log('Usage: node tools/brief-depth.mjs [--dir docs] [FILE.md …] [--min-bytes 10000] [--min-rows 8] [--template SET-brief.md] [--json]\n' +
    'Discovers SET-<scene>.md (not the blank SET-brief.md), STORYBOARD*.md, CONCEPT*.md, ASSET-BIBLE*.md. Fails on missing headings, incomplete\n' +
    'component tables, NEW-HARD parts without an eight-part recipe, shots without a bill of materials, delegation phrases or placeholders in\n' +
    'designer-owned sections, and set briefs below the designer-written byte minimum. The 回填 section is the implementer\'s and is ignored. Exit 1 on FAIL.');
  else {
    try {
      const report = await checkBriefs({dir: a.dir ?? (positionals.length ? undefined : 'docs'), files: positionals, minBytes: a['min-bytes'] ? Number(a['min-bytes']) : DEFAULTS.minBytes, minRows: a['min-rows'] ? Number(a['min-rows']) : DEFAULTS.minRows, template: a.template});
      console.log(a.json ? JSON.stringify(report, null, 2) : formatReport(report));
      process.exitCode = report.pass ? 0 : 1;
    } catch (error) { console.error(`[brief-depth] ${error.message}`); process.exitCode = 2; }
  }
}
