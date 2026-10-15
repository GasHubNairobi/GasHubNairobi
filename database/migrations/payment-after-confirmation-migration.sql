-- Pay after the dealer confirms (optional: the server also creates these on start).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method_chosen BOOLEAN NOT NULL DEFAULT TRUE;  -- existing orders count as already chosen
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pay_notice_sent_at TIMESTAMPTZ;
