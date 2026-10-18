import { test, expect } from '../../src/auth/fixtures';
import { TEST_SECRETS, basic, decodeJwt } from '../../src/auth/oauth';

const CASHIER = ['cashier-service', TEST_SECRETS['cashier-service']] as const;

/** Client Credentials (RFC 6749 §4.4) and client authentication at the token endpoint. */
test.describe('Client Credentials', () => {
  test('a service gets a token for itself, without a refresh token', { tag: '@smoke' }, async ({ auth }) => {
    const t = await auth.token({ grant_type: 'client_credentials' }, basic(...CASHIER));

    expect(t.status).toBe(200);
    expect(t.body.refresh_token).toBeUndefined(); // the service can always ask again
    expect(decodeJwt(t.body.access_token).payload).toMatchObject({
      sub: 'cashier-service',
      client_id: 'cashier-service',
      scope: 'accounts:read:all deposits:write',
    });
  });

  test('client_secret_post works too', async ({ auth }) => {
    const t = await auth.token({
      grant_type: 'client_credentials',
      client_id: CASHIER[0],
      client_secret: CASHIER[1],
    });
    expect(t.status).toBe(200);
  });

  test('a narrower scope can be asked for; a wider one is refused', async ({ auth }) => {
    const narrow = await auth.token(
      { grant_type: 'client_credentials', scope: 'accounts:read:all' },
      basic(...CASHIER),
    );
    const wide = await auth.token(
      { grant_type: 'client_credentials', scope: 'deposits:write transfers:write' },
      basic(...CASHIER),
    );

    expect(narrow.body.scope).toBe('accounts:read:all');
    expect([wide.status, wide.body.error]).toEqual([400, 'invalid_scope']);
  });

  test('a wrong secret → 401 invalid_client with a Basic challenge', async ({ auth }) => {
    const t = await auth.token({ grant_type: 'client_credentials' }, basic(CASHIER[0], 'guess'));

    expect([t.status, t.body.error]).toEqual([401, 'invalid_client']);
    expect(t.response.headers()['www-authenticate']).toMatch(/^Basic /);
    expect(t.response.headers()['cache-control']).toBe('no-store');
  });

  const refused: [string, Record<string, string>, string | undefined, number, string][] = [
    ['an unknown client', { grant_type: 'client_credentials' }, basic('ghost', 'x'), 401, 'invalid_client'],
    [
      'the public web app (it has no secret to prove who it is)',
      { grant_type: 'client_credentials', client_id: 'ledger-web' },
      undefined,
      400,
      'unauthorized_client',
    ],
    [
      'a public client that sends a secret',
      { grant_type: 'client_credentials', client_id: 'ledger-web', client_secret: 'x' },
      undefined,
      401,
      'invalid_client',
    ],
    [
      'the password grant (removed in OAuth 2.1)',
      { grant_type: 'password', username: 'alice', password: 'x' },
      basic(...CASHIER),
      400,
      'unsupported_grant_type',
    ],
    ['no grant_type', {}, basic(...CASHIER), 400, 'invalid_request'],
    [
      'a service using the authorization code grant',
      { grant_type: 'authorization_code', code: 'x' },
      basic(...CASHIER),
      400,
      'unauthorized_client',
    ],
  ];
  for (const [name, form, authorization, status, error] of refused) {
    test(`refused: ${name} → ${status} ${error}`, async ({ auth }) => {
      const t = await auth.token(form, authorization);

      expect([t.status, t.body.error]).toEqual([status, error]);
      expect(t.body.access_token).toBeUndefined();
    });
  }

  test('JSON instead of a form body → 400 invalid_request', async ({ auth }) => {
    const t = await auth.api.post<{ error: string }>(`${auth.issuer}/token`, {
      body: { grant_type: 'client_credentials' },
      headers: { Authorization: basic(...CASHIER) },
    });
    expect([t.status, t.body.error]).toEqual([400, 'invalid_request']);
  });
});
