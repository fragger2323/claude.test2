import { describe, expect, it } from 'vitest';
import { auc, brier, crossValidate, fitLogistic, mulberry32, predictOne, predictWithInterval, bootstrapModels, type Dataset, type TrainedModel } from '../../src/engine/learning/logistic.js';
import { contactAvailability, resolveContacts, type ContactObservation } from '../../src/engine/contacts/contact-discovery.js';
import { salesPotential } from '../../src/engine/fit/sales-potential.js';
import type { LeadFitResult } from '../../src/domain/types.js';

function synthetic(n: number, seed = 1): Dataset {
  const rand = mulberry32(seed);
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const need = rand() * 100;
    const noise = rand() * 100;
    X.push([need, noise]);
    y.push(rand() < 0.1 + 0.8 * (need / 100) ? 1 : 0);
  }
  return { featureNames: ['websiteNeed', 'noise'], X, y };
}

describe('logistic regression', () => {
  it('learns a real signal and beats the base-rate baseline in cross-validation', () => {
    const ds = synthetic(300);
    const m = fitLogistic(ds);
    expect(m.weights[0]!).toBeGreaterThan(Math.abs(m.weights[1]!));
    expect(predictOne(m, [90, 50])).toBeGreaterThan(predictOne(m, [10, 50]));
    const cv = crossValidate(ds, 5);
    expect(cv.brier).toBeLessThan(cv.baselineBrier);
    expect(cv.auc!).toBeGreaterThan(0.7);
    expect(cv.calibration.reduce((s, b) => s + b.n, 0)).toBe(300);
  });

  it('metrics', () => {
    expect(brier([1, 0], [1, 0])).toBe(0);
    expect(auc([0.9, 0.1], [1, 0])).toBe(1);
    expect(auc([0.5, 0.5], [1, 1])).toBeNull();
  });

  it('Mode B returns a probability with an interval, sample size and version', () => {
    const ds = synthetic(120, 3);
    const model: TrainedModel = { target: 'reply', version: 2, trainedAt: '2026-09-01T00:00:00Z', sampleSize: 120, positives: ds.y.filter(Boolean).length, model: fitLogistic(ds), bootstrap: bootstrapModels(ds, 20) };
    const p = predictWithInterval(model, { websiteNeed: 80, noise: 10 });
    expect(p.interval[0]).toBeLessThanOrEqual(p.probability);
    expect(p.interval[1]).toBeGreaterThanOrEqual(p.probability);
    const fit: LeadFitResult = { leadFit: 70, components: [], priority: 'high', priorityReasons: [], dataCompleteness: 1 };
    const sp = salesPotential(fit, model, { websiteNeed: 80, noise: 10 });
    expect(sp.mode).toBe('B');
    if (sp.mode === 'B') {
      expect(sp.sampleSize).toBe(120);
      expect(sp.modelVersion).toBe(2);
      expect(sp.note).toMatch(/not a promise/);
    }
  });
});

describe('contact resolution', () => {
  const at = new Date('2026-09-20');
  const o = (p: Partial<ContactObservation> & Pick<ContactObservation, 'type' | 'value' | 'source'>): ContactObservation => ({ normalizedValue: p.value.toLowerCase(), onOfficialSite: false, observedAt: at, ...p });

  it('assigns verified / probable / unverified from evidence only', () => {
    const r = resolveContacts(
      [
        o({ type: 'email', value: 'info@smile.pl', source: 'website', onOfficialSite: true, sourceUrl: 'https://smile.pl/kontakt' }),
        o({ type: 'phone', value: '+48221234567', source: 'google_places' }),
        o({ type: 'phone', value: '+48221234567', source: 'osm' }),
        o({ type: 'phone', value: '+48600000000', source: 'yelp' }),
        o({ type: 'email', value: 'biuro@nomx.pl', source: 'osm' }),
        o({ type: 'email', value: 'x@found-in-search.pl', source: 'web_search' }),
      ],
      { officialDomain: 'smile.pl', mx: new Map([['nomx.pl', false]]) },
    );
    const by = (v: string) => r.find((c) => c.normalizedValue === v)!;
    expect(by('info@smile.pl')).toMatchObject({ status: 'verified', confidence: 'high', isRoleBased: true });
    expect(by('+48221234567')).toMatchObject({ status: 'verified' });
    expect(by('+48221234567').sightings).toHaveLength(2);
    expect(by('+48600000000').status).toBe('probable');
    expect(by('biuro@nomx.pl').status).toBe('unverified');
    expect(by('x@found-in-search.pl').status).toBe('unverified');
  });

  it('best channel ignores unverified contacts', () => {
    expect(contactAvailability([{ type: 'email', status: 'unverified' }, { type: 'phone', status: 'probable' }])).toBe('phone');
    expect(contactAvailability([{ type: 'contact_form', status: 'verified' }])).toBe('form');
    expect(contactAvailability([])).toBe('none');
  });
});
