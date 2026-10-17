-- Run once in the Supabase SQL Editor (safe to run again).
-- Gives orders the delivery-person columns and completion times the app now saves,
-- and makes sure the dealer's messenger list (delivery_agents) exists.

DO $$
DECLARE dealer_id_type TEXT;
BEGIN
    SELECT format_type(a.atttypid, a.atttypmod) INTO dealer_id_type
    FROM pg_attribute a WHERE a.attrelid = 'dealers'::regclass AND a.attname = 'id';

    EXECUTE format($f$
        CREATE TABLE IF NOT EXISTS delivery_agents (
            id            BIGSERIAL PRIMARY KEY,
            dealer_id     %s NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
            full_name     VARCHAR(120) NOT NULL,
            phone         VARCHAR(20)  NOT NULL,
            id_number     VARCHAR(20)  NOT NULL,
            vehicle_reg   VARCHAR(20),
            status        VARCHAR(20)  NOT NULL DEFAULT 'active',
            created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            UNIQUE (dealer_id, id_number)
        )$f$, dealer_id_type);
END $$;

CREATE INDEX IF NOT EXISTS idx_delivery_agents_dealer ON delivery_agents (dealer_id, status);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_agent_id   BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_name          VARCHAR(120);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_phone         VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_id_number     VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_vehicle_reg   VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_assigned_at   TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_at        TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatched_at       TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at        TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at        TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at        TIMESTAMPTZ;

-- orders that were already completed before completed_at existed: use their last update
UPDATE orders SET completed_at = COALESCE(delivered_at, updated_at) WHERE status::text = 'completed' AND completed_at IS NULL;
