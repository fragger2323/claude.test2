import { z } from 'zod';

import { BUSINESS_MODELS, COMPANY_SIZES, PRICE_SEGMENTS } from './search-options.js';

export { BUSINESS_MODELS, COMPANY_SIZES, PRICE_SEGMENTS };

const trimmed = (max: number) => z.string().trim().min(1).max(max);

export const searchParamsSchema = z.object({
  niche: trimmed(120),
  location: trimmed(120),
  country: trimmed(60),
  service: z.string().trim().max(120).optional(),
  quantity: z.coerce.number().int().min(1).max(1000).default(50),
  language: z.string().trim().max(10).optional(),
  radiusKm: z.coerce.number().min(1).max(100).optional(),
  /** Minimum Website Need (0..100) a lead must reach to be qualified — i.e. the quality gap threshold. */
  minWebsiteNeed: z.coerce.number().min(0).max(100).optional(),
  minCompanySize: z.enum(COMPANY_SIZES).default('any'),
  businessModel: z.enum(BUSINESS_MODELS).default('any'),
  priceSegment: z.enum(PRICE_SEGMENTS).default('any'),
  excludeExistingClients: z.boolean().default(true),
  excludePreviouslyContacted: z.boolean().default(true),
  onlyWithWebsite: z.boolean().default(false),
  onlyWithPublicContact: z.boolean().default(false),
  /** Only when an age signal exists (copyright year / Last-Modified); never guessed. */
  minWebsiteAgeYears: z.coerce.number().min(0).max(30).optional(),
  preferredIndustries: z.array(z.string().trim().max(80)).max(30).default([]),
  excludedIndustries: z.array(z.string().trim().max(80)).max(30).default([]),
  providers: z.array(z.string().max(40)).max(20).default([]),
  analyzeWebsites: z.boolean().default(true),
  visualAi: z.boolean().default(true),
  generateAudits: z.enum(['none', 'top']).default('none'),
});

export type SearchParams = z.infer<typeof searchParamsSchema>;
export type SearchParamsInput = z.input<typeof searchParamsSchema>;
