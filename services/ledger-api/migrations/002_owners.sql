-- OAuth 2.0: every account belongs to the subject (`sub` claim) that opened it, and every transfer records
-- who initiated it. Existing rows would need a backfill; the test databases start empty.

ALTER TABLE accounts ADD COLUMN owner_sub text NOT NULL CHECK (length(owner_sub) BETWEEN 1 AND 200);
CREATE INDEX accounts_owner_sub ON accounts (owner_sub);

ALTER TABLE transfers ADD COLUMN initiated_by text;
