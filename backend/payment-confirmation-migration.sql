-- Payment confirmation flow (cash -> dealer confirms, M-Pesa -> GasHub confirms).
-- Run once in the Supabase SQL Editor (safe to run again). Nothing is dropped or renamed.
-- No new tables are needed: the admin's GasHub payment account is saved in the existing gashub_settings table
-- (setting_key = 'payment_account'), and a customer's M-Pesa code is saved as a "pending" row in payments.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- faster lookups when the admin confirms a payment and when a code is checked for re-use
CREATE INDEX IF NOT EXISTS idx_payments_order   ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_receipt ON payments (mpesa_receipt_number) WHERE mpesa_receipt_number IS NOT NULL;
