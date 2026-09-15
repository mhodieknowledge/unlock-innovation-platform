-- Drops the constraint. The merges are NOT undone: re-splitting a merged row would mean
-- inventing which facts belonged to which copy, and the copies were identical by
-- construction. Down migrations here restore the schema; this one says plainly which
-- half of its effect is one-way.
DROP INDEX IF EXISTS opportunities_one_live_row_per_url;
