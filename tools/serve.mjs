import http from 'node:http';
import path from 'node:path';
import {realpath, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {cli, isMain, number} from './lib/cli.mjs';

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.bin': 'application/octet-stream',
};
export function mime(file) {
  return file.endsWith('.wasm.bin') ? 'application/wasm' : types[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

export function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) throw new Error('range');
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] ? (match[2] ? Math.min(Number(match[2]), size - 1) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) throw new Error('range');
  return {start, end};
}

export async function startServer({root = '.', port = 39920, host = '127.0.0.1'} = {}) {
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Only loopback hosts are supported');
  const base = await realpath(root);
  const inside = file => file === base || file.startsWith(base + path.sep);
  const server = http.createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, {Allow: 'GET, HEAD'}).end();
        return;
      }
      const pathname = decodeURIComponent(req.url.split('?')[0]);
      if (pathname.includes('\0') || pathname.split('/').some(p => p.startsWith('.')) || pathname.includes('\\')) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      let file = path.resolve(base, '.' + pathname);
      if (!inside(file)) { res.writeHead(403).end('Forbidden'); return; }
      file = await realpath(file);
      if (!inside(file)) { res.writeHead(403).end('Forbidden'); return; }
      let info = await stat(file);
      if (info.isDirectory()) {
        file = await realpath(path.join(file, 'index.html'));
        if (!inside(file)) { res.writeHead(403).end('Forbidden'); return; }
        info = await stat(file);
      }
      if (!info.isFile()) { res.writeHead(404).end('Not found'); return; }
      let range;
      try { range = byteRange(req.headers.range, info.size); }
      catch { res.writeHead(416, {'Content-Range': `bytes */${info.size}`}).end(); return; }
      const headers = {
        'Content-Type': mime(file), 'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes',
        'Content-Length': range ? range.end - range.start + 1 : info.size,
      };
      if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD' || info.size === 0) res.end();
      else await pipeline(createReadStream(file, range || {}), res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 400).end('Unavailable');
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    server, port: server.address().port,
    url: `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

if (isMain(import.meta.url)) {
  const args = cli({root: {type: 'string', default: '.'}, port: {type: 'string', default: '39920'},
    host: {type: 'string', default: '127.0.0.1'}},
  'Usage: node tools/serve.mjs [--root DIR] [--port 39920] [--host 127.0.0.1]\n静态服务：MIME、Range、HEAD、开发 no-cache，仅回环地址。');
  if (args) {
    const app = await startServer({...args, port: number(args.port, 'port', 1, 65535, true)});
    console.log(`READY ${app.url} pid=${process.pid}`);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
    });
  }
}
