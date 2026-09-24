import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Command } from 'cmdk';
import {
  BarChart3,
  Briefcase,
  Brain,
  CalendarCheck2,
  FolderKanban,
  Keyboard,
  KanbanSquare,
  LayoutList,
  LogOut,
  Moon,
  Search,
  Settings,
  Sparkles,
  Star,
  Sun,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { api } from '../lib/api';
import { Dialog, Kbd } from './ui';
import { PriorityBadge } from './domain';

const NAV = [
  { to: '/today', label: 'Today', icon: CalendarCheck2, key: 't' },
  { to: '/search', label: 'New search', icon: Search, key: 'n' },
  { to: '/leads', label: 'Leads', icon: LayoutList, key: 'l' },
  { to: '/crm', label: 'CRM', icon: KanbanSquare, key: 'c' },
  { to: '/campaigns', label: 'Campaigns', icon: FolderKanban, key: 'p' },
  { to: '/saved', label: 'Saved searches', icon: Star, key: 'v' },
  { to: '/dashboard', label: 'Dashboard', icon: BarChart3, key: 'd' },
  { to: '/learning', label: 'Learning', icon: Brain, key: 'e' },
  { to: '/business', label: 'My Business', icon: Briefcase, key: 'b' },
  { to: '/import', label: 'Import', icon: Upload, key: 'i' },
  { to: '/settings', label: 'Settings', icon: Settings, key: 's' },
];

export function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = useCallback(() => {
    const next = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('aios-theme', next ? 'dark' : 'light');
    } catch {
      // storage unavailable — theme still switches for this session
    }
    setDark(next);
  }, []);
  return [dark, toggle];
}

