import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK, type JWTPayload } from 'jose';
import { DEFAULT_CLIENTS, DEFAULT_USERS, type Client } from './clients.ts';

/**
 * A small OAuth 2.0 authorization server for the Ledger API (docs/oauth-jwt.md), written to be tested.
 *
 * - Authorization Code + PKCE (S256 only, as OAuth 2.1 requires) for the browser app `ledger-web`;
 *   `login_hint` stands in for the login page: the named test user signs in and consents.
 * - Client Credentials for back-office services (`cashier-service`, `reporting`).
 * - Refresh tokens are rotated on every use; reusing an old one revokes the whole family (OAuth 2.0 Security BCP).
 * - Access tokens are JWTs (RFC 9068, `typ: at+jwt`) signed with ES256; public keys are served as a JWKS and can
 *   be rotated. Codes, refresh tokens and keys live in memory: one server per test worker.
 */

export type AuthOptions = {
  clients?: Record<string, Client>;
  users?: string[];
  audience?: string;
  accessTtlSec?: number;
  codeTtlSec?: number;
  refreshTtlSec?: number;
};

type Key = { kid: string; privateKey: CryptoKey; publicJwk: JWK; published: boolean };
type Code = {
  clientId: string;
  redirectUri: string;
  user: string;
  scope: string;
  challenge: string;
  expiresAt: number;
  used: boolean;
  family: string;
};
type Refresh = {
  family: string;
  clientId: string;
  user: string;
  scope: string;
  expiresAt: number;
  used: boolean;
};

export type AuthServer = {
  app: FastifyInstance;
  /** Set once the server listens: the issuer is its own base URL (RFC 8414). */
  setIssuer(url: string): void;
  readonly issuer: string;
  /** Test hook: sign arbitrary claims with the current key, to build tokens a buggy issuer could produce. */
  mint(claims: JWTPayload, header?: { typ?: string; kid?: string }): Promise<string>;
  /** A new signing key; the previous one stays in the JWKS so its tokens keep working. */
  rotateKeys(): Promise<string>;
  /** Removes a key from the JWKS: tokens signed with it must stop working once resource servers notice. */
  retireKey(kid: string): void;
  readonly activeKid: string;
  /** How many times the JWKS was downloaded: resource servers must cache it. */
  readonly jwksRequests: number;
};

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const b64url = (buf: Buffer) => buf.toString('base64url');
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly description: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(description);
  }
}

async function newKey(): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const kid = `k-${randomUUID().slice(0, 8)}`;
  const jwk = await exportJWK(publicKey);
  return { kid, privateKey, publicJwk: { ...jwk, kid, alg: 'ES256', use: 'sig' }, published: true };
}

const scopeList = (s: unknown) => (typeof s === 'string' ? s.split(' ').filter(Boolean) : []);

