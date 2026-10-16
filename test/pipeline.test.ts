import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixtures } from '../scripts/make-fixtures.js';
import { RegisterIndex, checkItems, summarise } from '../src/check/checker.js';
import { readStockCsv, reportCsv } from '../src/check/csv.js';
import { similarity, withinOneEdit } from '../src/check/similarity.js';
import type { Db } from '../src/db.js';
import { FileSource } from '../src/fetch/sources.js';
import { QUALITY_END, QUALITY_START, buildQualityReport, injectQuality, renderQualityMarkdown } from '../src/quality/report.js';
import { diffSnapshots } from '../src/snapshot/diff.js';
import { verifyAll } from '../src/snapshot/verify.js';
import { IngestError, ingestSnapshot, renormalise } from '../src/snapshot/ingest.js';
import {
  NotFoundError, getByRegNo, getProduct, listSnapshots, loadSnapshotRows, productHistory, resolveSnapshot, searchProducts,
} from '../src/snapshot/repo.js';
import { idOf, newDb, seededDb } from './helpers.js';

let db: Db;
let fx: ReturnType<typeof buildFixtures>;
beforeAll(async () => {
  ({ db, fixtures: fx } = await seededDb());
}, 60_000);
afterAll(async () => {
  await db.close();
});

const raws = (i: number) => fx.snapshots[i]!.records.map((r) => ({ sourceId: String(r.productId), fields: r }));

describe('ingest', () => {
  it('stores three snapshots with the expected counts', async () => {
    const snaps = await listSnapshots(db);
    expect(snaps.map((s) => s.record_count)).toEqual([300, 307, 310]);
    expect(new Set(snaps.map((s) => s.content_hash)).size).toBe(3);
  });

  it('de-duplicates: unchanged products are stored once across snapshots', async () => {
    const n = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM records')).rows[0]!.n;
    // 300 + (10 changed + 10 new) + (2 reactivated + 4 new) = 326, far below 300+307+310.
    expect(n).toBeLessThan(400);
    expect(n).toBeGreaterThanOrEqual(310);
  });

  it('never stores contact details', async () => {
    const hit = await db.query(`SELECT 1 FROM records WHERE raw::text ILIKE '%demo.example%' OR raw::text ILIKE '%applicantPhone%' OR raw::text ILIKE '%applicantEmail%'`);
    expect(hit.rows).toHaveLength(0);
    const snap1 = (await listSnapshots(db))[0]!;
    expect(Number((snap1.notes as { stripped_contact_fields: number }).stripped_contact_fields)).toBe(60); // 30 records x 2 fields
  });

  it('keeps the raw record next to the normalised columns', async () => {
    const row = await getProduct(db, (await resolveSnapshot(db, 1)).id, String(idOf(0)));
    expect(row?.raw).toMatchObject({ registrationNumber: 'T1-1000' });
    expect(row?.reg_no).toBe('T1-1000');
    expect(row?.ingredients).toEqual(['artemether', 'lumefantrine']);
  });

  it('re-ingesting identical content creates no snapshot and just re-confirms', async () => {
    const before = (await listSnapshots(db)).length;
    const res = await ingestSnapshot(db, raws(2), { source: 'again', takenAt: new Date('2026-10-16T06:00:00Z') });
    expect(res.status).toBe('unchanged');
    const after = await listSnapshots(db);
    expect(after).toHaveLength(before);
    expect(after[2]!.confirm_count).toBe(2);
    expect(after[2]!.last_confirmed_at).toBe('2026-10-16T06:00:00Z');
  });

  it('is deterministic: same data in a fresh database gives the same snapshot hashes', async () => {
    const { db: db2 } = await seededDb();
    const a = (await listSnapshots(db)).map((s) => s.content_hash);
    const b = (await listSnapshots(db2)).map((s) => s.content_hash);
    expect(b).toEqual(a);
    await db2.close();
  });
});

