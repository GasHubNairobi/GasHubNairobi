-- Migration 007: lock every table in the "public" schema against Supabase's public REST API.
--
-- WHY: Supabase automatically exposes every table in the public schema through its REST API (PostgREST). Anyone who has the
-- project's public "anon" key could then read or change users, password hashes, orders and payments - even though GasHub's own
-- website never uses that API. GasHub's backend connects with the database owner role, which is NOT affected by Row Level
-- Security, so turning it on with no policies blocks the public API completely and changes nothing for the website.
--
-- RUN: Supabase dashboard -> SQL Editor -> paste this whole file -> Run. Safe to run again at any time
-- (run it again after adding new tables).

DO $$
DECLARE t RECORD;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    END LOOP;
END $$;

-- Belt and braces: the public API roles get no table rights at all.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- CHECK (should return no rows): tables that still have Row Level Security switched off
-- SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity;
