import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

/** Directory with the *.sql migrations, relative to the repository root. */
export const MIGRATIONS_DIR = path.resolve('services/ledger-api/migrations');

/** Applies migrations/*.sql in name order, once each (tracked in schema_migrations). */
export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())',
  );
  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const done: string[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (applied.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(path.join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      done.push(file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return done;
}

export function createPool(connectionString: string): pg.Pool {
  // NUMERIC comes back as a string by default, which is what we want for money (no float rounding).
  return new pg.Pool({ connectionString, max: 10 });
}
