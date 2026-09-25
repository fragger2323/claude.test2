import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Rocket, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { BUSINESS_MODELS, COMPANY_SIZES, PRICE_SEGMENTS } from '../../domain/search-options';
import type { SearchParams } from '../../domain/search-params';

/** Form state mirrors the validated SearchParams (server validates again). */
type SearchParamsInput = SearchParams;
import { api, ApiError } from '../lib/api';
import { providerName, titleCase } from '../lib/format';
import { Badge, Button, Checkbox, Field, Input, PageHeader, Panel, Select, toast } from '../components/ui';

interface ProvidersInfo {
  sources: Array<{ id: string; name: string; configured: boolean; enabled: boolean; capabilities: { search: boolean }; hint: string }>;
  ai: { configured: boolean; model: string };
}
interface Service {
  slug: string;
  name: string;
  active: boolean;
}
interface Campaign {
  id: string;
  name: string;
}

const DEFAULTS: SearchParamsInput = {
  niche: '',
  location: '',
  country: '',
  service: '',
  quantity: 50,
  language: 'auto',
  excludeExistingClients: true,
  excludePreviouslyContacted: true,
  onlyWithWebsite: false,
  onlyWithPublicContact: false,
  minCompanySize: 'any',
  businessModel: 'any',
  priceSegment: 'any',
  preferredIndustries: [],
  excludedIndustries: [],
  providers: [],
  analyzeWebsites: true,
  visualAi: true,
  generateAudits: 'none',
};

