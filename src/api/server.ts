import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RegisterIndex, checkItems, summarise, type CheckInput } from '../check/checker.js';
import { InputError, readStockCsv } from '../check/csv.js';
import { VERSION } from '../config.js';
import type { Db } from '../db.js';
import { buildQualityReport } from '../quality/report.js';
import { diffSnapshots } from '../snapshot/diff.js';
import {
  NotFoundError, getByRegNo, getProduct, listSnapshots, loadSnapshotRows, productHistory,
  resolveSnapshot, searchProducts,
} from '../snapshot/repo.js';

const MAX_LIMIT = 200;
const MAX_CHECK_ITEMS = 5000;

const SearchQuery = z.object({
  q: z.string().optional(),
  ingredient: z.string().optional(),
  manufacturer: z.string().optional(),
  atc: z.string().optional(),
  status: z.string().optional(),
  reg_no: z.string().optional(),
  dosage_form: z.string().optional(),
  category: z.string().optional(),
  snapshot: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const CheckBody = z.object({
  snapshot: z.string().optional(),
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  items: z
    .array(
      z.object({
        reg_no: z.string().optional(),
        product_name: z.string().optional(),
        ingredient: z.string().optional(),
        strength: z.string().optional(),
        manufacturer: z.string().optional(),
        dosage_form: z.string().optional(),
      }),
    )
    .min(1)
    .max(MAX_CHECK_ITEMS),
});

export interface ServerOptions {
  /** Defaults to true in production use; tests turn it off. */
  logger?: boolean;
}

export function buildServer(db: Db, opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });

  app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: 'bad_request', message: err.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; ') });
    }
    if (err instanceof NotFoundError) return reply.code(404).send({ error: 'not_found', message: err.message });
    if (err instanceof InputError) return reply.code(400).send({ error: 'bad_request', message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Internal error' });
  });

  // The register is public data and the API is read-only, so allow browser use from anywhere.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
  });

  app.get('/health', async () => ({ status: 'ok', version: VERSION }));

  app.get('/v1/snapshots', async () => ({ data: await listSnapshots(db) }));

  app.get('/v1/products', async (req) => {
    const p = SearchQuery.parse(req.query);
    const snap = await resolveSnapshot(db, p.snapshot);
    const { rows, total } = await searchProducts(
      db,
      snap.id,
      {
        q: p.q, ingredient: p.ingredient, manufacturer: p.manufacturer, atc: p.atc, status: p.status,
        regNo: p.reg_no, dosageForm: p.dosage_form, category: p.category,
      },
      { limit: p.limit, offset: p.offset },
    );
    return { snapshot: { id: snap.id, taken_at: snap.taken_at, content_hash: snap.content_hash }, total, limit: p.limit, offset: p.offset, data: rows };
  });

  app.get<{ Params: { id: string } }>('/v1/products/:id', async (req) => {
    const q = z.object({ snapshot: z.string().optional(), include_raw: z.enum(['true', 'false']).optional() }).parse(req.query);
    const snap = await resolveSnapshot(db, q.snapshot);
    const row = await getProduct(db, snap.id, req.params.id);
    if (!row) throw new NotFoundError(`No product with id ${req.params.id} in snapshot ${snap.id}.`);
    const { raw, ...product } = row;
    return { snapshot: { id: snap.id, taken_at: snap.taken_at }, data: q.include_raw === 'true' ? { ...product, raw } : product };
  });

  app.get<{ Params: { id: string } }>('/v1/products/:id/history', async (req) => {
    const history = await productHistory(db, req.params.id);
    if (history.length === 0) throw new NotFoundError(`Product ${req.params.id} has never appeared in a snapshot.`);
    return { data: history };
  });

  // Several products can share one registration number, so this returns a list.
  app.get<{ Params: { regNo: string } }>('/v1/registrations/:regNo', async (req) => {
    const q = z.object({ snapshot: z.string().optional() }).parse(req.query);
    const snap = await resolveSnapshot(db, q.snapshot);
    const rows = await getByRegNo(db, snap.id, req.params.regNo);
    if (rows.length === 0) throw new NotFoundError(`Registration number ${req.params.regNo} is not on the register in snapshot ${snap.id}.`);
    return { snapshot: { id: snap.id, taken_at: snap.taken_at }, shared: rows.length > 1, data: rows };
  });

  app.get('/v1/diff', async (req) => {
    const q = z.object({ from: z.string(), to: z.string().default('latest') }).parse(req.query);
    return diffSnapshots(db, q.from, q.to);
  });

  app.get('/v1/quality', async (req) => {
    const q = z.object({ snapshot: z.string().optional() }).parse(req.query);
    return buildQualityReport(db, q.snapshot);
  });

  // Bulk check: JSON {items:[...]} or a raw CSV body (Content-Type: text/csv).
  app.post('/v1/check', async (req) => {
    const ctype = String(req.headers['content-type'] ?? '');
    let snapshotRef: string | undefined;
    let asOf: string | undefined;
    let inputs: CheckInput[];

    if (ctype.startsWith('text/csv')) {
      const q = z.object({ snapshot: z.string().optional(), as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
      snapshotRef = q.snapshot;
      asOf = q.as_of;
      inputs = readStockCsv(String(req.body ?? '')).inputs;
      if (inputs.length > MAX_CHECK_ITEMS) throw Object.assign(new Error(`At most ${MAX_CHECK_ITEMS} rows per request.`), { statusCode: 413 });
    } else {
      const b = CheckBody.parse(req.body);
      snapshotRef = b.snapshot;
      asOf = b.as_of;
      inputs = b.items.map((i, n) => ({
        row: n + 1, regNo: i.reg_no, productName: i.product_name, ingredient: i.ingredient,
        strength: i.strength, manufacturer: i.manufacturer, dosageForm: i.dosage_form,
      }));
    }

    const snap = await resolveSnapshot(db, snapshotRef);
    const index = new RegisterIndex(snap, await loadSnapshotRows(db, snap.id));
    const results = checkItems(index, inputs, { asOf: asOf ?? new Date().toISOString().slice(0, 10) });
    return { snapshot: { id: snap.id, taken_at: snap.taken_at, content_hash: snap.content_hash }, summary: summarise(results), results };
  });

  return app;
}
