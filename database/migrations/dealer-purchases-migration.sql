-- Supplier purchases recorded by dealers (dealer "Purchases" page).
-- The backend also creates this table automatically the first time the page is used,
-- so running this file by hand is optional.
CREATE TABLE IF NOT EXISTS dealer_purchases (
    id BIGSERIAL PRIMARY KEY,
    po_number TEXT UNIQUE NOT NULL,
    dealer_id TEXT NOT NULL,
    supplier TEXT NOT NULL,
    items TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_cost NUMERIC(12,2) NOT NULL CHECK (unit_cost >= 0),
    total_cost NUMERIC(14,2) NOT NULL CHECK (total_cost >= 0),
    status TEXT NOT NULL DEFAULT 'pending',
    mpesa_receipt TEXT,
    notes TEXT,
    ordered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    received_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dealer_purchases_dealer ON dealer_purchases (dealer_id, created_at DESC);
