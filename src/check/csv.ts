import { parse } from 'csv-parse/sync';
import { keyify } from '../normalise/text.js';
import type { CheckInput, CheckResult } from './checker.js';

/** The caller's file is unusable. The API maps this to HTTP 400 and the CLI prints it as-is. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

type Field = 'regNo' | 'productName' | 'ingredient' | 'strength' | 'manufacturer' | 'dosageForm';

/** Header names accepted for each field, compared with case and punctuation ignored. */
const HEADER_ALIASES: Record<Field, string[]> = {
  regNo: ['regno', 'nrn', 'nafdacregno', 'nafdacno', 'nafdacnumber', 'nafdacregistrationnumber',
    'registrationnumber', 'registrationno', 'regnumber', 'reg', 'nafdac'],
  productName: ['productname', 'product', 'name', 'brand', 'brandname', 'description', 'item',
    'itemname', 'itemdescription', 'drug', 'drugname'],
  ingredient: ['ingredient', 'ingredients', 'activeingredient', 'activeingredients', 'generic',
    'genericname', 'api'],
  strength: ['strength', 'strengths', 'dose'],
  manufacturer: ['manufacturer', 'manufacturername', 'applicant', 'supplier', 'mfr', 'company'],
  dosageForm: ['dosageform', 'form', 'formulation'],
};

export type ColumnMap = Partial<Record<Field, string>>;

export interface StockFile {
  headers: string[];
  rows: Record<string, string>[];
  inputs: CheckInput[];
  /** Which file column was used for each field. */
  columns: ColumnMap;
}

function sniffDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const counts: [string, number][] = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

/**
 * Read a pharmacy or importer stock list. Columns are found by header name; pass `overrides`
 * (field -> header) when a file uses unusual headers.
 */
export function readStockCsv(text: string, overrides: ColumnMap = {}): StockFile {
  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
      delimiter: sniffDelimiter(text),
    }) as string[][];
  } catch (e) {
    throw new InputError(`Could not read the CSV: ${(e as Error).message}`);
  }

  if (records.length === 0) throw new InputError('The CSV is empty.');
  const headers = records[0]!.map((h, i) => (h === '' ? `column_${i + 1}` : h));
  const keyed = headers.map((h) => keyify(h));

  const columns: ColumnMap = {};
  for (const field of Object.keys(HEADER_ALIASES) as Field[]) {
    const wanted = overrides[field];
    if (wanted) {
      const idx = keyed.indexOf(keyify(wanted));
      if (idx === -1) throw new InputError(`Column "${wanted}" (for ${field}) not found. Headers are: ${headers.join(', ')}`);
      columns[field] = headers[idx]!;
      continue;
    }
    // Aliases are tried in priority order, so "reg no" beats a generic "nafdac" column.
    for (const alias of HEADER_ALIASES[field]) {
      const idx = keyed.indexOf(alias);
      if (idx !== -1) {
        columns[field] = headers[idx]!;
        break;
      }
    }
  }

  if (!columns.regNo && !columns.productName) {
    throw new InputError(
      `Could not find a registration-number or product-name column. Headers found: ${headers.join(', ')}. ` +
        `Use a header like "NAFDAC Reg No" or "Product Name", or pass --reg-col / --name-col.`,
    );
  }

  const rows: Record<string, string>[] = [];
  const inputs: CheckInput[] = [];
  records.slice(1).forEach((cells, i) => {
    const row: Record<string, string> = {};
    headers.forEach((h, c) => {
      row[h] = cells[c] ?? '';
    });
    rows.push(row);
    const get = (f: Field) => {
      const col = columns[f];
      const v = col ? row[col] : undefined;
      return v && v.trim() !== '' ? v.trim() : undefined;
    };
    inputs.push({
      row: i + 2, // spreadsheet numbering: the header is row 1
      regNo: get('regNo'),
      productName: get('productName'),
      ingredient: get('ingredient'),
      strength: get('strength'),
      manufacturer: get('manufacturer'),
      dosageForm: get('dosageForm'),
    });
  });

  return { headers, rows, inputs, columns };
}

/**
 * Neutralise spreadsheet formula injection: a cell starting with = + - @ is read by Excel as a
 * formula, and register data is outside our control.
 */
function safe(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function cell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export const REPORT_HEADERS = [
  'gbo_verdict', 'gbo_severity', 'gbo_reasons', 'gbo_match_product_id', 'gbo_match_reg_no',
  'gbo_match_product', 'gbo_match_status', 'gbo_match_expires_on', 'gbo_candidates', 'gbo_snapshot_id',
] as const;

/** The original columns, untouched, followed by the verdict columns. */
export function reportCsv(file: StockFile, results: CheckResult[], snapshotId: number): string {
  const lines = [[...file.headers, ...REPORT_HEADERS].map(cell).join(',')];
  results.forEach((r, i) => {
    const orig = file.headers.map((h) => cell(file.rows[i]?.[h] ?? ''));
    const m = r.match;
    const extra = [
      r.verdict,
      r.severity,
      r.reasons.join('; '),
      m?.source_id ?? '',
      m?.reg_no ?? '',
      safe(m?.product_name ?? ''),
      m?.status ?? '',
      m?.expires_on ?? '',
      safe(r.candidates.map((c) => `${c.reg_no ?? '?'} ${c.product_name ?? ''}`.trim()).join(' | ')),
      String(snapshotId),
    ].map(cell);
    lines.push([...orig, ...extra].join(','));
  });
  return `${lines.join('\n')}\n`;
}
