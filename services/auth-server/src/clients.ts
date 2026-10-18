import { createHash } from 'node:crypto';

/**
 * Registered clients and users of the test authorization server. These are throwaway test credentials of an
 * in-memory server that exists only while the tests run; they protect nothing.
 */
export type Client = {
  /** sha256 of the secret, hex. Absent for public clients (a browser app cannot keep a secret). */
  secretSha256?: string;
  grants: ('authorization_code' | 'refresh_token' | 'client_credentials')[];
  scopes: string[];
  redirectUris?: string[];
};

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export const TEST_SECRETS = {
  'cashier-service': 'test-only-cashier-secret',
  reporting: 'test-only-reporting-secret',
} as const;

export const WEB_REDIRECT_URI = 'http://127.0.0.1:5173/callback';

export const DEFAULT_CLIENTS: Record<string, Client> = {
  // The customer-facing web app: a public client, Authorization Code + PKCE, acts for a signed-in user.
  'ledger-web': {
    grants: ['authorization_code', 'refresh_token'],
    scopes: ['accounts:read', 'accounts:write', 'transfers:write'],
    redirectUris: [WEB_REDIRECT_URI],
  },
  // Back office: puts cash on any account.
  'cashier-service': {
    secretSha256: hash(TEST_SECRETS['cashier-service']),
    grants: ['client_credentials'],
    scopes: ['accounts:read:all', 'deposits:write'],
  },
  // Read-only reports over all accounts.
  reporting: {
    secretSha256: hash(TEST_SECRETS.reporting),
    grants: ['client_credentials'],
    scopes: ['accounts:read:all'],
  },
};

export const DEFAULT_USERS = ['alice', 'bob', 'carol'];
