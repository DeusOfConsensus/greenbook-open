import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import type { Db } from '../src/db.js';
import { idOf, seededDb } from './helpers.js';
import type { FixtureSet } from '../scripts/make-fixtures.js';

let app: FastifyInstance;
let db: Db;
let fx: FixtureSet;
beforeAll(async () => {
  const s = await seededDb();
  fx = s.fixtures;
  db = s.db;
  app = buildServer(s.db);
  await app.ready();
}, 60_000);
afterAll(async () => {
  await app.close();
  await db.close();
});

const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as any, headers: res.headers };
};

describe('REST API', () => {
  it('health and snapshots', async () => {
    expect((await get('/health')).body.status).toBe('ok');
    const s = await get('/v1/snapshots');
    expect(s.body.data).toHaveLength(3);
    expect(s.body.data[2]).toMatchObject({ id: 3, record_count: 310 });
    expect(s.headers['access-control-allow-origin']).toBe('*');
  });

  it('searches by ingredient, ATC and manufacturer, with paging metadata', async () => {
    const r = await get('/v1/products?ingredient=artemether,lumefantrine&limit=5');
    expect(r.status).toBe(200);
    expect(r.body.total).toBeGreaterThan(5);
    expect(r.body.data).toHaveLength(5);
    expect(r.body.snapshot.id).toBe(3);
    const atc = await get('/v1/products?atc=P01B&limit=200');
    expect(atc.body.data.every((p: any) => p.atc_codes.some((c: string) => c.startsWith('P01B')))).toBe(true);
    const mfr = await get('/v1/products?manufacturer=testa%20healthcare&limit=10');
    expect(mfr.body.total).toBeGreaterThan(0);
  });

  it('serves point-in-time queries', async () => {
    const early = await get('/v1/products?snapshot=2026-09-15&limit=1');
    expect(early.body.snapshot.id).toBe(1);
    expect(early.body.total).toBe(300);
  });

  it('serves one product, optionally with its raw record, and its history', async () => {
    const p = await get(`/v1/products/${idOf(0)}`);
    expect(p.body.data.reg_no).toBe('T1-1000');
    expect(p.body.data.raw).toBeUndefined();
    const withRaw = await get(`/v1/products/${idOf(0)}?include_raw=true`);
    expect(withRaw.body.data.raw.registrationNumber).toBe('T1-1000');
    const h = await get(`/v1/products/${idOf(21)}/history`);
    expect(h.body.data).toHaveLength(3);
  });

  it('serves registration lookups and flags shared numbers', async () => {
    const shared = await get('/v1/registrations/t2%201100'); // sloppy case and spacing still match
    expect(shared.body.shared).toBe(true);
    expect(shared.body.data).toHaveLength(2);
    const single = await get('/v1/registrations/T1-1000');
    expect(single.body.shared).toBe(false);
  });

  it('serves diffs and the quality report', async () => {
    const d = await get('/v1/diff?from=1&to=2');
    expect(d.body.summary).toMatchObject({ added: 10, removed: 3, status_changed: 5 });
    const q = await get('/v1/quality?snapshot=1');
    expect(q.body.reg_no.shared_numbers).toBe(5);
  });

  it('checks a JSON list', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/check',
      payload: { as_of: '2026-10-15', items: [{ reg_no: 'T3-1200', product_name: 'x' }, { reg_no: 'T9-9999' }] },
    });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.summary.total).toBe(2);
    expect(b.results[1]).toMatchObject({ verdict: 'unregistered', severity: 'fail' });
  });

  it('checks a raw CSV body and matches the expected verdicts', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/check?as_of=2026-10-15', headers: { 'content-type': 'text/csv' }, payload: fx.stock.csv,
    });
    expect(res.statusCode).toBe(200);
    for (const r of res.json().results) expect(r.verdict).toBe(fx.stock.expected[r.row]!.verdict);
  });

  it('returns clean errors', async () => {
    expect((await get('/v1/products/999999')).status).toBe(404);
    expect((await get('/v1/registrations/ZZ-0000')).status).toBe(404);
    expect((await get('/v1/products/999999/history')).status).toBe(404);
    expect((await get('/v1/products?snapshot=1999-01-01')).status).toBe(404);
    const bad = await get('/v1/products?limit=100000');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_request');
    expect((await get('/v1/diff')).status).toBe(400);
    const empty = await app.inject({ method: 'POST', url: '/v1/check', payload: { items: [] } });
    expect(empty.statusCode).toBe(400);
  });

  it('treats an unusable CSV as the caller\'s error (400), with a message that says what to fix', async () => {
    const post = (payload: string) =>
      app.inject({ method: 'POST', url: '/v1/check', headers: { 'content-type': 'text/csv' }, payload });
    const noCols = await post('foo,bar\n1,2\n');
    expect(noCols.statusCode).toBe(400);
    expect(noCols.json().message).toMatch(/registration-number or product-name column/);
    expect((await post('')).statusCode).toBe(400);
    expect((await post('a,b\n"unclosed,2\n')).statusCode).toBe(400);
  });
});
