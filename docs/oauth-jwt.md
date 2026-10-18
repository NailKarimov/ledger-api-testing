# OAuth 2.0 and JWT: an authorization server and the Ledger API as a resource server

Visual version (the PKCE flow step by step, a token you can forge and watch the API refuse, who-may-do-what
matrix, refresh-token theft, key rotation, RU/EN):
[`docs/oauth-jwt.html`](https://nailkarimov.github.io/ledger-api-testing/oauth-jwt.html).

## Why

A money API without authentication only shows half of the testing. Almost every real API sits behind OAuth 2.0,
and the most common API vulnerabilities are about it: OWASP API Security Top 10 puts **broken object level
authorization** (API1) and **broken authentication** (API2) first. This stage adds a real token flow to the Ledger
API and tests both sides of it:

- **the authorization server** issues tokens correctly: PKCE, redirect rules, refresh rotation, client authentication;
- **the Ledger API** (resource server) refuses every token it should refuse, and a valid token only opens the data
  that belongs to its owner.

## The parts

```
 alice (browser) ──▶ ledger-web ──(1) /authorize + PKCE──▶ auth-server ──(2) 302 ?code&state&iss
                         │                                     │
                         └──(3) POST /token + code_verifier ───┘──▶ access token (JWT, 15 min) + refresh token
                         │
                         └──(4) Authorization: Bearer <JWT> ──▶ Ledger API ──▶ JWKS (cached) ──▶ PostgreSQL

 cashier-service, reporting ──client_credentials──▶ auth-server ──▶ token for the service itself
```

| Part                        | What it is                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `services/auth-server`      | Fastify + [jose](https://github.com/panva/jose), about 400 lines. In memory, one per test worker, no Docker needed |
| `services/ledger-api`       | now a resource server: `jose.jwtVerify` with a remote, cached JWKS; scopes per route; ownership in SQL             |
| `migrations/002_owners.sql` | `accounts.owner_sub` (the token's `sub` who opened it, `NOT NULL`), `transfers.initiated_by`                       |
| `src/auth/oauth.ts`         | `AuthClient` (every exchange attached to the report), PKCE helper, JWT decoder                                     |
| `src/auth/fixtures.ts`      | `auth`, `authServer` fixtures; `startAuthServer()` for tests that need their own server                            |
| `tests/auth`                | 66 tests                                                                                                           |

The login page is replaced by `login_hint`: the named test user "signs in and consents"; `consent=deny` declines.
Everything else follows the RFCs. Real projects would put Keycloak or Auth0 here; our own server lets the tests
mint broken tokens with the real key and rotate keys mid-test, which a hosted IdP does not allow.

### Clients and scopes

| Client            | Type                  | Grant                              | Scopes                                             |
| ----------------- | --------------------- | ---------------------------------- | -------------------------------------------------- |
| `ledger-web`      | public (no secret)    | Authorization Code + PKCE, refresh | `accounts:read` `accounts:write` `transfers:write` |
| `cashier-service` | confidential (secret) | Client Credentials                 | `accounts:read:all` `deposits:write`               |
| `reporting`       | confidential (secret) | Client Credentials                 | `accounts:read:all`                                |

| Ledger API operation                  | Needs                                  | Data rule                                    |
| ------------------------------------- | -------------------------------------- | -------------------------------------------- |
| `POST /accounts`                      | `accounts:write`                       | the account belongs to the token's `sub`     |
| `GET /accounts/{id}`, `/transactions` | `accounts:read` or `accounts:read:all` | own accounts only, unless `:all`; else 404   |
| `POST /accounts/{id}/deposits`        | `deposits:write`                       | back office only                             |
| `POST /transfers`                     | `transfers:write`                      | spend only from your own account; pay anyone |
| `GET /health`                         | nothing                                | public                                       |

Someone else's account answers **exactly like a missing one** (404, same body), so ids cannot be probed.

### What the API checks in a token, in order

1. `Authorization: Bearer <token>` (scheme case-insensitive); nothing else, not `?access_token=`.
2. Algorithm is **ES256** (allow-list; `none` and `HS256` are refused).
3. `kid` is in the JWKS; the signature verifies.
4. `typ` is `at+jwt` (RFC 9068), so an ID token cannot be used as an access token.
5. `iss` is our authorization server, `aud` is `ledger-api`.
6. `exp` not passed (30 s clock tolerance); `iat`, `sub`, `client_id` present.
7. The scope for the operation; then the ownership rule in SQL.

401 answers carry `WWW-Authenticate: Bearer realm="ledger-api", error="invalid_token"` (bare `Bearer realm=…`
when no token was sent, RFC 6750 §3.1); 403 carries `error="insufficient_scope", scope="…"`.

## What the tests check (66)

| Spec                      | Technique                                   | Examples                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discovery.spec`          | Contract testing                            | RFC 8414 metadata: only `code`, only `S256`, no implicit or password grant; JWKS has public ES256 keys and no private `d`; the token is `at+jwt` with `iss`, `aud`, `sub`, 900 s lifetime, unique `jti`                                                                                                                                                          |
| `authorization-code.spec` | State transition, negative, boundary values | full flow with `state` and RFC 9207 `iss`; `Cache-Control: no-store`; wrong verifier; a 42-character verifier (limit 43); code used twice (and its session revoked); code expiry on a 1-second server; 7 bad `redirect_uri`s answered on the page, never redirected (prefix, traversal, query, port, host); 6 errors redirected with `error` and `state`         |
| `client-credentials.spec` | Equivalence partitioning, negative          | Basic and `client_secret_post`; narrower scope allowed, wider refused; wrong secret → 401 with a Basic challenge; public client, secret on a public client, password grant, no grant, wrong grant for the client; JSON instead of a form                                                                                                                         |
| `refresh.spec`            | State transition                            | rotation; **reuse of an old refresh token kills the newer one too**; scope may narrow, never widen; bound to its client                                                                                                                                                                                                                                          |
| `jwt-validation.spec`     | Security testing, forged inputs             | 11 forged tokens → 401 and nothing changes: expired, other `iss`, other `aud`, `typ: JWT`, no `client_id`, claims edited after signing, attacker's key with the real `kid`, `alg: none`, HS256 with the public key as secret, unknown `kid`, garbage; expiry inside the 30 s tolerance still accepted; no header; token in the query; Basic; lower-case `bearer` |
| `access-control.spec`     | OWASP API1 (BOLA), API5 (BFLA)              | `owner_sub` and `initiated_by` in the database; Bob cannot see or spend Alice's account (same 404 as a missing id); Bob may pay Alice; Bob reusing Alice's `Idempotency-Key` gets 422, not her transfer; reporting reads but cannot write (403 with the scope named); a user cannot deposit; a read-only login cannot pay; 401 before 400                        |
| `key-rotation.spec`       | Resilience                                  | new key works at once (unknown `kid` → JWKS refetch), the old one until retired, then 401 once the cache is stale; 20 requests → at most one JWKS download; auth server down → tokens still verify from the cache                                                                                                                                                |

Plus three unit tests of the report masking (below). The existing 50 Ledger tests now run with real tokens: the
user's for accounts and transfers, the cashier service's for deposits.

## Do the tests catch real bugs?

Each bug below was planted in the code, the suite run, and the change reverted (mutation testing by hand):

| Planted bug                                        | Caught by                                               |
| -------------------------------------------------- | ------------------------------------------------------- |
| audience not checked                               | `a token for another API (aud)`                         |
| issuer not checked                                 | `another issuer`                                        |
| `typ` not checked                                  | `an ID token instead of an access token`                |
| 10 days of clock tolerance                         | `expired 2 minutes ago`                                 |
| `GET /accounts/{id}` ignores the owner             | `BOLA: Bob cannot see Alice's account`                  |
| a transfer ignores who owns the source account     | `BOLA: Bob cannot spend from Alice's account`           |
| the caller left out of the idempotency fingerprint | `Bob reusing Alice's Idempotency-Key`                   |
| `accounts:write` also allows deposits              | `BFLA: a user cannot put cash…`, `a reporting service…` |
| PKCE verifier not compared                         | `a wrong code_verifier`                                 |
| a code can be used twice                           | `a code works once…`                                    |
| refresh reuse not detected                         | `reusing an old refresh token…`                         |
| `redirect_uri` checked by prefix                   | prefix, traversal, extra query (3 tests)                |
| the JWT signature left in the report               | unit `a JWT keeps its readable header and claims…`      |

13 of 13 caught.

## Tokens in a public report

The Allure report is public. `src/api/redact.ts` keeps a JWT's header and claims readable (they are what you
want to see when a test fails) but replaces the signature with `***`, so no attachment is a working token. Codes,
`code_verifier`, refresh tokens, client secrets and the `Authorization` header are masked as well. The client
secrets in `services/auth-server/src/clients.ts` are throwaway values of an in-memory server that exists only while
the tests run; the signing keys are generated fresh on every start.

## Findings and limits

- **Access tokens cannot be recalled.** Revoking a refresh-token family stops new tokens, but an access token
  already issued stays valid until `exp` (15 minutes). That is the trade-off of self-contained JWTs; the fix is a
  short lifetime or token introspection.
- **Key retirement is not instant.** A retired key keeps working until the API's JWKS cache goes stale (10 minutes
  by default). The rotation test measures it with a 1-second cache.
- **The authorization server can go down** without stopping the API: keys are cached. The test proves it.

## Running

```bash
npm run test:auth                        # only the OAuth suite (Docker for the Ledger part)
npx playwright test tests/auth/refresh.spec.ts   # authorization server only, no Docker needed
DATABASE_URL=postgres://… npm run ledger:dev     # auth server on :3101, Ledger API on :3100
```

## Standards used

RFC 6749 (OAuth 2.0), RFC 6750 (Bearer tokens), RFC 7636 (PKCE), RFC 7519 (JWT), RFC 7517 (JWK), RFC 8414
(server metadata), RFC 9068 (JWT access tokens), RFC 9207 (`iss` in the authorization response), OAuth 2.0
Security Best Current Practice (RFC 9700), OAuth 2.1 draft (no implicit or password grant, PKCE for everyone),
OWASP API Security Top 10 (2023).
