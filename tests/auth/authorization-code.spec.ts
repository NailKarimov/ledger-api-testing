import { createHash, randomBytes } from 'node:crypto';
import { test, expect, startAuthServer } from '../../src/auth/fixtures';
import { AuthClient, WEB_REDIRECT_URI, decodeJwt, pkce, type AuthorizeParams } from '../../src/auth/oauth';
import { ApiClient } from '../../src/api/ApiClient';

/** Authorization Code + PKCE (RFC 6749 §4.1, RFC 7636): the flow of the browser app `ledger-web`. */
test.describe('Authorization Code + PKCE', () => {
  const start = (challenge: string, extra: AuthorizeParams = {}): AuthorizeParams => ({
    response_type: 'code',
    client_id: 'ledger-web',
    redirect_uri: WEB_REDIRECT_URI,
    scope: 'accounts:read transfers:write',
    state: 'st-42',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    login_hint: 'alice',
    ...extra,
  });
  const exchange = (code: string, verifier: string, extra: Record<string, string> = {}) => ({
    grant_type: 'authorization_code',
    client_id: 'ledger-web',
    code,
    redirect_uri: WEB_REDIRECT_URI,
    code_verifier: verifier,
    ...extra,
  });

  test(
    'the full flow: redirect with code, state and iss, then tokens',
    { tag: '@smoke' },
    async ({ auth }) => {
      const { verifier, challenge } = pkce();
      const a = await auth.authorize(start(challenge));

      expect(a.res.status).toBe(302);
      expect(`${a.redirect!.origin}${a.redirect!.pathname}`).toBe(WEB_REDIRECT_URI);
      expect(a.get('state')).toBe('st-42'); // the client checks it against CSRF
      expect(a.get('iss')).toBe(auth.issuer); // RFC 9207: protects against mix-up attacks
      expect(a.get('code')).toMatch(/^[\w-]{43}$/);

      const t = await auth.token(exchange(a.get('code')!, verifier));
      expect(t.status).toBe(200);
      expect(t.response.headers()['cache-control']).toBe('no-store'); // RFC 6749 §5.1
      expect(t.body).toMatchObject({
        token_type: 'Bearer',
        expires_in: 900,
        scope: 'accounts:read transfers:write',
      });
      expect(t.body.refresh_token).toEqual(expect.any(String));
      expect(decodeJwt(t.body.access_token).payload.sub).toBe('alice');
    },
  );

  test('a wrong code_verifier → invalid_grant (a stolen code is useless without it)', async ({ auth }) => {
    const { challenge } = pkce();
    const a = await auth.authorize(start(challenge));
    const t = await auth.token(exchange(a.get('code')!, pkce().verifier));

    expect([t.status, t.body.error]).toEqual([400, 'invalid_grant']);
    expect(t.body.access_token).toBeUndefined();
  });

  test('a verifier of 42 characters is refused even when its hash matches (boundary: 43–128)', async ({
    auth,
  }) => {
    const short = randomBytes(32).toString('base64url').slice(0, 42);
    const challenge = createHash('sha256').update(short).digest('base64url');
    const a = await auth.authorize(start(challenge));
    const t = await auth.token(exchange(a.get('code')!, short));

    expect([t.status, t.body.error]).toEqual([400, 'invalid_grant']);
  });

  test('a code works once; the second use also revokes the session it started', async ({ auth }) => {
    const { verifier, challenge } = pkce();
    const code = (await auth.authorize(start(challenge))).get('code')!;
    const first = await auth.token(exchange(code, verifier));
    const second = await auth.token(exchange(code, verifier));
    const refresh = await auth.token({
      grant_type: 'refresh_token',
      client_id: 'ledger-web',
      refresh_token: first.body.refresh_token!,
    });

    expect(first.status).toBe(200);
    expect([second.status, second.body.error]).toEqual([400, 'invalid_grant']);
    expect([refresh.status, refresh.body.error]).toEqual([400, 'invalid_grant']);
  });

  test('redirect_uri at the token endpoint must be the one used to get the code', async ({ auth }) => {
    const { verifier, challenge } = pkce();
    const code = (await auth.authorize(start(challenge))).get('code')!;
    const t = await auth.token(exchange(code, verifier, { redirect_uri: `${WEB_REDIRECT_URI}2` }));

    expect([t.status, t.body.error]).toEqual([400, 'invalid_grant']);
  });

  test('a code expires (lifetime 1 s on a dedicated server)', async ({ request }) => {
    const server = await startAuthServer({ codeTtlSec: 1 });
    try {
      const auth = new AuthClient(new ApiClient(request), server.issuer);
      const { verifier, challenge } = pkce();
      const code = (await auth.authorize(start(challenge))).get('code')!;
      await new Promise((r) => setTimeout(r, 1_200));
      const t = await auth.token(exchange(code, verifier));

      expect([t.status, t.body.error, t.body.error_description]).toEqual([
        400,
        'invalid_grant',
        'code expired',
      ]);
    } finally {
      await server.close();
    }
  });

  // Errors about the client itself are shown, never redirected: otherwise /authorize is an open redirector.
  const notRedirected: [string, AuthorizeParams][] = [
    ['an unknown client', { client_id: 'evil-app' }],
    ['another host', { redirect_uri: 'https://evil.example/callback' }],
    ['a longer path (prefix match)', { redirect_uri: `${WEB_REDIRECT_URI}/evil` }],
    ['a path traversal', { redirect_uri: 'http://127.0.0.1:5173/callback/../evil' }],
    ['an extra query', { redirect_uri: `${WEB_REDIRECT_URI}?next=https://evil.example` }],
    ['another port', { redirect_uri: 'http://127.0.0.1:5174/callback' }],
    ['no redirect_uri', { redirect_uri: undefined }],
  ];
  for (const [name, extra] of notRedirected) {
    test(`${name} → 400 on the page, no redirect`, async ({ auth }) => {
      const a = await auth.authorize(start(pkce().challenge, extra));

      expect(a.res.status).toBe(400);
      expect(a.redirect).toBeUndefined();
    });
  }

  const redirectedErrors: [string, AuthorizeParams, string][] = [
    ['no code_challenge (PKCE is mandatory)', { code_challenge: undefined }, 'invalid_request'],
    ['code_challenge_method=plain', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['the implicit flow (response_type=token)', { response_type: 'token' }, 'unsupported_response_type'],
    ['a scope the client may not have', { scope: 'deposits:write' }, 'invalid_scope'],
    ['the user declines consent', { consent: 'deny' }, 'access_denied'],
    ['an unknown user', { login_hint: 'mallory' }, 'access_denied'],
  ];
  for (const [name, extra, error] of redirectedErrors) {
    test(`${name} → back to the client with error=${error} and state, no code`, async ({ auth }) => {
      const a = await auth.authorize(start(pkce().challenge, extra));

      expect(a.res.status).toBe(302);
      expect([a.get('error'), a.get('state'), a.get('code')]).toEqual([error, 'st-42', null]);
    });
  }
});
