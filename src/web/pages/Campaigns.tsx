import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api } from '../lib/api';
import { fmtDate, pct } from '../lib/format';
import { Badge, Button, EmptyState, ErrorState, PageHeader, Panel, SkeletonRows, Stat } from '../components/ui';
import { FunnelTable, RateCell, type DashboardData } from './Dashboard';

interface CampaignRow {
  id: string;
  name: string;
  industry: string;
  location: string;
  country: string;
  serviceSlug: string | null;
  targetLeads: number;
  status: string;
  createdAt: string;
  _count: { campaignLeads: number; searchJobs: number };
  stats?: { funnel: DashboardData['funnel']; rates: DashboardData['rates'] };
}

function CampaignDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['campaign', id], queryFn: () => api<{ campaign: CampaignRow & { searchJobs: Array<{ id: string; status: string; createdAt: string; counts: Record<string, number>; trigger: string }> }; stats: DashboardData }>(`/api/campaigns/${id}`) });
  if (q.isLoading) return <SkeletonRows rows={8} />;
  if (q.error) return <ErrorState error={q.error} />;
  const { campaign: c, stats } = q.data!;
  return (
    <div className="space-y-4">
      <PageHeader
        title={c.name}
        subtitle={`${c.industry} · ${c.location}, ${c.country}${c.serviceSlug ? ` · ${c.serviceSlug}` : ''} · target ${c.targetLeads}`}
        actions={
          <>
            <Link to={`/leads?campaignId=${c.id}`}>
              <Button>Leads</Button>
            </Link>
            <Link to={`/search?campaignId=${c.id}&niche=${encodeURIComponent(c.industry)}&location=${encodeURIComponent(c.location)}&country=${encodeURIComponent(c.country)}`}>
              <Button variant="primary">Run another search</Button>
            </Link>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="Leads" value={stats.funnel.discovered} />
        <Stat label="Qualified" value={stats.funnel.qualified} />
        <Stat label="Contacted" value={stats.funnel.contacted} />
        <Stat label="Replies" value={stats.funnel.replies} />
        <Stat label="Won" value={stats.funnel.won} tone="ok" />
        <Stat label="Reply rate" value={stats.rates.replyRate.value != null ? pct(stats.rates.replyRate.value) : '—'} hint={stats.rates.replyRate.sufficient ? `n=${stats.rates.replyRate.n}` : `insufficient data (n=${stats.rates.replyRate.n})`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Funnel">
          <FunnelTable funnel={stats.funnel} />
        </Panel>
        <Panel title="Search runs">
          <ul className="space-y-1.5 text-[12.5px]">
            {c.searchJobs.map((j) => (
              <li key={j.id} className="flex items-center justify-between">
                <Link className="text-accent hover:underline" to={`/jobs/${j.id}`}>
                  {fmtDate(j.createdAt, true)} · {j.trigger}
                </Link>
                <span className="flex items-center gap-2 text-ink-3">
                  {j.counts?.valid ?? 0} valid · {(j.counts?.veryHigh ?? 0) + (j.counts?.high ?? 0)} high
                  <Badge tone={j.status === 'completed' ? 'ok' : j.status === 'failed' ? 'bad' : 'neutral'}>{j.status}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

export default function Campaigns() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['campaigns'], queryFn: () => api<CampaignRow[]>('/api/campaigns'), enabled: !id });
  if (id) return <CampaignDetail id={id} />;
  if (q.isLoading) return <SkeletonRows rows={8} />;
  if (q.error) return <ErrorState error={q.error} />;
  const rows = q.data!;
  return (
    <div className="space-y-4">
      <PageHeader title="Campaigns" subtitle="Every search belongs to a campaign, so you can compare niches, cities and services." actions={<Link to="/search"><Button variant="primary">New search</Button></Link>} />
      <Panel bodyClassName="p-0">
        {rows.length === 0 ? (
          <EmptyState title="No campaigns yet">A campaign is created automatically with your first search.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead className="bg-panel-2 text-left text-[11px] uppercase text-ink-3">
                <tr>
                  {['Campaign', 'Niche · location', 'Leads', 'Qualified', 'Contacted', 'Reply rate', 'Meetings', 'Won', 'Created'].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-t border-line hover:bg-sunken/50">
                    <td className="px-3 py-2 font-medium">
                      <Link to={`/campaigns/${c.id}`} className="hover:underline">
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-ink-2">
                      {c.industry} · {c.location}
                    </td>
                    <td className="tnum px-3 py-2">{c.stats?.funnel.discovered ?? c._count.campaignLeads}</td>
                    <td className="tnum px-3 py-2">{c.stats?.funnel.qualified ?? '—'}</td>
                    <td className="tnum px-3 py-2">{c.stats?.funnel.contacted ?? '—'}</td>
                    <td className="px-3 py-2">{c.stats ? <RateCell rate={c.stats.rates.replyRate} /> : '—'}</td>
                    <td className="tnum px-3 py-2">{c.stats?.funnel.meetings ?? '—'}</td>
                    <td className="tnum px-3 py-2">{c.stats?.funnel.won ?? '—'}</td>
                    <td className="px-3 py-2 text-ink-3">{fmtDate(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
