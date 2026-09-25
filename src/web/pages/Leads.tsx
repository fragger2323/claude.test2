import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type RowSelectionState } from '@tanstack/react-table';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Download, ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { CRM_STAGES, CRM_STAGE_LABELS, PRIORITIES, PRIORITY_LABELS } from '../../domain/types';
import { api, download } from '../lib/api';
import { hostname, providerName, titleCase } from '../lib/format';
import { ContactBadge, FreshnessBadge, PriorityBadge, StageBadge } from '../components/domain';
import { Button, EmptyState, ErrorState, Input, PageHeader, ScoreBar, Select, SkeletonRows, toast } from '../components/ui';

export interface LeadRowData {
  id: string;
  company: string;
  industry: string | null;
  city: string | null;
  website: string | null;
  websiteStatus: string;
  stage: string;
  priority: string | null;
  leadFit: number | null;
  websiteNeed: number | null;
  serviceFit: number | null;
  contactability: number | null;
  freshness: number | null;
  recommendedService: string | null;
  mainOpportunity: string | null;
  contactAvailability: string | null;
  verifiedContacts: string[];
  sources: string[];
}

const SORTABLE: Record<string, string> = { priority: 'priority', websiteNeed: 'websiteNeed', contactability: 'contactability', freshness: 'freshness', leadFit: 'leadFit', company: 'company' };
const FILTER_KEYS = ['q', 'priority', 'stage', 'industry', 'city', 'service', 'websiteStatus', 'contact', 'freshness', 'source', 'campaignId', 'review', 'sort', 'dir', 'page'] as const;

