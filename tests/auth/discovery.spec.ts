import { test, expect } from '../../src/auth/fixtures';
import { decodeJwt } from '../../src/auth/oauth';

/** What a client or a resource server learns from the authorization server before the first token. */
test.describe('Discovery and keys', () => {
  test('metadata (RFC 8414) offers only the safe flows', { tag: '@smoke' }, async ({ auth }) => {
    const res = await auth.discovery();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      issuer: auth.issuer,
      authorization_endpoint: `${auth.issuer}/authorize`,
      token_endpoint: `${auth.issuer}/token`,
      jwks_uri: `${auth.issuer}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    });
    // OAuth 2.1 removes the implicit and password grants; PKCE "plain" is not offered.
    expect(res.body.grant_types_supported).not.toContain('implicit');
    expect(res.body.grant_types_supported).not.toContain('password');
  });

  test('the JWKS publishes public ES256 keys only, never the private part', async ({ auth }) => {
    const res = await auth.jwks();

    expect(res.status).toBe(200);
    expect(res.response.headers()['cache-control']).toMatch(/max-age=\d+/);
    expect(res.body.keys.length).toBeGreaterThan(0);
    for (const key of res.body.keys) {
      expect(key).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
      expect(key.kid).toEqual(expect.any(String));
      expect(key).not.toHaveProperty('d');
    }
  });

  test('an access token is a signed at+jwt (RFC 9068) with the claims the API relies on', async ({
    auth,
  }) => {
    const before = Math.floor(Date.now() / 1000);
    const first = await auth.login('alice');
    const second = await auth.login('alice');
    const { header, payload } = decodeJwt(first.access_token);
    const kids = (await auth.jwks()).body.keys.map((k) => k.kid);

    expect(header).toMatchObject({ alg: 'ES256', typ: 'at+jwt' });
    expect(kids).toContain(header.kid);
    expect(payload).toMatchObject({
      iss: auth.issuer,
      aud: 'ledger-api',
      sub: 'alice',
      client_id: 'ledger-web',
      scope: 'accounts:read accounts:write transfers:write',
    });
    expect(payload.iat as number).toBeGreaterThanOrEqual(before);
    expect((payload.exp as number) - (payload.iat as number)).toBe(900);
    expect(payload.jti).not.toBe(decodeJwt(second.access_token).payload.jti);
  });
});
