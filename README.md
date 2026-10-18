# ledger-api-testing

[![Tests](https://github.com/NailKarimov/ledger-api-testing/actions/workflows/tests.yml/badge.svg)](https://github.com/NailKarimov/ledger-api-testing/actions/workflows/tests.yml)
[![Allure report](https://img.shields.io/badge/report-Allure-orange)](https://nailkarimov.github.io/ledger-api-testing/)

Database and authorization testing on a service of our own. A public API never lets you look inside its database
or mint its tokens, so this repository contains a small but realistic money service, its own OAuth 2.0
authorization server, and tests that check every API answer **against the rows actually stored in PostgreSQL**.

- **System under test:** `services/ledger-api` — Fastify + PostgreSQL: accounts, deposits, idempotent transfers, a
  double-entry ledger, row locks and schema constraints.
- **Database per worker:** [Testcontainers](https://testcontainers.com) starts a fresh `postgres:16-alpine` for every
  Playwright worker, runs the migrations from scratch and starts the API in-process; everything is removed afterwards.
- **OAuth 2.0 / JWT:** `services/auth-server` issues ES256 JWT access tokens (Authorization Code + PKCE for the web
  app, Client Credentials for back-office services, rotating refresh tokens, JWKS with key rotation); the Ledger API
  verifies them, checks scopes, and lets a user see and spend **only their own accounts**.

| Spec                   | What it proves                                                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`, `deposits` | stored rows equal the responses; boundaries of the amount rule (0.01 … 1 000 000.00, 2 decimals); invalid input → 400 **and nothing stored**                                                                                                       |
| `transfers`            | balances, one transfer row, two entries summing to zero; one cent more than the balance → 422 and the database unchanged (atomicity)                                                                                                               |
| `idempotency`          | a retry with the same key charges once; 10 simultaneous retries → one charge; same key, other amount → 422                                                                                                                                         |
| `concurrency`          | 25 parallel transfers of 10 from 100 → exactly 10 succeed, balance 0.00; crossing A↔B transfers never deadlock                                                                                                                                     |
| `db-invariants`        | every balance = sum of its entries; all balances = all deposits; the schema itself refuses a negative balance, a zero or self transfer, an orphan entry                                                                                            |
| `auth/*` (66 tests)    | 11 forged tokens refused (`alg: none`, HS256 key confusion, attacker's key, edited claims, expired, wrong `iss`/`aud`/`typ`); BOLA and BFLA; PKCE, `redirect_uri` and code rules; refresh reuse revokes the session; JWKS caching and key rotation |

**Do the tests catch bugs?** Five bugs were planted by hand (no row lock, `<=` instead of `<`, a lost credit
entry, no idempotency lookup, wrong lock order) and all five were caught. Details:
[`docs/ledger-api.md`](docs/ledger-api.md) · visual guide with a transfer simulator:
[`docs/ledger-api.html`](https://nailkarimov.github.io/ledger-api-testing/ledger-api.html).

**OAuth 2.0 / JWT.** 13 more bugs planted in the token checks, scopes, ownership and the authorization server
(no `aud` check, prefix-matched `redirect_uri`, refresh reuse not detected, …): all 13 caught. Tokens in the public
report keep their readable claims but lose the signature. Details: [`docs/oauth-jwt.md`](docs/oauth-jwt.md) · visual
guide where you forge a token and watch the API refuse it:
[`docs/oauth-jwt.html`](https://nailkarimov.github.io/ledger-api-testing/oauth-jwt.html).

## Running it

```bash
npm ci
npm test                                               # everything (119 tests); needs Docker
npm run test:ledger                                    # Ledger only; Testcontainers does the rest
npm run test:auth                                      # OAuth 2.0 / JWT suite
LEDGER_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run test:ledger   # an existing server
DATABASE_URL=postgres://postgres@localhost:5432/ledger npm run ledger:dev             # auth server :3101, API :3100
```

## Part of a portfolio

REST and GraphQL tests of public APIs: [api-test-automation](https://github.com/NailKarimov/api-test-automation) ·
contract testing: [contract-testing-lab](https://github.com/NailKarimov/contract-testing-lab) ·
microservices: [microservices-testing](https://github.com/NailKarimov/microservices-testing) ·
overview: [github.com/NailKarimov](https://github.com/NailKarimov).

**Stack:** TypeScript · Fastify · PostgreSQL · node-postgres · Testcontainers · OAuth 2.0 · JWT (jose) · Playwright Test · Allure · GitHub Actions.
