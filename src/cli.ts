#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { buildServer } from './api/server.js';
import { RegisterIndex, checkItems, summarise, type CheckResult } from './check/checker.js';
import { readStockCsv, reportCsv, type ColumnMap } from './check/csv.js';
import { VERSION, loadConfig } from './config.js';
import { type Db, openDb } from './db.js';
import { PoliteClient } from './fetch/client.js';
import { DataTablesSource, FileSource, type RecordSource } from './fetch/sources.js';
import { migrate } from './migrate.js';
import { normaliseRecord } from './normalise/index.js';
import { sanitiseFields } from './normalise/sanitise.js';
import { buildQualityReport, injectQuality, renderQualityMarkdown } from './quality/report.js';
import { diffSnapshots, type SnapshotDiff } from './snapshot/diff.js';
import { ingestSnapshot, renormalise } from './snapshot/ingest.js';
import { verifyAll } from './snapshot/verify.js';
import {
  getProduct, listSnapshots, loadSnapshotRows, productHistory, resolveSnapshot, searchProducts,
} from './snapshot/repo.js';
import type { ProductRow, RawRecord } from './types.js';

// `greenbook-open search ... | head` closes the pipe early; that is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
}

const program = new Command();
program
  .name('greenbook-open')
  .description('Open, versioned data and API for the NAFDAC Greenbook. Independent project, not affiliated with NAFDAC.')
  .version(VERSION)
  .option('--db <url>', 'database URL (default: $DATABASE_URL or pglite://./data/greenbook)');

async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const cfg = loadConfig();
  const url = (program.opts<{ db?: string }>().db) ?? cfg.databaseUrl;
  const db = await openDb(url);
  try {
    await migrate(db);
    return await fn(db);
  } finally {
    await db.close();
  }
}

const out = (s: string): void => void process.stdout.write(`${s}\n`);
const err = (s: string): void => void process.stderr.write(`${s}\n`);
const json = (v: unknown): void => out(JSON.stringify(v, null, 2));

function fmtRow(r: ProductRow): string {
  const ing = r.ingredients.join(', ') || '-';
  return [
    r.source_id.padEnd(7), (r.reg_no ?? '-').padEnd(11), (r.status_norm).padEnd(9), (r.expires_on ?? '-').padEnd(10),
    `${r.product_name ?? '-'} | ${ing}${r.strength_text ? ` | ${r.strength_text}` : ''}${r.manufacturer ? ` | ${r.manufacturer}` : ''}`,
  ].join('  ');
}

function printDiff(d: SnapshotDiff, limit: number) {
  out(`Snapshot #${d.from.id} (${d.from.taken_at}) -> #${d.to.id} (${d.to.taken_at})`);
  const s = d.summary;
  out(`  added ${s.added}   removed ${s.removed}   changed ${s.changed}   status changes ${s.status_changed}   newly expired ${s.newly_expired}   unchanged ${s.unchanged}`);
  const section = <T,>(title: string, items: T[], line: (x: T) => string) => {
    if (items.length === 0) return;
    out(`\n${title} (${items.length})`);
    for (const x of items.slice(0, limit)) out(`  ${line(x)}`);
    if (items.length > limit) out(`  ... ${items.length - limit} more (use --json for everything)`);
  };
  section('Newly registered', d.added, fmtRow);
  section('Removed from the register', d.removed, fmtRow);
  section('Status changed', d.status_changes, (c) => `${c.source_id.padEnd(7)} ${(c.reg_no ?? '-').padEnd(11)} ${c.from ?? '-'} -> ${c.to ?? '-'}   ${c.product_name ?? ''}`);
  section('Newly expired by date', d.newly_expired, fmtRow);
  section('Other changes', d.changed.filter((c) => !d.status_changes.some((x) => x.source_id === c.source_id)),
    (c) => `${c.source_id.padEnd(7)} ${(c.reg_no ?? '-').padEnd(11)} ${c.changes.map((x) => x.field).join(', ') || 'raw fields only'}   ${c.product_name ?? ''}`);
}

program
  .command('migrate')
  .description('Create or update the database schema')
  .action(() => withDb(async () => out('Database is up to date.')));

