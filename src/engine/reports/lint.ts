/**
 * Outreach linter: flags spammy or unverifiable language before the user sends anything.
 * error   = must be removed (false guarantees, fake urgency, unverifiable loss claims, invented stats)
 * warning = review (generic greeting, too long, exclamation-heavy, possible fake compliment)
 */
export interface LintIssue {
  level: 'error' | 'warning';
  rule: string;
  message: string;
  match?: string;
}

const RULES: Array<{ rule: string; level: 'error' | 'warning'; re: RegExp; message: string }> = [
  { rule: 'guarantee', level: 'error', re: /(guarantee|guaranteed|gwarant|garantier|garanti|гарант)/i, message: 'Avoid guarantees — outcomes cannot be promised.' },
  { rule: 'false_urgency', level: 'error', re: /(limited time|only today|act now|last chance|hurry|ostatnia szansa|tylko dziś|tylko dzis|только сегодня|последний шанс|срочно|nur heute|letzte chance|тільки сьогодні|останній шанс)/i, message: 'False urgency is not allowed.' },
  { rule: 'outcome_claim', level: 'error', re: /((double|triple|skyrocket|boost|increase)\s+your\s+(sales|revenue|clients|customers|leads|bookings)|(zwiększ|podwój|podwoimy|zwiększymy)\w*.{0,25}(sprzeda|klient|przych)|(увелич|удво)\w*.{0,25}(продаж|клиент|выручк)|(збільш|подво)\w*.{0,25}(продаж|клієнт)|(verdoppeln|steigern)\s+ihre\s+(umsätze|kunden))/i, message: 'Do not promise business outcomes.' },
  { rule: 'loss_claim', level: 'error', re: /(you('| a)re losing|losing (customers|clients|patients|money)|tracisz|tracicie|traci pan|traci pani|теряете|потеряете|втрачаєте|verlieren sie)/i, message: 'Unverifiable loss claim — we did not measure lost customers or revenue.' },
  { rule: 'hundred_percent', level: 'error', re: /\b100\s?%/, message: '“100%” claims are not supportable.' },
  { rule: 'spam_phrases', level: 'warning', re: /(click here|risk[- ]free|no brainer|once in a lifetime|best in (the )?(world|market|city)|#1 agency|number one agency|kliknij tutaj|жми|нажмите сюда)/i, message: 'Spam-filter trigger phrase.' },
  { rule: 'fake_compliment', level: 'warning', re: /(amazing|awesome|incredible|stunning business|wspaniał|niesamowit|rewelacyjn|потрясающ|восхитит|неймовірн|großartig)/i, message: 'Possible generic/fake compliment — keep praise specific or remove it.' },
  { rule: 'generic_greeting', level: 'warning', re: /(dear sir|dear madam|to whom it may concern|szanowni państwo|уважаемые господа)/i, message: 'Generic greeting reads like mass mail.' },
];

export interface LintContext {
  companyName: string;
  tone: string;
  /** Numbers that legitimately appear in evidence (e.g. "2016", "7.4") */
  allowedNumbers?: string[];
}

export function lintOutreach(subject: string | null | undefined, body: string, ctx: LintContext): LintIssue[] {
  const text = `${subject ?? ''}\n${body}`;
  const issues: LintIssue[] = [];
  for (const r of RULES) {
    const m = text.match(r.re);
    if (m) issues.push({ level: r.level, rule: r.rule, message: r.message, match: m[0] });
  }
  const percents = text.match(/\d+([.,]\d+)?\s?%/g) ?? [];
  for (const p of percents) {
    const num = p.replace(/\s?%/, '');
    if (!ctx.allowedNumbers?.includes(num)) issues.push({ level: 'error', rule: 'unsupported_statistic', message: 'Percentage not taken from your evidence — remove or source it.', match: p });
  }
  const exclamations = (body.match(/!/g) ?? []).length;
  if (exclamations > 1) issues.push({ level: 'warning', rule: 'exclamations', message: `${exclamations} exclamation marks — tone down.` });
  const len = body.length;
  if (ctx.tone === 'ultra_short' && len > 450) issues.push({ level: 'warning', rule: 'length', message: `Ultra-short draft is ${len} characters (aim for < 450).` });
  if (ctx.tone !== 'ultra_short' && len > 1600) issues.push({ level: 'warning', rule: 'length', message: `Draft is ${len} characters — shorter messages get read.` });
  const firstWord = ctx.companyName.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (firstWord.length > 2 && !text.toLowerCase().includes(firstWord)) {
    issues.push({ level: 'warning', rule: 'not_personalised', message: 'The company is not mentioned — the message may read as generic.' });
  }
  return issues;
}
