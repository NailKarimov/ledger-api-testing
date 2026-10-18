import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type pg from 'pg';

/**
 * Ledger API: accounts, deposits and transfers with a double-entry ledger in PostgreSQL.
 * A deliberately small but realistic money service, written to be tested (docs/ledger-api.md).
 *
 * Rules:
 * - amounts are decimal strings with at most 2 places, 0.01 … 1 000 000.00;
 * - a transfer moves money between two different accounts in the same currency, never below zero;
 * - POST /transfers requires an Idempotency-Key: a retry with the same key and body returns the
 *   original transfer and moves no money; the same key with another body is rejected.
 *
 * OAuth 2.0 resource server (docs/oauth-jwt.md): every route except /health needs a Bearer JWT from the
 * authorization server — signature from its JWKS, ES256 only, `typ: at+jwt`, the right `iss` and `aud`,
 * not expired — and a scope. Users see and spend only their own accounts; another user's account is a 404.
 */
const AMOUNT = /^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/;
const MAX_AMOUNT = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Problem = { status: number; error: string; message: string };

export type AuthConfig = {
  issuer: string;
  audience: string;
  jwksUrl: string;
  /** Tolerated clock skew between the servers, seconds. */
  clockToleranceSec?: number;
  /** JWKS cache: how long keys are trusted without a refetch, and the minimum pause between refetches. */
  jwksCacheMaxAgeMs?: number;
  jwksCooldownMs?: number;
};

export type Principal = { sub: string; clientId: string; scopes: string[] };
const problem = (status: number, error: string, message: string): Problem => ({ status, error, message });

function parseAmount(value: unknown): string | Problem {
  if (typeof value !== 'string' || !AMOUNT.test(value)) {
    return problem(
      400,
      'invalid_amount',
      'amount must be a decimal string with at most 2 places, e.g. "10.50"',
    );
  }
  const n = Number(value);
  if (n <= 0 || n > MAX_AMOUNT)
    return problem(400, 'invalid_amount', `amount must be between 0.01 and ${MAX_AMOUNT}`);
  return n.toFixed(2);
}

async function inTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

class HttpProblem extends Error {
  readonly p: Problem;
  readonly headers: Record<string, string>;
  constructor(p: Problem, headers: Record<string, string> = {}) {
    super(p.message);
    this.p = p;
    this.headers = headers;
  }
}

/** RFC 6750 §3: a missing token gets a bare challenge; a bad one names the error. */
function unauthorized(description?: string): HttpProblem {
  const challenge = description
    ? `Bearer realm="ledger-api", error="invalid_token", error_description="${description}"`
    : 'Bearer realm="ledger-api"';
  return new HttpProblem(
    problem(401, description ? 'invalid_token' : 'unauthorized', description ?? 'a Bearer token is required'),
    {
      'WWW-Authenticate': challenge,
    },
  );
}

function forbidden(scopes: string[]): HttpProblem {
  return new HttpProblem(problem(403, 'insufficient_scope', `requires scope ${scopes.join(' or ')}`), {
    'WWW-Authenticate': `Bearer realm="ledger-api", error="insufficient_scope", scope="${scopes.join(' ')}"`,
  });
}

const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;

function verifier(cfg: AuthConfig) {
  const jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(cfg.jwksUrl), {
    cacheMaxAge: cfg.jwksCacheMaxAgeMs ?? 600_000,
    cooldownDuration: cfg.jwksCooldownMs ?? 30_000,
  });
  return async (req: FastifyRequest, anyOf: string[]): Promise<Principal> => {
    const header = req.headers.authorization;
    if (!header) throw unauthorized();
    const m = BEARER.exec(header);
    if (!m) throw unauthorized('malformed Authorization header');
    let payload;
    try {
      ({ payload } = await jwtVerify(m[1]!, jwks, {
        issuer: cfg.issuer,
        audience: cfg.audience,
        algorithms: ['ES256'],
        typ: 'at+jwt',
        clockTolerance: cfg.clockToleranceSec ?? 30,
        requiredClaims: ['exp', 'iat', 'sub', 'client_id'],
      }));
    } catch (error) {
      const reason =
        error instanceof joseErrors.JWTExpired
          ? 'token expired'
          : error instanceof joseErrors.JWTClaimValidationFailed
            ? `claim ${error.claim} is invalid`
            : error instanceof joseErrors.JWKSNoMatchingKey
              ? 'unknown signing key'
              : 'token is invalid';
      throw unauthorized(reason);
    }
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
    if (!anyOf.some((s) => scopes.includes(s))) throw forbidden(anyOf);
    return { sub: payload.sub!, clientId: String(payload.client_id), scopes };
  };
}

