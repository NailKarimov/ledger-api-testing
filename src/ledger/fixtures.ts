import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { test as base, expect } from '../auth/fixtures';
import { ApiClient } from '../api/ApiClient';
import { env } from '../../config/env';
import { buildApp, type AuthConfig } from '../../services/ledger-api/src/app.ts';
import type { AuthServer } from '../../services/auth-server/src/app.ts';
import { TEST_SECRETS, fetchServiceToken, fetchUserToken } from '../auth/oauth';
import { createPool, migrate } from '../../services/ledger-api/src/db.ts';
import { LedgerClient } from './LedgerClient';
import { Db } from './Db';

export type Tokens = { alice: string; bob: string; cashier: string; reporting: string };

type LedgerEnv =
  | {
      ok: true;
      baseUrl: string;
      pool: pg.Pool;
      databaseUrl: string;
      image: string;
      migrations: string[];
      tokens: Tokens;
    }
  | { ok: false; reason: string };

/** The resource-server settings that trust a given authorization server. */
export const trust = (auth: AuthServer, overrides: Partial<AuthConfig> = {}): AuthConfig => ({
  issuer: auth.issuer,
  audience: 'ledger-api',
  jwksUrl: `${auth.issuer}/.well-known/jwks.json`,
  ...overrides,
});

/** Another Ledger API on the same database, trusting another auth server (for key rotation and the like). */
export async function startLedger(pool: pg.Pool, auth: AuthConfig) {
  const app = buildApp(pool, auth);
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  return { baseUrl, close: () => app.close() };
}

export async function tokensFrom(issuer: string): Promise<Tokens> {
  return {
    alice: await fetchUserToken(issuer, 'alice'),
    bob: await fetchUserToken(issuer, 'bob'),
    cashier: await fetchServiceToken(issuer, 'cashier-service', TEST_SECRETS['cashier-service']),
    reporting: await fetchServiceToken(issuer, 'reporting', TEST_SECRETS.reporting),
  };
}

/**
 * One PostgreSQL per Playwright worker, started by Testcontainers, migrated from scratch, with the
 * Ledger API listening on a random port in the same process. Workers never share a database, so the
 * tests can assert exact counts and balances. Without Docker the tests are skipped locally (failed in
 * CI); LEDGER_DATABASE_URL (an admin URL) uses an existing server instead, with a database per worker.
 */
export const test = base.extend<
  { ledger: LedgerClient; db: Db; tokens: Tokens; ledgerPool: pg.Pool },
  { ledgerEnv: LedgerEnv }
>({
  ledgerEnv: [
    async ({ authEnv }, use, workerInfo) => {
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
        app = buildApp(pool, trust(authEnv));
        const address = await app.listen({ port: 0, host: '127.0.0.1' });
        const tokens = await tokensFrom(authEnv.issuer);
        await use({ ok: true, baseUrl: address, pool, databaseUrl, image, migrations, tokens });
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
    await use(
      new LedgerClient(
        new ApiClient(request),
        ledgerEnv.baseUrl,
        ledgerEnv.tokens.alice,
        ledgerEnv.tokens.cashier,
      ),
    );
  },
  tokens: async ({ ledgerEnv }, use) => {
    if (!ledgerEnv.ok) {
      if (env.requireStack) throw new Error(ledgerEnv.reason);
      test.skip(true, ledgerEnv.reason);
      return;
    }
    await use(ledgerEnv.tokens);
  },
  ledgerPool: async ({ ledgerEnv }, use) => {
    if (!ledgerEnv.ok) {
      if (env.requireStack) throw new Error(ledgerEnv.reason);
      test.skip(true, ledgerEnv.reason);
      return;
    }
    await use(ledgerEnv.pool);
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
