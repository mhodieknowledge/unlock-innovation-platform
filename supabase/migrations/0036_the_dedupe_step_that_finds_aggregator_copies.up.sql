-- 0036 step 3 of AI_SYSTEM.md §9, which was never implemented
--
-- The live board carried the same opportunity two and three times: "AI Builders Hackathon"
-- twice, "Gates Cambridge Scholarship" twice, the AfricaLics PhD Visiting Fellowship three
-- times under three slightly different titles. §9 defines five steps to prevent exactly that
-- and the code had two of them.
--
--   1. canonical URL match → certain duplicate, auto-merge        was recorded, never merged
--   2. trigram title ≥ 0.62 AND same organisation AND ±3 days     implemented
--   3. embedding cosine ≥ 0.90 AND deadline within ±7 days        MISSING — this migration
--   4. only survivors of 2 or 3 go to the model                   MISSING — scripts/dedupe.mjs
--   5. `same` at ≥ 0.85 → auto-merge                              MISSING — scripts/dedupe.mjs
--
-- STEP 3 IS THE ONE THAT MATTERS FOR WHAT IS ON THE SITE. Every one of those duplicates is
-- the same event written up by different aggregators, so:
--
--   * the URLs differ, and step 1 cannot see them;
--   * the titles differ by more than a trigram threshold tolerates ("AfricaLics Visiting PhD
--     Fellowship Programme 2027" vs "AfricaLics PhD Visiting Fellowship Programme (VFP)
--     2027" is 0.55);
--   * and step 2 additionally requires a shared organisation_id, which migration 0034 set to
--     NULL across the catalogue when it removed the organisations ingestion had invented from
--     other listings' titles. That repair was right and it left step 2 with nothing to match
--     on for precisely the records most likely to be duplicated.
--
-- An embedding does not care which words a blog chose. It is also already computed, daily and
-- free, by a model that runs locally (§3.3) — so this step costs one index scan.
--
-- ON NULL DEADLINES, where this reads §9 rather than quotes it. The ±7 days clause exists to
-- keep annual editions apart: merging the 2026 round into the 2027 round deletes a live
-- opportunity. A pair where BOTH deadlines are unknown cannot be checked that way, and
-- excluding it would leave the aggregator copies that arrive without a date — most of them —
-- permanently invisible to every step. They are included, and nothing about that can merge
-- anything: a step 3 hit is a CANDIDATE, and the only paths to a merge are step 1's certainty
-- or step 4's model, which prompts/dedupe.v1.md instructs to answer `different` for annual
-- editions and `unsure` whenever it would be guessing. A pair with one deadline known and the
-- other NULL is excluded, because that is the shape an annual edition takes.

CREATE OR REPLACE FUNCTION dedupe_candidates_for(p_opportunity_id uuid)
RETURNS TABLE (candidate_id uuid, similarity numeric, method text)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE o record;
BEGIN
  SELECT id, title, organisation_id, deadline_at, source_url, official_url, embedding
    INTO o FROM opportunities WHERE id = p_opportunity_id;
  IF o.id IS NULL THEN RETURN; END IF;

  -- Step 1: a canonical URL match is a CERTAIN duplicate (§4.6 rule 1).
  RETURN QUERY
  SELECT x.id, 1.000::numeric, 'canonical_url'
    FROM opportunities x
   WHERE x.id <> o.id
     AND x.deleted_at IS NULL
     AND x.duplicate_of IS NULL
     AND (
       (o.source_url IS NOT NULL AND x.source_url = o.source_url) OR
       (o.official_url IS NOT NULL AND x.official_url = o.official_url)
     );

  -- Step 2: title similarity AND same organisation AND deadline within 3 days.
  RETURN QUERY
  SELECT x.id, similarity(x.title, o.title)::numeric, 'trigram_title'
    FROM opportunities x
   WHERE x.id <> o.id
     AND x.deleted_at IS NULL
     AND x.duplicate_of IS NULL
     AND o.organisation_id IS NOT NULL
     AND x.organisation_id = o.organisation_id
     AND o.deadline_at IS NOT NULL
     AND x.deadline_at BETWEEN o.deadline_at - interval '3 days'
                           AND o.deadline_at + interval '3 days'
     AND similarity(x.title, o.title) >= 0.62;

  -- Step 3: embedding cosine >= 0.90 AND deadline within +/-7 days (or both unknown).
  --
  -- `1 - (a <=> b)` is cosine similarity from pgvector's cosine DISTANCE operator, the same
  -- expression recommend_for_user uses. The threshold is on similarity, so it reads the same
  -- way §9 writes it.
  RETURN QUERY
  SELECT x.id, (1 - (x.embedding <=> o.embedding))::numeric, 'embedding'
    FROM opportunities x
   WHERE x.id <> o.id
     AND x.deleted_at IS NULL
     AND x.duplicate_of IS NULL
     AND o.embedding IS NOT NULL
     AND x.embedding IS NOT NULL
     AND (
       (o.deadline_at IS NOT NULL AND x.deadline_at IS NOT NULL
         AND x.deadline_at BETWEEN o.deadline_at - interval '7 days'
                               AND o.deadline_at + interval '7 days')
       OR (o.deadline_at IS NULL AND x.deadline_at IS NULL)
     )
     AND (1 - (x.embedding <=> o.embedding)) >= 0.90;
END
$$;

REVOKE ALL ON FUNCTION dedupe_candidates_for(uuid) FROM PUBLIC;
