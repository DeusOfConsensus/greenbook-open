import type { Db } from '../db.js';
import { regNoShape } from '../normalise/codes.js';
import { resolveSnapshot } from '../snapshot/repo.js';
import type { SnapshotMeta } from '../types.js';

export interface QualityReport {
  snapshot: Pick<SnapshotMeta, 'id' | 'taken_at' | 'source' | 'record_count' | 'content_hash'>;
  as_of: string;
  ids: {
    total: number;
    duplicate_ids_dropped_at_ingest: number;
    numeric: null | { count: number; min: number; max: number; missing_in_range: number };
  };
  reg_no: {
    missing: number;
    distinct: number;
    shared_numbers: number;
    products_sharing_a_number: number;
    largest_group: { reg_no: string; products: number } | null;
    shapes: { shape: string; count: number }[];
  };
  dates: {
    approval: { missing: number; unparseable: number; sentinel: number; earliest: string | null; latest: string | null; in_future: number };
    expiry: { missing: number; unparseable: number; sentinel: number; earliest: string | null; latest: string | null };
    expiry_before_approval: number;
    active_but_past_expiry: number;
  };
  status: { values: { status: string | null; normalised: string; count: number }[]; unmapped: { status: string; count: number }[] };
  ingredients: { empty: number; multi_ingredient: number; distinct_names: number };
  strength: { present: number; parsed: number; unparsed: number; count_mismatch: number; unparsed_examples: { text: string; count: number }[] };
  atc: { with_codes: number; missing: number; invalid: number };
  organisations: {
    manufacturer_missing: number;
    applicant_missing: number;
    manufacturer_name_variants: number;
    variant_examples: { key: string; spellings: number }[];
  };
  categories: { category: string | null; count: number }[];
  issues: { code: string; count: number }[];
}

const BASE = `FROM snapshot_records sr JOIN records r ON r.record_hash = sr.record_hash WHERE sr.snapshot_id = $1`;

