import { createHash, randomBytes } from 'node:crypto';
import type { ApiClient, ApiResult } from '../api/ApiClient';
import { WEB_REDIRECT_URI } from '../../services/auth-server/src/clients.ts';

export { TEST_SECRETS, WEB_REDIRECT_URI } from '../../services/auth-server/src/clients.ts';

export type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

/** PKCE (RFC 7636): a random verifier and its S256 challenge. */
export function pkce() {
  const verifier = randomBytes(32).toString('base64url'); // 43 characters
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

/** Decodes a JWT's header and payload without verifying it (for assertions on what was issued). */
export function decodeJwt(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const [h, p] = token.split('.');
  const parse = (part = '') => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  return { header: parse(h), payload: parse(p) };
}

export type AuthorizeParams = Partial<{
  response_type: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  login_hint: string;
  consent: string;
}>;

/** Client of the authorization server, through Playwright (every exchange lands in the report, redacted). */
export class AuthClient {
  constructor(
    readonly api: ApiClient,
    readonly issuer: string,
  ) {}

  discovery() {
    return this.api.get<Record<string, unknown>>(`${this.issuer}/.well-known/oauth-authorization-server`);
  }

  jwks() {
    return this.api.get<{ keys: Record<string, unknown>[] }>(`${this.issuer}/.well-known/jwks.json`);
  }

  /** GET /authorize without following the redirect; returns the response and the parsed Location. */
  async authorize(params: AuthorizeParams) {
    const res = await this.api.send<Record<string, string>>('GET', `${this.issuer}/authorize`, {
      query: params,
      maxRedirects: 0,
    });
    const location = res.response.headers()['location'];
    const redirect = location ? new URL(location) : undefined;
    return { res, redirect, get: (k: string) => redirect?.searchParams.get(k) ?? null };
  }

  token(form: Record<string, string>, authorization?: string): Promise<ApiResult<TokenResponse>> {
    return this.api.post(`${this.issuer}/token`, {
      form,
      headers: authorization ? { Authorization: authorization } : {},
    });
  }

  /** The happy path of Authorization Code + PKCE for `ledger-web`, as the browser app runs it. */
  async login(user: string, scope = 'accounts:read accounts:write transfers:write') {
    const { verifier, challenge } = pkce();
    const state = randomBytes(8).toString('hex');
    const a = await this.authorize({
      response_type: 'code',
      client_id: 'ledger-web',
      redirect_uri: WEB_REDIRECT_URI,
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      login_hint: user,
    });
    const code = a.get('code');
    if (!code) throw new Error(`authorize failed: ${a.get('error')} ${a.get('error_description')}`);
    const res = await this.token({
      grant_type: 'authorization_code',
      client_id: 'ledger-web',
      code,
      redirect_uri: WEB_REDIRECT_URI,
      code_verifier: verifier,
    });
    return res.body;
  }

  /** Client Credentials for a back-office service. */
  async service(id: string, secret: string, scope?: string) {
    const res = await this.token(
      { grant_type: 'client_credentials', ...(scope ? { scope } : {}) },
      basic(id, secret),
    );
    return res.body;
  }
}

/** The same two flows with plain fetch, for worker-scoped fixtures that run outside a test. */
export async function fetchUserToken(issuer: string, user: string): Promise<string> {
  const { verifier, challenge } = pkce();
  const url = new URL(`${issuer}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: 'ledger-web',
    redirect_uri: WEB_REDIRECT_URI,
    scope: 'accounts:read accounts:write transfers:write',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    login_hint: user,
  }))
    url.searchParams.set(k, v);
  const a = await fetch(url, { redirect: 'manual' });
  const code = new URL(a.headers.get('location')!).searchParams.get('code');
  if (!code) throw new Error(`authorize failed for ${user}: ${a.headers.get('location')}`);
  const t = await fetch(`${issuer}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'ledger-web',
      code,
      redirect_uri: WEB_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  return ((await t.json()) as TokenResponse).access_token;
}

export async function fetchServiceToken(issuer: string, id: string, secret: string): Promise<string> {
  const t = await fetch(`${issuer}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic(id, secret) },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  return ((await t.json()) as TokenResponse).access_token;
}
