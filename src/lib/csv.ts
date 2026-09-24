import Papa from 'papaparse';

export interface CsvParseResult {
  rows: Array<Record<string, string>>;
  headers: string[];
  errors: string[];
}

export const MAX_IMPORT_ROWS = 20_000;

/** Parse CSV text with a header row. Header names are trimmed and lower-cased. */
export function parseCsv(text: string): CsvParseResult {
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const errors = res.errors.slice(0, 20).map((e) => `row ${e.row ?? '?'}: ${e.message}`);
  const rows = res.data.slice(0, MAX_IMPORT_ROWS);
  if (res.data.length > MAX_IMPORT_ROWS) errors.push(`only the first ${MAX_IMPORT_ROWS} rows were imported`);
  return { rows, headers: res.meta.fields ?? [], errors };
}

/**
 * Escape a value for CSV export and neutralise spreadsheet formula injection
 * (cells starting with = + - @ tab CR are prefixed with an apostrophe).
 */
export function csvCell(value: unknown): string {
  if (value == null) return '';
  let s = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r;]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const lines = [columns.map(csvCell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
