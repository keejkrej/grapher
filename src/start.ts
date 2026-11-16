import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceMiddleware } from './server.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = resolve(root, 'dist');
if (!existsSync(resolve(assets, 'index.html'))) throw new Error('Run npm run build before npm start.');
const middleware = workspaceMiddleware(process.env);
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};
const server = createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  middleware(req, res, () => {
    void (async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end('Method not allowed');
      }
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname); }
      catch { res.writeHead(400); return res.end('Invalid path'); }
      const requested = resolve(assets, '.' + pathname);
      const pathFromRoot = relative(assets, requested);
      if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot) || pathname.includes('\0')) {
        res.writeHead(403); return res.end('Forbidden');
      }
      const file = pathname === '/' ? resolve(assets, 'index.html') : requested;
      const details = await stat(file).catch(() => null);
      if (!details?.isFile()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': mime[extname(file)] || 'application/octet-stream',
        'Content-Length': details.size,
        'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end('Request failed'); });
  });
});
const port = Number(process.env.PORT || 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
server.listen(port, '127.0.0.1', () => console.log(`Grapher is available at http://localhost:${port}`));
server.on('close', () => middleware.close());
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (closing) return;
  closing = true;
  server.close();
  server.closeIdleConnections();
});
