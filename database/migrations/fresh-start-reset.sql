-- GasHub: FRESH START before the Play Store launch.
-- Deletes ALL test data: every customer account, every dealer account (and their products, messengers, applications),
-- all orders, payments, M-Pesa logs, points, withdrawals, refunds, reviews, complaints, messages, payouts, sessions and bans.
--
-- KEPT:  admin account(s) (users.role = 'admin', with their passwords) and gashub_settings (payment till, coin rate,
--        switches, social links and the other admin settings).
--
-- Runs ONLY in the Supabase SQL Editor. Nothing to deploy.
--
-- HOW TO RUN
--   1) Paste this whole file in Supabase > SQL Editor > Run.  As it is now it is a PREVIEW: nothing is deleted. The "Messages"
--      panel lists every table with its row count and the admin account(s) that will be kept.
--   2) To really delete: set  run_it := TRUE  and  confirm := 'DELETE EVERYTHING'  and Run again.
--   3) A backup copy of every table goes into a schema named  fresh_start_backup_<date_time>  first (make_backup := TRUE).
--      It still holds the old personal data, so once you are happy the app works, remove it:
--          DROP SCHEMA fresh_start_backup_<date_time> CASCADE;
--
-- Everything runs in ONE transaction: if anything fails, nothing is changed.
-- Not covered by SQL: pictures already uploaded to Cloudinary (old product / dealer images) stay there; delete them in the Cloudinary dashboard.

DO $$
DECLARE
    run_it      boolean := FALSE;                -- <-- TRUE to really delete (FALSE = preview only)
    confirm     text    := '';                   -- <-- type DELETE EVERYTHING here when run_it is TRUE
    make_backup boolean := TRUE;                 -- <-- FALSE = no backup copy (cannot be undone)

    keep_tables text[]  := ARRAY['users', 'gashub_settings'];     -- never emptied (users is cleaned separately below)
    skip_tables text[]  := ARRAY['spatial_ref_sys', 'schema_migrations'];   -- system tables
    t           text;
    n           bigint;
    admins      bigint;
    wipe        text[]  := ARRAY[]::text[];
    bk          text    := 'fresh_start_backup_' || to_char(now() AT TIME ZONE 'Africa/Nairobi', 'YYYYMMDD_HH24MI');
    r           record;
BEGIN
    SELECT count(*) INTO admins FROM public.users WHERE role::text = 'admin';
    IF admins = 0 THEN RAISE EXCEPTION 'No admin account found in users: stopping so you cannot lock yourself out.'; END IF;

    -- every table in public except the kept / system ones
    FOR r IN SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name LOOP
        IF r.table_name = ANY (keep_tables) OR r.table_name = ANY (skip_tables) THEN CONTINUE; END IF;
        wipe := wipe || r.table_name::text;
    END LOOP;

    FOR r IN SELECT email, full_name FROM public.users WHERE role::text = 'admin' LOOP
        RAISE NOTICE 'KEEP     admin account: % (%)', r.email, r.full_name;
    END LOOP;
    SELECT count(*) INTO n FROM public.users WHERE role::text <> 'admin';
    RAISE NOTICE '%  users (customers + dealers + messenger logins): % will be deleted', CASE WHEN run_it THEN 'DELETE  ' ELSE 'PREVIEW ' END, n;
    FOREACH t IN ARRAY wipe LOOP
        EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
        RAISE NOTICE '%  % | rows: %', CASE WHEN run_it THEN 'DELETE  ' ELSE 'PREVIEW ' END, rpad(t, 32), n;
    END LOOP;

    IF NOT run_it THEN
        RAISE NOTICE 'Nothing was changed (preview). To delete: run_it := TRUE and confirm := ''DELETE EVERYTHING''.';
        RETURN;
    END IF;
    IF confirm <> 'DELETE EVERYTHING' THEN RAISE EXCEPTION 'Stopped: set confirm := ''DELETE EVERYTHING'' to really delete.'; END IF;

    -- 1) backup
    IF make_backup THEN
        EXECUTE format('CREATE SCHEMA %I', bk);
        FOREACH t IN ARRAY (wipe || ARRAY['users']) LOOP
            EXECUTE format('CREATE TABLE %I.%I AS SELECT * FROM public.%I', bk, t, t);
            EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', bk, t);   -- not readable through Supabase's public API
        END LOOP;
    END IF;

    -- 2) empty all the activity / account tables in one statement (numbering restarts at 1).
    --    No CASCADE on purpose: if a kept table points at one of these, the database refuses and nothing is changed.
    IF array_length(wipe, 1) IS NOT NULL THEN
        EXECUTE 'TRUNCATE TABLE ' || (SELECT string_agg(format('public.%I', x), ', ') FROM unnest(wipe) AS x) || ' RESTART IDENTITY';
    END IF;

    -- 3) remove every customer / dealer / messenger login; the admin stays
    DELETE FROM public.users WHERE role::text <> 'admin';

    RAISE NOTICE 'DONE. % admin account(s) kept, all other data removed. Backup schema: %', admins, CASE WHEN make_backup THEN bk ELSE 'none' END;
    RAISE NOTICE 'Next: sign in as admin, re-check Admin > Settings (till, coin rate), then let dealers apply / register again.';
END $$;
