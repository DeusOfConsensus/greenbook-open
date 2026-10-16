import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import { extractSourceId } from '../normalise/index.js';
import { cleanText } from '../normalise/text.js';
import type { RawRecord } from '../types.js';
import type { PoliteClient } from './client.js';

export interface RecordSource {
  /** Stored on the snapshot, e.g. "greenbook-live" or "file:snapshot.json". */
  label: string;
  /** Total the source claims to have; set once known. Ingest refuses a short fetch. */
  expectedTotal: number | null;
  records(): AsyncIterable<RawRecord>;
}

function toRaw(row: unknown, index: number, idField?: string): RawRecord {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(
      `Row ${index} is not an object. Rows must be key/value records; array-style rows need column names mapped first.`,
    );
  }
  const fields = row as Record<string, unknown>;
  const sourceId = idField ? cleanText(fields[idField]) : extractSourceId(fields);
  if (sourceId === null) {
    throw new Error(
      `Row ${index} has no product id${idField ? ` in "${idField}"` : ''}. ` +
        `Registration numbers are NOT unique in the Greenbook, so they cannot stand in for an id. ` +
        `Pass --id-field <column>, or add the column name to ALIASES.productId in src/normalise/index.ts.`,
    );
  }
  return { sourceId, fields };
}

/** Load a snapshot from a local .json, .ndjson/.jsonl or .csv file. */
export class FileSource implements RecordSource {
  readonly label: string;
  expectedTotal: number | null = null;

  constructor(
    private readonly path: string,
    private readonly idField?: string,
  ) {
    this.label = `file:${basename(path)}`;
  }

  private rows(): unknown[] {
    const text = readFileSync(this.path, 'utf8');
    const ext = extname(this.path).toLowerCase();
    if (ext === '.csv') {
      return parseCsv(text, { columns: true, bom: true, skip_empty_lines: true, trim: true }) as unknown[];
    }
    if (ext === '.ndjson' || ext === '.jsonl') {
      return text
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '')
        .map((l, i) => {
          try {
            return JSON.parse(l) as unknown;
          } catch {
            throw new Error(`Line ${i + 1} of ${this.path} is not valid JSON`);
          }
        });
    }
    const parsed = JSON.parse(text.replace(/^﻿/, '')) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      for (const key of ['data', 'records', 'results', 'items', 'products']) {
        const v = (parsed as Record<string, unknown>)[key];
        if (Array.isArray(v)) return v;
      }
    }
    throw new Error(`${this.path}: expected a JSON array, or an object with a data/records/results/items/products array`);
  }

  async *records(): AsyncIterable<RawRecord> {
    const rows = this.rows();
    this.expectedTotal = rows.length;
    for (let i = 0; i < rows.length; i++) yield toRaw(rows[i], i, this.idField);
  }
}

export interface DataTablesOptions {
  client: PoliteClient;
  baseUrl: string;
  pageSize: number;
  /** Stop after this many pages (for probing). The snapshot is then partial. */
  maxPages?: number;
  log?: (msg: string) => void;
}

/**
 * The live Greenbook, read the way its own page does: a server-side jQuery DataTables
 * GET against the site root with `X-Requested-With: XMLHttpRequest`, paged by start/length.
 *
 * UNVERIFIED: this is built from the public description of how the page loads its table.
 * The environment this was written in could not reach the site. Run `greenbook-open probe`
 * first; it fetches two rows and shows exactly what came back and how it normalises.
 */
export class DataTablesSource implements RecordSource {
  readonly label = 'greenbook-live';
  expectedTotal: number | null = null;
  pagesFetched = 0;

  constructor(private readonly o: DataTablesOptions) {}

  async *records(): AsyncIterable<RawRecord> {
    let start = 0;
    let draw = 1;
    let index = 0;
    const maxPages = this.o.maxPages ?? Infinity;

    while (this.pagesFetched < maxPages) {
      const url = `${this.o.baseUrl}/?draw=${draw}&start=${start}&length=${this.o.pageSize}`;
      const body = await this.o.client.getJson<Record<string, unknown>>(url, {
        'X-Requested-With': 'XMLHttpRequest',
      });
      this.pagesFetched++;

      // A 200 response can still carry an application error; never read that as "no rows".
      if (body && typeof body === 'object' && 'error' in body && body.error) {
        throw new Error(`Greenbook returned an error for ${url}: ${String(body.error)}`);
      }
      const data = body?.data;
      if (!Array.isArray(data)) {
        throw new Error(
          `Unexpected response shape from ${url}: no "data" array (keys: ${Object.keys(body ?? {}).join(', ') || 'none'}). ` +
            `Run \`greenbook-open probe\` to inspect it.`,
        );
      }
      const total = Number(body.recordsTotal ?? body.recordsFiltered);
      if (Number.isFinite(total)) this.expectedTotal = total;

      this.o.log?.(`page ${this.pagesFetched}: ${data.length} rows (${start + data.length}/${this.expectedTotal ?? '?'})`);
      for (const row of data) yield toRaw(row, index++);

      if (data.length === 0) break;
      start += data.length;
      draw++;
      if (this.expectedTotal !== null && start >= this.expectedTotal) break;
    }
  }
}