export default function NewSearch() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const [p, setP] = useState<SearchParamsInput>(() => ({
    ...DEFAULTS,
    niche: sp.get('niche') ?? '',
    location: sp.get('location') ?? '',
    country: sp.get('country') ?? '',
    service: sp.get('service') ?? '',
    quantity: Number(sp.get('quantity') ?? 50) || 50,
  }));
  const [advanced, setAdvanced] = useState(false);
  const [campaignId, setCampaignId] = useState(sp.get('campaignId') ?? '');
  const [campaignName, setCampaignName] = useState('');
  const [saveAs, setSaveAs] = useState('');
  const [command, setCommand] = useState('');
  const set = <K extends keyof SearchParamsInput>(k: K, v: SearchParamsInput[K]) => setP((x) => ({ ...x, [k]: v }));

  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<ProvidersInfo>('/api/settings/providers') });
  const services = useQuery({ queryKey: ['services'], queryFn: () => api<Service[]>('/api/services') });
  const campaigns = useQuery({ queryKey: ['campaigns-min'], queryFn: () => api<Campaign[]>('/api/campaigns') });
  const searchSources = useMemo(() => (providers.data?.sources ?? []).filter((s) => s.capabilities.search && s.id !== 'import'), [providers.data]);
  const active = searchSources.filter((s) => s.configured && s.enabled);

  useEffect(() => {
    if (!p.service && services.data?.length) {
      const redesign = services.data.find((s) => s.slug === 'website-redesign');
      if (redesign) set('service', redesign.name);
    }
  }, [services.data, p.service]);

  const parse = useMutation({
    mutationFn: (text: string) => api<{ niche?: string; location?: string; country?: string; service?: string; quantity?: number; missing: string[] }>('/api/command/parse', { body: { text } }),
    onSuccess: (r) => {
      setP((x) => ({ ...x, niche: r.niche ?? x.niche, location: r.location ?? x.location, country: r.country ?? x.country, service: r.service ?? x.service, quantity: r.quantity ?? x.quantity }));
      if (r.missing.filter((m) => m !== 'service').length) toast.info(`Please fill in: ${r.missing.filter((m) => m !== 'service').join(', ')}`);
    },
  });

  const start = useMutation({
    mutationFn: () =>
      api<{ searchJobId: string }>('/api/search', {
        body: { params: { ...p, language: p.language === 'auto' ? undefined : p.language, service: p.service || undefined }, campaignId: campaignId || undefined, campaignName: campaignName || undefined, saveAs: saveAs || undefined, trigger: command ? 'command' : 'manual' },
      }),
    onSuccess: (r) => navigate(`/jobs/${r.searchJobId}`),
    onError: (e) => toast.error(e instanceof ApiError ? `${e.message}${Array.isArray(e.details) ? `: ${(e.details as Array<{ path: string; message: string }>).map((d) => `${d.path} ${d.message}`).join(', ')}` : ''}` : 'Failed to start search'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    start.mutate();
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Find best leads" subtitle="Discovery across all configured sources → merge & dedupe → website discovery → live analysis → evidence-based qualification." />
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (command.trim().length >= 3) parse.mutate(command);
        }}
      >
        <div className="relative flex-1">
          <Sparkles className="absolute left-2.5 top-2 size-4 text-accent" />
          <Input data-page-search value={command} onChange={(e) => setCommand(e.target.value)} className="pl-8" placeholder='Describe it: "Find 100 dental clinics in Warsaw for premium website redesign"' />
        </div>
        <Button type="submit" loading={parse.isPending}>
          Fill form
        </Button>
      </form>

      <form onSubmit={submit} className="space-y-4">
        <Panel>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
            <Field label="Niche" className="md:col-span-2" hint="Any language, e.g. “стоматологии”, “dentists”, “kancelaria prawna”.">
              <Input required value={p.niche} onChange={(e) => set('niche', e.target.value)} placeholder="dental clinics" />
            </Field>
            <Field label="Location (city)" className="md:col-span-2">
              <Input required value={p.location} onChange={(e) => set('location', e.target.value)} placeholder="Warsaw" />
            </Field>
            <Field label="Country" className="md:col-span-2">
              <Input required value={p.country} onChange={(e) => set('country', e.target.value)} placeholder="Poland" />
            </Field>
            <Field label="Service you want to sell" className="md:col-span-4" hint="Matched against your service catalogue (My Business → Services).">
              <Input list="services-list" value={p.service ?? ''} onChange={(e) => set('service', e.target.value)} placeholder="premium website redesign" />
              <datalist id="services-list">{services.data?.filter((s) => s.active).map((s) => <option key={s.slug} value={s.name} />)}</datalist>
            </Field>
            <Field label="Number of leads" className="md:col-span-2">
              <Input type="number" min={1} max={1000} required value={p.quantity} onChange={(e) => set('quantity', Number(e.target.value))} />
            </Field>
          </div>
        </Panel>

        <Panel>
          <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex w-full items-center gap-1.5 text-[13px] font-medium text-ink">
            {advanced ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} Filters & options
          </button>
          {advanced && (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                <Field label="Language">
                  <Select value={p.language} onChange={(e) => set('language', e.target.value)}>
                    <option value="auto">Auto (country languages)</option>
                    {['pl', 'en', 'de', 'cs', 'sk', 'uk', 'ru', 'es', 'fr', 'it', 'pt', 'nl'].map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Radius (km)" hint="Around the city centre.">
                  <Input type="number" min={1} max={100} value={p.radiusKm ?? ''} onChange={(e) => set('radiusKm', e.target.value ? Number(e.target.value) : undefined)} placeholder="15" />
                </Field>
                <Field label="Min. website need (0–100)" hint="Quality-gap threshold: lower-need sites are marked Low.">
                  <Input type="number" min={0} max={100} value={p.minWebsiteNeed ?? ''} onChange={(e) => set('minWebsiteNeed', e.target.value ? Number(e.target.value) : undefined)} placeholder="—" />
                </Field>
                <Field label="Min. website age (years)" hint="Only applied when an age signal exists.">
                  <Input type="number" min={0} max={30} value={p.minWebsiteAgeYears ?? ''} onChange={(e) => set('minWebsiteAgeYears', e.target.value ? Number(e.target.value) : undefined)} placeholder="—" />
                </Field>
                <Field label="Min. company size" hint="Proxy: review count / locations.">
                  <Select value={p.minCompanySize} onChange={(e) => set('minCompanySize', e.target.value as SearchParamsInput['minCompanySize'])}>
                    {COMPANY_SIZES.map((s) => (
                      <option key={s} value={s}>
                        {titleCase(s)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Business model">
                  <Select value={p.businessModel} onChange={(e) => set('businessModel', e.target.value as SearchParamsInput['businessModel'])}>
                    {BUSINESS_MODELS.map((s) => (
                      <option key={s} value={s}>
                        {titleCase(s)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Price segment">
                  <Select value={p.priceSegment} onChange={(e) => set('priceSegment', e.target.value as SearchParamsInput['priceSegment'])}>
                    {PRICE_SEGMENTS.map((s) => (
                      <option key={s} value={s}>
                        {titleCase(s)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Audits">
                  <Select value={p.generateAudits} onChange={(e) => set('generateAudits', e.target.value as 'none' | 'top')}>
                    <option value="none">On demand</option>
                    <option value="top">Auto for top leads (template, no AI cost)</option>
                  </Select>
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="Preferred industries" hint="Comma-separated; boosts Business Fit.">
                  <Input value={(p.preferredIndustries ?? []).join(', ')} onChange={(e) => set('preferredIndustries', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} placeholder="implants, cosmetic" />
                </Field>
                <Field label="Excluded industries" hint="Comma-separated; matching companies are excluded (kept with a reason).">
                  <Input value={(p.excludedIndustries ?? []).join(', ')} onChange={(e) => set('excludedIndustries', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} placeholder="franchise, chain" />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                <Checkbox label="Exclude existing clients" checked={!!p.excludeExistingClients} onChange={(v) => set('excludeExistingClients', v)} />
                <Checkbox label="Exclude previously contacted" checked={!!p.excludePreviouslyContacted} onChange={(v) => set('excludePreviouslyContacted', v)} />
                <Checkbox label="Only businesses with websites" checked={!!p.onlyWithWebsite} onChange={(v) => set('onlyWithWebsite', v)} />
                <Checkbox label="Only with public contact info" checked={!!p.onlyWithPublicContact} onChange={(v) => set('onlyWithPublicContact', v)} />
                <Checkbox label="Analyse websites live (Playwright)" checked={!!p.analyzeWebsites} onChange={(v) => set('analyzeWebsites', v)} />
                <Checkbox label="AI visual analysis" hint={providers.data?.ai.configured ? `Uses ${providers.data.ai.model}; cached` : 'AI not configured — skipped'} checked={!!p.visualAi} onChange={(v) => set('visualAi', v)} />
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium text-ink-2">Sources (none selected = all configured)</div>
                <div className="flex flex-wrap gap-2">
                  {searchSources.map((s) => {
                    const on = (p.providers ?? []).includes(s.id);
                    return (
                      <button
                        type="button"
                        key={s.id}
                        disabled={!s.configured || !s.enabled}
                        title={s.configured ? '' : s.hint}
                        onClick={() => set('providers', on ? (p.providers ?? []).filter((x) => x !== s.id) : [...(p.providers ?? []), s.id])}
                        className={`rounded-md border px-2 py-1 text-[12px] ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2'} disabled:opacity-40`}
                      >
                        {s.name}
                        {!s.configured && ' (not configured)'}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </Panel>

        <Panel>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="Campaign">
              <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">New campaign</option>
                {campaigns.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            {!campaignId && (
              <Field label="New campaign name" hint="Default: niche · city · date">
                <Input value={campaignName} onChange={(e) => setCampaignName(e.target.value)} placeholder="September Warsaw Dental" />
              </Field>
            )}
            <Field label="Save as saved search (optional)">
              <Input value={saveAs} onChange={(e) => setSaveAs(e.target.value)} placeholder="Dental Warsaw" />
            </Field>
          </div>
        </Panel>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
            Sources used:
            {active.length ? active.map((s) => <Badge key={s.id} tone="ok">{providerName(s.id)}</Badge>) : <Badge tone="warn">none configured — see Settings</Badge>}
          </div>
          <Button type="submit" variant="primary" icon={<Rocket className="size-4" />} loading={start.isPending} className="h-10 px-5 text-[14px]">
            FIND BEST LEADS
          </Button>
        </div>
        {active.length > 0 && (active.length === 1 || !active.some((s) => s.id === 'web_search')) && (
          <p className="mt-2 text-[12px] text-ink-3">
            {active.length === 1 ? `Only one source (${providerName(active[0]!.id)}) is active, so coverage and deduplication are limited. ` : ''}
            {!active.some((s) => s.id === 'web_search')
              ? 'Web search is not configured: businesses whose listings have no website are shown as “website not verified” (not as “no website”) until you add the site or configure Brave/Google search in Settings.'
              : ''}
          </p>
        )}
      </form>
    </div>
  );
}
