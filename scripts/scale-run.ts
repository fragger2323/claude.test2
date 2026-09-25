/**
 * Scale / stress run: a 100-lead search end to end through the real worker, against
 *   - 150 generated business websites, each on its own loopback address (127.0.3.x),
 *   - mocked Nominatim + Overpass (170 POIs) and Google Places (60 overlapping + 10 unique),
 *   - optional hostile sites (--hostile): frozen main thread, bot challenge, never-ending response.
 * Reports stage timings, time to first contact-ready lead, dedupe result, peak concurrency
 * against the websites, peak browser contexts and memory. Exit code 1 if an invariant fails.
 *
 *   npm run test:scale              # or: npx tsx scripts/scale-run.ts --hostile
 */
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const HOSTILE = process.argv.includes('--hostile');
const QUANTITY = Number(process.env.SCALE_QUANTITY ?? 100);
const SITES = 150;
const DIR = 'tests/.tmp/scale';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

// ── deterministic data ──
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const SURNAMES = ['Kowalczyk', 'Wiśniewska', 'Wójcik', 'Kamińska', 'Lewandowski', 'Zielińska', 'Szymański', 'Woźniak', 'Dąbrowski', 'Kozłowska', 'Jankowski', 'Mazur', 'Kwiatkowska', 'Krawczyk', 'Piotrowski', 'Grabowska', 'Nowakowski', 'Pawłowska', 'Michalski', 'Adamczyk', 'Dudek', 'Zając', 'Wieczorek', 'Jabłońska', 'Król', 'Majewski', 'Olszewska', 'Jaworski', 'Wróbel', 'Malinowska'];
const PREFIXES = ['Stomatologia', 'Klinika Dentystyczna', 'Gabinet Stomatologiczny dr', 'Centrum Implantologii', 'Dental Studio', 'Ortodoncja'];
interface Biz { i: number; name: string; phone: string; lat: number; lng: number; street: string; site?: string; kind: 'outdated' | 'modern' | 'medium' | 'busy' | 'challenge' | 'stream' }
const businesses: Biz[] = [];
for (let i = 0; i < 180; i++) {
  const name = `${PREFIXES[i % PREFIXES.length]} ${SURNAMES[Math.floor(i / PREFIXES.length) % SURNAMES.length]}`;
  const hostileKind = HOSTILE && i < 9 ? (['busy', 'challenge', 'stream'] as const)[i % 3] : null;
  businesses.push({
    i,
    name,
    phone: `+48 22 ${600 + Math.floor(i / 100)} ${String(10 + (i % 90)).padStart(2, '0')} ${String(10 + ((i * 7) % 90)).padStart(2, '0')}`,
    lat: 52.16 + rand() * 0.14,
    lng: 20.92 + rand() * 0.2,
    street: `ul. Testowa ${i + 1}`,
    kind: hostileKind ?? (i % 3 === 0 ? 'outdated' : i % 3 === 1 ? 'modern' : 'medium'),
  });
}

