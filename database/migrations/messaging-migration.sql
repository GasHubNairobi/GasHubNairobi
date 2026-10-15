-- GasHub admin messaging. Run once in the Supabase SQL Editor. Safe to re-run.
-- It reads the real id types of your users and products tables, so it works with UUID or number ids.

-- 1) Broadcasts the admin sends to all active customers (email or SMS)
CREATE TABLE IF NOT EXISTS broadcast_messages (
  id BIGSERIAL PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sending',      -- sending | completed | interrupted | failed
  recipients_total INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS broadcast_messages_channel_idx ON broadcast_messages(channel, created_at DESC);

-- 2) + 3) tables that point at users / products
DO $$
DECLARE
  uid_type TEXT;
  pid_type TEXT;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO uid_type
    FROM pg_attribute a WHERE a.attrelid = 'public.users'::regclass AND a.attname = 'id';
  SELECT format_type(a.atttypid, a.atttypmod) INTO pid_type
    FROM pg_attribute a WHERE a.attrelid = 'public.products'::regclass AND a.attname = 'id';

  -- Items a customer opened checkout for (used by the "selected item" reminder)
  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS customer_item_selections (
      id BIGSERIAL PRIMARY KEY,
      user_id %1$s NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      product_id %2$s NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
      selected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reminder_sent_at TIMESTAMPTZ,
      UNIQUE (user_id, product_id)
    )$f$, uid_type, pid_type);

  -- Every automated message that was sent (also stops the same reminder going out twice)
  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS automated_message_log (
      id BIGSERIAL PRIMARY KEY,
      user_id %1$s NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('item_reminder', 'restock_reminder')),
      ref_key TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
      status TEXT NOT NULL DEFAULT 'pending',
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, kind, ref_key, channel)
    )$f$, uid_type);
END $$;

CREATE INDEX IF NOT EXISTS customer_item_selections_due_idx ON customer_item_selections(selected_at) WHERE reminder_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS automated_message_log_kind_idx ON automated_message_log(kind, created_at DESC);

-- The admin's settings for the two reminders are stored in gashub_settings
-- (run social-settings-and-product-views-migration.sql first if you never did).
