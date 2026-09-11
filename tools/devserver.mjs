// Dev-only static server + screenshot sink.
//
// Why this exists: the game renders with WebGL, and the automated preview pane
// cannot capture WebGL surfaces in a screenshot. So the page reads pixels back
// from the framebuffer itself and POSTs them here, where they land on disk as
// JPEGs that can be opened and reviewed.
//
// Not used by the game at runtime — plain `npx serve` works just as well for play.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? '.');
const PORT = Number(process.env.PORT ?? 3721);
const SHOTS = join(ROOT, '.shots');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

await mkdir(SHOTS, { recursive: true });

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/__shot') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const { name = 'shot', dataUrl = '' } = JSON.parse(body);
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const ext = dataUrl.startsWith('data:image/png') ? 'png' : 'jpg';
    const file = join(SHOTS, `${safe}.${ext}`);
    await writeFile(file, Buffer.from(b64, 'base64'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, file }));
    return;
  }

  let p = normalize(decodeURIComponent(url.pathname));
  if (p.endsWith('/')) p += 'index.html';
  const base = join(ROOT, p);
  if (!base.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  // Match `npx serve`: bare paths also resolve to .html / directory index.
  const candidates = extname(base) ? [base] : [base, base + '.html', join(base, 'index.html')];

  for (const full of candidates) {
    try {
      const buf = await readFile(full);
      res.writeHead(200, {
        'content-type': MIME[extname(full)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(buf);
      return;
    } catch { /* try next */ }
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}).listen(PORT, () => console.log(`dev server on http://localhost:${PORT} (root ${ROOT}, shots -> ${SHOTS})`));
