// Author: suwubee
// engine/lyrics.js — Canvas2D lyric / title / credits overlay, drawn AFTER post (stays crisp) and
// composited 1:1 in the final pass. Pure function of t: draw(t) clears and redraws everything.
//
//  modes:  'bottom'   — one centred line in the lower letterbox bar (or just inside the picture)
//          'vertical' — 竖排: each lyric line is a column, columns placed right→left
//  chars ease in "ink-bloom" style (blur→sharp, slight upward drift, soft glow while sung);
//  finished lines fade gracefully (drift up + dissolve).
import { clamp, saturate, smoothstep, lastIndexLE } from './util.js';
import { makeRng } from './noise.js';
import {alignedSongLines} from './lyrics/index.js';

export const FONT_SERIF = 'MV Serif';
export const FONT_BRUSH = 'MV Brush';
/** Project-owned fonts only. Files and coverage URLs are supplied by the caller. */
export async function loadFonts({files = [], baseURL = document.baseURI, coverageURL = null} = {}) {
  const faces = [];
  for (const f of files) {
    const url = new URL(f.file, baseURL).href;
    try {
      const face = new FontFace(f.family, `url("${url}")`, {weight:f.weight || '400', style:f.style || 'normal', display:'block'});
      await face.load(); document.fonts.add(face); faces.push({...f, ok:true});
    } catch (e) { faces.push({...f, ok:false}); throw new Error(`font load failed: ${f.file}: ${e.message}`); }
  }
  await document.fonts.ready;
  const coverage = coverageURL ? (await (await fetch(new URL(coverageURL, baseURL))).json()).coverage : null;
  return {faces, coverage};
}

const easeOutCubic = (x) => 1 - Math.pow(1 - saturate(x), 3);

/**
 * Re-flow aligned lyric lines (song.json, possibly merged phrases) into display lines (with spaces).
 * Returns null if the character streams don't match (then the song lines are used as-is).
 */
export function reflowLyrics(lines, displayLines) {
  if (!displayLines || !displayLines.length) return null;
  const chars = lines.flatMap((l) => l.chars.filter((c) => c.c && c.c.trim()));
  let ci = 0;
  const out = [];
  for (const text of displayLines) {
    const cs = [];
    for (const g of [...text]) {
      if (!g.trim()) { cs.push({ c: ' ', space: true }); continue; }
      if (ci >= chars.length || chars[ci].c !== g) return null;
      cs.push({ ...chars[ci++] });
    }
    const real = cs.filter((c) => !c.space);
    if (!real.length) continue;
    // spaces get the time of the following char
    for (let i = 0; i < cs.length; i++) if (cs[i].space) { const nx = cs.slice(i + 1).find((c) => !c.space) || real[real.length - 1]; cs[i].t0 = nx.t0; cs[i].t1 = nx.t0; }
    out.push({ text, t0: real[0].t0, t1: real[real.length - 1].t1, chars: cs });
  }
  if (ci !== chars.length) return null;
  return out;
}

/**
 * song.json line → display line: glyphs follow `text` (keeps the half-line space; if the text has none but
 * `split` > 0, a space is inserted after `split` characters); timings come from `chars` in order.
 */
export function displayLine(l) {
  let text = l.text || (l.chars || []).map((c) => c.c).join('');
  const real = (l.chars || []).filter((c) => c.c && c.c.trim());
  if (!/\s/.test(text) && l.split > 0 && l.split < [...text].length) { const g = [...text]; text = g.slice(0, l.split).join('') + ' ' + g.slice(l.split).join(''); }
  const cs = [];
  let ci = 0;
  for (const g of [...text]) {
    if (!g.trim()) { cs.push({ c: ' ', space: true }); continue; }
    if (ci < real.length) cs.push({ ...real[ci++], c: g });
    else cs.push({ c: g, t0: l.t1, t1: l.t1 });
  }
  const glyphs = cs.filter((c) => !c.space);
  for (let i = 0; i < cs.length; i++) if (cs[i].space) { const nx = cs.slice(i + 1).find((c) => !c.space) || glyphs[glyphs.length - 1]; cs[i].t0 = nx.t0; cs[i].t1 = nx.t0; }
  return { ...l, text, chars: cs, t0: glyphs.length ? glyphs[0].t0 : l.t0, t1: glyphs.length ? glyphs[glyphs.length - 1].t1 : l.t1 };
}

/**
 * createLyrics({ width, height, pictureHeight, song, config })
 * config (from timeline.js `lyricsConfig`):
 *   { displayLines:[...], styles:[{t0,t1,mode:'vertical',x,y,size}], titles:[{kind:'title'|'credits'|'text', t0,t1,...}],
 *     bottom:{ place:'bar'|'picture', size } }
 */
