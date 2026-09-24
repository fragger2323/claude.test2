import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { fmtDate, providerName, relTime } from '../lib/format';
import { Badge, Button, ErrorState, Input, PageHeader, Panel, SkeletonRows, toast } from '../components/ui';

export interface ProvidersResp {
  sources: Array<{
    id: string;
    name: string;
    category: string;
    configured: boolean;
    enabled: boolean;
    hint: string;
    capabilities: Record<string, boolean>;
    dataPolicy: { retentionHours: number | null; attribution?: string; notes: string };
    circuitOpen: boolean;
    health: { totalCalls: number; totalFailures: number; consecutiveFailures: number; avgLatencyMs: number; lastSuccessAt: string | null; lastFailureAt: string | null; lastError: string | null } | null;
  }>;
  webSearchEngines: Array<{ id: string; name: string; configured: boolean; hint: string }>;
  secrets: Array<{ name: string; configured: boolean; source: 'env' | 'ui' | null; last4: string | null }>;
  usage: Array<{ provider: string; day: string; calls: number; failures: number; cacheHits: number; inputTokens: number; outputTokens: number }>;
  ai: { id: string; model: string; configured: boolean; tokensThisMonth: number; monthlyBudget: number; visualAnalysis: boolean; effort: string };
  limits: Record<string, number | boolean>;
  canStoreSecrets: boolean;
  warnings: Array<{ key: string; message: string }>;
}

const SECRET_LABELS: Record<string, string> = {
  GOOGLE_PLACES_API_KEY: 'Google Places API key',
  FOURSQUARE_API_KEY: 'Foursquare Places API key',
  YELP_API_KEY: 'Yelp Places (Fusion) API key',
  BRAVE_SEARCH_API_KEY: 'Brave Search API key',
  GOOGLE_CSE_API_KEY: 'Google Programmable Search API key',
  GOOGLE_CSE_CX: 'Google Programmable Search engine ID (cx)',
  ANTHROPIC_API_KEY: 'Anthropic API key (Claude)',
};

