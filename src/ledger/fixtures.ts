import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { test as base, expect } from '../fixtures';
import { ApiClient } from '../api/ApiClient';
import { env } from '../../config/env';
import { buildApp } from '../../services/ledger-api/src/app.ts';
import { createPool, migrate } from '../../services/ledger-api/src/db.ts';
import { LedgerClient } from './LedgerClient';
import { Db } from './Db';

type LedgerEnv =
  | { ok: true; baseUrl: string; pool: pg.Pool; databaseUrl: string; image: string; migrations: string[] }
  | { ok: false; reason: string };

/**
 * One PostgreSQL per Playwright worker, started by Testcontainers, migrated from scratch, with the
 * Ledger API listening on a random port in the same process. Workers never share a database, so the
 * tests can assert exact counts and balances. Without Docker the tests are skipped locally (failed in
 * CI); LEDGER_DATABASE_URL (an admin URL) uses an existing server instead, with a database per worker.
 */
export const test = base.extend<{ ledger: LedgerClient; db: Db }, { ledgerEnv: LedgerEnv }>({
  ledgerEnv: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      let container: StartedPostgreSqlContainer | undefined;
      let admin: pg.Pool | undefined;
      let app: FastifyInstance | undefined;
      let pool: pg.Pool | undefined;
      let databaseUrl: string;
      const image = 'postgres:16-alpine';
      try {
        if (process.env.LEDGER_DATABASE_URL) {
          const name = `ledger_w${workerInfo.workerIndex}_${Date.now()}`;
          admin = new pg.Pool({ connectionString: process.env.LEDGER_DATABASE_URL, max: 1 });
          await admin.query(`CREATE DATABASE ${name}`);
          const u = new URL(process.env.LEDGER_DATABASE_URL);
          u.pathname = `/${name}`;
          databaseUrl = u.toString();
        } else {
          container = await new PostgreSqlContainer(image).withDatabase('ledger').start();
          databaseUrl = container.getConnectionUri();
        }
        pool = createPool(databaseUrl);
        const migrations = await migrate(pool);
        app = buildApp(pool);
        const address = await app.listen({ port: 0, host: '127.0.0.1' });
        await use({ ok: true, baseUrl: address, pool, databaseUrl, image, migrations });
      } catch (error) {
        if (pool || app) throw error; // started but failed later: a real error
        await use({
          ok: false,
          reason: `No PostgreSQL for the Ledger API (Docker not available?): ${String(error).slice(0, 200)}`,
        });
      } finally {
        await app?.close();
        await pool?.end();
        await admin?.end();
        await container?.stop();
      }
    },
    { scope: 'worker', timeout: 180_000 },
  ],
  ledger: async ({ ledgerEnv, request }, use) => {
    if (!ledgerEnv.ok) {
      if (env.requireStack) throw new Error(ledgerEnv.reason);
      test.skip(true, ledgerEnv.reason);
      return;
    }
    await use(new LedgerClient(new ApiClient(request), ledgerEnv.baseUrl));
  },
  db: async ({ ledgerEnv }, use) => {
    if (!ledgerEnv.ok) {
      if (env.requireStack) throw new Error(ledgerEnv.reason);
      test.skip(true, ledgerEnv.reason);
      return;
    }
    await use(new Db(ledgerEnv.pool));
  },
});

export { expect };
export { newKey } from './LedgerClient';
