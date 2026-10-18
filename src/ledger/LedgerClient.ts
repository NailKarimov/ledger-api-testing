import type { ApiClient, ApiResult } from '../api/ApiClient';

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

/** One method per Ledger API endpoint (services/ledger-api). `baseUrl` is the per-worker server. */
export class LedgerClient {
  constructor(
    readonly api: ApiClient,
    readonly baseUrl: string,
  ) {}

  private url(path: string) {
    return `${this.baseUrl}${path}`;
  }

  createAccount(body: Record<string, unknown>): Promise<ApiResult<Account & Problem>> {
    return this.api.post(this.url('/accounts'), { body });
  }

  getAccount(id: string): Promise<ApiResult<Account & Problem>> {
    return this.api.get(this.url(`/accounts/${id}`));
  }

  transactions(id: string): Promise<ApiResult<(Transfer & { entry: string })[]>> {
    return this.api.get(this.url(`/accounts/${id}/transactions`));
  }

  deposit(id: string, amount: unknown): Promise<ApiResult<Transfer & Problem>> {
    return this.api.post(this.url(`/accounts/${id}/deposits`), { body: { amount } });
  }

  transfer(body: Record<string, unknown>, idempotencyKey?: string): Promise<ApiResult<Transfer & Problem>> {
    return this.api.post(this.url('/transfers'), {
      body,
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
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
