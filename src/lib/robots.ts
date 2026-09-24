/**
 * Minimal robots.txt evaluator (RFC 9309 longest-match semantics for Allow/Disallow).
 */
interface Group {
  agents: string[];
  rules: Array<{ allow: boolean; path: string }>;
}

export interface RobotsPolicy {
  isAllowed(path: string): boolean;
  sitemaps: string[];
  found: boolean;
}

export function parseRobots(text: string | null, userAgentToken: string): RobotsPolicy {
  if (text == null) return { isAllowed: () => true, sitemaps: [], found: false };
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      lastWasAgent = false;
      if (current && (value || key === 'allow')) current.rules.push({ allow: key === 'allow', path: value });
    } else if (key === 'sitemap') {
      sitemaps.push(value);
    } else {
      lastWasAgent = false;
    }
  }
  const token = userAgentToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const applicable = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = applicable.flatMap((g) => g.rules);
  const toRegex = (p: string) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`);
  return {
    found: true,
    sitemaps,
    isAllowed(path: string): boolean {
      let best: { allow: boolean; len: number } | null = null;
      for (const r of rules) {
        if (!r.path) continue;
        if (toRegex(r.path).test(path)) {
          const len = r.path.length;
          if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
        }
      }
      return best ? best.allow : true;
    },
  };
}
