import type { Logger } from 'pino';
import { z } from 'zod';
import { PROBLEM_TAG_LABELS, PRIORITY_LABELS, type EvidenceItem, type Priority, type ProblemTag } from '../../domain/types.js';
import type { AiProvider } from '../../providers/types.js';
import { langFor, type OutreachLang } from './phrases.js';

/**
 * Personalised website audit. The structure and every finding come from stored evidence;
 * optional AI only rewrites summary prose (and translates) using the same facts.
 */

export interface AuditProblem {
  findingId: string;
  title: string;
  detail: string;
  category: string;
  severity: string;
  kind: string;
  confidence: string;
  evidence: EvidenceItem[];
  pageUrl: string | null;
  viewport: string | null;
  problemTags: ProblemTag[];
}

export interface AuditContent {
  language: OutreachLang;
  title: string;
  company: { name: string; website: string | null; city: string | null; industry: string | null };
  generatedAt: string;
  analysisAt: string | null;
  generator: 'template' | 'ai';
  executiveSummary: string[];
  working: Array<{ title: string; detail: string }>;
  problems: AuditProblem[];
  businessRelevance: string[];
  improvements: Array<{ title: string; detail: string; findingIds: string[] }>;
  recommendedService: { primary: { name: string; reason: string } | null; secondary: { name: string; reason: string } | null; notRecommended: Array<{ name: string; reason: string }> };
  scope: string[];
  priority: { level: Priority; reasons: string[] };
  screenshots: Array<{ id: string; viewport: string; kind: string }>;
  methodology: string[];
  limitations: string[];
}

export interface AuditInput {
  company: AuditContent['company'];
  analysis: { at: Date | null; pages: number; lighthouseRan: boolean; aiStatus: string; status: string } | null;
  websiteStatus: string;
  findings: Array<AuditProblem & { polarity: string }>;
  services: { primary: { name: string; slug: string; reasons: string[] } | null; secondary: { name: string; slug: string; reasons: string[] } | null; doNot: Array<{ name: string; reasons: string[] }> };
  priority: { level: Priority; reasons: string[] };
  interpretations: string[];
  screenshots: Array<{ id: string; viewport: string; kind: string }>;
  language?: string;
}

const HEADINGS: Record<OutreachLang, Record<string, string>> = {
  en: { title: 'Website audit', summary: 'Executive summary', working: 'What is working', problems: 'Problems found', evidence: 'Evidence', relevance: 'Business relevance', improvements: 'Recommended improvements', service: 'Recommended service', scope: 'Potential project scope', priority: 'Priority', method: 'Methodology', limits: 'Limitations', notrec: 'Not recommended', screens: 'Screenshots' },
  pl: { title: 'Audyt strony internetowej', summary: 'Podsumowanie', working: 'Co działa dobrze', problems: 'Wykryte problemy', evidence: 'Dowody', relevance: 'Znaczenie dla biznesu', improvements: 'Rekomendowane usprawnienia', service: 'Rekomendowana usługa', scope: 'Potencjalny zakres projektu', priority: 'Priorytet', method: 'Metodologia', limits: 'Ograniczenia', notrec: 'Nierekomendowane', screens: 'Zrzuty ekranu' },
  ru: { title: 'Аудит сайта', summary: 'Краткое резюме', working: 'Что работает хорошо', problems: 'Найденные проблемы', evidence: 'Доказательства', relevance: 'Значение для бизнеса', improvements: 'Рекомендуемые улучшения', service: 'Рекомендуемая услуга', scope: 'Возможный объём проекта', priority: 'Приоритет', method: 'Методология', limits: 'Ограничения', notrec: 'Не рекомендуется', screens: 'Скриншоты' },
  uk: { title: 'Аудит сайту', summary: 'Коротке резюме', working: 'Що працює добре', problems: 'Знайдені проблеми', evidence: 'Докази', relevance: 'Значення для бізнесу', improvements: 'Рекомендовані покращення', service: 'Рекомендована послуга', scope: 'Можливий обсяг проєкту', priority: 'Пріоритет', method: 'Методологія', limits: 'Обмеження', notrec: 'Не рекомендується', screens: 'Скриншоти' },
  de: { title: 'Website-Audit', summary: 'Zusammenfassung', working: 'Was gut funktioniert', problems: 'Gefundene Probleme', evidence: 'Belege', relevance: 'Geschäftliche Relevanz', improvements: 'Empfohlene Verbesserungen', service: 'Empfohlene Leistung', scope: 'Möglicher Projektumfang', priority: 'Priorität', method: 'Methodik', limits: 'Einschränkungen', notrec: 'Nicht empfohlen', screens: 'Screenshots' },
};

