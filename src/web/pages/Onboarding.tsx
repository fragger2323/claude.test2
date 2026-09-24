import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { api } from '../lib/api';
import { Button, PageHeader, Panel } from '../components/ui';
import { SecretsPanel, SourcesPanel } from './Settings';

interface OnboardingData {
  steps: {
    sources: { done: boolean; configured: string[] };
    keys: { done: boolean; ai: boolean };
    services: { done: boolean; count: number };
    campaign: { done: boolean };
    leads: { done: boolean };
  };
  completed: boolean;
}

export default function Onboarding() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['onboarding'], queryFn: () => api<OnboardingData>('/api/onboarding'), refetchInterval: 5000 });
  const finish = useMutation({
    mutationFn: () => api('/api/business/profile', { method: 'PUT', body: { onboardingCompleted: true } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['onboarding'] });
      navigate('/search');
    },
  });
  const s = q.data?.steps;
  const steps = [
    { n: 1, title: 'Configure sources', done: !!s?.sources.done, detail: s?.sources.configured.length ? `Active: ${s.sources.configured.join(', ')}` : 'OpenStreetMap works without a key. Add Google Places / Foursquare / Yelp for more coverage.' },
    { n: 2, title: 'Add API keys', done: !!s?.keys.done, detail: s?.keys.ai ? 'AI configured.' : 'Optional: places APIs, web search, and Anthropic for AI visual analysis and writing.' },
    { n: 3, title: 'Configure services', done: !!s?.services.done, detail: `${s?.services.count ?? 0} services in your catalogue. Set your studio name and sender in My Business.` },
    { n: 4, title: 'Create a campaign', done: !!s?.campaign.done, detail: 'Created automatically with your first search.' },
    { n: 5, title: 'Find leads', done: !!s?.leads.done, detail: 'Enter niche, city, country, service and quantity.' },
  ];
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Welcome — let's get your first leads" subtitle="Five short steps. Everything can be changed later." />
      <Panel>
        <ol className="grid grid-cols-1 gap-2 md:grid-cols-5">
          {steps.map((st) => (
            <li key={st.n} className={clsx('rounded-md border px-3 py-2', st.done ? 'border-ok/40 bg-ok-soft' : 'border-line')}>
              <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
                <span className={clsx('grid size-5 place-items-center rounded-full text-[11px]', st.done ? 'bg-ok text-white' : 'bg-sunken text-ink-3')}>{st.done ? <Check className="size-3" /> : st.n}</span>
                {st.title}
              </div>
              <div className="mt-1 text-[11.5px] text-ink-3">{st.detail}</div>
            </li>
          ))}
        </ol>
      </Panel>
      <SourcesPanel />
      <SecretsPanel />
      <Panel title="Services & studio profile">
        <p className="text-[12.5px] text-ink-2">
          A default catalogue (website redesign, landing page, WordPress, Webflow, Tilda, Bitrix, mobile/performance optimisation, SEO basics, maintenance, UX…) is ready. Adjust prices and add your studio name, sender and portfolio in{' '}
          <Link to="/business" className="text-accent hover:underline">
            My Business
          </Link>
          .
        </p>
      </Panel>
      <div className="flex justify-end gap-2">
        <Link to="/business">
          <Button>Edit my business</Button>
        </Link>
        <Button variant="primary" onClick={() => finish.mutate()} loading={finish.isPending}>
          Continue to first search
        </Button>
      </div>
    </div>
  );
}
