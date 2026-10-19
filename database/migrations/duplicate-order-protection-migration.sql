-- Duplicate-order protection (optional: the server also creates these on first use).
-- Each "Place order" tap carries a one-time key; the same key can never create a second order for the same customer.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS orders_customer_idem_idx
    ON orders (customer_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
