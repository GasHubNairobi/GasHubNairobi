-- Live order tracking.
-- Run once in the Supabase SQL Editor (safe to run again). Nothing is dropped or renamed.
-- It only adds columns to the existing orders table: no new tables, no copies of your data.

-- A secret link token per order. The dealer shares the link with the assigned messenger,
-- and the messenger's phone sends its GPS position to the server with it.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_token        VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_started_at   TIMESTAMPTZ;

-- The messenger's latest position (one row per order, overwritten on every update)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_lat             DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_lng             DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_heading         REAL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_speed           REAL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_accuracy        REAL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_location_at     TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_tracking_token ON orders (tracking_token) WHERE tracking_token IS NOT NULL;

-- Clean up anything left behind on orders that are already finished
UPDATE orders
   SET rider_lat = NULL, rider_lng = NULL, rider_heading = NULL, rider_speed = NULL,
       rider_accuracy = NULL, rider_location_at = NULL, tracking_token = NULL
 WHERE status::text IN ('delivered', 'completed', 'cancelled', 'rejected')
   AND (rider_lat IS NOT NULL OR tracking_token IS NOT NULL);
