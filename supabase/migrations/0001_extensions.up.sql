-- 0001 extensions
-- DATA_MODEL.md preamble: PostgreSQL 15+ with pgvector, pg_trgm, unaccent,
-- citext, uuid-ossp. pgcrypto supplies gen_random_uuid() for primary keys.
--
-- On Supabase these live in the `extensions` schema by convention; created
-- IF NOT EXISTS so the migration is idempotent and safe to re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Vector search. SYSTEM_ARCHITECTURE.md §20 decision 5: 384 dimensions stored
-- as halfvec (2 bytes/dim) is what makes vector search possible inside a 500 MB
-- free tier at all.
CREATE EXTENSION IF NOT EXISTS vector;

-- halfvec arrived in pgvector 0.7.0. Ubuntu's package still ships 0.6.0, where
-- the type is simply absent and later migrations fail with a bare
-- "type halfvec does not exist" that gives no hint what to do. Fail here
-- instead, with the fix in the message.
DO $$
DECLARE v text;
BEGIN
  SELECT extversion INTO v FROM pg_extension WHERE extname = 'vector';
  IF string_to_array(v, '.')::int[] < ARRAY[0, 7, 0] THEN
    RAISE EXCEPTION
      'pgvector % is too old: halfvec needs >= 0.7.0. Supabase and the pgvector/pgvector:pg16 CI image are current; a local box on a distro package is not. Build from source or use the Docker image.', v;
  END IF;
END
$$;

-- Supabase role shim.
--
-- Supabase ships `anon`, `authenticated` and `service_role`, and migrations GRANT
-- to them. Plain Postgres has none of them, so a GRANT fails with
-- 'role "anon" does not exist' and the migration aborts.
--
-- Created ONLY when absent, as NOLOGIN so they cannot be used to connect. On
-- Supabase every branch is a no-op and the platform's own roles are untouched.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END
$$;

-- auth.uid() compatibility shim.
--
-- Every RLS policy in this schema is written against auth.uid(), which Supabase
-- provides. Local development and CI run plain Postgres, where it does not
-- exist, so the policies would fail to create.
--
-- Created ONLY when absent, so this is a no-op on Supabase — we must never
-- redefine the platform's own function. The shim reads the same JWT claim
-- Supabase does, so a test harness can impersonate a user with
-- `SET request.jwt.claim.sub = '<uuid>'`, which is what the RLS test suite
-- required by SECURITY.md §12 depends on.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    CREATE SCHEMA IF NOT EXISTS auth;
    EXECUTE $fn$
      CREATE FUNCTION auth.uid() RETURNS uuid
        LANGUAGE sql
        STABLE
      AS $body$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $body$;
    $fn$;
  END IF;
END
$$;
