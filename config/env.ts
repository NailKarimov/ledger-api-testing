import 'dotenv/config';

/** Reads a variable from the environment (or .env) and falls back to a default. */
function read(name: string, fallback = ''): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

/** Test environment settings. Nothing here is secret. */
export const env = {
  /** In CI a missing Docker (no Testcontainers database) must fail the run instead of skipping it. */
  requireStack: read('REQUIRE_STACK') === '1',
};
