#!/usr/bin/env node
// Author: suwubee
// Dissolve continuity check: a two-layer (dissolve) frame must equal the single-layer frame of the outgoing shot at
// weight 0 and of the incoming shot at weight 1, and change monotonically in between (no brightness bump).
//
//   node tools/cinematic/verify_dissolve.mjs [--page index.html] [--cuts 22.6,51.4,83.4] [--w 1920 --h 1080] [--query "..."]
//                                  [--weights 0,1e-6,0.01,0.25,0.5,0.75,0.99,0.999999,1] [--cpus 4-7] [--tol 1]
//
// For each cut time T (the incoming shot's t0) both shots are rendered at the SAME film time T through
// engine.renderFrame(T, {layers}) with explicit weights, so only the blend varies. Reported per weight:
//   max|Δ| and mean|Δ| (8-bit RGB, picture area) vs the single-layer outgoing (A) and incoming (B) frames,
//   mean luma of the picture; then: ends within --tol LSB (w=0 & 1e-6 vs A, 1-1e-6 & 1 vs B), mean-luma monotone,
//   and the fraction of pixels whose luma is monotone (±1 LSB) across the weight sweep.
// Exit 0 = all checks pass, 1 = a check failed, 2 = error.
import { startServer } from './serve.mjs';
import { launchBrowser, openMvPage, parseArgs } from './lib/browser.mjs';

const a = parseArgs(process.argv.slice(2), ['help']);
if (a.help) { console.log('see header of tools/cinematic/verify_dissolve.mjs'); process.exit(0); }
if(!a.root)throw Error('--root project directory required');
const W = +(a.w || 1920), H = +(a.h || 1080);
const cuts = String(a.cuts || '30').split(',').map(Number);
const weights = String(a.weights || '0,1e-6,0.01,0.25,0.5,0.75,0.99,0.999999,1').split(',').map(Number);
const tol = +(a.tol ?? 1);

