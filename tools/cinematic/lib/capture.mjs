// Author: suwubee
// Frame capture strategies. All of them seek AND capture inside one page.evaluate (same JS task), so they are
// correct even when the page's WebGL context has preserveDrawingBuffer:false.
//
// methods:
//   pixels      gl.readPixels(RGBA8 default framebuffer) -> binary fetch POST to the tool server -> Node PNG encode
//               (JS filter + async zlib in the libuv pool, overlaps the next frame). Fastest lossless. (default)
//   blob        canvas.toBlob(mime) -> binary POST. mime image/png | image/jpeg | image/webp
//   dataurl     canvas.toDataURL(mime) -> base64 string through CDP
//   cdp         CDP Page.captureScreenshot(clip=canvas, optimizeForSpeed) png|jpeg|webp (composited: includes DOM overlays)
//   screenshot  Playwright page.screenshot (canvas clip, or whole viewport with full:true)
import { encodePNG } from './png.mjs';

export class FrameSink {
  constructor() { this.store = new Map(); this.waiters = new Map(); this.seq = 0; this.issued = new Set(); this.prefix = `/__mvframe/${process.pid}-${Math.floor(Math.random() * 1e9)}/`; }
  newUrl() { const id = String(++this.seq); this.issued.add(id); return { id, url: this.prefix + id }; }
  take(id) { const v = this.store.get(id); this.store.delete(id); return v; }
  /** Promise for an upload that may still be in flight. */
  wait(id, timeoutMs = 60000) {
    const v = this.take(id);
    if (v) return Promise.resolve(v);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`upload ${id} not received within ${timeoutMs} ms`)); }, timeoutMs);
      timer.unref();
      this.waiters.set(id, (v, err) => { clearTimeout(timer); if (err) reject(err); else resolve(v); });
    });
  }
  cancel(id) { this.waiters.delete(id); this.store.delete(id); this.issued.delete(id); }
  /** Reject a still-pending wait (e.g. the browser died before the upload arrived). No-op if it already arrived. */
  fail(id, err = new Error('upload abandoned')) { const w = this.waiters.get(id); if (w) { this.waiters.delete(id); w(null, err); } }
  /** http hook for startServer({ handler }) */
  handler = async (req, res, urlPath) => {
    if (req.method !== 'POST' || !urlPath.startsWith(this.prefix)) return false;
    const id = urlPath.slice(this.prefix.length);
    const len = +req.headers['content-length'] || 0;
    if(!this.issued.delete(id) || !Number.isSafeInteger(len) || len<0 || len>64*1024*1024){res.writeHead(413);res.end();return true;}
    let received=0;
    let buf = len ? Buffer.allocUnsafe(len) : null, off = 0;
    const parts = [];
    for await (const c of req) {
      received+=c.length;if(received>64*1024*1024){this.fail(id,new Error("frame exceeds 64 MiB"));res.writeHead(413);res.end();return true;}
      if (buf && off + c.length <= len) { c.copy(buf, off); off += c.length; } else parts.push(c);
    }
    if (!buf || parts.length) buf = Buffer.concat(buf ? [buf.subarray(0, off), ...parts] : parts);
    const u = new URL(req.url, 'http://x');
    const v = { buf, w: +u.searchParams.get('w') || 0, h: +u.searchParams.get('h') || 0, flip: u.searchParams.get('flip') === '1' };
    const waiter = this.waiters.get(id);
    if (waiter) { this.waiters.delete(id); waiter(v); } else this.store.set(id, v);
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Length': 0 });
    res.end();
    return true;
  };
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/**
 * Seek to t and capture. Returns { w, h, seekMs, capMs, ext, encode: Promise<Buffer> }.
 * `encode` resolves to the encoded file bytes; for 'pixels' the PNG encode runs asynchronously so callers can
 * start the next seek before awaiting it.
 */
