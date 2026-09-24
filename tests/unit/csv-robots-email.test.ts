import { describe, expect, it } from 'vitest';
import { csvCell, parseCsv, toCsv } from '../../src/lib/csv.js';
import { parseRobots } from '../../src/lib/robots.js';
import { emailFromMailto, extractEmails, isRoleBasedEmail, isValidEmailSyntax, looksPersonalEmail } from '../../src/engine/contacts/email.js';

describe('csv', () => {
  it('parses with BOM, trims/lowercases headers and skips empty lines', () => {
    const r = parseCsv('﻿Name , Website\nSmile,smile.pl\n\n  \nBella,bella.pl\n');
    expect(r.headers).toEqual(['name', 'website']);
    expect(r.rows).toEqual([
      { name: 'Smile', website: 'smile.pl' },
      { name: 'Bella', website: 'bella.pl' },
    ]);
  });

  it('neutralises spreadsheet formula injection on export', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+48 22 123')).toBe(`'+48 22 123`);
    expect(csvCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(csvCell('-1')).toBe(`'-1`);
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('toCsv emits header and CRLF rows', () => {
    expect(toCsv([{ a: 1, b: 'x' }], ['a', 'b'])).toBe('a,b\r\n1,x\r\n');
  });
});

describe('robots.txt', () => {
  const txt = `User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\nSitemap: https://x.pl/sitemap.xml\n\nUser-agent: BadBot\nDisallow: /`;

  it('applies longest-match semantics', () => {
    const p = parseRobots(txt, 'AgencyIntelligenceOS/1.0');
    expect(p.found).toBe(true);
    expect(p.isAllowed('/')).toBe(true);
    expect(p.isAllowed('/private/x')).toBe(false);
    expect(p.isAllowed('/private/public/page')).toBe(true);
    expect(p.isAllowed('/files/a.pdf')).toBe(false);
    expect(p.isAllowed('/files/a.pdf?x=1')).toBe(true);
    expect(p.sitemaps).toEqual(['https://x.pl/sitemap.xml']);
  });

  it('uses a specific group when the agent matches', () => {
    expect(parseRobots(txt, 'BadBot').isAllowed('/')).toBe(false);
  });

  it('missing robots.txt allows everything', () => {
    const p = parseRobots(null, 'x');
    expect(p.found).toBe(false);
    expect(p.isAllowed('/anything')).toBe(true);
  });
});

describe('email', () => {
  it('validates syntax and rejects junk/asset-like addresses', () => {
    expect(isValidEmailSyntax('info@smile-dental.pl')).toBe(true);
    expect(isValidEmailSyntax('user@example.com')).toBe(false);
    expect(isValidEmailSyntax('logo@2x.png')).toBe(false);
    expect(isValidEmailSyntax('no-at-sign')).toBe(false);
  });

  it('extracts plain emails only, deduplicated and lowercased', () => {
    const text = 'Kontakt: Info@Smile-Dental.pl, info@smile-dental.pl; recepcja [at] smile.pl; icon@2x.png';
    expect(extractEmails(text)).toEqual(['info@smile-dental.pl']);
  });

  it('does not de-obfuscate or guess addresses', () => {
    expect(extractEmails('jan (dot) kowalski (at) smile (dot) pl')).toEqual([]);
  });

  it('parses mailto links', () => {
    expect(emailFromMailto('mailto:Biuro@Smile.pl?subject=Hi')).toBe('biuro@smile.pl');
    expect(emailFromMailto('https://smile.pl')).toBeNull();
  });

  it('distinguishes role-based and personal addresses', () => {
    expect(isRoleBasedEmail('recepcja@smile.pl')).toBe(true);
    expect(isRoleBasedEmail('jan.kowalski@smile.pl')).toBe(false);
    expect(looksPersonalEmail('jan.kowalski@smile.pl')).toBe(true);
    expect(looksPersonalEmail('info@smile.pl')).toBe(false);
  });
});
