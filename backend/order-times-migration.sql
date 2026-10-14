-- Exact order times. The server also runs this by itself on start; run it by hand in the Supabase SQL Editor only if you prefer. Safe to run again.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS confirmed_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS paid_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS delivered_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS completed_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cancelled_at  TIMESTAMPTZ;

UPDATE orders o
   SET paid_at = p.first_paid
  FROM (SELECT order_id, MIN(paid_at) AS first_paid FROM payments
         WHERE status::text = 'paid' AND paid_at IS NOT NULL GROUP BY order_id) p
 WHERE p.order_id = o.id AND o.paid_at IS NULL AND o.payment_status::text = 'paid';

UPDATE orders SET dispatched_at = tracking_started_at
 WHERE dispatched_at IS NULL AND tracking_started_at IS NOT NULL;