// ── websites ──
let inFlight = 0;
let peakInFlight = 0;
const perSiteRequests = new Map<number, number>();
function html(b: Biz, path: string): string {
  const email = `recepcja@site${b.i}.example`;
  const tel = b.phone.replace(/\s/g, '');
  const nav = `<nav><a href="/">Start</a><a href="/oferta">Oferta</a><a href="/kontakt">Kontakt</a><a href="/o-nas">O nas</a></nav>`;
  if (b.kind === 'outdated') {
    return `<html><head><title>${b.name}</title></head><body><table width="900"><tr><td><font size="5">${b.name}</font><center>${nav}</center>
<p>Zapraszamy do naszego gabinetu. Telefon ${b.phone}. ${b.street}, Warszawa.</p><img src="/hero.jpg" width="900"><a href="/stara-strona">Aktualności</a>
<p>${'Leczenie zębów, protetyka, implanty. '.repeat(20)}</p></td></tr></table><footer>© 2015 ${b.name}</footer><script>var x = undefinedFunction();</script></body></html>`;
  }
  const head = `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${b.name} – stomatologia w Warszawie"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Dentist","name":"${b.name}","telephone":"${b.phone}"}</script>`;
  const cta = `<a href="/kontakt" style="display:inline-block;background:#0a4;color:#fff;padding:14px 22px;border-radius:6px">Umów wizytę</a>`;
  const hero = b.kind === 'modern' ? `<section style="height:420px"><h1>${b.name}</h1>${cta}</section>` : `<section style="height:1400px;background:#eee"><h1>${b.name}</h1><p>Witamy</p></section>${cta}`;
  const contact = path === '/kontakt' ? `<form action="/send" method="post"><label>E-mail <input type="email" name="e"></label><label>Wiadomość <textarea name="m"></textarea></label><button>Wyślij</button></form>` : '';
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8">${head}<title>${b.name} | Stomatolog Warszawa</title></head><body><header>${nav}<a href="tel:${tel}">${b.phone}</a></header>${hero}
<main><h2>Opinie pacjentów</h2><p>${'Profesjonalna opieka stomatologiczna dla całej rodziny. '.repeat(30)}</p>${contact}</main>
<footer>${b.kind === 'modern' ? `<a href="mailto:${email}">${email}</a>` : b.phone} · ${b.street}, Warszawa · © ${new Date().getFullYear()}</footer></body></html>`;
}
function handle(b: Biz, req: IncomingMessage, res: ServerResponse) {
  inFlight++;
  peakInFlight = Math.max(peakInFlight, inFlight);
  perSiteRequests.set(b.i, (perSiteRequests.get(b.i) ?? 0) + 1);
  res.on('close', () => inFlight--);
  const path = (req.url ?? '/').split('?')[0]!;
  if (path === '/robots.txt' || path.startsWith('/sitemap') || path.startsWith('/wp-sitemap') || path.includes('aios-check') || path === '/stara-strona') {
    res.writeHead(404).end('not found');
    return;
  }
  if (path.endsWith('.jpg')) {
    res.writeHead(200, { 'content-type': 'image/jpeg' }).end(Buffer.alloc(req.method === 'HEAD' ? 0 : 400_000, 1));
    return;
  }
  if (b.kind === 'challenge') {
    res.writeHead(403, { 'content-type': 'text/html', 'cf-ray': 'x', server: 'cloudflare' }).end('<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>');
    return;
  }
  if (b.kind === 'stream') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write(`<html><head><title>${b.name}</title></head><body>`);
    const t = setInterval(() => res.write('<p>…</p>'), 1000);
    req.on('close', () => clearInterval(t));
    return;
  }
  if (b.kind === 'busy') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><title>${b.name}</title></head><body><h1>${b.name}</h1><script>setTimeout(function(){for(;;){}}, 200)</script></body></html>`);
    return;
  }
  if (req.method === 'POST') {
    res.writeHead(200).end('ok');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(req.method === 'HEAD' ? undefined : html(b, path));
}
const servers: Server[] = [];
for (const b of businesses.slice(0, SITES)) {
  const s = createServer((req, res) => handle(b, req, res));
  const host = `127.0.3.${b.i + 1}`;
  await new Promise<void>((r) => s.listen(0, host, r));
  b.site = `http://${host}:${(s.address() as { port: number }).port}`;
  servers.push(s);
}

// ── provider mocks ──
const osmBiz = businesses.slice(0, 170);
const googleBiz = [...businesses.slice(0, 50), ...businesses.slice(170, 180)];
let providerCalls = 0;
const mock = createServer(async (req, res) => {
  providerCalls++;
  const url = new URL(req.url ?? '/', 'http://x');
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString();
  const json = (d: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(d));
  if (url.pathname === '/search') return json([{ osm_type: 'relation', osm_id: 336075, lat: '52.23', lon: '21.01', boundingbox: ['52.09', '52.37', '20.85', '21.27'], display_name: 'Warszawa, Polska', address: { city: 'Warszawa', country_code: 'pl' } }]);
  if (url.pathname === '/interpreter') {
    const q = new URLSearchParams(body).get('data') ?? '';
    if (q.includes('boundary')) return json({ elements: ['Śródmieście', 'Mokotów', 'Wola', 'Ochota', 'Żoliborz', 'Praga-Południe'].map((name, i) => ({ type: 'relation', id: 900 + i, tags: { name, admin_level: '9', boundary: 'administrative' } })) });
    return json({
      elements: osmBiz.map((b) => ({
        type: 'node',
        id: 1000 + b.i,
        lat: b.lat,
        lon: b.lng,
        timestamp: new Date(Date.now() - (b.i % 4) * 400 * 86_400_000).toISOString(),
        tags: { amenity: 'dentist', name: b.name, phone: b.phone, 'addr:street': 'Testowa', 'addr:housenumber': String(b.i + 1), 'addr:city': 'Warszawa', ...(b.site && b.i % 10 !== 9 ? { website: b.site } : {}) },
      })),
    });
  }
  if (url.pathname === '/v1/places:searchText') {
    const token = JSON.parse(body || '{}').pageToken as string | undefined;
    const pageNo = token ? Number(token) : 0;
    const slice = googleBiz.slice(pageNo * 20, pageNo * 20 + 20);
    return json({
      places: slice.map((b) => ({
        id: `g${b.i}`,
        displayName: { text: b.i % 2 ? `${b.name} Sp. z o.o.` : b.name },
        formattedAddress: `Testowa ${b.i + 1}, Warszawa, Poland`,
        location: { latitude: b.lat + 0.0002, longitude: b.lng },
        types: ['dentist'],
        internationalPhoneNumber: b.phone,
        websiteUri: b.site ? b.site.replace('http://', 'http://') : undefined,
        businessStatus: 'OPERATIONAL',
        rating: 4 + (b.i % 10) / 10,
        userRatingCount: 20 + b.i * 3,
      })),
      nextPageToken: pageNo < 2 ? String(pageNo + 1) : undefined,
    });
  }
  res.writeHead(404).end('{}');
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const mockUrl = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;

Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: `file:../${DIR}/scale.db`,
  DATA_DIR: `${DIR}/data`,
  ALLOW_PRIVATE_NETWORK_TARGETS: 'true',
  APP_ENCRYPTION_KEY: '0'.repeat(64),
  SCHEDULER_ENABLED: 'false',
  EMAIL_MX_CHECK: 'false',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  GOOGLE_PLACES_API_KEY: 'test-google-key',
  GOOGLE_PLACES_BASE_URL: mockUrl,
  NOMINATIM_BASE_URL: mockUrl,
  OVERPASS_BASE_URL: mockUrl,
  OSM_ENABLED: 'true',
  AI_PROVIDER: 'none',
  FOURSQUARE_API_KEY: '',
  YELP_API_KEY: '',
  BRAVE_SEARCH_API_KEY: '',
});
execSync('npx prisma db push --skip-generate --accept-data-loss', { stdio: 'ignore', env: process.env });
const { db, tuneDatabase } = await import('../src/db/client.js');
const { ensureDefaults } = await import('../src/engine/defaults.js');
const { syncSourceRows } = await import('../src/providers/registry.js');
const { enqueueJob } = await import('../src/jobs/queue.js');
const { Worker } = await import('../src/jobs/worker.js');
const { browserPool } = await import('../src/providers/website/browser-pool.js');
await tuneDatabase();
await ensureDefaults();
await syncSourceRows();

