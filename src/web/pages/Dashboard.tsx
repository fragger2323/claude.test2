import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { pct, providerName, titleCase } from '../lib/format';
import { ErrorState, PageHeader, Panel, Select, SkeletonRows, Stat } from '../components/ui';

export interface Rate {
  value: number | null;
  numerator: number;
  n: number;
  sufficient: boolean;
}
export interface Perf {
  key: string;
  leads: number;
  qualified: number;
  highPriority: number;
  contacted: number;
  replyRate: Rate;
  winRate: Rate;
  won: number;
}
export interface DashboardData {
  funnel: { discovered: number; websitesFound: number; verified: number; analyzed: number; qualified: number; contactReady: number; contacted: number; replies: number; meetings: number; proposals: number; won: number; lost: number };
  rates: { replyRate: Rate; meetingRate: Rate; proposalRate: Rate; winRate: Rate };
  sourcePerformance: Perf[];
  serviceDemand: Perf[];
  industryPerformance: Perf[];
  locationPerformance: Perf[];
  minN: number;
}

export function RateCell({ rate }: { rate: Rate }) {
  if (!rate.sufficient) return <span className="text-[11.5px] text-ink-3" title="Not enough data for a meaningful rate">n={rate.n} · insufficient</span>;
  return (
    <span className="tnum">
      {pct(rate.value)} <span className="text-[11px] text-ink-3">({rate.numerator}/{rate.n})</span>
    </span>
  );
}

export function FunnelTable({ funnel }: { funnel: DashboardData['funnel'] }) {
  const steps: Array<[string, number]> = [
    ['Discovered', funnel.discovered],
    ['Websites found', funnel.websitesFound],
    ['Verified', funnel.verified],
    ['Analyzed', funnel.analyzed],
    ['Qualified', funnel.qualified],
    ['Contact ready', funnel.contactReady],
    ['Contacted', funnel.contacted],
    ['Replies', funnel.replies],
    ['Meetings', funnel.meetings],
    ['Proposals', funnel.proposals],
    ['Won', funnel.won],
    ['Lost', funnel.lost],
  ];
  const max = Math.max(1, funnel.discovered);
  return (
    <ul className="space-y-1">
      {steps.map(([label, v]) => (
        <li key={label} className="grid grid-cols-[120px_1fr_48px] items-center gap-2 text-[12.5px]">
          <span className="text-ink-2">{label}</span>
          <div className="h-2 overflow-hidden rounded-full bg-sunken">
            <div className="h-full rounded-full bg-accent/70" style={{ width: `${(v / max) * 100}%` }} />
          </div>
          <span className="tnum text-right">{v}</span>
        </li>
      ))}
    </ul>
  );
}

function PerfTable({ rows, label, nameFor }: { rows: Perf[]; label: string; nameFor?: (k: string) => string }) {
  if (!rows.length) return <div className="text-[12px] text-ink-3">No data yet.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead className="text-left text-[11px] uppercase text-ink-3">
          <tr>
            <th className="py-1.5 pr-3 font-medium">{label}</th>
            <th className="py-1.5 pr-3 font-medium">Leads</th>
            <th className="py-1.5 pr-3 font-medium">High</th>
            <th className="py-1.5 pr-3 font-medium">Contacted</th>
            <th className="py-1.5 pr-3 font-medium">Reply rate</th>
            <th className="py-1.5 font-medium">Won</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 12).map((r) => (
            <tr key={r.key} className="border-t border-line">
              <td className="py-1.5 pr-3">{nameFor ? nameFor(r.key) : r.key}</td>
              <td className="tnum py-1.5 pr-3">{r.leads}</td>
              <td className="tnum py-1.5 pr-3">{r.highPriority}</td>
              <td className="tnum py-1.5 pr-3">{r.contacted}</td>
              <td className="py-1.5 pr-3">
                <RateCell rate={r.replyRate} />
              </td>
              <td className="tnum py-1.5">{r.won}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Dashboard() {
  const [campaignId, setCampaignId] = useState('');
  const campaigns = useQuery({ queryKey: ['campaigns-min'], queryFn: () => api<Array<{ id: string; name: string }>>('/api/campaigns') });
  const q = useQuery({ queryKey: ['dashboard', campaignId], queryFn: () => api<DashboardData>('/api/dashboard', { query: { campaignId } }) });
  if (q.isLoading) return <SkeletonRows rows={10} />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data!;
  const r = d.rates;
  const rateVal = (x: Rate) => (x.sufficient ? pct(x.value) : '—');
  const rateHint = (x: Rate) => (x.sufficient ? `${x.numerator}/${x.n}` : `insufficient data (n=${x.n}, need ${d.minN})`);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Dashboard"
        subtitle="Real numbers from your data only. Rates appear once a group has enough contacted leads."
        actions={
          <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} aria-label="Campaign">
            <option value="">All campaigns</option>
            {campaigns.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Total discovered" value={d.funnel.discovered} />
        <Stat label="Websites found" value={d.funnel.websitesFound} />
        <Stat label="Analyzed" value={d.funnel.analyzed} />
        <Stat label="Qualified" value={d.funnel.qualified} />
        <Stat label="Contact ready" value={d.funnel.contactReady} />
        <Stat label="Contacted" value={d.funnel.contacted} />
        <Stat label="Replies" value={d.funnel.replies} />
        <Stat label="Meetings" value={d.funnel.meetings} />
        <Stat label="Proposals" value={d.funnel.proposals} />
        <Stat label="Won" value={d.funnel.won} tone="ok" />
        <Stat label="Lost" value={d.funnel.lost} />
        <Stat label="Verified" value={d.funnel.verified} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Reply rate" value={rateVal(r.replyRate)} hint={rateHint(r.replyRate)} />
        <Stat label="Meeting rate" value={rateVal(r.meetingRate)} hint={rateHint(r.meetingRate)} />
        <Stat label="Proposal rate" value={rateVal(r.proposalRate)} hint={rateHint(r.proposalRate)} />
        <Stat label="Win rate" value={rateVal(r.winRate)} hint={rateHint(r.winRate)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Funnel">
          <FunnelTable funnel={d.funnel} />
        </Panel>
        <Panel title="Lead source performance">
          <PerfTable rows={d.sourcePerformance} label="Source" nameFor={providerName} />
        </Panel>
        <Panel title="Service demand (qualified leads by recommended service)">
          <PerfTable rows={d.serviceDemand} label="Service" nameFor={(k) => (k === 'unknown' ? 'No service fits' : titleCase(k))} />
        </Panel>
        <Panel title="Industry performance">
          <PerfTable rows={d.industryPerformance} label="Industry" />
        </Panel>
        <Panel title="Location performance">
          <PerfTable rows={d.locationPerformance} label="City" />
        </Panel>
      </div>
    </div>
  );
}