interface ParsedCommand {
  niche?: string;
  location?: string;
  country?: string;
  service?: string;
  quantity?: number;
  missing: string[];
  confidence: string;
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [parsed, setParsed] = useState<ParsedCommand | null>(null);
  const [leads, setLeads] = useState<Array<{ id: string; company: string; city: string | null; priority: string | null }>>([]);
  useEffect(() => {
    if (!open) {
      setValue('');
      setParsed(null);
      setLeads([]);
    }
  }, [open]);
  useEffect(() => {
    const v = value.trim();
    if (v.length < 3) {
      setParsed(null);
      setLeads([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      if (/\d|\b(find|search|знай|найд|znajd)/i.test(v)) {
        api<ParsedCommand>('/api/command/parse', { body: { text: v }, signal: ctrl.signal }).then(setParsed).catch(() => undefined);
      } else setParsed(null);
      api<{ rows: Array<{ id: string; company: string; city: string | null; priority: string | null }> }>('/api/leads', { query: { q: v, pageSize: 8 }, signal: ctrl.signal })
        .then((r) => setLeads(r.rows))
        .catch(() => undefined);
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [value]);

  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <Command label="Command palette" className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-panel shadow-pop" shouldFilter={false} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Sparkles className="size-4 text-accent" />
          <Command.Input autoFocus value={value} onValueChange={setValue} placeholder='Try "Find 100 dental clinics in Warsaw for premium website redesign" or a company name…' className="h-11 w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3" />
        </div>
        <Command.List className="scroll-thin max-h-[55vh] overflow-y-auto p-1.5">
          {parsed && (parsed.niche || parsed.location) && (
            <Command.Group heading="Search command">
              <Command.Item
                value="run-command"
                onSelect={() => {
                  const p = new URLSearchParams();
                  for (const k of ['niche', 'location', 'country', 'service'] as const) if (parsed[k]) p.set(k, String(parsed[k]));
                  if (parsed.quantity) p.set('quantity', String(parsed.quantity));
                  go(`/search?${p.toString()}`);
                }}
                className="flex cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2"
              >
                <span className="text-[13px] font-medium">
                  Find {parsed.quantity ?? '…'} × {parsed.niche ?? '…'} · {parsed.location ?? '…'}
                  {parsed.country ? `, ${parsed.country}` : ''}
                </span>
                <span className="text-[12px] text-ink-3">
                  {parsed.service ? `for ${parsed.service}` : 'service not specified'}
                  {parsed.missing.length ? ` · missing: ${parsed.missing.join(', ')} (you'll confirm in the form)` : ' · ready — review and start'}
                </span>
              </Command.Item>
            </Command.Group>
          )}
          {leads.length > 0 && (
            <Command.Group heading="Leads">
              {leads.map((l) => (
                <Command.Item key={l.id} value={`lead-${l.id}`} onSelect={() => go(`/leads/${l.id}`)} className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[13px]">
                  <span>
                    {l.company} <span className="text-ink-3">{l.city}</span>
                  </span>
                  <PriorityBadge priority={l.priority} />
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading="Go to">
            {NAV.filter((n) => !value || n.label.toLowerCase().includes(value.toLowerCase())).map((n) => (
              <Command.Item key={n.to} value={n.to} onSelect={() => go(n.to)} className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-[13px]">
                <n.icon className="size-4 text-ink-3" /> {n.label}
                <span className="ml-auto flex gap-1">
                  <Kbd>g</Kbd>
                  <Kbd>{n.key}</Kbd>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Empty className="px-3 py-6 text-center text-[13px] text-ink-3">No matches.</Command.Empty>
        </Command.List>
      </Command>
    </div>
  );
}

function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rows: Array<[ReactNode, string]> = [
    [<Kbd key="k">⌘/Ctrl K</Kbd>, 'Command palette (search commands, leads, navigation)'],
    [<Kbd key="s">/</Kbd>, 'Focus the page search field'],
    [<span key="g" className="flex gap-1"><Kbd>g</Kbd><Kbd>t/l/c/d…</Kbd></span>, 'Go to Today / Leads / CRM / Dashboard …'],
    [<span key="jk" className="flex gap-1"><Kbd>j</Kbd><Kbd>k</Kbd></span>, 'Move selection in tables'],
    [<Kbd key="e">Enter</Kbd>, 'Open selected lead'],
    [<Kbd key="q">?</Kbd>, 'This help'],
  ];
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      <table className="w-full text-[13px]">
        <tbody>
          {rows.map(([k, d], i) => (
            <tr key={i} className="border-b border-line last:border-0">
              <td className="py-2 pr-4">{k}</td>
              <td className="py-2 text-ink-2">{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

export function Layout({ children, user, onLogout }: { children: ReactNode; user: { email: string; name: string | null }; onLogout: () => void }) {
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [dark, toggleTheme] = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const gPressed = useRef(0);
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: () => api<{ jobs: { queued: number; running: number } }>('/api/health'), refetchInterval: 10_000 });

  const byKey = useMemo(() => Object.fromEntries(NAV.map((n) => [n.key, n.to])), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '?') {
        setHelp(true);
        return;
      }
      if (e.key === '/') {
        const el = document.querySelector<HTMLInputElement>('[data-page-search]');
        if (el) {
          e.preventDefault();
          el.focus();
        }
        return;
      }
      if (e.key === 'g') {
        gPressed.current = Date.now();
        return;
      }
      if (Date.now() - gPressed.current < 900 && byKey[e.key]) {
        gPressed.current = 0;
        navigate(byKey[e.key]!);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [byKey, navigate]);

  useEffect(() => setPalette(false), [location.pathname]);

  return (
    <div className="flex h-full">
      <aside className="hidden w-[212px] shrink-0 flex-col border-r border-line bg-panel md:flex">
        <div className="flex items-center gap-2 px-4 py-3.5">
          <div className="grid size-6 place-items-center rounded-md bg-ink text-[11px] font-bold text-panel">AI</div>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold">Agency Intelligence</div>
            <div className="text-[10px] uppercase tracking-wider text-ink-3">Business OS</div>
          </div>
        </div>
        <button onClick={() => setPalette(true)} className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-line bg-panel-2 px-2.5 py-1.5 text-left text-[12px] text-ink-3 hover:bg-sunken">
          <Search className="size-3.5" /> Command…
          <span className="ml-auto">
            <Kbd>⌘K</Kbd>
          </span>
        </button>
        <nav className="scroll-thin flex-1 space-y-0.5 overflow-y-auto px-2 py-1" aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => clsx('flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px]', isActive ? 'bg-sunken font-medium text-ink' : 'text-ink-2 hover:bg-sunken/70 hover:text-ink')}>
              <n.icon className="size-4 shrink-0" />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line px-3 py-2.5 text-[12px]">
          {health && (health.jobs.running > 0 || health.jobs.queued > 0) && (
            <div className="mb-2 flex items-center gap-1.5 text-ink-3">
              <span className="size-1.5 animate-pulse rounded-full bg-accent" /> {health.jobs.running} running · {health.jobs.queued} queued
            </div>
          )}
          <div className="flex items-center justify-between gap-1">
            <span className="truncate text-ink-3" title={user.email}>
              {user.name ?? user.email}
            </span>
            <div className="flex">
              <button aria-label="Keyboard shortcuts" className="rounded p-1 text-ink-3 hover:bg-sunken" onClick={() => setHelp(true)}>
                <Keyboard className="size-3.5" />
              </button>
              <button aria-label="Toggle theme" className="rounded p-1 text-ink-3 hover:bg-sunken" onClick={toggleTheme}>
                {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
              </button>
              <button aria-label="Sign out" className="rounded p-1 text-ink-3 hover:bg-sunken" onClick={onLogout}>
                <LogOut className="size-3.5" />
              </button>
            </div>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2 md:hidden">
          <div className="grid size-6 place-items-center rounded-md bg-ink text-[11px] font-bold text-panel">AI</div>
          <select aria-label="Navigate" className="flex-1 rounded-md border border-line bg-panel px-2 py-1 text-[13px]" value={NAV.find((n) => location.pathname.startsWith(n.to))?.to ?? ''} onChange={(e) => navigate(e.target.value)}>
            {NAV.map((n) => (
              <option key={n.to} value={n.to}>
                {n.label}
              </option>
            ))}
          </select>
          <button aria-label="Command palette" className="rounded-md border border-line p-1.5" onClick={() => setPalette(true)}>
            <Search className="size-4" />
          </button>
        </div>
        <main className="scroll-thin min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1440px] px-4 py-5 md:px-6">{children}</div>
        </main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <ShortcutsHelp open={help} onClose={() => setHelp(false)} />
    </div>
  );
}