program
  .command('ingest <file>')
  .description('Store a snapshot from a .json, .ndjson or .csv file of Greenbook records')
  .option('--id-field <name>', 'column holding the unique product id')
  .option('--taken-at <iso>', 'when the data was captured (default: now)')
  .option('--allow-partial', 'accept a snapshot smaller than the source reports')
  .option('--force', 'accept a snapshot much smaller than the previous one')
  .option('--json', 'machine-readable output')
  .action((file: string, o: { idField?: string; takenAt?: string; allowPartial?: boolean; force?: boolean; json?: boolean }) =>
    withDb(async (db) => {
      if (!existsSync(file)) throw new Error(`File not found: ${file}`);
      const source = new FileSource(file, o.idField);
      const res = await ingestSnapshot(db, source.records(), {
        source: source.label, takenAt: o.takenAt ? new Date(o.takenAt) : undefined,
        allowPartial: o.allowPartial, force: o.force,
      });
      if (o.json) return json(res);
      out(res.status === 'unchanged'
        ? `No change: identical to snapshot #${res.snapshotId} (${res.recordCount} records). Re-confirmed.`
        : `Snapshot #${res.snapshotId} stored: ${res.recordCount} records, ${res.newRecords} new or changed rows.`);
      out(`Content hash: ${res.contentHash}`);
      if (res.duplicateIds) out(`Warning: ${res.duplicateIds} duplicate product ids in the file (first occurrence kept).`);
    }),
  );

function liveSource(cfg = loadConfig(), maxPages?: number): DataTablesSource {
  const client = new PoliteClient({ userAgent: cfg.userAgent, minDelayMs: cfg.minDelayMs, log: err });
  return new DataTablesSource({ client, baseUrl: cfg.baseUrl, pageSize: cfg.pageSize, maxPages, log: err });
}

program
  .command('probe')
  .description('Fetch ONE small page from the live Greenbook and show how it normalises. Run this before the first fetch.')
  .option('--rows <n>', 'rows to request', '3')
  .action((o: { rows: string }) => {
    const cfg = loadConfig();
    cfg.pageSize = Math.max(1, Math.min(10, Number(o.rows) || 3));
    return withDb(async () => {
      const src = liveSource(cfg, 1);
      let shown = 0;
      for await (const rec of src.records()) {
        const { cleaned } = sanitiseFields(rec.fields);
        out(`--- raw fields (contact fields removed) ---`);
        json(cleaned);
        out(`--- normalised ---`);
        json(normaliseRecord({ sourceId: rec.sourceId, fields: cleaned }));
        shown++;
      }
      out(`\n${shown} row(s) shown. The source reports ${src.expectedTotal ?? 'an unknown number of'} records in total.`);
      out('If a field you expected is null above, add its real name to ALIASES in src/normalise/index.ts.');
    });
  });

program
  .command('fetch')
  .description('Fetch the whole Greenbook slowly and store it as a new snapshot')
  .option('--allow-partial', 'accept a snapshot smaller than the source reports')
  .option('--force', 'accept a snapshot much smaller than the previous one')
  .option('--max-pages <n>', 'stop after n pages (implies --allow-partial)')
  .action((o: { allowPartial?: boolean; force?: boolean; maxPages?: string }) =>
    withDb(async (db) => {
      const cfg = loadConfig();
      const maxPages = o.maxPages ? Number(o.maxPages) : undefined;
      const src = liveSource(cfg, maxPages);
      err(`Fetching ${cfg.baseUrl} as "${cfg.userAgent}", at least ${cfg.minDelayMs} ms between requests.`);
      const records = await collect<RawRecord>(src.records());
      const res = await ingestSnapshot(db, records, {
        source: src.label, expectedTotal: src.expectedTotal,
        allowPartial: o.allowPartial || maxPages !== undefined, force: o.force,
        notes: { pages: src.pagesFetched },
      });
      out(res.status === 'unchanged'
        ? `No change since snapshot #${res.snapshotId}. Re-confirmed.`
        : `Snapshot #${res.snapshotId} stored: ${res.recordCount} records, ${res.newRecords} new or changed rows.`);
      out(`Content hash: ${res.contentHash}`);
    }),
  );

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const a: T[] = [];
  for await (const x of it) a.push(x);
  return a;
}

program
  .command('snapshots')
  .description('List stored snapshots')
  .option('--json', 'machine-readable output')
  .action((o: { json?: boolean }) =>
    withDb(async (db) => {
      const rows = await listSnapshots(db);
      if (o.json) return json(rows);
      if (rows.length === 0) return out('No snapshots yet.');
      for (const s of rows) {
        out(`#${String(s.id).padEnd(4)} ${s.taken_at}  ${String(s.record_count).padStart(6)} records  ${s.source.padEnd(18)} ${s.content_hash.slice(0, 16)}…  (confirmed ${s.confirm_count}x)`);
      }
    }),
  );