const IMPROVEMENTS: Array<{ tags: ProblemTag[]; title: string; detail: string }> = [
  { tags: ['mobile_experience', 'responsive_bugs'], title: 'Make the site work properly on phones', detail: 'Declare a responsive viewport, fix elements wider than the screen, and use readable text and comfortably sized tap targets.' },
  { tags: ['weak_cta', 'conversion_path', 'landing_structure'], title: 'Put one clear next step on the first screen', detail: 'Place a single primary action (e.g. “Book an appointment”) in the first screen on desktop and mobile, and repeat it after key sections.' },
  { tags: ['contact_path'], title: 'Make contacting easy from every page', detail: 'Add contact details to the header/menu and make phone numbers tappable (tel: links).' },
  { tags: ['performance', 'heavy_assets'], title: 'Reduce page weight and speed up loading', detail: 'Resize and compress images (WebP/AVIF, responsive sizes), defer non-critical scripts, lazy-load below-the-fold media.' },
  { tags: ['seo_foundation', 'local_seo'], title: 'Fix the SEO foundation', detail: 'Unique title and meta description, one H1, LocalBusiness structured data, XML sitemap and correct status codes.' },
  { tags: ['accessibility'], title: 'Improve accessibility', detail: 'Alt text for meaningful images, labelled form fields, visible keyboard focus and sufficient colour contrast.' },
  { tags: ['technical_errors', 'broken_links'], title: 'Fix errors and broken links', detail: 'Resolve the JavaScript errors, failed resources and broken links recorded during the scan.' },
  { tags: ['security_https'], title: 'Serve everything over HTTPS', detail: 'Enable HTTPS for the whole site and redirect all HTTP requests to HTTPS.' },
  { tags: ['outdated_design', 'visual_quality', 'branding', 'imagery'], title: 'Refresh the visual design', detail: 'Modern typography and spacing, consistent components, and imagery that reflects the quality of the service.' },
  { tags: ['trust_signals'], title: 'Show proof near decisions', detail: 'Reviews, certificates, team credentials or case examples close to the call-to-action.' },
  { tags: ['service_presentation', 'navigation_ux'], title: 'Present services clearly', detail: 'A headline stating what you do and where, a service overview with links, and a short, clear navigation.' },
  { tags: ['maintenance'], title: 'Update outdated components', detail: 'Update the CMS core, plugins and libraries; set up monitoring and backups.' },
  { tags: ['forms'], title: 'Simplify the enquiry form', detail: 'Keep only the fields needed for a first reply and label each field.' },
  { tags: ['no_website'], title: 'Create an official website', detail: 'A fast, mobile-friendly site with services, location, contact options and booking.' },
];

