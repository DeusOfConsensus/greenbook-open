import { createHash } from 'node:crypto';

export const HASH_VERSION = 1;

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** JSON with sorted keys and no whitespace, so equal data always hashes equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Identity of a record: its product id plus its cleaned raw fields. */
export function recordHash(sourceId: string, cleanedFields: Record<string, unknown>): string {
  return sha256(canonicalJson({ id: sourceId, fields: cleanedFields }));
}

/**
 * Hash of a whole snapshot: sha256 over lines "source_id<TAB>record_hash\n", sorted by
 * source_id by plain code-point comparison (never locale-dependent). Order of input does
 * not matter. This is the value to sign, tag or anchor to prove what the register said.
 */
export function snapshotContentHash(pairs: ReadonlyArray<readonly [string, string]>): string {
  const sorted = [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = createHash('sha256');
  for (const [id, hash] of sorted) h.update(`${id}\t${hash}\n`, 'utf8');
  return h.digest('hex');
}
