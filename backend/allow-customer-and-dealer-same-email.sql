-- Lets one email / phone number have a customer account AND a dealer account.
-- Run once in the Supabase SQL Editor. Safe to run again.
-- Uniqueness becomes "one account per email PER ROLE" instead of "one per email".

BEGIN;

DO $$
DECLARE r record;
BEGIN
  -- 1. Drop single-column UNIQUE constraints on users.email / users.phone
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.users'::regclass
      AND c.contype = 'u'
      AND array_length(c.conkey, 1) = 1
      AND (SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) IN ('email', 'phone')
  LOOP
    EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I', r.conname);
    RAISE NOTICE 'Dropped constraint %', r.conname;
  END LOOP;

  -- 2. Drop stand-alone unique indexes on email / lower(email) / phone
  FOR r IN
    SELECT i.indexrelid::regclass::text AS idx
    FROM pg_index i
    WHERE i.indrelid = 'public.users'::regclass
      AND i.indisunique AND NOT i.indisprimary
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
      AND pg_get_indexdef(i.indexrelid) ~ 'USING btree \((email|phone|lower\(\(?email\)?(::text)?\))\)$'
  LOOP
    EXECUTE format('DROP INDEX %s', r.idx);
    RAISE NOTICE 'Dropped index %', r.idx;
  END LOOP;
END $$;

-- 3. One account per email / phone within each role
CREATE UNIQUE INDEX IF NOT EXISTS users_email_role_key ON public.users (LOWER(email), role);
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_role_key ON public.users (phone, role) WHERE phone IS NOT NULL;

COMMIT;

-- Check afterwards: should list only users_pkey, user_code uniqueness and the two new indexes
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'users';
