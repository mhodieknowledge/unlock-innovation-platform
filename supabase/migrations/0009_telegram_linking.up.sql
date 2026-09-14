-- 0009 Telegram account linking and the bot's data access
--
-- SYSTEM_ARCHITECTURE.md §20 decision 7 and NOTIFICATIONS.md §2: Telegram is the
-- PRIMARY push channel, free and unmetered, versus ~300 emails/day shared with
-- auth. FREE_INFRASTRUCTURE.md §3.7 calls it "the decision that makes retention
-- viable at $0", and §3.6 does the arithmetic: 280 emails/day supports roughly 280
-- daily digest recipients, so email alone cannot carry retention past a few
-- hundred users.
--
-- THE DESIGN PROBLEM, and why this file looks the way it does.
--
-- The bot must act across users: redeem a code, read the tracker behind a linked
-- chat, evaluate that user's eligibility. No anon-key session can do any of that.
-- The obvious shortcut is to give the webhook a service-role key — and
-- SECURITY.md §2 forbids exactly that: the service key "is used only in the batch
-- tier and never in any request-handling path... never present in a Worker
-- environment reachable from the edge."
--
-- So the bot gets NO database-wide key. Every cross-user operation is a narrow
-- SECURITY DEFINER function, and each one requires a bot secret that is verified
-- INSIDE the function against a digest stored here. Consequences:
--   * the public anon key alone cannot call any of them;
--   * a leaked bot secret reaches only these functions, not arbitrary tables;
--   * the eligibility profile never leaves the database — the verdict is computed
--     against it in here and only the verdict comes back (invariant 6, and
--     PRIVACY_AND_COMPLIANCE.md §2 control 2's "returns a verdict only, never the
--     inputs").

CREATE TABLE telegram_link_codes (
  code       text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Short by design. A long-lived code is a standing account-takeover primitive:
  -- anyone who sees it in a screenshot can attach their own chat to the account.
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_link_codes_user_idx ON telegram_link_codes (user_id);
CREATE INDEX telegram_link_codes_expiry_idx ON telegram_link_codes (expires_at);

ALTER TABLE telegram_link_codes ENABLE ROW LEVEL SECURITY;

-- A user may create and read their OWN codes. Redemption happens through the
-- definer function below, so no policy grants it.
CREATE POLICY telegram_link_codes_owner ON telegram_link_codes FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Holds a digest of the bot secret. RLS on, no policy: unreachable by every
-- principal except the definer functions and the batch tier.
CREATE TABLE service_secrets (
  name        text PRIMARY KEY,
  secret_hash text NOT NULL,
  rotated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE service_secrets ENABLE ROW LEVEL SECURITY;

/**
 * Safe text-array extraction from untrusted jsonb params.
 *
 * Returns NULL when the key is missing or is not an array, instead of raising.
 * jsonb_array_elements_text on a scalar throws "cannot extract elements from a
 * scalar", and one malformed params row would then abort the whole verdict query
 * — taking down eligibility for every opportunity in the same batch.
 *
 * The TypeScript engine already guarantees this: "Anything unusable yields
 * `unparsed` rather than throwing, so one malformed row can never break a page."
 * The mirror has to make the same guarantee, and a real corpus case
 * ({"countries":"ZW"} instead of a list) is what exposed that it did not.
 */
CREATE OR REPLACE FUNCTION jsonb_text_array(p jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p IS NULL OR jsonb_typeof(p) <> 'array' THEN NULL
    ELSE ARRAY(SELECT jsonb_array_elements_text(p))
  END
$$;

/**
 * Constant-time-ish comparison of a presented secret against the stored digest.
 * Returns false when no secret is configured, so an unconfigured deployment
 * fails CLOSED rather than accepting anything.
 */
CREATE OR REPLACE FUNCTION verify_service_secret(p_name text, p_secret text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE stored text;
BEGIN
  IF p_secret IS NULL OR length(p_secret) < 16 THEN
    RETURN false;
  END IF;
  SELECT secret_hash INTO stored FROM service_secrets WHERE name = p_name;
  IF stored IS NULL THEN
    RETURN false;
  END IF;
  RETURN stored = encode(digest(p_secret, 'sha256'), 'hex');
END
$$;

-- ── Bot operations. Each verifies the secret first. ─────────────────────────

/**
 * Redeem a link code and attach the chat.
 *
 * Atomic on purpose: a code checked and then used in two statements can be
 * redeemed twice. Returns NULL for expired, already-used and never-existed alike,
 * so the bot cannot be used as an oracle for guessing codes.
 */
CREATE OR REPLACE FUNCTION bot_redeem_link(p_secret text, p_code text, p_chat_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user_id uuid;
BEGIN
  IF NOT verify_service_secret('telegram_bot', p_secret) THEN
    RETURN false;
  END IF;

  DELETE FROM telegram_link_codes WHERE expires_at < now() - interval '1 day';

  UPDATE telegram_link_codes
     SET used_at = now()
   WHERE code = p_code AND used_at IS NULL AND expires_at > now()
  RETURNING user_id INTO v_user_id;

  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO notification_channels (user_id, channel, address, verified_at)
  VALUES (v_user_id, 'telegram', p_chat_id, now())
  ON CONFLICT (user_id, channel) DO UPDATE
    SET address = EXCLUDED.address,
        verified_at = now(),
        is_active = true,
        paused_until = NULL,
        consecutive_failures = 0;

  RETURN true;
END
$$;

/** NOTIFICATIONS.md §7: /pause suspends pushes for 30 days without unlinking. */
CREATE OR REPLACE FUNCTION bot_pause(p_secret text, p_chat_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT verify_service_secret('telegram_bot', p_secret) THEN RETURN false; END IF;
  UPDATE notification_channels
     SET paused_until = now() + interval '30 days'
   WHERE channel = 'telegram' AND address = p_chat_id;
  RETURN true;
END
$$;

/** NOTIFICATIONS.md §7: /stop unlinks completely and is honoured immediately. */
CREATE OR REPLACE FUNCTION bot_unlink(p_secret text, p_chat_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT verify_service_secret('telegram_bot', p_secret) THEN RETURN false; END IF;
  DELETE FROM notification_channels WHERE channel = 'telegram' AND address = p_chat_id;
  RETURN true;
END
$$;

/**
 * Tracker summary for a linked chat: state and count only.
 *
 * Deliberately returns no titles and no notes. ADMIN_SYSTEM.md §6 and
 * MODERATION_AND_TRUST.md §10 keep tracker contents and notes private; a bot
 * reply is a less controlled surface than the app, so it gets the least it can
 * usefully work with.
 */
CREATE OR REPLACE FUNCTION bot_tracker_summary(p_secret text, p_chat_id text)
RETURNS TABLE (state text, n bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT verify_service_secret('telegram_bot', p_secret) THEN RETURN; END IF;

  RETURN QUERY
  SELECT t.state::text, count(*)
    FROM tracker_entries t
    JOIN notification_channels c ON c.user_id = t.user_id
   WHERE c.channel = 'telegram' AND c.address = p_chat_id
   GROUP BY t.state
   ORDER BY count(*) DESC;
END
$$;

/**
 * Eligibility verdicts for a linked chat, computed IN the database.
 *
 * This is the important one. The profile is read here and never returned: the
 * caller gets an opportunity id and a verdict word. The engine's aggregation is
 * mirrored in SQL per SYSTEM_ARCHITECTURE.md §7 ("implemented once in TypeScript
 * and mirrored as a Postgres function for batch use"), including the bias rule —
 * any fail is not_eligible, any unresolved high-stakes rule or missing field is
 * unclear, and ambiguity never becomes eligible.
 */
CREATE OR REPLACE FUNCTION user_verdicts(
  p_user_id uuid,
  p_opportunity_ids uuid[]
)
RETURNS TABLE (opportunity_id uuid, verdict text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE prof eligibility_profiles;
BEGIN
  SELECT e.* INTO prof FROM eligibility_profiles e WHERE e.user_id = p_user_id;

  -- No profile, no personal verdict. The caller shows the unpersonalised page
  -- rather than a guess.
  IF prof.user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH per_rule AS (
    SELECT r.opportunity_id,
           r.is_high_stakes,
           r.confidence,
           CASE
             -- AI_SYSTEM.md §5.4: a high-stakes rule below the floor decides
             -- nothing, in either direction.
             WHEN r.is_high_stakes AND r.confidence < 0.80 THEN 'unparsed'
             WHEN btrim(r.source_quote) = '' THEN 'unparsed'

             WHEN r.rule_type = 'country_in' THEN
               CASE WHEN jsonb_text_array(r.params->'countries') IS NULL THEN 'unparsed'
                    WHEN prof.country_of_residence IS NULL THEN 'unknown'
                    WHEN btrim(prof.country_of_residence) = ANY (jsonb_text_array(r.params->'countries'))
                      THEN 'pass'
                    ELSE 'fail' END

             WHEN r.rule_type = 'country_not_in' THEN
               CASE WHEN jsonb_text_array(r.params->'countries') IS NULL THEN 'unparsed'
                    WHEN prof.country_of_residence IS NULL THEN 'unknown'
                    WHEN btrim(prof.country_of_residence) = ANY (jsonb_text_array(r.params->'countries'))
                      THEN 'fail'
                    ELSE 'pass' END

             WHEN r.rule_type = 'nationality_in' THEN
               CASE WHEN jsonb_text_array(r.params->'countries') IS NULL THEN 'unparsed'
                    WHEN coalesce(cardinality(prof.nationalities), 0) = 0 THEN 'unknown'
                    -- nationalities is char(2)[] and blank-padded, so compare
                    -- trimmed values rather than relying on an array operator
                    -- that needs identical element types.
                    WHEN EXISTS (
                      SELECT 1 FROM unnest(prof.nationalities) AS n
                       WHERE btrim(n) = ANY (jsonb_text_array(r.params->'countries'))
                    ) THEN 'pass'
                    ELSE 'fail' END

             WHEN r.rule_type = 'student_status_in' THEN
               CASE WHEN jsonb_text_array(r.params->'statuses') IS NULL THEN 'unparsed'
                    WHEN prof.student_status IS NULL THEN 'unknown'
                    WHEN prof.student_status = ANY (jsonb_text_array(r.params->'statuses'))
                      THEN 'pass'
                    ELSE 'fail' END

             WHEN r.rule_type = 'age_between' THEN
               CASE
                 WHEN r.params->>'min' IS NULL AND r.params->>'max' IS NULL THEN 'unparsed'
                 WHEN prof.birth_year IS NULL THEN 'unknown'
                 -- Birth year alone leaves age ambiguous by one. Pass only when
                 -- BOTH possible ages satisfy, fail only when neither does, and
                 -- report the boundary as unknown rather than guessing.
                 WHEN  (r.params->>'min' IS NULL OR
                        (extract(year FROM now())::int - prof.birth_year - 1) >= (r.params->>'min')::int)
                   AND (r.params->>'max' IS NULL OR
                        (extract(year FROM now())::int - prof.birth_year) <= (r.params->>'max')::int)
                   THEN 'pass'
                 WHEN  (r.params->>'min' IS NOT NULL AND
                        (extract(year FROM now())::int - prof.birth_year) < (r.params->>'min')::int)
                    OR (r.params->>'max' IS NOT NULL AND
                        (extract(year FROM now())::int - prof.birth_year - 1) > (r.params->>'max')::int)
                   THEN 'fail'
                 ELSE 'unknown'
               END

             WHEN r.rule_type = 'residency_required' THEN
               CASE WHEN jsonb_text_array(r.params->'countries') IS NULL THEN 'unparsed'
                    WHEN prof.country_of_residence IS NULL THEN 'unknown'
                    WHEN btrim(prof.country_of_residence) = ANY (jsonb_text_array(r.params->'countries'))
                      THEN 'pass'
                    ELSE 'fail' END

             WHEN r.rule_type = 'year_of_study_in' THEN
               CASE WHEN prof.year_of_study IS NULL THEN 'unknown'
                    WHEN jsonb_text_array(r.params->'years') IS NOT NULL THEN
                      CASE WHEN prof.year_of_study::text = ANY (jsonb_text_array(r.params->'years'))
                        THEN 'pass'
                      ELSE 'fail' END
                    WHEN (r.params->>'min' IS NULL OR prof.year_of_study >= (r.params->>'min')::int)
                     AND (r.params->>'max' IS NULL OR prof.year_of_study <= (r.params->>'max')::int)
                      THEN 'pass'
                    ELSE 'fail' END

             WHEN r.rule_type = 'institution_type_in' THEN
               CASE WHEN jsonb_text_array(r.params->'types') IS NULL THEN 'unparsed'
                    WHEN prof.institution_type IS NULL THEN 'unknown'
                    WHEN lower(prof.institution_type) = ANY (
                      SELECT lower(x) FROM unnest(jsonb_text_array(r.params->'types')) AS x)
                      THEN 'pass'
                    ELSE 'fail' END

             WHEN r.rule_type = 'experience_between' THEN
               -- Zero is a supplied value, not a missing one.
               CASE WHEN r.params->>'min' IS NULL AND r.params->>'max' IS NULL THEN 'unparsed'
                    WHEN prof.years_experience IS NULL THEN 'unknown'
                    WHEN (r.params->>'min' IS NULL OR prof.years_experience >= (r.params->>'min')::int)
                     AND (r.params->>'max' IS NULL OR prof.years_experience <= (r.params->>'max')::int)
                      THEN 'pass'
                    ELSE 'fail' END

             WHEN r.rule_type = 'language_required' THEN
               CASE WHEN jsonb_text_array(r.params->'languages') IS NULL THEN 'unparsed'
                    WHEN coalesce(cardinality(prof.languages), 0) = 0 THEN 'unknown'
                    WHEN EXISTS (
                      SELECT 1 FROM unnest(prof.languages) AS l
                       WHERE lower(l) = ANY (
                         SELECT lower(x) FROM unnest(jsonb_text_array(r.params->'languages')) AS x)
                    ) THEN 'pass'
                    ELSE 'fail' END

             -- Never inferred: only evaluated against a value explicitly given
             -- (PRODUCT_SPEC.md §12.2).
             WHEN r.rule_type = 'gender_restricted' THEN
               CASE WHEN jsonb_text_array(r.params->'genders') IS NULL THEN 'unparsed'
                    WHEN prof.gender IS NULL THEN 'unknown'
                    WHEN lower(prof.gender) = ANY (
                      SELECT lower(x) FROM unnest(jsonb_text_array(r.params->'genders')) AS x)
                      THEN 'pass'
                    ELSE 'fail' END

             -- A remote-only PREFERENCE is deliberately not read as
             -- ineligibility: 01_PASS2_CRITIQUE.md §E2 rates wrongly excluding
             -- someone as the worse error.
             WHEN r.rule_type = 'travel_required' THEN
               CASE WHEN prof.can_travel IS NULL THEN 'unknown'
                    WHEN prof.can_travel THEN 'pass'
                    ELSE 'fail' END

             -- Prose we could not structure, including requirements resting on
             -- attributes we deliberately never collect
             -- (PRIVACY_AND_COMPLIANCE.md §3). Always forces unclear.
             WHEN r.rule_type = 'other_unstructured' THEN 'unparsed'

             -- Informational rule types describe the opportunity, not the person.
             WHEN r.rule_type IN ('team_size_between','individual_only','team_only','cost')
               THEN 'informational'

             ELSE 'unparsed'
           END AS outcome
      FROM eligibility_rules r
     WHERE r.opportunity_id = ANY (p_opportunity_ids)
  ),
  gating AS (
    SELECT * FROM per_rule WHERE outcome <> 'informational'
  )
  SELECT o.id,
         CASE
           WHEN NOT EXISTS (SELECT 1 FROM gating g WHERE g.opportunity_id = o.id) THEN 'unclear'
           WHEN EXISTS (SELECT 1 FROM gating g WHERE g.opportunity_id = o.id AND g.outcome = 'fail')
             THEN 'not_eligible'
           WHEN EXISTS (SELECT 1 FROM gating g WHERE g.opportunity_id = o.id
                          AND g.outcome IN ('unparsed','unknown'))
             THEN 'unclear'
           WHEN EXISTS (SELECT 1 FROM gating g WHERE g.opportunity_id = o.id AND g.confidence < 0.80)
             THEN 'likely_eligible'
           ELSE 'eligible'
         END
    FROM unnest(p_opportunity_ids) AS o(id);
END
$$;

/**
 * The bot's view of the same function.
 *
 * Resolves the chat to its linked account and delegates: ONE mirror, not two. The
 * profile still never leaves the database — only the verdict word comes back.
 */
CREATE OR REPLACE FUNCTION bot_verdicts(
  p_secret text,
  p_chat_id text,
  p_opportunity_ids uuid[]
)
RETURNS TABLE (opportunity_id uuid, verdict text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user_id uuid;
BEGIN
  IF NOT verify_service_secret('telegram_bot', p_secret) THEN RETURN; END IF;

  SELECT c.user_id INTO v_user_id
    FROM notification_channels c
   WHERE c.channel = 'telegram' AND c.address = p_chat_id;

  IF v_user_id IS NULL THEN RETURN; END IF;

  RETURN QUERY SELECT * FROM user_verdicts(v_user_id, p_opportunity_ids);
END
$$;

-- The bot calls these with the public anon key PLUS the bot secret. Granting to
-- anon is safe only because every function verifies the secret first.
REVOKE ALL ON FUNCTION verify_service_secret(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bot_redeem_link(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bot_pause(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bot_unlink(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bot_tracker_summary(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bot_verdicts(text, text, uuid[]) FROM PUBLIC;
-- user_verdicts takes a user id, so it must never be callable by a request-tier
-- principal: that would be an eligibility oracle for any account. Batch tier only.
REVOKE ALL ON FUNCTION user_verdicts(uuid, uuid[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION bot_redeem_link(text, text, text) TO anon;
GRANT EXECUTE ON FUNCTION bot_pause(text, text) TO anon;
GRANT EXECUTE ON FUNCTION bot_unlink(text, text) TO anon;
GRANT EXECUTE ON FUNCTION bot_tracker_summary(text, text) TO anon;
GRANT EXECUTE ON FUNCTION bot_verdicts(text, text, uuid[]) TO anon;

/**
 * Digest suppression, as a function so the dispatcher and any future caller
 * cannot disagree. NOTIFICATIONS.md §5.1:
 *   fewer than 2 items     -> not sent at all
 *   nothing new since last -> not sent
 *   opened the app in 12h  -> daily downgrades to weekly automatically
 *
 * "A thin digest teaches people to ignore digests" is the reasoning, which is why
 * silence is an acceptable outcome rather than a failure.
 */
CREATE OR REPLACE FUNCTION digest_should_send(
  p_item_count int,
  p_last_sent_at timestamptz,
  p_last_seen_at timestamptz,
  p_frequency text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_frequency <> 'off'
     AND p_item_count >= 2
     AND (
       p_last_sent_at IS NULL
       OR CASE
            WHEN p_frequency = 'daily'
                 AND (p_last_seen_at IS NULL OR p_last_seen_at < now() - interval '12 hours')
              THEN p_last_sent_at < now() - interval '20 hours'
            ELSE p_last_sent_at < now() - interval '6 days'
          END
     )
$$;
