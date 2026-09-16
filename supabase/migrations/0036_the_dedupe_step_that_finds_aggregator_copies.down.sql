-- Restores 0013's two-step version, copied from that migration rather than retyped: a
-- rollback that reconstructs a function from memory is how a rollback introduces a bug.
-- Candidate rows already found by the embedding step are left alone; they are candidates,
-- and a human or the model still decides.

CREATE OR REPLACE FUNCTION dedupe_candidates_for(p_opportunity_id uuid)
RETURNS TABLE (candidate_id uuid, similarity numeric, method text)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE o record;
BEGIN
  SELECT id, title, organisation_id, deadline_at, source_url, official_url
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
END
$$;

REVOKE ALL ON FUNCTION dedupe_candidates_for(uuid) FROM PUBLIC;