const server = await startServer({root:a.root,port:+(a.port||39920)});
let browser, exit = 0;
try {
  browser = await launchBrowser({ cpus: a.cpus || null });
  const { page } = await openMvPage(browser, { baseUrl: server.url, page: a.page || 'index.html', query: a.query || '', w: W, h: H, readyTimeout: 300000, diag: { echo: 'problems' } });
  for (const T of cuts) {
    const r = await page.evaluate(async ([T, weights, W, H, TOL]) => {
      const e = window.__mv.engine, gl = e.renderer.getContext();
      const shots = e.timeline.shots;
      const i = shots.findIndex((s) => Math.abs(s.t0 - T) < 1e-3);
      if (i <= 0) return { error: `no cut at t=${T}` };
      const A = shots[i - 1], B = shots[i];
      const PH = e.pictureHeight, y0 = Math.round((H - PH) / 2);
      const L = (shot, w) => ({ shot, tLocal: T - shot.t0, weight: w, gain: 1, fade: 1 });
      const grab = async (layers) => {
        await e.renderFrame(T, { layers });
        e.renderer.setRenderTarget(null);
        const buf = new Uint8Array(W * PH * 4);
        gl.readPixels(0, y0, W, PH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return buf;
      };
      const luma = (b) => { const n = b.length / 4, out = new Float32Array(n); for (let k = 0; k < n; k++) out[k] = 0.2126 * b[k * 4] + 0.7152 * b[k * 4 + 1] + 0.0722 * b[k * 4 + 2]; return out; };
      const stats = (x, y) => { let mx = 0, sum = 0, n = 0, over = 0; for (let k = 0; k < x.length; k += 4) { let pm = 0; for (let c = 0; c < 3; c++) { const d = Math.abs(x[k + c] - y[k + c]); if (d > pm) pm = d; sum += d; n++; } if (pm > mx) mx = pm; if (pm > TOL) over++; } return { max: mx, mean: sum / n, over }; };
      const meanL = (l) => { let s = 0; for (let k = 0; k < l.length; k++) s += l[k]; return s / l.length; };
      const refA = await grab([L(A, 1)]);
      const refB = await grab([L(B, 1)]);
      const rows = [], lumas = [];
      for (const w of weights) {
        const b = await grab([L(A, 1 - w), L(B, w)]);
        const l = luma(b);
        lumas.push(l);
        rows.push({ w, vsA: stats(b, refA), vsB: stats(b, refB), meanLuma: meanL(l) });
      }
      // per-pixel monotonicity over the sweep (±1 LSB), subsampled
      let mono = 0, tot = 0;
      for (let k = 0; k < lumas[0].length; k += 7) {
        let inc = true, dec = true;
        for (let j = 1; j < lumas.length; j++) { const d = lumas[j][k] - lumas[j - 1][k]; if (d < -1) inc = false; if (d > 1) dec = false; }
        if (inc || dec) mono++;
        tot++;
      }
      return { A: A.id, B: B.id, rows, meanLA: meanL(luma(refA)), meanLB: meanL(luma(refB)), monoFrac: mono / tot };
    }, [T, weights, W, H, tol]);
    if (r.error) { console.error(r.error); exit = 2; continue; }
    console.log(`\n=== cut t=${T}: ${r.A} → ${r.B}   mean luma A ${r.meanLA.toFixed(2)}  B ${r.meanLB.toFixed(2)}`);
    console.log(`   weight      max|Δ|A  mean|Δ|A  px>${tol}(A)   max|Δ|B  mean|Δ|B  px>${tol}(B)   meanLuma`);
    for (const x of r.rows) console.log(`   ${String(x.w).padEnd(10)} ${String(x.vsA.max).padStart(7)} ${x.vsA.mean.toFixed(3).padStart(9)} ${String(x.vsA.over).padStart(9)} ${String(x.vsB.max).padStart(9)} ${x.vsB.mean.toFixed(3).padStart(9)} ${String(x.vsB.over).padStart(9)} ${x.meanLuma.toFixed(2).padStart(10)}`);
    const byW = (w) => r.rows.find((x) => x.w === w);
    const npx = W * (H - 2 * Math.round((H - Math.min(H, Math.round(W / 2.38806))) / 2));
    const endsOk = [[0, 'A', 0], [1, 'B', 0], [1e-6, 'A', 1], [0.999999, 'B', 1]].every(([w, s, slack]) => {
      const x = byW(w); if (!x) return true; const v = s === 'A' ? x.vsA : x.vsB;
      return v.max <= tol + slack && (slack === 0 || v.over <= npx * 1e-4);   // near-ends: HDR highlights of the other shot may shine through
    });
    const ls = r.rows.map((x) => x.meanLuma);
    const inc = ls.every((v, k) => k === 0 || v >= ls[k - 1] - 0.05), dec = ls.every((v, k) => k === 0 || v <= ls[k - 1] + 0.05);
    const lo = Math.min(r.meanLA, r.meanLB) - 0.05, hi = Math.max(r.meanLA, r.meanLB) + 0.05;
    const noBump = ls.every((v) => v >= lo && v <= hi);
    console.log(`   ends (w=0/1 ≤${tol} LSB; w=1e-6 ≤${tol + 1} LSB on <0.01% px): ${endsOk ? 'PASS' : 'FAIL'} | mean luma monotone: ${inc || dec ? 'PASS' : 'FAIL'} | no bump outside [A,B]: ${noBump ? 'PASS' : 'FAIL'} | pixels monotone (±1): ${(100 * r.monoFrac).toFixed(2)} %`);
    if (!endsOk || !(inc || dec) || !noBump) exit = Math.max(exit, 1);
  }
} catch (e) {
  console.error('[verify_dissolve] FATAL', e && e.stack || e);
  exit = 2;
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.close();
}
console.log(exit === 0 ? '\n[verify_dissolve] PASS' : exit === 1 ? '\n[verify_dissolve] FAIL' : '\n[verify_dissolve] ERROR');
process.exit(exit);
