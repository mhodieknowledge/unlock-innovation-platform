-- Restores 0032's index. Note that it will refuse any pre-existing pair of live rows
-- sharing a source_url, so a rollback onto data written since may fail — which is the
-- same objection that removed it.
CREATE UNIQUE INDEX IF NOT EXISTS opportunities_one_live_row_per_url
  ON opportunities (source_url)
  WHERE source_url IS NOT NULL AND deleted_at IS NULL AND duplicate_of IS NULL;