export function SecretsPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['providers'], queryFn: () => api<ProvidersResp>('/api/settings/providers') });
  const [values, setValues] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: ({ name, value }: { name: string; value: string | null }) => api(`/api/settings/secrets/${name}`, { method: 'PUT', body: { value } }),
    onSuccess: () => {
      toast.ok('Key saved (encrypted)');
      setValues({});
      void qc.invalidateQueries({ queryKey: ['providers'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!q.data) return <SkeletonRows rows={4} />;
  return (
    <Panel title="API keys" actions={<KeyRound className="size-4 text-ink-3" />}>
      <p className="mb-3 text-[12px] text-ink-3">
        Keys from the server environment always win. Keys entered here are encrypted with APP_ENCRYPTION_KEY and never sent back to the browser.
        {!q.data.canStoreSecrets && <span className="text-warn"> APP_ENCRYPTION_KEY is not set — add keys to .env instead.</span>}
      </p>
      <ul className="space-y-2">
        {q.data.secrets.map((s) => (
          <li key={s.name} className="grid grid-cols-1 items-center gap-2 md:grid-cols-[260px_1fr_auto]">
            <div className="text-[12.5px]">
              {SECRET_LABELS[s.name] ?? s.name}
              <div className="font-mono text-[10.5px] text-ink-3">{s.name}</div>
            </div>
            {s.source === 'env' ? (
              <div className="text-[12px] text-ink-2">
                <Badge tone="ok">set in environment</Badge> ••••{s.last4}
              </div>
            ) : (
              <Input type="password" autoComplete="off" placeholder={s.configured ? `saved ••••${s.last4}` : 'not set'} value={values[s.name] ?? ''} onChange={(e) => setValues({ ...values, [s.name]: e.target.value })} disabled={!q.data.canStoreSecrets} />
            )}
            {s.source !== 'env' && (
              <div className="flex gap-1">
                <Button size="sm" disabled={!values[s.name]} onClick={() => save.mutate({ name: s.name, value: values[s.name]! })}>
                  Save
                </Button>
                {s.configured && (
                  <Button size="sm" variant="ghost" onClick={() => save.mutate({ name: s.name, value: null })}>
                    Remove
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function SourcesPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['providers'], queryFn: () => api<ProvidersResp>('/api/settings/providers') });
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api(`/api/settings/sources/${id}`, { method: 'PUT', body: { enabled } }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['providers'] }) });
  if (q.isLoading) return <SkeletonRows rows={5} />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <Panel title="Lead sources" bodyClassName="p-0">
      <table className="w-full text-[12.5px]">
        <thead className="bg-panel-2 text-left text-[11px] uppercase text-ink-3">
          <tr>
            {['Source', 'Status', 'Health', 'Data policy', ''].map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {q.data!.sources.map((s) => (
            <tr key={s.id} className="border-t border-line align-top">
              <td className="px-3 py-2">
                <div className="font-medium">{s.name}</div>
                <div className="text-[11.5px] text-ink-3">{s.category}</div>
              </td>
              <td className="px-3 py-2">
                {s.configured ? <Badge tone={s.enabled ? 'ok' : 'neutral'}>{s.enabled ? 'active' : 'disabled'}</Badge> : <Badge tone="warn">not configured</Badge>}
                {s.circuitOpen && <Badge tone="bad" className="ml-1">circuit open</Badge>}
                {!s.configured && <div className="mt-1 max-w-xs text-[11.5px] text-ink-3">{s.hint}</div>}
              </td>
              <td className="px-3 py-2 text-[11.5px] text-ink-2">
                {s.health ? (
                  <>
                    <div className="tnum">
                      {s.health.totalCalls} calls · {s.health.totalFailures} failed · {s.health.avgLatencyMs} ms avg
                    </div>
                    <div className="text-ink-3">
                      last ok {relTime(s.health.lastSuccessAt)}
                      {s.health.lastFailureAt && ` · last failure ${relTime(s.health.lastFailureAt)}`}
                    </div>
                    {s.health.lastError && <div className="text-bad">{s.health.lastError}</div>}
                  </>
                ) : (
                  <span className="text-ink-3">no calls yet</span>
                )}
              </td>
              <td className="max-w-xs px-3 py-2 text-[11.5px] text-ink-3">
                {s.dataPolicy.retentionHours ? `Raw content kept ${Math.round(s.dataPolicy.retentionHours / 24) || 1} day(s). ` : ''}
                {s.dataPolicy.notes}
              </td>
              <td className="px-3 py-2 text-right">
                {s.configured && s.id !== 'import' && (
                  <Button size="sm" variant="ghost" onClick={() => toggle.mutate({ id: s.id, enabled: !s.enabled })}>
                    {s.enabled ? 'Disable' : 'Enable'}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

export default function Settings() {
  const q = useQuery({ queryKey: ['providers'], queryFn: () => api<ProvidersResp>('/api/settings/providers') });
  const d = q.data;
  const usageByProvider = new Map<string, { calls: number; failures: number; cacheHits: number; tokens: number }>();
  for (const u of d?.usage ?? []) {
    const e = usageByProvider.get(u.provider) ?? { calls: 0, failures: 0, cacheHits: 0, tokens: 0 };
    e.calls += u.calls;
    e.failures += u.failures;
    e.cacheHits += u.cacheHits;
    e.tokens += u.inputTokens + u.outputTokens;
    usageByProvider.set(u.provider, e);
  }
  return (
    <div className="space-y-4">
      <PageHeader title="Settings" subtitle="Sources, keys, AI and cost controls." />
      {d?.warnings.length ? (
        <div className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-2.5 text-[12.5px] text-warn">
          {d.warnings.map((w) => (
            <div key={w.key}>
              <span className="font-mono">{w.key}</span>: {w.message}
            </div>
          ))}
        </div>
      ) : null}
      <SourcesPanel />
      <SecretsPanel />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="AI">
          {d ? (
            <div className="space-y-1 text-[12.5px]">
              <div>
                {d.ai.configured ? <Badge tone="ok">configured</Badge> : <Badge tone="warn">not configured</Badge>} <span className="ml-1">model {d.ai.model}</span> · effort {d.ai.effort}
              </div>
              <div className="tnum text-ink-2">
                Tokens this month: {d.ai.tokensThisMonth.toLocaleString()} / {d.ai.monthlyBudget.toLocaleString()} budget
              </div>
              <div className="text-ink-3">AI is used only for visual observations, audit prose and outreach drafts. All measurable checks run as code. Results are cached; without AI the technical analysis still works.</div>
            </div>
          ) : (
            <SkeletonRows rows={3} />
          )}
        </Panel>
        <Panel title="Usage (last 30 days)">
          {usageByProvider.size === 0 ? (
            <div className="text-[12px] text-ink-3">No external calls yet.</div>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead className="text-left text-[11px] uppercase text-ink-3">
                <tr>
                  <th className="py-1 font-medium">Provider</th>
                  <th className="py-1 font-medium">Calls</th>
                  <th className="py-1 font-medium">Cache hits</th>
                  <th className="py-1 font-medium">Failures</th>
                  <th className="py-1 font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {[...usageByProvider.entries()].map(([p, u]) => (
                  <tr key={p} className="tnum border-t border-line">
                    <td className="py-1">{providerName(p)}</td>
                    <td>{u.calls}</td>
                    <td>{u.cacheHits}</td>
                    <td>{u.failures}</td>
                    <td>{u.tokens || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {d && (
            <div className="mt-2 text-[11.5px] text-ink-3">
              Limits: {String(d.limits.maxProviderCallsPerJob)} provider calls per job · {String(d.limits.analysisMaxPages)} pages per site · browser pool {String(d.limits.browserPoolSize)} · re-analyse after {String(d.limits.reanalyzeAfterDays)} days · robots.txt {d.limits.respectRobotsTxt ? 'respected' : 'ignored'}. Updated {fmtDate(new Date())}.
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
