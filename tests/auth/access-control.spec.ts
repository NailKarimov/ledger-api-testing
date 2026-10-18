import { test, expect, newKey } from '../../src/ledger/fixtures';

/**
 * Who may do what with a valid token: scopes decide the operation, the `sub` claim decides the data.
 * OWASP API Security Top 10: API1 Broken Object Level Authorization, API5 Broken Function Level Authorization.
 */
test.describe('Scopes and ownership', () => {
  test(
    'a user owns the accounts they open; the database records who did what',
    { tag: '@smoke' },
    async ({ ledger, db }) => {
      const alice = await ledger.funded('Alice', '50');
      const bob = await ledger.funded('Bob', '0');
      const t = await ledger.transfer({ from: alice.id, to: bob.id, amount: '5' }, newKey());

      expect(await db.one('SELECT owner_sub FROM accounts WHERE id = $1', [alice.id])).toEqual({
        owner_sub: 'alice',
      });
      expect(
        await db.rows(
          'SELECT kind, initiated_by FROM transfers WHERE to_account = $1 OR id = $2 ORDER BY kind',
          [alice.id, t.body.id],
        ),
      ).toEqual([
        { kind: 'deposit', initiated_by: 'cashier-service' },
        { kind: 'transfer', initiated_by: 'alice' },
      ]);
    },
  );

  test('BOLA: Bob cannot see Alice’s account — the answer equals a missing account', async ({
    ledger,
    tokens,
  }) => {
    const acc = await ledger.funded('Alice', '50');
    const bob = ledger.as(tokens.bob);

    const own = await ledger.getAccount(acc.id);
    const foreign = await bob.getAccount(acc.id);
    const missing = await bob.getAccount(crypto.randomUUID());
    const history = await bob.transactions(acc.id);

    expect(own.status).toBe(200);
    expect([foreign.status, foreign.body]).toEqual([missing.status, missing.body]);
    expect(foreign.status).toBe(404);
    expect(history.status).toBe(404);
  });

  test('BOLA: Bob cannot spend from Alice’s account; nothing moves', async ({ ledger, tokens, db }) => {
    const alice = await ledger.funded('Alice', '50');
    const bobAcc = await ledger.as(tokens.bob).funded('Bob', '0');

    const res = await ledger
      .as(tokens.bob)
      .transfer({ from: alice.id, to: bobAcc.id, amount: '50' }, newKey());

    expect([res.status, res.body.error]).toEqual([404, 'not_found']);
    expect(await db.balance(alice.id)).toBe('50.00');
    expect(await db.balance(bobAcc.id)).toBe('0.00');
  });

  test('anyone may be paid: Bob sends money to Alice’s account', async ({ ledger, tokens, db }) => {
    const alice = await ledger.funded('Alice', '0');
    const bobAcc = await ledger.as(tokens.bob).funded('Bob', '20');

    const res = await ledger
      .as(tokens.bob)
      .transfer({ from: bobAcc.id, to: alice.id, amount: '20' }, newKey());

    expect(res.status).toBe(201);
    expect(await db.balance(alice.id)).toBe('20.00');
  });

  test('Bob reusing Alice’s Idempotency-Key gets a 422, not a replay of her transfer', async ({
    ledger,
    tokens,
  }) => {
    const alice = await ledger.funded('Alice', '50');
    const bobAcc = await ledger.as(tokens.bob).funded('Bob', '50');
    const key = newKey();
    const hers = await ledger.transfer({ from: alice.id, to: bobAcc.id, amount: '7' }, key);

    const his = await ledger.as(tokens.bob).transfer({ from: alice.id, to: bobAcc.id, amount: '7' }, key);

    expect(hers.status).toBe(201);
    expect([his.status, his.body.error]).toEqual([422, 'idempotency_key_reused']);
    expect(his.text).not.toContain(hers.body.id);
  });

  test('a reporting service reads any account but cannot change anything', async ({ ledger, tokens }) => {
    const acc = await ledger.funded('Alice', '50');
    const reporting = ledger.as(tokens.reporting);

    const read = await reporting.getAccount(acc.id);
    const open = await reporting.createAccount({ owner: 'X', currency: 'EUR' });
    const pay = await reporting.transfer({ from: acc.id, to: crypto.randomUUID(), amount: '1' }, newKey());
    const cash = await ledger.deposit(acc.id, '1', tokens.reporting);

    expect(read.status).toBe(200);
    for (const [res, scope] of [
      [open, 'accounts:write'],
      [pay, 'transfers:write'],
      [cash, 'deposits:write'],
    ] as const) {
      expect([res.status, res.body.error]).toEqual([403, 'insufficient_scope']);
      expect(res.response.headers()['www-authenticate']).toContain(
        `error="insufficient_scope", scope="${scope}"`,
      );
    }
  });

  test('BFLA: a user cannot put cash on an account (deposits are back-office only)', async ({
    ledger,
    tokens,
    db,
  }) => {
    const acc = await ledger.funded('Alice', '0');
    const res = await ledger.deposit(acc.id, '1000', tokens.alice);

    expect([res.status, res.body.error]).toEqual([403, 'insufficient_scope']);
    expect(await db.balance(acc.id)).toBe('0.00');
  });

  test('a read-only login can look but not pay', async ({ ledger, auth }) => {
    const acc = await ledger.funded('Alice', '10');
    const readOnly = ledger.as((await auth.login('alice', 'accounts:read')).access_token);

    expect((await readOnly.getAccount(acc.id)).status).toBe(200);
    expect(
      (await readOnly.transfer({ from: acc.id, to: crypto.randomUUID(), amount: '1' }, newKey())).status,
    ).toBe(403);
  });

  test('authentication comes before validation: no token and no Idempotency-Key → 401, not 400', async ({
    ledger,
  }) => {
    const res = await ledger.call('POST', '/transfers', { body: {} });
    expect(res.status).toBe(401);
  });
});
