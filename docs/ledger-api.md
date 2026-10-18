# Ledger API: database testing with PostgreSQL and Testcontainers

Visual version (one database per worker, transfer simulator with live tables, race of 25 requests, bugs the
tests catch, RU/EN): [`docs/ledger-api.html`](https://nailkarimov.github.io/api-test-automation/ledger-api.html).

## What it is

A small money service written for this repository, so the tests can look **inside the database**, which a public
API never allows. Domain: wallets and transfers, the kind of system where a missed check loses real money.

- `services/ledger-api` — Fastify + PostgreSQL (`pg`), about 320 lines including the SQL schema.
- `tests/ledger` — 47 tests that check every API answer against the rows actually stored.
- **Testcontainers** starts a throw-away PostgreSQL for every Playwright worker, the migrations run from scratch,
  and the API listens on a random port in the same process. Nothing is shared, nothing is left behind.

## The API

| Endpoint                          | Rules                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /accounts`                  | `owner` 1–100 characters (trimmed), `currency` ISO 4217 (`EUR`); starts at `0.00`      |
| `GET /accounts/{id}`              | 404 unknown, 400 not a UUID                                                            |
| `POST /accounts/{id}/deposits`    | `amount` is a decimal **string**, 0.01 … 1 000 000.00, at most 2 places                |
| `POST /transfers`                 | `Idempotency-Key` header required; different accounts, same currency, never below zero |
| `GET /accounts/{id}/transactions` | the account's ledger entries, signed                                                   |

Errors are problem objects: `{ status, error, message }` (`insufficient_funds`, `currency_mismatch`,
`idempotency_key_reused`, …). SQL and stack traces never reach the client.

**Schema** (`migrations/001_init.sql`): `accounts` (balance `numeric(14,2)`, `CHECK (balance >= 0)`), `transfers`
(`CHECK (amount > 0)`, `CHECK (from_account <> to_account)`, unique `idempotency_key`) and `ledger_entries`:
**double-entry bookkeeping**, every movement is two entries that sum to zero.

**How a transfer works**: one transaction; both accounts are locked with `SELECT … FOR UPDATE` **in id order**
(so A→B and B→A cannot deadlock); balance check; one `transfers` row, two `ledger_entries`, two balance updates;
commit. A retry with the same key and body returns the stored transfer (`200`, `Idempotent-Replayed: true`); two
simultaneous first attempts are settled by the unique index.

## What the tests check (47)

| Spec                 | Technique                                      | Examples                                                                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts.spec`      | API ↔ DB, equivalence partitioning, boundaries | stored row equals the response; owner 100 chars ok, 101 rejected; invalid input → 400 **and no row inserted**                                                                                                                                  |
| `deposits.spec`      | boundary value analysis                        | 0.01, 1 000 000.00 accepted; 0, 0.001, 1 000 000.01, a number instead of a string, `1e3` rejected, balance and ledger untouched                                                                                                                |
| `transfers.spec`     | state, atomicity                               | balances, one row, two entries summing to zero; the whole balance can go; **one cent more → 422 and nothing changed**; same account, unknown account, other currency                                                                           |
| `idempotency.spec`   | retries                                        | same key → same transfer, charged once; `"40"` = `"40.00"`; same key, other amount → 422; no key → 400; **10 simultaneous retries → one charge**                                                                                               |
| `concurrency.spec`   | race conditions                                | **25 parallel transfers of 10 from 100 → exactly 10 succeed, balance 0.00**; 20 crossing A↔B transfers all complete                                                                                                                            |
| `db-invariants.spec` | database invariants, defence in depth          | every balance = sum of its entries; every movement = 2 entries summing to 0; all balances = all deposits; the schema itself refuses a negative balance, a zero transfer, a self-transfer, `eur`, an orphan entry; migrations ran in a fresh DB |

## Do the tests catch bugs? Five bugs planted by hand

Each bug was put into the service, the suite was run against a real PostgreSQL, and the change was reverted
(a manual form of **mutation testing**):

| Planted bug                                          | Caught by                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| row lock removed (`FOR UPDATE` deleted)              | both concurrency tests                                                                                 |
| `balance <= amount` instead of `balance < amount`    | "the whole balance can be sent", 25 parallel transfers                                                 |
| idempotency lookup removed                           | "same key, different amount" (the unique index still blocked double charges, a second line of defence) |
| credit entry forgotten (only the debit written)      | 8 tests across transfers, idempotency and concurrency                                                  |
| accounts locked in request order instead of id order | "A→B and B→A … no deadlock" (PostgreSQL logged `deadlock detected`)                                    |

All five were caught. The third one shows why the schema constraints matter: the code bug was real, the database
still prevented the damage.

## Testcontainers in this repository

`src/ledger/fixtures.ts` defines a **worker-scoped** fixture:

1. `new PostgreSqlContainer('postgres:16-alpine').start()` — a new database container (Testcontainers picks a free
   port and waits until PostgreSQL accepts connections; its Ryuk container removes leftovers even after a crash);
2. `migrate()` applies `migrations/*.sql` and records them in `schema_migrations`;
3. `buildApp(pool).listen({ port: 0 })` starts the API in-process;
4. after the worker's last test: API closed, pool ended, container stopped.

With two CI workers there are two databases, so tests inside one worker can assert exact row counts. Without Docker
the tests are skipped locally (they fail in CI, `REQUIRE_STACK=1`). `LEDGER_DATABASE_URL` (an admin URL) uses an
existing PostgreSQL instead and creates a database per worker.

## Running it

```bash
npm run test:ledger                                    # needs Docker: Testcontainers does the rest
LEDGER_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run test:ledger   # an existing server
DATABASE_URL=postgres://postgres@localhost:5432/ledger npm run ledger:dev             # run the API by hand on :3100
```

## Terms

| Term                             | Meaning                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Testcontainers                   | library that starts real dependencies (databases, brokers) in throw-away Docker containers from test code |
| Migration                        | a versioned schema change script, applied in order and recorded                                           |
| Transaction / atomicity          | a group of changes that either all happen or none do                                                      |
| Row lock (`SELECT … FOR UPDATE`) | blocks other transactions from changing the same rows until commit                                        |
| Race condition                   | the result depends on the timing of parallel requests                                                     |
| Deadlock                         | two transactions each wait for a lock the other holds; PostgreSQL aborts one                              |
| Idempotency key                  | a client-generated id that makes a retried request safe to repeat                                         |
| Double-entry ledger              | every movement is recorded twice (debit and credit) and the entries sum to zero                           |
| Invariant                        | a property that must hold for all data at all times                                                       |
| Mutation testing                 | planting small bugs to check that the tests notice them                                                   |
