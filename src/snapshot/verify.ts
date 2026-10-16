import type { Db } from '../db.js';
import { recordHash, snapshotContentHash } from '../hash.js';

export interface VerifyIssue {
  kind: 'record_hash_mismatch' | 'snapshot_hash_mismatch' | 'snapshot_count_mismatch';
  snapshot_id?: number;
  record_hash?: string;
  source_id?: string;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  snapshots_checked: number;
  records_checked: number;
  issues: VerifyIssue[];
}

/**
 * Re-derive every hash from the stored data and compare with what was recorded at ingest:
 *  1. each record's hash must equal sha256 of its stored id + raw fields, and
 *  2. each snapshot's content hash must equal the hash of its (source_id, record_hash) list.
 * Any edit to a stored record, or to which records belong to a snapshot, shows up here.
 * This proves the database is self-consistent; it does not prove what NAFDAC published,
 * which is what publishing the snapshot hash somewhere independent (a signed tag, an
 * anchor) is for.
 */
export async function verifyAll(db: Db): Promise<VerifyResult> {
  const issues: VerifyIssue[] = [];

  const recs = await db.query<{ record_hash: string; source_id: string; raw: Record<string, unknown> }>(
    'SELECT record_hash, source_id, raw FROM records',
  );
  for (const r of recs.rows) {
    if (recordHash(r.source_id, r.raw) !== r.record_hash) {
      issues.push({
        kind: 'record_hash_mismatch', record_hash: r.record_hash, source_id: r.source_id,
        detail: `Stored fields of product ${r.source_id} no longer match the hash they were stored under.`,
      });
    }
  }

  const snaps = await db.query<{ id: number; record_count: number; content_hash: string }>(
    'SELECT id, record_count, content_hash FROM snapshots ORDER BY id',
  );
  for (const s of snaps.rows) {
    const pairs = await db.query<{ source_id: string; record_hash: string }>(
      'SELECT source_id, record_hash FROM snapshot_records WHERE snapshot_id = $1',
      [s.id],
    );
    if (pairs.rows.length !== s.record_count) {
      issues.push({
        kind: 'snapshot_count_mismatch', snapshot_id: s.id,
        detail: `Snapshot #${s.id} says ${s.record_count} records but holds ${pairs.rows.length}.`,
      });
    }
    const actual = snapshotContentHash(pairs.rows.map((p) => [p.source_id, p.record_hash] as const));
    if (actual !== s.content_hash) {
      issues.push({
        kind: 'snapshot_hash_mismatch', snapshot_id: s.id,
        detail: `Snapshot #${s.id} content hash is ${s.content_hash.slice(0, 16)}… but its records hash to ${actual.slice(0, 16)}….`,
      });
    }
  }

  return { ok: issues.length === 0, snapshots_checked: snaps.rows.length, records_checked: recs.rows.length, issues };
}
