import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState, type DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../lib/api';
import { fmtDate, stageLabel } from '../lib/format';
import { PriorityBadge } from '../components/domain';
import { Badge, Button, ErrorState, PageHeader, Panel, Select, SkeletonRows, Tabs, toast } from '../components/ui';
import type { LeadRowData } from './Leads';

interface Board {
  columns: Array<{ stage: string; count: number; leads: LeadRowData[] }>;
}

export default function Crm() {
  const [sp, setSp] = useSearchParams();
  const view = sp.get('view') === 'followups' ? 'followups' : 'board';
  const [campaignId, setCampaignId] = useState(sp.get('campaignId') ?? '');
  const qc = useQueryClient();
  const board = useQuery({ queryKey: ['board', campaignId], queryFn: () => api<Board>('/api/crm/board', { query: { campaignId, perStage: 60 } }), enabled: view === 'board' });
  const followups = useQuery({ queryKey: ['followups'], queryFn: () => api<Array<{ id: string; dueAt: string; note: string | null; lead: { id: string; priority: string | null; company: { name: string; city: string | null } } }>>('/api/followups'), enabled: view === 'followups' });
  const campaigns = useQuery({ queryKey: ['campaigns-min'], queryFn: () => api<Array<{ id: string; name: string }>>('/api/campaigns') });
  const [dragOver, setDragOver] = useState<string | null>(null);
  const move = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: string }) => api(`/api/leads/${id}`, { method: 'PATCH', body: { stage } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['board'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const done = useMutation({ mutationFn: (id: string) => api(`/api/followups/${id}`, { method: 'PATCH', body: { status: 'done' } }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['followups'] }) });
  const onlyStage = sp.get('stage');

  const onDrop = (e: DragEvent, stage: string) => {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData('text/lead-id');
    if (id) move.mutate({ id, stage });
  };

  return (
    <div className="space-y-3">
      <PageHeader
        title="CRM"
        subtitle="Drag cards between stages. Pipeline stages (Discovered → Contact Ready) are set automatically; everything after is yours."
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
      <Tabs
        tabs={[
          { id: 'board', label: 'Pipeline' },
          { id: 'followups', label: 'Follow-ups' },
        ]}
        value={view}
        onChange={(v) => setSp(v === 'followups' ? { view: 'followups' } : {}, { replace: true })}
      />
      {view === 'board' ? (
        board.isLoading ? (
          <SkeletonRows rows={8} />
        ) : board.error ? (
          <ErrorState error={board.error} />
        ) : (
          <div className="scroll-thin flex gap-3 overflow-x-auto pb-3">
            {board.data!.columns
              .filter((c) => !onlyStage || c.stage === onlyStage)
              .map((col) => (
                <div
                  key={col.stage}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(col.stage);
                  }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={(e) => onDrop(e, col.stage)}
                  className={clsx('flex w-64 shrink-0 flex-col rounded-lg border border-line bg-panel-2', dragOver === col.stage && 'ring-2 ring-accent')}
                >
                  <div className="flex items-center justify-between border-b border-line px-3 py-2">
                    <span className="text-[12px] font-semibold">{stageLabel(col.stage)}</span>
                    <Badge>{col.count}</Badge>
                  </div>
                  <div className="scroll-thin max-h-[70vh] min-h-24 space-y-1.5 overflow-y-auto p-2">
                    {col.leads.map((l) => (
                      <Link
                        key={l.id}
                        to={`/leads/${l.id}`}
                        draggable
                        onDragStart={(e) => e.dataTransfer.setData('text/lead-id', l.id)}
                        className="block rounded-md border border-line bg-panel p-2 shadow-panel hover:border-line-strong"
                      >
                        <div className="flex items-start justify-between gap-1">
                          <span className="text-[12.5px] font-medium leading-tight">{l.company}</span>
                          <PriorityBadge priority={l.priority} />
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-ink-3">{[l.city, l.mainOpportunity].filter(Boolean).join(' · ')}</div>
                      </Link>
                    ))}
                    {col.count > col.leads.length && <div className="px-1 text-[11px] text-ink-3">+{col.count - col.leads.length} more (see Leads table)</div>}
                  </div>
                </div>
              ))}
          </div>
        )
      ) : (
        <Panel bodyClassName="p-0">
          {followups.isLoading ? (
            <div className="p-4">
              <SkeletonRows />
            </div>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead className="bg-panel-2 text-left text-[11px] uppercase text-ink-3">
                <tr>
                  <th className="px-3 py-2">Due</th>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2">Note</th>
                  <th className="px-3 py-2">Priority</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {followups.data?.map((f) => (
                  <tr key={f.id} className="border-t border-line">
                    <td className={clsx('tnum px-3 py-2', new Date(f.dueAt) < new Date() && 'text-bad')}>{fmtDate(f.dueAt)}</td>
                    <td className="px-3 py-2">
                      <Link to={`/leads/${f.lead.id}`} className="font-medium hover:underline">
                        {f.lead.company.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-ink-2">{f.note}</td>
                    <td className="px-3 py-2">
                      <PriorityBadge priority={f.lead.priority} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" onClick={() => done.mutate(f.id)}>
                        Done
                      </Button>
                    </td>
                  </tr>
                ))}
                {followups.data?.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-ink-3">
                      No pending follow-ups.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </Panel>
      )}
    </div>
  );
}