describe('ingest guards', () => {
  const fresh = () => newDb();

  it('refuses an empty fetch', async () => {
    const d = await fresh();
    await expect(ingestSnapshot(d, [], { source: 'x' })).rejects.toBeInstanceOf(IngestError);
    await d.close();
  });

  it('refuses a fetch shorter than the source reports, unless allowed', async () => {
    const d = await fresh();
    await expect(ingestSnapshot(d, raws(0).slice(0, 50), { source: 'x', expectedTotal: 300 })).rejects.toThrow(/incomplete/);
    const ok = await ingestSnapshot(d, raws(0).slice(0, 50), { source: 'x', expectedTotal: 300, allowPartial: true });
    expect(ok.status).toBe('created');
    await d.close();
  });

  it('refuses a snapshot that shrinks suspiciously, unless forced', async () => {
    const d = await fresh();
    await ingestSnapshot(d, raws(0), { source: 'a', takenAt: new Date('2026-09-01T00:00:00Z') });
    await expect(ingestSnapshot(d, raws(0).slice(0, 100), { source: 'b', takenAt: new Date('2026-09-02T00:00:00Z') })).rejects.toThrow(/failed or partial/);
    const forced = await ingestSnapshot(d, raws(0).slice(0, 100), { source: 'b', takenAt: new Date('2026-09-02T00:00:00Z'), force: true });
    expect(forced.status).toBe('created');
    await d.close();
  });

  it('refuses out-of-order snapshots', async () => {
    const d = await fresh();
    await ingestSnapshot(d, raws(0), { source: 'a', takenAt: new Date('2026-10-01T00:00:00Z') });
    await expect(ingestSnapshot(d, raws(1), { source: 'b', takenAt: new Date('2026-09-01T00:00:00Z') })).rejects.toThrow(/chronological/);
    await d.close();
  });

  it('keeps the first of duplicate product ids and counts the rest', async () => {
    const d = await fresh();
    const rows = raws(0).slice(0, 10);
    const res = await ingestSnapshot(d, [...rows, rows[0]!, rows[1]!], { source: 'dupes' });
    expect(res.recordCount).toBe(10);
    expect(res.duplicateIds).toBe(2);
    await d.close();
  });

  it('rolls everything back when the write fails part-way: no snapshot row, no orphan records', async () => {
    const d = await fresh();
    // Same database, but the last insert inside the transaction blows up.
    const failing = {
      kind: d.kind,
      query: (sql: string, p?: unknown[]) => d.query(sql, p),
      exec: (sql: string) => d.exec(sql),
      close: () => d.close(),
      tx: <T,>(fn: (t: Db) => Promise<T>) =>
        d.tx((t) =>
          fn({
            ...t,
            kind: t.kind,
            exec: (sql: string) => t.exec(sql),
            tx: <U,>(f: (x: Db) => Promise<U>) => f(t),
            close: async () => undefined,
            query: async (sql: string, p?: unknown[]) => {
              if (sql.includes('INSERT INTO snapshot_records')) throw new Error('disk exploded');
              return t.query(sql, p);
            },
          } as unknown as Db),
        ),
    } as unknown as Db;

    await expect(ingestSnapshot(failing, raws(0).slice(0, 20), { source: 'x' })).rejects.toThrow('disk exploded');
    expect((await d.query<{ n: number }>('SELECT count(*)::int AS n FROM snapshots')).rows[0]!.n).toBe(0);
    expect((await d.query<{ n: number }>('SELECT count(*)::int AS n FROM records')).rows[0]!.n).toBe(0);
    // And the database is still usable afterwards.
    expect((await ingestSnapshot(d, raws(0).slice(0, 20), { source: 'x' })).status).toBe('created');
    await d.close();
  });
});

describe('FileSource', () => {
  it('rejects rows with no product id and explains why registration numbers do not substitute', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'gbo-'));
    const p = join(dir, 'x.json');
    writeFileSync(p, JSON.stringify([{ registrationNumber: 'A1-1', productName: 'X' }]));
    const it = new FileSource(p).records()[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(/NOT unique/);

    const c = join(dir, 'x.csv');
    writeFileSync(c, 'id,NRN,Product Name\n7,A1-1,X\n8,A1-1,Y\n');
    const got: string[] = [];
    for await (const r of new FileSource(c).records()) got.push(r.sourceId);
    expect(got).toEqual(['7', '8']); // two products, one registration number: both kept
  });
});

