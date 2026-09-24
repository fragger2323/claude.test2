import type { Prisma } from '@prisma/client';
import { loadConfig } from '../../config/env.js';
import { db } from '../../db/client.js';
import { jsonArray } from '../../lib/misc.js';
import { domainHasMx } from './email.js';
import { resolveContacts, type ContactObservation } from './contact-discovery.js';

/**
 * Merges new contact observations with what is stored and writes Contact rows with
 * status/provenance. Previously stored sightings are kept (history), duplicates collapse.
 */
export async function storeContacts(companyId: string, observations: ContactObservation[], officialDomain: string | null): Promise<number> {
  if (observations.length === 0) return 0;
  const existing = await db().contact.findMany({ where: { companyId } });
  // Re-hydrate previous sightings so status reflects all evidence, not only this run.
  const previous: ContactObservation[] = existing.flatMap((c) =>
    jsonArray<{ source: string; sourceUrl?: string; observedAt: string; onOfficialSite: boolean }>(c.sightings).map((s) => ({
      type: c.type as ContactObservation['type'],
      subtype: c.subtype ?? undefined,
      value: c.value,
      normalizedValue: c.normalizedValue,
      source: s.source,
      sourceUrl: s.sourceUrl,
      label: c.label ?? undefined,
      onOfficialSite: s.onOfficialSite,
      observedAt: new Date(s.observedAt),
    })),
  );
  const all = [...previous, ...observations];
  const mx = new Map<string, boolean | null>();
  const checkMx = loadConfig().EMAIL_MX_CHECK;
  for (const o of all) {
    if (!checkMx || o.type !== 'email') continue;
    const d = o.normalizedValue.split('@')[1];
    if (d && !mx.has(d)) mx.set(d, await domainHasMx(d));
  }
  const resolved = resolveContacts(all, { officialDomain, mx });
  let written = 0;
  for (const c of resolved) {
    // de-duplicate sightings by source+url
    const seen = new Set<string>();
    const sightings = c.sightings
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
      .filter((s) => {
        const k = `${s.source}|${s.sourceUrl ?? ''}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 20);
    const lastVerifiedAt = new Date(sightings[0]?.observedAt ?? Date.now());
    const data = {
      value: c.value,
      subtype: c.subtype,
      label: c.label,
      source: c.source,
      sourceUrl: c.sourceUrl,
      status: c.status,
      confidence: c.confidence,
      isRoleBased: c.isRoleBased,
      isPersonal: c.isPersonal,
      sightings: sightings as unknown as Prisma.InputJsonValue,
      lastVerifiedAt,
      expiredAt: null,
    };
    await db().contact.upsert({
      where: { companyId_type_normalizedValue: { companyId, type: c.type, normalizedValue: c.normalizedValue } },
      create: { companyId, type: c.type, normalizedValue: c.normalizedValue, ...data },
      update: data,
    });
    written++;
  }
  return written;
}
