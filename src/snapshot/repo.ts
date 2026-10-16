import { type Db, likeEscape } from '../db.js';
import { normaliseOrg, normaliseRegNo } from '../normalise/codes.js';
import type { ProductRow, SnapshotMeta } from '../types.js';

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Dates come back as text and counts as ints so pg and PGlite return identical shapes. */
export const PRODUCT_COLS = `r.source_id, r.reg_no, r.product_name, r.ingredients, r.ingredients_text,
  r.dosage_form, r.strength_text, r.strengths, r.manufacturer, r.applicant, r.category, r.atc_codes,
  r.approved_on::text AS approved_on, r.expires_on::text AS expires_on, r.status, r.status_norm, r.issues`;

const SNAPSHOT_COLS = `id,
  to_char(taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS taken_at,
  to_char(last_confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_confirmed_at,
  confirm_count, source, record_count, content_hash, hash_version, notes`;

export async function listSnapshots(db: Db): Promise<SnapshotMeta[]> {
  const res = await db.query<SnapshotMeta>(`SELECT ${SNAPSHOT_COLS} FROM snapshots ORDER BY id`);
  return res.rows;
}

/**
 * Resolve a snapshot reference: "latest" (or nothing), a numeric id, or a YYYY-MM-DD date,
 * which means "the register as of the end of that day".
 */
export async function resolveSnapshot(db: Db, ref?: string | number | null): Promise<SnapshotMeta> {
  const r = ref === undefined || ref === null ? 'latest' : String(ref).trim();
  let res;
  if (r === 'latest' || r === '') {
    res = await db.query<SnapshotMeta>(`SELECT ${SNAPSHOT_COLS} FROM snapshots ORDER BY taken_at DESC, id DESC LIMIT 1`);
  } else if (/^\d+$/.test(r)) {
    res = await db.query<SnapshotMeta>(`SELECT ${SNAPSHOT_COLS} FROM snapshots WHERE id = $1`, [Number(r)]);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(r)) {
    res = await db.query<SnapshotMeta>(
      `SELECT ${SNAPSHOT_COLS} FROM snapshots
        WHERE taken_at < (($1::date + 1)::timestamp AT TIME ZONE 'UTC')
        ORDER BY taken_at DESC, id DESC LIMIT 1`,
      [r],
    );
  } else {
    throw new NotFoundError(`Bad snapshot reference "${r}". Use "latest", a snapshot id, or YYYY-MM-DD.`);
  }
  const snap = res.rows[0];
  if (!snap) throw new NotFoundError(r === 'latest' ? 'No snapshots yet. Run `greenbook-open ingest <file>` or `fetch` first.' : `No snapshot matches "${r}".`);
  return snap;
}

export interface SearchFilters {
  q?: string;
  ingredient?: string;
  manufacturer?: string;
  atc?: string;
  status?: string;
  regNo?: string;
  dosageForm?: string;
  category?: string;
}

export interface Paging {
  limit: number;
  offset: number;
}

