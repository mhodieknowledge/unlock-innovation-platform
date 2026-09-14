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
