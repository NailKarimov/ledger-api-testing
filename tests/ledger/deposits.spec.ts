import { test, expect } from '../../src/ledger/fixtures';

test.describe('Deposits', () => {
  test('a deposit raises the balance and writes a balanced pair of ledger entries', async ({
    ledger,
    db,
  }) => {
    const acc = (await ledger.createAccount({ owner: 'Alice', currency: 'EUR' })).body;
    const res = await ledger.deposit(acc.id, '100.50');

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'deposit',
      from: null,
      to: acc.id,
      amount: '100.50',
      currency: 'EUR',
    });
    expect(await db.balance(acc.id)).toBe('100.50');
    const entries = await db.rows<{ account_id: string | null; amount: string }>(
      'SELECT account_id, amount FROM ledger_entries WHERE transfer_id = $1 ORDER BY amount DESC',
      [res.body.id],
    );
    // money comes from outside the system (account_id NULL), and the pair sums to zero
    expect(entries).toEqual([
      { account_id: acc.id, amount: '100.50' },
      { account_id: null, amount: '-100.50' },
    ]);
  });

  // Boundary values of the amount rule: 0.01 … 1 000 000.00, at most 2 decimal places, as a string.
  const accepted = ['0.01', '1', '999999.99', '1000000', '1000000.00'];
  const rejected: [string, unknown][] = [
    ['zero', '0'],
    ['0.00', '0.00'],
    ['negative', '-5'],
    ['three decimals', '0.001'],
    ['just above the maximum', '1000000.01'],
    ['a number, not a string', 10],
    ['scientific notation', '1e3'],
    ['empty', ''],
  ];
  for (const amount of accepted) {
    test(`amount ${amount} is accepted (boundary)`, async ({ ledger, db }) => {
      const acc = (await ledger.createAccount({ owner: 'B', currency: 'EUR' })).body;
      expect((await ledger.deposit(acc.id, amount)).status).toBe(201);
      expect(await db.balance(acc.id)).toBe(Number(amount).toFixed(2));
    });
  }
  for (const [name, amount] of rejected) {
    test(`amount rejected: ${name} → 400, balance and ledger untouched`, async ({ ledger, db }) => {
      const acc = (await ledger.createAccount({ owner: 'C', currency: 'EUR' })).body;
      const res = await ledger.deposit(acc.id, amount);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_amount');
      expect(await db.balance(acc.id)).toBe('0.00');
      await expect(db).toHaveCount(0);
    });
  }

  test('deposit to an unknown account → 404 and no orphan rows', async ({ ledger, db }) => {
    const before = await db.count('SELECT 1 FROM transfers');
    expect((await ledger.deposit(crypto.randomUUID(), '10')).status).toBe(404);
    await expect(db).toHaveCount(before);
  });
});
