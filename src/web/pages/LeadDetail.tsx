import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  AlertTriangle,
  Ban,
  BellPlus,
  Bot,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileDown,
  FileText,
  History,
  Image as ImageIcon,
  Mail,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Sparkles,
  Target,
  Trophy,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { COMPONENT_LABELS, CRM_STAGES, CRM_STAGE_LABELS, OUTCOME_LABELS, OUTCOME_TYPES, type DecisionIntel, type Discrepancy, type EvidenceItem, type PortfolioMatchResult, type SalesPotential, type ScoreComponent } from '../../domain/types';
import { api, download } from '../lib/api';
import { fmtDate, hostname, money, providerName, relTime, stageLabel, titleCase } from '../lib/format';
import { ConfidenceBadge, ContactStatusBadge, FreshnessBadge, KindBadge, KnowledgeBlock, PriorityBadge, Section, SeverityBadge } from '../components/domain';
import { Badge, Button, Checkbox, Dialog, EmptyState, ErrorState, Field, Input, Panel, ScoreBar, Select, SkeletonRows, Tabs, Textarea, toast } from '../components/ui';

// ───────────── types (API shape) ─────────────
interface Finding {
  id: string;
  code: string;
  category: string;
  polarity: string;
  severity: string;
  kind: string;
  source: string;
  title: string;
  detail: string;
  evidence: Array<EvidenceItem & { key?: string }>;
  pageUrl: string | null;
  viewport: string | null;
  confidence: string;
  detectedAt: string;
}
interface Screenshot {
  id: string;
  viewport: string;
  kind: string;
  path: string;
  width: number;
  height: number;
  pageUrl: string;
}
interface Contact {
  id: string;
  type: string;
  subtype: string | null;
  value: string;
  status: string;
  source: string;
  sourceUrl: string | null;
  label: string | null;
  isRoleBased: boolean;
  isPersonal: boolean;
  lastVerifiedAt: string;
  expiredAt: string | null;
  personName: string | null;
}
interface Outreach {
  id: string;
  channel: string;
  tone: string;
  language: string;
  subject: string | null;
  body: string;
  generator: string;
  status: string;
  lintWarnings: Array<{ level: string; rule: string; message: string; match?: string }>;
  createdAt: string;
  sentAt: string | null;
}
interface LeadDetailResp {
  lead: {
    id: string;
    stage: string;
    priority: string | null;
    leadFit: number | null;
    freshness: number | null;
    notes: string | null;
    components: { components: ScoreComponent[]; dataCompleteness: number } | null;
    priorityReasons: string[];
    salesPotential: SalesPotential | null;
    decision: DecisionIntel | null;
    portfolioMatch: { best: PortfolioMatchResult | null; ranked: PortfolioMatchResult[]; note: string } | null;
    contactAvailability: string | null;
    excludedReason: string | null;
    lastScoredAt: string | null;
    contactedAt: string | null;
    company: {
      id: string;
      name: string;
      industry: string | null;
      city: string | null;
      country: string | null;
      address: string | null;
      rating: number | null;
      ratingCount: number | null;
      businessStatus: string;
      isExistingClient: boolean;
      doNotContact: boolean;
      discrepancies: Discrepancy[];
      firstSeenAt: string;
      lastVerifiedAt: string | null;
      website: { url: string | null; status: string; confidence: string; discoverySource: string | null; discoveryLog: Array<{ url: string; source: string; verdict: string; reasons: string[]; evidence: string }>; notFoundReason: string | null; platform: string | null; lastAnalyzedAt: string | null } | null;
      locations: Array<{ id: string; address: string | null; city: string | null; phoneE164: string | null }>;
      contacts: Contact[];
      sourceRecords: Array<{ id: string; provider: string; name: string | null; address: string | null; phone: string | null; website: string | null; profileUrl: string | null; fetchedAt: string; purgedAt: string | null; retentionExpiresAt: string | null; rating: number | null; ratingCount: number | null; businessStatus: string | null }>;
    };
    recommendations: Array<{ id: string; serviceSlug: string; kind: string; fitScore: number; reasons: Array<{ text: string; findingIds: string[] }>; exclusionReasons: string[] }>;
    audits: Array<{ id: string; generator: string; status: string; createdAt: string }>;
    outreach: Outreach[];
    activities: Array<{ id: string; type: string; summary: string; actor: string; createdAt: string }>;
    followUps: Array<{ id: string; dueAt: string; note: string | null; status: string; channel: string | null }>;
    outcomes: Array<{ id: string; type: string; dealValue: number | null; notes: string | null; recordedAt: string }>;
    campaignLeads: Array<{ campaign: { id: string; name: string } }>;
  };
  analyses: Array<{ id: string; status: string; startedAt: string; finishedAt: string | null; aiStatus: string; diff: { fixed: string[]; added: string[]; redesignSuspected: boolean; note?: string; previousAt: string } | null; summary: { negative?: number; positive?: number } }>;
  latestAnalysis: { id: string; status: string; finishedAt: string | null; aiStatus: string; aiModel: string | null; metrics: Record<string, unknown>; tech: { platform?: string; libraries?: string[]; analytics?: string[] }; errors: string[]; lighthouse: unknown; pagesVisited: Array<{ url: string; kind: string }>; findings: Finding[]; screenshots: Screenshot[] } | null;
  services: Array<{ slug: string; name: string; priceMin: number | null; priceMax: number | null; currency: string }>;
}

const CATEGORY_TABS = [
  { id: 'all', label: 'All issues', match: (f: Finding) => f.polarity === 'negative' },
  { id: 'technical', label: 'Technical', match: (f: Finding) => f.polarity === 'negative' && ['technical', 'security'].includes(f.category) },
  { id: 'ux', label: 'UX', match: (f: Finding) => f.polarity === 'negative' && f.category === 'ux' && f.kind !== 'ai_observation' },
  { id: 'seo', label: 'SEO', match: (f: Finding) => f.polarity === 'negative' && (f.category === 'seo' || f.category === 'content') },
  { id: 'performance', label: 'Performance', match: (f: Finding) => f.polarity === 'negative' && f.category === 'performance' },
  { id: 'accessibility', label: 'Accessibility', match: (f: Finding) => f.polarity === 'negative' && f.category === 'accessibility' },
  { id: 'visual', label: 'Visual & AI', match: (f: Finding) => f.kind === 'ai_observation' || (f.polarity === 'negative' && f.category === 'visual') },
  { id: 'working', label: 'What works', match: (f: Finding) => f.polarity === 'positive' },
] as const;

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function shotUrl(s: Screenshot): string {
  return `/media/screenshots/${s.path}`;
}

