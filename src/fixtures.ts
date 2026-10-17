import { test as base, expect } from '@playwright/test';
import * as allure from 'allure-js-commons';
import { ApiClient } from './api/ApiClient';
import { WeatherClient } from './openweather/WeatherClient';
import { PetstoreClient } from './petstore/PetstoreClient';
import { SockShopClient } from './sockshop/SockShopClient';
import { ShippingQueue } from './sockshop/queue';
import { GraphQLClient } from './graphql/GraphQLClient';
import { env } from '../config/env';

let stack: Promise<boolean> | undefined;
/** One cheap probe per worker: is the payment service of the Sock Shop answering? */
function stackIsUp(): Promise<boolean> {
  stack ??= fetch(`${env.sockShop.payment}/health`, { signal: AbortSignal.timeout(3_000) })
    .then((r) => r.ok)
    .catch(() => false);
  return stack;
}

type Fixtures = {
  weather: WeatherClient;
  petstore: PetstoreClient;
  /** Rick and Morty GraphQL endpoint; `graph.api` also reaches the REST twin under /api. */
  graph: GraphQLClient;
  shop: SockShopClient;
  /** A connection to the `shipping-task` queue, purged before each test for isolation. */
  queue: ShippingQueue;
  /** Auto fixture: labels every test in the Allure report. */
  allureLabels: void;
};

const OWNER = 'Nail Karimov';
const EPICS: Record<string, string> = {
  openweather: 'OpenWeather',
  petstore: 'Swagger Petstore',
  sockshop: 'Sock Shop',
  'sockshop-chaos': 'Sock Shop',
  'sockshop-events': 'Sock Shop',
  security: 'Security',
  graphql: 'GraphQL (Rick and Morty)',
  'contract-consumer': 'Contract tests (Pact)',
  'contract-provider': 'Contract tests (Pact)',
};

/** @smoke → critical, @security → critical, everything else → normal. */
function severityOf(tags: string[]): 'critical' | 'normal' {
  return tags.includes('@smoke') || tags.includes('@security') ? 'critical' : 'normal';
}

/** Tests receive ready clients: async ({ weather }) => { ... } / async ({ petstore }) => { ... } */
export const test = base.extend<Fixtures>({
  allureLabels: [
    // Playwright requires a destructuring pattern for the fixtures argument.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      await allure.owner(OWNER);
      await allure.layer('api');
      await allure.severity(severityOf(testInfo.tags));
      const epic = EPICS[testInfo.project.name];
      if (epic) await allure.epic(epic);
      await use();
    },
    { auto: true },
  ],
  weather: async ({ request }, use) => {
    if (!env.apiKey) {
      throw new Error(
        'OPENWEATHER_API_KEY is not set: add it to .env locally or as a repository secret in CI.',
      );
    }
    await use(new WeatherClient(new ApiClient(request, env.apiKey)));
  },
  // The Sock Shop runs in Docker on this machine (or on the CI runner). Without it the tests are
  // skipped locally, and fail when REQUIRE_STACK=1 (CI).
  shop: async ({ request }, use) => {
    if (!(await stackIsUp())) {
      const reason = 'Sock Shop is not running: start it with `npm run stack:up`.';
      if (env.requireStack) throw new Error(reason);
      test.skip(true, reason);
    }
    await use(new SockShopClient(new ApiClient(request)));
  },
  // The Petstore sandbox needs no key.
  petstore: async ({ request }, use) => {
    await use(new PetstoreClient(new ApiClient(request)));
  },
  graph: async ({ request }, use) => {
    await use(new GraphQLClient(new ApiClient(request)));
  },
  // eslint-disable-next-line no-empty-pattern
  queue: async ({}, use) => {
    if (!(await stackIsUp())) {
      const reason = 'Sock Shop is not running: start it with `npm run stack:up`.';
      if (env.requireStack) throw new Error(reason);
      test.skip(true, reason);
    }
    const queue = new ShippingQueue();
    await queue.connect();
    await queue.purge();
    await use(queue);
    await queue.close();
  },
});

export { expect };
