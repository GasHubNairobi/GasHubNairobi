-- Messenger email + safer delivery links.
-- Run once in the Supabase SQL Editor (safe to run again). The server also adds these columns by itself the first
-- time they are needed, so running this file is optional but recommended.

-- 1) The email address the delivery link and order details are sent to
ALTER TABLE delivery_agents ADD COLUMN IF NOT EXISTS email VARCHAR(160);

-- 2) Link security
--    tracking_token_expires_at : the link stops working after 12 hours (renewed when the dealer re-shares it or the delivery starts)
--    tracking_device_hash      : the first phone that starts the delivery owns the link (a forwarded link is refused)
--    tracking_emailed_at       : when the link was last emailed to the messenger
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_token_expires_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_device_hash      VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_emailed_at       TIMESTAMPTZ;