const SCOPES: Record<string, string[]> = {
  'website-redesign': ['UX review and new information architecture', 'Responsive design system (desktop/tablet/mobile)', 'Rebuild of key templates (home, services, contact)', 'Content migration and SEO-safe redirects', 'Performance and accessibility pass'],
  'premium-website-design': ['Brand-led art direction and custom design', 'Photography/imagery direction', 'Custom-built responsive frontend', 'CMS for self-editing', 'Launch with SEO and analytics setup'],
  'new-business-website': ['Site structure (home, services, about, contact)', 'Responsive design and build', 'Contact form, click-to-call and map', 'Basic SEO and Google Business Profile link-up'],
  'landing-page': ['One conversion-focused page', 'Copy structure and CTA placement', 'Form/booking integration', 'Analytics events'],
  'mobile-optimization': ['Responsive fixes for the key templates', 'Tap-target, typography and menu improvements', 'Click-to-call and sticky CTA on mobile'],
  'performance-optimization': ['Image pipeline (resize/compress/modern formats)', 'Script deferral and third-party review', 'Caching/compression settings', 'Before/after lab measurements'],
  'seo-basics': ['Titles, descriptions, headings', 'Structured data (LocalBusiness)', 'Sitemap/robots/status-code fixes', 'Image alt text'],
  'ux-improvement': ['CTA hierarchy and placement', 'Contact paths and navigation clean-up', 'Form simplification', 'Trust elements near decisions'],
  'website-maintenance': ['Updates and security patches', 'Uptime/error monitoring', 'Backups', 'Monthly small fixes'],
  'bug-fixing': ['Fix recorded JavaScript errors', 'Repair broken links/resources', 'Form checks'],
  'wordpress-development': ['Core/theme/plugin updates', 'Performance tuning', 'Error fixes and hardening'],
};

export function buildAudit(i: AuditInput): AuditContent {
  const lang = langFor(i.language);
  const negative = i.findings.filter((f) => f.polarity === 'negative');
  const positive = i.findings.filter((f) => f.polarity === 'positive');
  const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const problems = [...negative].sort((a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5) || (a.kind === 'ai_observation' ? 1 : -1));
  const high = negative.filter((f) => f.severity === 'high' || f.severity === 'critical').length;
  const tagWeights = new Map<ProblemTag, string[]>();
  for (const f of negative) for (const t of f.problemTags) if (!t.startsWith('platform_')) tagWeights.set(t, [...(tagWeights.get(t) ?? []), f.findingId]);
  if (i.websiteStatus === 'not_found') tagWeights.set('no_website', []);
  const topTags = [...tagWeights.entries()].sort((a, b) => b[1].length - a[1].length);
  const improvements = IMPROVEMENTS.filter((imp) => imp.tags.some((t) => tagWeights.has(t)))
    .map((imp) => ({ title: imp.title, detail: imp.detail, findingIds: [...new Set(imp.tags.flatMap((t) => tagWeights.get(t) ?? []))] }))
    .sort((a, b) => b.findingIds.length - a.findingIds.length)
    .slice(0, 7);

  const date = i.analysis?.at ? i.analysis.at.toISOString().slice(0, 10) : null;
  const executiveSummary: string[] = [];
  if (i.websiteStatus === 'not_found') {
    executiveSummary.push(`No official website was found for ${i.company.name}; the business is represented only by third-party listings.`);
  } else {
    executiveSummary.push(`${i.company.name}'s website${i.company.website ? ` (${i.company.website})` : ''} was analysed live${date ? ` on ${date}` : ''} on desktop, tablet and mobile (${i.analysis?.pages ?? 1} page(s)).`);
    executiveSummary.push(`We recorded ${negative.length} issue(s)${high ? `, ${high} of them high-severity` : ''}, and ${positive.length} thing(s) that work well.`);
  }
  if (topTags[0]) executiveSummary.push(`Main area for improvement: ${PROBLEM_TAG_LABELS[topTags[0][0]].toLowerCase()}.`);
  if (i.services.primary) executiveSummary.push(`Suggested starting point: ${i.services.primary.name}.`);

  const methodology = [
    'Automated live analysis with a real Chromium browser at 1440px (desktop), 820px (tablet) and 390px (mobile) widths.',
    'HTTP checks (HTTPS, redirects, headers, robots.txt, sitemap), link checks on analysed pages, and in-page measurements (layout, headings, forms, contrast, keyboard focus, network weight).',
    'Performance numbers are lab measurements from a single page load, not real-user data.',
  ];
  if (i.analysis?.aiStatus === 'completed') methodology.push('Visual observations marked “AI observation” are subjective assessments of screenshots and are shown separately from measured facts.');
  const limitations = [
    'Only publicly accessible pages were analysed; pages behind logins or not linked from the homepage were not checked.',
    'Findings describe what was observed at the time of analysis; the website may have changed since.',
    'Business impact (lost enquiries, revenue) was not measured and is not claimed.',
  ];
  if (!i.analysis?.lighthouseRan) limitations.push('Lighthouse was not run; no Lighthouse/PageSpeed scores are reported.');

  const primaryScope = i.services.primary ? SCOPES[i.services.primary.slug] ?? [] : [];
  return {
    language: lang,
    title: `${HEADINGS[lang].title}: ${i.company.name}`,
    company: i.company,
    generatedAt: new Date().toISOString(),
    analysisAt: i.analysis?.at?.toISOString() ?? null,
    generator: 'template',
    executiveSummary,
    working: positive.slice(0, 8).map((f) => ({ title: f.title, detail: f.detail })),
    problems: problems.slice(0, 25).map(({ polarity: _p, ...rest }) => rest),
    businessRelevance: i.interpretations.length ? i.interpretations : ['The observations above describe the visitor experience; their effect on enquiries was not measured.'],
    improvements,
    recommendedService: {
      primary: i.services.primary ? { name: i.services.primary.name, reason: i.services.primary.reasons.slice(0, 2).join('; ') } : null,
      secondary: i.services.secondary ? { name: i.services.secondary.name, reason: i.services.secondary.reasons.slice(0, 2).join('; ') } : null,
      notRecommended: i.services.doNot.map((d) => ({ name: d.name, reason: d.reasons.join(' ') })),
    },
    scope: primaryScope,
    priority: { level: i.priority.level, reasons: i.priority.reasons.slice(0, 4) },
    screenshots: i.screenshots.filter((s) => s.kind === 'viewport' && (s.viewport === 'desktop' || s.viewport === 'mobile')),
    methodology,
    limitations,
  };
}

