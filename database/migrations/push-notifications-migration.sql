-- Phone push notifications: one row per phone / browser that turned notifications on.
-- Run once in the Supabase SQL Editor (safe to run again). The table is also created automatically the first time it is needed,
-- so this file is optional - but running it keeps every change in one place.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id           BIGSERIAL PRIMARY KEY,
    role         TEXT NOT NULL CHECK (role IN ('customer','dealer')),
    owner_id     TEXT NOT NULL,                 -- the customer's or dealer's id
    endpoint     TEXT NOT NULL,                 -- the phone's address at Google / Apple / Mozilla's push service
    p256dh       TEXT NOT NULL,                 -- encryption keys sent by the browser (not secrets of yours)
    auth         TEXT NOT NULL,
    user_agent   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (role, endpoint)
);
CREATE INDEX IF NOT EXISTS push_subscriptions_owner_idx ON push_subscriptions (role, owner_id);

-- lock it against Supabase's public REST API like every other table (same as migration 007)
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_subscriptions FROM anon, authenticated;
