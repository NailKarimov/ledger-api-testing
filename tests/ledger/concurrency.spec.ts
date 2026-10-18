import { test, expect, newKey } from '../../src/ledger/fixtures';

/** Race conditions: the classic way a money service loses money. */
test.describe('Concurrency', () => {
  test('25 parallel transfers of 10 from 100: exactly 10 succeed, the balance never goes negative', async ({
    ledger,
    db,
  }) => {
    const alice = await ledger.funded('Alice', '100');
    const bob = await ledger.funded('Bob', '0');

    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        ledger.transfer({ from: alice.id, to: bob.id, amount: '10' }, newKey()),
      ),
    );
    const codes = results.map((r) => r.status);

    expect(codes.filter((c) => c === 201)).toHaveLength(10);
    expect(codes.filter((c) => c === 422)).toHaveLength(15);
    expect(await db.balance(alice.id)).toBe('0.00');
    expect(await db.balance(bob.id)).toBe('100.00');
  });

  test('A→B and B→A at the same time all complete (no deadlock)', async ({ ledger, db }) => {
    const a = await ledger.funded('A', '100');
    const b = await ledger.funded('B', '100');

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2
          ? ledger.transfer({ from: a.id, to: b.id, amount: '1' }, newKey())
          : ledger.transfer({ from: b.id, to: a.id, amount: '1' }, newKey()),
      ),
    );

    expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
    expect(await db.balance(a.id)).toBe('100.00');
    expect(await db.balance(b.id)).toBe('100.00');
  });
});
