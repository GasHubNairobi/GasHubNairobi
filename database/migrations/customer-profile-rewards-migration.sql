-- GasHub: profile, "Earn GasHub Points" and delayed account deletion.
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- Needs social-settings-and-product-views-migration.sql to have been run first (gashub_settings table).

-- 1) Columns on users --------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_scheduled_for TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_key ON users (referral_code) WHERE referral_code IS NOT NULL;

-- 2) points_ledger.reason must accept the new reasons ('referral', 'social_follow').
--    Only changes anything if the column is a Postgres ENUM; a TEXT/VARCHAR column is left alone.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'points_ledger' AND column_name = 'reason' AND data_type = 'USER-DEFINED'
  ) THEN
    ALTER TABLE points_ledger ALTER COLUMN reason TYPE TEXT USING reason::text;
  END IF;
END $$;

-- 3) Referrals and follow claims. The id type of users is detected so the
--    foreign keys match whatever your users table already uses (BIGINT or UUID).
DO $$
DECLARE idtype text;
BEGIN
  SELECT format_type(atttypid, atttypmod) INTO idtype
  FROM pg_attribute WHERE attrelid = 'users'::regclass AND attname = 'id';

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,
      referrer_id %1$s NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referred_id %1$s NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      points_awarded INTEGER
    )$f$, idtype);

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS reward_claims (
      id BIGSERIAL PRIMARY KEY,
      user_id %1$s NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      claim_key TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      points INTEGER,
      UNIQUE (user_id, claim_key)
    )$f$, idtype);
END $$;
CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals (referrer_id);

-- 4) Starting values for the admin "Earn GasHub Points" settings (the admin can change all of these)
INSERT INTO gashub_settings (setting_key, setting_value) VALUES
('earn', '{"enabled":true,"referralPoints":50,"referralRequires":"signup","referralMaxFriends":20,"followPoints":{"facebook":10,"instagram":10,"tiktok":10,"youtube":10,"x":10}}'::jsonb),
('support', '{"whatsapp":"","phone":"","hours":"","website":""}'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;
