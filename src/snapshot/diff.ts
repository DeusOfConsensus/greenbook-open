import { canonicalJson } from '../hash.js';
import { type Db, pgArray } from '../db.js';
import type { ProductRow, SnapshotMeta } from '../types.js';
import { PRODUCT_COLS, resolveSnapshot } from './repo.js';

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ChangedProduct {
  source_id: string;
  reg_no: string | null;
  product_name: string | null;
  /** Changes in the cleaned columns. */
  changes: FieldChange[];
  /** Changes in the raw source fields (can exist even when normalisation hides them). */
  raw_changes: FieldChange[];
}

export interface StatusChange {
  source_id: string;
  reg_no: string | null;
  product_name: string | null;
  from: string | null;
  to: string | null;
}

export interface SnapshotDiff {
  from: SnapshotMeta;
  to: SnapshotMeta;
  summary: {
    added: number;
    removed: number;
    changed: number;
    status_changed: number;
    newly_expired: number;
    unchanged: number;
  };
  /** Products newly on the register. */
  added: ProductRow[];
  /** Products no longer on the register. */
  removed: ProductRow[];
  changed: ChangedProduct[];
  status_changes: StatusChange[];
  /**
   * Products whose expiry date passed between the two snapshot dates. This is date-driven,
   * so a product can become expired without the register changing at all.
   */
  newly_expired: ProductRow[];
}

const COMPARED: (keyof ProductRow)[] = [
  'reg_no', 'product_name', 'ingredients', 'dosage_form', 'strength_text', 'manufacturer', 'applicant',
  'category', 'atc_codes', 'approved_on', 'expires_on', 'status',
];

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

function cmpId(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

type WithRaw = ProductRow & { raw: Record<string, unknown>; record_hash: string };

async function loadByHash(db: Db, hashes: string[]): Promise<Map<string, WithRaw>> {
  const map = new Map<string, WithRaw>();
  for (let i = 0; i < hashes.length; i += 2000) {
    const chunk = hashes.slice(i, i + 2000);
    const res = await db.query<WithRaw>(
      `SELECT r.record_hash, r.raw, ${PRODUCT_COLS} FROM records r WHERE r.record_hash = ANY($1::text[])`,
      [pgArray(chunk)],
    );
    for (const row of res.rows) map.set(row.record_hash, row);
  }
  return map;
}

function stripInternal({ raw: _raw, record_hash: _hash, ...row }: WithRaw): ProductRow {
  return row;
}

/** Compare two snapshots (references as accepted by resolveSnapshot). */
export async function diffSnapshots(db: Db, fromRef: string | number, toRef: string | number): Promise<SnapshotDiff> {
  const from = await resolveSnapshot(db, fromRef);
  const to = await resolveSnapshot(db, toRef);

  const pairs = await db.query<{ source_id: string; from_hash: string | null; to_hash: string | null }>(
    `SELECT COALESCE(a.source_id, b.source_id) AS source_id, a.record_hash AS from_hash, b.record_hash AS to_hash
       FROM (SELECT source_id, record_hash FROM snapshot_records WHERE snapshot_id = $1) a
       FULL OUTER JOIN (SELECT source_id, record_hash FROM snapshot_records WHERE snapshot_id = $2) b
         ON a.source_id = b.source_id
      WHERE a.record_hash IS DISTINCT FROM b.record_hash`,
    [from.id, to.id],
  );

  const hashes = new Set<string>();
  for (const p of pairs.rows) {
    if (p.from_hash) hashes.add(p.from_hash);
    if (p.to_hash) hashes.add(p.to_hash);
  }
  const recs = await loadByHash(db, [...hashes]);

  const added: ProductRow[] = [];
  const removed: ProductRow[] = [];
  const changed: ChangedProduct[] = [];
  const statusChanges: StatusChange[] = [];

  for (const p of pairs.rows) {
    const a = p.from_hash ? recs.get(p.from_hash) : undefined;
    const b = p.to_hash ? recs.get(p.to_hash) : undefined;
    if (!a && b) added.push(stripInternal(b));
    else if (a && !b) removed.push(stripInternal(a));
    else if (a && b) {
      const changes: FieldChange[] = [];
      for (const field of COMPARED) {
        if (!same(a[field], b[field])) changes.push({ field, from: a[field] ?? null, to: b[field] ?? null });
      }
      const rawChanges: FieldChange[] = [];
      for (const key of new Set([...Object.keys(a.raw), ...Object.keys(b.raw)])) {
        if (!same(a.raw[key], b.raw[key])) rawChanges.push({ field: key, from: a.raw[key] ?? null, to: b.raw[key] ?? null });
      }
      changed.push({ source_id: p.source_id, reg_no: b.reg_no, product_name: b.product_name, changes, raw_changes: rawChanges });
      if (!same(a.status_norm, b.status_norm) || !same(a.status, b.status)) {
        statusChanges.push({
          source_id: p.source_id, reg_no: b.reg_no, product_name: b.product_name,
          from: a.status, to: b.status,
        });
      }
    }
  }

  const byId = <T extends { source_id: string }>(x: T[]) => x.sort((p, q) => cmpId(p.source_id, q.source_id));
  byId(added); byId(removed); byId(changed); byId(statusChanges);

  const expired = await db.query<ProductRow>(
    `SELECT ${PRODUCT_COLS} FROM snapshot_records sr JOIN records r ON r.record_hash = sr.record_hash
      WHERE sr.snapshot_id = $1 AND r.expires_on > $2::date AND r.expires_on <= $3::date
      ORDER BY r.source_id`,
    [to.id, from.taken_at.slice(0, 10), to.taken_at.slice(0, 10)],
  );
  const newlyExpired = byId(expired.rows);

  return {
    from,
    to,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      status_changed: statusChanges.length,
      newly_expired: newlyExpired.length,
      unchanged: to.record_count - added.length - changed.length,
    },
    added, removed, changed, status_changes: statusChanges, newly_expired: newlyExpired,
  };
}
