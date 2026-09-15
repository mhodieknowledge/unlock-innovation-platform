-- Reverses the constraint only.
--
-- The duplicate rows are NOT restored, and cannot be: they were eighteen identical copies
-- distinguished by nothing but a generated uuid, and re-creating seventeen of them would be
-- inventing data rather than rolling back. Down migrations in this repository restore the
-- schema; this one says plainly which part of its effect is one-way.
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_url_key;
