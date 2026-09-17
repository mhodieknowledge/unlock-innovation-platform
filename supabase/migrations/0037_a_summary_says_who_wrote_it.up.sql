-- 0037 a summary that does not say who wrote it
--
-- PRODUCT_SPEC.md §14's hard AI rules, marked [PR]: "Anything AI-derived and user-visible is
-- labelled and carries its source quote." The same section lists, under explicitly NOT built,
-- "AI-written opportunity descriptions presented as ours".
--
-- Every summary in this table was written by a model. extract.v1.md rule 1 asks for one in the
-- model's own words on every page the crawler fetches, and the new summarise task writes the
-- rest. There is no path by which a person has ever written one: the admin queues edit rules
-- and routing, not prose.
--
-- And the opportunity page rendered it as an unlabelled paragraph under the title, in the
-- position and the voice of an editorial standfirst. That is the definition of presented as
-- ours, and it has been true of every listing with a description since the pipeline first ran.
--
-- So the column exists to make the label CONDITIONAL rather than decorative. A label the page
-- prints unconditionally is a label nobody can trust the day a person edits one summary by
-- hand — and the honest statement then is different, so the page has to be able to tell.
--
-- DEFAULT 'model' is correct for every row that exists today and for every row the pipeline
-- will write. It would become a lie the moment a human write path is added without setting the
-- column, which is why test/workflows.audit.test.ts asserts that every statement writing
-- `summary` in scripts/ writes `summary_source` beside it.

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS summary_source text NOT NULL DEFAULT 'model'
    CHECK (summary_source IN ('model', 'human'));

COMMENT ON COLUMN opportunities.summary_source IS
  'Who wrote `summary`. PRODUCT_SPEC.md §14 requires anything AI-derived and user-visible to be labelled, so the page reads this rather than assuming.';
