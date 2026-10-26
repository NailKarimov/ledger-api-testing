# ledger-api-testing

[![Tests](https://github.com/NailKarimov/ledger-api-testing/actions/workflows/tests.yml/badge.svg)](https://github.com/NailKarimov/ledger-api-testing/actions/workflows/tests.yml)
[![Allure report](https://img.shields.io/badge/report-Allure-orange)](https://nailkarimov.github.io/ledger-api-testing/)
[![Release](https://img.shields.io/github/v/release/NailKarimov/ledger-api-testing)](https://github.com/NailKarimov/ledger-api-testing/releases)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/NailKarimov/ledger-api-testing?quickstart=1)

### ▶ Open online

| Page                                                                                              | What it is        |
| ------------------------------------------------------------------------------------------------- | ----------------- |
| **[Allure test report](https://nailkarimov.github.io/ledger-api-testing/)**                       | latest CI run     |
| [Ledger API and Testcontainers](https://nailkarimov.github.io/ledger-api-testing/ledger-api.html) | interactive guide |
| [OAuth 2.0 and JWT](https://nailkarimov.github.io/ledger-api-testing/oauth-jwt.html)              | interactive guide |

Click these links: opening an `.html` file in the file list shows its source code, GitHub does not run it.

Database and authorization testing on a money service of our own. Every API answer is checked **against the rows
actually stored in PostgreSQL**. Tokens come from our own OAuth 2.0 authorization server, so the tests can forge
them.

|                        |                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **System under test**  | own Ledger API (Fastify + PostgreSQL: accounts, deposits, idempotent transfers, a double-entry ledger) and own OAuth 2.0 server (ES256 JWT, PKCE, client credentials, rotating refresh tokens, JWKS)                            |
| **Language and tools** | TypeScript · Playwright Test · Testcontainers · PostgreSQL 16 · node-postgres · jose · Allure                                                                                                                                   |
| **Types of testing**   | functional API, database integration, transactions and concurrency, security (OAuth 2.0, JWT, BOLA, BFLA)                                                                                                                       |
| **Tests**              | 119: 48 ledger, 66 OAuth / JWT, 5 unit                                                                                                                                                                                          |
| **Test quality**       | 18/18 planted bugs caught: 5 in the ledger, 13 in the token checks and the authorization server                                                                                                                                 |
| **Reports**            | [Allure](https://nailkarimov.github.io/ledger-api-testing/) · [ledger guide](https://nailkarimov.github.io/ledger-api-testing/ledger-api.html) · [OAuth guide](https://nailkarimov.github.io/ledger-api-testing/oauth-jwt.html) |

## What is tested

| Suite                                | Tool                       | What it proves                                                                                                                                                                                                                                            |
| ------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ledger/accounts`, `ledger/deposits` | Playwright + node-postgres | stored rows equal the responses; boundaries of the amount (0.01 … 1 000 000.00, 2 decimals); invalid input → 400 **and nothing stored**                                                                                                                   |
| `ledger/transfers`                   | Playwright + node-postgres | balances, one transfer row, two entries summing to zero; one cent over the balance → 422 and the database unchanged                                                                                                                                       |
| `ledger/idempotency`                 | Playwright                 | a retry with the same key charges once; 10 simultaneous retries → one charge; same key, other amount → 422                                                                                                                                                |
| `ledger/concurrency`                 | Playwright                 | 25 parallel transfers of 10 from 100 → exactly 10 succeed; crossing A↔B transfers never deadlock                                                                                                                                                          |
| `ledger/db-invariants`               | SQL                        | every balance = the sum of its entries; the schema itself refuses a negative balance, a zero or self transfer, an orphan entry                                                                                                                            |
| `auth/*` (66)                        | Playwright + jose          | 11 forged tokens refused (`alg: none`, HS256 key confusion, an attacker's key, edited claims, expired, wrong `iss`, `aud` or `typ`); BOLA and BFLA; PKCE, `redirect_uri` and code rules; refresh reuse revokes the session; JWKS caching and key rotation |

## Findings

- **The schema is a second line of defence.** CHECK and FOREIGN KEY constraints refuse a negative balance, an
  orphan entry or a self transfer even when the API code is bypassed. The invariant tests write to the database
  directly to prove it.
- **Lock order matters.** The planted "wrong lock order" bug deadlocked crossing transfers. Only the concurrency
  test with A↔B traffic caught it.
- **Tokens in a public report.** The Allure report keeps the readable claims of tokens but cuts the signature, so
  no token from a report can be replayed.

## Running it

No local setup: the **Open in GitHub Codespaces** badge starts a browser VS Code with this repository, its tools and Docker; the container runs `npm ci` on creation, then `npm test` works in the terminal.

Requirements: Node.js 22+, Docker (Testcontainers), Java 17+ for a local Allure report.

```bash
npm ci
npm test                       # everything; a fresh PostgreSQL container per worker
npm run test:ledger            # ledger only
npm run test:auth              # OAuth 2.0 / JWT only
LEDGER_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run test:ledger   # an existing server
DATABASE_URL=postgres://postgres@localhost:5432/ledger npm run ledger:dev             # auth :3101, API :3100
```

## Project structure

```text
services/ledger-api/       the system under test: Fastify app, SQL migrations
services/auth-server/      the OAuth 2.0 authorization server
src/ledger/, src/auth/     API clients, token helpers, forgers
src/support/               Testcontainers database per worker, the API in-process
src/fixtures.ts            database, ledger, auth fixtures
tests/ledger/              ledger specs
tests/auth/                OAuth 2.0 / JWT specs
tests/unit/                redaction of tokens in the report
docs/                      test plan, test report, guides
```

## CI

`.github/workflows/tests.yml` runs on push, pull request, nightly at 03:00 UTC and on demand: lint, format,
typecheck and all tests with Testcontainers, then the Allure report with history on GitHub Pages.

Releases: committing `.github/releases/<tag>.md` runs the Release workflow, which creates the tag and the GitHub release with that file as its notes.

## Documentation

| Document                                                                                                                | What it is                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`docs/test-plan.md`](docs/test-plan.md)                                                                                | test plan (ISO/IEC/IEEE 29119-3)                                                                  |
| [`docs/test-report.md`](docs/test-report.md)                                                                            | test summary report: latest results, findings, recommendations                                    |
| [`docs/ledger-api.md`](docs/ledger-api.md) · [visual](https://nailkarimov.github.io/ledger-api-testing/ledger-api.html) | database testing with Testcontainers: atomicity, idempotency, races, invariants, the planted bugs |
| [`docs/oauth-jwt.md`](docs/oauth-jwt.md) · [visual](https://nailkarimov.github.io/ledger-api-testing/oauth-jwt.html)    | OAuth 2.0 and JWT: PKCE, forged tokens, BOLA, refresh reuse, key rotation                         |

## Part of a portfolio

One of 13 test automation projects by [Nail Karimov](https://github.com/NailKarimov):
[all projects](https://github.com/NailKarimov) ·
[testing map](https://nailkarimov.github.io/api-test-automation/testing-map.html) ·
[toolbox](https://nailkarimov.github.io/api-test-automation/toolbox.html).
