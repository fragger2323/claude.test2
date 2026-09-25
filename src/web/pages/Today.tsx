import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, Brain, Rocket } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { fmtDate, relTime, titleCase } from '../lib/format';
import { PriorityBadge } from '../components/domain';
import { Badge, Button, EmptyState, ErrorState, PageHeader, Panel, SkeletonRows } from '../components/ui';

interface MiniLead {
  id: string;
  stage: string;
  priority: string | null;
  leadFit: number | null;
  mainOpportunity: string | null;
  primaryServiceSlug: string | null;
  stageChangedAt: string;
  company: { name: string; city: string | null; industry: string | null; website?: { url: string | null; status: string } | null };
}
interface TodayData {
  date: string;
  newBestLeads: MiniLead[];
  followUpsDue: Array<{ id: string; dueAt: string; note: string | null; overdue: boolean; lead: MiniLead }>;
  replies: MiniLead[];
  meetings: MiniLead[];
  proposals: MiniLead[];
  recentlyWon: Array<{ id: string; recordedAt: string; dealValue: number | null; lead: MiniLead }>;
  needsReview: MiniLead[];
  recommendedActions: Array<{ id: string; title: string; detail: string; count: number; link: string; urgency: 'high' | 'medium' | 'low' }>;
  learning: { labelledOutcomes: number; needed: number };
}