program
  .command('search')
  .description('Search the register by ingredient, manufacturer, ATC code, status or free text')
  .option('-q, --query <text>', 'product name, ingredient or registration number')
  .option('-i, --ingredient <name>', 'ingredient (comma-separate to require several)')
  .option('-m, --manufacturer <name>', 'manufacturer or applicant')
  .option('-a, --atc <code>', 'ATC code or prefix, e.g. P01B')
  .option('-s, --status <status>', 'active, inactive, expired, ...')
  .option('-r, --reg-no <number>', 'registration number')
  .option('--snapshot <ref>', 'latest, a snapshot id, or YYYY-MM-DD', 'latest')
  .option('-n, --limit <n>', 'rows to show', '25')
  .option('--json', 'machine-readable output')
  .action((o: Record<string, string | undefined> & { json?: boolean }) =>
    withDb(async (db) => {
      const snap = await resolveSnapshot(db, o.snapshot);
      const { rows, total } = await searchProducts(
        db, snap.id,
        { q: o.query, ingredient: o.ingredient, manufacturer: o.manufacturer, atc: o.atc, status: o.status, regNo: o.regNo },
        { limit: Number(o.limit ?? 25), offset: 0 },
      );
      if (o.json) return json({ snapshot: snap.id, total, data: rows });
      out(`Snapshot #${snap.id} (${snap.taken_at}): ${total} match${total === 1 ? '' : 'es'}`);
      for (const r of rows) out(fmtRow(r));
      if (total > rows.length) out(`... ${total - rows.length} more (raise --limit or use --json)`);
    }),
  );

program
  .command('show <productId>')
  .description('Show one product, with its raw record and history')
  .option('--snapshot <ref>', 'latest, a snapshot id, or YYYY-MM-DD', 'latest')
  .action((id: string, o: { snapshot: string }) =>
    withDb(async (db) => {
      const snap = await resolveSnapshot(db, o.snapshot);
      const row = await getProduct(db, snap.id, id);
      if (!row) throw new Error(`No product ${id} in snapshot #${snap.id}.`);
      json(row);
      const hist = await productHistory(db, id);
      out(`\nHistory: ${hist.length} distinct version(s)`);
      for (const h of hist) out(`  snapshots #${h.first_snapshot}–#${h.last_snapshot}  first seen ${h.first_seen}  status ${h.record.status ?? '-'}  expires ${h.record.expires_on ?? '-'}`);
    }),
  );

program
  .command('diff <from> [to]')
  .description('What changed between two snapshots (ids, dates or "latest")')
  .option('-n, --limit <n>', 'rows per section', '15')
  .option('--json', 'machine-readable output')
  .action((from: string, to: string | undefined, o: { limit: string; json?: boolean }) =>
    withDb(async (db) => {
      const d = await diffSnapshots(db, from, to ?? 'latest');
      if (o.json) return json(d);
      printDiff(d, Number(o.limit));
    }),
  );

