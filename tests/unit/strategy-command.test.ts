import { describe, expect, it } from 'vitest';
import { planSearch, queryBudget, resolveCity, resolveNiche } from '../../src/engine/strategy/strategy-engine.js';
import { parseCommand } from '../../src/engine/command/parse-command.js';
import { searchParamsSchema } from '../../src/domain/search-params.js';

describe('search strategy engine', () => {
  it('resolves niches in several languages', () => {
    expect(resolveNiche('стоматологии').def?.key).toBe(resolveNiche('dental clinics').def?.key);
    expect(resolveNiche('dentysta').def?.key).toBe(resolveNiche('dentists').def?.key);
    expect(resolveNiche('underwater basket weaving').def).toBeNull();
  });

  it('resolves city aliases', () => {
    expect(resolveCity('Варшава')?.country).toBe('PL');
    expect(resolveCity('Warszawa')?.names.en).toBe('Warsaw');
  });

  it('plans localized, de-duplicated queries within budget', () => {
    const params = searchParamsSchema.parse({ niche: 'стоматологии', location: 'Варшава', country: 'Польша', quantity: 100, service: 'premium website redesign' });
    const plan = planSearch(params);
    expect(plan.countryCode).toBe('PL');
    expect(plan.languages[0]).toBe('pl');
    expect(plan.queries.length).toBeLessThanOrEqual(queryBudget(100));
    expect(plan.queries[0]!.strategy).toBe('primary');
    expect(plan.queries[0]!.text).toContain('Warszawa');
    expect(plan.queries.some((q) => q.strategy === 'segment')).toBe(true);
    const texts = plan.queries.map((q) => q.text.toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);
    expect(plan.notes.join(' ')).toMatch(/Search languages/);
  });

  it('falls back to the raw term for unknown niches and says so', () => {
    const params = searchParamsSchema.parse({ niche: 'escape rooms for dogs', location: 'Gdynia', country: 'Poland', quantity: 10 });
    const plan = planSearch(params);
    expect(plan.niche).toBeNull();
    expect(plan.queries[0]!.strategy).toBe('raw');
    expect(plan.notes[0]).toMatch(/not in the taxonomy/);
  });

  it('boosts templates that historically produced good leads', () => {
    const params = searchParamsSchema.parse({ niche: 'dentist', location: 'Warsaw', country: 'Poland', quantity: 20 });
    const base = planSearch(params);
    const target = base.queries.find((q) => q.strategy !== 'primary')!;
    const boosted = planSearch(params, { templateYield: new Map([[target.template, 1]]) });
    const before = base.queries.find((q) => q.template === target.template)!.priority;
    const after = boosted.queries.find((q) => q.template === target.template)!.priority;
    expect(after).toBeGreaterThan(before);
  });
});

describe('command parser', () => {
  it('parses an English command', () => {
    const r = parseCommand('Find 100 dental clinics in Warsaw for premium website redesign');
    expect(r).toMatchObject({ quantity: 100, niche: 'dental clinics', location: 'Warsaw', country: 'Poland', service: 'premium website redesign', confidence: 'high' });
    expect(r.missing).toEqual([]);
  });

  it('parses Russian with an inflected city', () => {
    const r = parseCommand('Найди 50 стоматологий в Варшаве для редизайна сайта');
    expect(r.quantity).toBe(50);
    expect(r.location).toBe('Warsaw');
    expect(r.country).toBe('Poland');
    expect(r.niche).toMatch(/стоматолог/);
    expect(r.service).toBe('редизайна сайта');
  });

  it('parses Polish', () => {
    const r = parseCommand('Znajdź 30 salonów kosmetycznych w Krakowie');
    expect(r.location).toBe('Krakow');
    expect(r.quantity).toBe(30);
    expect(r.missing).toContain('service');
  });

  it('reports what it could not extract', () => {
    const r = parseCommand('dentists');
    expect(r.missing).toEqual(expect.arrayContaining(['location', 'country', 'quantity', 'service']));
    expect(r.confidence).toBe('low');
  });
});