function LeadList({ leads, empty, meta }: { leads: MiniLead[]; empty: string; meta?: (l: MiniLead) => ReactNode }) {
  if (!leads.length) return <div className="py-3 text-[12px] text-ink-3">{empty}</div>;
  return (
    <ul className="divide-y divide-line">
      {leads.map((l) => (
        <li key={l.id}>
          <Link to={`/leads/${l.id}`} className="flex items-center justify-between gap-2 py-2 hover:bg-sunken/50">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium">{l.company.name}</div>
              <div className="truncate text-[11.5px] text-ink-3">{meta ? meta(l) : [l.company.city, l.mainOpportunity].filter(Boolean).join(' · ')}</div>
            </div>
            <PriorityBadge priority={l.priority} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function Today() {
  const q = useQuery({ queryKey: ['today'], queryFn: () => api<TodayData>('/api/today'), refetchInterval: 60_000 });
  const onboarding = useQuery({ queryKey: ['onboarding'], queryFn: () => api<{ completed: boolean; steps: Record<string, { done: boolean }> }>('/api/onboarding') });
  if (q.isLoading) return <SkeletonRows rows={10} />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const t = q.data!;
  const empty = !t.newBestLeads.length && !t.followUpsDue.length && !t.replies.length && !t.meetings.length && !t.proposals.length;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Today"
        subtitle={fmtDate(t.date)}
        actions={
          <Link to="/search">
            <Button variant="primary" icon={<Rocket className="size-4" />}>
              Find new leads
            </Button>
          </Link>
        }
      />
      {onboarding.data && !onboarding.data.completed && (
        <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent-soft px-4 py-3 text-[13px]">
          <span>
            Finish setup: {Object.entries(onboarding.data.steps).filter(([, s]) => !s.done).map(([k]) => titleCase(k)).join(', ') || 'review your settings'}.
          </span>
          <Link to="/onboarding">
            <Button size="sm">Open setup</Button>
          </Link>
        </div>
      )}

      <Panel title="Recommended actions" actions={<span className="text-[11.5px] text-ink-3">Rules over your real CRM data</span>}>
        {t.recommendedActions.length === 0 ? (
          <div className="text-[12.5px] text-ink-3">Nothing needs attention right now.</div>
        ) : (
          <ul className="space-y-2">
            {t.recommendedActions.map((a) => (
              <li key={a.id}>
                <Link to={a.link} className="flex items-center gap-3 rounded-md border border-line px-3 py-2 hover:bg-sunken/60">
                  <span className={clsx('size-2 shrink-0 rounded-full', a.urgency === 'high' ? 'bg-bad' : a.urgency === 'medium' ? 'bg-warn' : 'bg-ink-3')} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium">{a.title}</div>
                    <div className="truncate text-[12px] text-ink-3">{a.detail}</div>
                  </div>
                  <ArrowRight className="size-4 text-ink-3" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {empty && (
        <Panel>
          <EmptyState title="Your pipeline is empty" action={<Link to="/search"><Button variant="primary">Run your first search</Button></Link>}>
            Enter a niche, city, country and the service you sell — the system discovers, verifies and analyses companies for you.
          </EmptyState>
        </Panel>
      )}

      {(() => {
        // Only sections with something in them get a card; empty ones collapse into one line.
        const sections: Array<{ key: string; title: string; count: number; node: ReactNode }> = [
          { key: 'best', title: 'New best leads', count: t.newBestLeads.length, node: <LeadList leads={t.newBestLeads} empty="" meta={(l) => [l.company.city, l.primaryServiceSlug && titleCase(l.primaryServiceSlug), l.mainOpportunity].filter(Boolean).join(' · ')} /> },
          {
            key: 'followups',
            title: 'Follow-ups due',
            count: t.followUpsDue.length,
            node: (
              <ul className="divide-y divide-line">
                {t.followUpsDue.map((f) => (
                  <li key={f.id}>
                    <Link to={`/leads/${f.lead.id}`} className="flex items-center justify-between gap-2 py-2 hover:bg-sunken/50">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium">{f.lead.company.name}</div>
                        <div className="truncate text-[11.5px] text-ink-3">{f.note ?? 'Follow up'}</div>
                      </div>
                      <Badge tone={f.overdue ? 'bad' : 'info'}>{f.overdue ? `overdue ${relTime(f.dueAt)}` : 'today'}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            ),
          },
          { key: 'replies', title: 'Replies', count: t.replies.length, node: <LeadList leads={t.replies} empty="" meta={(l) => `replied ${relTime(l.stageChangedAt)}`} /> },
          { key: 'meetings', title: 'Meetings', count: t.meetings.length, node: <LeadList leads={t.meetings} empty="" meta={(l) => `since ${fmtDate(l.stageChangedAt)}`} /> },
          { key: 'proposals', title: 'Proposals', count: t.proposals.length, node: <LeadList leads={t.proposals} empty="" meta={(l) => `sent ${relTime(l.stageChangedAt)}`} /> },
          {
            key: 'won',
            title: 'Won (30 days)',
            count: t.recentlyWon.length,
            node: (
              <ul className="divide-y divide-line">
                {t.recentlyWon.map((w) => (
                  <li key={w.id} className="flex items-center justify-between py-2 text-[13px]">
                    <Link className="font-medium hover:underline" to={`/leads/${w.lead.id}`}>
                      {w.lead.company.name}
                    </Link>
                    <span className="tnum text-ink-3">{w.dealValue ?? ''} · {fmtDate(w.recordedAt)}</span>
                  </li>
                ))}
              </ul>
            ),
          },
        ];
        const filled = sections.filter((x) => x.count > 0);
        const idle = sections.filter((x) => x.count === 0);
        return (
          <>
            {filled.length > 0 && (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                {filled.map((x) => (
                  <Panel key={x.key} title={`${x.title} (${x.count})`}>
                    {x.node}
                  </Panel>
                ))}
              </div>
            )}
            {idle.length > 0 && (
              <p className="text-[12px] text-ink-3">
                Nothing waiting in: {idle.map((x) => x.title).join(' · ')}.
              </p>
            )}
          </>
        );
      })()}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Panel title={`Leads requiring review (${t.needsReview.length})`}>
          <LeadList leads={t.needsReview} empty="Nothing to review." meta={(l) => (l.company.website?.status === 'unverified' ? 'website not verified — add it or configure web search' : l.priority === 'insufficient_data' ? 'insufficient data — run analysis' : 'website unreachable or conflicting data')} />
        </Panel>
        <Panel title="Learning" actions={<Brain className="size-4 text-ink-3" />}>
          <div className="tnum text-xl font-semibold">
            {t.learning.labelledOutcomes}/{t.learning.needed}
          </div>
          <div className="text-[12px] text-ink-3">contacted leads with a recorded outcome. A calibrated model is trained only after enough of your own results.</div>
          <Link to="/learning" className="mt-2 inline-block text-[12px] text-accent hover:underline">
            Learn from my outcomes →
          </Link>
        </Panel>
      </div>
    </div>
  );
}
