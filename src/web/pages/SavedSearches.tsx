import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { api } from '../lib/api';
import { fmtDate, relTime } from '../lib/format';
import { Badge, Button, EmptyState, ErrorState, PageHeader, Panel, Select, SkeletonRows, toast } from '../components/ui';

interface Saved {
  id: string;
  name: string;
  params: { niche: string; location: string; country: string; service?: string; quantity: number };
  schedule: string | null;
  scheduleHour: number | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  campaignId: string | null;
  searchJobs: Array<{ id: string; status: string; counts: Record<string, number>; createdAt: string }>;
}

export default function SavedSearches() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['saved'], queryFn: () => api<Saved[]>('/api/saved-searches') });
  const run = useMutation({ mutationFn: (id: string) => api<{ searchJobId: string }>(`/api/saved-searches/${id}/run`, { body: {} }), onSuccess: (r) => navigate(`/jobs/${r.searchJobId}`) });
  const update = useMutation({ mutationFn: ({ id, ...body }: { id: string; schedule: string | null; scheduleHour?: number }) => api(`/api/saved-searches/${id}`, { method: 'PATCH', body }), onSuccess: () => { toast.ok('Schedule updated'); void qc.invalidateQueries({ queryKey: ['saved'] }); } });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/saved-searches/${id}`, { method: 'DELETE' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['saved'] }) });
  if (q.isLoading) return <SkeletonRows rows={6} />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <div className="space-y-4">
      <PageHeader title="Saved searches" subtitle="Re-run a search in one click, or schedule it daily: new companies are discovered and only new/stale websites are analysed. Messages are never sent automatically." />
      <Panel bodyClassName="p-0">
        {q.data!.length === 0 ? (
          <EmptyState title="No saved searches" action={<Link to="/search"><Button variant="primary">Create one from a search</Button></Link>}>
            Use “Save as saved search” in the search form.
          </EmptyState>
        ) : (
          <table className="w-full text-[12.5px]">
            <thead className="bg-panel-2 text-left text-[11px] uppercase text-ink-3">
              <tr>
                {['Name', 'Query', 'Last run', 'Performance (last runs)', 'Schedule', ''].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data!.map((s) => (
                <tr key={s.id} className="border-t border-line align-top">
                  <td className="px-3 py-2 font-medium">{s.name}</td>
                  <td className="px-3 py-2 text-ink-2">
                    {s.params.quantity} × {s.params.niche} · {s.params.location}, {s.params.country}
                    {s.params.service && <div className="text-[11.5px] text-ink-3">for {s.params.service}</div>}
                  </td>
                  <td className="px-3 py-2 text-ink-2">{s.lastRunAt ? relTime(s.lastRunAt) : 'never'}</td>
                  <td className="px-3 py-2">
                    <ul className="space-y-0.5">
                      {s.searchJobs.map((j) => (
                        <li key={j.id}>
                          <Link to={`/jobs/${j.id}`} className="text-ink-2 hover:text-accent">
                            {fmtDate(j.createdAt)}: {j.counts?.valid ?? 0} valid · {(j.counts?.veryHigh ?? 0) + (j.counts?.high ?? 0)} high
                          </Link>{' '}
                          <Badge tone={j.status === 'completed' ? 'ok' : 'neutral'}>{j.status}</Badge>
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <Select className="h-7 text-[12px]" value={s.schedule ?? ''} onChange={(e) => update.mutate({ id: s.id, schedule: e.target.value || null, scheduleHour: s.scheduleHour ?? 7 })} aria-label="Schedule">
                        <option value="">Manual</option>
                        <option value="daily">Daily</option>
                      </Select>
                      {s.schedule && (
                        <Select className="h-7 text-[12px]" value={s.scheduleHour ?? 7} onChange={(e) => update.mutate({ id: s.id, schedule: s.schedule, scheduleHour: Number(e.target.value) })} aria-label="Hour">
                          {Array.from({ length: 24 }, (_, h) => (
                            <option key={h} value={h}>
                              {String(h).padStart(2, '0')}:00
                            </option>
                          ))}
                        </Select>
                      )}
                    </div>
                    {s.nextRunAt && <div className="mt-1 text-[11px] text-ink-3">next {relTime(s.nextRunAt)}</div>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" icon={<Play className="size-3.5" />} onClick={() => run.mutate(s.id)} loading={run.isPending && run.variables === s.id}>
                        Run
                      </Button>
                      <Button size="sm" variant="ghost" aria-label="Delete" onClick={() => confirm(`Delete “${s.name}”?`) && del.mutate(s.id)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