/** Search one snapshot. All filters combine with AND. */
export async function searchProducts(
  db: Db,
  snapshotId: number,
  f: SearchFilters,
  paging: Paging,
): Promise<{ rows: ProductRow[]; total: number }> {
  const where: string[] = ['sr.snapshot_id = $1'];
  const params: unknown[] = [snapshotId];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const like = (s: string) => add(`%${likeEscape(s.trim())}%`);

  if (f.q?.trim()) {
    const p = like(f.q);
    const key = normaliseRegNo(f.q).regNoKey;
    const keyClause = key ? ` OR r.reg_no_key = ${add(key)}` : '';
    where.push(`(r.product_name ILIKE ${p} OR r.ingredients_text ILIKE ${p}${keyClause})`);
  }
  if (f.ingredient?.trim()) {
    // Comma-separated terms must ALL match, so "artemether,lumefantrine" finds the combination.
    for (const term of f.ingredient.split(',').map((t) => t.trim()).filter(Boolean)) {
      const p = like(term);
      where.push(
        `(r.ingredients_text ILIKE ${p} OR EXISTS (SELECT 1 FROM unnest(r.ingredients) AS i WHERE i ILIKE ${p}))`,
      );
    }
  }
  if (f.manufacturer?.trim()) {
    const norm = normaliseOrg(f.manufacturer) ?? f.manufacturer.toLowerCase();
    const p = like(norm);
    where.push(`(r.manufacturer_norm LIKE ${p} OR r.applicant_norm LIKE ${p})`);
  }
  if (f.atc?.trim()) {
    // Prefix match: "P01B" returns every antimalarial, "P01BF01" one exact class.
    const p = add(`${likeEscape(f.atc.trim().toUpperCase().replace(/\./g, ''))}%`);
    where.push(`EXISTS (SELECT 1 FROM unnest(r.atc_codes) AS c WHERE c LIKE ${p})`);
  }
  if (f.status?.trim()) where.push(`r.status_norm = ${add(f.status.trim().toLowerCase())}`);
  if (f.regNo?.trim()) {
    const key = normaliseRegNo(f.regNo).regNoKey;
    where.push(`r.reg_no_key = ${add(key ?? '')}`);
  }
  if (f.dosageForm?.trim()) where.push(`r.dosage_form_norm LIKE ${like(f.dosageForm.toLowerCase())}`);
  if (f.category?.trim()) where.push(`r.category ILIKE ${like(f.category)}`);

  const from = `FROM snapshot_records sr JOIN records r ON r.record_hash = sr.record_hash WHERE ${where.join(' AND ')}`;
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n ${from}`, params)).rows[0]?.n ?? 0;
  const lim = add(paging.limit);
  const off = add(paging.offset);
  const rows = await db.query<ProductRow>(
    `SELECT ${PRODUCT_COLS} ${from} ORDER BY r.product_name_norm NULLS LAST, r.source_id LIMIT ${lim} OFFSET ${off}`,
    params,
  );
  return { rows: rows.rows, total };
}

export async function loadSnapshotRows(db: Db, snapshotId: number): Promise<ProductRow[]> {
  const res = await db.query<ProductRow>(
    `SELECT ${PRODUCT_COLS} FROM snapshot_records sr JOIN records r ON r.record_hash = sr.record_hash
      WHERE sr.snapshot_id = $1 ORDER BY r.source_id`,
    [snapshotId],
  );
  return res.rows;
}

export async function getProduct(
  db: Db,
  snapshotId: number,
  sourceId: string,
): Promise<(ProductRow & { raw: Record<string, unknown> }) | null> {
  const res = await db.query<ProductRow & { raw: Record<string, unknown> }>(
    `SELECT ${PRODUCT_COLS}, r.raw FROM snapshot_records sr JOIN records r ON r.record_hash = sr.record_hash
      WHERE sr.snapshot_id = $1 AND sr.source_id = $2`,
    [snapshotId, sourceId],
  );
  return res.rows[0] ?? null;
}

/** Every product sharing a registration number. More than one row is itself a data-quality finding. */
export async function getByRegNo(db: Db, snapshotId: number, regNo: string): Promise<ProductRow[]> {
  const key = normaliseRegNo(regNo).regNoKey;
  if (!key) return [];
  const res = await db.query<ProductRow>(
    `SELECT ${PRODUCT_COLS} FROM snapshot_records sr JOIN records r ON r.record_hash = sr.record_hash
      WHERE sr.snapshot_id = $1 AND r.reg_no_key = $2 ORDER BY r.source_id`,
    [snapshotId, key],
  );
  return res.rows;
}

export interface HistoryEntry {
  first_snapshot: number;
  last_snapshot: number;
  first_seen: string;
  record: ProductRow;
}

/**
 * The life of one product across snapshots, collapsed to runs of identical content: each
 * entry says "from snapshot A to snapshot B this is what the register said".
 */
export async function productHistory(db: Db, sourceId: string): Promise<HistoryEntry[]> {
  const res = await db.query<ProductRow & { snapshot_id: number; record_hash: string; taken_at: string }>(
    `SELECT sr.snapshot_id, sr.record_hash,
            to_char(s.taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS taken_at, ${PRODUCT_COLS}
       FROM snapshot_records sr
       JOIN records r ON r.record_hash = sr.record_hash
       JOIN snapshots s ON s.id = sr.snapshot_id
      WHERE sr.source_id = $1 ORDER BY sr.snapshot_id`,
    [sourceId],
  );
  const out: HistoryEntry[] = [];
  let lastHash = '';
  for (const row of res.rows) {
    const { snapshot_id, record_hash, taken_at, ...record } = row;
    const prev = out[out.length - 1];
    if (prev && record_hash === lastHash) {
      prev.last_snapshot = snapshot_id;
    } else {
      out.push({ first_snapshot: snapshot_id, last_snapshot: snapshot_id, first_seen: taken_at, record });
      lastHash = record_hash;
    }
  }
  return out;
}
