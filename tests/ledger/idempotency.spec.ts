import { test, expect, newKey } from '../../src/ledger/fixtures';

/**
 * A payment client retries when a response is lost. The Idempotency-Key makes the retry safe:
 * the same key and body return the original transfer and move no money a second time.
 */
test.describe('Idempotency', () => {
  test('a retry with the same key returns the same transfer and charges once', async ({ ledger, db }) => {
    const alice = await ledger.funded('Alice', '100');
    const bob = await ledger.funded('Bob', '0');
    const key = newKey();
    const body = { from: alice.id, to: bob.id, amount: '40' };

    const first = await ledger.transfer(body, key);
    const retry = await ledger.transfer(body, key);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.response.headers()['idempotent-replayed']).toBe('true');
    expect(retry.body.id).toBe(first.body.id);
    expect(await db.countRows('SELECT 1 FROM transfers WHERE idempotency_key = $1', [key])).toBe(1);
    expect(await db.balance(alice.id)).toBe('60.00');
  });

  test('"40" and "40.00" are the same request', async ({ ledger }) => {
    const alice = await ledger.funded('Alice', '100');
    const bob = await ledger.funded('Bob', '0');
    const key = newKey();

    const first = await ledger.transfer({ from: alice.id, to: bob.id, amount: '40' }, key);
    const retry = await ledger.transfer({ from: alice.id, to: bob.id, amount: '40.00' }, key);

    expect(retry.body.id).toBe(first.body.id);
  });

  test('the same key with a different amount is rejected and moves nothing', async ({ ledger, db }) => {
    const alice = await ledger.funded('Alice', '100');
    const bob = await ledger.funded('Bob', '0');
    const key = newKey();
    await ledger.transfer({ from: alice.id, to: bob.id, amount: '10' }, key);

    const reuse = await ledger.transfer({ from: alice.id, to: bob.id, amount: '99' }, key);

    expect([reuse.status, reuse.body.error]).toEqual([422, 'idempotency_key_reused']);
    expect(await db.balance(alice.id)).toBe('90.00');
  });

  test('without an Idempotency-Key → 400', async ({ ledger }) => {
    const alice = await ledger.funded('Alice', '10');
    const bob = await ledger.funded('Bob', '0');

    const res = await ledger.transfer({ from: alice.id, to: bob.id, amount: '1' });
    expect([res.status, res.body.error]).toEqual([400, 'idempotency_key_required']);
  });

  test('ten simultaneous retries of one request charge exactly once', async ({ ledger, db }) => {
    const alice = await ledger.funded('Alice', '100');
    const bob = await ledger.funded('Bob', '0');
    const key = newKey();
    const body = { from: alice.id, to: bob.id, amount: '15' };

    const results = await Promise.all(Array.from({ length: 10 }, () => ledger.transfer(body, key)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await db.balance(alice.id)).toBe('85.00');
  });
});
