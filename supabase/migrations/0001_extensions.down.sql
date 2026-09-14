-- 0001 extensions (down)
--
-- Extensions are deliberately NOT dropped. Other objects may depend on them,
-- and on Supabase several are managed platform-side. Dropping them on a
-- rollback would be a destructive side effect well beyond this migration's
-- scope. This down migration is intentionally a no-op, recorded rather than
-- omitted so the chain stays complete and reversible in sequence.

SELECT 1;
