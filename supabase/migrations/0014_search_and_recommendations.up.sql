-- 0014 hybrid retrieval and recommendation candidates
--
-- SYSTEM_ARCHITECTURE.md §6.1 and §8.
--
-- THE DIVISION OF LABOUR HERE IS DELIBERATE.
--
-- Postgres does RETRIEVAL: full-text search, approximate nearest neighbour, and the
-- rank fusion that combines them. It returns candidates along with the raw SIGNALS a
-- ranking needs — the fused rank score, days to deadline, verification state, the
-- viewer's verdict, the organisation and category.
--
-- TypeScript does RANKING: every weight lives in packages/config/src/ranking.ts, which
-- §6.1 `[TD]` requires to be a single file. Computing the boosts in SQL as well would
-- put the same numbers in two places, and this repository has already been bitten
-- twice by two copies of one rule drifting apart. It also means a ranking change is a
-- deploy rather than a migration, which is the right cost for something meant to be
-- tuned.

-- ── ONE text-search configuration, because two did not match ────────────────
--
-- A REAL BUG, found by querying the search function for a word that was definitely in
-- the corpus and getting nothing back.
--
-- 0005's trigger built search_vector with the `simple` configuration, which does not
-- stem: the word "climate" was stored as 'climate'. This file's query used `english`,
-- which does: "climate" becomes 'climat'. The two never matched on any word English
-- stems — which is most words. Full-text search was returning nothing for almost every
-- query, and nothing about it looked broken: the vectors were populated, the index
-- existed, the query ran, the result was empty.
--
-- The fix is not to pick a configuration and remember to use it. It is to NAME one, so
-- the two sides cannot disagree again:
--
--   `mbele_search` = english stemming, with unaccent in front of every dictionary.
--
-- English stemming on a multilingual corpus is the right trade here. It stems English
-- (which most listings are written in) and leaves other languages as exact tokens —
-- worse recall for a French page than a French configuration would give, but never
-- WRONG, and one configuration that behaves predictably beats per-language detection
-- this catalogue has no way to do reliably.
--
-- unaccent in the dictionary chain rather than as a function call means "Côte d'Ivoire"
-- and "Cote d'Ivoire" are the same token on both the indexing and the querying side.
-- §6.1 asks for unaccent-normalised; doing it in the configuration is what makes that
-- true of the QUERY as well.

CREATE TEXT SEARCH CONFIGURATION mbele_search (COPY = english);

ALTER TEXT SEARCH CONFIGURATION mbele_search
  ALTER MAPPING FOR hword, hword_part, word, asciiword, asciihword, numword, numhword
  WITH unaccent, english_stem;

/**
 * The search vector, rebuilt. §6.1's weighting, with the tags 0005 left out:
 *   title 'A', organisation 'B', summary 'C', tags 'D'.
 *
 * Weights are what make a title match beat a summary match, and 'D' for tags is what
 * lets a tag contribute without competing with the title.
 */
CREATE OR REPLACE FUNCTION opportunities_search_vector_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  org_name text;
  tag_names text;
BEGIN
  SELECT name INTO org_name FROM organisations WHERE id = NEW.organisation_id;

  SELECT string_agg(t.name, ' ') INTO tag_names
    FROM tags t WHERE t.id = ANY (coalesce(NEW.tag_ids, '{}'::uuid[]));

  NEW.search_vector :=
      setweight(to_tsvector('mbele_search', coalesce(NEW.title, '')), 'A')
   || setweight(to_tsvector('mbele_search', coalesce(org_name, '')), 'B')
   || setweight(to_tsvector('mbele_search', coalesce(NEW.summary, '')), 'C')
   || setweight(to_tsvector('mbele_search', coalesce(tag_names, '')), 'D');
  RETURN NEW;
END
$$;

-- 0005's trigger did not fire on a tag change, so a retagged opportunity kept a stale
-- vector. Recreated with tag_ids in the column list.
DROP TRIGGER IF EXISTS opportunities_search_vector ON opportunities;
CREATE TRIGGER opportunities_search_vector
  BEFORE INSERT OR UPDATE OF title, summary, organisation_id, tag_ids ON opportunities
  FOR EACH ROW EXECUTE FUNCTION opportunities_search_vector_update();