const params = { niche: 'stomatologia', location: 'Warszawa', country: 'Poland', service: 'website redesign', quantity: QUANTITY, analyzeWebsites: true, visualAi: false };
const campaign = await db().campaign.create({ data: { name: 'Scale', industry: 'dentist', location: 'Warszawa', country: 'Poland' } });
const sj = await db().searchJob.create({ data: { campaignId: campaign.id, params, progress: {}, counts: {}, sourcesUsed: {}, strategyLog: [] } });
await enqueueJob('search', { searchJobId: sj.id }, { searchJobId: sj.id, priority: 1 });

const worker = new Worker(2, 200);
const t0 = Date.now();
await worker.start();
let peakContexts = 0;
let peakRss = 0;
let firstContactReady: number | null = null;
let firstRanked: number | null = null;
const stageStart = new Map<string, number>();
let status = 'queued';
const LIMIT_MS = Number(process.env.SCALE_TIMEOUT_MS ?? 25 * 60_000);
while (Date.now() - t0 < LIMIT_MS) {
  const j = await db().searchJob.findUnique({ where: { id: sj.id }, select: { status: true, stage: true } });
  status = j!.status;
  if (!stageStart.has(j!.stage)) stageStart.set(j!.stage, Date.now() - t0);
  peakContexts = Math.max(peakContexts, browserPool().stats.inUse);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  if (firstRanked == null && (await db().lead.count({ where: { priority: { in: ['very_high', 'high', 'medium'] } } })) > 0) firstRanked = Date.now() - t0;
  if (firstContactReady == null && (await db().lead.count({ where: { stage: 'contact_ready' } })) > 0) firstContactReady = Date.now() - t0;
  if (['completed', 'failed', 'cancelled'].includes(status)) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const elapsed = Date.now() - t0;
const job = await db().searchJob.findUnique({ where: { id: sj.id } });
const companies = await db().company.count();
const leadsByPriority = await db().lead.groupBy({ by: ['priority'], _count: true });
const contactReady = await db().lead.count({ where: { stage: 'contact_ready' } });
const websites = await db().website.groupBy({ by: ['status'], _count: true });
const analyses = await db().analysis.groupBy({ by: ['status'], _count: true });
const maxPerSite = Math.max(...perSiteRequests.values());
const fmt = (ms: number | null) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);
console.log(JSON.stringify({
  hostile: HOSTILE,
  status,
  elapsed: fmt(elapsed),
  stages: Object.fromEntries([...stageStart.entries()].map(([k, v]) => [k, fmt(v)])),
  firstRankedLead: fmt(firstRanked),
  firstContactReady: fmt(firstContactReady),
  counts: job?.counts,
  companies,
  expectedCompanies: 180,
  contactReady,
  leadsByPriority: Object.fromEntries(leadsByPriority.map((p) => [p.priority, p._count])),
  websites: Object.fromEntries(websites.map((w) => [w.status, w._count])),
  analyses: Object.fromEntries(analyses.map((a) => [a.status, a._count])),
  providerCalls,
  peakConcurrentRequestsToSites: peakInFlight,
  maxRequestsToOneSite: maxPerSite,
  peakBrowserContexts: peakContexts,
  peakRssMb: Math.round(peakRss / 1e6),
}, null, 2));
await worker.stop();
await db().$disconnect();
for (const s of [...servers, mock]) {
  s.closeAllConnections();
  s.close();
}
const ok = status === 'completed' && companies === 180;
process.exit(ok ? 0 : 1);
