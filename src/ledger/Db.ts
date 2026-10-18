import type pg from 'pg';

/** Direct, read-mostly access to the Ledger database for assertions the API cannot make. */
export class Db {
  constructor(readonly pool: pg.Pool) {}

  async rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows as T[];
  }

  async one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.rows<T>(sql, params))[0];
  }

  async count(sql: string, params: unknown[] = []): Promise<number> {
    const row = await this.one<{ n: string }>(`SELECT count(*)::text AS n FROM (${sql}) q`, params);
    return Number(row?.n ?? 0);
  }

  /** Balance column of an account, as stored. */
  async balance(accountId: string): Promise<string | undefined> {
    return (await this.one<{ balance: string }>('SELECT balance FROM accounts WHERE id = $1', [accountId]))
      ?.balance;
  }

  /** Balance recomputed from the ledger: the sum of the account's entries. */
  async ledgerBalance(accountId: string): Promise<string> {
    const r = await this.one<{ s: string }>(
      'SELECT coalesce(sum(amount), 0)::numeric(14,2)::text AS s FROM ledger_entries WHERE account_id = $1',
      [accountId],
    );
    return r!.s;
  }
}