export async function createAuthServer(opts: AuthOptions = {}): Promise<AuthServer> {
  const clients = opts.clients ?? DEFAULT_CLIENTS;
  const users = new Set(opts.users ?? DEFAULT_USERS);
  const audience = opts.audience ?? 'ledger-api';
  const accessTtl = opts.accessTtlSec ?? 900;
  const codeTtl = opts.codeTtlSec ?? 60;
  const refreshTtl = opts.refreshTtlSec ?? 86_400;

  let issuer = 'http://auth.invalid';
  const keys: Key[] = [await newKey()];
  const codes = new Map<string, Code>();
  const refreshTokens = new Map<string, Refresh>();
  const revokedFamilies = new Set<string>();
  let jwksRequests = 0;

  const active = () => keys[keys.length - 1]!;

  async function sign(claims: JWTPayload, header: { typ?: string; kid?: string } = {}) {
    const key = header.kid ? (keys.find((k) => k.kid === header.kid) ?? active()) : active();
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: header.kid ?? key.kid, typ: header.typ ?? 'at+jwt' })
      .sign(key.privateKey);
  }

  async function issue(sub: string, clientId: string, scope: string, family?: string) {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await sign({
      iss: issuer,
      sub,
      aud: audience,
      client_id: clientId,
      scope,
      iat: now,
      exp: now + accessTtl,
      jti: randomUUID(),
    });
    const body: Record<string, unknown> = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: accessTtl,
      scope,
    };
    if (family) {
      const refresh = b64url(randomBytes(32));
      refreshTokens.set(refresh, {
        family,
        clientId,
        user: sub,
        scope,
        expiresAt: Date.now() + refreshTtl * 1000,
        used: false,
      });
      body.refresh_token = refresh;
    }
    return body;
  }

  /** Client authentication: HTTP Basic or client_secret_post for confidential clients, client_id alone for public ones. */
  function authenticateClient(
    authHeader: string | undefined,
    form: Record<string, string>,
  ): [string, Client] {
    let id = form.client_id;
    let secret = form.client_secret;
    const basic = /^Basic (.+)$/i.exec(authHeader ?? '');
    if (basic) {
      const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      id = decodeURIComponent(decoded.slice(0, i));
      secret = decodeURIComponent(decoded.slice(i + 1));
    }
    const fail = () =>
      new OAuthError(
        401,
        'invalid_client',
        'client authentication failed',
        basic ? { 'WWW-Authenticate': 'Basic realm="ledger-auth"' } : {},
      );
    const client = id ? clients[id] : undefined;
    if (!client) throw fail();
    if (client.secretSha256) {
      if (!secret) throw fail();
      const given = sha256(secret);
      if (!timingSafeEqual(given, Buffer.from(client.secretSha256, 'hex'))) throw fail();
    } else if (secret) {
      throw fail(); // a public client has no secret; sending one means something is misconfigured
    }
    return [id!, client];
  }

  function grantedScope(requested: unknown, allowed: string[]): string {
    const asked = scopeList(requested);
    const list = asked.length ? asked : allowed;
    const bad = list.filter((s) => !allowed.includes(s));
    if (bad.length) throw new OAuthError(400, 'invalid_scope', `scope not allowed: ${bad.join(' ')}`);
    return [...new Set(list)].join(' ');
  }

  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof OAuthError) {
      return reply
        .status(error.status)
        .headers({ ...error.headers, 'Cache-Control': 'no-store' })
        .send({ error: error.error, error_description: error.description });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply
      .status(status < 500 ? 400 : 500)
      .send({ error: status < 500 ? 'invalid_request' : 'server_error', error_description: 'bad request' });
  });

  const metadata = () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: [...new Set(Object.values(clients).flatMap((c) => c.scopes))].sort(),
    authorization_response_iss_parameter_supported: true,
  });
  app.get('/.well-known/oauth-authorization-server', async () => metadata());
  app.get('/.well-known/openid-configuration', async () => metadata());

  app.get('/.well-known/jwks.json', async (_req, reply) => {
    jwksRequests++;
    return reply
      .header('Cache-Control', 'public, max-age=300')
      .send({ keys: keys.filter((k) => k.published).map((k) => k.publicJwk) });
  });

  // RFC 6749 §4.1.1 and RFC 7636. Errors about the client or redirect_uri are shown, never redirected
  // (an open redirector otherwise); everything else goes back to the client with `error` and `state`.
  app.get('/authorize', async (req, reply: FastifyReply) => {
    const q = req.query as Record<string, string | undefined>;
    const client = q.client_id ? clients[q.client_id] : undefined;
    if (!client) throw new OAuthError(400, 'invalid_client', 'unknown client_id');
    if (!q.redirect_uri || !client.redirectUris?.includes(q.redirect_uri)) {
      throw new OAuthError(400, 'invalid_request', 'redirect_uri is not registered for this client');
    }
    const back = (params: Record<string, string>) => {
      const url = new URL(q.redirect_uri!);
      for (const [k, v] of Object.entries({ ...params, ...(q.state ? { state: q.state } : {}), iss: issuer }))
        url.searchParams.set(k, v);
      return reply.status(302).header('Location', url.toString()).header('Cache-Control', 'no-store').send();
    };
    const fail = (error: string, description: string) => back({ error, error_description: description });

    if (q.response_type !== 'code') return fail('unsupported_response_type', 'only response_type=code');
    if (!client.grants.includes('authorization_code'))
      return fail('unauthorized_client', 'client may not use this flow');
    if (!q.code_challenge) return fail('invalid_request', 'code_challenge is required (PKCE)');
    if (q.code_challenge_method !== 'S256')
      return fail('invalid_request', 'code_challenge_method must be S256');
    if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge))
      return fail('invalid_request', 'malformed code_challenge');
    let scope: string;
    try {
      scope = grantedScope(q.scope, client.scopes);
    } catch (e) {
      return fail('invalid_scope', (e as Error).message);
    }
    // Test stand-in for the login and consent page.
    if (!q.login_hint || !users.has(q.login_hint) || q.consent === 'deny') {
      return fail('access_denied', 'the user did not sign in or did not consent');
    }
    const code = b64url(randomBytes(32));
    codes.set(code, {
      clientId: q.client_id!,
      redirectUri: q.redirect_uri,
      user: q.login_hint,
      scope,
      challenge: q.code_challenge,
      expiresAt: Date.now() + codeTtl * 1000,
      used: false,
      family: randomUUID(),
    });
    return back({ code });
  });

  app.post('/token', async (req, reply) => {
    const form = (req.body ?? {}) as Record<string, string>;
    if (
      typeof form !== 'object' ||
      !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')
    ) {
      throw new OAuthError(400, 'invalid_request', 'use application/x-www-form-urlencoded');
    }
    const [clientId, client] = authenticateClient(req.headers.authorization, form);
    const grant = form.grant_type;
    if (!grant) throw new OAuthError(400, 'invalid_request', 'grant_type is required');
    if (!['authorization_code', 'refresh_token', 'client_credentials'].includes(grant)) {
      throw new OAuthError(400, 'unsupported_grant_type', `unsupported grant_type: ${grant}`);
    }
    if (!client.grants.includes(grant as Client['grants'][number])) {
      throw new OAuthError(400, 'unauthorized_client', `client may not use ${grant}`);
    }
    let body: Record<string, unknown>;

    if (grant === 'authorization_code') {
      const code = codes.get(form.code ?? '');
      if (!code) throw new OAuthError(400, 'invalid_grant', 'unknown code');
      if (code.used) {
        // RFC 6749 §4.1.2: a code used twice means it was stolen; revoke what it produced.
        revokedFamilies.add(code.family);
        throw new OAuthError(400, 'invalid_grant', 'code already used');
      }
      code.used = true;
      if (code.expiresAt < Date.now()) throw new OAuthError(400, 'invalid_grant', 'code expired');
      if (code.clientId !== clientId)
        throw new OAuthError(400, 'invalid_grant', 'code was issued to another client');
      if (form.redirect_uri !== code.redirectUri)
        throw new OAuthError(400, 'invalid_grant', 'redirect_uri mismatch');
      if (!form.code_verifier || !VERIFIER.test(form.code_verifier)) {
        throw new OAuthError(400, 'invalid_grant', 'code_verifier must be 43–128 unreserved characters');
      }
      if (b64url(sha256(form.code_verifier)) !== code.challenge) {
        throw new OAuthError(400, 'invalid_grant', 'PKCE verification failed');
      }
      body = await issue(code.user, clientId, code.scope, code.family);
    } else if (grant === 'refresh_token') {
      const rt = refreshTokens.get(form.refresh_token ?? '');
      if (!rt || rt.clientId !== clientId)
        throw new OAuthError(400, 'invalid_grant', 'unknown refresh token');
      if (rt.used) {
        revokedFamilies.add(rt.family); // reuse detection: an attacker and the user hold the same token
        throw new OAuthError(400, 'invalid_grant', 'refresh token already used; the session is revoked');
      }
      if (revokedFamilies.has(rt.family)) throw new OAuthError(400, 'invalid_grant', 'session revoked');
      if (rt.expiresAt < Date.now()) throw new OAuthError(400, 'invalid_grant', 'refresh token expired');
      const scope = grantedScope(form.scope ?? rt.scope, scopeList(rt.scope)); // may narrow, never widen
      rt.used = true;
      body = await issue(rt.user, clientId, scope, rt.family);
    } else {
      body = await issue(clientId, clientId, grantedScope(form.scope, client.scopes));
    }
    return reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').send(body);
  });

  return {
    app,
    setIssuer: (url: string) => {
      issuer = url.replace(/\/$/, '');
    },
    get issuer() {
      return issuer;
    },
    mint: (claims, header) => sign(claims, header),
    rotateKeys: async () => {
      const k = await newKey();
      keys.push(k);
      return k.kid;
    },
    retireKey: (kid: string) => {
      const k = keys.find((x) => x.kid === kid);
      if (k) k.published = false;
    },
    get activeKid() {
      return active().kid;
    },
    get jwksRequests() {
      return jwksRequests;
    },
  };
}
