import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  // Each worker starts its own PostgreSQL container (src/ledger/fixtures.ts).
  workers: 2,
  timeout: 60_000,
  reporter: [[isCI ? 'github' : 'list'], ['html', { open: 'never' }], ['allure-playwright']],
  projects: [
    { name: 'unit', testDir: './tests/unit' },
    // Ledger API (services/ledger-api) on PostgreSQL started by Testcontainers per worker (docs/ledger-api.md).
    { name: 'ledger', testDir: './tests/ledger' },
  ],
});
