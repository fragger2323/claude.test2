import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate, pct, titleCase } from '../lib/format';
import { Badge, Button, ErrorState, PageHeader, Panel, SkeletonRows, toast } from '../components/ui';
import { RateCell, type Perf } from './Dashboard';

interface LearningData {
  runs: Array<{ id: string; target: string; version: number; status: string; active: boolean; sampleSize: number; positives: number; metrics: { brier?: number; baselineBrier?: number; auc?: number | null; calibration?: Array<{ bin: string; predicted: number; observed: number; n: number }>; negatives?: number }; notes: string | null; trainedAt: string }>;
  insights: { labelledLeads: number; byProblem: Perf[]; byChannel: Perf[]; byPriority: Perf[]; servicesSold: Array<{ service: string; count: number; value: number }>; note: string };
  templates: Array<{ template: string; example: string; queries: number; results: number; uniqueCompanies: number; highPriority: number; contacted: number; replied: number; yield: number }>;
  thresholds: { minSamples: number; minPerClass: number };
}

function Groups({ rows, label }: { rows: Perf[]; label: string }) {
  if (!rows.length) return <div className="text-[12px] text-ink-3">No contacted leads with outcomes yet.</div>;
  return (
    <table className="w-full text-[12.5px]">
      <thead className="text-left text-[11px] uppercase text-ink-3">
        <tr>
          <th className="py-1 pr-2 font-medium">{label}</th>
          <th className="py-1 pr-2 font-medium">Contacted</th>
          <th className="py-1 font-medium">Reply rate</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 10).map((r) => (
          <tr key={r.key} className="border-t border-line">
            <td className="py-1 pr-2">{titleCase(r.key)}</td>
            <td className="tnum py-1 pr-2">{r.contacted}</td>
            <td className="py-1">
              <RateCell rate={r.replyRate} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Learning() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['learning'], queryFn: () => api<LearningData>('/api/learning') });
  const train = useMutation({
    mutationFn: (target: 'reply' | 'won') => api<{ note: string; active: boolean }>('/api/learning/train', { body: { target } }),
    onSuccess: (r) => {
      toast.info(r.note);
      void qc.invalidateQueries({ queryKey: ['learning'] });
    },
  });
  if (q.isLoading) return <SkeletonRows rows={10} />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data!;
  const active = d.runs.find((r) => r.active);
  const progress = Math.min(1, d.insights.labelledLeads / d.thresholds.minSamples);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Learn from my outcomes"
        subtitle="Priority stays a transparent heuristic until your own results support a calibrated model. The model is only activated if it beats the base rate in cross-validation."
        actions={
          <>
            <Button icon={<Brain className="size-4" />} onClick={() => train.mutate('reply')} loading={train.isPending && train.variables === 'reply'}>
              Train reply model
            </Button>
            <Button onClick={() => train.mutate('won')} loading={train.isPending && train.variables === 'won'}>
              Train win model
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Data sufficiency">
          <div className="tnum text-2xl font-semibold">
            {d.insights.labelledLeads} / {d.thresholds.minSamples}
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-sunken">
            <div className="h-full rounded-full bg-accent" style={{ width: `${progress * 100}%` }} />
          </div>
          <p className="mt-2 text-[12px] text-ink-3">
            Contacted leads with a recorded outcome. Also required: at least {d.thresholds.minPerClass} positive and {d.thresholds.minPerClass} negative outcomes. Record “No reply” too — negatives matter.
          </p>
        </Panel>
        <Panel title="Active model">
          {active ? (
            <div className="space-y-1 text-[12.5px]">
              <div>
                <Badge tone="ai">
                  {active.target} · v{active.version}
                </Badge>{' '}
                trained {fmtDate(active.trainedAt)}
              </div>
              <div className="tnum text-ink-2">
                n = {active.sampleSize} · Brier {active.metrics.brier?.toFixed(3)} vs base {active.metrics.baselineBrier?.toFixed(3)}
                {active.metrics.auc != null && ` · AUC ${active.metrics.auc.toFixed(2)}`}
              </div>
              <div className="text-[12px] text-ink-3">{active.notes}</div>
            </div>
          ) : (
            <div className="text-[12.5px] text-ink-3">No active model — leads show “Estimated Sales Potential (heuristic)”, never a fake percentage.</div>
          )}
        </Panel>
        <Panel title="Services sold">
          {d.insights.servicesSold.length === 0 ? (
            <div className="text-[12px] text-ink-3">No won deals recorded yet.</div>
          ) : (
            <ul className="space-y-1 text-[12.5px]">
              {d.insights.servicesSold.map((s) => (
                <li key={s.service} className="flex justify-between">
                  <span>{titleCase(s.service)}</span>
                  <span className="tnum text-ink-2">
                    {s.count} · {s.value}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Replies by observed problem">
          <Groups rows={d.insights.byProblem} label="Problem" />
        </Panel>
        <Panel title="Replies by contact channel">
          <Groups rows={d.insights.byChannel} label="Channel" />
        </Panel>
        <Panel title="Replies by priority">
          <Groups rows={d.insights.byPriority} label="Priority" />
        </Panel>
      </div>
      <Panel title="Search quality: which query variations produce good leads" actions={<span className="text-[11.5px] text-ink-3">Yield is used to order future queries</span>}>
        {d.templates.length === 0 ? (
          <div className="text-[12px] text-ink-3">Run searches to collect query statistics.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead className="text-left text-[11px] uppercase text-ink-3">
                <tr>
                  {['Example query', 'Runs', 'Companies', 'High priority', 'Contacted', 'Replied', 'Yield'].map((h) => (
                    <th key={h} className="py-1.5 pr-3 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.templates.map((t) => (
                  <tr key={t.template} className="border-t border-line">
                    <td className="py-1.5 pr-3" title={t.template}>
                      {t.example}
                    </td>
                    <td className="tnum py-1.5 pr-3">{t.queries}</td>
                    <td className="tnum py-1.5 pr-3">{t.uniqueCompanies}</td>
                    <td className="tnum py-1.5 pr-3">{t.highPriority}</td>
                    <td className="tnum py-1.5 pr-3">{t.contacted}</td>
                    <td className="tnum py-1.5 pr-3">{t.replied}</td>
                    <td className="tnum py-1.5">{pct(t.yield, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Model runs">
        <ul className="space-y-1.5 text-[12.5px]">
          {d.runs.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2">
              <span className="tnum w-28 text-ink-3">{fmtDate(r.trainedAt)}</span>
              <Badge tone={r.active ? 'ai' : r.status === 'trained' ? 'neutral' : 'warn'}>
                {r.target} v{r.version} · {r.status}
                {r.active ? ' · active' : ''}
              </Badge>
              <span className="text-ink-2">{r.notes}</span>
            </li>
          ))}
          {d.runs.length === 0 && <li className="text-ink-3">No training attempts yet.</li>}
        </ul>
      </Panel>
    </div>
  );
}
