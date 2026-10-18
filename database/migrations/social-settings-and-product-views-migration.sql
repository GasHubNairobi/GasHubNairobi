-- Run once in the Supabase SQL Editor. Safe to re-run.
CREATE TABLE IF NOT EXISTS gashub_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO gashub_settings(setting_key, setting_value) VALUES
('social_links', '{"tiktok":"","instagram":"","facebook":"","x":"","email":""}'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS product_view_events (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_view_events_product_id_idx ON product_view_events(product_id);
CREATE INDEX IF NOT EXISTS product_view_events_viewed_at_idx ON product_view_events(viewed_at DESC);
