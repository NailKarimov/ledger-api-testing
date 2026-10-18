import { test as base, expect } from '../fixtures';
import { ApiClient } from '../api/ApiClient';
import { createAuthServer, type AuthOptions, type AuthServer } from '../../services/auth-server/src/app.ts';
import { AuthClient } from './oauth';

/** Starts an authorization server on a random local port; its issuer is its own base URL. */
export async function startAuthServer(
  opts: AuthOptions = {},
): Promise<AuthServer & { close(): Promise<void> }> {
  const server = await createAuthServer(opts);
  const address = await server.app.listen({ port: 0, host: '127.0.0.1' });
  server.setIssuer(address);
  return Object.assign(server, { close: () => server.app.close() });
}

/**
 * One authorization server per worker (in memory, no Docker needed). Tests that change its state —
 * key rotation, short lifetimes — start their own with startAuthServer().
 */
export const test = base.extend<{ auth: AuthClient; authServer: AuthServer }, { authEnv: AuthServer }>({
  authEnv: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startAuthServer();
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],
  authServer: async ({ authEnv }, use) => use(authEnv),
  auth: async ({ authEnv, request }, use) => use(new AuthClient(new ApiClient(request), authEnv.issuer)),
});

export { expect };
