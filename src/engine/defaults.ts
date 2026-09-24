import type { Prisma } from '@prisma/client';
import { db } from '../db/client.js';
import { jsonArray } from '../lib/misc.js';
import { DEFAULT_SERVICES, type ExclusionRule, type ServiceDef, type WeightedProblem } from './fit/service-catalog.js';

/** Idempotent first-run defaults: business profile + service catalogue. */
export async function ensureDefaults(): Promise<void> {
  await db().businessProfile.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      preferredIndustries: [],
      excludedIndustries: [],
      preferredCountries: [],
      preferredCities: [],
      preferredTechnologies: [],
      disallowedProjectTypes: [],
      portfolioUrls: [],
    },
    update: {},
  });
  const count = await db().service.count();
  if (count === 0) {
    let order = 0;
    for (const s of DEFAULT_SERVICES) {
      await db().service.create({
        data: {
          slug: s.slug,
          name: s.name,
          description: s.description,
          priceMin: s.priceMin,
          priceMax: s.priceMax,
          currency: s.currency,
          targetProfile: s.targetProfile,
          problemTypes: s.problemTypes as unknown as Prisma.InputJsonValue,
          minimumFit: s.minimumFit,
          excludedCases: s.excludedCases as unknown as Prisma.InputJsonValue,
          technologies: s.technologies,
          projectSize: s.projectSize,
          sortOrder: order++,
        },
      });
    }
  }
}

export interface ServiceRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string;
  targetProfile: string | null;
  problemTypes: unknown;
  minimumFit: number;
  excludedCases: unknown;
  technologies: unknown;
  projectSize: string;
}

export function rowToServiceDef(r: ServiceRow): ServiceDef {
  return {
    slug: r.slug,
    name: r.name,
    description: r.description ?? '',
    priceMin: r.priceMin ?? 0,
    priceMax: r.priceMax ?? 0,
    currency: r.currency,
    targetProfile: r.targetProfile ?? '',
    problemTypes: jsonArray<WeightedProblem>(r.problemTypes),
    minimumFit: r.minimumFit,
    excludedCases: jsonArray<ExclusionRule>(r.excludedCases),
    technologies: jsonArray<string>(r.technologies),
    projectSize: (['small', 'medium', 'large'].includes(r.projectSize) ? r.projectSize : 'medium') as ServiceDef['projectSize'],
  };
}

export async function activeServices(): Promise<Array<ServiceDef & { id: string }>> {
  const rows = await db().service.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
  return rows.map((r) => ({ ...rowToServiceDef(r), id: r.id }));
}

export async function businessProfile() {
  const p = await db().businessProfile.findUnique({ where: { id: 'default' } });
  return {
    raw: p,
    preferredIndustries: jsonArray<string>(p?.preferredIndustries),
    excludedIndustries: jsonArray<string>(p?.excludedIndustries),
    preferredCountries: jsonArray<string>(p?.preferredCountries),
    preferredCities: jsonArray<string>(p?.preferredCities),
    preferredTechnologies: jsonArray<string>(p?.preferredTechnologies),
    disallowedProjectTypes: jsonArray<string>(p?.disallowedProjectTypes),
    communicationLanguage: p?.communicationLanguage ?? 'en',
    senderName: p?.senderName ?? null,
    senderRole: p?.senderRole ?? null,
    studioName: p?.studioName ?? null,
    website: p?.website ?? null,
    scoringWeights: (p?.scoringWeights as Record<string, number> | null) ?? null,
  };
}
