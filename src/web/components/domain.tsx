import clsx from 'clsx';
import { Bot, CheckCircle2, CircleDashed, Eye, Gauge, HelpCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from './ui';
import { priorityLabel, providerName, stageLabel } from '../lib/format';

const PRIORITY_TONE: Record<string, 'bad' | 'warn' | 'info' | 'neutral' | 'accent' | 'ok'> = {
  very_high: 'accent',
  high: 'ok',
  medium: 'info',
  low: 'neutral',
  insufficient_data: 'warn',
  excluded: 'neutral',
};

export function PriorityBadge({ priority }: { priority: string | null | undefined }) {
  const tone = priority ? PRIORITY_TONE[priority] ?? 'neutral' : 'neutral';
  return (
    <Badge tone={tone} className={clsx(priority === 'excluded' && 'line-through opacity-70')}>
      {priorityLabel(priority)}
    </Badge>
  );
}

export function StageBadge({ stage }: { stage: string }) {
  const tone = stage === 'won' ? 'ok' : stage === 'lost' ? 'bad' : ['replied', 'meeting', 'proposal'].includes(stage) ? 'accent' : stage === 'contact_ready' ? 'info' : 'neutral';
  return <Badge tone={tone}>{stageLabel(stage)}</Badge>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  const tone = severity === 'critical' || severity === 'high' ? 'bad' : severity === 'medium' ? 'warn' : 'neutral';
  return <Badge tone={tone}>{severity}</Badge>;
}

/** Visual distinction between observed facts, measurements and AI opinions. */
export function KindBadge({ kind, source }: { kind: string; source?: string }) {
  if (kind === 'ai_observation')
    return (
      <Badge tone="ai" title="Subjective assessment by the AI model from screenshots — not a measured fact">
        <Bot className="size-3" /> AI observation
      </Badge>
    );
  if (kind === 'measured')
    return (
      <Badge tone="info" title="Numeric lab measurement from one page load">
        <Gauge className="size-3" /> Measured
      </Badge>
    );
  return (
    <Badge tone="neutral" title={`Observed by automated checks${source === 'lighthouse' ? ' (Lighthouse)' : ''}`}>
      <Eye className="size-3" /> Observed
    </Badge>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: string }) {
  return (
    <Badge tone={confidence === 'high' ? 'neutral' : confidence === 'medium' ? 'neutral' : 'warn'} title="Confidence in this item">
      {confidence} conf.
    </Badge>
  );
}

export function ContactStatusBadge({ status }: { status: string }) {
  if (status === 'verified')
    return (
      <Badge tone="ok" title="Published on the official website, or confirmed by 2+ independent sources">
        <CheckCircle2 className="size-3" /> verified
      </Badge>
    );
  if (status === 'probable')
    return (
      <Badge tone="info" title="From one business listing; not seen on the official website">
        <CircleDashed className="size-3" /> probable
      </Badge>
    );
  return (
    <Badge tone="warn" title="Weak or conflicting evidence">
      <HelpCircle className="size-3" /> unverified
    </Badge>
  );
}

export function SourceChips({ sources, max = 4 }: { sources: string[]; max?: number }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {sources.slice(0, max).map((s) => (
        <Badge key={s} tone="neutral">
          {providerName(s)}
        </Badge>
      ))}
      {sources.length > max && <Badge tone="neutral">+{sources.length - max}</Badge>}
    </span>
  );
}

export function FreshnessBadge({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-ink-3">—</span>;
  const label = value >= 85 ? 'Fresh' : value >= 65 ? 'Recent' : value >= 40 ? 'Aging' : 'Stale';
  return <Badge tone={value >= 65 ? 'ok' : value >= 40 ? 'warn' : 'bad'}>{label}</Badge>;
}

export function ContactBadge({ availability }: { availability: string | null | undefined }) {
  const map: Record<string, string> = { email: 'E-mail', form: 'Form', phone: 'Phone', social: 'Social', none: 'None' };
  const a = availability ?? 'none';
  return <Badge tone={a === 'none' ? 'warn' : a === 'email' || a === 'form' ? 'ok' : 'neutral'}>{map[a] ?? a}</Badge>;
}

export function KnowledgeBlock({ title, items, tone, empty }: { title: string; items: string[]; tone: 'fact' | 'observed' | 'infer' | 'unknown'; empty?: string }) {
  const color = { fact: 'border-l-ink-3', observed: 'border-l-info', infer: 'border-l-ai', unknown: 'border-l-warn' }[tone];
  return (
    <div className={clsx('rounded-md border border-line border-l-[3px] bg-panel-2 px-3 py-2', color)}>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{title}</div>
      {items.length ? (
        <ul className="space-y-1 text-[12.5px] text-ink-2">
          {items.map((t, i) => (
            <li key={i} className="leading-snug">
              {t}
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-[12px] text-ink-3">{empty ?? '—'}</div>
      )}
    </div>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}
