-- Dropping this re-hides who wrote every summary, which is the state PRODUCT_SPEC.md §14's
-- hard AI rules forbid. The page's label goes with it, so a rollback must be accompanied by
-- reverting the page — otherwise it renders a label it cannot support.
ALTER TABLE opportunities DROP COLUMN IF EXISTS summary_source;
