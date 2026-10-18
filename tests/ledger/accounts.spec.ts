import { test, expect } from '../../src/ledger/fixtures';

/** Every API answer is checked against what actually landed in PostgreSQL. */
test.describe('Accounts', () => {
  test(
    'a new account is stored with balance 0.00 and the trimmed owner',
    { tag: '@smoke' },
    async ({ ledger, db }) => {
      const res = await ledger.createAccount({ owner: '  Alice  ', currency: 'EUR' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ owner: 'Alice', currency: 'EUR', balance: '0.00' });
      const row = await db.one('SELECT owner, currency, balance FROM accounts WHERE id = $1', [res.body.id]);
      expect(row).toEqual({ owner: 'Alice', currency: 'EUR', balance: '0.00' });
    },
  );

  test('GET returns exactly what is stored', async ({ ledger, db }) => {
    const created = (await ledger.createAccount({ owner: 'Bob', currency: 'USD' })).body;
    const res = await ledger.getAccount(created.id);

    expect(res.status).toBe(200);
    const row = await db.one<{ created_at: Date }>('SELECT created_at FROM accounts WHERE id = $1', [
      created.id,
    ]);
    expect(res.body).toEqual({ ...created });
    expect(new Date(res.body.createdAt).getTime()).toBe(row!.created_at.getTime());
  });

  const invalid: [string, Record<string, unknown>, string][] = [
    ['no owner', { currency: 'EUR' }, 'invalid_owner'],
    ['blank owner', { owner: '   ', currency: 'EUR' }, 'invalid_owner'],
    ['owner of 101 characters (boundary)', { owner: 'x'.repeat(101), currency: 'EUR' }, 'invalid_owner'],
    ['lower-case currency', { owner: 'A', currency: 'eur' }, 'invalid_currency'],
    ['4-letter currency', { owner: 'A', currency: 'EURO' }, 'invalid_currency'],
    ['currency as a number', { owner: 'A', currency: 978 }, 'invalid_currency'],
  ];
  for (const [name, body, error] of invalid) {
    test(`rejected: ${name} → 400 ${error}, nothing stored`, async ({ ledger, db }) => {
      const before = await db.count('SELECT 1 FROM accounts');
      const res = await ledger.createAccount(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(error);
      await expect(db).toHaveCount(before);
    });
  }

  test('owner of exactly 100 characters is accepted (boundary)', async ({ ledger }) => {
    expect((await ledger.createAccount({ owner: 'x'.repeat(100), currency: 'EUR' })).status).toBe(201);
  });

  test('unknown id → 404, malformed id → 400', async ({ ledger }) => {
    expect((await ledger.getAccount(crypto.randomUUID())).status).toBe(404);
    expect((await ledger.getAccount('not-a-uuid')).status).toBe(400);
  });
});
