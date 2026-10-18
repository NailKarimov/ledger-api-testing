import { SignJWT, UnsecuredJWT, generateKeyPair } from 'jose';
import { test, expect } from '../../src/ledger/fixtures';
import type { AuthServer } from '../../services/auth-server/src/app.ts';

/**
 * The Ledger API as a resource server: which tokens it must refuse. Each forged token is built the way an
 * attacker or a buggy issuer would build it; `authServer.mint` signs with the real key, so only the claim
 * under test is wrong.
 */
test.describe('JWT validation on the Ledger API', () => {
  const now = () => Math.floor(Date.now() / 1000);
  const claims = (auth: AuthServer, over: Record<string, unknown> = {}) => ({
    iss: auth.issuer,
    aud: 'ledger-api',
    sub: 'alice',
    client_id: 'ledger-web',
    scope: 'accounts:read accounts:write transfers:write',
    iat: now(),
    exp: now() + 300,
    ...over,
  });

  const forged: [string, (auth: AuthServer, valid: string) => Promise<string>][] = [
    ['expired 2 minutes ago', (a) => a.mint(claims(a, { iat: now() - 1000, exp: now() - 120 }))],
    ['another issuer', (a) => a.mint(claims(a, { iss: 'https://evil.example' }))],
    ['a token for another API (aud)', (a) => a.mint(claims(a, { aud: 'reporting-api' }))],
    ['an ID token instead of an access token (typ JWT)', (a) => a.mint(claims(a), { typ: 'JWT' })],
    ['no client_id claim', (a) => a.mint(claims(a, { client_id: undefined }))],
    [
      'claims edited after signing (sub alice → bob)',
      async (_a, valid) => {
        const [h, p, s] = valid.split('.');
        const payload = { ...JSON.parse(Buffer.from(p!, 'base64url').toString()), sub: 'bob' };
        return `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
      },
    ],
    [
      'signed by the attacker’s own key with the real kid',
      async (a) => {
        const { privateKey } = await generateKeyPair('ES256');
        return new SignJWT(claims(a))
          .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: a.activeKid })
          .sign(privateKey);
      },
    ],
    ['alg: none (no signature)', async (a) => new UnsecuredJWT(claims(a)).encode()],
    [
      'HS256 with the public key as the HMAC secret (key confusion)',
      async (a) => {
        const jwks = await (await fetch(`${a.issuer}/.well-known/jwks.json`)).json();
        return new SignJWT(claims(a))
          .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: a.activeKid })
          .sign(new TextEncoder().encode(JSON.stringify(jwks.keys[0])));
      },
    ],
    ['a kid the JWKS does not have', (a) => a.mint(claims(a), { kid: 'k-unknown' })],
    ['not a JWT at all', async () => 'abc.def.ghi'],
  ];
  for (const [name, make] of forged) {
    test(`refused: ${name} → 401 invalid_token, nothing changes`, async ({
      ledger,
      authServer,
      tokens,
      db,
    }) => {
      const acc = await ledger.funded('Alice', '10');
      const token = await make(authServer, tokens.alice);
      const before = await db.countRows('SELECT 1 FROM transfers');

      const read = await ledger.as(token).getAccount(acc.id);
      const pay = await ledger
        .as(token)
        .transfer({ from: acc.id, to: crypto.randomUUID(), amount: '1' }, 'k-12345678');

      for (const res of [read, pay]) {
        expect([res.status, res.body.error]).toEqual([401, 'invalid_token']);
        expect(res.response.headers()['www-authenticate']).toMatch(
          /^Bearer realm="ledger-api", error="invalid_token"/,
        );
        expect(res.text).not.toContain(acc.id);
      }
      expect(await db.countRows('SELECT 1 FROM transfers')).toBe(before);
    });
  }

  test('expiry within the 30 s clock tolerance is still accepted (boundary)', async ({
    ledger,
    authServer,
  }) => {
    const acc = await ledger.funded('Alice', '10');
    const token = await authServer.mint(claims(authServer, { iat: now() - 600, exp: now() - 10 }));

    expect((await ledger.as(token).getAccount(acc.id)).status).toBe(200);
  });

  test('no Authorization header → 401 with a bare Bearer challenge (RFC 6750 §3.1)', async ({ ledger }) => {
    const res = await ledger.call('GET', `/accounts/${crypto.randomUUID()}`);

    expect(res.status).toBe(401);
    expect(res.response.headers()['www-authenticate']).toBe('Bearer realm="ledger-api"');
  });

  test('the token in the query string is not accepted', async ({ ledger, tokens }) => {
    const acc = await ledger.funded('Alice', '10');
    const res = await ledger.api.get<{ status: number }>(`${ledger.baseUrl}/accounts/${acc.id}`, {
      access_token: tokens.alice,
    });
    expect(res.status).toBe(401);
  });

  test('another scheme (Basic) → 401; the scheme name is case-insensitive', async ({ ledger, tokens }) => {
    const acc = await ledger.funded('Alice', '10');
    const basic = await ledger.call('GET', `/accounts/${acc.id}`, {
      headers: { Authorization: 'Basic YTpi' },
    });
    const lower = await ledger.call('GET', `/accounts/${acc.id}`, {
      headers: { Authorization: `bearer ${tokens.alice}` },
    });

    expect(basic.status).toBe(401);
    expect(lower.status).toBe(200);
  });

  test('/health stays public (for the load balancer)', async ({ ledger }) => {
    expect((await ledger.call('GET', '/health')).status).toBe(200);
  });
});
