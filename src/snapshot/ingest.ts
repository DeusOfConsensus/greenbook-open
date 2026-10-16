import { HASH_VERSION, recordHash, snapshotContentHash } from '../hash.js';
import { type Db, pgArray } from '../db.js';
import { NORMALISER_VERSION, normaliseRecord } from '../normalise/index.js';
import { sanitiseFields } from '../normalise/sanitise.js';
import type { NormalisedRecord, RawRecord } from '../types.js';

/** Raised when a fetch looks wrong enough that storing it would corrupt history. */
export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestError';
  }
}

export interface IngestOptions {
  /** Label stored on the snapshot, e.g. "greenbook-live". */
  source: string;
  takenAt?: Date;
  /** Total the source claims to hold. A shorter fetch is refused unless allowPartial. */
  expectedTotal?: number | null;
  allowPartial?: boolean;
  /** Skip the shrink guard (new snapshot must hold at least minRatio of the previous count). */
  force?: boolean;
  minRatio?: number;
  notes?: Record<string, unknown>;
}

export interface IngestResult {
  status: 'created' | 'unchanged';
  snapshotId: number;
  recordCount: number;
  newRecords: number;
  contentHash: string;
  duplicateIds: number;
  strippedContactFields: number;
}

const RECORD_COLUMNS = [
  'record_hash', 'source_id', 'raw', 'normaliser_version', 'reg_no', 'reg_no_key', 'product_name',
  'product_name_norm', 'ingredients', 'ingredients_text', 'dosage_form', 'dosage_form_norm',
  'strength_text', 'strengths', 'manufacturer', 'manufacturer_norm', 'applicant', 'applicant_norm',
  'category', 'atc_codes', 'approved_on', 'expires_on', 'status', 'status_norm', 'issues',
] as const;

const RECORD_CASTS: Record<string, string> = {
  raw: '::jsonb', strengths: '::jsonb', ingredients: '::text[]', atc_codes: '::text[]',
  issues: '::text[]', approved_on: '::date', expires_on: '::date',
};

/** Column values for the `records` table, in RECORD_COLUMNS order. */
export function recordParams(hash: string, cleaned: Record<string, unknown>, n: NormalisedRecord): unknown[] {
  return [
    hash, n.sourceId, JSON.stringify(cleaned), NORMALISER_VERSION, n.regNo, n.regNoKey, n.productName,
    n.productNameNorm, pgArray(n.ingredients), n.ingredientsText, n.dosageForm, n.dosageFormNorm,
    n.strengthText, JSON.stringify(n.strengths), n.manufacturer, n.manufacturerNorm, n.applicant,
    n.applicantNorm, n.category, pgArray(n.atcCodes), n.approvedOn, n.expiresOn, n.status,
    n.statusNorm, pgArray(n.issues),
  ];
}

function placeholders(rows: number, cols: number, casts: (string | undefined)[]): string {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) cells.push(`$${r * cols + c + 1}${casts[c] ?? ''}`);
    out.push(`(${cells.join(',')})`);
  }
  return out.join(',');
}

