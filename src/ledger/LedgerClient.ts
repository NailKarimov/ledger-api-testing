import type { ApiClient, ApiResult, Method } from '../api/ApiClient';

export type Account = { id: string; owner: string; currency: string; balance: string; createdAt: string };
export type Transfer = {
  id: string;
  kind: 'deposit' | 'transfer';
  from: string | null;
  to: string;
  amount: string;
  currency: string;
  createdAt: string;
};
export type Problem = { status: number; error: string; message: string };

/**
 * One method per Ledger API endpoint (services/ledger-api). `baseUrl` is the per-worker server.
 * Calls carry an OAuth access token: the signed-in user's for accounts and transfers, the cashier service's
 * for deposits (only the back office puts cash on an account).
 */
export class LedgerClient {
  constructor(
    readonly api: ApiClient,
    readonly baseUrl: string,
    readonly userToken: string,
    readonly cashierToken: string,
  ) {}

  /** The same client acting as another user (or with any other token). */
  as(userToken: string): LedgerClient {
    return new LedgerClient(this.api, this.baseUrl, userToken, this.cashierToken);
  }

  private url(path: string) {
    return `${this.baseUrl}${path}`;
  }

  private auth(token: string, extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${token}`, ...extra };
  }

  /** Raw call with exactly the headers given (no token added), for authentication tests. */
  call<T = Problem>(
    method: Method,
    path: string,
    opts: { headers?: Record<string, string>; body?: unknown } = {},
  ) {
    return this.api.send<T>(method, this.url(path), opts);
  }

  createAccount(body: Record<string, unknown>): Promise<ApiResult<Account & Problem>> {
    return this.api.post(this.url('/accounts'), { body, headers: this.auth(this.userToken) });
  }

  getAccount(id: string): Promise<ApiResult<Account & Problem>> {
    return this.api.send('GET', this.url(`/accounts/${id}`), { headers: this.auth(this.userToken) });
  }

  transactions(id: string): Promise<ApiResult<(Transfer & { entry: string })[]>> {
    return this.api.send('GET', this.url(`/accounts/${id}/transactions`), {
      headers: this.auth(this.userToken),
    });
  }

  deposit(id: string, amount: unknown, token = this.cashierToken): Promise<ApiResult<Transfer & Problem>> {
    return this.api.post(this.url(`/accounts/${id}/deposits`), {
      body: { amount },
      headers: this.auth(token),
    });
  }

  transfer(body: Record<string, unknown>, idempotencyKey?: string): Promise<ApiResult<Transfer & Problem>> {
    return this.api.post(this.url('/transfers'), {
      body,
      headers: this.auth(this.userToken, idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    });
  }

  /** Test helper: a new account with an opening deposit. */
  async funded(owner: string, amount: string, currency = 'EUR'): Promise<Account> {
    const acc = (await this.createAccount({ owner, currency })).body;
    if (Number(amount) > 0) await this.deposit(acc.id, amount);
    return acc;
  }
}

/** A fresh key per logical request, as a real client would generate. */
export const newKey = () => `qa-${crypto.randomUUID()}`;