-- Backfill. Every existing vector was built with the wrong configuration, so every one
-- of them is unsearchable until this runs.
UPDATE opportunities SET title = title WHERE true;

-- ── ANN index on profiles ───────────────────────────────────────────────────
--
-- opportunities already has its HNSW index, from 0005. This adds the matching one for
-- public profiles, which is what project-to-person and person-to-opportunity matching
-- searches against.
--
-- HNSW rather than IVFFlat: §6.1 specifies it, and it needs no training step — which
-- matters when the corpus grows daily and an index rebuild is an operational task
-- nobody will remember. halfvec keeps the index at half the size of a float32 one for a
-- recall difference not measurable at 384 dimensions.
--
-- NOTE what is deliberately absent: eligibility_profiles has no embedding column and
-- therefore no index. AI_SYSTEM.md §8 forbids embedding eligibility profile fields at
-- all, so matching uses the PUBLIC profile's embedding. The sensitive table is not
-- searchable because it is not vectorised.

CREATE INDEX profiles_embedding_idx
  ON profiles USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

/**
 * Candidate retrieval with rank fusion. §6.1.
 *
 *   candidates = FTS(query) ∪ ANN(embedding(query))
 *   score      = RRF(rank_fts, rank_vec, k=60)
 *
 * Returns SIGNALS, not a final score: the caller multiplies in the eligibility,
 * urgency, freshness and diversity terms from the one constants file.
 *
 * p_embedding may be NULL, and that is §6.2's degraded mode `[PR]`: "If the embedding
 * provider is unavailable: FTS-only with a quiet indicator in the admin dashboard.
 * Users see no error." A NULL embedding here produces an FTS-only result set with no
 * error and no empty state — the vector half simply contributes nothing.
 */
