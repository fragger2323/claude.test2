import type { Logger } from 'pino';
import { z } from 'zod';
import type { AiProvider } from '../../providers/types.js';
import { lintOutreach, type LintIssue } from './lint.js';
import { langFor, renderPhrase, type OutreachLang } from './phrases.js';

/**
 * Personalised outreach drafts. Drafts only — the user edits and sends manually.
 * Template mode is deterministic and uses only verified, high-confidence observations.
 * AI mode (optional) writes a draft from the same facts under strict rules, then is linted.
 */
export const TONES = ['friendly', 'professional', 'premium', 'ultra_short'] as const;
export type Tone = (typeof TONES)[number];

export interface OutreachFacts {
  company: string;
  industry: string | null;
  city: string | null;
  website: string | null;
  contactName: string | null;
  hasWebsite: boolean;
  observations: Array<{ findingId: string; code: string; title: string; detail: string; vars?: Record<string, string> }>;
  service: { name: string; slug: string } | null;
  portfolio: { name: string; url: string | null; reason: string } | null;
  sender: { name: string | null; studio: string | null; website: string | null; role: string | null };
}

export interface OutreachDraft {
  subject: string;
  body: string;
  language: OutreachLang;
  tone: Tone;
  generator: 'template' | 'ai';
  usedFindingIds: string[];
  portfolioUsed: boolean;
  lint: LintIssue[];
  aiModel?: string;
  note?: string;
}

interface Copy {
  subject: Record<Tone, string>;
  greet: (name: string | null) => string;
  introFriendly: (f: OutreachFacts) => string;
  introPro: (f: OutreachFacts) => string;
  introPremium: (f: OutreachFacts) => string;
  noticed: (obs: string[]) => string;
  portfolio: (p: NonNullable<OutreachFacts['portfolio']>) => string;
  service: (s: string) => string;
  offer: string;
  offerShort: string;
  question: string;
  optOut: string;
  signoff: string;
}

const joinObs = (obs: string[], and: string) => (obs.length <= 1 ? obs[0] ?? '' : `${obs.slice(0, -1).join('; ')} ${and} ${obs[obs.length - 1]}`);
const sender = (f: OutreachFacts) => f.sender.name ?? f.sender.studio ?? '';
const where = (f: OutreachFacts, prep: string) => (f.city ? ` ${prep} ${f.city}` : '');
/** City in parentheses — avoids wrong grammatical case for Slavic languages. */
const paren = (f: OutreachFacts) => (f.city ? ` (${f.city})` : '');