export async function seekAndCapture(page, t, o = {}) {
  const method = o.method || 'pixels';
  const format = (o.format || 'png').replace('jpeg', 'jpg');
  const q = o.quality ?? 95;
  const t0 = performance.now();
  if (method === 'pixels') {
    if (format !== 'png') throw new Error("method 'pixels' only writes png (use --method blob for jpg/webp)");
    const { id, url } = o.sink.newUrl();
    const nowait = o.nowait ?? true; // page returns right after readPixels; upload streams while the next frame renders
    let r;
    try {
      r = await page.evaluate(([t, url, nowait]) => window.__mvTools.seekCapture(t, 'pixels', { url, nowait }), [t, url, nowait]);
    } catch (e) { o.sink.cancel(id); throw e; }
    const capMs = performance.now() - t0 - r.seekMs;
    const encode = o.sink.wait(id, o.uploadTimeoutMs ?? 60000).then((got) => {
      if (got.buf.length !== got.w * got.h * 4) throw new Error(`pixel upload short for t=${t}: ${got.buf.length} bytes`);
      if (o.keepRaw) o.keepRaw(got);
      if (o.rawOnly) return got; // {buf (RGBA, bottom-up if flip), w, h, flip}
      return encodePNG(got.buf, got.w, got.h, { flip: got.flip, level: o.pngLevel ?? 1, filter: o.pngFilter || 'sub' });
    });
    return { w: r.w, h: r.h, seekMs: r.seekMs, readMs: r.readMs, capMs, ext: 'png', encode, uploadId: id };
  }
  if (method === 'blob') {
    const { id, url } = o.sink.newUrl();
    const r = await page.evaluate(([t, url, mime, qq]) => window.__mvTools.seekCapture(t, 'blob', { url, mime, quality: qq }), [t, url, MIME[format], q / 100]);
    const got = o.sink.take(id);
    if (!got) throw new Error(`blob upload missing for t=${t}`);
    return { w: r.w, h: r.h, seekMs: r.seekMs, capMs: performance.now() - t0 - r.seekMs, ext: format, encode: Promise.resolve(got.buf) };
  }
  if (method === 'dataurl') {
    const r = await page.evaluate(([t, mime, qq]) => window.__mvTools.seekCapture(t, 'dataurl', { mime, quality: qq }), [t, MIME[format], q / 100]);
    const buf = Buffer.from(r.data.slice(r.data.indexOf(',') + 1), 'base64');
    return { w: r.w, h: r.h, seekMs: r.seekMs, capMs: performance.now() - t0 - r.seekMs, ext: format, encode: Promise.resolve(buf) };
  }
  if (method === 'cdp' || method === 'screenshot') {
    // Seek, then read the canvas rect; the composited frame is captured right after (same frame content).
    const r = await page.evaluate(async (t) => { const r = await window.__mvTools.seekCapture(t, 'none'); return { ...r, rect: window.__mvTools.rect() }; }, t);
    const clip = o.full ? undefined : { x: r.rect.x, y: r.rect.y, width: r.rect.width, height: r.rect.height };
    let buf;
    if (method === 'cdp') {
      const cdp = o.cdp || (o.cdp = await page.context().newCDPSession(page));
      const params = { format: format === 'jpg' ? 'jpeg' : format, optimizeForSpeed: o.optimizeForSpeed ?? true, captureBeyondViewport: false, fromSurface: true };
      if (format !== 'png') params.quality = q;
      if (clip) params.clip = { ...clip, scale: 1 };
      const shot = await cdp.send('Page.captureScreenshot', params);
      buf = Buffer.from(shot.data, 'base64');
    } else {
      buf = await page.screenshot({ type: format === 'jpg' ? 'jpeg' : 'png', quality: format === 'jpg' ? q : undefined, clip, animations: 'allow', caret: 'initial', scale: 'css' });
    }
    return { w: r.w, h: r.h, seekMs: r.seekMs, capMs: performance.now() - t0 - r.seekMs, ext: format, encode: Promise.resolve(buf) };
  }
  throw new Error('unknown capture method ' + method);
}