program
  .command('check <stock.csv>')
  .description('Flag products in a stock list that are unregistered, inactive, expired or mismatched')
  .option('--reg-col <header>', 'column holding the registration number')
  .option('--name-col <header>', 'column holding the product name')
  .option('--ingredient-col <header>', 'column holding the active ingredient')
  .option('--strength-col <header>', 'column holding the strength')
  .option('--manufacturer-col <header>', 'column holding the manufacturer')
  .option('--snapshot <ref>', 'latest, a snapshot id, or YYYY-MM-DD', 'latest')
  .option('--as-of <date>', 'evaluate expiry as of this date (YYYY-MM-DD)')
  .option('-o, --out <file>', 'write the annotated CSV here')
  .option('--json', 'machine-readable output')
  .option('--fail-on <level>', 'exit code 1 on "fail" (default), "warn", or "never"', 'fail')
  .action((file: string, o: Record<string, string | undefined> & { json?: boolean }) =>
    withDb(async (db) => {
      if (!existsSync(file)) throw new Error(`File not found: ${file}`);
      const overrides: ColumnMap = {
        regNo: o.regCol, productName: o.nameCol, ingredient: o.ingredientCol,
        strength: o.strengthCol, manufacturer: o.manufacturerCol,
      };
      for (const k of Object.keys(overrides) as (keyof ColumnMap)[]) if (!overrides[k]) delete overrides[k];
      const stock = readStockCsv(readFileSync(file, 'utf8'), overrides);

      const snap = await resolveSnapshot(db, o.snapshot);
      const index = new RegisterIndex(snap, await loadSnapshotRows(db, snap.id));
      const asOf = o.asOf ?? new Date().toISOString().slice(0, 10);
      const results = checkItems(index, stock.inputs, { asOf });
      const summary = summarise(results);

      if (o.out) {
        writeFileSync(o.out, reportCsv(stock, results, snap.id));
        err(`Annotated CSV written to ${o.out}`);
      }
      if (o.json) {
        json({ snapshot: { id: snap.id, taken_at: snap.taken_at, content_hash: snap.content_hash }, summary, results });
      } else {
        out(`Checked ${summary.total} rows against snapshot #${snap.id} (${snap.taken_at}), expiry as of ${asOf}.`);
        out(`  pass ${summary.by_severity.pass}   warn ${summary.by_severity.warn}   FAIL ${summary.by_severity.fail}`);
        out(`  ${Object.entries(summary.by_verdict).map(([k, v]) => `${k} ${v}`).join('   ')}\n`);
        const show = (r: CheckResult) => {
          const m = r.match;
          out(`  row ${String(r.row).padEnd(4)} ${r.verdict.toUpperCase().padEnd(12)} ${(r.input.regNo ?? '-').padEnd(11)} ${(r.input.productName ?? '-').slice(0, 34).padEnd(34)} ${r.reasons.join('; ')}${m ? `  -> ${m.reg_no} ${m.product_name}` : ''}`);
        };
        for (const r of results.filter((x) => x.severity === 'fail')) show(r);
        for (const r of results.filter((x) => x.severity === 'warn')) show(r);
      }
      const level = o.failOn ?? 'fail';
      if ((level === 'fail' && summary.by_severity.fail > 0) || (level === 'warn' && summary.by_severity.fail + summary.by_severity.warn > 0)) {
        process.exitCode = 1;
      }
    }),
  );

program
  .command('quality')
  .description('Data-quality report for a snapshot')
  .option('--snapshot <ref>', 'latest, a snapshot id, or YYYY-MM-DD', 'latest')
  .option('--as-of <date>', 'evaluate expiry as of this date')
  .option('--json', 'machine-readable output')
  .option('--write-readme [path]', 'inject the report into the README between the QUALITY markers')
  .action((o: { snapshot: string; asOf?: string; json?: boolean; writeReadme?: string | boolean }) =>
    withDb(async (db) => {
      const r = await buildQualityReport(db, o.snapshot, o.asOf);
      if (o.json) return json(r);
      const md = renderQualityMarkdown(r);
      if (o.writeReadme) {
        const path = typeof o.writeReadme === 'string' ? o.writeReadme : 'README.md';
        writeFileSync(path, injectQuality(readFileSync(path, 'utf8'), md));
        return out(`Quality report written into ${path}`);
      }
      out(md);
    }),
  );

program
  .command('verify')
  .description('Recompute every record and snapshot hash from stored data and report any mismatch')
  .option('--json', 'machine-readable output')
  .action((o: { json?: boolean }) =>
    withDb(async (db) => {
      const r = await verifyAll(db);
      if (o.json) json(r);
      else if (r.ok) out(`OK: ${r.snapshots_checked} snapshot(s) and ${r.records_checked} record(s) match their recorded hashes.`);
      else {
        out(`FAILED: ${r.issues.length} problem(s) found.`);
        for (const i of r.issues.slice(0, 20)) out(`  ${i.kind}: ${i.detail}`);
      }
      if (!r.ok) process.exitCode = 1;
    }),
  );

program
  .command('renormalise')
  .description('Rebuild normalised columns from stored raw records after a normaliser change')
  .action(() => withDb(async (db) => out(`Renormalised ${await renormalise(db)} record(s).`)));

program
  .command('serve')
  .description('Start the read-only REST API')
  .option('-p, --port <n>', 'port')
  .option('--host <host>', 'host')
  .action(async (o: { port?: string; host?: string }) => {
    const cfg = loadConfig();
    const db = await openDb((program.opts<{ db?: string }>().db) ?? cfg.databaseUrl);
    await migrate(db);
    const app = buildServer(db, { logger: true });
    const port = o.port ? Number(o.port) : cfg.port;
    const host = o.host ?? cfg.host;
    const stop = async () => { await app.close(); await db.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await app.listen({ port, host });
    err(`Greenbook Open API on http://${host}:${port}  (try /v1/products?ingredient=artemether)`);
  });

program.parseAsync().catch((e: unknown) => {
  err(`Error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