const COPY: Record<OutreachLang, Copy> = {
  en: {
    subject: { friendly: 'Quick note about {company}’s website', professional: '{company} — a few observations about your website', premium: '{company}: website review', ultra_short: '{company} website' },
    greet: (n) => (n ? `Hello ${n},` : 'Hello,'),
    introFriendly: (f) => `I'm ${sender(f)}${f.sender.studio && f.sender.name ? ` from ${f.sender.studio}` : ''}. I came across ${f.company} while looking at ${f.industry ?? 'local business'} websites${where(f, 'in')}.`,
    introPro: (f) => `My name is ${sender(f)}${f.sender.studio && f.sender.name ? `, ${f.sender.role ?? 'I run'} ${f.sender.role ? 'at ' : ''}${f.sender.studio}` : ''}. I reviewed the ${f.company} website as part of research on ${f.industry ?? 'businesses'}${where(f, 'in')}.`,
    introPremium: (f) => `I lead ${f.sender.studio ?? 'a design studio'}, working with ${f.industry ?? 'service'} brands on their digital presence. I took a closer look at ${f.company}.`,
    noticed: (obs) => (obs.length === 1 ? `One thing stood out: ${obs[0]}.` : `A few things stood out: ${joinObs(obs, 'and')}.`),
    portfolio: (p) => `We recently worked on a similar project — ${p.name}${p.url ? ` (${p.url})` : ''} — in case it's a useful reference.`,
    service: (s) => `This is the kind of work we do (${s.toLowerCase()}).`,
    offer: "If it's useful, I can send a short audit with screenshots and specific fixes — no obligation.",
    offerShort: 'Happy to send a short audit with screenshots if useful.',
    question: 'Would that be helpful?',
    optOut: "If this isn't relevant, just let me know and I won't write again.",
    signoff: 'Best regards,',
  },
  pl: {
    subject: { friendly: 'Krótka uwaga o stronie {company}', professional: '{company} — kilka obserwacji dotyczących strony', premium: '{company}: przegląd strony internetowej', ultra_short: 'Strona {company}' },
    greet: (n) => (n ? `Dzień dobry, ${n},` : 'Dzień dobry,'),
    introFriendly: (f) => `Nazywam się ${sender(f)}${f.sender.studio && f.sender.name ? ` (${f.sender.studio})` : ''}. Przeglądamy strony firm ${f.industry ? `z branży „${f.industry}”` : 'lokalnych'}${paren(f)} — jedną z nich jest ${f.company}.`,
    introPro: (f) => `Nazywam się ${sender(f)}${f.sender.studio && f.sender.name ? ` i prowadzę studio ${f.sender.studio}` : ''}. W ramach przeglądu firm ${f.industry ? `z branży „${f.industry}”` : 'lokalnych'}${paren(f)} przyjrzeliśmy się stronie ${f.company}.`,
    introPremium: (f) => `Prowadzę ${f.sender.studio ? `studio ${f.sender.studio}` : 'studio projektowe'} i pracuję z markami ${f.industry ? `z branży „${f.industry}”` : 'usługowymi'} nad ich obecnością w sieci. Przyjrzeliśmy się bliżej stronie ${f.company}.`,
    noticed: (obs) => (obs.length === 1 ? `Zwróciło moją uwagę, że ${obs[0]}.` : `Zwróciło moją uwagę kilka rzeczy: ${joinObs(obs, 'oraz')}.`),
    portfolio: (p) => `Niedawno zrealizowaliśmy podobny projekt — ${p.name}${p.url ? ` (${p.url})` : ''} — może posłużyć jako punkt odniesienia.`,
    service: (s) => `Tym właśnie się zajmujemy (${s.toLowerCase()}).`,
    offer: 'Jeśli to przydatne, mogę przesłać krótki audyt ze zrzutami ekranu i konkretnymi poprawkami — bez zobowiązań.',
    offerShort: 'Chętnie prześlę krótki audyt ze zrzutami ekranu.',
    question: 'Czy byłoby to pomocne?',
    optOut: 'Jeśli temat jest nieaktualny, proszę dać znać — nie będę więcej pisać.',
    signoff: 'Pozdrawiam,',
  },
  ru: {
    subject: { friendly: 'Небольшое замечание о сайте {company}', professional: '{company} — несколько наблюдений по сайту', premium: '{company}: обзор сайта', ultra_short: 'Сайт {company}' },
    greet: (n) => (n ? `Здравствуйте, ${n}!` : 'Здравствуйте!'),
    introFriendly: (f) => `Меня зовут ${sender(f)}${f.sender.studio && f.sender.name ? ` (${f.sender.studio})` : ''}. Мы просматриваем сайты компаний ${f.industry ? `в сфере «${f.industry}»` : 'из вашего региона'}${paren(f)} — среди них ${f.company}.`,
    introPro: (f) => `Меня зовут ${sender(f)}${f.sender.studio && f.sender.name ? `, я руковожу студией ${f.sender.studio}` : ''}. В рамках обзора компаний ${f.industry ? `в сфере «${f.industry}»` : 'вашего региона'}${paren(f)} мы изучили сайт ${f.company}.`,
    introPremium: (f) => `Я руковожу ${f.sender.studio ? `студией ${f.sender.studio}` : 'дизайн-студией'} и работаю с брендами ${f.industry ? `в сфере «${f.industry}»` : 'из сферы услуг'} над их цифровым присутствием. Мы внимательно посмотрели сайт ${f.company}.`,
    noticed: (obs) => (obs.length === 1 ? `Мне бросилось в глаза, что ${obs[0]}.` : `Мне бросилось в глаза несколько моментов: ${joinObs(obs, 'и')}.`),
    portfolio: (p) => `Недавно мы сделали похожий проект — ${p.name}${p.url ? ` (${p.url})` : ''} — возможно, он будет полезен как пример.`,
    service: (s) => `Это как раз то, чем мы занимаемся (${s.toLowerCase()}).`,
    offer: 'Если это полезно, могу прислать короткий аудит со скриншотами и конкретными рекомендациями — без обязательств.',
    offerShort: 'Могу прислать короткий аудит со скриншотами.',
    question: 'Было бы это полезно?',
    optOut: 'Если тема неактуальна, просто дайте знать — я больше не буду писать.',
    signoff: 'С уважением,',
  },
  uk: {
    subject: { friendly: 'Коротко про сайт {company}', professional: '{company} — кілька спостережень щодо сайту', premium: '{company}: огляд сайту', ultra_short: 'Сайт {company}' },
    greet: (n) => (n ? `Добрий день, ${n}!` : 'Добрий день!'),
    introFriendly: (f) => `Мене звати ${sender(f)}${f.sender.studio && f.sender.name ? ` (${f.sender.studio})` : ''}. Ми переглядаємо сайти компаній ${f.industry ? `у сфері «${f.industry}»` : 'з вашого регіону'}${paren(f)} — серед них ${f.company}.`,
    introPro: (f) => `Мене звати ${sender(f)}${f.sender.studio && f.sender.name ? `, я керую студією ${f.sender.studio}` : ''}. У межах огляду компаній ${f.industry ? `у сфері «${f.industry}»` : 'вашого регіону'}${paren(f)} ми переглянули сайт ${f.company}.`,
    introPremium: (f) => `Я керую ${f.sender.studio ? `студією ${f.sender.studio}` : 'дизайн-студією'} і працюю з брендами ${f.industry ? `у сфері «${f.industry}»` : 'зі сфери послуг'} над їхньою присутністю в мережі. Ми уважно переглянули сайт ${f.company}.`,
    noticed: (obs) => (obs.length === 1 ? `Мені впало в око, що ${obs[0]}.` : `Мені впало в око кілька моментів: ${joinObs(obs, 'і')}.`),
    portfolio: (p) => `Нещодавно ми зробили схожий проєкт — ${p.name}${p.url ? ` (${p.url})` : ''} — можливо, він стане в пригоді як приклад.`,
    service: (s) => `Саме цим ми й займаємося (${s.toLowerCase()}).`,
    offer: 'Якщо це корисно, можу надіслати короткий аудит зі скриншотами та конкретними рекомендаціями — без зобов’язань.',
    offerShort: 'Можу надіслати короткий аудит зі скриншотами.',
    question: 'Чи було б це корисно?',
    optOut: 'Якщо тема неактуальна, просто дайте знати — я більше не писатиму.',
    signoff: 'З повагою,',
  },
  de: {
    subject: { friendly: 'Kurzer Hinweis zur Website von {company}', professional: '{company} – einige Beobachtungen zu Ihrer Website', premium: '{company}: Website-Review', ultra_short: 'Website {company}' },
    greet: (n) => (n ? `Guten Tag ${n},` : 'Guten Tag,'),
    introFriendly: (f) => `ich bin ${sender(f)}${f.sender.studio && f.sender.name ? ` von ${f.sender.studio}` : ''}. Beim Durchsehen von Websites ${f.industry ? `aus dem Bereich „${f.industry}“` : 'lokaler Unternehmen'}${where(f, 'in')} bin ich auf ${f.company} gestoßen.`,
    introPro: (f) => `mein Name ist ${sender(f)}${f.sender.studio && f.sender.name ? `, ich leite ${f.sender.studio}` : ''}. Im Rahmen einer Recherche ${f.industry ? `zum Bereich „${f.industry}“` : ''}${where(f, 'in')} habe ich mir die Website von ${f.company} angesehen.`,
    introPremium: (f) => `ich leite ${f.sender.studio ?? 'ein Designstudio'} und arbeite mit Marken ${f.industry ? `aus dem Bereich „${f.industry}“` : 'aus dem Dienstleistungsbereich'} an ihrem digitalen Auftritt. Ich habe mir ${f.company} genauer angesehen.`,
    noticed: (obs) => (obs.length === 1 ? `Mir ist aufgefallen: ${obs[0]}.` : `Mir sind ein paar Dinge aufgefallen: ${joinObs(obs, 'und')}.`),
    portfolio: (p) => `Wir haben kürzlich ein ähnliches Projekt umgesetzt – ${p.name}${p.url ? ` (${p.url})` : ''} – vielleicht als Referenz interessant.`,
    service: (s) => `Genau das ist unser Schwerpunkt (${s}).`,
    offer: 'Wenn es hilft, schicke ich Ihnen gern ein kurzes Audit mit Screenshots und konkreten Verbesserungen – unverbindlich.',
    offerShort: 'Gern schicke ich ein kurzes Audit mit Screenshots.',
    question: 'Wäre das hilfreich für Sie?',
    optOut: 'Falls das nicht relevant ist, geben Sie mir kurz Bescheid – dann melde ich mich nicht mehr.',
    signoff: 'Beste Grüße',
  },
};

