import { test, expect, startLedger, trust } from '../../src/ledger/fixtures';
import { startAuthServer } from '../../src/auth/fixtures';
import { fetchUserToken } from '../../src/auth/oauth';
import { LedgerClient } from '../../src/ledger/LedgerClient';
import { ApiClient } from '../../src/api/ApiClient';

/**
 * Signing keys change. Each test runs its own authorization server and Ledger API (on the worker's database),
 * so rotating keys here cannot disturb the other tests.
 */
test.describe('Key rotation and the JWKS cache', () => {
  test('rotation: tokens from the new key work at once, the old ones until the key is retired', async ({
    request,
    ledgerPool,
  }) => {
    const auth = await startAuthServer();
    const api = await startLedger(ledgerPool, trust(auth, { jwksCooldownMs: 0, jwksCacheMaxAgeMs: 1_000 }));
    try {
      const client = (token: string) => new LedgerClient(new ApiClient(request), api.baseUrl, token, token);
      const oldKid = auth.activeKid;
      const oldToken = await fetchUserToken(auth.issuer, 'alice');
      const acc = (await client(oldToken).createAccount({ owner: 'Alice', currency: 'EUR' })).body;

      await auth.rotateKeys();
      const newToken = await fetchUserToken(auth.issuer, 'alice');
      expect((await client(newToken).getAccount(acc.id)).status).toBe(200); // unknown kid → JWKS refetched
      expect((await client(oldToken).getAccount(acc.id)).status).toBe(200); // old key still published

      auth.retireKey(oldKid);
      await new Promise((r) => setTimeout(r, 1_200)); // let the API's JWKS cache go stale
      const after = await client(oldToken).getAccount(acc.id);
      expect([after.status, after.response.headers()['www-authenticate']]).toEqual([
        401,
        expect.stringContaining('unknown signing key'),
      ]);
      expect((await client(newToken).getAccount(acc.id)).status).toBe(200);
    } finally {
      await api.close();
      await auth.close();
    }
  });

  test('the API caches the JWKS: 20 requests, at most one download', async ({ request, ledgerPool }) => {
    const auth = await startAuthServer();
    const api = await startLedger(ledgerPool, trust(auth));
    try {
      const token = await fetchUserToken(auth.issuer, 'alice');
      const client = new LedgerClient(new ApiClient(request), api.baseUrl, token, token);
      const acc = (await client.createAccount({ owner: 'Alice', currency: 'EUR' })).body;
      const before = auth.jwksRequests;

      for (let i = 0; i < 20; i++) expect((await client.getAccount(acc.id)).status).toBe(200);

      expect(auth.jwksRequests - before).toBeLessThanOrEqual(1);
    } finally {
      await api.close();
      await auth.close();
    }
  });

  test('with the authorization server down, valid tokens still work from the cached keys', async ({
    request,
    ledgerPool,
  }) => {
    const auth = await startAuthServer();
    const api = await startLedger(ledgerPool, trust(auth));
    try {
      const token = await fetchUserToken(auth.issuer, 'alice');
      const client = new LedgerClient(new ApiClient(request), api.baseUrl, token, token);
      const acc = (await client.createAccount({ owner: 'Alice', currency: 'EUR' })).body;

      await auth.close();

      expect((await client.getAccount(acc.id)).status).toBe(200);
    } finally {
      await api.close();
    }
  });
});