CREATE OR REPLACE FUNCTION search_candidates(
  p_query text DEFAULT NULL,
  p_embedding halfvec(384) DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_country char(2) DEFAULT NULL,
  p_category_code text DEFAULT NULL,
  p_mode text DEFAULT NULL,
  p_cost text DEFAULT NULL,
  p_team text DEFAULT NULL,
  p_has_prize boolean DEFAULT NULL,
  p_limit int DEFAULT 120
)
RETURNS TABLE (
  id uuid,
  slug text,
  rrf numeric,
  rank_fts int,
  rank_vec int,
  verdict text,
  verification text,
  deadline_at timestamptz,
  is_rolling boolean,
  organisation_slug text,
  category_code text
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_k constant int := 60;   -- §6.1's RRF k. Mirrored in ranking.ts, where it is explained.
  v_tsquery tsquery;
BEGIN
  -- websearch_to_tsquery rather than plainto_: it understands quoted phrases and
  -- negation, which is what a person types into a search box, and it never raises on
  -- malformed input the way to_tsquery does.
  IF p_query IS NOT NULL AND btrim(p_query) <> '' THEN
    v_tsquery := websearch_to_tsquery('mbele_search', p_query);
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT o.*
      FROM opportunities o
     WHERE o.status = 'published'
       AND o.deleted_at IS NULL
       AND o.duplicate_of IS NULL
       -- §5.4: expired records are excluded from all search and feeds. They keep their
       -- URL and their place in history; they are not results.
       AND (o.deadline_at IS NULL OR o.deadline_at > now())
       AND (p_country IS NULL
            OR o.eligibility_scope IN ('africa_wide','global')
            OR btrim(p_country) = ANY (SELECT btrim(c) FROM unnest(o.eligible_countries) AS c))
       AND (p_category_code IS NULL
            OR o.category_id = (SELECT c.id FROM categories c WHERE c.code = p_category_code))
       AND (p_mode IS NULL OR o.participation_mode::text = p_mode)
       AND (p_cost IS NULL OR o.cost::text = p_cost)
       AND (p_team IS NULL
            OR (p_team = 'team' AND o.team_required IS TRUE)
            OR (p_team = 'individual' AND o.team_required IS NOT TRUE))
       AND (p_has_prize IS NOT TRUE OR o.prize_amount IS NOT NULL)
  ),
  fts AS (
    SELECT f.id,
           row_number() OVER (
             ORDER BY ts_rank_cd(f.search_vector, v_tsquery) DESC, f.deadline_at NULLS LAST
           )::int AS rank
      FROM filtered f
     WHERE v_tsquery IS NOT NULL
       AND f.search_vector @@ v_tsquery
     LIMIT p_limit
  ),
  vec AS (
    SELECT f.id,
           row_number() OVER (ORDER BY f.embedding <=> p_embedding)::int AS rank
      FROM filtered f
     WHERE p_embedding IS NOT NULL
       AND f.embedding IS NOT NULL
     LIMIT p_limit
  ),
  -- No query at all: browsing rather than searching. Urgency order, which
  -- PRODUCT_SPEC.md §13.4 makes the default sort — "this is a deadline product".
  browse AS (
    SELECT f.id,
           row_number() OVER (ORDER BY f.deadline_at NULLS LAST)::int AS rank
      FROM filtered f
     WHERE v_tsquery IS NULL AND p_embedding IS NULL
     LIMIT p_limit
  ),
  fused AS (
    SELECT coalesce(fts.id, vec.id, browse.id) AS id,
           fts.rank AS rank_fts,
           vec.rank AS rank_vec,
           -- RRF. A result both retrievers rank highly beats one only one of them
           -- loves, which is the whole reason for fusing rather than concatenating.
           (coalesce(1.0 / (v_k + fts.rank), 0)
            + coalesce(1.0 / (v_k + vec.rank), 0)
            + coalesce(1.0 / (v_k + browse.rank), 0))::numeric AS rrf
      FROM fts
      FULL OUTER JOIN vec ON vec.id = fts.id
      FULL OUTER JOIN browse ON browse.id = coalesce(fts.id, vec.id)
  )
  SELECT f.id,
         o.slug,
         f.rrf,
         f.rank_fts,
         f.rank_vec,
         -- The viewer's own verdict, computed where the profile already is. NULL for an
         -- anonymous viewer, who gets no personal boost and no personal data leaving
         -- the database either way.
         v.verdict,
         o.verification::text,
         o.deadline_at,
         o.is_rolling,
         og.slug,
         c.code
    FROM fused f
    JOIN opportunities o ON o.id = f.id
    LEFT JOIN organisations og ON og.id = o.organisation_id
    LEFT JOIN categories c ON c.id = o.category_id
    LEFT JOIN LATERAL (
      SELECT uv.verdict FROM user_verdicts(p_user_id, ARRAY[f.id]) uv
       WHERE p_user_id IS NOT NULL
    ) v ON true
   ORDER BY f.rrf DESC
   LIMIT p_limit;
END
$$;

-- ── §8 recommendations ──────────────────────────────────────────────────────

CREATE TABLE user_recommendations (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  score          numeric(6,4) NOT NULL,
  rank           smallint NOT NULL,
  -- §8 step 6: "Reasons: templated from matched rules + overlapping tag names." Stored
  -- rather than recomputed, because a recommendation without a reason is a black box
  -- and PRODUCT_SPEC.md §14 requires each one to say why.
  reasons        text[] NOT NULL DEFAULT '{}',
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, opportunity_id)
);

CREATE INDEX user_recommendations_read_idx ON user_recommendations (user_id, rank);

ALTER TABLE user_recommendations ENABLE ROW LEVEL SECURITY;

-- Owner-only, and no admin path: a recommendation set is derived from the eligibility
-- profile, which ADMIN_SYSTEM.md §6 keeps unreadable by administrators. A readable
-- recommendation list would leak what the profile says.
CREATE POLICY user_recommendations_owner_read ON user_recommendations FOR SELECT
  USING (user_id = auth.uid());

