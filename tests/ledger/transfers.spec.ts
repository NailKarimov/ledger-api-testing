import { test, expect, newKey } from '../../src/ledger/fixtures';

test.describe('Transfers', () => {
  test(
    'a transfer moves the money, stores one row and two entries that sum to zero',
    { tag: '@smoke' },
    async ({ ledger, db }) => {
      const alice = await ledger.funded('Alice', '100.00');
      const bob = await ledger.funded('Bob', '0');
      const res = await ledger.transfer({ from: alice.id, to: bob.id, amount: '30.50' }, newKey());

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ kind: 'transfer', from: alice.id, to: bob.id, amount: '30.50' });
      expect(await db.balance(alice.id)).toBe('69.50');
      expect(await db.balance(bob.id)).toBe('30.50');
      const entries = await db.rows<{ account_id: string; amount: string }>(
        'SELECT account_id, amount FROM ledger_entries WHERE transfer_id = $1 ORDER BY amount',
        [res.body.id],
      );
      expect(entries).toEqual([
        { account_id: alice.id, amount: '-30.50' },
        { account_id: bob.id, amount: '30.50' },
      ]);
    },
  );

  test('the whole balance can be sent (boundary: exactly zero left)', async ({ ledger, db }) => {
    const alice = await ledger.funded('Alice', '25.00');
    const bob = await ledger.funded('Bob', '0');

    expect((await ledger.transfer({ from: alice.id, to: bob.id, amount: '25.00' }, newKey())).status).toBe(
      201,
    );
    expect(await db.balance(alice.id)).toBe('0.00');
  });

  test('one cent more than the balance → 422 and the database is unchanged (atomicity)', async ({
    ledger,
    db,
  }) => {
    const alice = await ledger.funded('Alice', '25.00');
    const bob = await ledger.funded('Bob', '0');
    const transfersBefore = await db.count('SELECT 1 FROM transfers');

    const res = await ledger.transfer({ from: alice.id, to: bob.id, amount: '25.01' }, newKey());

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_funds');
    expect(await db.balance(alice.id)).toBe('25.00');
    expect(await db.balance(bob.id)).toBe('0.00');
    await expect(db).toHaveCount(transfersBefore);
  });

  test('same account → 400; unknown account → 404; nothing stored', async ({ ledger, db }) => {
    const alice = await ledger.funded('Alice', '10');
    const before = await db.count('SELECT 1 FROM transfers');

    const same = await ledger.transfer({ from: alice.id, to: alice.id, amount: '1' }, newKey());
    const unknown = await ledger.transfer({ from: alice.id, to: crypto.randomUUID(), amount: '1' }, newKey());

    expect([same.status, same.body.error]).toEqual([400, 'same_account']);
    expect([unknown.status, unknown.body.error]).toEqual([404, 'not_found']);
    await expect(db).toHaveCount(before);
    expect(await db.balance(alice.id)).toBe('10.00');
  });

  test('different currencies → 409 currency_mismatch', async ({ ledger, db }) => {
    const eur = await ledger.funded('Alice', '10', 'EUR');
    const usd = await ledger.funded('Bob', '0', 'USD');

    const res = await ledger.transfer({ from: eur.id, to: usd.id, amount: '1' }, newKey());

    expect([res.status, res.body.error]).toEqual([409, 'currency_mismatch']);
    expect(await db.balance(eur.id)).toBe('10.00');
  });

  test('the account history shows both movements with signed entries', async ({ ledger }) => {
    const alice = await ledger.funded('Alice', '50');
    const bob = await ledger.funded('Bob', '0');
    await ledger.transfer({ from: alice.id, to: bob.id, amount: '20' }, newKey());

    const history = (await ledger.transactions(alice.id)).body;
    expect(history.map((h) => [h.kind, h.amount, h.entry])).toEqual([
      ['deposit', '50.00', '50.00'],
      ['transfer', '20.00', '-20.00'],
    ]);
  });
});
