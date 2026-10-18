-- Complaints reported from a cancelled order + replies sent to the customer.
-- Optional: the server also creates these on first use. Safe to run again. Run migration-007-enable-rls.sql afterwards.

ALTER TABLE complaints
    ADD COLUMN IF NOT EXISTS source TEXT,
    ADD COLUMN IF NOT EXISTS reason TEXT,
    ADD COLUMN IF NOT EXISTS order_snapshot JSONB;

CREATE TABLE IF NOT EXISTS complaint_messages (
    id BIGSERIAL PRIMARY KEY,
    complaint_id TEXT NOT NULL,
    channel TEXT NOT NULL,                 -- email | sms | push
    kind TEXT NOT NULL DEFAULT 'manual',   -- manual | auto
    recipient TEXT,
    subject TEXT,
    body TEXT,
    status TEXT NOT NULL,                  -- sent | failed
    error TEXT,
    sent_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS complaint_messages_complaint_idx ON complaint_messages (complaint_id, created_at);
ALTER TABLE complaint_messages ENABLE ROW LEVEL SECURITY;
