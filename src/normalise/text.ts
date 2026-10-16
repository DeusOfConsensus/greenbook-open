const PLACEHOLDERS = new Set([
  '',
  'n/a',
  'na',
  'n.a',
  'n.a.',
  'null',
  'none',
  'nil',
  '-',
  '--',
  '---',
  'nan',
  'undefined',
]);

/** Lower-case alphanumerics only. Used to match field names regardless of spacing or case. */
export function keyify(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Turn whatever a source gave us into a string. Objects such as {id, name} yield their name. */
export function asText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(asText).filter((x): x is string => x !== null && x.trim() !== '');
    return parts.length > 0 ? parts.join('; ') : null;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return asText(o.name ?? o.title ?? o.label ?? o.value ?? null);
  }
  return null;
}

/** Trim, collapse whitespace, unify dashes, and map placeholder values like "N/A" to null. */
export function cleanText(v: unknown): string | null {
  const s = asText(v);
  if (s === null) return null;
  const t = s
    .normalize('NFKC')
    .replace(/[‐-―−]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return PLACEHOLDERS.has(t.toLowerCase()) ? null : t;
}
