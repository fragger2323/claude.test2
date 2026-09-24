import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { Logger } from 'pino';
import { db } from '../../db/client.js';
import { cacheGet, cacheSet } from '../../lib/cache.js';
import { recordUsage } from '../health.js';
import { AiUnavailableError, type AiJsonRequest, type AiProvider, type AiResult } from '../types.js';

export class AiRefusalError extends Error {
  override name = 'AiRefusalError';
}
export class AiBudgetError extends AiUnavailableError {
  override name = 'AiBudgetError';
}

export interface AnthropicOptions {
  apiKey: string | undefined;
  baseUrl?: string;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  monthlyTokenBudget: number;
  serverFallbacks: boolean;
}

/** Tokens used by this provider in the current calendar month (from ProviderUsage). */
export async function aiTokensThisMonth(provider = 'anthropic'): Promise<number> {
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const rows = await db().providerUsage.findMany({ where: { provider, day: { startsWith: monthPrefix } } });
  return rows.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
}

/**
 * Claude adapter. Used only for reasoning/writing tasks (visual/UX interpretation, audit prose,
 * outreach drafts). Results are cached by prompt hash; a monthly token budget is enforced.
 */
export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic';
  readonly model: string;
  private client: Anthropic | null = null;

  constructor(private readonly opts: AnthropicOptions) {
    this.model = opts.model;
  }

  isConfigured(): boolean {
    return !!this.opts.apiKey;
  }

  private sdk(): Anthropic {
    if (!this.opts.apiKey) throw new AiUnavailableError('ANTHROPIC_API_KEY is not configured');
    this.client ??= new Anthropic({ apiKey: this.opts.apiKey, baseURL: this.opts.baseUrl, timeout: 180_000, maxRetries: 2 });
    return this.client;
  }

  /** Server-side refusal fallbacks are only offered on models that support them. */
  private useFallbacks(): boolean {
    return this.opts.serverFallbacks && /^claude-(opus-5|fable-5)/.test(this.model);
  }

  async generateJson<T>(req: AiJsonRequest<T>, ctx: { signal?: AbortSignal; log: Logger }): Promise<AiResult<T>> {
    const cacheParts = { model: this.model, task: req.task, system: req.system, prompt: req.prompt, salt: req.cacheSalt ?? null, images: req.images?.length ?? 0 };
    const cached = await cacheGet<{ data: T; model: string }>(`ai:${req.task}`, cacheParts);
    if (cached) {
      await recordUsage(this.id, { cacheHits: 1 }).catch(() => undefined);
      ctx.log.info({ ai: true, task: req.task, cached: true }, 'ai cache hit');
      return { data: cached.data, model: cached.model, cached: true, usage: { inputTokens: 0, outputTokens: 0 } };
    }
    if (this.opts.monthlyTokenBudget > 0) {
      const used = await aiTokensThisMonth(this.id);
      if (used >= this.opts.monthlyTokenBudget) {
        throw new AiBudgetError(`monthly AI token budget reached (${used}/${this.opts.monthlyTokenBudget})`);
      }
    }

    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const img of req.images ?? []) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 } });
    }
    content.push({ type: 'text', text: req.prompt });

    const started = Date.now();
    try {
      const response = await this.sdk().beta.messages.parse(
        {
          model: this.model,
          max_tokens: req.maxTokens ?? 16000,
          system: req.system,
          messages: [{ role: 'user', content }],
          output_config: {
            format: betaZodOutputFormat(req.schema as never),
            ...(this.opts.effort ? { effort: this.opts.effort } : {}),
          },
          ...(this.useFallbacks() ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        },
        { signal: ctx.signal },
      );
      const usage = { inputTokens: response.usage.input_tokens ?? 0, outputTokens: response.usage.output_tokens ?? 0 };
      await recordUsage(this.id, { calls: 1, ...usage }).catch(() => undefined);
      const latencyMs = Date.now() - started;
      if (response.stop_reason === 'refusal') {
        ctx.log.warn({ ai: true, task: req.task, model: response.model, latencyMs }, 'ai refusal');
        throw new AiRefusalError('the model declined this request');
      }
      if (response.stop_reason === 'max_tokens') {
        throw new Error('AI response truncated (max_tokens)');
      }
      const parsed = response.parsed_output as T | null | undefined;
      if (parsed == null) throw new Error('AI response did not match the expected schema');
      ctx.log.info({ ai: true, task: req.task, model: response.model, latencyMs, ...usage }, 'ai request completed');
      await cacheSet(`ai:${req.task}`, cacheParts, { data: parsed, model: response.model }, req.cacheTtlHours ?? 24 * 30).catch(() => undefined);
      return { data: parsed, model: response.model, cached: false, usage };
    } catch (e) {
      const latencyMs = Date.now() - started;
      if (!(e instanceof AiRefusalError)) await recordUsage(this.id, { calls: 1, failures: 1 }).catch(() => undefined);
      if (e instanceof Anthropic.AuthenticationError) {
        ctx.log.error({ ai: true, task: req.task, latencyMs }, 'ai authentication failed');
        throw new AiUnavailableError('AI authentication failed — check ANTHROPIC_API_KEY');
      }
      if (e instanceof Anthropic.RateLimitError) {
        ctx.log.warn({ ai: true, task: req.task, latencyMs }, 'ai rate limited');
        throw new AiUnavailableError('AI rate limited — try again later');
      }
      if (e instanceof Anthropic.APIError) {
        ctx.log.error({ ai: true, task: req.task, latencyMs, status: e.status, error: e.message }, 'ai request failed');
        throw new AiUnavailableError(`AI request failed (HTTP ${e.status ?? '?'})`);
      }
      ctx.log.error({ ai: true, task: req.task, latencyMs, error: (e as Error).message }, 'ai request failed');
      throw e;
    }
  }
}

/** Used when no AI is configured: every call fails fast and callers fall back to templates. */
export class DisabledAiProvider implements AiProvider {
  readonly id = 'none';
  readonly model = 'none';
  isConfigured(): boolean {
    return false;
  }
  async generateJson<T>(): Promise<AiResult<T>> {
    throw new AiUnavailableError('AI provider is not configured');
  }
}
