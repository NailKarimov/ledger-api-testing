# Test summary report: Ledger API and OAuth 2.0 (ledger-api-testing)

The structure follows ISO/IEC/IEEE 29119-3 (test completion report), shortened.

- **Period:** 18.10.2026 – 23.10.2026
- **Build:** `main`, latest nightly run in GitHub Actions
- **Allure report:** https://nailkarimov.github.io/ledger-api-testing/

## 1. Summary

All 119 tests pass. No money is created or lost under retries, races or failed transfers. Every forged token is
refused, and users reach only their own accounts.

## 2. Results

| Metric                    | Value                                            |
| ------------------------- | ------------------------------------------------ |
| Tests run                 | 119: 48 ledger, 66 OAuth / JWT, 5 unit           |
| Passed / failed / skipped | 119 / 0 / 0                                      |
| Duration                  | ~20 s (containers start in parallel per worker)  |
| Mutation check            | 18 of 18 planted bugs caught (5 ledger, 13 auth) |

## 3. Planted bugs and what caught them

| Area   | Planted bug                                                                                      | Caught by                                     |
| ------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| ledger | no row lock                                                                                      | concurrency: 25 parallel transfers            |
| ledger | `<=` instead of `<` in the balance check                                                         | transfers: one cent over the balance          |
| ledger | a lost credit entry                                                                              | invariants: balance = sum of entries          |
| ledger | no idempotency lookup                                                                            | idempotency: a retry charges once             |
| ledger | wrong lock order                                                                                 | concurrency: crossing A↔B transfers           |
| auth   | 13 bugs, for example no `aud` check, a prefix-matched `redirect_uri`, refresh reuse not detected | the JWT, authorization-code and refresh specs |

## 4. Deviations from the plan

None.

## 5. Recommendations

1. Keep the SQL invariants after every test. They catch bugs that no single response shows.
2. Add a token-binding (DPoP) suite if the service ever issues tokens to public clients outside the browser.
