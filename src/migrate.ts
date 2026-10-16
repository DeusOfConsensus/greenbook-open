import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

// Works from both src/ (tsx) and dist/ (compiled): migrations/ sits one level above either.
const DEFAULT_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Apply any unapplied migrations in filename order. Returns the names applied. */
export async function migrate(db: Db, dir: string = DEFAULT_DIR): Promise<string[]> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const done = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(done.rows.map((r) => r.name));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(`${dir}${file}`, 'utf8');
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    ran.push(file);
  }
  return ran;
}
