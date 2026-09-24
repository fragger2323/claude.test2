import { db } from '../db/client.js';
import { isoDay } from '../lib/misc.js';
import { logger } from '../lib/logger.js';

/**
 * Provider health monitoring + circuit breaker.
 * State is kept in memory for speed and persisted to the `Source` table for the UI.
 */
interface State {
  consecutiveFailures: number;
  openUntil: number;
  lastError?: string;
}

const state = new Map<string, State>();
const FAILURE_THRESHOLD = 5;
const BASE_OPEN_MS = 2 * 60_000;
const MAX_OPEN_MS = 30 * 60_000;

function get(id: string): State {
  let s = state.get(id);
  if (!s) {
    s = { consecutiveFailures: 0, openUntil: 0 };
    state.set(id, s);
  }
  return s;
}

export function circuitStatus(id: string): { open: boolean; until?: Date; reason?: string } {
  const s = get(id);
  if (s.openUntil > Date.now()) return { open: true, until: new Date(s.openUntil), reason: s.lastError };
  return { open: false };
}

export interface CallOutcome {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
}

export async function recordProviderCall(id: string, outcome: CallOutcome): Promise<void> {
  const s = get(id);
  const authFailure = outcome.status === 401 || outcome.status === 403;
  if (outcome.ok) {
    s.consecutiveFailures = 0;
    s.openUntil = 0;
  } else {
    s.consecutiveFailures++;
    s.lastError = authFailure ? `authentication/authorization failed (HTTP ${outcome.status}) — check the API key and API enablement` : outcome.error;
    if (authFailure || s.consecutiveFailures >= FAILURE_THRESHOLD) {
      const factor = authFailure ? 8 : 2 ** Math.min(4, s.consecutiveFailures - FAILURE_THRESHOLD);
      s.openUntil = Date.now() + Math.min(MAX_OPEN_MS, BASE_OPEN_MS * factor);
      logger('provider-health').warn({ provider: id, consecutiveFailures: s.consecutiveFailures, openUntil: new Date(s.openUntil).toISOString(), error: s.lastError }, 'circuit opened');
    }
  }
  try {
    const now = new Date();
    const existing = await db().source.findUnique({ where: { id } });
    const totalCalls = (existing?.totalCalls ?? 0) + 1;
    const avg = existing ? Math.round((existing.avgLatencyMs * existing.totalCalls + outcome.latencyMs) / totalCalls) : outcome.latencyMs;
    await db().source.upsert({
      where: { id },
      create: {
        id,
        name: id,
        category: 'unknown',
        config: {},
        totalCalls: 1,
        totalFailures: outcome.ok ? 0 : 1,
        consecutiveFailures: s.consecutiveFailures,
        avgLatencyMs: outcome.latencyMs,
        lastSuccessAt: outcome.ok ? now : null,
        lastFailureAt: outcome.ok ? null : now,
        lastError: outcome.ok ? null : s.lastError,
        circuitOpenUntil: s.openUntil ? new Date(s.openUntil) : null,
      },
      update: {
        totalCalls: { increment: 1 },
        totalFailures: outcome.ok ? undefined : { increment: 1 },
        consecutiveFailures: s.consecutiveFailures,
        avgLatencyMs: avg,
        lastSuccessAt: outcome.ok ? now : undefined,
        lastFailureAt: outcome.ok ? undefined : now,
        lastError: outcome.ok ? undefined : s.lastError,
        circuitOpenUntil: s.openUntil ? new Date(s.openUntil) : null,
      },
    });
    await recordUsage(id, { calls: 1, failures: outcome.ok ? 0 : 1 });
  } catch (e) {
    logger('provider-health').warn({ provider: id, err: (e as Error).message }, 'failed to persist provider health');
  }
}

export async function recordUsage(
  provider: string,
  delta: { calls?: number; failures?: number; cacheHits?: number; inputTokens?: number; outputTokens?: number },
): Promise<void> {
  const day = isoDay();
  await db().providerUsage.upsert({
    where: { provider_day: { provider, day } },
    create: {
      provider,
      day,
      calls: delta.calls ?? 0,
      failures: delta.failures ?? 0,
      cacheHits: delta.cacheHits ?? 0,
      inputTokens: delta.inputTokens ?? 0,
      outputTokens: delta.outputTokens ?? 0,
    },
    update: {
      calls: { increment: delta.calls ?? 0 },
      failures: { increment: delta.failures ?? 0 },
      cacheHits: { increment: delta.cacheHits ?? 0 },
      inputTokens: { increment: delta.inputTokens ?? 0 },
      outputTokens: { increment: delta.outputTokens ?? 0 },
    },
  });
}

/** Test helper. */
export function resetHealthState(): void {
  state.clear();
}
