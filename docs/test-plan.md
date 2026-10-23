# Test plan: Ledger API and OAuth 2.0 (ledger-api-testing)

The structure follows ISO/IEC/IEEE 29119-3 (test plan), shortened for one project.

## 1. Context

- **System under test:** a money service of our own (Fastify + PostgreSQL) with a double-entry ledger, and its own
  OAuth 2.0 authorization server issuing ES256 JWTs.
- **Goal:** show that money is never created, lost or double-spent, even under retries and concurrency, and that
  only the owner of an account can see or spend it.
- **References:**
  - ACID transactions;
  - OAuth 2.0 (RFC 6749) with PKCE (RFC 7636);
  - JWT (RFC 7519) and JWKS (RFC 7517);
  - OAuth 2.0 Security BCP (RFC 9700);
  - OWASP API Security Top 10 (2023): API1 BOLA, API5 BFLA.

## 2. Scope

| In scope                                                              | Out of scope                  |
| --------------------------------------------------------------------- | ----------------------------- |
| accounts, deposits, transfers, idempotency keys                       | currencies and exchange       |
| what is stored: rows, entries, constraints                            | backups, replication          |
| Authorization Code + PKCE, Client Credentials, refresh rotation, JWKS | a login UI (users are seeded) |
| token validation, scopes, ownership                                   | performance under load        |

## 3. Quality characteristics (ISO/IEC 25010)

| Characteristic                                      | Covered by                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| Functional correctness                              | stored rows compared with every response; amount boundaries                 |
| Reliability (integrity, fault tolerance)            | atomic transfers, idempotent retries, races, deadlock-free locking          |
| Security (confidentiality, integrity, authenticity) | 11 forged tokens, BOLA and BFLA, PKCE and refresh-reuse rules, key rotation |

## 4. Approach

- **Levels:** the API in-process against a real PostgreSQL in a fresh Testcontainers container per worker.
  Migrations run from scratch.
- **Techniques:**
  - boundary values (0.01, 1 000 000.00, one cent over the balance);
  - state transitions of tokens and sessions;
  - attack catalogues for JWT;
  - invariants checked in SQL after every test.
- **Test quality:** bugs are planted by hand, one at a time (5 in the ledger, 13 in auth). Every one must fail the
  suite.

## 5. Risks

| Risk                                | Mitigation                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| Shared database state between tests | a container per worker, data created per test                                 |
| Race tests pass by luck             | 25 parallel transfers and 10 simultaneous retries, with exact expected counts |
| Secrets in public reports           | token signatures are cut before attaching                                     |

## 6. Entry and exit criteria

- **Entry:** Docker is available; lint, format and typecheck pass.
- **Exit:** all tests pass, the database invariants hold after the run, and every planted bug is caught.

## 7. Deliverables

The test suite, the Allure report on GitHub Pages, [`test-report.md`](test-report.md) and the two guides.
