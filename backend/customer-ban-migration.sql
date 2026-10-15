-- GasHub: ban / delete customer accounts (admin).
-- Run once in the Supabase SQL Editor. Safe to re-run.

-- 1) Ban details on the customer's own row. A banned customer has status = 'suspended'.
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_by  TEXT;

-- 2) Blocklist. Deleting an account scrubs the email/phone/Google id, which would let a banned person
--    sign up again. When a BANNED account is deleted, a one-way hash (SHA-256) of each is kept here so
--    registration can refuse them. No readable personal details are stored in this table.
CREATE TABLE IF NOT EXISTS banned_identities (
  id            BIGSERIAL PRIMARY KEY,
  identity_hash TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,            -- 'email' | 'phone' | 'provider'
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
