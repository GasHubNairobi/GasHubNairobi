-- Forgot / reset password (customers and dealers).
-- The server creates this table by itself on first use; run this only if you prefer to do it by hand.
-- If you ran an older version of this file, run first:  DROP TABLE IF EXISTS password_resets;
CREATE TABLE IF NOT EXISTS password_resets (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL,                         -- users.id is a UUID
    kind        TEXT NOT NULL DEFAULT 'customer',      -- 'customer' or 'dealer'
    token_hash  TEXT NOT NULL UNIQUE,                  -- SHA-256 of the emailed token; the token itself is never stored
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id, created_at DESC);
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;  -- backend-only table
