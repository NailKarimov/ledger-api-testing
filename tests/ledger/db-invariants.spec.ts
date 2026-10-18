import { test, expect, newKey } from '../../src/ledger/fixtures';

/**
 * Database-level checks: invariants over everything this worker's database holds, and the schema
 * constraints that stop bad data even if the service code had a bug (defence in depth).
 */
test.describe('Database invariants', () => {
  test.beforeEach(async ({ ledger }) => {
    // some traffic, so the invariants are checked over real rows
    const a = await ledger.funded('Inv A', '70');
    const b = await ledger.funded('Inv B', '30');
    await ledger.transfer({ from: a.id, to: b.id, amount: '12.34' }, newKey());
    await ledger.transfer({ from: b.id, to: a.id, amount: '0.01' }, newKey());
  });

  test("every stored balance equals the sum of that account's ledger entries", async ({ db }) => {
    const mismatches = await db.rows(
      `SELECT a.id, a.balance, coalesce(sum(e.amount), 0) AS ledger
         FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
        GROUP BY a.id, a.balance HAVING a.balance <> coalesce(sum(e.amount), 0)`,
    );
    expect(mismatches).toEqual([]);
  });

  test('every movement has exactly two entries that sum to zero', async ({ db }) => {
    const broken = await db.rows(
      `SELECT t.id, count(e.id) AS n, coalesce(sum(e.amount), 0) AS total
         FROM transfers t LEFT JOIN ledger_entries e ON e.transfer_id = t.id
        GROUP BY t.id HAVING count(e.id) <> 2 OR coalesce(sum(e.amount), 0) <> 0`,
    );
    expect(broken).toEqual([]);
  });

  test('money is conserved: all balances together equal all deposits', async ({ db }) => {
    const r = await db.one<{ balances: string; deposits: string }>(
      `SELECT (SELECT coalesce(sum(balance), 0) FROM accounts)::text AS balances,
              (SELECT coalesce(sum(amount), 0) FROM transfers WHERE kind = 'deposit')::text AS deposits`,
    );
    expect(r!.balances).toBe(r!.deposits);
  });

  const constraints: [string, string, RegExp][] = [
    [
      'a negative balance',
      "UPDATE accounts SET balance = -1 WHERE owner = 'Inv A'",
      /accounts_balance_check/,
    ],
    [
      'a zero transfer',
      "INSERT INTO transfers (kind, from_account, to_account, amount, currency) SELECT 'transfer', a.id, b.id, 0, 'EUR' FROM accounts a, accounts b WHERE a.owner = 'Inv A' AND b.owner = 'Inv B' LIMIT 1",
      /transfers_amount_check/,
    ],
    [
      'a transfer to the same account',
      "INSERT INTO transfers (kind, from_account, to_account, amount, currency) SELECT 'transfer', id, id, 1, 'EUR' FROM accounts WHERE owner = 'Inv A' LIMIT 1",
      /transfers_check/,
    ],
    [
      'a lower-case currency',
      "INSERT INTO accounts (owner, currency) VALUES ('x', 'eur')",
      /accounts_currency_check/,
    ],
    [
      'an entry for a missing transfer',
      'INSERT INTO ledger_entries (transfer_id, amount) VALUES (gen_random_uuid(), 1)',
      /ledger_entries_transfer_id_fkey/,
    ],
  ];
  for (const [name, sql, constraint] of constraints) {
    test(`the schema itself refuses ${name}`, async ({ db }) => {
      await expect(db.pool.query(sql)).rejects.toThrow();
      const err = await db.pool.query(sql).catch((e: { constraint?: string; message: string }) => e);
      expect(`${(err as { constraint?: string }).constraint ?? ''} ${(err as Error).message}`).toMatch(
        constraint,
      );
    });
  }

  test("migrations ran from scratch in this worker's fresh database", async ({ db }) => {
    const applied = await db.rows<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    expect(applied.map((m) => m.name)).toEqual(['001_init.sql']);
  });
});
