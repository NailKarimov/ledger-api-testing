# api-test-automation

[![Tests](https://github.com/NailKarimov/api-test-automation/actions/workflows/tests.yml/badge.svg)](https://github.com/NailKarimov/api-test-automation/actions/workflows/tests.yml)
[![Allure report](https://img.shields.io/badge/report-Allure-orange)](https://nailkarimov.github.io/api-test-automation/)
[![Fuzz](https://github.com/NailKarimov/api-test-automation/actions/workflows/fuzz.yml/badge.svg)](https://github.com/NailKarimov/api-test-automation/actions/workflows/fuzz.yml)
[![Contract](https://github.com/NailKarimov/api-test-automation/actions/workflows/contract.yml/badge.svg)](https://github.com/NailKarimov/api-test-automation/actions/workflows/contract.yml)

API test automation for public REST and GraphQL APIs. One framework, three systems under test:

- **[OpenWeather API](https://openweathermap.org/api)** — read-only API with live data: contract validation,
  boundary values, unit conversions, authentication, geocoding, forecast and air quality.
- **[Swagger Petstore v3](https://petstore3.swagger.io)** — CRUD API with an OpenAPI document: full resource
  lifecycle, search, input validation, negative tests, and checks of the server against its own contract.

- **[Sock Shop](https://github.com/microservices-demo/microservices-demo)** — a payment-centred microservices demo
  (catalogue, carts, user, orders, payment, shipping behind a gateway) that runs in **Docker**: service-level
  tests, an end-to-end order flow across services, payment limits, and fault injection (a container is stopped
  and the system must degrade cleanly).

**Playwright (API testing) + TypeScript + zod + Allure + Docker**, run daily in **GitHub Actions**.

## Toolbox

All tools used across the portfolio, by stage of work, with why each one is here and where it lives:
[`docs/toolbox.md`](docs/toolbox.md) · interactive map
[`docs/toolbox.html`](https://nailkarimov.github.io/api-test-automation/toolbox.html).

## What is tested

### OpenWeather (`tests/openweather/`)

| Area            | Spec                   | Technique                             | Examples                                                                                                          |
| --------------- | ---------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Current weather | `current-weather.spec` | Contract testing                      | Schema with physical ranges; by coordinates and by city; unknown city → 404; `lang=de`; `mode=xml`; response time |
| Coordinates     | `coordinates.spec`     | Boundary value analysis               | lat ±90, lon ±180 → 200; ±0.01 outside → 400; non-numeric → 400                                                   |
| Units           | `units.spec`           | Decision table                        | K − 273.15 = °C, °F = °C × 9/5 + 32, mph = m/s × 2.23694 for the same measurement                                 |
| Authentication  | `auth.spec`            | Negative testing                      | No key / invalid key → 401 on weather and geocoding                                                               |
| Geocoding       | `geocoding.spec`       | Equivalence partitioning, consistency | `limit` 1/3/5; unknown place → `[]`; Latvian local name; geocoding ↔ weather agree                                |
| Forecast        | `forecast.spec`        | Data invariants                       | 40 steps, exactly 3 h apart; `cnt` 1/8/40; first step not in the past                                             |
| Air pollution   | `air-pollution.spec`   | Contract testing                      | AQI 1–5; all main pollutants present and non-negative                                                             |

### Swagger Petstore (`tests/petstore/`)

| Area             | Spec                    | Technique                         | Examples                                                                                                         |
| ---------------- | ----------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Pet CRUD         | `pet-crud.spec`         | State transition, lifecycle       | create → read → replace (PUT) → patch (form) → delete → 404; minimal body; idempotent DELETE; unicode round trip |
| Input validation | `pet-validation.spec`   | Negative testing, equivalence     | unknown id → 404; `abc` → 400; malformed JSON → 400; `text/plain` → 415                                          |
| Search           | `pet-search.spec`       | Equivalence partitioning, oracle  | `findByStatus` for each status; a new pet appears and moves between statuses; `findByTags`; invalid status → 400 |
| User and store   | `user-and-store.spec`   | Negative testing, known defects   | login / logout session; store and user-write endpoints currently answer 500 (documented, see below)              |
| API contract     | `openapi-contract.spec` | Contract testing against the spec | `openapi.json` is served; every operation the suite uses is declared; `Pet` required fields and status enum      |

**Known defects.** Tests that describe behaviour required by the OpenAPI document but not delivered by the
public sandbox are marked with `test.fail()` and a `DEF-n` id. They stay green while the defect exists and
turn red the moment the server is fixed, so the marker can be removed. See
[`docs/test-report.md`](docs/test-report.md).

### Property-based fuzzing with Schemathesis (`fuzz/`)

[Schemathesis](https://schemathesis.io) generates the tests from Petstore's OpenAPI document: examples,
boundary values, random and deliberately invalid data, undeclared HTTP methods and stateful chains
(`POST /pet` → `GET /pet/{id}` → `DELETE`). Every response is checked against the spec: no 5xx, documented
status codes, schema, headers, auth. It runs against a **private Petstore container**
([`infra/petstore`](infra/petstore/docker-compose.yml)), never the public sandbox.

First run: 19/19 operations, 3 628 generated cases in 42 s, **83 spec violations grouped into 8 defects
(FZ-1 … FZ-8)**, mostly contract drift. They are accepted in [`fuzz/baseline.json`](fuzz/baseline.json); only a
_new_ failure fails the nightly [`fuzz.yml`](.github/workflows/fuzz.yml) job. Generation is deterministic, so a
red run means the API changed.

Read more: [`docs/schemathesis.md`](docs/schemathesis.md) · visual guide
[`docs/schemathesis.html`](https://nailkarimov.github.io/api-test-automation/schemathesis.html) · latest
[HTML report](https://nailkarimov.github.io/api-test-automation/fuzz/). Run locally:
`pip install -r fuzz/requirements.txt && npm run fuzz:up && npm run fuzz`.

### Contract drift with oasdiff (`contracts/`)

[oasdiff](https://www.oasdiff.com) compares OpenAPI documents and fails on changes that break existing clients.
The approved Petstore contract (`contracts/petstore/openapi.yaml`) is checked nightly against the spec the private
container serves and, report only, against the public sandbox; a pull request that edits the contract is compared
with the base branch. A self-test proves oasdiff rejects a breaking fixture and accepts a compatible one.
First run found **CD-1**: the `swaggerapi/petstore3:unstable` image serves the old 1.0.17 spec, where 7 operations
have no `200` response (accepted in `known-drift.txt`; Schemathesis found the same as FZ-2).
Read more: [`docs/contract-drift.md`](docs/contract-drift.md) · visual guide
[`docs/contract-drift.html`](https://nailkarimov.github.io/api-test-automation/contract-drift.html).

### Consumer-driven contracts with Pact (`tests/contract-consumer/`, `tests/contract-provider/`)

A small consumer, **Pet Adoption Web** (`src/consumers/AdoptionClient.ts`), records the five Petstore interactions
it relies on with [Pact](https://docs.pact.io); the resulting `pacts/PetAdoptionWeb-Petstore.json` is then replayed
against the private Petstore container with provider states ("a pet exists"). Verification: **5/5**. A self-test
proves that a contract the provider cannot satisfy is rejected. The pact file is published to
[`/pact/`](https://nailkarimov.github.io/api-test-automation/pact/PetAdoptionWeb-Petstore.json).
Read more: [`docs/pact.md`](docs/pact.md) · visual guide
[`docs/pact.html`](https://nailkarimov.github.io/api-test-automation/pact.html). Run: `npm run fuzz:up && npm run test:contract`.

### GraphQL (`tests/graphql/`)

34 tests against the public [Rick and Morty API](https://rickandmortyapi.com/documentation): field selection,
variables, aliases, fragments, pagination boundaries, filters, the `errors` array (validation, syntax, variables),
security (depth limit 4/5 boundary, introspection, batching, a 200-alias query, field-name suggestions), a REST-twin
oracle (GraphQL and `/api/...` must agree), and schema drift with GraphQL Inspector against
`contracts/rickandmorty/schema.graphql`. Findings: **GQL-2** no query cost limit, **GQL-3** field-name suggestions,
**GQL-5** syntax errors answered by the Stellate edge cache without a location. The client is polite to the
rate-limited service (spacing, waits out a 429). Read more: [`docs/graphql.md`](docs/graphql.md) · visual guide
[`docs/graphql.html`](https://nailkarimov.github.io/api-test-automation/graphql.html). Run: `npm run test:graphql`.

### Security headers (`tests/security/`)

One spec runs the same checks against all three systems: HSTS, `X-Content-Type-Options`, `X-Powered-By`,
version in the `Server` header, CORS (no `*` with credentials, no reflected origin), `OPTIONS` that does not
describe the API, and error bodies without stack traces or class names. Findings the servers currently have
are marked `test.fail()` with a `SEC-n` id (for example Petstore: no HSTS, `Server: Jetty(9.4.53…)`, WADL on
`OPTIONS`; OpenWeather: `Allow-Origin: *` with `Allow-Credentials: true`). Run: `npm run test:security`.

### Sock Shop microservices (`tests/sockshop/`, `tests/sockshop-chaos/`)

Needs Docker: `npm run stack:up` starts 13 containers from [`infra/sock-shop`](infra/sock-shop/docker-compose.yml).

| Area           | Spec              | Technique                              | Examples                                                                                                                      |
| -------------- | ----------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Payment        | `payment.spec`    | Boundary value analysis, negative      | 100.00 authorised, 100.01 declined; a decline is HTTP 200; invalid input answered with 500 (SS-1)                             |
| Orders         | `orders.spec`     | End-to-end across services, boundaries | cart → order → payment → shipping; total = goods + 4.99; 95.01 + 4.99 passes, 95.02 + 4.99 gets 406; no order after a decline |
| Cart           | `cart.spec`       | State, isolation                       | same sock twice → quantity 2; two customers' carts do not mix; remove by catalogue id; price tampering (SS-6)                 |
| User and cards | `user.spec`       | Security, negative                     | register / login; wrong password answered with 500 (SS-2); full card number and CCV returned in clear text (SS-4)             |
| Catalogue      | `catalogue.spec`  | Contract, pagination, filtering        | size and page; tags filter; `/catalogue/size` equals the list; unknown id answered with 500 (SS-5)                            |
| Gateway        | `gateway.spec`    | Consistency                            | catalogue and tags through the gateway equal the services; register starts an HttpOnly session                                |
| Resilience     | `resilience.spec` | Fault injection                        | payment container stopped → order fails within 30 s, nothing stored, other services up; recovery without repair               |

A step-by-step animated walkthrough, from preparing the machine to removing the images, is in
[`docs/microservices.html`](docs/microservices.html) (open it in a browser).

Defects found in the demo (SS-1 … SS-18) are written as normal tests with `test.fail()`, like the Petstore ones.
If the stack is not running the Sock Shop tests are skipped locally and fail in CI (`REQUIRE_STACK=1`).

#### OWASP API Security Top 10 (`security-owasp.spec.ts`)

Checks mapped to the categories that apply to a service with no real authentication: BOLA — a card or address
is readable by customer id alone, with no session for that customer (SS-13); brute-force protection on login
(SS-14); a maximum page size on the catalogue (SS-15); and the Spring Boot actuator of carts, orders and
shipping, reachable with no authentication (SS-16). SSRF (OWASP API7) is not automated: the orders service
builds internal requests from client-supplied URLs, and probing that safely needs a one-off, scoped check
rather than a repeatable test — see [`docs/test-report.md`](docs/test-report.md) for the details found so far.

#### Events: the `shipping-task` queue (`tests/sockshop-events/`)

The orders service does not call shipping directly: it publishes a task to a RabbitMQ queue, and (in
production) `queue-master` consumes it. That consumer is not started in this compose file, so the queue holds
exactly what the orders service put there — a thin `amqplib` client (`src/sockshop/queue.ts`) checks it
directly. A successful order publishes one message matching its `shipment.id` and `customerId`; a declined
payment publishes nothing; and, as fault injection on the broker itself, an order still succeeds when
RabbitMQ is stopped and its shipping task is silently lost, because the queue is also declared non-durable
(SS-17, SS-18). These tests run serially, after `sockshop` and `sockshop-chaos`, each purging the queue first.

### Load testing (`loadtests/`)

[k6](https://k6.io) scripts run from `grafana/k6:1.8.2` on the Sock Shop's own Docker network
(`scripts/run-k6.mjs`), so they reach services by their compose hostname — no port mapping needed.
`catalogue-browse.js` is read-only (safe at high concurrency); `checkout.js` runs the full
register → address → card → add-to-cart → order flow (writes real data, so it runs at lower concurrency).
Each has three profiles — smoke, load, stress — defined once in [`loadtests/lib/profiles.js`](loadtests/lib/profiles.js).

```bash
npm run stack:up
npm run loadtest:smoke      # catalogue-browse, smoke profile
npm run loadtest:load       # catalogue-browse, load profile
npm run loadtest:stress     # catalogue-browse, stress profile
npm run loadtest:checkout   # checkout, load profile
node scripts/run-k6.mjs checkout stress   # any script × any profile
```

Results (latency and the error rate at each profile, read against this machine's hardware, not as a
capacity number): [`docs/test-report.md`](docs/test-report.md). A manual GitHub Actions workflow
(`.github/workflows/loadtest.yml`, `workflow_dispatch` only — a stress run is not meant to gate every push)
re-runs any script × profile and uploads the k6 summary as an artifact.

### Helpers

| Spec                        | What it checks                                 |
| --------------------------- | ---------------------------------------------- |
| `tests/unit/redact.spec.ts` | The API key never appears in the public report |

Test design, scope, risks and exit criteria: [`docs/test-plan.md`](docs/test-plan.md).

## Design decisions

- **Contracts as code.** Response schemas (zod) live next to each API (`src/openweather/schemas.ts`,
  `src/petstore/schemas.ts`) and include physical or business limits — a humidity of 140 % fails the contract,
  not only a missing field.
- **One HTTP client, one client class per API.** `ApiClient` knows nothing about a specific API; `WeatherClient`
  and `PetstoreClient` expose one method per endpoint. Playwright projects give each API its own `baseURL`.
- **Live data, stable tests.** Weather changes every few minutes, so cross-request comparisons
  (units, translations) run only when the responses share the same measurement time `dt`.
- **Shared sandbox, isolated tests.** The Petstore is public: every test creates its own pet with a unique id
  and removes it afterwards, and never touches records it did not create.
- **Microservices as they run in production.** The Sock Shop is started with Docker Compose and every service
  is published on its own port, so a test can talk to one service, to the gateway, or follow a request through
  several services. Fault-injection tests stop real containers and always put them back.
- **The key never leaves the secret store.** `OPENWEATHER_API_KEY` comes from `.env` locally and from a
  repository secret in CI. Every request is attached to the Allure report with `appid=***`.
- **Gentle on third-party APIs.** About 100 requests per run, two workers, one daily scheduled run.
  No load testing against production services — the k6 load tests only ever target the local Sock Shop.

## Project structure

```
config/env.ts              base URLs and secrets from the environment
src/api/ApiClient.ts       generic HTTP client: GET/POST/PUT/DELETE, redacted request/response in the report
src/openweather/           WeatherClient, zod contracts, reference locations
src/petstore/              PetstoreClient, zod contracts, test data builders
src/sockshop/              SockShopClient, zod contracts for the microservices
src/fixtures.ts            `weather` and `petstore` fixtures injected into tests
tests/openweather/         OpenWeather specs
tests/petstore/            Petstore specs
tests/sockshop/            Sock Shop service and end-to-end specs
tests/sockshop-chaos/      fault-injection specs (stop and restart containers)
infra/sock-shop/           Docker Compose file of the microservices
loadtests/                 k6 load test scripts (catalogue-browse, checkout) and shared profiles
scripts/                   wait-for-stack.mjs, allure-prepare.mjs, run-k6.mjs
tests/unit/                unit tests of helpers
docs/                      test plan, test summary report, static sample of the Allure report
```

## Running locally

Requirements: Node.js 22+, Java 17+ (for the Allure CLI), Docker for the Sock Shop (about 4 GB of free memory;
on Windows, turn virtualization on in the BIOS). OpenWeather tests also need a free API key; the Petstore needs nothing.

```bash
npm ci
cp .env.example .env       # then put your key into OPENWEATHER_API_KEY
npm test                   # everything
npm run test:openweather   # OpenWeather only
npm run test:petstore      # Petstore only (no key needed)
npm run stack:up           # start the Sock Shop microservices in Docker and wait until ready
npm run test:sockshop      # Sock Shop service tests + fault injection (needs the stack)
npm run stack:down         # stop and remove the containers (images stay, next start takes ~32 s)
npm run stack:purge        # same, and delete all 12 images (frees ~3 GB of disk)
npm run test:smoke         # @smoke tests only
npm run lint && npm run typecheck
npm run allure:generate && npm run allure:open
```

In CI the key is the repository secret `OPENWEATHER_API_KEY`
(Settings → Secrets and variables → Actions).

## Tech stack

Playwright Test (APIRequestContext) · TypeScript · zod · Docker Compose · RabbitMQ (amqplib) · k6 · Allure Report · ESLint · Prettier · husky · GitHub Actions

## Allure report

Every test gets `owner`, `layer`, `epic` (system under test) and `severity` (`@smoke` and `@security` are
critical) automatically from a fixture in [`src/fixtures.ts`](src/fixtures.ts). `npm run allure:generate` first
runs [`scripts/allure-prepare.mjs`](scripts/allure-prepare.mjs), which adds failure
[categories](allure/categories.json) (known defects, fixed defects, security findings, infrastructure, product
and test defects), the environment block and, in CI, a link to the run. Run history is restored from
`gh-pages`, so the report shows trends.