const AiAuditSchema = z.object({
  executiveSummary: z.array(z.string()),
  businessRelevance: z.array(z.string()),
  improvements: z.array(z.object({ title: z.string(), detail: z.string() })),
  problems: z.array(z.object({ id: z.string(), title: z.string(), detail: z.string() })),
  working: z.array(z.object({ title: z.string(), detail: z.string() })),
});

export const AUDIT_SYSTEM_PROMPT = `You rewrite a website audit for a small business owner. Rules:
- Use only the facts given. Keep every problem, number and conclusion exactly as stated; do not add new ones.
- Neutral, clear, non-technical language. Hedge interpretations ("may", "likely") — never claim lost revenue or customers, never promise outcomes.
- Keep the same number of items and the same ids for problems; translate/rephrase titles and details faithfully.
- Write in the requested language.`;

export async function aiPolishAudit(ai: AiProvider, audit: AuditContent, log: Logger): Promise<AuditContent> {
  const facts = {
    language: audit.language,
    company: audit.company,
    executiveSummary: audit.executiveSummary,
    businessRelevance: audit.businessRelevance,
    improvements: audit.improvements.map((x) => ({ title: x.title, detail: x.detail })),
    problems: audit.problems.map((p) => ({ id: p.findingId, title: p.title, detail: p.detail })),
    working: audit.working,
  };
  const res = await ai.generateJson(
    { task: 'audit', system: AUDIT_SYSTEM_PROMPT, prompt: `Audit facts (JSON):\n${JSON.stringify(facts, null, 2)}`, schema: AiAuditSchema, maxTokens: 16000 },
    { log },
  );
  const d = res.data;
  const byId = new Map(d.problems.map((p) => [p.id, p]));
  return {
    ...audit,
    generator: 'ai',
    executiveSummary: d.executiveSummary.length ? d.executiveSummary : audit.executiveSummary,
    businessRelevance: d.businessRelevance.length ? d.businessRelevance : audit.businessRelevance,
    improvements: audit.improvements.map((imp, idx) => ({ ...imp, title: d.improvements[idx]?.title ?? imp.title, detail: d.improvements[idx]?.detail ?? imp.detail })),
    problems: audit.problems.map((p) => ({ ...p, title: byId.get(p.findingId)?.title ?? p.title, detail: byId.get(p.findingId)?.detail ?? p.detail })),
    working: d.working.length === audit.working.length ? d.working : audit.working,
  };
}

