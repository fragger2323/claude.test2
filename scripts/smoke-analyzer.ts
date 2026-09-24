// Dev smoke test: analyse the fixture sites with the real browser and print findings.
import { startFixtureSites } from '../tests/support/fixture-sites.js';
import { analyzeWebsite } from '../src/providers/website/analyzer.js';
import { buildFindings } from '../src/engine/analysis/checks.js';
import { closeBrowserPool } from '../src/providers/website/browser-pool.js';
import { contactsFromAnalysis } from '../src/engine/contacts/contact-discovery.js';

const sites = await startFixtureSites();
try {
  for (const [name, url] of Object.entries(sites.urls)) {
    const t = Date.now();
    const raw = await analyzeWebsite(url, { analysisId: `smoke-${name}`, screenshotDir: 'tests/.tmp/screens' });
    const f = buildFindings(raw);
    console.log(`\n=== ${name} ${url} status=${raw.status} ${Date.now() - t}ms errors=${JSON.stringify(raw.errors)}`);
    for (const x of f) console.log(`${x.polarity === 'positive' ? '+' : x.polarity === 'neutral' ? '·' : '-'} [${x.severity}] ${x.code}: ${x.title}`);
    console.log('contacts:', contactsFromAnalysis(raw, 'PL').map((c) => `${c.type}:${c.value}`).join(', '));
    console.log('pages:', raw.pages.map((p) => `${p.kind}:${p.url}:${p.ok}`).join(', '));
  }
} finally {
  await closeBrowserPool();
  await sites.close();
}
