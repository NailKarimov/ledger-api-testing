-- Ledger API schema: accounts, transfers and a double-entry ledger.
-- Constraints are the last line of defence: even a buggy service must not be able to store
-- a negative balance, a zero transfer or a transfer to the same account.

CREATE TABLE accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner       text        NOT NULL CHECK (length(trim(owner)) BETWEEN 1 AND 100),
  currency    char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance     numeric(14, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- kind: 'deposit' (from_account is NULL) or 'transfer'
CREATE TABLE transfers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text        NOT NULL CHECK (kind IN ('deposit', 'transfer')),
  from_account     uuid        REFERENCES accounts (id),
  to_account       uuid        NOT NULL REFERENCES accounts (id),
  amount           numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency         char(3)     NOT NULL,
  idempotency_key  text        UNIQUE,
  request_hash     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (from_account IS DISTINCT FROM to_account),
  CHECK ((kind = 'deposit') = (from_account IS NULL))
);

-- Every movement is two entries that sum to zero (a deposit's counter-entry has account_id NULL:
-- money coming from outside the system).
CREATE TABLE ledger_entries (
  id           bigserial PRIMARY KEY,
  transfer_id  uuid        NOT NULL REFERENCES transfers (id),
  account_id   uuid        REFERENCES accounts (id),
  amount       numeric(14, 2) NOT NULL CHECK (amount <> 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account ON ledger_entries (account_id);