async function toArray<T>(it: AsyncIterable<T> | Iterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

export async function ingestSnapshot(
  db: Db,
  input: AsyncIterable<RawRecord> | Iterable<RawRecord>,
  opts: IngestOptions,
): Promise<IngestResult> {
  const takenAt = opts.takenAt ?? new Date();
  const raws = await toArray(input);

  // 1. Clean, hash and normalise everything in memory first. Nothing touches the database
  //    until we know the fetch is complete and sane.
  const byId = new Map<string, { hash: string; cleaned: Record<string, unknown>; norm: NormalisedRecord }>();
  let duplicateIds = 0;
  let strippedContactFields = 0;
  for (const raw of raws) {
    if (byId.has(raw.sourceId)) {
      duplicateIds++; // keep the first occurrence; the count lands in the snapshot notes
      continue;
    }
    const { cleaned, strippedContact } = sanitiseFields(raw.fields);
    strippedContactFields += strippedContact;
    byId.set(raw.sourceId, {
      hash: recordHash(raw.sourceId, cleaned),
      cleaned,
      norm: normaliseRecord({ sourceId: raw.sourceId, fields: cleaned }),
    });
  }

  if (byId.size === 0) throw new IngestError('Source returned no records; refusing to create an empty snapshot.');
  if (opts.expectedTotal != null && byId.size < opts.expectedTotal && !opts.allowPartial) {
    throw new IngestError(
      `Fetched ${byId.size} unique records but the source reports ${opts.expectedTotal}. ` +
        `Refusing to store an incomplete snapshot (use --allow-partial to override).`,
    );
  }

  const contentHash = snapshotContentHash([...byId].map(([id, v]) => [id, v.hash] as const));

  const latest = (
    await db.query<{ id: number; record_count: number; content_hash: string; taken_at: string }>(
      `SELECT id, record_count, content_hash, taken_at::text AS taken_at
         FROM snapshots ORDER BY taken_at DESC, id DESC LIMIT 1`,
    )
  ).rows[0];

  if (latest) {
    if (new Date(latest.taken_at).getTime() > takenAt.getTime()) {
      throw new IngestError('Snapshots must be ingested in chronological order; this one is older than the latest.');
    }
    const minRatio = opts.minRatio ?? 0.8;
    if (!opts.force && byId.size < latest.record_count * minRatio) {
      throw new IngestError(
        `New snapshot has ${byId.size} records, under ${Math.round(minRatio * 100)}% of the previous ${latest.record_count}. ` +
          `Likely a failed or partial fetch. Use --force if the register really shrank.`,
      );
    }
    if (latest.content_hash === contentHash) {
      await db.query(
        `UPDATE snapshots SET last_confirmed_at = $2::timestamptz, confirm_count = confirm_count + 1 WHERE id = $1`,
        [latest.id, takenAt.toISOString()],
      );
      return {
        status: 'unchanged', snapshotId: latest.id, recordCount: byId.size, newRecords: 0,
        contentHash, duplicateIds, strippedContactFields,
      };
    }
  }

  // 2. Write everything in one transaction.
  const entries = [...byId];
  const notes = {
    ...opts.notes,
    duplicate_source_ids: duplicateIds,
    stripped_contact_fields: strippedContactFields,
    expected_total: opts.expectedTotal ?? null,
    normaliser_version: NORMALISER_VERSION,
  };

  const { snapshotId, newRecords } = await db.tx(async (t) => {
    const snap = await t.query<{ id: number }>(
      `INSERT INTO snapshots (taken_at, last_confirmed_at, source, record_count, content_hash, hash_version, notes)
       VALUES ($1::timestamptz, $1::timestamptz, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
      [takenAt.toISOString(), opts.source, byId.size, contentHash, HASH_VERSION, JSON.stringify(notes)],
    );
    const id = snap.rows[0]!.id;

    const casts = RECORD_COLUMNS.map((c) => RECORD_CASTS[c]);
    let inserted = 0;
    for (let i = 0; i < entries.length; i += 200) {
      const chunk = entries.slice(i, i + 200);
      const params = chunk.flatMap(([, v]) => recordParams(v.hash, v.cleaned, v.norm));
      const res = await t.query(
        `INSERT INTO records (${RECORD_COLUMNS.join(',')}) VALUES ${placeholders(chunk.length, RECORD_COLUMNS.length, casts)}
         ON CONFLICT (record_hash) DO NOTHING`,
        params,
      );
      inserted += res.rowCount;
    }

    for (let i = 0; i < entries.length; i += 1000) {
      const chunk = entries.slice(i, i + 1000);
      const params = chunk.flatMap(([sid, v]) => [id, sid, v.hash]);
      await t.query(
        `INSERT INTO snapshot_records (snapshot_id, source_id, record_hash) VALUES ${placeholders(chunk.length, 3, [])}`,
        params,
      );
    }
    return { snapshotId: id, newRecords: inserted };
  });

  return {
    status: 'created', snapshotId, recordCount: byId.size, newRecords, contentHash,
    duplicateIds, strippedContactFields,
  };
}

/**
 * Rebuild normalised columns from stored raw records whose normaliser_version is stale.
 * This is why raw is kept: improving a parser never requires re-fetching the register.
 */
export async function renormalise(db: Db): Promise<number> {
  const stale = await db.query<{ record_hash: string; source_id: string; raw: Record<string, unknown> }>(
    `SELECT record_hash, source_id, raw FROM records WHERE normaliser_version < $1`,
    [NORMALISER_VERSION],
  );
  await db.tx(async (t) => {
    for (const row of stale.rows) {
      const n = normaliseRecord({ sourceId: row.source_id, fields: row.raw });
      const p = recordParams(row.record_hash, row.raw, n);
      // p[0..2] are hash, source_id, raw: identity columns stay as they are.
      const sets = RECORD_COLUMNS.slice(3).map((c, i) => `${c} = $${i + 2}${RECORD_CASTS[c] ?? ''}`);
      await t.query(`UPDATE records SET ${sets.join(', ')} WHERE record_hash = $1`, [row.record_hash, ...p.slice(3)]);
    }
  });
  return stale.rows.length;
}