function signature(f: OutreachFacts, c: Copy): string {
  return [c.signoff, f.sender.name, f.sender.studio, f.sender.website].filter(Boolean).join('\n');
}

export function templateOutreach(f: OutreachFacts, tone: Tone, language: string): OutreachDraft {
  const lang = langFor(language);
  const c = COPY[lang];
  const obsPhrases: string[] = [];
  const used: string[] = [];
  if (!f.hasWebsite) {
    const p = renderPhrase('no_website', lang, { company: f.company });
    if (p) obsPhrases.push(p);
  }
  for (const o of f.observations) {
    if (obsPhrases.length >= (tone === 'ultra_short' ? 1 : 2)) break;
    const p = renderPhrase(o.code, lang, { company: f.company, ...(o.vars ?? {}) });
    if (p && !obsPhrases.includes(p)) {
      obsPhrases.push(p);
      used.push(o.findingId);
    }
  }
  const subject = c.subject[tone].replace('{company}', f.company);
  const parts: string[] = [c.greet(f.contactName)];
  if (tone === 'ultra_short') {
    parts.push([obsPhrases.length ? c.noticed(obsPhrases) : '', c.offerShort].filter(Boolean).join(' '));
    parts.push(signature(f, c));
  } else {
    const intro = tone === 'friendly' ? c.introFriendly(f) : tone === 'premium' ? c.introPremium(f) : c.introPro(f);
    // Without a sender name the first sentence ("My name is …") would be empty — keep only the rest.
    parts.push(sender(f) ? intro : intro.replace(/^[^.]*\.\s*/, ''));
    if (obsPhrases.length) parts.push(c.noticed(obsPhrases));
    const tail: string[] = [];
    if (f.portfolio) tail.push(c.portfolio(f.portfolio));
    if (f.service && tone !== 'friendly') tail.push(c.service(f.service.name));
    tail.push(c.offer, c.question);
    parts.push(tail.join(' '));
    parts.push(c.optOut);
    parts.push(signature(f, c));
  }
  const body = parts.filter((p) => p.trim()).join('\n\n');
  const lint = lintOutreach(subject, body, { companyName: f.company, tone, allowedNumbers: f.observations.flatMap((o) => Object.values(o.vars ?? {})) });
  return {
    subject,
    body,
    language: lang,
    tone,
    generator: 'template',
    usedFindingIds: used,
    portfolioUsed: !!f.portfolio && tone !== 'ultra_short',
    lint,
    note: obsPhrases.length === 0 ? 'No verified observation had a plain-language phrase in this language; the draft stays generic — add a specific observation manually.' : undefined,
  };
}

