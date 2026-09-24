import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, ExternalLink, Pause, Play, RotateCcw, Square } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { SEARCH_STAGE_LABELS, type SearchCounts, type ProviderRunStat } from '../../domain/types';
import { api } from '../lib/api';
import { fmtDate, hostname, relTime, titleCase } from '../lib/format';
import { ContactBadge, FreshnessBadge, PriorityBadge } from '../components/domain';
import { Badge, Button, EmptyState, ErrorState, PageHeader, Panel, SkeletonRows, Stat, toast } from '../components/ui';

interface JobDetail {
  id: string;
  status: string;
  stage: string;
  control: string;
  trigger: string;
  params: { niche: string; location: string; country: string; service?: string; quantity: number };
  progress: Record<string, { done: number; total: number } | unknown>;
  counts: Partial<SearchCounts>;
  sourcesUsed: Record<string, ProviderRunStat>;
  strategyLog: Array<{ at: string; message: string }>;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  campaign: { id: string; name: string } | null;
  queries: Array<{ id: string; text: string; language: string; strategy: string; status: string; resultsCount: number; newRecordsCount: number; error: string | null }>;
  queue: { status: string; attempts: number; maxAttempts: number; lastError: string | null } | null;
}

interface ResultRow {
  id: string;
  company: string;
  city: string | null;
  website: string | null;
  websiteStatus: string;
  priority: string | null;
  mainOpportunity: string | null;
  recommendedService: string | null;
  contactAvailability: string | null;
  freshness: number | null;
  leadFit: number | null;
  excludedReason: string | null;
  analyzedAt: string | null;
}

const STEPS = ['planning', 'discovering', 'merging', 'verifying', 'website_discovery', 'analyzing', 'contacts', 'qualifying', 'reporting'] as const;

