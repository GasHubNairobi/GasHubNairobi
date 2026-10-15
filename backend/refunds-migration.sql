-- Refunds for paid orders that are cancelled. Run once in the Supabase SQL Editor (safe to run again).
-- Optional: the server adds these columns by itself the first time a refund is needed.

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS refund_status TEXT,                -- NULL = no refund | pending | refunded
    ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(12,2),
    ADD COLUMN IF NOT EXISTS refund_phone TEXT,                 -- the M-Pesa number to send the money back to
    ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS refund_mpesa_receipt TEXT,         -- receipt of the money GasHub sent back
    ADD COLUMN IF NOT EXISTS refund_note TEXT,
    ADD COLUMN IF NOT EXISTS refunded_by TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_refund_status ON orders (refund_status) WHERE refund_status IS NOT NULL;

-- Optional: lets a refunded order show payment status "refunded". Run each line only if your payment status columns are
-- enums; if you get "type does not exist" or "already exists", just skip it. Refunds work without it.
-- ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'refunded';
