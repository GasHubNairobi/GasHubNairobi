-- Safe additive migration for the current GasHub public.dealer_applications schema.
-- Run in Supabase SQL Editor if these columns are not already present.
ALTER TABLE public.dealer_applications
  ADD COLUMN IF NOT EXISTS business_registration_number TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_notes TEXT,
  ADD COLUMN IF NOT EXISTS linked_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS linked_dealer_id UUID REFERENCES public.dealers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS temporary_credentials_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_login_required BOOLEAN NOT NULL DEFAULT TRUE;
-- Ensure only the agreed workflow statuses are used: pending, approved, rejected, ignored.
-- Review any existing status constraint/data before changing it; this script intentionally
-- does not drop constraints automatically.