COMMENT ON TABLE user_recommendations IS
  'SYSTEM_ARCHITECTURE.md §8. Precomputed nightly; read is a single indexed query, zero compute at request time.';

/**
 * Candidates for one user's nightly recommendation pass. §8 steps 1–3.
 *
 * Steps 4 and 5 — the weighted score and the diversity cap — are the caller's, using
 * ranking.ts. Same division as search: retrieval here, weights there.
 *
 * Step 2 is the important one: "Eligibility gate: verdict in (eligible,
 * likely_eligible)". A recommendation is a stronger claim than a search result. Search
 * shows `not_eligible` down-ranked because the reader may be checking for someone else;
 * a recommendation says "this is for you", so it has to actually be.
 */
CREATE OR REPLACE FUNCTION recommendation_candidates(
  p_user_id uuid,
  p_limit int DEFAULT 200
)
RETURNS TABLE (
  id uuid,
  slug text,
  title text,
  similarity numeric,
  verdict text,
  verification text,
  source_trust numeric,
  deadline_at timestamptz,
  is_rolling boolean,
  organisation_slug text,
  category_code text,
  matched_rule_types text[],
  shared_tags text[]
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_country char(2);
  v_embedding halfvec(384);
BEGIN
  SELECT e.country_of_residence INTO v_country
    FROM eligibility_profiles e WHERE e.user_id = p_user_id;

  SELECT p.embedding INTO v_embedding FROM profiles p WHERE p.user_id = p_user_id;

  RETURN QUERY
  WITH candidates AS (
    SELECT o.*
      FROM opportunities o
     WHERE o.status = 'published'
       AND o.deleted_at IS NULL
       AND o.duplicate_of IS NULL
       -- §8 step 1: within 60 days, and open to this user's country.
       AND o.deadline_at IS NOT NULL
       AND o.deadline_at > now()
       AND o.deadline_at <= now() + interval '60 days'
       AND (v_country IS NULL
            OR o.eligibility_scope IN ('africa_wide','global')
            OR btrim(v_country) = ANY (SELECT btrim(c) FROM unnest(o.eligible_countries) AS c))
       -- Already tracked is already known about.
       AND NOT EXISTS (
         SELECT 1 FROM tracker_entries t
          WHERE t.user_id = p_user_id AND t.opportunity_id = o.id)
     LIMIT p_limit
  )
  SELECT c.id,
         c.slug,
         c.title,
         -- Cosine similarity, or a neutral 0.5 with no profile embedding yet. §8's
         -- cold-start path: "fall back to country + category + urgency ranking", which
         -- is what a constant similarity term leaves behind.
         CASE WHEN v_embedding IS NULL OR c.embedding IS NULL THEN 0.5::numeric
              ELSE (1 - (c.embedding <=> v_embedding))::numeric END,
         v.verdict,
         c.verification::text,
         coalesce(s.trust_score, 0.5),
         c.deadline_at,
         c.is_rolling,
         og.slug,
         cat.code,
         -- §8 step 6's raw material: which of this user's own attributes the rules
         -- matched, so the reason can name them.
         coalesce(ARRAY(
           SELECT DISTINCT r.rule_type::text
             FROM eligibility_rules r
            WHERE r.opportunity_id = c.id
         ), '{}'::text[]),
         coalesce(ARRAY(
           SELECT t.name FROM tags t
            WHERE t.id = ANY (c.tag_ids)
            LIMIT 5
         ), '{}'::text[])
    FROM candidates c
    LEFT JOIN organisations og ON og.id = c.organisation_id
    LEFT JOIN categories cat ON cat.id = c.category_id
    LEFT JOIN sources s ON s.id = c.source_id
    CROSS JOIN LATERAL (SELECT uv.verdict FROM user_verdicts(p_user_id, ARRAY[c.id]) uv) v
   -- §8 step 2. A recommendation says "this is for you", so it has to be true.
   WHERE v.verdict IN ('eligible','likely_eligible');
END
$$;

/**
 * Replace a user's stored recommendations atomically.
 *
 * Atomically because the read path is a single indexed query with no notion of a
 * generation: deleting and then inserting in two statements would show an empty
 * recommendation surface to anyone who looked in between, and §8 `[PR]` says "Never
 * show an empty recommendation surface".
 */
CREATE OR REPLACE FUNCTION replace_user_recommendations(
  p_user_id uuid,
  p_rows jsonb
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n int;
BEGIN
  DELETE FROM user_recommendations WHERE user_id = p_user_id;

  INSERT INTO user_recommendations (user_id, opportunity_id, score, rank, reasons)
  SELECT p_user_id,
         (row->>'opportunity_id')::uuid,
         (row->>'score')::numeric,
         (row->>'rank')::smallint,
         coalesce(jsonb_text_array(row->'reasons'), '{}'::text[])
    FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) AS row;

  SELECT count(*)::int INTO n FROM user_recommendations WHERE user_id = p_user_id;
  RETURN n;
END
$$;

/** §8: "per active user (seen in the last 30 days)". */
CREATE OR REPLACE FUNCTION active_users_for_recommendations(p_limit int DEFAULT 500)
RETURNS TABLE (user_id uuid, has_embedding boolean, country char(2))
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT u.id,
         (SELECT p.embedding IS NOT NULL FROM profiles p WHERE p.user_id = u.id),
         (SELECT e.country_of_residence FROM eligibility_profiles e WHERE e.user_id = u.id)
    FROM users u
   WHERE u.account_state = 'active'
     AND u.deleted_at IS NULL
     AND u.last_seen_at IS NOT NULL
     AND u.last_seen_at > now() - interval '30 days'
   ORDER BY u.last_seen_at DESC
   LIMIT p_limit
$$;

/**
 * The cold-start surface. §8 `[PR]`: "Never show an empty recommendation surface — show
 * the country's closing-soon list with an honest label instead."
 *
 * Takes a country rather than a user, so it works for an anonymous visitor too. That is
 * the same list the country page shows, which is the point: honest and familiar beats
 * personalised and empty.
 */
CREATE OR REPLACE FUNCTION closing_soon_for_country(
  p_country char(2) DEFAULT NULL,
  p_limit int DEFAULT 10
)
RETURNS TABLE (
  id uuid, slug text, title text, deadline_at timestamptz, deadline_precision text,
  is_rolling boolean, cost text, organisation_name text, category_code text
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT o.id, o.slug, o.title, o.deadline_at, o.deadline_precision::text, o.is_rolling,
         o.cost::text, og.name, c.code
    FROM opportunities o
    LEFT JOIN organisations og ON og.id = o.organisation_id
    LEFT JOIN categories c ON c.id = o.category_id
   WHERE o.status = 'published'
     AND o.deleted_at IS NULL
     AND o.duplicate_of IS NULL
     AND (o.deadline_at IS NULL OR o.deadline_at > now())
     AND (p_country IS NULL
          OR o.eligibility_scope IN ('africa_wide','global')
          OR btrim(p_country) = ANY (SELECT btrim(x) FROM unnest(o.eligible_countries) AS x))
   ORDER BY o.deadline_at NULLS LAST
   LIMIT greatest(1, p_limit)
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
--
-- search_candidates and closing_soon_for_country are reachable by anyone: they return
-- published catalogue data, and search_candidates' only personal input is a user id it
-- uses to compute a verdict whose inputs never leave the database.
REVOKE ALL ON FUNCTION search_candidates(text, halfvec, uuid, char(2), text, text, text, text, boolean, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION closing_soon_for_country(char(2), int) FROM PUBLIC;
REVOKE ALL ON FUNCTION recommendation_candidates(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION replace_user_recommendations(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION active_users_for_recommendations(int) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION search_candidates(text, halfvec, uuid, char(2), text, text, text, text, boolean, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION closing_soon_for_country(char(2), int) TO anon, authenticated;

-- recommendation_candidates takes a user id and returns that user's personalised set,
-- so it is batch-tier only: granting it to `authenticated` would make it an oracle for
-- any account's eligibility.
