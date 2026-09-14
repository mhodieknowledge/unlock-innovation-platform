-- 0013 provider configuration and duplicate candidates
--
-- AI_SYSTEM.md §2 guardrail 6 `[PR]`: "No model name in application code. Models are
-- configuration rows. Free catalogues change without notice (Cerebras has dropped
-- models silently; Gemini removed Pro from the free tier)."
--
-- That guardrail is the reason this table exists rather than a constant in a script.
-- When a provider drops a model, the fix is an UPDATE and the next batch run picks it
-- up — not a code change, a review and a deploy while extraction is down.

CREATE TABLE ai_providers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  -- Which task this row serves. §3.1 routes by task rather than by a fixed order:
  -- long HTML wants a large context, rule derivation wants a small fast model.
  task          text NOT NULL CHECK (task IN ('extract','rules','brief','query','dedupe','moderate')),
  model         text NOT NULL,
  -- Lower runs first. §3.1's chain is expressed as priorities so it can be
  -- reordered per task without touching code.
  priority      smallint NOT NULL DEFAULT 50,
  enabled       boolean NOT NULL DEFAULT true,
  -- The free-tier ceilings from §3.1, so the accountant can stop before a 429
  -- rather than learning the limit by hitting it.
  daily_request_limit int,
  requests_per_minute int,
  -- §2 guardrail 5 `[PR]`: "No personal data to training-tier providers." Gemini's
  -- free tier and Mistral's experiment tier use inputs for improvement. Routing
  -- enforces it; this column is what routing reads.
  trains_on_input boolean NOT NULL DEFAULT false,
  endpoint      text,
  -- Names the environment variable, never the key. Invariant 11.
  api_key_env   text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, task, model)
);

CREATE INDEX ai_providers_routing_idx ON ai_providers (task, priority) WHERE enabled;

ALTER TABLE ai_providers ENABLE ROW LEVEL SECURITY;

-- Readable by the batch tier (service role, no policy needed) and by superadmins,
-- who are the people who change a model when a catalogue shifts.
CREATE POLICY ai_providers_admin_read ON ai_providers FOR SELECT
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND is_admin));
CREATE POLICY ai_providers_superadmin_write ON ai_providers FOR ALL
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND admin_role = 'superadmin'))
  WITH CHECK (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND admin_role = 'superadmin'));

COMMENT ON TABLE ai_providers IS
  'AI_SYSTEM.md §3.1. Model names live here, never in code. A dropped model is an UPDATE, not a deploy.';

/**
 * The chain for one task, best first, skipping anything disabled, anything whose
 * key is absent, and anything over its daily limit.
 *
 * p_allow_training_providers is the enforcement point for §2 guardrail 5. The caller
 * passes false for any task that could carry user text, and the routing layer then
 * cannot reach a provider that trains on its input — rather than that being a rule
 * someone has to remember.
 */
CREATE OR REPLACE FUNCTION ai_chain_for(
  p_task text,
  p_allow_training_providers boolean DEFAULT true
)
RETURNS TABLE (
  provider text,
  model text,
  endpoint text,
  api_key_env text,
  priority smallint,
  requests_per_minute int,
  used_today bigint,
  daily_request_limit int
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT p.provider, p.model, p.endpoint, p.api_key_env, p.priority, p.requests_per_minute,
         coalesce(u.calls, 0), p.daily_request_limit
    FROM ai_providers p
    LEFT JOIN (
      SELECT a.provider, count(*) AS calls
        FROM ai_usage a
       WHERE a.created_at >= date_trunc('day', now())
         AND a.outcome <> 'breaker_open'
       GROUP BY a.provider
    ) u ON u.provider = p.provider
   WHERE p.enabled
     AND p.task = p_task
     AND (p_allow_training_providers OR NOT p.trains_on_input)
     -- §3.2: stop before the ceiling rather than discovering it as a 429.
     AND (p.daily_request_limit IS NULL OR coalesce(u.calls, 0) < p.daily_request_limit)
   ORDER BY p.priority, p.provider
$$;

-- ── §9 duplicate candidates ─────────────────────────────────────────────────
--
-- "Deterministic first, AI last." The table exists so steps 2 and 3 can record what
-- they found and why, and so the model is only ever asked about a pair that a
-- deterministic check already thought was worth asking about.

CREATE TABLE dedupe_candidates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Ordered pair, smaller id first, so a pair is recorded once however it is found.
  left_id      uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  right_id     uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  method       text NOT NULL CHECK (method IN ('canonical_url','trigram_title','embedding','model')),
  score        numeric(4,3),
  -- What the model said, when it was asked at all. NULL means it was not.
  model_verdict text CHECK (model_verdict IN ('same','different','unsure')),
  model_reason text,
  state        text NOT NULL DEFAULT 'open'
                 CHECK (state IN ('open','merged','distinct','dismissed')),
  resolved_by  uuid REFERENCES users(id),
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dedupe_pair_ordered CHECK (left_id < right_id),
  UNIQUE (left_id, right_id)
);

CREATE INDEX dedupe_open_idx ON dedupe_candidates (state, created_at) WHERE state = 'open';

ALTER TABLE dedupe_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY dedupe_admin_read ON dedupe_candidates FOR SELECT
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND is_admin));