export default function JobResults() {
  const { id } = useParams();
  const qc = useQueryClient();
  const job = useQuery({
    queryKey: ['job', id],
    queryFn: () => api<JobDetail>(`/api/search-jobs/${id}`),
    refetchInterval: (q) => (['queued', 'running'].includes(q.state.data?.status ?? 'queued') ? 2000 : false),
  });
  const running = ['queued', 'running'].includes(job.data?.status ?? '');
  const results = useQuery({
    queryKey: ['job-results', id],
    queryFn: () => api<{ counts: SearchCounts; rows: ResultRow[] }>(`/api/search-jobs/${id}/results`, { query: { limit: 500 } }),
    refetchInterval: running ? 5000 : false,
  });
  const control = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'cancel' | 'retry') => api(`/api/search-jobs/${id}/${action}`, { method: 'POST', body: {} }),
    onSuccess: (_d, a) => {
      toast.ok(`Job ${a === 'resume' || a === 'retry' ? 're-queued' : a === 'pause' ? 'pausing…' : 'cancelling…'}`);
      void qc.invalidateQueries({ queryKey: ['job', id] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (job.isLoading) return <SkeletonRows rows={10} />;
  if (job.error) return <ErrorState error={job.error} retry={() => job.refetch()} />;
  const j = job.data!;
  const c = (results.data?.counts ?? j.counts) as Partial<SearchCounts>;
  const stageIdx = STEPS.indexOf(j.stage as (typeof STEPS)[number]);
  const prog = (s: string) => j.progress[s] as { done: number; total: number } | undefined;
  const statusTone = j.status === 'completed' ? 'ok' : j.status === 'failed' ? 'bad' : j.status === 'cancelled' ? 'neutral' : j.status === 'paused' ? 'warn' : 'accent';

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {j.params.quantity} × {j.params.niche} · {j.params.location}, {j.params.country}
            <Badge tone={statusTone}>{j.status}</Badge>
          </span>
        }
        subtitle={
          <>
            {j.params.service ? `For “${j.params.service}” · ` : ''}
            {j.campaign && (
              <Link className="text-accent hover:underline" to={`/campaigns/${j.campaign.id}`}>
                {j.campaign.name}
              </Link>
            )}{' '}
            · started {relTime(j.startedAt ?? j.createdAt)}
            {j.finishedAt && ` · finished ${fmtDate(j.finishedAt, true)}`}
          </>
        }
        actions={
          <>
            {j.status === 'running' && (
              <Button icon={<Pause className="size-3.5" />} onClick={() => control.mutate('pause')} disabled={j.control === 'pause'}>
                Pause
              </Button>
            )}
            {j.status === 'paused' && (
              <Button icon={<Play className="size-3.5" />} onClick={() => control.mutate('resume')}>
                Resume
              </Button>
            )}
            {['failed', 'cancelled'].includes(j.status) && (
              <Button icon={<RotateCcw className="size-3.5" />} onClick={() => control.mutate('retry')}>
                Retry
              </Button>
            )}
            {['running', 'queued', 'paused'].includes(j.status) && (
              <Button variant="danger" icon={<Square className="size-3.5" />} onClick={() => control.mutate('cancel')} disabled={j.control === 'cancel'}>
                Cancel
              </Button>
            )}
            {j.campaign && (
              <Link to={`/leads?campaignId=${j.campaign.id}`}>
                <Button variant="primary">Open in lead table</Button>
              </Link>
            )}
          </>
        }
      />
      {j.error && <ErrorState error={new Error(j.error)} />}

      <Panel bodyClassName="p-3">
        <ol className="grid grid-cols-3 gap-1 md:grid-cols-9">
          {STEPS.map((s, i) => {
            const done = j.status === 'completed' || i < stageIdx;
            const current = i === stageIdx && j.status !== 'completed';
            const pr = prog(s);
            return (
              <li key={s} className={clsx('rounded-md px-2 py-1.5 text-[11.5px]', current ? 'bg-accent-soft text-accent' : done ? 'text-ink-2' : 'text-ink-3')}>
                <div className="flex items-center gap-1 font-medium">
                  {done ? <Check className="size-3 text-ok" /> : current ? <span className="size-1.5 animate-pulse rounded-full bg-accent" /> : <span className="size-1.5 rounded-full bg-line-strong" />}
                  {SEARCH_STAGE_LABELS[s]}
                </div>
                {pr && pr.total > 0 && (
                  <div className="tnum mt-0.5 text-[10.5px] opacity-80">
                    {pr.done}/{pr.total}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </Panel>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="Found" value={c.found ?? 0} hint="source records" />
        <Stat label="Valid businesses" value={c.valid ?? 0} hint={`${c.duplicatesMerged ?? 0} duplicates merged`} />
        <Stat label="Websites" value={c.websites ?? 0} hint={`${c.noWebsite ?? 0} without`} />
        <Stat label="Analyzed" value={c.analyzed ?? 0} hint={c.analysisFailed ? `${c.analysisFailed} unreachable/failed` : 'live'} />
        <Stat label="Very high" value={c.veryHigh ?? 0} tone="accent" />
        <Stat label="High" value={c.high ?? 0} tone="ok" />
        <Stat label="Medium" value={c.medium ?? 0} />
        <Stat label="Low" value={c.low ?? 0} hint={`${c.excluded ?? 0} excluded · ${c.insufficient ?? 0} insufficient`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel title={`Results (${results.data?.rows.length ?? 0})`} bodyClassName="p-0" className="min-w-0">
          {results.isLoading ? (
            <div className="p-4">
              <SkeletonRows />
            </div>
          ) : !results.data?.rows.length ? (
            <EmptyState title={running ? 'Working on it…' : 'No leads in this job'}>{running ? 'Leads appear here as they are merged and qualified.' : 'Check the strategy log for provider errors or configure more sources in Settings.'}</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead className="bg-panel-2 text-left text-[11px] uppercase tracking-wide text-ink-3">
                  <tr>
                    {['Company', 'Location', 'Website', 'Priority', 'Main opportunity', 'Recommended service', 'Contact', 'Freshness', 'Evidence'].map((h) => (
                      <th key={h} className="px-3 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.data.rows.map((r) => (
                    <tr key={r.id} className="border-t border-line hover:bg-sunken/60">
                      <td className="px-3 py-2 font-medium">
                        <Link to={`/leads/${r.id}`} className="hover:underline">
                          {r.company}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-ink-2">{r.city}</td>
                      <td className="px-3 py-2">
                        {r.website ? (
                          <a href={r.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ink-2 hover:text-accent">
                            {hostname(r.website)} <ExternalLink className="size-3" />
                          </a>
                        ) : (
                          <span className="text-ink-3">{r.websiteStatus === 'not_found' ? 'none found' : '—'}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <PriorityBadge priority={r.priority} />
                      </td>
                      <td className="max-w-[220px] truncate px-3 py-2 text-ink-2" title={r.mainOpportunity ?? ''}>
                        {r.mainOpportunity ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-ink-2">{r.recommendedService ? titleCase(r.recommendedService) : '—'}</td>
                      <td className="px-3 py-2">
                        <ContactBadge availability={r.contactAvailability} />
                      </td>
                      <td className="px-3 py-2">
                        <FreshnessBadge value={r.freshness} />
                      </td>
                      <td className="px-3 py-2">
                        <Link to={`/leads/${r.id}#evidence`} className="text-accent hover:underline">
                          {r.analyzedAt ? 'View' : '—'}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="Sources used">
            {Object.values(j.sourcesUsed ?? {}).length === 0 ? (
              <div className="text-[12px] text-ink-3">Not queried yet.</div>
            ) : (
              <ul className="space-y-2">
                {Object.values(j.sourcesUsed).map((s) => (
                  <li key={s.provider} className="text-[12.5px]">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{s.name}</span>
                      <Badge tone={s.status === 'ok' ? 'ok' : s.status === 'partial' ? 'warn' : 'bad'}>{s.status}</Badge>
                    </div>
                    <div className="tnum text-[11.5px] text-ink-3">
                      {s.records} records · {s.calls} calls{s.errors ? ` · ${s.errors} errors` : ''}
                    </div>
                    {s.lastError && <div className="text-[11.5px] text-bad">{s.lastError}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Strategy log">
            <ul className="scroll-thin max-h-72 space-y-1.5 overflow-y-auto text-[12px] text-ink-2">
              {j.strategyLog.map((l, i) => (
                <li key={i}>
                  <span className="tnum mr-1.5 text-ink-3">{new Date(l.at).toLocaleTimeString()}</span>
                  {l.message}
                </li>
              ))}
              {j.strategyLog.length === 0 && <li className="text-ink-3">Waiting for the worker…</li>}
            </ul>
          </Panel>
          <Panel title={`Queries (${j.queries.length})`}>
            <ul className="scroll-thin max-h-64 space-y-1 overflow-y-auto text-[12px]">
              {j.queries.map((q) => (
                <li key={q.id} className="flex items-center justify-between gap-2">
                  <span className="truncate text-ink-2" title={`${q.strategy} · ${q.language}`}>
                    {q.text}
                  </span>
                  <span className="tnum shrink-0 text-ink-3" title={q.error ?? ''}>
                    {q.status === 'pending' ? '…' : `${q.resultsCount} (${q.newRecordsCount} new)`}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
