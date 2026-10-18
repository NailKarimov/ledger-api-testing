# ledger-api-testing

[![Tests](https://github.com/NailKarimov/ledger-api-testing/actions/workflows/tests.yml/badge.svg)](https://github.com/NailKarimov/ledger-api-testing/actions/workflows/tests.yml)
[![Allure report](https://img.shields.io/badge/report-Allure-orange)](https://nailkarimov.github.io/ledger-api-testing/)

Database testing on a service of our own. A public API never lets you look inside its database, so this
repository contains a small but realistic money service and tests that check every API answer **against the rows
actually stored in PostgreSQL**.

- **System under test:** `services/ledger-api` — Fastify + PostgreSQL: accounts, deposits, idempotent transfers, a
  double-entry ledger, row locks and schema constraints.
- **Database per worker:** [Testcontainers](https://testcontainers.com) starts a fresh `postgres:16-alpine` for every
  Playwright worker, runs the migrations from scratch and starts the API in-process; everything is removed afterwards.

| Spec                   | What it proves                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`, `deposits` | stored rows equal the responses; boundaries of the amount rule (0.01 … 1 000 000.00, 2 decimals); invalid input → 400 **and nothing stored**            |
| `transfers`            | balances, one transfer row, two entries summing to zero; one cent more than the balance → 422 and the database unchanged (atomicity)                    |
| `idempotency`          | a retry with the same key charges once; 10 simultaneous retries → one charge; same key, other amount → 422                                              |
| `concurrency`          | 25 parallel transfers of 10 from 100 → exactly 10 succeed, balance 0.00; crossing A↔B transfers never deadlock                                          |
| `db-invariants`        | every balance = sum of its entries; all balances = all deposits; the schema itself refuses a negative balance, a zero or self transfer, an orphan entry |

**Do the tests catch bugs?** Five bugs were planted by hand (no row lock, `<=` instead of `<`, a lost credit
entry, no idempotency lookup, wrong lock order) and all five were caught. Details:
[`docs/ledger-api.md`](docs/ledger-api.md) · visual guide with a transfer simulator:
[`docs/ledger-api.html`](https://nailkarimov.github.io/ledger-api-testing/ledger-api.html).

**Next:** OAuth 2.0 / JWT — only the owner of an account can move its money; expired, forged and `alg=none` tokens.

## Running it

```bash
npm ci
npm run test:ledger                                    # needs Docker; Testcontainers does the rest
LEDGER_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run test:ledger   # an existing server
DATABASE_URL=postgres://postgres@localhost:5432/ledger npm run ledger:dev             # the API by hand on :3100
```

## Part of a portfolio

REST and GraphQL tests of public APIs: [api-test-automation](https://github.com/NailKarimov/api-test-automation) ·
contract testing: [contract-testing-lab](https://github.com/NailKarimov/contract-testing-lab) ·
microservices: [microservices-testing](https://github.com/NailKarimov/microservices-testing) ·
overview: [github.com/NailKarimov](https://github.com/NailKarimov).

**Stack:** TypeScript · Fastify · PostgreSQL · node-postgres · Testcontainers · Playwright Test · Allure · GitHub Actions.
