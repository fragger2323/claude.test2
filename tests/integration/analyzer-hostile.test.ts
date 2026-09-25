import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeWebsite } from '../../src/providers/website/analyzer.js';
import { closeBrowserPool } from '../../src/providers/website/browser-pool.js';
import { buildFindings } from '../../src/engine/analysis/checks.js';
import { contactsFromAnalysis, resolveContacts } from '../../src/engine/contacts/contact-discovery.js';

/**
 * Adversarial websites: the analyser must finish in bounded time, never report findings about
 * pages it could not really see (bot challenges, error pages), and never attribute a third
 * party's contact (e.g. the web agency in the footer) to the business.
 */
const page = (body: string, head = '<meta name="viewport" content="width=device-width,initial-scale=1">') =>
  `<!doctype html><html lang="pl"><head><meta charset="utf-8">${head}<title>Gabinet Test</title></head><body>${body}</body></html>`;

const servers: http.Server[] = [];
async function site(handler: http.RequestListener, host = '127.0.0.1'): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, host, r));
  return `http://${host}:${(s.address() as AddressInfo).port}/`;
}
const robots404 = (req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url === '/robots.txt' || req.url?.startsWith('/sitemap') || req.url?.startsWith('/wp-sitemap') || req.url?.includes('aios-check')) {
    res.writeHead(404).end('not found');
    return true;
  }
  return false;
};

let busy = '';
let stream = '';
let challenge = '';
let footer = '';
let redirectLoop = '';

beforeAll(async () => {
  busy = await site((req, res) => {
    if (robots404(req, res)) return;
    res.writeHead(200, { 'content-type': 'text/html' }).end(page('<h1>Busy</h1><a href="/kontakt">Kontakt</a><script>setTimeout(function(){ for(;;){} }, 300)</script>'));
  });
  stream = await site((req, res) => {
    if (robots404(req, res)) return;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('<!doctype html><html><head><title>Slow</title></head><body>');
    const t = setInterval(() => res.write('<p>still loading</p>'), 500);
    req.on('close', () => clearInterval(t));
  });
  challenge = await site((req, res) => {
    if (robots404(req, res)) return;
    res.writeHead(403, { 'content-type': 'text/html', server: 'cloudflare', 'cf-ray': '8abc-WAW' }).end(
      '<!doctype html><html><head><title>Just a moment...</title></head><body><h1>Checking your browser before accessing the site.</h1><div id="challenge-form"></div></body></html>',
    );
  });
  footer = await site((req, res) => {
    if (robots404(req, res)) return;
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      page(`<header><nav><a href="/">Start</a><a href="/oferta">Oferta</a><a href="/kontakt">Kontakt</a></nav></header>
<h1>Gabinet Stomatologiczny Test</h1><a class="btn" href="/kontakt" style="background:#036;color:#fff;padding:12px">Umów wizytę</a>
<p>Napisz: <a href="mailto:recepcja@gabinet-test.pl">recepcja@gabinet-test.pl</a></p>
<footer>© 2016 - ${new Date().getFullYear()} Gabinet Test. NIP 525-000-11-22, KRS 0000123456. Konto: 12 1020 1026 0000 0402 0123 4567.
Realizacja strony: Studio Pixel, kontakt@studio-pixel-agencja.pl</footer>`),
    );
  });
  redirectLoop = await site((req, res) => {
    if (robots404(req, res)) return;
    res.writeHead(302, { location: '/loop?' + Math.random() }).end();
  });
});

afterAll(async () => {
  await closeBrowserPool();
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

describe('hostile websites', () => {
  it('a page that freezes its main thread cannot hang the analysis', async () => {
    const started = Date.now();
    const raw = await analyzeWebsite(busy, { analysisId: 'hostile-busy', maxPages: 1, viewports: ['desktop'] });
    expect(Date.now() - started).toBeLessThan(75_000);
    expect(['partial', 'failed', 'completed']).toContain(raw.status);
  }, 90_000);

  it('a response that never finishes is bounded by timeouts', async () => {
    const started = Date.now();
    const raw = await analyzeWebsite(stream, { analysisId: 'hostile-stream', maxPages: 1, viewports: ['desktop'] });
    expect(Date.now() - started).toBeLessThan(75_000);
    expect(raw.status).toBeDefined();
  }, 90_000);

  it('a bot-protection challenge is reported as blocked, with no findings about the site', async () => {
    const raw = await analyzeWebsite(challenge, { analysisId: 'hostile-challenge', maxPages: 1 });
    expect(raw.status).toBe('blocked');
    expect(buildFindings(raw)).toEqual([]);
  }, 90_000);

  it('redirect loops end as unreachable, not as a crash', async () => {
    const raw = await analyzeWebsite(redirectLoop, { analysisId: 'hostile-loop', maxPages: 1 });
    expect(raw.status).toBe('unreachable');
    expect(buildFindings(raw)).toEqual([]);
  }, 90_000);

  it('years, tax IDs and bank numbers are not treated as phone numbers; agency e-mails are not the business contact', async () => {
    const raw = await analyzeWebsite(footer, { analysisId: 'hostile-footer', maxPages: 1 });
    const codes = buildFindings(raw).map((f) => f.code);
    expect(codes).not.toContain('ux.no_click_to_call');
    const contacts = resolveContacts(contactsFromAnalysis(raw, 'PL'), { officialDomain: 'gabinet-test.pl' });
    const emails = contacts.filter((c) => c.type === 'email').map((c) => c.normalizedValue);
    expect(emails).toContain('recepcja@gabinet-test.pl');
    expect(emails).not.toContain('kontakt@studio-pixel-agencja.pl');
    expect(contacts.filter((c) => c.type === 'phone')).toEqual([]);
  }, 90_000);
});