// ───────────── sub-components ─────────────
function FindingCard({ f, screenshots, onShot }: { f: Finding; screenshots: Screenshot[]; onShot: (s: Screenshot) => void }) {
  const evidence = f.evidence.filter((e) => e.type !== 'screenshot');
  const shots = f.evidence.filter((e) => e.type === 'screenshot').map((e) => screenshots.find((s) => s.id === e.ref)).filter((s): s is Screenshot => !!s);
  return (
    <article className={clsx('rounded-md border border-line bg-panel px-3 py-2.5', f.kind === 'ai_observation' && 'border-l-[3px] border-l-ai')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="text-[13px] font-medium text-ink">{f.title}</h4>
        <div className="flex flex-wrap gap-1">
          {f.polarity === 'negative' && <SeverityBadge severity={f.severity} />}
          <KindBadge kind={f.kind} source={f.source} />
          <ConfidenceBadge confidence={f.confidence} />
        </div>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-2">{f.detail}</p>
      {(evidence.length > 0 || shots.length > 0) && (
        <div className="mt-2 space-y-1">
          {evidence.slice(0, 5).map((e, i) => (
            <div key={i} className="flex gap-2 text-[11.5px] text-ink-3">
              <span className="shrink-0 rounded bg-sunken px-1 font-mono">{e.type}</span>
              <span className="min-w-0 break-all">
                {[e.label, e.excerpt, e.selector, e.value != null ? `${e.value}${e.unit ? ` ${e.unit}` : ''}` : null].filter(Boolean).join(' · ')}
                {e.ref && e.type !== 'screenshot' && /^https?:/.test(e.ref) && (
                  <a className="ml-1 text-accent hover:underline" href={e.ref} target="_blank" rel="noopener noreferrer">
                    {e.ref.length > 70 ? `${e.ref.slice(0, 70)}…` : e.ref}
                  </a>
                )}
                {e.ref && e.type !== 'screenshot' && !/^https?:/.test(e.ref) && <span className="ml-1">{e.ref}</span>}
              </span>
            </div>
          ))}
          {shots.length > 0 && (
            <div className="flex gap-1.5 pt-1">
              {shots.map((s) => (
                <button key={s.id} onClick={() => onShot(s)} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-2 hover:bg-sunken">
                  <ImageIcon className="size-3" /> {s.viewport} screenshot
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="mt-1.5 text-[10.5px] text-ink-3">
        {f.source === 'ai' ? 'Source: AI (subjective)' : 'Source: automated check'}
        {f.pageUrl && ` · ${f.pageUrl.replace(/^https?:\/\//, '')}`}
        {f.viewport && ` · ${f.viewport}`} · {fmtDate(f.detectedAt, true)}
      </div>
    </article>
  );
}

function ComponentsCard({ components, leadFit, completeness, reasons, priority }: { components: ScoreComponent[]; leadFit: number | null; completeness: number; reasons: string[]; priority: string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const kindIcon = (k: string) => ({ fact: 'fact', observation: 'observed', inference: 'inferred', gap: 'unknown' })[k] ?? k;
  return (
    <Panel title="Lead Fit" actions={<PriorityBadge priority={priority} />}>
      <div className="flex items-end gap-3">
        <div className="tnum text-3xl font-semibold">{leadFit ?? '—'}</div>
        <div className="pb-1 text-[12px] text-ink-3">/100 · data completeness {Math.round(completeness * 100)}%</div>
      </div>
      <p className="mt-1 text-[11.5px] text-ink-3">Weighted sum of the components below — each is explained; unknowns are shown as gaps, not guessed.</p>
      <ul className="mt-3 space-y-1">
        {components.map((c) => (
          <li key={c.key}>
            <button className="flex w-full items-center justify-between gap-2 rounded px-1 py-1 text-left hover:bg-sunken" onClick={() => setOpen(open === c.key ? null : c.key)}>
              <span className="text-[12.5px] text-ink-2">
                {COMPONENT_LABELS[c.key]} <span className="text-[10.5px] text-ink-3">×{c.weight}</span>
              </span>
              <ScoreBar value={c.score} />
            </button>
            {open === c.key && (
              <ul className="mb-1 ml-1 space-y-0.5 border-l border-line pl-2">
                {c.factors.map((f, i) => (
                  <li key={i} className="flex justify-between gap-2 text-[11.5px]">
                    <span className="text-ink-2">
                      <span className="mr-1 rounded bg-sunken px-1 text-[10px] text-ink-3">{kindIcon(f.kind)}</span>
                      {f.label}
                    </span>
                    <span className={clsx('tnum shrink-0', f.points > 0 ? 'text-ok' : f.points < 0 ? 'text-bad' : 'text-ink-3')}>{f.points > 0 ? `+${f.points}` : f.points}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 border-t border-line pt-2">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Why this priority</div>
        <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-ink-2">
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function SalesPotentialCard({ sp }: { sp: SalesPotential | null }) {
  if (!sp) return null;
  if (sp.mode === 'A')
    return (
      <Panel title="Estimated sales potential" actions={<Badge tone="neutral">heuristic</Badge>}>
        <div className="text-xl font-semibold capitalize">{sp.level}</div>
        <ul className="mt-2 space-y-0.5 text-[12px] text-ink-2">
          {sp.factors.map((f, i) => (
            <li key={i}>• {f.label}</li>
          ))}
        </ul>
        <p className="mt-2 text-[11.5px] text-ink-3">{sp.note}</p>
      </Panel>
    );
  return (
    <Panel title="Forecast" actions={<Badge tone="ai">model v{sp.modelVersion}</Badge>}>
      <div className="tnum text-xl font-semibold">{Math.round(sp.probability * 100)}%</div>
      <div className="tnum text-[12px] text-ink-2">
        80% interval {Math.round(sp.interval[0] * 100)}–{Math.round(sp.interval[1] * 100)}% · n = {sp.sampleSize} · trained {fmtDate(sp.trainedAt)}
      </div>
      <p className="mt-2 text-[11.5px] text-ink-3">{sp.note}</p>
    </Panel>
  );
}

function OutreachEditor({ o, leadId, emails }: { o: Outreach; leadId: string; emails: string[] }) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState(o.subject ?? '');
  const [body, setBody] = useState(o.body);
  useEffect(() => {
    setSubject(o.subject ?? '');
    setBody(o.body);
  }, [o.id, o.subject, o.body]);
  const dirty = subject !== (o.subject ?? '') || body !== o.body;
  const save = useMutation({
    mutationFn: (status?: string) => api(`/api/outreach/${o.id}`, { method: 'PATCH', body: { subject, body, status } }),
    onSuccess: () => {
      toast.ok('Draft saved');
      void qc.invalidateQueries({ queryKey: ['lead', leadId] });
    },
  });
  const sent = useMutation({
    mutationFn: async () => {
      if (dirty) await api(`/api/outreach/${o.id}`, { method: 'PATCH', body: { subject, body } });
      return api(`/api/outreach/${o.id}/mark-sent`, { method: 'POST', body: {} });
    },
    onSuccess: () => {
      toast.ok('Marked as contacted');
      void qc.invalidateQueries({ queryKey: ['lead', leadId] });
    },
  });
  const errors = o.lintWarnings.filter((w) => w.level === 'error');
  const warnings = o.lintWarnings.filter((w) => w.level === 'warning');
  const mailto = emails[0] && o.channel === 'email' ? `mailto:${encodeURIComponent(emails[0])}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
        <Badge>{o.channel}</Badge>
        <Badge>{titleCase(o.tone)}</Badge>
        <Badge>{o.language}</Badge>
        <Badge tone={o.generator === 'ai' ? 'ai' : 'neutral'}>{o.generator === 'ai' ? 'AI draft' : 'template'}</Badge>
        <Badge tone={o.status === 'sent_manually' ? 'ok' : 'neutral'}>{o.status.replace('_', ' ')}</Badge>
        <span>{relTime(o.createdAt)}</span>
      </div>
      {o.channel === 'email' && <Input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />}
      <Textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message body" className="font-[inherit] leading-relaxed" />
      {(errors.length > 0 || warnings.length > 0) && (
        <ul className="space-y-1">
          {[...errors, ...warnings].map((w, i) => (
            <li key={i} className={clsx('flex gap-1.5 text-[12px]', w.level === 'error' ? 'text-bad' : 'text-warn')}>
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {w.message}
              {w.match && <span className="font-mono">“{w.match}”</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => save.mutate(undefined)} disabled={!dirty} loading={save.isPending}>
          Save & re-check
        </Button>
        <Button
          size="sm"
          icon={<Copy className="size-3.5" />}
          onClick={() => {
            void navigator.clipboard.writeText(o.channel === 'email' ? `${subject}\n\n${body}` : body);
            toast.ok('Copied');
          }}
        >
          Copy
        </Button>
        {mailto && (
          <a href={mailto}>
            <Button size="sm" icon={<Mail className="size-3.5" />}>
              Open in mail app
            </Button>
          </a>
        )}
        <Button size="sm" variant="primary" icon={<Send className="size-3.5" />} onClick={() => sent.mutate()} disabled={o.status === 'sent_manually'} loading={sent.isPending}>
          {o.status === 'sent_manually' ? `Sent ${relTime(o.sentAt)}` : 'I sent it — mark contacted'}
        </Button>
      </div>
      <p className="text-[11px] text-ink-3">Nothing is sent automatically. You send the message yourself, then mark it here.</p>
    </div>
  );
}

// ───────────── page ─────────────
export default function LeadDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['lead', id], queryFn: () => api<LeadDetailResp>(`/api/leads/${id}`) });
  const [tab, setTab] = useState<(typeof CATEGORY_TABS)[number]['id']>('all');
  const [shot, setShot] = useState<Screenshot | null>(null);
  const [auditView, setAuditView] = useState<{ id: string; markdown: string } | null>(null);
  const [followOpen, setFollowOpen] = useState(false);
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [analyzeJob, setAnalyzeJob] = useState<string | null>(null);
  const [tone, setTone] = useState('professional');
  const [lang, setLang] = useState('');
  const [channel, setChannel] = useState('email');
  const [useAi, setUseAi] = useState(false);
  const [contactName, setContactName] = useState('');
  const [note, setNote] = useState('');
  const invalidate = () => qc.invalidateQueries({ queryKey: ['lead', id] });

  const analyzeStatus = useQuery({
    queryKey: ['job-status', analyzeJob],
    queryFn: () => api<{ status: string; lastError: string | null }>(`/api/jobs/${analyzeJob}`),
    enabled: !!analyzeJob,
    refetchInterval: (s) => (['queued', 'running'].includes(s.state.data?.status ?? 'queued') ? 2500 : false),
  });
  useEffect(() => {
    if (!analyzeJob || !analyzeStatus.data) return;
    if (analyzeStatus.data.status === 'completed') {
      toast.ok('Analysis complete');
      setAnalyzeJob(null);
      void invalidate();
    } else if (analyzeStatus.data.status === 'failed') {
      toast.error(`Analysis failed: ${analyzeStatus.data.lastError ?? ''}`);
      setAnalyzeJob(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzeStatus.data, analyzeJob]);

  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api(`/api/leads/${id}`, { method: 'PATCH', body }), onSuccess: () => invalidate(), onError: (e) => toast.error((e as Error).message) });
  const analyze = useMutation({ mutationFn: () => api<{ jobId: string }>(`/api/leads/${id}/analyze`, { body: { visualAi: true } }), onSuccess: (r) => { setAnalyzeJob(r.jobId); toast.info('Analysis queued — the page updates when it finishes.'); } });
  const requalify = useMutation({ mutationFn: () => api(`/api/leads/${id}/requalify`, { body: {} }), onSuccess: () => { toast.ok('Re-scored'); void invalidate(); } });
  const genAudit = useMutation({ mutationFn: (ai: boolean) => api<{ id: string }>(`/api/leads/${id}/audit`, { body: { ai, language: lang || undefined } }), onSuccess: () => { toast.ok('Audit generated'); void invalidate(); }, onError: (e) => toast.error((e as Error).message) });
  const genOutreach = useMutation({ mutationFn: () => api(`/api/leads/${id}/outreach`, { body: { tone, language: lang || undefined, channel, useAi, contactName: contactName || null } }), onSuccess: () => { toast.ok('Draft created'); void invalidate(); }, onError: (e) => toast.error((e as Error).message) });
  const addNote = useMutation({ mutationFn: () => api(`/api/leads/${id}/activities`, { body: { type: 'note', summary: note } }), onSuccess: () => { setNote(''); void invalidate(); } });
  const followDone = useMutation({ mutationFn: (fid: string) => api(`/api/followups/${fid}`, { method: 'PATCH', body: { status: 'done' } }), onSuccess: () => invalidate() });

  const data = q.data;
  const findings = useMemo(() => [...(data?.latestAnalysis?.findings ?? [])].sort((a, b) => (SEV_ORDER[a.severity] ?? 5) - (SEV_ORDER[b.severity] ?? 5) || (a.kind === 'ai_observation' ? 1 : 0) - (b.kind === 'ai_observation' ? 1 : 0)), [data]);

  if (q.isLoading) return <SkeletonRows rows={12} />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const { lead, analyses, latestAnalysis: la, services } = data!;
  const c = lead.company;
  const d = lead.decision;
  const svcName = (slug: string) => services.find((s) => s.slug === slug)?.name ?? titleCase(slug);
  const svcPrice = (slug: string) => {
    const s = services.find((x) => x.slug === slug);
    return s ? money(s.priceMin, s.priceMax, s.currency) : '';
  };
  const screenshots = la?.screenshots ?? [];
  const tabDef = CATEGORY_TABS.find((t) => t.id === tab)!;
  const visibleFindings = findings.filter(tabDef.match);
  const verifiedEmails = c.contacts.filter((x) => x.type === 'email' && x.status !== 'unverified' && !x.expiredAt).map((x) => x.value);
  const metrics = (la?.metrics ?? {}) as { desktop?: Record<string, number | null>; mobile?: Record<string, number | null>; note?: string };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded-lg border border-line bg-panel p-4 shadow-panel">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{c.name}</h1>
              <PriorityBadge priority={lead.priority} />
              <FreshnessBadge value={lead.freshness} />
              {c.doNotContact && <Badge tone="bad">Do not contact</Badge>}
              {c.isExistingClient && <Badge tone="info">Existing client</Badge>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-2">
              {c.website?.url ? (
                <a href={c.website.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                  {hostname(c.website.url)} <ExternalLink className="size-3" />
                </a>
              ) : (
                <span className="text-warn">{c.website?.status === 'not_found' ? 'No official website found' : 'Website not checked yet'}</span>
              )}
              <span>{[c.address, c.city, c.country].filter(Boolean).join(', ')}</span>
              {c.industry && <span>{c.industry}</span>}
              {c.website?.platform && <Badge>{c.website.platform}</Badge>}
              {c.ratingCount != null && (
                <span title="From business listings">
                  ★ {c.rating?.toFixed(1)} ({c.ratingCount})
                </span>
              )}
            </div>
            {lead.excludedReason && <div className="mt-1.5 text-[12px] text-bad">Excluded: {lead.excludedReason}</div>}
          </div>
          <div className="flex items-center gap-2">
            <Select value={lead.stage} onChange={(e) => patch.mutate({ stage: e.target.value })} aria-label="CRM stage">
              {CRM_STAGES.map((s) => (
                <option key={s} value={s}>
                  {CRM_STAGE_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button icon={<RefreshCw className={clsx('size-3.5', analyzeJob && 'animate-spin')} />} onClick={() => analyze.mutate()} disabled={!!analyzeJob} loading={analyze.isPending}>
            {analyzeJob ? 'Analysing…' : la ? 'Re-analyze' : 'Analyze'}
          </Button>
          <a href="#evidence">
            <Button icon={<Target className="size-3.5" />}>View evidence</Button>
          </a>
          <Button icon={<FileText className="size-3.5" />} onClick={() => genAudit.mutate(false)} loading={genAudit.isPending && !genAudit.variables}>
            Generate audit
          </Button>
          <a href="#outreach">
            <Button icon={<MessageSquarePlus className="size-3.5" />}>Generate outreach</Button>
          </a>
          <Button icon={<BellPlus className="size-3.5" />} onClick={() => setFollowOpen(true)}>
            Schedule follow-up
          </Button>
          <Button icon={<Send className="size-3.5" />} onClick={() => patch.mutate({ stage: 'contacted' })} disabled={!!lead.contactedAt}>
            {lead.contactedAt ? `Contacted ${relTime(lead.contactedAt)}` : 'Mark contacted'}
          </Button>
          <Button icon={<Trophy className="size-3.5" />} onClick={() => setOutcomeOpen(true)}>
            Record outcome
          </Button>
          <Button variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => requalify.mutate()} loading={requalify.isPending}>
            Re-score
          </Button>
          <Button variant="ghost" icon={<Ban className="size-3.5" />} onClick={() => patch.mutate({ doNotContact: !c.doNotContact })}>
            {c.doNotContact ? 'Allow contact' : 'Do not contact'}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          {/* Why this lead */}
          <Panel title="Why this lead">
            {!d ? (
              <EmptyState title="Not qualified yet">Run an analysis or re-score to generate the decision summary.</EmptyState>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <Section title="Why this lead">
                    <ul className="list-disc space-y-1 pl-4 text-[12.5px] text-ink-2">
                      {d.whyThisLead.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </Section>
                  <Section title="Why now">
                    <ul className="list-disc space-y-1 pl-4 text-[12.5px] text-ink-2">
                      {d.whyNow.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </Section>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <KnowledgeBlock title="What we know (sources)" tone="fact" items={d.knowledge.know} />
                  <KnowledgeBlock title="What we observed (measured)" tone="observed" items={d.knowledge.observed} empty="No analysis yet" />
                  <KnowledgeBlock title="What we infer" tone="infer" items={d.knowledge.infer} />
                  <KnowledgeBlock title="What we don't know" tone="unknown" items={d.knowledge.unknown} />
                </div>
              </div>
            )}
          </Panel>

          {/* Opportunity */}
          {d && (
            <Panel title="Business opportunity">
              <div className="grid gap-4 md:grid-cols-2">
                <Section title="Main pain point">
                  {d.mainPainPoint ? (
                    <div className="text-[12.5px]">
                      <div className="font-medium">{d.mainPainPoint.title}</div>
                      <div className="text-ink-2">{d.mainPainPoint.interpretation}</div>
                    </div>
                  ) : (
                    <div className="text-[12px] text-ink-3">None identified.</div>
                  )}
                </Section>
                <Section title="Secondary pain point">
                  {d.secondaryPainPoint ? (
                    <div className="text-[12.5px]">
                      <div className="font-medium">{d.secondaryPainPoint.title}</div>
                      <div className="text-ink-2">{d.secondaryPainPoint.interpretation}</div>
                    </div>
                  ) : (
                    <div className="text-[12px] text-ink-3">—</div>
                  )}
                </Section>
                <Section title="What to offer">
                  <ul className="space-y-2">
                    {lead.recommendations
                      .filter((r) => r.kind === 'primary' || r.kind === 'secondary')
                      .map((r) => (
                        <li key={r.id} className="text-[12.5px]">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge tone={r.kind === 'primary' ? 'accent' : 'neutral'}>{r.kind}</Badge>
                            <span className="font-medium">{svcName(r.serviceSlug)}</span>
                            <span className="text-ink-3">fit {r.fitScore} · {svcPrice(r.serviceSlug)}</span>
                          </div>
                          <ul className="mt-0.5 list-disc pl-4 text-[12px] text-ink-2">
                            {r.reasons.slice(0, 3).map((x, i) => (
                              <li key={i}>{x.text}</li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    {!lead.recommendations.some((r) => r.kind === 'primary') && <li className="text-[12px] text-ink-3">No service meets its minimum evidence threshold.</li>}
                  </ul>
                </Section>
                <Section title="What NOT to offer">
                  <ul className="space-y-1.5 text-[12.5px]">
                    {lead.recommendations
                      .filter((r) => r.kind === 'do_not_recommend')
                      .map((r) => (
                        <li key={r.id}>
                          <span className="font-medium">{svcName(r.serviceSlug)}</span>
                          <div className="text-[12px] text-ink-2">{r.exclusionReasons.join(' ')}</div>
                        </li>
                      ))}
                    {!lead.recommendations.some((r) => r.kind === 'do_not_recommend') && <li className="text-[12px] text-ink-3">—</li>}
                  </ul>
                </Section>
                <Section title="What to mention">
                  <ul className="list-disc space-y-1 pl-4 text-[12.5px] text-ink-2">
                    {d.whatToMention.map((m) => (
                      <li key={m.findingId}>
                        {m.text} <span className="text-ink-3">({m.evidence})</span>
                      </li>
                    ))}
                    {d.whatToMention.length === 0 && <li className="list-none text-ink-3">No high-confidence observation to mention.</li>}
                  </ul>
                </Section>
                <Section title="What NOT to claim">
                  <ul className="list-disc space-y-1 pl-4 text-[12.5px] text-ink-2">
                    {d.whatNotToClaim.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </Section>
              </div>
              <div className="mt-4 rounded-md border border-line bg-panel-2 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Best contact channel</div>
                {d.bestContactChannel ? (
                  <div className="mt-1 text-[12.5px]">
                    <span className="font-medium">{titleCase(d.bestContactChannel.channel)}</span>
                    {d.bestContactChannel.value && <span className="ml-1.5 break-all text-ink-2">{d.bestContactChannel.value}</span>}
                    <div className="text-[12px] text-ink-2">{d.bestContactChannel.reason}</div>
                    {d.bestContactChannel.complianceNote && <div className="mt-1 text-[11.5px] text-warn">{d.bestContactChannel.complianceNote}</div>}
                  </div>
                ) : (
                  <div className="mt-1 text-[12px] text-ink-3">No public business contact found.</div>
                )}
              </div>
            </Panel>
          )}

          {/* Evidence */}
          <Panel
            id="evidence"
            title="Evidence"
            actions={
              la && (
                <span className="text-[11.5px] text-ink-3">
                  Analysed {relTime(la.finishedAt)} · {la.pagesVisited.length} page(s) · AI: {la.aiStatus.replace(/_/g, ' ')}
                </span>
              )
            }
          >
            {!la ? (
              <EmptyState title={c.website?.url ? 'Website not analysed yet' : 'No website to analyse'} action={c.website?.url ? <Button onClick={() => analyze.mutate()}>Analyze now</Button> : undefined}>
                {c.website?.notFoundReason ?? 'Live analysis checks desktop, tablet and mobile with a real browser.'}
              </EmptyState>
            ) : (
              <div className="space-y-3">
                {la.status !== 'completed' && (
                  <div className="rounded-md bg-warn-soft px-3 py-2 text-[12px] text-warn">
                    Analysis status: {la.status}. {la.errors.slice(0, 2).join(' · ')}
                  </div>
                )}
                <Tabs tabs={CATEGORY_TABS.map((t) => ({ id: t.id, label: t.label, count: findings.filter(t.match).length }))} value={tab} onChange={setTab} />
                {tab === 'visual' && <p className="text-[11.5px] text-ai"><Bot className="mr-1 inline size-3.5" />AI observations are subjective assessments of screenshots — shown separately from measured facts.</p>}
                <div className="space-y-2">
                  {visibleFindings.map((f) => (
                    <FindingCard key={f.id} f={f} screenshots={screenshots} onShot={setShot} />
                  ))}
                  {visibleFindings.length === 0 && <div className="py-4 text-center text-[12px] text-ink-3">Nothing in this category.</div>}
                </div>
                {(metrics.desktop || metrics.mobile) && (
                  <div className="rounded-md border border-line bg-panel-2 p-3 text-[12px]">
                    <div className="mb-1 font-medium">Measurements</div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {(['desktop', 'mobile'] as const).map((vp) =>
                        metrics[vp] ? (
                          <div key={vp}>
                            <div className="text-[11px] uppercase text-ink-3">{vp}</div>
                            <div className="tnum text-ink-2">
                              {Object.entries(metrics[vp]!)
                                .filter(([, v]) => v != null)
                                .map(([k, v]) => `${k}: ${v}`)
                                .join(' · ')}
                            </div>
                          </div>
                        ) : null,
                      )}
                    </div>
                    <div className="mt-1 text-[11px] text-ink-3">{metrics.note} {la.lighthouse ? '' : 'Lighthouse: not run.'}</div>
                  </div>
                )}
              </div>
            )}
          </Panel>

          {/* Screenshots */}
          {screenshots.length > 0 && (
            <Panel title="Website screenshots">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                {screenshots.map((s) => (
                  <button key={s.id} onClick={() => setShot(s)} className={clsx('group overflow-hidden rounded-md border border-line text-left', s.viewport === 'desktop' && s.kind === 'viewport' && 'col-span-2')}>
                    <img src={shotUrl(s)} alt={`${s.viewport} ${s.kind}`} loading="lazy" className="h-40 w-full object-cover object-top transition group-hover:opacity-90" />
                    <div className="px-2 py-1 text-[11px] text-ink-3">
                      {s.viewport} · {s.kind}
                    </div>
                  </button>
                ))}
              </div>
            </Panel>
          )}

          {/* History */}
          {analyses.length > 0 && (
            <Panel title="Analysis history" actions={<History className="size-4 text-ink-3" />}>
              <ul className="space-y-2 text-[12.5px]">
                {analyses.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2 border-b border-line pb-2 last:border-0">
                    <span className="tnum w-36 text-ink-2">{fmtDate(a.startedAt, true)}</span>
                    <Badge tone={a.status === 'completed' ? 'ok' : a.status === 'failed' ? 'bad' : 'warn'}>{a.status}</Badge>
                    <span className="text-ink-3">
                      {a.summary?.negative ?? 0} issues · {a.summary?.positive ?? 0} positives
                    </span>
                    {a.diff && (
                      <span className="text-ink-2">
                        {a.diff.fixed.length} fixed, {a.diff.added.length} new since {fmtDate(a.diff.previousAt)}
                        {a.diff.redesignSuspected && <Badge tone="warn" className="ml-1.5">possible redesign</Badge>}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {/* Audit */}
          <Panel
            title="Audit"
            actions={
              <>
                <Button size="sm" onClick={() => genAudit.mutate(false)} loading={genAudit.isPending && genAudit.variables === false}>
                  Generate (template)
                </Button>
                <Button size="sm" icon={<Sparkles className="size-3.5" />} onClick={() => genAudit.mutate(true)} loading={genAudit.isPending && genAudit.variables === true}>
                  Generate with AI
                </Button>
              </>
            }
          >
            {lead.audits.length === 0 ? (
              <div className="text-[12px] text-ink-3">No audit yet. Template audits are free and built only from recorded evidence; AI rewrites the prose (and translates) from the same facts.</div>
            ) : (
              <ul className="space-y-2">
                {lead.audits.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2 text-[12.5px]">
                    <FileText className="size-4 text-ink-3" />
                    <span>{fmtDate(a.createdAt, true)}</span>
                    <Badge tone={a.generator === 'ai' ? 'ai' : 'neutral'}>{a.generator}</Badge>
                    <span className="ml-auto flex gap-1">
                      <Button size="sm" variant="ghost" onClick={async () => setAuditView({ id: a.id, markdown: (await api<{ markdown: string }>(`/api/audits/${a.id}`)).markdown })}>
                        View
                      </Button>
                      <Button size="sm" variant="ghost" icon={<FileDown className="size-3.5" />} onClick={() => download(`/api/audits/${a.id}/export`, { format: 'pdf' })}>
                        PDF
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => download(`/api/audits/${a.id}/export`, { format: 'html' })}>
                        HTML
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => download(`/api/audits/${a.id}/export`, { format: 'md' })}>
                        MD
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {/* Outreach */}
          <Panel id="outreach" title="Outreach">
            <div className="mb-3 grid gap-2 md:grid-cols-5">
              <Field label="Tone">
                <Select value={tone} onChange={(e) => setTone(e.target.value)}>
                  <option value="friendly">Friendly</option>
                  <option value="professional">Professional</option>
                  <option value="premium">Premium Agency</option>
                  <option value="ultra_short">Ultra Short</option>
                </Select>
              </Field>
              <Field label="Language">
                <Select value={lang} onChange={(e) => setLang(e.target.value)}>
                  <option value="">Auto (lead's country)</option>
                  <option value="en">English</option>
                  <option value="pl">Polski</option>
                  <option value="de">Deutsch</option>
                  <option value="uk">Українська</option>
                  <option value="ru">Русский</option>
                </Select>
              </Field>
              <Field label="Channel">
                <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
                  <option value="email">E-mail</option>
                  <option value="contact_form">Contact form</option>
                  <option value="linkedin">LinkedIn</option>
                  <option value="phone_script">Phone script</option>
                </Select>
              </Field>
              <Field label="Contact name (optional)">
                <Input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Anna" />
              </Field>
              <div className="flex flex-col justify-end gap-1.5">
                <Checkbox label="Write with AI" checked={useAi} onChange={setUseAi} />
                <Button variant="primary" onClick={() => genOutreach.mutate()} loading={genOutreach.isPending}>
                  Generate draft
                </Button>
              </div>
            </div>
            {lead.portfolioMatch && (
              <div className="mb-3 rounded-md border border-line bg-panel-2 px-3 py-2 text-[12px]">
                <span className="font-medium">Portfolio: </span>
                {lead.portfolioMatch.best ? (
                  <>
                    show <span className="font-medium">{lead.portfolioMatch.best.name}</span> — {lead.portfolioMatch.best.reasons.join(' + ')}
                  </>
                ) : (
                  <span className="text-ink-3">{lead.portfolioMatch.note}</span>
                )}
              </div>
            )}
            {lead.outreach.length === 0 ? (
              <div className="text-[12px] text-ink-3">No drafts yet. Drafts use only verified observations; the linter flags guarantees, fake urgency, invented statistics and loss claims.</div>
            ) : (
              <div className="space-y-4">
                <OutreachEditor o={lead.outreach[0]!} leadId={lead.id} emails={verifiedEmails} />
                {lead.outreach.length > 1 && (
                  <details className="text-[12px] text-ink-3">
                    <summary className="cursor-pointer">{lead.outreach.length - 1} older draft(s)</summary>
                    <ul className="mt-2 space-y-2">
                      {lead.outreach.slice(1).map((o) => (
                        <li key={o.id} className="rounded border border-line p-2">
                          <div className="mb-1">
                            {fmtDate(o.createdAt, true)} · {o.tone} · {o.language} · {o.status}
                          </div>
                          <pre className="whitespace-pre-wrap font-[inherit] text-ink-2">{o.body}</pre>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </Panel>

          {/* CRM */}
          <Panel title="CRM activity">
            <div className="mb-3 flex gap-2">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note, call summary…" onKeyDown={(e) => e.key === 'Enter' && note.trim() && addNote.mutate()} />
              <Button onClick={() => addNote.mutate()} disabled={!note.trim()}>
                Add
              </Button>
            </div>
            {lead.followUps.length > 0 && (
              <div className="mb-3">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Follow-ups</div>
                <ul className="space-y-1 text-[12.5px]">
                  {lead.followUps.map((f) => (
                    <li key={f.id} className="flex items-center gap-2">
                      <Badge tone={f.status === 'done' ? 'ok' : new Date(f.dueAt) < new Date() ? 'bad' : 'info'}>{f.status === 'pending' ? (new Date(f.dueAt) < new Date() ? 'overdue' : 'due') : f.status}</Badge>
                      <span className="tnum">{fmtDate(f.dueAt)}</span>
                      <span className="text-ink-2">{f.note}</span>
                      {f.status === 'pending' && (
                        <Button size="sm" variant="ghost" className="ml-auto" icon={<CheckCircle2 className="size-3.5" />} onClick={() => followDone.mutate(f.id)}>
                          Done
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {lead.outcomes.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {lead.outcomes.map((o) => (
                  <Badge key={o.id} tone={o.type === 'won' ? 'ok' : ['lost', 'not_interested', 'wrong_fit'].includes(o.type) ? 'bad' : 'accent'}>
                    {OUTCOME_LABELS[o.type as keyof typeof OUTCOME_LABELS] ?? o.type}
                    {o.dealValue ? ` · ${o.dealValue}` : ''} · {fmtDate(o.recordedAt)}
                  </Badge>
                ))}
              </div>
            )}
            <ul className="space-y-1.5">
              {lead.activities.map((a) => (
                <li key={a.id} className="flex gap-2 text-[12.5px]">
                  <span className="tnum w-28 shrink-0 text-ink-3">{fmtDate(a.createdAt, true)}</span>
                  <span className={clsx(a.actor === 'system' ? 'text-ink-3' : 'text-ink-2')}>{a.summary}</span>
                </li>
              ))}
              {lead.activities.length === 0 && <li className="text-[12px] text-ink-3">No activity yet.</li>}
            </ul>
          </Panel>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {lead.components && <ComponentsCard components={lead.components.components} leadFit={lead.leadFit} completeness={lead.components.dataCompleteness} reasons={lead.priorityReasons} priority={lead.priority} />}
          <SalesPotentialCard sp={lead.salesPotential} />
          <Panel title="Contacts" actions={<Button size="sm" variant="ghost" onClick={() => setContactOpen(true)}>Add</Button>}>
            <ul className="space-y-2">
              {c.contacts.map((x) => (
                <li key={x.id} className={clsx('text-[12.5px]', x.expiredAt && 'opacity-50')}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 break-all font-medium">
                      <span className="mr-1 text-[11px] font-normal text-ink-3">{x.subtype ?? x.type}</span>
                      {x.type === 'contact_form' || x.type === 'social' ? (
                        <a className="text-accent hover:underline" href={x.value} target="_blank" rel="noopener noreferrer">
                          {x.value.replace(/^https?:\/\//, '')}
                        </a>
                      ) : (
                        x.value
                      )}
                    </span>
                    <ContactStatusBadge status={x.status} />
                  </div>
                  <div className="text-[11px] text-ink-3">
                    {providerName(x.source)}
                    {x.sourceUrl && (
                      <>
                        {' · '}
                        <a className="hover:underline" href={x.sourceUrl} target="_blank" rel="noopener noreferrer">
                          source
                        </a>
                      </>
                    )}{' '}
                    · verified {relTime(x.lastVerifiedAt)}
                    {x.isRoleBased && ' · role address'}
                    {x.isPersonal && ' · personal — handle per GDPR'}
                    {x.expiredAt && ' · expired (retention)'}
                  </div>
                </li>
              ))}
              {c.contacts.length === 0 && <li className="text-[12px] text-ink-3">No public contacts found. Nothing is guessed.</li>}
            </ul>
          </Panel>
          <Panel title="Sources & provenance">
            <ul className="space-y-2 text-[12px]">
              {c.sourceRecords.map((s) => (
                <li key={s.id}>
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{providerName(s.provider)}</span>
                    <span className="text-ink-3">{relTime(s.fetchedAt)}</span>
                  </div>
                  {s.purgedAt ? (
                    <div className="text-ink-3">Content purged per provider retention policy (ID kept).</div>
                  ) : (
                    <div className="text-ink-2">
                      {[s.name, s.address, s.phone].filter(Boolean).join(' · ')}
                      {s.profileUrl && (
                        <a href={s.profileUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-accent hover:underline">
                          listing
                        </a>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {c.discrepancies.length > 0 && (
              <div className="mt-3 rounded-md border border-warn/40 bg-warn-soft p-2.5">
                <div className="mb-1 flex items-center gap-1 text-[12px] font-medium text-warn">
                  <AlertTriangle className="size-3.5" /> Conflicting data
                </div>
                {c.discrepancies.map((dd, i) => (
                  <div key={i} className="mb-1.5 text-[12px]">
                    <div className="font-medium capitalize">{dd.field}</div>
                    {dd.values.map((v, j) => (
                      <div key={j} className="text-ink-2">
                        {v.value} — {v.sources.map((s) => providerName(s.provider)).join(', ')}
                      </div>
                    ))}
                    {dd.note && <div className="text-[11px] text-ink-3">{dd.note}</div>}
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3 text-[11px] text-ink-3">
              First seen {fmtDate(c.firstSeenAt)} · last verified {relTime(c.lastVerifiedAt)} · status {c.businessStatus.replace('_', ' ')}
            </div>
          </Panel>
          {c.website && (
            <Panel title="Website discovery">
              <div className="text-[12px] text-ink-2">
                {c.website.status === 'found' ? `Official website (${c.website.confidence} confidence) via ${providerName(c.website.discoverySource ?? '')}.` : c.website.notFoundReason}
              </div>
              <ul className="mt-2 space-y-1">
                {c.website.discoveryLog.map((l, i) => (
                  <li key={i} className="text-[11.5px]">
                    <Badge tone={l.verdict === 'accepted' ? 'ok' : l.verdict === 'rejected' ? 'bad' : 'warn'}>{l.verdict}</Badge> <span className="break-all text-ink-2">{l.url}</span>
                    <div className="text-ink-3">{l.reasons.join('; ')}</div>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          {lead.campaignLeads.length > 0 && (
            <Panel title="Campaigns">
              <ul className="space-y-1 text-[12.5px]">
                {lead.campaignLeads.map((cl) => (
                  <li key={cl.campaign.id}>
                    <Link className="text-accent hover:underline" to={`/campaigns/${cl.campaign.id}`}>
                      {cl.campaign.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      </div>

      {/* Dialogs */}
      <Dialog open={!!shot} onClose={() => setShot(null)} title={shot ? `${shot.viewport} · ${shot.kind}` : ''} width="max-w-5xl">
        {shot && (
          <div className="max-h-[75vh] overflow-auto">
            <img src={shotUrl(shot)} alt="Screenshot" className="mx-auto" />
            <div className="mt-2 text-[11.5px] text-ink-3">{shot.pageUrl}</div>
          </div>
        )}
      </Dialog>
      <Dialog open={!!auditView} onClose={() => setAuditView(null)} title="Audit" width="max-w-3xl">
        <pre className="scroll-thin max-h-[70vh] overflow-auto whitespace-pre-wrap font-[inherit] text-[12.5px] leading-relaxed">{auditView?.markdown}</pre>
      </Dialog>
      <FollowUpDialog open={followOpen} onClose={() => setFollowOpen(false)} leadId={lead.id} onDone={invalidate} />
      <OutcomeDialog open={outcomeOpen} onClose={() => setOutcomeOpen(false)} leadId={lead.id} services={services} onDone={invalidate} />
      <ContactDialog open={contactOpen} onClose={() => setContactOpen(false)} leadId={lead.id} onDone={invalidate} />
    </div>
  );
}

function FollowUpDialog({ open, onClose, leadId, onDone }: { open: boolean; onClose: () => void; leadId: string; onDone: () => void }) {
  const [days, setDays] = useState('3');
  const [date, setDate] = useState('');
  const [noteText, setNoteText] = useState('');
  const m = useMutation({
    mutationFn: () => {
      const due = date ? new Date(`${date}T09:00:00`) : new Date(Date.now() + Number(days) * 86_400_000);
      return api(`/api/leads/${leadId}/followups`, { body: { dueAt: due.toISOString(), note: noteText || undefined } });
    },
    onSuccess: () => {
      toast.ok('Follow-up scheduled');
      onDone();
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Schedule follow-up" footer={<Button variant="primary" onClick={() => m.mutate()} loading={m.isPending}>Schedule</Button>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="In">
          <Select value={days} onChange={(e) => setDays(e.target.value)}>
            {['1', '2', '3', '5', '7', '14', '30'].map((d) => (
              <option key={d} value={d}>
                {d} day(s)
              </option>
            ))}
          </Select>
        </Field>
        <Field label="…or on date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Note" className="md:col-span-2">
          <Input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Ask whether they saw the audit" />
        </Field>
      </div>
    </Dialog>
  );
}

function OutcomeDialog({ open, onClose, leadId, services, onDone }: { open: boolean; onClose: () => void; leadId: string; services: Array<{ slug: string; name: string }>; onDone: () => void }) {
  const [type, setType] = useState<string>('replied');
  const [value, setValue] = useState('');
  const [svc, setSvc] = useState('');
  const [notes, setNotes] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/api/leads/${leadId}/outcomes`, { body: { type, dealValue: value ? Number(value) : undefined, serviceSlug: svc || undefined, notes: notes || undefined } }),
    onSuccess: () => {
      toast.ok('Outcome recorded — it feeds the learning loop');
      onDone();
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Record outcome" footer={<Button variant="primary" onClick={() => m.mutate()} loading={m.isPending}>Save</Button>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Outcome">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            {OUTCOME_TYPES.map((t) => (
              <option key={t} value={t}>
                {OUTCOME_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Deal value (optional)">
          <Input type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Service (optional)">
          <Select value={svc} onChange={(e) => setSvc(e.target.value)}>
            <option value="">Recommended service</option>
            {services.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <p className="mt-3 text-[11.5px] text-ink-3">Stage updates automatically ({stageLabel('replied')}, {stageLabel('meeting')}, {stageLabel('won')}…). Outcomes are used to train your own model once there is enough data.</p>
    </Dialog>
  );
}

function ContactDialog({ open, onClose, leadId, onDone }: { open: boolean; onClose: () => void; leadId: string; onDone: () => void }) {
  const [type, setType] = useState('email');
  const [value, setValue] = useState('');
  const [personName, setPersonName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/api/leads/${leadId}/contacts`, { body: { type, value, personName: personName || undefined, sourceUrl: sourceUrl || undefined } }),
    onSuccess: () => {
      toast.ok('Contact added (status: probable)');
      onDone();
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open={open} onClose={onClose} title="Add a public contact" footer={<Button variant="primary" onClick={() => m.mutate()} loading={m.isPending}>Add</Button>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="email">E-mail</option>
            <option value="phone">Phone</option>
            <option value="contact_form">Contact form URL</option>
            <option value="social">Social profile URL</option>
          </Select>
        </Field>
        <Field label="Value">
          <Input value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Person (optional)">
          <Input value={personName} onChange={(e) => setPersonName(e.target.value)} />
        </Field>
        <Field label="Where you found it (URL)">
          <Input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
        </Field>
      </div>
      <p className="mt-3 text-[11.5px] text-ink-3">Only add publicly published business contacts. Manually added contacts are marked “probable”.</p>
    </Dialog>
  );
}