export function createLyrics({ width, height, pictureHeight, song, config = {}, coverage = null, onMissing = null }) {
  const FONT_SERIF = config.fontFamily || 'MV Serif', FONT_BRUSH = config.titleFontFamily || FONT_SERIF;
  const W = width, H = height, PH = pictureHeight;
  const barH = (H - PH) / 2;
  const S = H / 1080; // reference scale
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d', { alpha: true, willReadFrequently: true }); // CPU raster: far cheaper than GPU canvas on SwiftShader
  // bounding box of everything drawn this frame (canvas px, y down) — only this region is uploaded
  const bb = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
  const grow = (x0, y0, x1, y1) => { bb.x0 = Math.min(bb.x0, x0); bb.y0 = Math.min(bb.y0, y0); bb.x1 = Math.max(bb.x1, x1); bb.y1 = Math.max(bb.y1, y1); };

  // missing-glyph reporting (once per family/char) — never silently draw tofu
  const cover = {};
  if (coverage) for (const [k, v] of Object.entries(coverage)) cover[k.split('|')[0]] = (cover[k.split('|')[0]] || '') + v;
  const reported = new Set();
  const checkGlyphs = (text, family) => {
    if (!coverage || !cover[family]) return;
    for (const ch of String(text)) {
      if (!ch.trim() || cover[family].includes(ch)) continue;
      const key = family + ':' + ch;
      if (reported.has(key)) continue;
      reported.add(key);
      const msg = `[lyrics] glyph '${ch}' (U+${ch.codePointAt(0).toString(16).toUpperCase()}) is missing from the "${family}" subset — run \`npm run fonts\``;
      console.error(msg);
      if (onMissing) onMissing(msg);
    }
  };

  // song.json lines are the display lines (text keeps the half-line space; see displayLine). A timeline
  // `displayLines` list is only used to RE-FLOW merged aligner lines, when explicitly configured.
  const songLines = song?.lines ? alignedSongLines(song) : (song?.lyrics || []).filter(l=>l.locked===true);
  let lines = (config.displayLines && reflowLyrics(songLines, config.displayLines)) || songLines.map(displayLine);
  // per-line lead: sibilant / aspirated initials start 0.08–0.2 s before the aligned vowel onset
  const leadOf = (i) => (config.leads && config.leads[i] !== undefined ? config.leads[i] : (config.lead ?? 0.10));
  lines = lines.map((l, i) => {
    const d = leadOf(l.i ?? i);
    if (!d) return l;
    return { ...l, t0: l.t0 - d, t1: l.t1 - d, chars: l.chars.map((c) => ({ ...c, t0: c.t0 - d, t1: c.t1 - d })) };
  });
  for (const l of lines) checkGlyphs(l.text, FONT_SERIF);
  const styles = (config.styles || (config.direction==='vertical'?[{t0:0,t1:Math.max(0,...songLines.map(l=>l.t1))+2,mode:'vertical',...(config.vertical||{})}]:[])).slice().sort((a, b) => a.t0 - b.t0);
  const titles = config.titles || [];
  for (const T of titles) {
    if (T.kind === 'credits') for (const ln of T.lines || []) checkGlyphs(typeof ln === 'object' ? ln.text : ln, typeof ln === 'object' && ln.head ? FONT_BRUSH : FONT_SERIF);
    else if (T.kind === 'creator') { checkGlyphs(T.name || '', FONT_BRUSH); checkGlyphs(T.small || '', FONT_BRUSH); checkGlyphs(T.label || '', FONT_SERIF); checkGlyphs(typeof T.seal === 'string' ? T.seal : T.name || '', FONT_BRUSH); }
    else if (T.kind === 'roles') { checkGlyphs(T.heading || '', FONT_BRUSH); for (const r of [...(T.rows || []), ...(T.pages || []).flatMap((p) => p.rows || [])]) { checkGlyphs(r[0] || '', FONT_SERIF); checkGlyphs(r[1] || '', FONT_SERIF); } }
    else { checkGlyphs(T.text || '', FONT_BRUSH); checkGlyphs(T.sub || '', FONT_SERIF); checkGlyphs(T.sealText || '', FONT_BRUSH); }
  }
  const bottom = { place: 'bar', size: 40, color: '#e9eef4', glow: 'rgba(160,188,228,0.55)', tracking: 0.22, ...(config.bottom || {}) };

  const styleAt = (t) => { const i = lastIndexLE(styles, t, (s) => s.t0); return i >= 0 && t < styles[i].t1 ? styles[i] : null; };
  // assign each line a mode + column index (for vertical groups)
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const st = styleAt(L.t0 + 0.01);
    L.mode = st ? st.mode : 'bottom';
    L.style = st;
    if (st && st.mode === 'vertical') {
      const prevInGroup = lines.slice(0, i).filter((x) => x.style === st);
      L.col = prevInGroup.length;
    }
  }
  // visibility windows. Bottom lines: a line fades after its last char (+HOLD); if the next line
  // starts before that fade is done, the old line instead RISES (~1 line) and dissolves while the
  // new one blooms in below it — never two lines garbled on top of each other.
  const LEAD = 0.06, IN = 0.6, HOLD = 0.7, FADE = 1.3, RISE = 0.75; // LEAD: ink pre-roll before the (lead-shifted) onset
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const next = lines.slice(i + 1).find((x) => x.mode === L.mode && (L.mode !== 'vertical' || x.style === L.style));
    L.visStart = L.chars.find((c) => !c.space)?.t0 - LEAD - 0.05;
    L.rise = null;
    if (L.mode === 'vertical') {
      const endT = L.style.t1;
      L.fadeStart = Math.max(L.t1 + HOLD, endT - (L.style.fadeDur ?? 1.6));
      L.fadeEnd = Math.max(L.fadeStart + 0.4, endT);
    } else {
      L.fadeStart = L.t1 + HOLD; L.fadeEnd = L.fadeStart + FADE;
      if (next) {
        const nStart = next.chars.find((c) => !c.space)?.t0 - LEAD;
        if (nStart < L.fadeEnd) { L.rise = { t0: nStart - 0.08, t1: nStart - 0.08 + RISE }; L.fadeEnd = Math.min(L.fadeEnd, L.rise.t1); L.fadeStart = Math.min(L.fadeStart, L.rise.t0); }
      }
    }
  }

  function charState(c, t, L) {
    const a = easeOutCubic((t - (c.t0 - LEAD)) / IN);
    let sung = 0;
    if (c.t1 > c.t0) sung = smoothstep(c.t0 - 0.05, c.t0 + 0.15, t) * (1 - smoothstep(c.t1 - 0.05, c.t1 + 0.6, t));
    const f = saturate((t - L.fadeStart) / Math.max(0.05, L.fadeEnd - L.fadeStart));
    const fo = f * f * (3 - 2 * f);
    let rise = 0;
    if (L.rise) { const r = saturate((t - L.rise.t0) / (L.rise.t1 - L.rise.t0)); rise = 1 - Math.pow(1 - r, 2.2); }
    // drift > 0 = up: chars bloom in from ~9 px below and rise into place; finished lines drift up as they dissolve
    return { alpha: a * (1 - fo), blur: (1 - a) * 7 + fo * 3.5, drift: -(1 - a) * 9 + fo * 6 + rise * 48, scale: 1 + (1 - a) * 0.05, sung };
  }

  // Blur without ctx.filter (which blurs a canvas-sized layer per draw): draw the glyph far
  // off-canvas and let its shadow (a bounded Gaussian of the glyph) land at the right place.
  const OFF = 20000;
  function blurredText(ch, x, y, blurPx, color, alpha) {
    g.save();
    g.globalAlpha = clamp(alpha, 0, 1);
    g.shadowColor = color; g.shadowBlur = Math.max(0.01, blurPx * 2); g.shadowOffsetX = OFF; g.shadowOffsetY = 0;
    g.fillStyle = '#000';
    g.fillText(ch, x - OFF, y);
    g.restore();
  }
  function glyph(ch, x, y, size, st, family, weight, color, glow, align = 'center') {
    if (st.alpha <= 0.003) return;
    g.font = `${weight} ${Math.round(size * st.scale * 100) / 100}px "${family}"`;
    g.textAlign = align; g.textBaseline = 'middle';
    const yy = y - st.drift * S;
    const blur = st.blur * S;
    { const w = g.measureText(ch).width, pad = (22 + 10 * st.sung) * S + blur * 3 + 4, hs = size * st.scale * 0.75;
      grow(x - w / 2 - pad, yy - hs - pad, x + w / 2 + pad, yy + hs + pad); }
    // ink-bloom: a soft blob that sharpens into the character (cross-fade blurred -> crisp)
    const sharpW = blur > 0.3 ? smoothstep(3.5 * S, 0.3, blur) : 1;
    if (sharpW < 1) blurredText(ch, x, yy, blur, color, st.alpha * (1 - sharpW * 0.7));
    if (sharpW > 0) {
      g.save();
      g.globalAlpha = clamp(st.alpha * sharpW, 0, 1);
      g.shadowColor = glow; g.shadowBlur = (10 + 10 * st.sung) * S; g.shadowOffsetX = 0; g.shadowOffsetY = 0;
      g.fillStyle = color;
      g.fillText(ch, x, yy);
      if (st.sung > 0.01) { g.shadowBlur = 0; g.globalAlpha = clamp(st.alpha * sharpW * 0.35 * st.sung, 0, 1); g.fillText(ch, x, yy); }
      g.restore();
    }
  }

  function measure(text, font) { g.font = font; return g.measureText(text).width; }

  function drawBottom(L, t) {
    const size = (L.style?.size || bottom.size) * S;
    const font = `400 ${size}px "${FONT_SERIF}"`;
    const track = bottom.tracking * size;
    const widths = L.chars.map((c) => (c.space ? size * 0.55 : measure(c.c, font)));
    const total = widths.reduce((a, b) => a + b, 0) + track * (L.chars.length - 1);
    let x = W / 2 - total / 2;
    let y;
    const place = L.style?.place || bottom.place;
    if (typeof place === 'number') y = place * H;
    else if (place === 'picture' || barH < size * 1.8) y = barH + PH * 0.9; // no room in the bar (e.g. ?h=402) → inside the picture
    else y = H - barH / 2; // centred in the lower bar
    for (let i = 0; i < L.chars.length; i++) {
      const c = L.chars[i];
      if (!c.space) glyph(c.c, x + widths[i] / 2, y, size, charState(c, t, L), FONT_SERIF, 400, bottom.color, bottom.glow);
      x += widths[i] + track;
    }
  }

  function drawVertical(L, t) {
    const st = L.style;
    const size = (st.size || 50) * S;
    const colGap = (st.colGap || 2.1) * size;
    const x = (st.x ?? 0.84) * W - L.col * colGap;
    let y = barH + PH * (st.y ?? 0.16);
    const step = size * (1 + (st.tracking ?? 0.28));
    for (const c of L.chars) {
      if (c.space) { y += step * 0.55; continue; }
      glyph(c.c, x, y + size / 2, size, charState(c, t, L), FONT_SERIF, 400, st.color || '#eef2f7', st.glow || 'rgba(160,188,228,0.55)');
      y += step;
    }
  }

  // ---- title card & credits ----
  const sealRng = makeRng('seal');
  const sealNoise = Array.from({ length: 64 }, () => sealRng());
  function drawSeal(x, y, s, alpha, text = '月') {
    if ([...text].length > 1) return drawSealMulti(x, y, s, alpha, text);
    grow(x - s, y - s, x + s, y + s);
    g.save();
    g.globalAlpha = alpha * 0.92;
    g.fillStyle = '#b8322a';
    g.beginPath();
    const n = 32;
    for (let i = 0; i < n; i++) { // slightly irregular rounded square
      const a = (i / n) * Math.PI * 2;
      const sq = 1 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      const r = s * 0.5 * Math.min(sq, 1.25) * (0.97 + 0.05 * sealNoise[i]);
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath(); g.fill();
    g.globalCompositeOperation = 'destination-out';
    g.font = `400 ${s * 0.72}px "${FONT_BRUSH}"`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, x, y + s * 0.03);
    g.restore();
  }

  /**
   * Multi-character chop (e.g. a 4-character name): characters knocked out of an irregular vermilion square in
   * traditional reading order — columns right → left, each top → bottom ( → row 1 [一][天], row 2 [秉][下]).
   */
  const sealNoiseM = new Map();
  function drawSealMulti(x, y, s, alpha, text) {
    const ch = [...text];
    const cols = Math.ceil(ch.length / 2), rows = Math.min(2, ch.length);
    const w = s * (cols >= 2 ? 1.0 : 0.62), h = s;
    let nz = sealNoiseM.get(text);
    if (!nz) { const r = makeRng('sealM:' + text); nz = { edge: Array.from({ length: 48 }, () => r()), specks: Array.from({ length: 26 }, () => [r(), r(), r()]) }; sealNoiseM.set(text, nz); }
    grow(x - w * 0.7, y - h * 0.7, x + w * 0.7, y + h * 0.7);
    g.save();
    g.globalAlpha = alpha * 0.93;
    g.fillStyle = '#b3302a';
    g.beginPath();
    const n = 48;
    for (let i = 0; i < n; i++) { // irregular rounded rectangle (hand-cut stone chop)
      const a = (i / n) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const sq = 1 / Math.max(Math.abs(ca) / (w * 0.5), Math.abs(sa) / (h * 0.5));
      const rr = Math.min(sq, 0.885 * Math.hypot(w, h) * 0.5) * (0.975 + 0.04 * nz.edge[i]);
      const px = x + ca * rr, py = y + sa * rr;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath(); g.fill();
    g.globalCompositeOperation = 'destination-out';
    // characters: column-major, right column first
    const inner = 0.88, cw = (w * inner) / cols, chh = (h * inner) / rows, fs = Math.min(cw, chh) * 1.06;
    g.font = `400 ${fs}px "${FONT_BRUSH}"`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.lineWidth = fs * 0.035; g.strokeStyle = '#000';
    for (let i = 0; i < ch.length; i++) {
      const col = Math.floor(i / rows), row = i % rows;
      const cxp = x + w * inner / 2 - cw * (col + 0.5), cyp = y - h * inner / 2 + chh * (row + 0.5);
      g.fillText(ch[i], cxp, cyp + fs * 0.03);
      g.strokeText(ch[i], cxp, cyp + fs * 0.03); // carved strokes read a little bolder than the brush face
    }
    // a few worn specks (stamped-ink texture), deterministic
    for (const [u, v, r] of nz.specks) { g.beginPath(); g.arc(x + (u - 0.5) * w * 0.92, y + (v - 0.5) * h * 0.92, s * (0.006 + 0.012 * r), 0, Math.PI * 2); g.fill(); }
    g.restore();
  }

  /** a centred brush line (small title, heading) whose characters ink-bloom in one after another */
  function bloomLine(text, cx, cy, size, t, t0, { stagger = 0.08, dur = 0.8, out = 1, alpha = 1, tracking = 0.16, color = '#f1ece4', glow = 'rgba(255,214,170,0.3)' } = {}) {
    const chars = [...text];
    const font = `400 ${size}px "${FONT_BRUSH}"`;
    const widths = chars.map((c) => measure(c, font));
    const track = size * tracking;
    const total = widths.reduce((a, b) => a + b, 0) + track * (chars.length - 1);
    let x = cx - total / 2, k = 0;
    for (let i = 0; i < chars.length; i++) {
      if (chars[i].trim()) {
        const a = easeOutCubic((t - (t0 + k++ * stagger)) / dur);
        glyph(chars[i], x + widths[i] / 2, cy, size, { alpha: a * out * alpha, blur: (1 - a) * 6 + (1 - out) * 3, drift: -(1 - a) * 5 + (1 - out) * 4, scale: 1 + (1 - a) * 0.05, sung: 0 }, FONT_BRUSH, 400, color, glow);
      }
      x += widths[i] + track;
    }
  }

  /** a short single line of letter-spaced text (labels, headings, small titles); returns its width */
  function spacedLine(text, x, y, size, family, color, alpha, tracking, glow, align = 'center') {
    if (alpha <= 0.003 || !text) return 0;
    g.save();
    g.globalAlpha = clamp(alpha, 0, 1);
    g.font = `400 ${size}px "${family}"`;
    g.textAlign = align; g.textBaseline = 'middle';
    if ('letterSpacing' in g) g.letterSpacing = `${(size * tracking).toFixed(1)}px`;
    g.fillStyle = color; g.shadowColor = glow || 'rgba(255,214,170,0.28)'; g.shadowBlur = 9 * S;
    const w = g.measureText(text).width;
    // letterSpacing adds trailing space after the last glyph; compensate so centred text stays centred
    const tr = 'letterSpacing' in g ? size * tracking : 0;
    const xx = align === 'center' ? x + tr / 2 : align === 'right' ? x + tr : x;
    g.fillText(text, xx, y);
    const pad = 22 * S;
    const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    grow(x0 - pad, y - size - pad, x0 + w + pad, y + size + pad);
    g.restore();
    return w;
  }

  /**
   * CREATOR card: [small title] / letter-spaced label / NAME (large brush, staggered ink bloom) + multi-char seal.
   * T: { t0, t1, name, label, small, seal (true|false|'text'), x, y, nameSize, labelSize, smallSize, stagger,
   *      bloom, fadeOut, color, glow }
   */
  function drawCreator(T, t) {
    const u0 = T.t0, u1 = T.t1;
    const fadeOut = 1 - smoothstep(u1 - (T.fadeOut ?? 0.6), u1, t);
    const nameSize = (T.nameSize ?? 104) * S, labelSize = (T.labelSize ?? 26) * S, smallSize = (T.smallSize ?? 40) * S;
    const cx = (T.x ?? 0.5) * W, cy = barH + PH * (T.y ?? 0.47);
    const color = T.color || '#f1ece4', glow = T.glow || 'rgba(255,214,170,0.35)';
    const stag = T.stagger ?? 0.15, bloom = T.bloom ?? 0.8;
    const ease = (t0, d) => easeOutCubic((t - t0) / d);
    if (T.scrim) scrim(cx, cy - nameSize * (T.small ? 0.45 : 0.2), W * 0.3, nameSize * (T.small ? 2.4 : 1.8), T.scrim * ease(u0, 0.8) * fadeOut);
    let tl = u0;
    // optional small title (brush) on top
    const labelY = cy - nameSize * 0.98;
    if (T.small) {
      bloomLine(T.small, cx, labelY - labelSize * (T.smallGap ?? 3.4), smallSize, t, tl, { out: fadeOut, alpha: 0.92, tracking: 0.16, color, glow });
      tl += 0.18;
    }
    // label
    if (T.label) {
      const a = ease(tl, 0.6) * fadeOut;
      spacedLine(T.label, cx, labelY + (1 - ease(tl, 0.6)) * 5 * S, labelSize, FONT_SERIF, color, a * 0.85, 0.28, 'rgba(255,214,170,0.22)');
      tl += 0.15;
    }
    // name: staggered ink bloom (like the title)
    const chars = [...(T.name || '')];
    const font = `400 ${nameSize}px "${FONT_BRUSH}"`;
    const widths = chars.map((c) => measure(c, font));
    const track = nameSize * (T.tracking ?? 0.14);
    const total = widths.reduce((a, b) => a + b, 0) + track * Math.max(0, chars.length - 1);
    let x = cx - total / 2;
    for (let i = 0; i < chars.length; i++) {
      const a = ease(tl + i * stag, bloom);
      const st = { alpha: a * fadeOut, blur: (1 - a) * 9 + (1 - fadeOut) * 3, drift: -(1 - a) * 6 + (1 - fadeOut) * 4, scale: 1 + (1 - a) * 0.06, sung: 0 };
      glyph(chars[i], x + widths[i] / 2, cy, nameSize, st, FONT_BRUSH, 400, color, glow);
      x += widths[i] + track;
    }
    // seal: stamped after the last character (quick press: 1.08 → 1.0 scale)
    if (T.seal !== false && chars.length) {
      const ts = tl + (chars.length - 1) * stag + bloom * 0.6;
      const k = ease(ts, 0.35);
      const a = k * fadeOut;
      const sz = nameSize * (T.sealSize ?? 0.8) * (1 + 0.08 * (1 - k));
      if (a > 0.003) drawSeal(cx + total / 2 + nameSize * 0.2 + sz * 0.62, cy + nameSize * 0.06, sz, a, typeof T.seal === 'string' ? T.seal : T.name);
    }
  }

  /** split a credit value at top-level ' · ' separators (never inside parentheses) */
  function splitTop(text) {
    const parts = []; let depth = 0, cur = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '(' || c === '（') depth++;
      else if (c === ')' || c === '）') depth = Math.max(0, depth - 1);
      if (depth === 0 && text.startsWith(' · ', i)) { parts.push(cur); cur = ''; i += 2; continue; }
      cur += c;
    }
    parts.push(cur);
    return parts;
  }
  /**
   * fit one credit value: keep it on one line up to `wrapW` (a ≤6 % shrink is allowed first), otherwise wrap it at
   * the most balanced top-level separator; anything still wider than the hard limit `maxW` (safe area) shrinks.
   */
  function fitValue(text, size, maxW, tracking, wrapW = maxW) {
    const widthAt = (txt, sz) => { g.font = `400 ${sz}px "${FONT_SERIF}"`; return g.measureText(txt).width + ('letterSpacing' in g ? sz * tracking * [...txt].length : 0); };
    const lim = Math.min(maxW, wrapW);
    const w0 = widthAt(text, size);
    if (w0 <= lim) return { lines: [text], size };
    if (w0 * 0.94 <= lim) return { lines: [text], size: size * lim / w0 };
    const parts = splitTop(text);
    if (parts.length > 1) {
      let best = null;
      for (let i = 1; i < parts.length; i++) {
        const a = parts.slice(0, i).join(' · '), b = parts.slice(i).join(' · ');
        const m = Math.max(widthAt(a, size), widthAt(b, size));
        if (!best || m < best.m) best = { a, b, m };
      }
      return { lines: [best.a, best.b], size: best.m > maxW ? size * maxW / best.m : size };
    }
    return { lines: [text], size: size * Math.min(1, maxW / w0) };
  }

  /**
   * ROLES card (film end-credit list): optional brush heading, then rows [role, value] — role right-aligned (dim,
   * small, letter-spaced) at roleX, value left-aligned (bright) at valueX; rows fade/drift in staggered.
   * T: { t0, t1, heading, rows:[[role, value]] | pages:[{ t0, t1, rows }], x, y, roleX 0.44, valueX 0.47,
   *      roleSize 24, valueSize 30, headingSize 46, headingGap 2.1, rowGap 2.1, stagger 0.25, fadeOut 0.5, pageFade,
   *      wrapAt 0.40 (value width that wraps at a ' · '), safe:[0.08, 0.92] (hard x limits), scrim (0..1, off) }
   * `pages` keep one heading on screen while the rows change (a continued card): each page's rows fade out over
   * its last `fadeOut` s and the next page's rows bloom in; the block is laid out for the tallest page, rows
   * top-aligned under the heading.
   */
  function drawRoles(T, t) {
    const cardOut = 1 - smoothstep(T.t1 - (T.fadeOut ?? 0.5), T.t1, t);
    const color = T.color || '#f1ece4';
    const roleSize = (T.roleSize ?? 24) * S, valueSize = (T.valueSize ?? 30) * S, headSize = (T.headingSize ?? 46) * S;
    const rowGap = valueSize * (T.rowGap ?? 2.1);
    const roleX = (T.roleX ?? 0.44) * W, valueX = (T.valueX ?? 0.47) * W;
    const safe = T.safe || [0.08, 0.92];
    const pages = (T.pages || [{ t0: T.t0, t1: T.t1, rows: T.rows || [] }]).map((p) => {
      const rows = p.rows.map(([role, value]) => {
        g.font = `400 ${roleSize}px "${FONT_SERIF}"`; // roles are short; shrink one only if it would cross the left safe edge
        const rw = g.measureText(role).width + roleSize * 0.2 * [...role].length, room = roleX - safe[0] * W;
        return { role, value, roleSize: rw > room ? roleSize * room / rw : roleSize, fit: fitValue(value, valueSize, safe[1] * W - valueX, 0.04, (T.wrapAt ?? 0.4) * W) };
      });
      const h = rows.reduce((a, r) => a + rowGap + (r.fit.lines.length - 1) * r.fit.size * 1.35, 0);
      return { ...p, rows, h };
    });
    const headH = T.heading ? headSize * (T.headingGap ?? 2.1) : 0;
    const blockH = headH + Math.max(...pages.map((p) => p.h));
    const top = barH + PH * (T.y ?? 0.5) - blockH / 2;
    const ease = (t0, d) => easeOutCubic((t - t0) / d);
    if (T.scrim) scrim((T.x ?? 0.5) * W, top + blockH / 2, W * 0.36, blockH * 0.85, T.scrim * ease(T.t0, 0.8) * cardOut);
    if (T.heading) bloomLine(T.heading, (T.x ?? 0.5) * W, top + headSize * 0.5, headSize, t, T.t0, { out: cardOut, alpha: 0.95, tracking: 0.18, stagger: 0.07, color });
    const stag = T.stagger ?? 0.25;
    for (let k = 0; k < pages.length; k++) {
      const p = pages[k];
      if (t < p.t0 || t > p.t1) continue;
      const pageOut = k === pages.length - 1 ? cardOut : 1 - smoothstep(p.t1 - (T.pageFade ?? T.fadeOut ?? 0.5), p.t1, t);
      const r0 = p.t0 + (k === 0 && T.heading ? 0.25 : 0.05);
      let y = top + headH;
      for (let i = 0; i < p.rows.length; i++) {
        const r = p.rows[i];
        const e = ease(r0 + i * stag, 0.7), a = e * pageOut;
        const n = r.fit.lines.length, lh = r.fit.size * 1.35;
        const yc = y + rowGap * 0.5 + (1 - e) * 7 * S; // role aligns with the first value line
        spacedLine(r.role, roleX, yc, r.roleSize, FONT_SERIF, color, a * 0.64, 0.2, 'rgba(255,214,170,0.14)', 'right');
        for (let j = 0; j < n; j++) spacedLine(r.fit.lines[j], valueX, yc + j * lh, r.fit.size, FONT_SERIF, color, a * 0.97, 0.04, 'rgba(255,214,170,0.26)', 'left');
        y += rowGap + (n - 1) * lh;
      }
    }
  }

  /** very soft dark elliptical vignette behind a text block (readability over bright picture areas) */
  function scrim(cx, cy, rx, ry, alpha) {
    if (alpha <= 0.003) return;
    g.save();
    g.translate(cx, cy); g.scale(1, ry / rx);
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    gr.addColorStop(0, `rgba(4,6,10,${(alpha).toFixed(4)})`);
    gr.addColorStop(0.55, `rgba(4,6,10,${(alpha * 0.6).toFixed(4)})`);
    gr.addColorStop(1, 'rgba(4,6,10,0)');
    g.fillStyle = gr;
    g.fillRect(-rx, -rx, rx * 2, rx * 2);
    g.restore();
    grow(cx - rx, cy - ry, cx + rx, cy + ry);
  }

  function drawTitle(T, t) {
    const u0 = T.t0, u1 = T.t1;
    const fadeOut = 1 - smoothstep(u1 - (T.fadeOut ?? 2.2), u1, t);
    const text = T.text || '';
    const size = (T.size || 124) * S;
    const cx = (T.x ?? 0.5) * W, cy = barH + PH * (T.y ?? 0.44);
    const chars = [...text];
    const font = `400 ${size}px "${FONT_BRUSH}"`;
    const widths = chars.map((c) => measure(c, font));
    const track = size * (T.tracking ?? 0.12);
    const total = widths.reduce((a, b) => a + b, 0) + track * (chars.length - 1);
    let x = cx - total / 2;
    for (let i = 0; i < chars.length; i++) {
      const ts = u0 + i * (T.stagger ?? 0.45);
      const a = easeOutCubic((t - ts) / (T.bloom ?? 1.6));
      const st = { alpha: a * fadeOut, blur: (1 - a) * 10 + (1 - fadeOut) * 4, drift: -(1 - a) * 6 + (1 - fadeOut) * 5, scale: 1 + (1 - a) * 0.06, sung: 0 };
      glyph(chars[i], x + widths[i] / 2, cy, size, st, FONT_BRUSH, 400, T.color || '#f1ece4', T.glow || 'rgba(255,214,170,0.35)');
      x += widths[i] + track;
    }
    if (T.sub) {
      const a = easeOutCubic((t - (u0 + chars.length * (T.stagger ?? 0.45) + (T.subDelay ?? 0.4))) / (T.subBloom ?? 1.8)) * fadeOut;
      const ssize = (T.subSize || 22) * S;
      g.save();
      g.globalAlpha = a * 0.85;
      g.font = `400 ${ssize}px "${FONT_SERIF}"`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      if ('letterSpacing' in g) g.letterSpacing = `${(ssize * 0.5).toFixed(1)}px`;
      g.fillStyle = '#d9dee6'; g.shadowColor = 'rgba(160,188,228,0.4)'; g.shadowBlur = 8 * S;
      g.fillText(T.sub, cx, cy + size * 0.78);
      { const w = g.measureText(T.sub).width + ssize * 0.5 * T.sub.length, pad = 20 * S; grow(cx - w / 2 - pad, cy + size * 0.78 - ssize - pad, cx + w / 2 + pad, cy + size * 0.78 + ssize + pad); }
      g.restore();
    }
    if (T.seal !== false) {
      const a = easeOutCubic((t - (u0 + chars.length * (T.stagger ?? 0.45) + (T.sealDelay ?? 0.9))) / 0.9) * fadeOut;
      if (a > 0.003) drawSeal(cx + total / 2 + size * 0.42, cy + size * 0.18, size * 0.36, a, T.sealText || '月');
    }
  }

  function drawCredits(T, t) {
    const fadeOut = 1 - smoothstep(T.t1 - (T.fadeOut ?? 2.0), T.t1, t);
    const linesC = T.lines || [];
    const size = (T.size || 26) * S;
    const lh = size * 2.0;
    const cy = barH + PH * (T.y ?? 0.5) - (linesC.length - 1) * lh / 2;
    for (let i = 0; i < linesC.length; i++) {
      const ln = linesC[i];
      const a = easeOutCubic((t - (T.t0 + i * (T.stagger ?? 0.6))) / 1.4) * fadeOut;
      if (a <= 0.003) continue;
      const isHead = typeof ln === 'object' && ln.head;
      const txt = typeof ln === 'object' ? ln.text : ln;
      g.save();
      g.globalAlpha = a;
      const fam = isHead ? FONT_BRUSH : FONT_SERIF;
      const sz = isHead ? size * 1.9 : size;
      g.font = `400 ${sz}px "${fam}"`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      if ('letterSpacing' in g) g.letterSpacing = `${(sz * (isHead ? 0.12 : 0.3)).toFixed(1)}px`;
      g.fillStyle = '#e6e9ee'; g.shadowColor = 'rgba(160,188,228,0.45)'; g.shadowBlur = 10 * S;
      g.fillText(txt, (T.x ?? 0.5) * W, cy + i * lh + (1 - a) * 6 * S);
      { const w = g.measureText(txt).width + sz * 0.3 * txt.length, pad = 24 * S, yy = cy + i * lh + (1 - a) * 6 * S; grow((T.x ?? 0.5) * W - w / 2 - pad, yy - sz - pad, (T.x ?? 0.5) * W + w / 2 + pad, yy + sz + pad); }
      g.restore();
    }
  }

  const api = {
    canvas, lines,
    /** draw the overlay for film time t; returns the drawn bbox {x0,y0,x1,y1} (canvas px) or null */
    draw(t, { hideLyrics = false } = {}) {
      const visible = [];
      if (!hideLyrics) for (const L of lines) if (t >= L.visStart && t <= L.fadeEnd) visible.push(L);
      const vt = titles.filter((T) => t >= T.t0 && t <= T.t1);
      g.clearRect(0, 0, W, H); // full clear: the result must never depend on the previous frame
      bb.x0 = bb.y0 = 1e9; bb.x1 = bb.y1 = -1e9;
      if (!visible.length && !vt.length) return null;
      for (const L of visible) { if (L.mode === 'vertical') drawVertical(L, t); else drawBottom(L, t); }
      for (const T of vt) {
        if (T.kind === 'credits') drawCredits(T, t);
        else if (T.kind === 'creator') drawCreator(T, t);
        else if (T.kind === 'roles') drawRoles(T, t);
        else drawTitle(T, t);
      }
      if (bb.x1 <= bb.x0) return null;
      return { x0: Math.max(0, bb.x0), y0: Math.max(0, bb.y0), x1: Math.min(W, bb.x1), y1: Math.min(H, bb.y1) };
    },
    dispose() {},
  };
  return api;
}
