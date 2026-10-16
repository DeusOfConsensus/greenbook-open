import pg from 'pg';
import { buildFixtures, type FixtureSet } from '../scripts/make-fixtures.js';
import { type Db, openDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { ingestSnapshot } from '../src/snapshot/ingest.js';

/**
 * A fresh, empty, migrated database for one test file or case.
 *
 * Default: in-memory PGlite. Set TEST_DATABASE_URL (a postgres:// URL with rights to
 * CREATE DATABASE) to run the very same tests against real Postgres through the `pg`
 * driver instead; each call then gets its own throwaway database, dropped on close.
 */
export async function newDb(): Promise<Db> {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) {
    const db = await openDb('pglite://memory');
    await migrate(db);
    return db;
  }
  const name = `gbo_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query(`CREATE DATABASE ${name}`);
  const url = new URL(admin);
  url.pathname = `/${name}`;
  const inner = await openDb(url.toString());
  await migrate(inner);

  const wrapped: Db = {
    kind: inner.kind,
    query: (sql, params) => inner.query(sql, params),
    exec: (sql) => inner.exec(sql),
    tx: (fn) => inner.tx(fn),
    close: async () => {
      await inner.close();
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await client.end();
    },
  };
  return wrapped;
}

/** A migrated database with the three synthetic snapshots loaded. */
export async function seededDb(): Promise<{ db: Db; fixtures: FixtureSet }> {
  const db = await newDb();
  const fixtures = buildFixtures();
  for (const s of fixtures.snapshots) {
    await ingestSnapshot(
      db,
      s.records.map((r) => ({ sourceId: String(r.productId), fields: r })),
      { source: `fixture:${s.name}`, takenAt: new Date(s.takenAt) },
    );
  }
  return { db, fixtures };
}

export const idOf = (i: number) => 1000 + i + Math.floor(i / 7);