/**
 * Record a candidate pair, normalising the order so one pair is one row.
 *
 * Returns the row id so the caller can attach a model verdict later. A pair found by
 * two different methods keeps the FIRST method that found it: §9's methods are in
 * descending order of certainty, and a canonical-URL match is not made less certain
 * by a trigram check agreeing with it.
 */
CREATE OR REPLACE FUNCTION record_dedupe_candidate(
  p_a uuid,
  p_b uuid,
  p_method text,
  p_score numeric DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_left uuid := least(p_a, p_b);
  v_right uuid := greatest(p_a, p_b);
  v_id uuid;
BEGIN
  IF p_a IS NULL OR p_b IS NULL OR p_a = p_b THEN
    RETURN NULL;
  END IF;

  INSERT INTO dedupe_candidates (left_id, right_id, method, score)
  VALUES (v_left, v_right, p_method, p_score)
  ON CONFLICT (left_id, right_id) DO UPDATE
    SET score = coalesce(dedupe_candidates.score, EXCLUDED.score)
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

/**
 * §9 step 2, run in the database because pg_trgm lives here.
 *
 * "pg_trgm similarity on title >= 0.62 AND same organisation AND deadline within
 * +/-3 days". All three conditions, because title similarity alone matches every
 * annual edition of the same programme against every other — and merging 2026's
 * round into 2027's would delete a live opportunity.
 */
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

/**
 * Merge a duplicate. §4.6 `[PR]`, and every clause of it is a choice about which
 * error to prefer:
 *
 *   * the HIGHEST-VERIFICATION record stays canonical — a human-checked record
 *     should not be replaced by an auto-extracted one;
 *   * eligible_countries are UNIONED — dropping a country would tell someone they
 *     cannot apply when they can;
 *   * the EARLIEST deadline wins — conservative, because missing a deadline costs
 *     more than applying early;
 *   * all source links are retained;
 *   * the loser keeps duplicate_of so its URL answers 410 with merged_into rather
 *     than 404 or a silent redirect.
 */
CREATE OR REPLACE FUNCTION merge_opportunities(
  p_canonical uuid,
  p_duplicate uuid,
  p_actor uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a record;
  b record;
  v_keep uuid;
  v_drop uuid;
  v_rank text[] := ARRAY['official','verified','auto','community_flagged','stale','expired','disputed'];
BEGIN
  SELECT * INTO a FROM opportunities WHERE id = p_canonical;
  SELECT * INTO b FROM opportunities WHERE id = p_duplicate;
  IF a.id IS NULL OR b.id IS NULL OR a.id = b.id THEN RETURN NULL; END IF;

  -- Highest verification is canonical, whatever the caller proposed. Passing the
  -- pair in either order must give the same result, or a merge becomes dependent on
  -- which record the dedupe job happened to see first.
  IF array_position(v_rank, b.verification::text) < array_position(v_rank, a.verification::text) THEN
    v_keep := b.id; v_drop := a.id;
  ELSE
    v_keep := a.id; v_drop := b.id;
  END IF;

  UPDATE opportunities k
     SET eligible_countries = ARRAY(
           SELECT DISTINCT c FROM unnest(k.eligible_countries || d.eligible_countries) AS c
            WHERE c IS NOT NULL),
         deadline_at = LEAST(
           coalesce(k.deadline_at, d.deadline_at),
           coalesce(d.deadline_at, k.deadline_at)),
         -- The loser's links are kept where the winner has none, so no attribution
         -- is lost (§2.1 rule 7 requires attribution to the source).
         source_url = coalesce(k.source_url, d.source_url),
         official_url = coalesce(k.official_url, d.official_url),
         apply_url = coalesce(k.apply_url, d.apply_url),
         updated_at = now()
    FROM opportunities d
   WHERE k.id = v_keep AND d.id = v_drop;

  -- Anyone tracking the loser now tracks the winner. Silently dropping their
  -- tracker entry would lose the reminder they saved it for.
  UPDATE tracker_entries t
     SET opportunity_id = v_keep
   WHERE t.opportunity_id = v_drop
     AND NOT EXISTS (
       SELECT 1 FROM tracker_entries e
        WHERE e.user_id = t.user_id AND e.opportunity_id = v_keep);
  DELETE FROM tracker_entries WHERE opportunity_id = v_drop;

  UPDATE opportunities
     SET status = 'merged', duplicate_of = v_keep, updated_at = now()
   WHERE id = v_drop;

  UPDATE dedupe_candidates
     SET state = 'merged', resolved_by = p_actor, resolved_at = now()
   WHERE least(left_id, right_id) = least(v_keep, v_drop)
     AND greatest(left_id, right_id) = greatest(v_keep, v_drop);

  INSERT INTO admin_audit_log (actor_user_id, action, subject_type, subject_id, after)
  VALUES (p_actor, 'merge_opportunity', 'opportunity', v_drop,
          jsonb_build_object('merged_into', v_keep));

  RETURN v_keep;
END
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION ai_chain_for(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_dedupe_candidate(uuid, uuid, text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION merge_opportunities(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION dedupe_candidates_for(uuid) FROM PUBLIC;
