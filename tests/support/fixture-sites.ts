import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Serves the fixture websites in tests/fixtures/sites, each on its own loopback IP
 * (127.0.0.2, 127.0.0.3, ...) so they have distinct "domains". Large images are generated
 * on the fly (uncompressed BMP) to exercise the performance checks without committing binaries.
 */
const ROOT = fileURLToPath(new URL('../fixtures/sites/', import.meta.url));

const BMP_SIZES: Record<string, [number, number]> = {
  'hero.bmp': [1600, 900],
  'team.bmp': [1400, 800],
  'logo.bmp': [200, 80],
};

function bmp(w: number, h: number): Buffer {
  const row = (w * 3 + 3) & ~3;
  const buf = Buffer.alloc(54 + row * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) buf[54 + y * row + x] = (x * 7 + y) % 256;
  return buf;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.txt': 'text/plain', '.xml': 'application/xml' };

export interface FixtureSites {
  urls: Record<string, string>;
  close(): Promise<void>;
}

export async function startFixtureSites(names: string[] = ['smile-dental', 'modern-clinic', 'bella-beauty'], basePort = 0): Promise<FixtureSites> {
  const servers: Server[] = [];
  const urls: Record<string, string> = {};
  let ipOctet = 2;
  for (const name of names) {
    const dir = join(ROOT, name);
    const server = createServer(async (req, res) => {
      const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
      if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }
      if (path.startsWith('/img/') && path.endsWith('.bmp')) {
        const [w, h] = BMP_SIZES[path.slice(5)] ?? [800, 600];
        res.writeHead(200, { 'content-type': 'image/bmp' }).end(req.method === 'HEAD' ? undefined : bmp(w, h));
        return;
      }
      const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
      try {
        const body = await readFile(join(dir, rel));
        res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' }).end(req.method === 'HEAD' ? undefined : body);
      } catch {
        res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>');
      }
    });
    const host = `127.0.0.${ipOctet++}`;
    await new Promise<void>((resolve) => server.listen(basePort ? basePort : 0, host, resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : basePort;
    urls[name] = `http://${host}:${port}`;
    servers.push(server);
  }
  return {
    urls,
    close: () => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))).then(() => undefined),
  };
}