// ───────────────────────── rendering ─────────────────────────

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function evidenceText(e: EvidenceItem): string {
  const parts = [e.label, e.excerpt, e.selector, e.value != null ? `${e.value}${e.unit ? ` ${e.unit}` : ''}` : null, e.type !== 'screenshot' ? e.ref : null].filter(Boolean);
  return `${e.type}: ${parts.join(' · ')}`;
}

export function auditToMarkdown(a: AuditContent): string {
  const h = HEADINGS[a.language];
  const lines: string[] = [`# ${a.title}`, '', `${a.company.website ?? ''}${a.analysisAt ? ` · ${a.analysisAt.slice(0, 10)}` : ''}`, ''];
  lines.push(`## ${h.summary}`, ...a.executiveSummary.map((s) => `- ${s}`), '');
  if (a.working.length) lines.push(`## ${h.working}`, ...a.working.map((w) => `- **${w.title}** — ${w.detail}`), '');
  lines.push(`## ${h.problems}`);
  for (const p of a.problems) {
    lines.push(`### ${p.title}`, `*${p.category} · ${p.severity} · ${p.kind === 'ai_observation' ? 'AI observation (subjective)' : p.kind} · confidence ${p.confidence}*`, '', p.detail, '');
    const ev = p.evidence.filter((e) => e.type !== 'screenshot').slice(0, 4);
    if (ev.length) lines.push(`${h.evidence}:`, ...ev.map((e) => `- ${evidenceText(e)}`), '');
  }
  lines.push(`## ${h.relevance}`, ...a.businessRelevance.map((s) => `- ${s}`), '');
  lines.push(`## ${h.improvements}`, ...a.improvements.map((x) => `- **${x.title}** — ${x.detail}`), '');
  lines.push(`## ${h.service}`);
  if (a.recommendedService.primary) lines.push(`- **${a.recommendedService.primary.name}** — ${a.recommendedService.primary.reason}`);
  if (a.recommendedService.secondary) lines.push(`- ${a.recommendedService.secondary.name} — ${a.recommendedService.secondary.reason}`);
  if (a.recommendedService.notRecommended.length) lines.push('', `${h.notrec}:`, ...a.recommendedService.notRecommended.map((n) => `- ${n.name} — ${n.reason}`));
  lines.push('');
  if (a.scope.length) lines.push(`## ${h.scope}`, ...a.scope.map((s) => `- ${s}`), '');
  lines.push(`## ${h.priority}`, `**${PRIORITY_LABELS[a.priority.level]}**`, ...a.priority.reasons.map((r) => `- ${r}`), '');
  lines.push(`## ${h.method}`, ...a.methodology.map((m) => `- ${m}`), '', `## ${h.limits}`, ...a.limitations.map((m) => `- ${m}`), '');
  return lines.join('\n');
}