const transferView = (t: Record<string, unknown>) => ({
  id: t.id,
  kind: t.kind,
  from: t.from_account,
  to: t.to_account,
  amount: t.amount,
  currency: t.currency,
  createdAt: t.created_at,
});

export function buildApp(pool: pg.Pool, auth: AuthConfig): FastifyInstance {
  const app = Fastify({ logger: false });
  const verify = verifier(auth);
  /** Authenticates the request and checks that the token has one of the scopes. */
  const principal = (req: FastifyRequest, ...anyOf: string[]) => verify(req, anyOf);
  const canReadAll = (p: Principal) => p.scopes.includes('accounts:read:all');

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpProblem)
      return reply.status(error.p.status).headers(error.headers).send(error.p);
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status < 500)
      return reply.status(status).send(problem(status, 'bad_request', (error as Error).message));
    // never leak SQL or stack traces
    return reply.status(500).send(problem(500, 'internal', 'internal error'));
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  app.post('/accounts', async (req, reply) => {
    const me = await principal(req, 'accounts:write');
    const body = (req.body ?? {}) as { owner?: unknown; currency?: unknown };
    if (typeof body.owner !== 'string' || body.owner.trim().length < 1 || body.owner.trim().length > 100) {
      throw new HttpProblem(problem(400, 'invalid_owner', 'owner must be 1–100 characters'));
    }
    if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) {
      throw new HttpProblem(
        problem(400, 'invalid_currency', 'currency must be an ISO 4217 code such as "EUR"'),
      );
    }
    const { rows } = await pool.query(
      'INSERT INTO accounts (owner, currency, owner_sub) VALUES ($1, $2, $3) RETURNING id, owner, currency, balance, created_at',
      [body.owner.trim(), body.currency, me.sub],
    );
    return reply.status(201).send({ ...rows[0], createdAt: rows[0].created_at, created_at: undefined });
  });

  app.get('/accounts/:id', async (req) => {
    const me = await principal(req, 'accounts:read', 'accounts:read:all');
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) throw new HttpProblem(problem(400, 'invalid_id', 'account id must be a UUID'));
    // Someone else's account answers exactly like a missing one: no way to probe which ids exist (BOLA).
    const { rows } = await pool.query(
      'SELECT id, owner, currency, balance, created_at FROM accounts WHERE id = $1 AND (owner_sub = $2 OR $3)',
      [id, me.sub, canReadAll(me)],
    );
    if (!rows[0]) throw new HttpProblem(problem(404, 'not_found', 'account not found'));
    return { ...rows[0], createdAt: rows[0].created_at, created_at: undefined };
  });

  app.get('/accounts/:id/transactions', async (req) => {
    const me = await principal(req, 'accounts:read', 'accounts:read:all');
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) throw new HttpProblem(problem(400, 'invalid_id', 'account id must be a UUID'));
    const exists = await pool.query('SELECT 1 FROM accounts WHERE id = $1 AND (owner_sub = $2 OR $3)', [
      id,
      me.sub,
      canReadAll(me),
    ]);
    if (!exists.rowCount) throw new HttpProblem(problem(404, 'not_found', 'account not found'));
    const { rows } = await pool.query(
      `SELECT e.amount AS entry, t.id, t.kind, t.from_account, t.to_account, t.amount, t.currency, t.created_at
         FROM ledger_entries e JOIN transfers t ON t.id = e.transfer_id
        WHERE e.account_id = $1 ORDER BY e.id`,
      [id],
    );
    return rows.map((r) => ({ ...transferView(r), entry: r.entry }));
  });

  app.post('/accounts/:id/deposits', async (req, reply) => {
    const me = await principal(req, 'deposits:write');
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) throw new HttpProblem(problem(400, 'invalid_id', 'account id must be a UUID'));
    const amount = parseAmount((req.body as { amount?: unknown } | undefined)?.amount);
    if (typeof amount !== 'string') throw new HttpProblem(amount);
    const t = await inTransaction(pool, async (c) => {
      const acc = await c.query('SELECT currency FROM accounts WHERE id = $1 FOR UPDATE', [id]);
      if (!acc.rows[0]) throw new HttpProblem(problem(404, 'not_found', 'account not found'));
      const ins = await c.query(
        `INSERT INTO transfers (kind, to_account, amount, currency, initiated_by) VALUES ('deposit', $1, $2, $3, $4) RETURNING *`,
        [id, amount, acc.rows[0].currency, me.sub],
      );
      await c.query(
        'INSERT INTO ledger_entries (transfer_id, account_id, amount) VALUES ($1, $2, $3), ($1, NULL, -$3::numeric)',
        [ins.rows[0].id, id, amount],
      );
      await c.query('UPDATE accounts SET balance = balance + $2 WHERE id = $1', [id, amount]);
      return ins.rows[0];
    });
    return reply.status(201).send(transferView(t));
  });

  app.post('/transfers', async (req, reply) => {
    const me = await principal(req, 'transfers:write');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
      throw new HttpProblem(
        problem(400, 'idempotency_key_required', 'Idempotency-Key header (8–100 characters) is required'),
      );
    }
    const body = (req.body ?? {}) as { from?: unknown; to?: unknown; amount?: unknown };
    if (
      typeof body.from !== 'string' ||
      !UUID.test(body.from) ||
      typeof body.to !== 'string' ||
      !UUID.test(body.to)
    ) {
      throw new HttpProblem(problem(400, 'invalid_id', 'from and to must be account UUIDs'));
    }
    if (body.from === body.to) throw new HttpProblem(problem(400, 'same_account', 'from and to must differ'));
    const amount = parseAmount(body.amount);
    if (typeof amount !== 'string') throw new HttpProblem(amount);
    const hash = createHash('sha256')
      // The caller is part of the request: another user's key never replays someone else's transfer.
      .update(JSON.stringify([me.sub, body.from, body.to, amount]))
      .digest('hex');

    // A retry: the key was used before.
    const replay = async () => {
      const prev = await pool.query('SELECT * FROM transfers WHERE idempotency_key = $1', [key]);
      if (!prev.rows[0]) return undefined;
      if (prev.rows[0].request_hash !== hash) {
        throw new HttpProblem(
          problem(422, 'idempotency_key_reused', 'Idempotency-Key was already used with a different request'),
        );
      }
      return reply.status(200).header('Idempotent-Replayed', 'true').send(transferView(prev.rows[0]));
    };
    const earlier = await replay();
    if (earlier) return earlier;

    try {
      const t = await inTransaction(pool, async (c) => {
        // Lock both accounts in a fixed order, so A→B and B→A at the same time cannot deadlock.
        const [first, second] = [body.from as string, body.to as string].sort();
        const locked = await c.query(
          'SELECT id, currency, balance, owner_sub FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [[first, second]],
        );
        const from = locked.rows.find((r) => r.id === body.from);
        const to = locked.rows.find((r) => r.id === body.to);
        // Only the owner may spend from an account; anyone may be paid.
        if (!from || !to || from.owner_sub !== me.sub)
          throw new HttpProblem(problem(404, 'not_found', 'account not found'));
        if (from.currency !== to.currency) {
          throw new HttpProblem(
            problem(409, 'currency_mismatch', `cannot transfer ${from.currency} to a ${to.currency} account`),
          );
        }
        if (Number(from.balance) < Number(amount)) {
          throw new HttpProblem(problem(422, 'insufficient_funds', 'not enough money on the source account'));
        }
        const ins = await c.query(
          `INSERT INTO transfers (kind, from_account, to_account, amount, currency, idempotency_key, request_hash, initiated_by)
           VALUES ('transfer', $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [from.id, to.id, amount, from.currency, key, hash, me.sub],
        );
        await c.query(
          'INSERT INTO ledger_entries (transfer_id, account_id, amount) VALUES ($1, $2, -$4::numeric), ($1, $3, $4)',
          [ins.rows[0].id, from.id, to.id, amount],
        );
        await c.query('UPDATE accounts SET balance = balance - $2 WHERE id = $1', [from.id, amount]);
        await c.query('UPDATE accounts SET balance = balance + $2 WHERE id = $1', [to.id, amount]);
        return ins.rows[0];
      });
      return reply.status(201).send(transferView(t));
    } catch (error) {
      // Two requests with the same key raced: the loser hits the unique index and replays the winner.
      if ((error as { code?: string }).code === '23505') {
        const winner = await replay();
        if (winner) return winner;
      }
      throw error;
    }
  });

  return app;
}
