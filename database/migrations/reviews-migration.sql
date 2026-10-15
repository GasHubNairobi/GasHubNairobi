-- Dealer reviews after a completed order.
-- The server also does this automatically the first time it is needed, so running
-- this file is optional. Match the type of orders.id (UUID shown here).

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS order_id UUID;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS comment TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- "Maybe later" on the popup: do not ask again about this order
ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_skipped_at TIMESTAMPTZ;

-- One review per order
CREATE UNIQUE INDEX IF NOT EXISTS reviews_one_per_order
    ON reviews (order_id) WHERE order_id IS NOT NULL;