describe('snapshot references', () => {
  it('resolves latest, ids and dates', async () => {
    expect((await resolveSnapshot(db)).id).toBe(3);
    expect((await resolveSnapshot(db, 'latest')).id).toBe(3);
    expect((await resolveSnapshot(db, '2')).id).toBe(2);
    expect((await resolveSnapshot(db, '2026-09-20')).id).toBe(1); // as of the end of that day
    expect((await resolveSnapshot(db, '2026-10-01')).id).toBe(2);
    await expect(resolveSnapshot(db, '2026-08-01')).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveSnapshot(db, 'nonsense')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('search', () => {
  const s = () => resolveSnapshot(db).then((x) => x.id);

  it('finds a combination by ingredient and requires all comma-separated terms', async () => {
    const both = await searchProducts(db, await s(), { ingredient: 'artemether,lumefantrine' }, { limit: 100, offset: 0 });
    expect(both.total).toBeGreaterThan(0);
    for (const r of both.rows) expect(r.ingredients).toEqual(expect.arrayContaining(['artemether', 'lumefantrine']));
    const none = await searchProducts(db, await s(), { ingredient: 'artemether,paracetamol' }, { limit: 10, offset: 0 });
    expect(none.total).toBe(0);
  });

  it('matches ATC codes by prefix', async () => {
    const mal = await searchProducts(db, await s(), { atc: 'P01B' }, { limit: 500, offset: 0 });
    expect(mal.total).toBeGreaterThan(0);
    for (const r of mal.rows) expect(r.atc_codes.some((c) => c.startsWith('P01B'))).toBe(true);
    const exact = await searchProducts(db, await s(), { atc: 'p01bf01' }, { limit: 500, offset: 0 });
    expect(exact.total).toBeGreaterThan(0);
    expect(exact.total).toBeLessThan(mal.total);
  });

  it('matches manufacturer names across spelling variants', async () => {
    const r = await searchProducts(db, await s(), { manufacturer: 'DEMO PHARMA LTD.' }, { limit: 500, offset: 0 });
    const names = new Set(r.rows.map((x) => x.manufacturer));
    expect(r.total).toBeGreaterThan(0);
    expect(names.size).toBeGreaterThan(1); // "Demo Pharma Limited", "DEMO PHARMA LTD." ...
  });

  it('matches registration numbers however they are typed', async () => {
    const r = await searchProducts(db, await s(), { regNo: 't1 1000' }, { limit: 10, offset: 0 });
    expect(r.rows.map((x) => x.reg_no)).toEqual(['T1-1000']);
  });

  it('treats LIKE wildcards in user input literally and combines filters with AND', async () => {
    expect((await searchProducts(db, await s(), { q: '%' }, { limit: 5, offset: 0 })).total).toBe(0);
    const r = await searchProducts(db, await s(), { ingredient: 'paracetamol', status: 'active' }, { limit: 500, offset: 0 });
    for (const x of r.rows) expect(x.status_norm).toBe('active');
  });

  it('pages consistently', async () => {
    const id = await s();
    const a = await searchProducts(db, id, {}, { limit: 20, offset: 0 });
    const b = await searchProducts(db, id, {}, { limit: 20, offset: 20 });
    expect(a.total).toBe(310);
    expect(new Set([...a.rows, ...b.rows].map((r) => r.source_id)).size).toBe(40);
  });

  it('returns every product sharing a registration number', async () => {
    const rows = await getByRegNo(db, await s(), 'T2-1100');
    expect(rows.map((r) => r.source_id).sort()).toEqual([String(idOf(100)), String(idOf(101))].sort());
  });
});

describe('diff', () => {
  it('reports additions, removals, status changes and field changes between snapshots 1 and 2', async () => {
    const d = await diffSnapshots(db, 1, 2);
    expect(d.summary).toMatchObject({ added: 10, removed: 3, status_changed: 5 });
    expect(d.summary.changed).toBe(10); // 5 status + manufacturer + raw-only strength + 3 expiry dates
    expect(d.removed.map((r) => r.source_id).sort()).toEqual([250, 251, 252].map((i) => String(idOf(i))).sort());
    const sc = d.status_changes.find((c) => c.source_id === String(idOf(20)))!;
    expect([sc.from, sc.to]).toEqual(['Active', 'Inactive']);
    const mfr = d.changed.find((c) => c.source_id === String(idOf(30)))!;
    expect(mfr.changes.map((c) => c.field)).toEqual(['manufacturer']);
    const rawOnly = d.changed.find((c) => c.source_id === String(idOf(80)))!;
    expect(rawOnly.raw_changes.map((c) => c.field)).toEqual(['strength']);
  });

  it('reports reactivations and removals between snapshots 2 and 3', async () => {
    const d = await diffSnapshots(db, 2, 3);
    expect(d.summary).toMatchObject({ added: 4, removed: 1, status_changed: 2, changed: 2 });
    expect(d.status_changes.every((c) => c.from === 'Inactive' && c.to === 'Active')).toBe(true);
    expect(d.summary.unchanged).toBe(310 - 4 - 2);
  });

  it('finds products that expired by date between two snapshot dates, with no register change needed', async () => {
    const d = await diffSnapshots(db, '2026-10-01', '2026-10-15');
    const ids = d.newly_expired.map((r) => r.source_id);
    for (const i of [150, 151, 152]) expect(ids).toContain(String(idOf(i)));
    for (const r of d.newly_expired) {
      expect(r.expires_on! > '2026-10-01' && r.expires_on! <= '2026-10-15').toBe(true);
    }
  });

  it('is empty when comparing a snapshot with itself and works with dates as references', async () => {
    const d = await diffSnapshots(db, 3, 'latest');
    expect(d.summary).toMatchObject({ added: 0, removed: 0, changed: 0, status_changed: 0 });
    const byDate = await diffSnapshots(db, '2026-09-01', '2026-10-01');
    expect(byDate.from.id).toBe(1);
    expect(byDate.to.id).toBe(2);
  });
});

describe('history', () => {
  it('collapses unchanged runs and shows a status flip over time', async () => {
    const h = await productHistory(db, String(idOf(21))); // Active -> Inactive (s2) -> Active (s3)
    expect(h.map((x) => [x.first_snapshot, x.last_snapshot, x.record.status])).toEqual([
      [1, 1, 'Active'], [2, 2, 'Inactive'], [3, 3, 'Active'],
    ]);
    const stable = await productHistory(db, String(idOf(1)));
    expect(stable).toHaveLength(1);
    expect([stable[0]!.first_snapshot, stable[0]!.last_snapshot]).toEqual([1, 3]);
    expect(await productHistory(db, 'nope')).toEqual([]);
  });
});

describe('quality report', () => {
  it('finds exactly what was planted in snapshot 1', async () => {
    const r = await buildQualityReport(db, 1, '2026-10-15');
    expect(r.snapshot.record_count).toBe(300);
    expect(r.reg_no.shared_numbers).toBe(fx.planted.sharedRegNumbers);
    expect(r.reg_no.products_sharing_a_number).toBe(fx.planted.productsSharingRegNumbers);
    expect(r.reg_no.largest_group?.products).toBe(2);
    // ids 1000 + i + floor(i/7) for i in 0..299: range 1000..1341 = 342 wide, 300 present.
    expect(r.ids.numeric).toEqual({ count: 300, min: 1000, max: 1341, missing_in_range: 42 });
    // Every fixture record has an approval date; one is a placeholder and one is junk.
    // Those must each be counted once, on their own line, and never also as "missing".
    expect(r.dates.approval).toMatchObject({ missing: 0, sentinel: 1, unparseable: 1 });
    expect(r.dates.expiry).toMatchObject({ missing: 0, sentinel: 0, unparseable: 0 });
    expect(r.dates.expiry_before_approval).toBeGreaterThanOrEqual(1);
    expect(r.status.unmapped).toEqual([{ status: 'Under Review', count: 1 }]);
    expect(r.atc.invalid).toBe(1);
    expect(r.strength.unparsed).toBe(1);
    expect(r.strength.unparsed_examples[0]).toEqual({ text: 'as directed', count: 1 });
    expect(r.organisations.manufacturer_name_variants).toBeGreaterThan(0);
    expect(r.reg_no.shapes[0]!.shape).toMatch(/^A9-9999$/);
  });

  it('renders markdown and injects it between README markers', async () => {
    const md = renderQualityMarkdown(await buildQualityReport(db, 1, '2026-10-15'), 'Synthetic data');
    expect(md).toContain('| Registration numbers shared by more than one product |');
    expect(md).toContain('42 missing from the public list');
    const readme = `# T\n${QUALITY_START}\nSTALE-CONTENT-123\n${QUALITY_END}\ntail\n`;
    const out = injectQuality(readme, md);
    expect(out).not.toContain('STALE-CONTENT-123');
    expect(out).toContain('42 missing from the public list');
    expect(out.endsWith('tail\n')).toBe(true);
    expect(() => injectQuality('no markers', md)).toThrow(/markers/);
  });
});

describe('similarity', () => {
  it('scores same products high and different ones low', () => {
    expect(similarity('ZOLVEXIN 80/480 TABLETS', 'Zolvexin 80/480 tablets')).toBeGreaterThan(0.95);
    expect(similarity('Amoxil 500mg Capsules', 'AMOXIL')).toBeGreaterThanOrEqual(0.9);
    expect(similarity('Zolvexin', 'Totally Different Syrup')).toBeLessThan(0.35);
    expect(similarity('Zolvexin', 'Zolvexen')).toBeGreaterThan(0.6);
    expect(similarity(null, 'x')).toBe(0);
    expect(similarity('Tablets 500mg', 'Tablets 500mg')).toBe(0); // nothing distinctive left to compare
  });
  it('detects single edits', () => {
    expect(withinOneEdit('T31200', 'T31201')).toBe(true);
    expect(withinOneEdit('T31200', 'T3120')).toBe(true);
    expect(withinOneEdit('T31200', 'T3120X1')).toBe(false);
    expect(withinOneEdit('T31200', 'T31200')).toBe(true);
  });
});

describe('checker', () => {
  it('returns the expected verdict for every row of the sample stock list', async () => {
    const snap = await resolveSnapshot(db);
    const index = new RegisterIndex(snap, await loadSnapshotRows(db, snap.id));
    const stock = readStockCsv(fx.stock.csv);
    expect(stock.columns).toMatchObject({ regNo: 'NAFDAC Reg No', productName: 'Product Name', manufacturer: 'Manufacturer' });
    const results = checkItems(index, stock.inputs, { asOf: '2026-10-15' });
    for (const r of results) {
      const want = fx.stock.expected[r.row]!;
      expect({ row: r.row, verdict: r.verdict, severity: r.severity }, `row ${r.row}: ${r.reasons.join(',')}`).toEqual({ row: r.row, ...want });
    }
    const sum = summarise(results);
    expect(sum.total).toBe(12);
    expect(sum.by_severity.fail).toBe(5);
  });

  it('explains itself: near-miss registration numbers and ambiguity candidates are surfaced', async () => {
    const snap = await resolveSnapshot(db);
    const index = new RegisterIndex(snap, await loadSnapshotRows(db, snap.id));
    const stock = readStockCsv(fx.stock.csv);
    const results = checkItems(index, stock.inputs, { asOf: '2026-10-15' });
    const typo = results.find((r) => r.row === 7)!;
    expect(typo.reasons).toContain('near_reg_no_found');
    expect(typo.candidates[0]?.reg_no).toBe('T3-1200');
    const ambiguous = results.find((r) => r.row === 10)!;
    expect(ambiguous.candidates).toHaveLength(2);
    const expiring = results.find((r) => r.row === 5)!;
    expect(expiring.reasons.some((x) => /^expires_in_\d+_days$/.test(x))).toBe(true);
  });

  it('the same stock list evaluated against an older snapshot or date gives different answers', async () => {
    const s1 = await resolveSnapshot(db, 1);
    const idx = new RegisterIndex(s1, await loadSnapshotRows(db, s1.id));
    const stock = readStockCsv(fx.stock.csv);
    const early = checkItems(idx, stock.inputs, { asOf: '2025-06-01' });
    expect(early.find((r) => r.row === 4)!.verdict).toBe('ok'); // product 210 was not yet expired in mid-2025
  });

  it('reads awkward CSVs: semicolons, BOM, unusual headers and overrides', () => {
    const f = readStockCsv('﻿ITEM DESCRIPTION;NRN;Qty\nParacetamol 500mg;A4-0001;5\n');
    expect(f.columns).toMatchObject({ productName: 'ITEM DESCRIPTION', regNo: 'NRN' });
    expect(f.inputs[0]).toMatchObject({ row: 2, regNo: 'A4-0001', productName: 'Paracetamol 500mg' });
    expect(() => readStockCsv('foo,bar\n1,2\n')).toThrow(/registration-number or product-name column/);
    expect(readStockCsv('code,thing\nA4-1,X\n', { regNo: 'code', productName: 'thing' }).inputs[0]!.regNo).toBe('A4-1');
    expect(() => readStockCsv('a,b\n1,2\n', { regNo: 'zzz' })).toThrow(/not found/);
  });

  it('writes an annotated CSV that keeps the original columns and neutralises formula injection', async () => {
    const snap = await resolveSnapshot(db);
    const index = new RegisterIndex(snap, await loadSnapshotRows(db, snap.id));
    const stock = readStockCsv('Reg No,Product Name\nT3-1200,"=HYPERLINK(""x"")"\n');
    const csv = reportCsv(stock, checkItems(index, stock.inputs, { asOf: '2026-10-15' }), snap.id);
    const [head, line] = csv.trim().split('\n');
    expect(head!.startsWith('Reg No,Product Name,gbo_verdict')).toBe(true);
    expect(line!.startsWith('T3-1200,')).toBe(true);
    expect(csv).not.toMatch(/,=[A-Z]/); // no cell we generate starts with "="
  });
});

describe('verify (tamper evidence)', () => {
  it('passes on untouched data', async () => {
    const r = await verifyAll(db);
    expect(r).toMatchObject({ ok: true, snapshots_checked: 3, issues: [] });
    expect(r.records_checked).toBeGreaterThan(300);
  });

  it('catches an edited record', async () => {
    const d = await newDb();
    await ingestSnapshot(d, raws(0).slice(0, 30), { source: 'x' });
    await d.query(`UPDATE records SET raw = jsonb_set(raw, '{status}', '"Quietly Changed"') WHERE source_id = $1`, [String(idOf(3))]);
    const r = await verifyAll(d);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.kind)).toEqual(['record_hash_mismatch']);
    expect(r.issues[0]!.source_id).toBe(String(idOf(3)));
    await d.close();
  });

  it('catches a swapped, added or removed snapshot membership', async () => {
    const d = await newDb();
    await ingestSnapshot(d, raws(0).slice(0, 30), { source: 'x' });
    const other = (await d.query<{ record_hash: string }>('SELECT record_hash FROM snapshot_records WHERE source_id = $1', [String(idOf(4))])).rows[0]!;
    await d.query('UPDATE snapshot_records SET record_hash = $1 WHERE source_id = $2', [other.record_hash, String(idOf(3))]);
    const swapped = await verifyAll(d);
    expect(swapped.issues.map((i) => i.kind)).toEqual(['snapshot_hash_mismatch']);

    await d.query('DELETE FROM snapshot_records WHERE source_id = $1', [String(idOf(5))]);
    const removed = await verifyAll(d);
    expect(removed.issues.map((i) => i.kind).sort()).toEqual(['snapshot_count_mismatch', 'snapshot_hash_mismatch']);
    await d.close();
  });
});

describe('renormalise', () => {
  it('rebuilds normalised columns from raw when the normaliser version moves on', async () => {
    await db.query(`UPDATE records SET normaliser_version = 0, ingredients = '{}', status_norm = 'unknown'`);
    const n = await renormalise(db);
    expect(n).toBeGreaterThan(300);
    const row = await getProduct(db, 3, String(idOf(0)));
    expect(row?.ingredients).toEqual(['artemether', 'lumefantrine']);
    expect(row?.status_norm).toBe('active');
    expect(await renormalise(db)).toBe(0);
  });
});
