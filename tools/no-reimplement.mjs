#!/usr/bin/env node
// Static check: scene/prop source must use the engine's existing features instead of re-implementing them.
// Model-free, no dependencies. Scans .js/.mjs/.glsl/.vert/.frag files (inline GLSL in JS strings included) and
// reports file:line for each rule below. The engine inventory and the calibrated parameters are listed in
// tracks/music-video/engine/README.md ("已有功能清单 / do-not-reimplement").
//
// Allowlist (same line or the line above):  // no-reimplement-allow <rule>: <reason of at least 8 characters>
// An allow comment without a rule name or a reason is itself reported (rule "allow-without-reason").
import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {isMain} from './lib/cli.mjs';

const CAM = String.raw`(?<![\w$])[\w$]*cam(?:era)?[\w$]*(?:\.[\w$]+)*`;
const CAM_MOVE = new RegExp(String.raw`${CAM}\.(?:rotate[XYZ]|rotateOnAxis|rotateOnWorldAxis|translate[XYZ]|translateOnAxis)\s*\(|${CAM}\.(?:rotation|position)\.[xyz]\s*(?:[+\-*]?=)(?!=)|${CAM}\.(?:rotation|position)\.(?:set|add|addScaledVector)\s*\(|${CAM}\.quaternion\.(?:multiply|premultiply)\s*\(`, 'i');
const OSC = /\b(?:pink1|fbm[123]?|[gsv]?noise[123]?|snoise[23]|gnoise[12]|vnoise[123]|curl[23]|hash(?:11|21|22|31|33)?|pcg[23]?d?|mulberry32|sfc32)\s*\(|Math\.(?:sin|cos|random)\s*\(|(?<![\w$.])(?:sin|cos)\s*\(/;
export const RULES = Object.freeze({
  'camera-shake': 'camera rotation/translation driven by noise, sin/cos or random — return handheld/breathing from the preset (engine camera.js handheld, ±0.15° per amount; keep ≤ 0.35) or animate keys with evalCam/dolly/crane/orbit',
  'handheld-amount': 'handheld amount above 1.0 (≈3× the 0.35 working limit; the engine clamps at 1.5)',
  'glsl-sin-hash': 'fract(sin(…)) hash in GLSL — use the engine integer hashes (noise.js GLSL_HASH / GLSL_NOISE, pcg) which are stable across GPUs',
  'custom-fog': 'self-made fog — use the shared atmosphere (createAtmosphere / fogTerrain / withAtmosFog) and particles createMistCards',
  'custom-sky': 'self-made sky dome or sky shader — use createSky / getSharedSky / scopeSharedSky / skyPreset',
  'hardcoded-credit': 'hard-coded author/credit text — titles and credits come only from the project credits file (engine/credits.js)',
  'allow-without-reason': 'no-reimplement-allow comment needs a rule name and a reason (≥ 8 characters)',
});
const CREDIT = /(['"`])[^'"`\n]*?(?:作词|作曲|编曲|演唱|原唱|词曲|制作人|监制|出品人?|导演|摄影指导|创意|Lyrics\s+by|Music\s+by|Directed\s+by|Produced\s+by|Written\s+by|Composed\s+by|Arranged\s+by|Lyricist|Composer|Credits?)\s*[:：/]/i;
const ALLOW = /no-reimplement-allow\b\s*([\w-]*)\s*(?::\s*(.*))?$/;
const EXT = /\.(?:m?js|glsl|vert|frag)$/i;

function allowFor(lines, i, rule) {
  for (const j of [i, i - 1]) {
    const m = j >= 0 && lines[j].match(ALLOW);
    if (m && m[1] === rule && (m[2] || '').trim().replace(/\*\/\s*$/, '').trim().length >= 8) return true;
  }
  return false;
}

/** Scan one source text; returns [{line, rule, text}] (allowlisted findings removed). */
export function scanSource(text, file = 'source.js') {
  const lines = text.split(/\r?\n/), found = [];
  const base = path.basename(file);
  const tainted = new Map();   // name → line where it was assigned from an oscillator/noise expression
  const add = (i, rule) => { if (!allowFor(lines, i, rule)) found.push({line: i + 1, rule, text: lines[i].trim().slice(0, 160)}); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const allow = line.match(ALLOW);
    if (allow && (!RULES[allow[1]] || allow[1] === 'allow-without-reason' || (allow[2] || '').trim().replace(/\*\/\s*$/, '').trim().length < 8)) found.push({line: i + 1, rule: 'allow-without-reason', text: line.trim().slice(0, 160)});
    const code = line.replace(/\/\/.*$/, '');
    const assign = code.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/);
    if (assign && OSC.test(assign[2])) tainted.set(assign[1], i);
    const destructure = code.match(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(.*)$/);
    if (destructure && OSC.test(destructure[2])) for (const n of destructure[1].split(',')) { const name = n.split(':').pop().trim(); if (name) tainted.set(name, i); }
    if (CAM_MOVE.test(code)) {
      const usesTaint = [...tainted].some(([name, at]) => i - at <= 40 && new RegExp(String.raw`(?<![\w$.])${name.replace(/\$/g, '\\$')}(?![\w$])`).test(code.replace(CAM_MOVE, '')));
      if (OSC.test(code) || usesTaint) add(i, 'camera-shake');
    }
    const hh = code.match(/\bhandheld\s*[:=]\s*(\d*\.?\d+)/);
    if (hh && Number(hh[1]) > 1) add(i, 'handheld-amount');
    const hhCall = code.match(/\bhandheld\s*\([^,()]*,\s*(\d*\.?\d+)/);
    if (hhCall && Number(hhCall[1]) > 1) add(i, 'handheld-amount');
    if (/fract\s*\(\s*sin\s*\(/.test(code)) add(i, 'glsl-sin-hash');
    if (/\bnew\s+(?:THREE\.)?Fog(?:Exp2)?\s*\(|\.fog\s*=\s*new\b|\b(?:fogFactor|fogAmount|fogAmt|fogMix)\s*=\s*[^;]*\bexp2?\s*\(|\bmix\s*\([^;]*fogColou?r[^;]*exp2?\s*\(/i.test(code)) add(i, 'custom-fog');
    if (/\bnew\s+Sky\s*\(|\bsky\w*\s*=\s*new\s+(?:THREE\.)?(?:Raw)?ShaderMaterial\s*\(|SphereGeometry\s*\([^)]*\)[^;]*BackSide|\bsky\w*(?:Dome|Sphere)\s*=\s*new\s+(?:THREE\.)?Mesh\s*\(/i.test(code)) add(i, 'custom-sky');
    if (base !== 'credits.js' && CREDIT.test(code)) add(i, 'hardcoded-credit');
  }
  return found;
}

async function* walk(target) {
  const info = await stat(target);
  if (info.isFile()) { if (EXT.test(target)) yield target; return; }
  for (const entry of (await readdir(target, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name.startsWith('.')) continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && EXT.test(entry.name)) yield full;
  }
}

/** Scan files/directories; returns {pass, files, findings:[{file, line, rule, text, why}]}. */
export async function scanPaths(paths) {
  const findings = [];
  let files = 0;
  for (const p of paths) for await (const file of walk(p)) {
    files++;
    for (const f of scanSource(await readFile(file, 'utf8'), file)) findings.push({file, ...f, why: RULES[f.rule]});
  }
  return {pass: findings.length === 0, files, findings};
}

if (isMain(import.meta.url)) {
  const {values: args, positionals} = parseArgs({options: {json: {type: 'boolean'}, help: {type: 'boolean', short: 'h'}}, allowPositionals: true});
  if (args.help) console.log('Usage: node tools/no-reimplement.mjs [--json] PATH... (default: src)\n' +
    'Flags scene/prop code that re-implements engine features: noise/sin-driven camera moves (self-made shake), handheld > 1.0,\n' +
    'fract(sin()) GLSL hashes, self-made fog or sky, hard-coded credit text. Allow one line with\n' +
    '  // no-reimplement-allow <rule>: <reason>   (same line or the line above; a reason is required). Exit 1 on findings.');
  else {
    try {
      const report = await scanPaths(positionals.length ? positionals : ['src']);
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else {
        for (const f of report.findings) console.log(`${f.file}:${f.line} ${f.rule} — ${f.why}\n    ${f.text}`);
        console.log(`${report.pass ? 'PASS' : 'FAIL'} no-reimplement · ${report.files} files · ${report.findings.length} findings`);
      }
      process.exitCode = report.pass ? 0 : 1;
    } catch (error) { console.error(`[no-reimplement] ${error.message}`); process.exitCode = 2; }
  }
}