export default function Leads() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const f = Object.fromEntries(FILTER_KEYS.map((k) => [k, sp.get(k) ?? ''])) as Record<(typeof FILTER_KEYS)[number], string>;
  const [q, setQ] = useState(f.q);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [cursor, setCursor] = useState(0);
  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(sp);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setSp(next, { replace: true });
  };
  useEffect(() => {
    const t = setTimeout(() => q !== f.q && setFilter('q', q), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const query = { ...f, sort: f.sort || 'priority', dir: f.dir || 'desc', page: f.page || '1', pageSize: 50 };
  const leads = useQuery({ queryKey: ['leads', query], queryFn: () => api<{ total: number; page: number; pageSize: number; rows: LeadRowData[] }>('/api/leads', { query }), placeholderData: keepPreviousData });
  const facets = useQuery({ queryKey: ['facets'], queryFn: () => api<{ industries: string[]; cities: string[]; services: string[]; sources: string[] }>('/api/leads/facets'), staleTime: 60_000 });
  const campaigns = useQuery({ queryKey: ['campaigns-min'], queryFn: () => api<Array<{ id: string; name: string }>>('/api/campaigns') });

  const bulk = useMutation({
    mutationFn: (body: { action: 'stage' | 'analyze' | 'requalify'; stage?: string }) => api('/api/leads/bulk', { body: { ids: Object.keys(selection), ...body } }),
    onSuccess: () => {
      toast.ok('Done');
      setSelection({});
      void qc.invalidateQueries({ queryKey: ['leads'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const sortHeader = (key: string, label: string) => {
    const active = query.sort === SORTABLE[key];
    return (
      <button
        className={clsx('inline-flex items-center gap-0.5 uppercase', active && 'text-ink')}
        onClick={() => {
          const next = new URLSearchParams(sp);
          next.set('sort', SORTABLE[key]!);
          next.set('dir', active && query.dir === 'desc' ? 'asc' : 'desc');
          setSp(next, { replace: true });
        }}
      >
        {label}
        {active && (query.dir === 'desc' ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
      </button>
    );
  };

  const columns = useMemo<ColumnDef<LeadRowData>[]>(
    () => [
      {
        id: 'select',
        header: ({ table }) => <input type="checkbox" aria-label="Select all" checked={table.getIsAllRowsSelected()} onChange={table.getToggleAllRowsSelectedHandler()} />,
        cell: ({ row }) => <input type="checkbox" aria-label="Select row" checked={row.getIsSelected()} onChange={row.getToggleSelectedHandler()} onClick={(e) => e.stopPropagation()} />,
      },
      { id: 'company', header: () => sortHeader('company', 'Company'), cell: ({ row }) => <Link to={`/leads/${row.original.id}`} className="font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>{row.original.company}</Link> },
      { id: 'industry', header: 'Industry', cell: ({ row }) => <span className="text-ink-2">{row.original.industry ?? '—'}</span> },
      { id: 'city', header: 'City', cell: ({ row }) => <span className="text-ink-2">{row.original.city ?? '—'}</span> },
      {
        id: 'website',
        header: 'Website',
        cell: ({ row }) =>
          row.original.website ? (
            <a href={row.original.website} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-ink-2 hover:text-accent">
              {hostname(row.original.website)} <ExternalLink className="size-3" />
            </a>
          ) : (
            <span className="text-ink-3">{row.original.websiteStatus === 'not_found' ? 'none' : row.original.websiteStatus === 'unverified' ? 'not verified' : '—'}</span>
          ),
      },
      { id: 'websiteNeed', header: () => sortHeader('websiteNeed', 'Website need'), cell: ({ row }) => <ScoreBar value={row.original.websiteNeed} /> },
      { id: 'serviceFit', header: 'Service fit', cell: ({ row }) => <ScoreBar value={row.original.serviceFit} /> },
      { id: 'contactability', header: () => sortHeader('contactability', 'Contactability'), cell: ({ row }) => <ScoreBar value={row.original.contactability} /> },
      { id: 'freshness', header: () => sortHeader('freshness', 'Freshness'), cell: ({ row }) => <FreshnessBadge value={row.original.freshness} /> },
      { id: 'priority', header: () => sortHeader('priority', 'Priority'), cell: ({ row }) => <PriorityBadge priority={row.original.priority} /> },
      { id: 'service', header: 'Recommended service', cell: ({ row }) => <span className="text-ink-2">{row.original.recommendedService ? titleCase(row.original.recommendedService) : '—'}</span> },
      { id: 'contact', header: 'Contact', cell: ({ row }) => <ContactBadge availability={row.original.contactAvailability} /> },
      { id: 'stage', header: 'Status', cell: ({ row }) => <StageBadge stage={row.original.stage} /> },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query.sort, query.dir, sp],
  );

  const table = useReactTable({ data: leads.data?.rows ?? [], columns, getCoreRowModel: getCoreRowModel(), getRowId: (r) => r.id, state: { rowSelection: selection }, onRowSelectionChange: setSelection, enableRowSelection: true });

  useEffect(() => {
    const rows = leads.data?.rows ?? [];
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if (e.key === 'j') setCursor((c) => Math.min(rows.length - 1, c + 1));
      if (e.key === 'k') setCursor((c) => Math.max(0, c - 1));
      if (e.key === 'Enter' && rows[cursor]) navigate(`/leads/${rows[cursor]!.id}`);
      if (e.key === 'x' && rows[cursor]) setSelection((s) => ({ ...s, [rows[cursor]!.id]: !s[rows[cursor]!.id] }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [leads.data, cursor, navigate]);

  const total = leads.data?.total ?? 0;
  const page = Number(query.page);
  const pages = Math.max(1, Math.ceil(total / 50));
  const selectedCount = Object.keys(selection).filter((k) => selection[k]).length;
  const exportQuery = { ...query, page: undefined };

  return (
    <div className="space-y-3">
      <PageHeader
        title="Leads"
        subtitle={`${total} lead(s) · sorted by ${query.sort} · j/k to move, Enter to open, x to select`}
        actions={
          <>
            <Button icon={<Download className="size-3.5" />} onClick={() => download('/api/export/leads', { ...exportQuery, format: 'csv' })}>
              CSV
            </Button>
            <Button icon={<Download className="size-3.5" />} onClick={() => download('/api/export/leads', { ...exportQuery, format: 'json' })}>
              JSON
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-2 shadow-panel">
        <div className="w-56">
          <Input data-page-search className="h-7" placeholder="Search company or domain  ( / )" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select className="h-7 text-[12px]" value={f.priority} onChange={(e) => setFilter('priority', e.target.value)} aria-label="Priority">
          <option value="">Any priority</option>
          <option value="very_high,high">High & Very high</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </Select>
        <Select className="h-7 text-[12px]" value={f.stage} onChange={(e) => setFilter('stage', e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {CRM_STAGES.map((s) => (
            <option key={s} value={s}>
              {CRM_STAGE_LABELS[s]}
            </option>
          ))}
        </Select>
        <Select className="h-7 text-[12px]" value={f.industry} onChange={(e) => setFilter('industry', e.target.value)} aria-label="Industry">
          <option value="">Any industry</option>
          {facets.data?.industries.map((i) => (
            <option key={i}>{i}</option>
          ))}
        </Select>
        <Select className="h-7 text-[12px]" value={f.city} onChange={(e) => setFilter('city', e.target.value)} aria-label="Location">
          <option value="">Any location</option>
          {facets.data?.cities.map((i) => (
            <option key={i}>{i}</option>
          ))}
        </Select>
        <Select className="h-7 text-[12px]" value={f.service} onChange={(e) => setFilter('service', e.target.value)} aria-label="Service">
          <option value="">Any service</option>
          {facets.data?.services.map((i) => (
            <option key={i} value={i}>
              {titleCase(i)}
            </option>
          ))}
        </Select>
        <Select className="h-7 text-[12px]" value={f.websiteStatus} onChange={(e) => setFilter('websiteStatus', e.target.value)} aria-label="Website condition">
          <option value="">Any website</option>
          <option value="found">Has website</option>
          <option value="not_found">No website</option>
              <option value="unverified">Website not verified</option>
          <option value="unreachable">Unreachable</option>
        </Select>
        <Select className="h-7 text-[12px]" value={f.contact} onChange={(e) => setFilter('contact', e.target.value)} aria-label="Contact availability">
          <option value="">Any contact</option>
          <option value="any">Has public contact</option>
          <option value="email">E-mail</option>
          <option value="form">Form</option>
          <option value="phone">Phone only</option>
          <option value="none">None</option>
        </Select>
        <Select className="h-7 text-[12px]" value={f.freshness} onChange={(e) => setFilter('freshness', e.target.value)} aria-label="Freshness">
          <option value="">Any freshness</option>
          <option value="fresh">Fresh</option>
          <option value="recent">Recent/aging</option>
          <option value="stale">Stale</option>
        </Select>
        <Select className="h-7 text-[12px]" value={f.source} onChange={(e) => setFilter('source', e.target.value)} aria-label="Source">
          <option value="">Any source</option>
          {facets.data?.sources.map((s) => (
            <option key={s} value={s}>
              {providerName(s)}
            </option>
          ))}
        </Select>
        <Select className="h-7 text-[12px]" value={f.campaignId} onChange={(e) => setFilter('campaignId', e.target.value)} aria-label="Campaign">
          <option value="">Any campaign</option>
          {campaigns.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {FILTER_KEYS.some((k) => k !== 'sort' && k !== 'dir' && f[k]) && (
          <Button size="sm" variant="ghost" onClick={() => setSp(new URLSearchParams(), { replace: true })}>
            Clear
          </Button>
        )}
      </div>

      {selectedCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-[12.5px]">
          <span className="font-medium text-accent">{selectedCount} selected</span>
          <Button size="sm" onClick={() => bulk.mutate({ action: 'analyze' })}>
            Analyze
          </Button>
          <Button size="sm" onClick={() => bulk.mutate({ action: 'requalify' })}>
            Re-score
          </Button>
          <Select className="h-7 text-[12px]" value="" onChange={(e) => e.target.value && bulk.mutate({ action: 'stage', stage: e.target.value })} aria-label="Move to stage">
            <option value="">Move to stage…</option>
            {CRM_STAGES.map((s) => (
              <option key={s} value={s}>
                {CRM_STAGE_LABELS[s]}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="ghost" onClick={() => setSelection({})}>
            Clear selection
          </Button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-line bg-panel shadow-panel">
        {leads.isLoading ? (
          <div className="p-4">
            <SkeletonRows rows={10} />
          </div>
        ) : leads.error ? (
          <div className="p-4">
            <ErrorState error={leads.error} retry={() => leads.refetch()} />
          </div>
        ) : total === 0 ? (
          <EmptyState title="No leads match" action={<Link to="/search"><Button variant="primary">Find leads</Button></Link>}>
            Run a search or import a CSV. Filters are kept in the URL, so you can bookmark views.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead className="sticky top-0 bg-panel-2 text-left text-[11px] uppercase tracking-wide text-ink-3">
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((h) => (
                      <th key={h.id} className="whitespace-nowrap px-2.5 py-2 font-medium">
                        {flexRender(h.column.columnDef.header, h.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row, i) => (
                  <tr key={row.id} onClick={() => navigate(`/leads/${row.original.id}`)} className={clsx('cursor-pointer border-t border-line hover:bg-sunken/60', i === cursor && 'bg-sunken/80 outline outline-1 -outline-offset-1 outline-accent/40', row.getIsSelected() && 'bg-accent-soft/50')}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="whitespace-nowrap px-2.5 py-1.5">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > 50 && (
          <div className="flex items-center justify-between border-t border-line px-3 py-2 text-[12px] text-ink-3">
            <span className="tnum">
              Page {page} of {pages}
            </span>
            <div className="flex gap-1">
              <Button size="sm" disabled={page <= 1} onClick={() => setFilter('page', String(page - 1))}>
                Previous
              </Button>
              <Button size="sm" disabled={page >= pages} onClick={() => setFilter('page', String(page + 1))}>
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
