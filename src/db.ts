import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * Minimal database interface. Two implementations run the exact same SQL:
 *  - Postgres via `pg` (production)
 *  - PGlite, a WASM build of Postgres, for zero-setup local use and fast tests
 *
 * Rule for callers: pass dates and arrays as text and cast in SQL (`$1::date`, `$2::text[]`),
 * and cast counts (`count(*)::int`), so both drivers return identical shapes.
 */
export interface Db {
  readonly kind: 'pg' | 'pglite';
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run one or more statements with no parameters (used for migrations). */
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PgDb implements Db {
  readonly kind = 'pg' as const;
  constructor(
    private readonly pool: pg.Pool,
    private readonly client?: pg.PoolClient,
  ) {}

  async query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const target = this.client ?? this.pool;
    const res = await target.query(sql, params as any[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await (this.client ?? this.pool).query(sql);
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.client) return fn(this); // already inside a transaction
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(new PgDb(this.pool, client));
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.client) await this.pool.end();
  }
}

interface PgliteLike {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
}

class PgliteDb implements Db {
  readonly kind = 'pglite' as const;
  constructor(
    private readonly db: PgliteLike,
    private readonly root: PGlite,
    private readonly inTx = false,
  ) {}

  async query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const res = await this.db.query(sql, params as any[]);
    return { rows: res.rows as T[], rowCount: res.affectedRows ?? res.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    return this.root.transaction((t) => fn(new PgliteDb(t as unknown as PgliteLike, this.root, true)));
  }

  async close(): Promise<void> {
    if (!this.inTx) await this.root.close();
  }
}

/**
 * DATABASE_URL forms:
 *   postgres://user:pass@host:5432/db   real Postgres
 *   pglite://./data/greenbook           embedded Postgres persisted in that folder
 *   pglite://memory                     embedded, in-memory (tests)
 */
export async function openDb(url: string): Promise<Db> {
  if (/^postgres(ql)?:\/\//i.test(url)) {
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    return new PgDb(pool);
  }
  const m = /^pglite:\/\/(.*)$/i.exec(url);
  if (m) {
    const target = m[1] ?? '';
    let root: PGlite;
    if (target === '' || target === 'memory') {
      root = new PGlite();
    } else {
      mkdirSync(dirname(target), { recursive: true });
      root = new PGlite(target);
    }
    await root.waitReady;
    return new PgliteDb(root as unknown as PgliteLike, root);
  }
  throw new Error(`Unsupported DATABASE_URL "${url}". Use postgres://... or pglite://<path>.`);
}

/** Postgres array literal from strings, for use with a `$n::text[]` cast. */
export function pgArray(items: readonly string[]): string {
  return `{${items.map((s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

/** Escape LIKE/ILIKE wildcards in user input. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
