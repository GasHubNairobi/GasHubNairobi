-- Migration 006: tables used when GasHub runs on Netlify Functions (no memory shared between requests).
-- OPTIONAL: the backend creates both tables automatically the first time it needs them.
-- Run this in the Supabase SQL Editor only if you prefer to create them yourself up front.

-- Admin sessions, dealer sessions and super-admin unlock tokens / failed-attempt counters (tokens are stored hashed)
CREATE TABLE IF NOT EXISTS gashub_sessions (
    kind        TEXT        NOT NULL,
    token_hash  TEXT        NOT NULL,
    data        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (kind, token_hash)
);
CREATE INDEX IF NOT EXISTS gashub_sessions_expires_idx ON gashub_sessions (expires_at);

-- Per-IP request counters for the rate limiter (login attempts, registrations, M-Pesa requests ...)
CREATE TABLE IF NOT EXISTS gashub_rate_limits (
    key       TEXT        PRIMARY KEY,
    hits      INTEGER     NOT NULL,
    reset_at  TIMESTAMPTZ NOT NULL
);

-- Optional hardening: these tables are only ever used by the backend (service connection), never by the browser.
-- Turning on Row Level Security with no policies blocks Supabase's public REST API from reading them.
ALTER TABLE gashub_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE gashub_rate_limits  ENABLE ROW LEVEL SECURITY;