/** Measure how clean one snapshot is. Every number here is computed, none is assumed. */
export async function buildQualityReport(db: Db, ref?: string | number | null, asOf?: string): Promise<QualityReport> {
  const snap = await resolveSnapshot(db, ref);
  const today = asOf ?? new Date().toISOString().slice(0, 10);
  const q = async <T>(sql: string, extra: unknown[] = []) => (await db.query<T>(sql, [snap.id, ...extra])).rows;
  const one = async <T>(sql: string, extra: unknown[] = []) => (await q<T>(sql, extra))[0]!;

  const ids = await one<{ total: number; n: number; lo: number | null; hi: number | null }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE sr.source_id ~ '^[0-9]{1,15}$')::int AS n,
            min(CASE WHEN sr.source_id ~ '^[0-9]{1,15}$' THEN sr.source_id::bigint END)::float8 AS lo,
            max(CASE WHEN sr.source_id ~ '^[0-9]{1,15}$' THEN sr.source_id::bigint END)::float8 AS hi ${BASE}`,
  );

  const reg = await one<{ missing: number; distinct: number }>(
    `SELECT count(*) FILTER (WHERE r.reg_no_key IS NULL)::int AS missing,
            count(DISTINCT r.reg_no_key)::int AS distinct ${BASE}`,
  );
  const shared = await one<{ numbers: number; products: number }>(
    `SELECT count(*)::int AS numbers, COALESCE(sum(n), 0)::int AS products FROM
       (SELECT count(*) AS n ${BASE} AND r.reg_no_key IS NOT NULL GROUP BY r.reg_no_key HAVING count(*) > 1) g`,
  );
  const largest = (
    await q<{ reg_no: string; n: number }>(
      `SELECT max(r.reg_no) AS reg_no, count(*)::int AS n ${BASE} AND r.reg_no_key IS NOT NULL
        GROUP BY r.reg_no_key HAVING count(*) > 1 ORDER BY n DESC, max(r.reg_no) LIMIT 1`,
    )
  )[0];
  const shapeRows = await q<{ reg_no: string; n: number }>(
    `SELECT r.reg_no, count(*)::int AS n ${BASE} AND r.reg_no IS NOT NULL GROUP BY r.reg_no`,
  );
  const shapes = new Map<string, number>();
  for (const s of shapeRows) shapes.set(regNoShape(s.reg_no), (shapes.get(regNoShape(s.reg_no)) ?? 0) + s.n);

  const d = await one<Record<string, number | string | null>>(
    // "missing" means the source gave nothing; a bad or placeholder value is counted on its own line.
    `SELECT count(*) FILTER (WHERE r.approved_on IS NULL
                               AND NOT ('date.approval.unparseable' = ANY(r.issues))
                               AND NOT ('date.approval.sentinel' = ANY(r.issues)))::int AS a_missing,
            count(*) FILTER (WHERE 'date.approval.unparseable' = ANY(r.issues))::int AS a_bad,
            count(*) FILTER (WHERE 'date.approval.sentinel' = ANY(r.issues))::int AS a_sent,
            min(r.approved_on)::text AS a_min, max(r.approved_on)::text AS a_max,
            count(*) FILTER (WHERE r.approved_on > $2::date)::int AS a_future,
            count(*) FILTER (WHERE r.expires_on IS NULL
                               AND NOT ('date.expiry.unparseable' = ANY(r.issues))
                               AND NOT ('date.expiry.sentinel' = ANY(r.issues)))::int AS e_missing,
            count(*) FILTER (WHERE 'date.expiry.unparseable' = ANY(r.issues))::int AS e_bad,
            count(*) FILTER (WHERE 'date.expiry.sentinel' = ANY(r.issues))::int AS e_sent,
            min(r.expires_on)::text AS e_min, max(r.expires_on)::text AS e_max,
            count(*) FILTER (WHERE 'date.expiry_before_approval' = ANY(r.issues))::int AS e_before,
            count(*) FILTER (WHERE r.status_norm = 'active' AND r.expires_on < $2::date)::int AS active_expired ${BASE}`,
    [today],
  );

  const statusRows = await q<{ status: string | null; norm: string; n: number }>(
    `SELECT r.status, r.status_norm AS norm, count(*)::int AS n ${BASE} GROUP BY r.status, r.status_norm ORDER BY n DESC`,
  );

  const ing = await one<{ empty: number; multi: number; names: number }>(
    `SELECT count(*) FILTER (WHERE cardinality(r.ingredients) = 0)::int AS empty,
            count(*) FILTER (WHERE cardinality(r.ingredients) > 1)::int AS multi,
            (SELECT count(DISTINCT i) FROM snapshot_records s2 JOIN records r2 ON r2.record_hash = s2.record_hash,
                    unnest(r2.ingredients) AS i WHERE s2.snapshot_id = $1)::int AS names ${BASE}`,
  );

  const str = await one<{ present: number; unparsed: number; mismatch: number }>(
    `SELECT count(*) FILTER (WHERE r.strength_text IS NOT NULL)::int AS present,
            count(*) FILTER (WHERE 'strength.unparsed' = ANY(r.issues))::int AS unparsed,
            count(*) FILTER (WHERE 'strength.ingredient_count_mismatch' = ANY(r.issues))::int AS mismatch ${BASE}`,
  );
  const unparsedEx = await q<{ t: string; n: number }>(
    `SELECT r.strength_text AS t, count(*)::int AS n ${BASE} AND 'strength.unparsed' = ANY(r.issues)
      GROUP BY r.strength_text ORDER BY n DESC, t LIMIT 10`,
  );

  const atc = await one<{ with: number; invalid: number }>(
    `SELECT count(*) FILTER (WHERE cardinality(r.atc_codes) > 0)::int AS "with",
            count(*) FILTER (WHERE 'atc.invalid' = ANY(r.issues))::int AS invalid ${BASE}`,
  );

  const org = await one<{ m_missing: number; a_missing: number; groups: number }>(
    `SELECT count(*) FILTER (WHERE r.manufacturer IS NULL)::int AS m_missing,
            count(*) FILTER (WHERE r.applicant IS NULL)::int AS a_missing,
            (SELECT count(*) FROM (SELECT 1 FROM snapshot_records s2 JOIN records r2 ON r2.record_hash = s2.record_hash
               WHERE s2.snapshot_id = $1 AND r2.manufacturer_norm IS NOT NULL
               GROUP BY r2.manufacturer_norm HAVING count(DISTINCT r2.manufacturer) > 1) v)::int AS groups ${BASE}`,
  );
  const variants = await q<{ key: string; v: number }>(
    `SELECT r.manufacturer_norm AS key, count(DISTINCT r.manufacturer)::int AS v ${BASE} AND r.manufacturer_norm IS NOT NULL
      GROUP BY r.manufacturer_norm HAVING count(DISTINCT r.manufacturer) > 1 ORDER BY v DESC, key LIMIT 10`,
  );

  const cats = await q<{ category: string | null; n: number }>(
    `SELECT r.category, count(*)::int AS n ${BASE} GROUP BY r.category ORDER BY n DESC`,
  );
  const issues = await q<{ code: string; n: number }>(
    `SELECT i AS code, count(*)::int AS n FROM snapshot_records sr JOIN records r ON r.record_hash = sr.record_hash,
            unnest(r.issues) AS i WHERE sr.snapshot_id = $1 GROUP BY i ORDER BY n DESC, code`,
  );

  const dupes = Number((snap.notes as { duplicate_source_ids?: number }).duplicate_source_ids ?? 0);
  const num = (v: unknown) => Number(v ?? 0);

  return {
    snapshot: {
      id: snap.id, taken_at: snap.taken_at, source: snap.source,
      record_count: snap.record_count, content_hash: snap.content_hash,
    },
    as_of: today,
    ids: {
      total: ids.total,
      duplicate_ids_dropped_at_ingest: dupes,
      numeric:
        ids.n > 0 && ids.lo !== null && ids.hi !== null
          ? { count: ids.n, min: ids.lo, max: ids.hi, missing_in_range: ids.hi - ids.lo + 1 - ids.n }
          : null,
    },
    reg_no: {
      missing: reg.missing,
      distinct: reg.distinct,
      shared_numbers: shared.numbers,
      products_sharing_a_number: shared.products,
      largest_group: largest ? { reg_no: largest.reg_no, products: largest.n } : null,
      shapes: [...shapes].map(([shape, count]) => ({ shape, count })).sort((a, b) => b.count - a.count).slice(0, 12),
    },
    dates: {
      approval: {
        missing: num(d.a_missing), unparseable: num(d.a_bad), sentinel: num(d.a_sent),
        earliest: (d.a_min as string | null) ?? null, latest: (d.a_max as string | null) ?? null,
        in_future: num(d.a_future),
      },
      expiry: {
        missing: num(d.e_missing), unparseable: num(d.e_bad), sentinel: num(d.e_sent),
        earliest: (d.e_min as string | null) ?? null, latest: (d.e_max as string | null) ?? null,
      },
      expiry_before_approval: num(d.e_before),
      active_but_past_expiry: num(d.active_expired),
    },
    status: {
      values: statusRows.map((s) => ({ status: s.status, normalised: s.norm, count: s.n })),
      unmapped: statusRows.filter((s) => s.norm === 'unknown' && s.status !== null).map((s) => ({ status: s.status!, count: s.n })),
    },
    ingredients: { empty: ing.empty, multi_ingredient: ing.multi, distinct_names: ing.names },
    strength: {
      present: str.present, parsed: str.present - str.unparsed, unparsed: str.unparsed,
      count_mismatch: str.mismatch, unparsed_examples: unparsedEx.map((u) => ({ text: u.t, count: u.n })),
    },
    atc: { with_codes: atc.with, missing: ids.total - atc.with, invalid: atc.invalid },
    organisations: {
      manufacturer_missing: org.m_missing, applicant_missing: org.a_missing,
      manufacturer_name_variants: org.groups,
      variant_examples: variants.map((v) => ({ key: v.key, spellings: v.v })),
    },
    categories: cats.map((c) => ({ category: c.category, count: c.n })),
    issues: issues.map((i) => ({ code: i.code, count: i.n })),
  };
}

const n = (x: number) => x.toLocaleString('en-US');
const pct = (part: number, whole: number) => (whole === 0 ? '0%' : `${((part / whole) * 100).toFixed(1)}%`);

export const QUALITY_START = '<!-- QUALITY:START -->';
export const QUALITY_END = '<!-- QUALITY:END -->';

export function renderQualityMarkdown(r: QualityReport, banner?: string): string {
  const t = r.snapshot.record_count;
  const out: string[] = [];
  if (banner) out.push(`> ${banner}`, '');
  out.push(
    `Measured on snapshot #${r.snapshot.id} (taken ${r.snapshot.taken_at}, source \`${r.snapshot.source}\`, ${n(t)} records, ` +
      `content hash \`${r.snapshot.content_hash.slice(0, 16)}…\`). Expiry checks evaluated as of ${r.as_of}. ` +
      `Regenerate with \`greenbook-open quality --write-readme\`.`,
    '',
    '| Check | Result |',
    '|---|---|',
  );
  if (r.ids.numeric) {
    out.push(
      `| Product IDs in range ${n(r.ids.numeric.min)}–${n(r.ids.numeric.max)} | ${n(r.ids.numeric.count)} present, **${n(r.ids.numeric.missing_in_range)} missing from the public list** |`,
    );
  }
  out.push(
    `| Duplicate product IDs in the source | ${n(r.ids.duplicate_ids_dropped_at_ingest)} |`,
    `| Registration numbers missing | ${n(r.reg_no.missing)} (${pct(r.reg_no.missing, t)}) |`,
    `| Registration numbers shared by more than one product | **${n(r.reg_no.shared_numbers)} numbers cover ${n(r.reg_no.products_sharing_a_number)} products**` +
      (r.reg_no.largest_group ? `; largest group \`${r.reg_no.largest_group.reg_no}\` has ${r.reg_no.largest_group.products}` : '') + ' |',
    `| Approval date missing / unparseable / placeholder | ${n(r.dates.approval.missing)} / ${n(r.dates.approval.unparseable)} / ${n(r.dates.approval.sentinel)} |`,
    `| Expiry date missing / unparseable / placeholder | ${n(r.dates.expiry.missing)} / ${n(r.dates.expiry.unparseable)} / ${n(r.dates.expiry.sentinel)} |`,
    `| Expiry before approval | ${n(r.dates.expiry_before_approval)} |`,
    `| Status "active" but expiry date already passed | ${n(r.dates.active_but_past_expiry)} |`,
    `| Status values not recognised by the normaliser | ${r.status.unmapped.length === 0 ? 'none' : r.status.unmapped.map((u) => `\`${u.status}\` (${n(u.count)})`).join(', ')} |`,
    `| Records with no parsed ingredient | ${n(r.ingredients.empty)} |`,
    `| Strength text that could not be parsed | ${n(r.strength.unparsed)} of ${n(r.strength.present)} (${pct(r.strength.unparsed, r.strength.present)}) |`,
    `| Records with an ATC code / missing / invalid | ${n(r.atc.with_codes)} / ${n(r.atc.missing)} / ${n(r.atc.invalid)} |`,
    `| Manufacturer missing / applicant missing | ${n(r.organisations.manufacturer_missing)} / ${n(r.organisations.applicant_missing)} |`,
    `| Manufacturer names with several spellings | ${n(r.organisations.manufacturer_name_variants)} |`,
    '',
  );
  if (r.reg_no.shapes.length > 0) {
    out.push(
      `Registration number formats seen (A = letter, 9 = digit): ` +
        r.reg_no.shapes.slice(0, 8).map((s) => `\`${s.shape}\` ×${n(s.count)}`).join(', ') + '.',
      '',
    );
  }
  if (r.strength.unparsed_examples.length > 0) {
    out.push(
      `Most common unparsed strengths: ` + r.strength.unparsed_examples.slice(0, 5).map((s) => `\`${s.text}\``).join(', ') + '.',
      '',
    );
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** Replace the block between the QUALITY markers in a README, or throw if they are absent. */
export function injectQuality(readme: string, markdown: string): string {
  const a = readme.indexOf(QUALITY_START);
  const b = readme.indexOf(QUALITY_END);
  if (a === -1 || b === -1 || b < a) throw new Error(`README is missing the ${QUALITY_START} / ${QUALITY_END} markers.`);
  return `${readme.slice(0, a + QUALITY_START.length)}\n\n${markdown}\n${readme.slice(b)}`;
}
