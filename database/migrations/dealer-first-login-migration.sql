-- GasHub dealer one-time login / mandatory onboarding
-- Run once in the Supabase SQL Editor before using the updated flow.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS initial_login_used BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT TRUE;

-- Existing accounts keep their existing login flow. New temporary dealer accounts
-- explicitly set must_change_password=TRUE and onboarding_completed=FALSE.
