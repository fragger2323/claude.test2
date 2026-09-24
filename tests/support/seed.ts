import { db } from '../../src/db/client.js';

let n = 0;
/** Minimal company + lead for API tests (no pipeline). */
export async function seedLead(over: { name?: string; stage?: string; priority?: string; country?: string; industry?: string } = {}) {
  n += 1;
  const company = await db().company.create({
    data: {
      name: over.name ?? `Seed Clinic ${n}`,
      normalizedName: (over.name ?? `seed clinic ${n}`).toLowerCase(),
      industry: over.industry ?? 'dentist',
      categories: ['dentist'],
      city: 'Warszawa',
      country: over.country ?? 'PL',
      businessStatus: 'operational',
      sources: ['osm'],
      discrepancies: [],
      lastVerifiedAt: new Date(),
    },
  });
  const lead = await db().lead.create({
    data: { companyId: company.id, stage: over.stage ?? 'qualified', priority: over.priority ?? 'high', priorityRank: 4, leadFit: 70, priorityReasons: ['seed'] },
  });
  return { company, lead };
}