/** Client-facing HTML (internal-only sections such as lead priority are omitted unless `internal`). */
export function auditToHtml(a: AuditContent, images: Record<string, string> = {}, opts: { internal?: boolean } = {}): string {
  const h = HEADINGS[a.language];
  const sevColor: Record<string, string> = { critical: '#b42318', high: '#c4320a', medium: '#b54708', low: '#475467', info: '#475467' };
  const problems = a.problems
    .map(
      (p) => `<article class="problem"><h3>${esc(p.title)}</h3><p class="meta"><span class="chip" style="color:${sevColor[p.severity] ?? '#475467'}">${esc(p.severity)}</span> ${esc(p.category)} · ${p.kind === 'ai_observation' ? 'AI observation (subjective)' : esc(p.kind)} · confidence ${esc(p.confidence)}</p><p>${esc(p.detail)}</p>${
        p.evidence.filter((e) => e.type !== 'screenshot').length
          ? `<ul class="ev">${p.evidence
              .filter((e) => e.type !== 'screenshot')
              .slice(0, 4)
              .map((e) => `<li>${esc(evidenceText(e))}</li>`)
              .join('')}</ul>`
          : ''
      }</article>`,
    )
    .join('');
  const shots = a.screenshots
    .filter((s) => images[s.id])
    .map((s) => `<figure><img src="${images[s.id]}" alt="${esc(s.viewport)} screenshot"><figcaption>${esc(s.viewport)}</figcaption></figure>`)
    .join('');
  const list = (items: string[]) => `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  return `<!doctype html><html lang="${a.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(a.title)}</title>
<style>
body{font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#101828;max-width:860px;margin:32px auto;padding:0 20px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 10px;padding-bottom:6px;border-bottom:1px solid #eaecf0}h3{font-size:15px;margin:0 0 4px}
.sub{color:#475467;margin:0 0 20px}.problem{border:1px solid #eaecf0;border-radius:8px;padding:12px 14px;margin:10px 0;break-inside:avoid}
.meta{color:#475467;font-size:12px;margin:0 0 6px}.chip{font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.03em}
.ev{font-size:12px;color:#344054;margin:6px 0 0;padding-left:18px}.ev li{word-break:break-word}
.shots{display:flex;gap:16px;align-items:flex-start}.shots figure{margin:0;flex:1}.shots img{width:100%;border:1px solid #eaecf0;border-radius:6px}
.shots figure:nth-child(2){flex:0 0 28%}figcaption{font-size:12px;color:#475467}
.prio{font-weight:700}footer{margin-top:40px;color:#667085;font-size:12px}
@media print{body{margin:0}a{color:inherit}}
</style></head><body>
<h1>${esc(a.title)}</h1><p class="sub">${esc(a.company.website ?? '')}${a.analysisAt ? ` · ${esc(a.analysisAt.slice(0, 10))}` : ''}${a.company.city ? ` · ${esc(a.company.city)}` : ''}</p>
<h2>${h.summary}</h2>${list(a.executiveSummary)}
${shots ? `<h2>${h.screens}</h2><div class="shots">${shots}</div>` : ''}
${a.working.length ? `<h2>${h.working}</h2><ul>${a.working.map((w) => `<li><strong>${esc(w.title)}</strong> — ${esc(w.detail)}</li>`).join('')}</ul>` : ''}
<h2>${h.problems}</h2>${problems || '<p>—</p>'}
<h2>${h.relevance}</h2>${list(a.businessRelevance)}
<h2>${h.improvements}</h2><ul>${a.improvements.map((x) => `<li><strong>${esc(x.title)}</strong> — ${esc(x.detail)}</li>`).join('')}</ul>
<h2>${h.service}</h2><ul>${a.recommendedService.primary ? `<li><strong>${esc(a.recommendedService.primary.name)}</strong> — ${esc(a.recommendedService.primary.reason)}</li>` : ''}${a.recommendedService.secondary ? `<li>${esc(a.recommendedService.secondary.name)} — ${esc(a.recommendedService.secondary.reason)}</li>` : ''}</ul>
${a.scope.length ? `<h2>${h.scope}</h2>${list(a.scope)}` : ''}
${opts.internal ? `<h2>${h.priority}</h2><p class="prio">${esc(PRIORITY_LABELS[a.priority.level])}</p>${list(a.priority.reasons)}` : ''}
<h2>${h.method}</h2>${list(a.methodology)}<h2>${h.limits}</h2>${list(a.limitations)}
<footer>Generated ${esc(a.generatedAt.slice(0, 10))}${a.generator === 'ai' ? ' · summary text written with AI from the recorded facts' : ''}</footer>
</body></html>`;
}
