import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeWebsite } from '../../src/providers/website/analyzer.js';
import { closeBrowserPool } from '../../src/providers/website/browser-pool.js';

/**
 * The analyser runs untrusted pages. Besides the HTTP route guard (see ssrf tests), a page must
 * never be able to open WebSockets (not covered by request interception) or trigger downloads.
 */
let server: http.Server;
let base = '';
let upgrades = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') return res.writeHead(404).end();
    if (req.url === '/file.zip') return res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename=x.zip' }).end('PK');
    const port = (server.address() as AddressInfo).port;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Probe Clinic</title></head>
<body><h1>Probe Clinic</h1><p>Dental care in Warsaw.</p><a href="/file.zip">download</a>
<script>try { const ws = new WebSocket('ws://127.0.0.1:${port}/probe'); ws.onopen = () => document.title = 'LEAKED'; } catch (e) {}</script></body></html>`);
  });
  server.on('upgrade', (_req, socket) => {
    upgrades++;
    socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await closeBrowserPool();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('analyzer sandbox', () => {
  it('blocks WebSockets opened by the analysed page', async () => {
    const raw = await analyzeWebsite(base, { analysisId: 'sandbox-test', maxPages: 1 });
    expect(raw.status).toMatch(/completed|partial/);
    expect(upgrades).toBe(0);
    const blocked = Object.values(raw.runs).flatMap((r) => r?.blockedRequests ?? []);
    expect(blocked.some((b) => b.startsWith('websocket'))).toBe(true);
    expect(raw.runs.desktop?.snapshot?.meta.title).toBe('Probe Clinic');
  });
});
