-- GasHub: clear test activity so income / reports start clean. KEEPS every account and password.
-- Runs ONLY in the Supabase SQL Editor (nothing to deploy on Netlify, no code changes).
--
-- KEPT (never touched):  users (logins + password hashes), dealers, products, delivery_agents (messengers),
--                        dealer_applications, dealer_payout_settings, dealer_followers, gashub_settings,
--                        gashub_sessions (nobody is logged out), banned_identities, report_records.
-- CLEARED:               orders, order_items, payments, M-Pesa request/receipt logs, customer points + withdrawals,
--                        referrals / reward claims, reviews, complaints, dealer<->customer messages, broadcasts,
--                        automated reminder log, item selections, product view counts, dealer purchases,
--                        dealer verification payments, dealer payouts, rate-limit counters.
--
-- HOW TO RUN
--   1) Supabase dashboard -> SQL Editor -> paste this whole file -> Run.
--      With the settings below as they are it is a DRY RUN: it changes nothing and prints, in the "Messages"
--      panel, how many rows each table has and the date of the newest row.
--   2) If the newest order / payment is a test one, set  run_it := TRUE  and Run again.
--      If REAL customers have already ordered since going live, also set  go_live_at  (e.g. '2026-10-14 08:00+03').
--      Then only rows created BEFORE that moment are removed and the real ones stay.
--   3) Before deleting, every table is copied to a schema named  reset_backup_<date_time>  so you can undo it.
--      When you are happy, drop it:  DROP SCHEMA reset_backup_<date_time> CASCADE;
--
-- Everything runs in one transaction: if anything fails, nothing is changed.
-- Stock is NOT restored: open Dealer > Products and re-check each product's stock_quantity after the reset.

DO $$
DECLARE
    run_it      boolean     := FALSE;   -- <-- change to TRUE to really delete (FALSE = preview only)
    go_live_at  timestamptz := NULL;    -- <-- NULL = clear everything; or a time: only older rows are cleared

    -- children first, parents last (orders are cleared after everything that points at them)
    wipe text[] := ARRAY[
        'order_items', 'payments', 'mpesa_stk_requests', 'mpesa_c2b_payments',
        'points_withdrawals', 'withdrawal_notify', 'points_ledger', 'referrals', 'reward_claims',
        'reviews', 'complaints', 'dealer_messages', 'broadcast_messages', 'automated_message_log',
        'customer_item_selections', 'product_view_events', 'dealer_purchases',
        'dealer_verification_payments', 'dealer_payout_orders', 'dealer_payouts',
        'gashub_rate_limits', 'orders'
    ];
    t          text;
    n          bigint;
    newest     text;
    has_ts     boolean;
    bk         text := 'reset_backup_' || to_char(now() AT TIME ZONE 'Africa/Nairobi', 'YYYYMMDD_HH24MI');
    cond       text;
    removed    bigint;
BEGIN
    IF run_it THEN EXECUTE format('CREATE SCHEMA %I', bk); END IF;

    FOREACH t IN ARRAY wipe LOOP
        IF to_regclass(format('public.%I', t)) IS NULL THEN CONTINUE; END IF;   -- table not created yet: skip

        EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
        SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = t AND column_name = 'created_at') INTO has_ts;
        newest := NULL;
        IF has_ts THEN EXECUTE format('SELECT max(created_at)::text FROM public.%I', t) INTO newest; END IF;

        IF NOT run_it THEN
            RAISE NOTICE 'PREVIEW  % | rows: % | newest: %', rpad(t, 30), n, COALESCE(newest, '-');
            CONTINUE;
        END IF;

        -- 1) backup the whole table
        EXECUTE format('CREATE TABLE %I.%I AS SELECT * FROM public.%I', bk, t, t);
        EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', bk, t);   -- not readable through Supabase's public API

        -- 2) delete
        IF go_live_at IS NULL THEN
            EXECUTE format('DELETE FROM public.%I', t);
        ELSIF t <> 'orders' AND EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = t AND column_name = 'order_id') THEN
            -- rows that belong to an old order go with it, plus anything else created before the cut-off
            cond := 'order_id IN (SELECT id FROM public.orders WHERE created_at < $1)' || CASE WHEN has_ts THEN ' OR created_at < $1' ELSE '' END;
            EXECUTE format('DELETE FROM public.%I WHERE ', t) || cond USING go_live_at;
        ELSIF has_ts THEN
            EXECUTE format('DELETE FROM public.%I WHERE created_at < $1', t) USING go_live_at;
        ELSE
            RAISE NOTICE 'SKIPPED  % (no created_at column, cannot tell test rows from real ones)', t;
            CONTINUE;
        END IF;
        GET DIAGNOSTICS removed = ROW_COUNT;
        RAISE NOTICE 'CLEARED  % | removed: % of %', rpad(t, 30), removed, n;
    END LOOP;

    IF run_it THEN
        -- numbering starts again from 1 where a table is now completely empty
        FOREACH t IN ARRAY wipe LOOP
            IF to_regclass(format('public.%I', t)) IS NULL THEN CONTINUE; END IF;
            EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
            IF n = 0 THEN
                FOR cond IN SELECT pg_get_serial_sequence(format('public.%I', t), column_name)
                            FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = t
                              AND pg_get_serial_sequence(format('public.%I', t), column_name) IS NOT NULL
                LOOP EXECUTE format('ALTER SEQUENCE %s RESTART WITH 1', cond); END LOOP;
            END IF;
        END LOOP;
        RAISE NOTICE 'DONE. Accounts and passwords untouched. Backup copy is in schema "%".', bk;
    ELSE
        RAISE NOTICE 'Nothing was changed (preview). Set run_it := TRUE to delete.';
    END IF;
END $$;
