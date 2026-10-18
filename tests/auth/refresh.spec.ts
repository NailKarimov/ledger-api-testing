import { test, expect } from '../../src/auth/fixtures';
import { TEST_SECRETS, basic, decodeJwt } from '../../src/auth/oauth';

/** Refresh tokens are rotated; a reused one means it leaked, so the whole session dies (Security BCP §4.14). */
test.describe('Refresh tokens', () => {
  const refresh = (token: string, extra: Record<string, string> = {}) => ({
    grant_type: 'refresh_token',
    client_id: 'ledger-web',
    refresh_token: token,
    ...extra,
  });

  test('every refresh returns a new refresh token (rotation)', { tag: '@smoke' }, async ({ auth }) => {
    const login = await auth.login('alice');
    const r = await auth.token(refresh(login.refresh_token!));

    expect(r.status).toBe(200);
    expect(r.body.refresh_token).toEqual(expect.any(String));
    expect(r.body.refresh_token).not.toBe(login.refresh_token);
    expect(decodeJwt(r.body.access_token).payload).toMatchObject({ sub: 'alice', scope: login.scope });
  });

  test('reusing an old refresh token is refused and revokes the newer one too', async ({ auth }) => {
    const login = await auth.login('alice');
    const rotated = await auth.token(refresh(login.refresh_token!)); // the legitimate app
    const attacker = await auth.token(refresh(login.refresh_token!)); // a copy of the old token
    const app = await auth.token(refresh(rotated.body.refresh_token!));

    expect([attacker.status, attacker.body.error]).toEqual([400, 'invalid_grant']);
    expect([app.status, app.body.error]).toEqual([400, 'invalid_grant']);
  });

  test('a refresh may narrow the scope but never widen it', async ({ auth }) => {
    const login = await auth.login('alice', 'accounts:read transfers:write');
    const narrow = await auth.token(refresh(login.refresh_token!, { scope: 'accounts:read' }));
    const wide = await auth.token(
      refresh(narrow.body.refresh_token!, { scope: 'accounts:read accounts:write' }),
    );

    expect(narrow.body.scope).toBe('accounts:read');
    expect([wide.status, wide.body.error]).toEqual([400, 'invalid_scope']);
  });

  test('a refresh token is bound to the client it was issued to', async ({ auth }) => {
    const login = await auth.login('alice');
    const r = await auth.token(
      { grant_type: 'refresh_token', refresh_token: login.refresh_token! },
      basic('cashier-service', TEST_SECRETS['cashier-service']),
    );

    expect(r.status).toBe(400);
    expect(['invalid_grant', 'unauthorized_client']).toContain(r.body.error);
  });

  test('a made-up refresh token → invalid_grant', async ({ auth }) => {
    const r = await auth.token(refresh('not-a-real-token'));
    expect([r.status, r.body.error]).toEqual([400, 'invalid_grant']);
  });
});
