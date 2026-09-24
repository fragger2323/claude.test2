import clsx from 'clsx';
import { AlertTriangle, Inbox, Loader2, X } from 'lucide-react';
import { forwardRef, useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

// ───────────── Buttons ─────────────
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }>(
  function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={clsx(
          'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed select-none',
          size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
          variant === 'primary' && 'bg-accent text-accent-text hover:brightness-110 shadow-panel',
          variant === 'secondary' && 'bg-panel text-ink border border-line hover:bg-sunken shadow-panel',
          variant === 'ghost' && 'text-ink-2 hover:bg-sunken hover:text-ink',
          variant === 'danger' && 'bg-panel text-bad border border-line hover:bg-bad-soft',
          className,
        )}
        {...rest}
      >
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
        {children}
      </button>
    );
  },
);

// ───────────── Form controls ─────────────
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx('h-8 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={clsx('w-full rounded-md border border-line bg-panel px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx('h-8 rounded-md border border-line bg-panel px-2 text-[13px] text-ink focus:border-accent focus:outline-none', className)} {...rest}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('flex flex-col gap-1', className)}>
      <span className="text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
    </label>
  );
}

export function Checkbox({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-[13px] text-ink cursor-pointer select-none">
      <input type="checkbox" className="mt-0.5 size-3.5 accent-[var(--accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="block text-[11px] text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}

// ───────────── Layout primitives ─────────────
export function Panel({ title, actions, children, className, bodyClassName, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; id?: string }) {
  return (
    <section id={id} className={clsx('rounded-lg border border-line bg-panel shadow-panel', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
          <div className="flex items-center gap-1.5">{actions}</div>
        </header>
      )}
      <div className={clsx('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 pb-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[13px] text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'accent' }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-3.5 py-3 shadow-panel">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
      <div className={clsx('tnum mt-1 text-xl font-semibold', tone === 'ok' && 'text-ok', tone === 'warn' && 'text-warn', tone === 'bad' && 'text-bad', tone === 'accent' && 'text-accent')}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

// ───────────── Badges ─────────────
type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'accent' | 'ai';
const TONE: Record<Tone, string> = {
  neutral: 'bg-sunken text-ink-2 border-line',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  bad: 'bg-bad-soft text-bad border-transparent',
  info: 'bg-info-soft text-info border-transparent',
  accent: 'bg-accent-soft text-accent border-transparent',
  ai: 'bg-ai-soft text-ai border-transparent',
};
export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={clsx('inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] font-medium whitespace-nowrap', TONE[tone], className)}>
      {children}
    </span>
  );
}

// ───────────── States ─────────────
export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton', className)} />;
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="text-ink-3">{icon ?? <Inbox className="size-6" />}</div>
      <div className="text-[13px] font-medium text-ink">{title}</div>
      {children && <div className="max-w-md text-[12px] text-ink-3">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex items-start gap-3 rounded-lg border border-line bg-bad-soft px-4 py-3 text-[13px] text-bad">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="flex-1">
        <div className="font-medium">Something went wrong</div>
        <div className="text-[12px] opacity-90">{msg}</div>
      </div>
      {retry && (
        <Button size="sm" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

// ───────────── Score bar ─────────────
export function ScoreBar({ value, className }: { value: number | null | undefined; className?: string }) {
  if (value == null) return <span className="text-[12px] text-ink-3">—</span>;
  const tone = value >= 70 ? 'bg-ok' : value >= 45 ? 'bg-warn' : 'bg-ink-3';
  return (
    <div className={clsx('flex items-center gap-2', className)} title={`${value}/100`}>
      <div className="h-1.5 w-10 overflow-hidden rounded-full bg-sunken">
        <div className={clsx('h-full rounded-full', tone)} style={{ width: `${Math.max(3, value)}%` }} />
      </div>
      <span className="tnum w-6 text-right text-[12px] text-ink-2">{value}</span>
    </div>
  );
}

// ───────────── Tabs ─────────────
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: ReactNode; count?: number }>; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex flex-wrap items-center gap-1 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={clsx('-mb-px border-b-2 px-2.5 py-1.5 text-[13px] font-medium transition-colors', value === t.id ? 'border-accent text-ink' : 'border-transparent text-ink-3 hover:text-ink-2')}
        >
          {t.label}
          {t.count != null && <span className="tnum ml-1.5 rounded bg-sunken px-1 text-[11px] text-ink-3">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ───────────── Dialog ─────────────
export function Dialog({ open, onClose, title, children, footer, width = 'max-w-lg' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className={clsx('w-full rounded-xl border border-line bg-panel shadow-pop', width)}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="text-[14px] font-semibold">{title}</h3>
          <button aria-label="Close" onClick={onClose} className="rounded p-1 text-ink-3 hover:bg-sunken hover:text-ink">
            <X className="size-4" />
          </button>
        </div>
        <div className="p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ───────────── Toasts ─────────────
type ToastItem = { id: number; text: string; tone: 'ok' | 'bad' | 'info' };
let pushToast: ((t: Omit<ToastItem, 'id'>) => void) | null = null;
export const toast = {
  ok: (text: string) => pushToast?.({ text, tone: 'ok' }),
  error: (text: string) => pushToast?.({ text, tone: 'bad' }),
  info: (text: string) => pushToast?.({ text, tone: 'info' }),
};
export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    let n = 0;
    pushToast = (t) => {
      const id = ++n;
      setItems((xs) => [...xs, { ...t, id }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4500);
    };
    return () => {
      pushToast = null;
    };
  }, []);
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
      {items.map((t) => (
        <div key={t.id} className={clsx('pointer-events-auto max-w-sm rounded-lg border border-line bg-panel px-3.5 py-2.5 text-[13px] shadow-pop', t.tone === 'bad' && 'text-bad', t.tone === 'ok' && 'text-ok')}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-sunken px-1 font-mono text-[10px] text-ink-3">{children}</kbd>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-4 animate-spin text-ink-3', className)} />;
}
