import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Confidence, FindingDraft, ProblemTag, Severity } from '../../domain/types.js';
import type { AiProvider } from '../../providers/types.js';
import type { ScreenshotFile } from '../../providers/website/types.js';

/**
 * AI visual analysis (optional). Claude looks at the desktop and mobile first-screen
 * screenshots and returns subjective observations. They are stored as `ai_observation`
 * findings — explicitly separated from code-measured facts — each with evidence and confidence.
 */
export const VISUAL_DIMENSIONS = [
  'visual_hierarchy',
  'typography',
  'consistency',
  'spacing',
  'imagery',
  'modernity',
  'branding',
  'ui_quality',
  'polish',
  'value_proposition',
  'cta_clarity',
] as const;

export const VisualAnalysisSchema = z.object({
  observations: z.array(
    z.object({
      dimension: z.enum(VISUAL_DIMENSIONS),
      polarity: z.enum(['positive', 'negative', 'neutral']),
      observation: z.string(),
      evidence: z.string(),
      screenshot: z.enum(['desktop', 'mobile']),
      confidence: z.enum(['high', 'medium', 'low']),
      severity: z.enum(['high', 'medium', 'low', 'info']),
    }),
  ),
  overall: z.object({
    modernity: z.enum(['modern', 'somewhat_dated', 'dated', 'unclear']),
    summary: z.string(),
  }),
});
export type VisualAnalysis = z.infer<typeof VisualAnalysisSchema>;

const DIMENSION_TAGS: Record<(typeof VISUAL_DIMENSIONS)[number], ProblemTag[]> = {
  visual_hierarchy: ['visual_quality', 'landing_structure'],
  typography: ['visual_quality'],
  consistency: ['visual_quality', 'branding'],
  spacing: ['visual_quality'],
  imagery: ['imagery'],
  modernity: ['outdated_design'],
  branding: ['branding'],
  ui_quality: ['visual_quality'],
  polish: ['visual_quality'],
  value_proposition: ['service_presentation', 'landing_structure'],
  cta_clarity: ['weak_cta'],
};

export const VISUAL_SYSTEM_PROMPT = `You review website screenshots for a web design studio's internal research tool.
Describe only what is visible in the screenshots. Rules:
- Every observation must point to something concrete and visible (element, position, colours, text) in the named screenshot.
- Neutral, specific language. Do not speculate about the business, its revenue, customers, or intentions.
- Do not claim technical facts you cannot see (speed, SEO, code quality).
- Prefer 4-8 observations; include positives where they exist.
- "modernity" judgements must cite visible design cues (e.g. typography style, layout patterns, imagery treatment).
- Use low confidence when the screenshot is ambiguous (e.g. cookie banner covering content).`;

export interface VisualAiResult {
  status: 'completed' | 'failed' | 'skipped_no_provider' | 'skipped_disabled';
  findings: FindingDraft[];
  model?: string;
  error?: string;
  overall?: VisualAnalysis['overall'];
}

export async function runVisualAnalysis(opts: {
  ai: AiProvider;
  enabled: boolean;
  screenshots: ScreenshotFile[];
  screenshotDir: string;
  context: { companyName: string; industry?: string | null; url: string; codeFindingTitles: string[] };
  log: Logger;
  signal?: AbortSignal;
}): Promise<VisualAiResult> {
  if (!opts.enabled) return { status: 'skipped_disabled', findings: [] };
  if (!opts.ai.isConfigured()) return { status: 'skipped_no_provider', findings: [] };
  const desktop = opts.screenshots.find((s) => s.key === 'desktop-viewport');
  const mobile = opts.screenshots.find((s) => s.key === 'mobile-viewport');
  if (!desktop && !mobile) return { status: 'failed', findings: [], error: 'no screenshots available' };
  try {
    const images = [];
    const order: string[] = [];
    for (const s of [desktop, mobile]) {
      if (!s) continue;
      const buf = await readFile(join(opts.screenshotDir, s.path));
      images.push({ mediaType: 'image/jpeg' as const, dataBase64: buf.toString('base64') });
      order.push(s.viewport);
    }
    const prompt = [
      `Screenshots attached in this order: ${order.join(', ')} (first screen of the homepage).`,
      `Website: ${opts.context.url}`,
      opts.context.industry ? `Industry: ${opts.context.industry}` : '',
      opts.context.codeFindingTitles.length
        ? `Automated checks already recorded these facts (do not repeat them, do not contradict them): ${opts.context.codeFindingTitles.slice(0, 15).join('; ')}`
        : '',
      'Return structured observations about visual hierarchy, typography, consistency, spacing, imagery, modernity, branding, UI quality, polish, clarity of the value proposition and clarity of the call to action.',
    ]
      .filter(Boolean)
      .join('\n');
    const res = await opts.ai.generateJson(
      {
        task: 'visual_analysis',
        system: VISUAL_SYSTEM_PROMPT,
        prompt,
        images,
        schema: VisualAnalysisSchema,
        maxTokens: 8000,
        cacheSalt: [desktop?.sha256, mobile?.sha256].join(':'),
      },
      { log: opts.log, signal: opts.signal },
    );
    const findings: FindingDraft[] = res.data.observations.slice(0, 12).map((o, i) => ({
      code: `ai.visual.${o.dimension}.${i}`,
      category: o.dimension === 'cta_clarity' || o.dimension === 'value_proposition' ? 'ux' : 'visual',
      polarity: o.polarity,
      severity: (o.polarity === 'positive' ? 'info' : o.severity) as Severity,
      kind: 'ai_observation',
      source: 'ai',
      title: `${o.dimension.replace(/_/g, ' ')}: ${o.observation.slice(0, 90)}`,
      detail: o.observation,
      evidence: [
        { type: 'screenshot', ref: `${o.screenshot}-viewport`, label: `${o.screenshot} screenshot` },
        { type: 'text', excerpt: o.evidence.slice(0, 400), label: 'what the model pointed to' },
      ],
      viewport: o.screenshot,
      confidence: o.confidence as Confidence,
      problemTags: o.polarity === 'negative' ? DIMENSION_TAGS[o.dimension] : [],
    }));
    return { status: 'completed', findings, model: res.model, overall: res.data.overall };
  } catch (e) {
    opts.log.warn({ ai: true, task: 'visual_analysis', error: (e as Error).message }, 'visual analysis failed; technical analysis retained');
    return { status: 'failed', findings: [], error: (e as Error).message };
  }
}
