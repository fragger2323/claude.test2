import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PROBLEM_TAG_LABELS, type ProblemTag } from '../../domain/types';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { Badge, Button, Checkbox, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Panel, Select, SkeletonRows, Tabs, Textarea, toast } from '../components/ui';

interface Profile {
  studioName: string | null;
  senderName: string | null;
  senderRole: string | null;
  website: string | null;
  currency: string;
  minProjectSize: number | null;
  targetClientProfile: string | null;
  communicationLanguage: string;
  preferredIndustries: string[];
  excludedIndustries: string[];
  preferredCountries: string[];
  preferredCities: string[];
  preferredTechnologies: string[];
  disallowedProjectTypes: string[];
  portfolioUrls: string[];
}
interface Service {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string;
  targetProfile: string | null;
  problemTypes: Array<{ tag: ProblemTag; weight: number }>;
  minimumFit: number;
  excludedCases: Array<{ type: string; reason: string; tag?: string; value?: number }>;
  technologies: string[];
  projectSize: string;
  active: boolean;
}
interface Project {
  id: string;
  name: string;
  url: string | null;
  industry: string | null;
  technologies: string[];
  styles: string[];
  services: string[];
  caseStudy: string | null;
  results: string | null;
  active: boolean;
}

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function ProfileTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['profile'], queryFn: () => api<Profile>('/api/business/profile') });
  const services = useQuery({ queryKey: ['services'], queryFn: () => api<Service[]>('/api/services') });
  const [p, setP] = useState<Profile | null>(null);
  useEffect(() => {
    if (q.data) setP(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api('/api/business/profile', { method: 'PUT', body: p }),
    onSuccess: () => {
      toast.ok('Saved. Use “Re-score all leads” to apply to existing leads.');
      void qc.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const requalify = useMutation({ mutationFn: () => api('/api/business/requalify', { body: {} }), onSuccess: () => toast.ok('Re-scoring queued') });
  if (!p) return <SkeletonRows />;
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setP({ ...p, [k]: v });
  return (
    <div className="space-y-4">
      <Panel title="Studio & sender" actions={<Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>Save</Button>}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Studio name">
            <Input value={p.studioName ?? ''} onChange={(e) => set('studioName', e.target.value)} />
          </Field>
          <Field label="Your name (signature)">
            <Input value={p.senderName ?? ''} onChange={(e) => set('senderName', e.target.value)} />
          </Field>
          <Field label="Role">
            <Input value={p.senderRole ?? ''} onChange={(e) => set('senderRole', e.target.value)} placeholder="Founder" />
          </Field>
          <Field label="Studio website">
            <Input value={p.website ?? ''} onChange={(e) => set('website', e.target.value)} />
          </Field>
          <Field label="Communication language (default)">
            <Select value={p.communicationLanguage} onChange={(e) => set('communicationLanguage', e.target.value)}>
              <option value="en">English</option>
              <option value="pl">Polski</option>
              <option value="de">Deutsch</option>
              <option value="uk">Українська</option>
              <option value="ru">Русский</option>
            </Select>
          </Field>
          <Field label="Currency">
            <Input value={p.currency} maxLength={3} onChange={(e) => set('currency', e.target.value.toUpperCase())} />
          </Field>
        </div>
      </Panel>
      <Panel title="Target clients" actions={<Button onClick={() => requalify.mutate()} loading={requalify.isPending}>Re-score all leads</Button>}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Preferred industries" hint="Comma-separated. Boosts Business Fit.">
            <Input value={p.preferredIndustries.join(', ')} onChange={(e) => set('preferredIndustries', list(e.target.value))} />
          </Field>
          <Field label="Excluded industries" hint="Comma-separated. Matching leads are excluded (kept with a reason).">
            <Input value={p.excludedIndustries.join(', ')} onChange={(e) => set('excludedIndustries', list(e.target.value))} />
          </Field>
          <Field label="Preferred countries">
            <Input value={p.preferredCountries.join(', ')} onChange={(e) => set('preferredCountries', list(e.target.value))} />
          </Field>
          <Field label="Preferred cities">
            <Input value={p.preferredCities.join(', ')} onChange={(e) => set('preferredCities', list(e.target.value))} />
          </Field>
          <Field label="Preferred technologies" hint="e.g. Webflow, WordPress — small fit boost for matching services.">
            <Input value={p.preferredTechnologies.join(', ')} onChange={(e) => set('preferredTechnologies', list(e.target.value))} />
          </Field>
          <Field label="Minimum project size">
            <Input type="number" min={0} value={p.minProjectSize ?? ''} onChange={(e) => set('minProjectSize', e.target.value ? Number(e.target.value) : null)} />
          </Field>
          <Field label="Target client profile" className="md:col-span-2">
            <Textarea rows={3} value={p.targetClientProfile ?? ''} onChange={(e) => set('targetClientProfile', e.target.value)} placeholder="Premium private clinics and professional services with dated sites…" />
          </Field>
          <Field label="Portfolio URLs" hint="Comma-separated." className="md:col-span-2">
            <Input value={p.portfolioUrls.join(', ')} onChange={(e) => set('portfolioUrls', list(e.target.value))} />
          </Field>
        </div>
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-ink-2">Disallowed project types (never recommended)</div>
          <div className="flex flex-wrap gap-3">
            {services.data?.map((s) => (
              <Checkbox key={s.slug} label={s.name} checked={p.disallowedProjectTypes.includes(s.slug)} onChange={(v) => set('disallowedProjectTypes', v ? [...p.disallowedProjectTypes, s.slug] : p.disallowedProjectTypes.filter((x) => x !== s.slug))} />
            ))}
          </div>
        </div>
      </Panel>
    </div>
  );
}

function ServiceEditor({ s, onClose }: { s: Service | null; onClose: () => void }) {
  const qc = useQueryClient();
  const tags = useQuery({ queryKey: ['problem-tags'], queryFn: () => api<ProblemTag[]>('/api/services/problem-tags') });
  const [f, setF] = useState<Partial<Service>>(s ?? { name: '', priceMin: null, priceMax: null, currency: 'EUR', problemTypes: [], minimumFit: 40, excludedCases: [], technologies: [], projectSize: 'medium', active: true });
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name, description: f.description, priceMin: f.priceMin, priceMax: f.priceMax, currency: f.currency, targetProfile: f.targetProfile, problemTypes: f.problemTypes, minimumFit: f.minimumFit, excludedCases: f.excludedCases, technologies: f.technologies, projectSize: f.projectSize, active: f.active };
      return s ? api(`/api/services/${s.id}`, { method: 'PUT', body }) : api('/api/services', { body });
    },
    onSuccess: () => {
      toast.ok('Service saved');
      void qc.invalidateQueries({ queryKey: ['services'] });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const weight = (tag: ProblemTag) => f.problemTypes?.find((p) => p.tag === tag)?.weight ?? 0;
  const setWeight = (tag: ProblemTag, w: number) => setF({ ...f, problemTypes: [...(f.problemTypes ?? []).filter((p) => p.tag !== tag), ...(w > 0 ? [{ tag, weight: w }] : [])] });
  return (
    <Dialog open onClose={onClose} title={s ? `Edit “${s.name}”` : 'New service'} width="max-w-3xl" footer={<Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>Save</Button>}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Field label="Name" className="md:col-span-2">
          <Input value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Price from">
          <Input type="number" value={f.priceMin ?? ''} onChange={(e) => setF({ ...f, priceMin: e.target.value ? Number(e.target.value) : null })} />
        </Field>
        <Field label="Price to">
          <Input type="number" value={f.priceMax ?? ''} onChange={(e) => setF({ ...f, priceMax: e.target.value ? Number(e.target.value) : null })} />
        </Field>
        <Field label="Target profile" className="md:col-span-4">
          <Textarea rows={2} value={f.targetProfile ?? ''} onChange={(e) => setF({ ...f, targetProfile: e.target.value })} />
        </Field>
        <Field label="Minimum fit (0–100)">
          <Input type="number" min={0} max={100} value={f.minimumFit ?? 40} onChange={(e) => setF({ ...f, minimumFit: Number(e.target.value) })} />
        </Field>
        <Field label="Project size">
          <Select value={f.projectSize} onChange={(e) => setF({ ...f, projectSize: e.target.value })}>
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large (needs strong evidence)</option>
          </Select>
        </Field>
        <Field label="Technologies" className="md:col-span-2">
          <Input value={(f.technologies ?? []).join(', ')} onChange={(e) => setF({ ...f, technologies: list(e.target.value) })} />
        </Field>
      </div>
      <div className="mt-4">
        <div className="mb-1 text-xs font-medium text-ink-2">Problem types this service solves (weight 0–5)</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-3">
          {tags.data?.map((t) => (
            <label key={t} className="flex items-center justify-between gap-2 text-[12px]">
              <span className="truncate text-ink-2">{PROBLEM_TAG_LABELS[t]}</span>
              <input type="number" min={0} max={5} className="h-6 w-12 rounded border border-line bg-panel px-1 text-right" value={weight(t)} onChange={(e) => setWeight(t, Number(e.target.value))} />
            </label>
          ))}
        </div>
      </div>
      {(f.excludedCases ?? []).length > 0 && (
        <div className="mt-4 text-[12px]">
          <div className="mb-1 font-medium text-ink-2">Exclusion rules</div>
          <ul className="list-disc pl-4 text-ink-3">
            {f.excludedCases!.map((x, i) => (
              <li key={i}>
                {x.type}
                {x.tag ? ` (${x.tag})` : ''}
                {x.value != null ? ` ≥ ${x.value}` : ''}: {x.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}

function ServicesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['services'], queryFn: () => api<Service[]>('/api/services') });
  const [edit, setEdit] = useState<Service | null | 'new'>(null);
  const toggle = useMutation({ mutationFn: (s: Service) => api(`/api/services/${s.id}`, { method: 'PUT', body: { active: !s.active } }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['services'] }) });
  const restore = useMutation({ mutationFn: () => api<{ added: number }>('/api/services/restore-defaults', { body: {} }), onSuccess: (r) => { toast.ok(`${r.added} default service(s) added`); void qc.invalidateQueries({ queryKey: ['services'] }); } });
  if (q.isLoading) return <SkeletonRows />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <Panel
      title="Service catalogue"
      actions={
        <>
          <Button size="sm" onClick={() => restore.mutate()}>
            Restore defaults
          </Button>
          <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEdit('new')}>
            Add service
          </Button>
        </>
      }
      bodyClassName="p-0"
    >
      <table className="w-full text-[12.5px]">
        <thead className="bg-panel-2 text-left text-[11px] uppercase text-ink-3">
          <tr>
            {['Service', 'Price range', 'Solves', 'Min fit', 'Size', 'Status', ''].map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {q.data!.map((s) => (
            <tr key={s.id} className="border-t border-line align-top">
              <td className="px-3 py-2">
                <div className="font-medium">{s.name}</div>
                <div className="text-[11.5px] text-ink-3">{s.targetProfile}</div>
              </td>
              <td className="tnum whitespace-nowrap px-3 py-2">{money(s.priceMin, s.priceMax, s.currency)}</td>
              <td className="px-3 py-2">
                <div className="flex max-w-md flex-wrap gap-1">
                  {s.problemTypes
                    .sort((a, b) => b.weight - a.weight)
                    .map((p) => (
                      <Badge key={p.tag}>
                        {PROBLEM_TAG_LABELS[p.tag] ?? p.tag} ×{p.weight}
                      </Badge>
                    ))}
                </div>
              </td>
              <td className="tnum px-3 py-2">{s.minimumFit}</td>
              <td className="px-3 py-2">{s.projectSize}</td>
              <td className="px-3 py-2">
                <button onClick={() => toggle.mutate(s)}>
                  <Badge tone={s.active ? 'ok' : 'neutral'}>{s.active ? 'active' : 'inactive'}</Badge>
                </button>
              </td>
              <td className="px-3 py-2 text-right">
                <Button size="sm" variant="ghost" onClick={() => setEdit(s)}>
                  Edit
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <ServiceEditor s={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </Panel>
  );
}

function PortfolioTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['portfolio'], queryFn: () => api<Project[]>('/api/portfolio') });
  const services = useQuery({ queryKey: ['services'], queryFn: () => api<Service[]>('/api/services') });
  const empty: Omit<Project, 'id'> = { name: '', url: '', industry: '', technologies: [], styles: [], services: [], caseStudy: '', results: '', active: true };
  const [form, setForm] = useState<Omit<Project, 'id'> & { id?: string }>(empty);
  const [open, setOpen] = useState(false);
  const save = useMutation({
    mutationFn: () => {
      const { id, ...body } = form;
      return id ? api(`/api/portfolio/${id}`, { method: 'PUT', body }) : api('/api/portfolio', { body });
    },
    onSuccess: () => {
      toast.ok('Project saved');
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/portfolio/${id}`, { method: 'DELETE' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['portfolio'] }) });
  return (
    <Panel
      title="Portfolio projects"
      actions={
        <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => { setForm(empty); setOpen(true); }}>
          Add project
        </Button>
      }
    >
      <p className="mb-3 text-[12px] text-ink-3">Matched to leads by industry, service and platform. A project is suggested in outreach only when there is a real match — similarity is never invented.</p>
      {q.data?.length === 0 ? (
        <EmptyState title="No projects yet">Add 3–5 of your best projects with industry, services and technologies.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {q.data?.map((p) => (
            <div key={p.id} className="rounded-md border border-line p-3">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-medium">{p.name}</div>
                  {p.url && (
                    <a className="text-[12px] text-accent hover:underline" href={p.url} target="_blank" rel="noopener noreferrer">
                      {p.url}
                    </a>
                  )}
                </div>
                <div className="flex">
                  <Button size="sm" variant="ghost" onClick={() => { setForm({ ...p, url: p.url ?? '', industry: p.industry ?? '', caseStudy: p.caseStudy ?? '', results: p.results ?? '' }); setOpen(true); }}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" aria-label="Delete" onClick={() => confirm(`Delete ${p.name}?`) && del.mutate(p.id)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {p.industry && <Badge tone="accent">{p.industry}</Badge>}
                {p.services.map((s) => (
                  <Badge key={s}>{services.data?.find((x) => x.slug === s)?.name ?? s}</Badge>
                ))}
                {p.technologies.map((t) => (
                  <Badge key={t} tone="info">
                    {t}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title={form.id ? 'Edit project' : 'New project'} width="max-w-2xl" footer={<Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>Save</Button>}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="URL">
            <Input value={form.url ?? ''} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </Field>
          <Field label="Industry" hint="e.g. dentist, restaurant, law firm">
            <Input value={form.industry ?? ''} onChange={(e) => setForm({ ...form, industry: e.target.value })} />
          </Field>
          <Field label="Technologies">
            <Input value={form.technologies.join(', ')} onChange={(e) => setForm({ ...form, technologies: list(e.target.value) })} />
          </Field>
          <Field label="Style tags">
            <Input value={form.styles.join(', ')} onChange={(e) => setForm({ ...form, styles: list(e.target.value) })} placeholder="minimal, luxury" />
          </Field>
          <Field label="Services">
            <Select multiple className="h-24" value={form.services} onChange={(e) => setForm({ ...form, services: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
              {services.data?.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Case study" className="md:col-span-2">
            <Textarea rows={3} value={form.caseStudy ?? ''} onChange={(e) => setForm({ ...form, caseStudy: e.target.value })} />
          </Field>
          <Field label="Real results (only verifiable ones)" className="md:col-span-2">
            <Textarea rows={2} value={form.results ?? ''} onChange={(e) => setForm({ ...form, results: e.target.value })} />
          </Field>
        </div>
      </Dialog>
    </Panel>
  );
}

export default function Business() {
  const [tab, setTab] = useState<'profile' | 'services' | 'portfolio'>('profile');
  return (
    <div className="space-y-4">
      <PageHeader title="My Business" subtitle="Your services, prices, target clients and portfolio drive qualification, service matching and outreach." />
      <Tabs
        tabs={[
          { id: 'profile', label: 'Profile & targeting' },
          { id: 'services', label: 'Services' },
          { id: 'portfolio', label: 'Portfolio' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'profile' && <ProfileTab />}
      {tab === 'services' && <ServicesTab />}
      {tab === 'portfolio' && <PortfolioTab />}
    </div>
  );
}