const AiOutreachSchema = z.object({ subject: z.string(), body: z.string() });

export const OUTREACH_SYSTEM_PROMPT = `You draft short, personal first-contact messages for a small web studio. Hard rules:
- Use ONLY the facts provided. Do not invent observations, numbers, statistics, results, clients or similarities.
- Mention at most two observations, in plain non-technical language, phrased neutrally ("I noticed...").
- Never claim the company is losing customers/revenue, never promise outcomes, no guarantees, no urgency, no flattery.
- Mention the portfolio project only if one is provided, using the given reason.
- Offer something small and useful (e.g. a short audit with screenshots) and end with one low-pressure question.
- Include a one-line opt-out sentence. No emojis. Write in the requested language and tone.
- Length: ultra_short ≤ 60 words; other tones ≤ 150 words.`;

export async function aiOutreach(ai: AiProvider, f: OutreachFacts, tone: Tone, language: string, log: Logger): Promise<OutreachDraft> {
  const lang = langFor(language);
  const facts = {
    company: f.company,
    industry: f.industry,
    city: f.city,
    website: f.website,
    contactName: f.contactName,
    observations: f.observations.slice(0, 3).map((o) => ({ title: o.title, detail: o.detail })),
    recommendedService: f.service?.name ?? null,
    portfolio: f.portfolio,
    sender: f.sender,
    tone,
    language: lang,
  };
  const res = await ai.generateJson(
    { task: 'outreach', system: OUTREACH_SYSTEM_PROMPT, prompt: `Facts (JSON):\n${JSON.stringify(facts, null, 2)}\n\nWrite the subject and body.`, schema: AiOutreachSchema, maxTokens: 4000 },
    { log },
  );
  const lint = lintOutreach(res.data.subject, res.data.body, { companyName: f.company, tone, allowedNumbers: f.observations.flatMap((o) => Object.values(o.vars ?? {})) });
  return {
    subject: res.data.subject,
    body: res.data.body,
    language: lang,
    tone,
    generator: 'ai',
    usedFindingIds: f.observations.slice(0, 3).map((o) => o.findingId),
    portfolioUsed: !!f.portfolio,
    lint,
    aiModel: res.model,
  };
}
