import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { PROBLEM_TAGS } from '../../domain/types.js';
import { DEFAULT_SERVICES } from '../../engine/fit/service-catalog.js';
import { enqueueJob } from '../../jobs/queue.js';
import { slugify } from '../../lib/text.js';
import { normalizeUrl } from '../../lib/url.js';
import { assertId, notFound, parseBody } from '../validation.js';

const strList = z.array(z.string().trim().min(1).max(120)).max(50);

const profileSchema = z.object({
  studioName: z.string().trim().max(120).nullable().optional(),
  senderName: z.string().trim().max(120).nullable().optional(),
  senderRole: z.string().trim().max(120).nullable().optional(),
  website: z.string().trim().max(300).nullable().optional(),
  currency: z.string().trim().length(3).optional(),
  minProjectSize: z.number().int().min(0).max(10_000_000).nullable().optional(),
  targetClientProfile: z.string().max(2000).nullable().optional(),
  communicationLanguage: z.enum(['en', 'pl', 'ru', 'uk', 'de']).optional(),
  preferredIndustries: strList.optional(),
  excludedIndustries: strList.optional(),
  preferredCountries: strList.optional(),
  preferredCities: strList.optional(),
  preferredTechnologies: strList.optional(),
  disallowedProjectTypes: strList.optional(),
  portfolioUrls: z.array(z.string().max(300)).max(50).optional(),
  scoringWeights: z.record(z.string(), z.number().min(0).max(1)).nullable().optional(),
  onboardingCompleted: z.boolean().optional(),
});

const exclusionRule = z.discriminatedUnion('type', [
  z.object({ type: z.literal('requires_tag'), tag: z.enum(PROBLEM_TAGS), reason: z.string().max(300) }),
  z.object({ type: z.literal('excludes_tag'), tag: z.enum(PROBLEM_TAGS), reason: z.string().max(300) }),
  z.object({ type: z.literal('requires_website'), reason: z.string().max(300) }),
  z.object({ type: z.literal('min_commercial_relevance'), value: z.number().min(0).max(100), reason: z.string().max(300) }),
  z.object({ type: z.literal('min_evidence_categories'), value: z.number().int().min(1).max(10), reason: z.string().max(300) }),
]);

const serviceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().max(80).optional(),
  description: z.string().max(2000).nullable().optional(),
  priceMin: z.number().int().min(0).nullable().optional(),
  priceMax: z.number().int().min(0).nullable().optional(),
  currency: z.string().length(3).default('EUR'),
  targetProfile: z.string().max(2000).nullable().optional(),
  problemTypes: z.array(z.object({ tag: z.enum(PROBLEM_TAGS), weight: z.number().min(0).max(5) })).max(30).default([]),
  minimumFit: z.number().int().min(0).max(100).default(40),
  excludedCases: z.array(exclusionRule).max(20).default([]),
  technologies: strList.default([]),
  projectSize: z.enum(['small', 'medium', 'large']).default('medium'),
  active: z.boolean().default(true),
  sortOrder: z.number().int().optional(),
});

const portfolioSchema = z.object({
  name: z.string().trim().min(1).max(160),
  url: z.string().trim().max(300).nullable().optional(),
  industry: z.string().trim().max(120).nullable().optional(),
  technologies: strList.default([]),
  styles: strList.default([]),
  services: z.array(z.string().max(80)).max(20).default([]),
  caseStudy: z.string().max(10_000).nullable().optional(),
  results: z.string().max(4000).nullable().optional(),
  active: z.boolean().default(true),
});

export function registerBusinessRoutes(app: FastifyInstance): void {
  app.get('/api/business/profile', async () => db().businessProfile.findUnique({ where: { id: 'default' } }));

  app.put('/api/business/profile', async (req) => {
    const body = parseBody(profileSchema, req.body);
    const { onboardingCompleted, scoringWeights, ...rest } = body;
    return db().businessProfile.update({
      where: { id: 'default' },
      data: {
        ...rest,
        website: rest.website ? normalizeUrl(rest.website) ?? rest.website : rest.website,
        scoringWeights: scoringWeights === null ? undefined : (scoringWeights as Prisma.InputJsonValue | undefined),
        onboardingCompletedAt: onboardingCompleted ? new Date() : undefined,
      },
    });
  });

  app.get('/api/services', async () => db().service.findMany({ orderBy: { sortOrder: 'asc' } }));
  app.get('/api/services/problem-tags', async () => PROBLEM_TAGS);

  app.post('/api/services', async (req) => {
    const body = parseBody(serviceSchema, req.body);
    const slug = slugify(body.slug || body.name);
    return db().service.create({ data: { ...body, slug, problemTypes: body.problemTypes, excludedCases: body.excludedCases as unknown as Prisma.InputJsonValue, technologies: body.technologies, sortOrder: body.sortOrder ?? 999 } });
  });

  app.put('/api/services/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const body = parseBody(serviceSchema.partial(), req.body);
    if (!(await db().service.findUnique({ where: { id } }))) notFound('Service');
    const { slug: _ignored, ...rest } = body;
    return db().service.update({ where: { id }, data: { ...rest, excludedCases: rest.excludedCases as unknown as Prisma.InputJsonValue | undefined } });
  });

  app.delete('/api/services/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    await db().service.update({ where: { id }, data: { active: false } });
    return { ok: true, note: 'Service deactivated (kept for history).' };
  });

  app.post('/api/services/restore-defaults', async () => {
    let added = 0;
    for (const s of DEFAULT_SERVICES) {
      const exists = await db().service.findUnique({ where: { slug: s.slug } });
      if (exists) continue;
      await db().service.create({ data: { ...s, problemTypes: s.problemTypes as unknown as Prisma.InputJsonValue, excludedCases: s.excludedCases as unknown as Prisma.InputJsonValue, technologies: s.technologies } });
      added++;
    }
    return { added };
  });

  /** Re-score every lead after changing services/profile/weights. */
  app.post('/api/business/requalify', async () => {
    const job = await enqueueJob('qualify_all', {}, { priority: 1 });
    return { jobId: job.id };
  });

  app.get('/api/portfolio', async () => db().portfolioProject.findMany({ orderBy: { createdAt: 'desc' } }));
  app.post('/api/portfolio', async (req) => {
    const body = parseBody(portfolioSchema, req.body);
    return db().portfolioProject.create({ data: { ...body, url: body.url ? normalizeUrl(body.url) : null } });
  });
  app.put('/api/portfolio/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const body = parseBody(portfolioSchema.partial(), req.body);
    return db().portfolioProject.update({ where: { id }, data: { ...body, url: body.url === undefined ? undefined : body.url ? normalizeUrl(body.url) : null } });
  });
  app.delete('/api/portfolio/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    await db().portfolioProject.delete({ where: { id } });
    return { ok: true };
  });
}
