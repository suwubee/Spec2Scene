#!/usr/bin/env node
/** Syntax, module-load and line-comment safety check for generated projects. */
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readdir, readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const here = fileURLToPath(new URL('../', import.meta.url));
const valueAfter = (args, name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };

async function filesUnder(root) {
  const out = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (/\.(?:[cm]?js|mjs)$/i.test(entry.name)) out.push(full);
    }
  }
  await visit(root); return out.sort();
}

function lineCommentIssues(source, file) {
  const lines = source.split(/\r?\n/), issues = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], index = line.indexOf('//');
    if (index < 0 || !line.slice(0, index).trim()) continue;
    const code = line.slice(0, index).trim();
    let next = i + 1; while (next < lines.length && !lines[next].trim()) next++;
    const following = lines[next]?.trim() || '';
    // A continuation token on the next line is the common accidental form:
    // `return // note` followed by an expression, or `value // note` followed
    // by `.method()`/an operator. A normal statement after a comment is safe.
    const inlineCode = /\/\/\s*(?:const|let|var)\s+[A-Za-z_$]|\/\/\s*(?:import|export)\s+(?:[A-Za-z_$]|\{)|\/\/\s*(?:if|for|while)\s*\(/.test(line);
    const incompleteKeyword = /\b(?:return|throw|await)\s*$/.test(code);
    if (inlineCode || (following && !following.startsWith('/') && !/[;{}]\s*$/.test(code) && incompleteKeyword)) {
      issues.push({ file, line: i + 1, kind: 'line-comment-may-swallow-code', text: line.trim() });
    }
  }
  return issues;
}

export async function checkSyntaxAndLoad({ root = path.join(here, 'src'), skip = [], load = true } = {}) {
  const absoluteRoot = path.resolve(root), files = await filesUnder(absoluteRoot), skipPatterns = skip.map(pattern => new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))), results = [], issues = [];
  for (const file of files) {
    const relative = path.relative(absoluteRoot, file);
    if (skipPatterns.some(pattern => pattern.test(relative) || pattern.test(path.basename(file)))) { results.push({ file: relative, skipped: true }); continue; }
    const source = await readFile(file, 'utf8');
    issues.push(...lineCommentIssues(source, relative));
    const result = { file: relative, syntax: 'PASS', load: load ? 'PENDING' : 'SKIP' };
    try { await exec(process.execPath, ['--check', file], { timeout: 30000, maxBuffer: 1024 * 1024 }); }
    catch (error) { result.syntax = 'FAIL'; result.syntaxError = String(error.stderr || error.message); issues.push({ file: relative, kind: 'syntax', error: result.syntaxError }); }
    if (load && result.syntax === 'PASS') {
      try { await exec(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])', pathToFileURL(file).href], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }); result.load = 'PASS'; }
      catch (error) { result.load = 'FAIL'; result.loadError = String(error.stderr || error.message); issues.push({ file: relative, kind: 'module-load', error: result.loadError }); }
    }
    results.push(result);
  }
  return { status: issues.length ? 'FAIL' : 'PASS', root: absoluteRoot, files: results, issues };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2), root = valueAfter(args, '--root', path.join(here, 'src')), skip = args.flatMap((arg, i) => arg === '--skip' ? [args[i + 1]] : []).filter(Boolean), noLoad = args.includes('--no-load');
  const report = await checkSyntaxAndLoad({ root, skip, load: !noLoad });
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
}
