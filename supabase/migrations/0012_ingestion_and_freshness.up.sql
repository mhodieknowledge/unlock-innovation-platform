-- 0012 ingestion accounting, publication routing, and the freshness model
--
-- OPPORTUNITY_INGESTION.md §4.7 and §5, AI_SYSTEM.md §3.2 and §12.
--
-- 0005 and 0006 gave the pipeline its tables. This gives it the DECISIONS: when a
-- record may auto-publish, when it must be re-verified, what counts as a change
-- worth telling someone about, and when something becomes stale, closed or expired.
--
-- They live here rather than in the ingestion script for the same reason the
-- notification rules do: these are the promises the product makes about freshness,
-- and a promise enforced in one script is a promise the next script breaks. The
-- script fetches and parses; the database decides.

-- ── AI accounting (AI_SYSTEM.md §3.2) ───────────────────────────────────────
--
-- "All consumption is logged to ai_usage. The daily budget-report job alerts the
-- operator via Telegram at 70% and 90% of any provider's daily quota."
--
-- Note what is NOT here: prompt or response text. §2 guardrail 5 keeps user data
-- away from providers, and logging request bodies would quietly recreate the
-- exposure inside our own database. Counts and outcomes are what the budget needs.
CREATE TABLE ai_usage (
  id          bigserial PRIMARY KEY,
  provider    text NOT NULL,
  task        text NOT NULL,
  -- Models are configuration, never hard-coded (§2 guardrail 6), so the model
  -- actually used is recorded per call rather than assumed from the provider.
  model       text NOT NULL,
  prompt_version text,
  tokens_in   int NOT NULL DEFAULT 0,
  tokens_out  int NOT NULL DEFAULT 0,
  latency_ms  int,
  outcome     text NOT NULL CHECK (outcome IN ('ok','schema_invalid','rate_limited','error','breaker_open','no_ai')),
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_day_idx ON ai_usage (created_at DESC);
CREATE INDEX ai_usage_provider_day_idx ON ai_usage (provider, created_at DESC);

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
-- Batch tier only.

/** Today's calls per provider, for the budget report and the circuit breaker. */
CREATE OR REPLACE FUNCTION ai_usage_today()
RETURNS TABLE (provider text, calls bigint, tokens_in bigint, tokens_out bigint, errors bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT u.provider, count(*), sum(u.tokens_in), sum(u.tokens_out),
         count(*) FILTER (WHERE u.outcome <> 'ok')
    FROM ai_usage u
   WHERE u.created_at >= date_trunc('day', now())
   GROUP BY u.provider
   ORDER BY count(*) DESC
$$;

-- ── Source health (§3) ──────────────────────────────────────────────────────

/**
 * Record the outcome of a fetch against its source.
 *
 * "consecutive_failures >= 3 marks the source degraded"; a success resets the
 * counter. A silently dead source is the most likely cause of catalogue rot, so
 * this is the one counter the pipeline must never forget to update — which is why
 * it is one function called from one place.
 */
CREATE OR REPLACE FUNCTION record_source_fetch(
  p_source_id uuid,
  p_status fetch_status,
  p_http_status int DEFAULT NULL,
  p_items_seen int DEFAULT 0,
  p_items_new int DEFAULT 0,
  p_error text DEFAULT NULL,
  p_etag text DEFAULT NULL,
  p_last_modified text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO source_fetches (source_id, started_at, finished_at, status, http_status,
                              items_seen, items_new, error)
  VALUES (p_source_id, now(), now(), p_status, p_http_status,
          coalesce(p_items_seen,0), coalesce(p_items_new,0), left(p_error, 1000))
  RETURNING id INTO v_id;

  -- not_modified is a SUCCESS: the source answered correctly and cheaply. Counting
  -- it as a failure would degrade every well-behaved source that rarely changes.
  IF p_status IN ('ok','not_modified') THEN
    UPDATE sources
       SET last_fetch_at = now(),
           last_success_at = now(),
           consecutive_failures = 0,
           etag = coalesce(p_etag, etag),
           last_modified = coalesce(p_last_modified, last_modified)
     WHERE id = p_source_id;
  ELSE
    UPDATE sources
       SET last_fetch_at = now(),
           consecutive_failures = consecutive_failures + 1
     WHERE id = p_source_id;
  END IF;

  RETURN v_id;
END
$$;

/** §3: degraded at 3 consecutive failures, surfaced on the admin dashboard. */
CREATE OR REPLACE FUNCTION degraded_sources()
RETURNS TABLE (id uuid, name text, consecutive_failures int, last_success_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT s.id, s.name, s.consecutive_failures, s.last_success_at
    FROM sources s
   WHERE s.is_active AND s.consecutive_failures >= 3
   ORDER BY s.consecutive_failures DESC, s.last_success_at NULLS FIRST
$$;

/**
 * §3 `[PR]`: ">= 3 sources degraded for >= 12 h sends a Telegram alert to the
 * operator". The 12-hour qualifier matters — three sources failing at once is
 * usually one network blip, and alerting on it trains the operator to ignore alerts.
 */
CREATE OR REPLACE FUNCTION source_health_alert_due()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM sources s
   WHERE s.is_active
     AND s.consecutive_failures >= 3
     AND (s.last_success_at IS NULL OR s.last_success_at < now() - interval '12 hours');

  IF v_n >= 3 THEN
    RETURN format('%s sources have been failing for over 12 hours. A dead source is silent catalogue rot (OPPORTUNITY_INGESTION.md §3).', v_n);
  END IF;
  RETURN NULL;
END
$$;

-- ── §5.1 re-verification cadence ────────────────────────────────────────────

/**
 * How long until this record must be checked again.
 *
 *   <= 3 days to deadline -> 12 hours
 *   <= 7 days            -> 24 hours
 *   <= 30 days           -> 3 days
 *   > 30 days            -> 7 days
 *   rolling or unknown   -> 14 days
 *
 * The shape of the table is the point: a wrong deadline matters most when the
 * deadline is near, so attention is spent where being wrong is expensive.
 *
 * REPLACES 0006's single-argument version rather than overloading it. §5.1 gives
 * rolling deadlines their own 14-day band, and the old signature had no way to say
 * "rolling" — a rolling opportunity has no deadline_at, so it fell into the NULL
 * case and got the right answer by accident. Two functions of the same name with
 * nearly the same meaning is how the next caller picks the wrong one, so there is
 * now one. The default keeps every existing call site correct.
 */
DROP FUNCTION IF EXISTS next_verify_interval(timestamptz);

CREATE OR REPLACE FUNCTION next_verify_interval(
  p_deadline_at timestamptz,
  p_is_rolling boolean DEFAULT false
)
RETURNS interval
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_is_rolling OR p_deadline_at IS NULL THEN interval '14 days'
    WHEN p_deadline_at <= now() + interval '3 days'  THEN interval '12 hours'
    WHEN p_deadline_at <= now() + interval '7 days'  THEN interval '24 hours'
    WHEN p_deadline_at <= now() + interval '30 days' THEN interval '3 days'
    ELSE interval '7 days'
  END
$$;

/**
 * Apply the cadence to every published record.
 *
 * Recomputed rather than set once at publish: a record published 60 days out moves
 * through every band as its deadline approaches, and a next_verify_at frozen at
 * publish time would check it weekly on the day before it closes.
 */
CREATE OR REPLACE FUNCTION apply_verification_cadence()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n int;
BEGIN
  WITH updated AS (
    UPDATE opportunities o
       SET next_verify_at = coalesce(o.last_verified_at, now())
                          + next_verify_interval(o.deadline_at, o.is_rolling)
     WHERE o.status = 'published'
       AND o.deleted_at IS NULL
       AND (o.next_verify_at IS NULL
            OR o.next_verify_at <> coalesce(o.last_verified_at, now())
                                 + next_verify_interval(o.deadline_at, o.is_rolling))
    RETURNING 1)
  SELECT count(*)::int INTO n FROM updated;
  RETURN n;
END
$$;

/** What the verify job should look at next, most urgent first. */
CREATE OR REPLACE FUNCTION due_for_verification(p_limit int DEFAULT 50)
RETURNS TABLE (
  id uuid, slug text, source_url text, official_url text, apply_url text,
  deadline_at timestamptz, next_verify_at timestamptz, source_id uuid
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT o.id, o.slug, o.source_url, o.official_url, o.apply_url,
         o.deadline_at, o.next_verify_at, o.source_id
    FROM opportunities o
   WHERE o.status = 'published'
     AND o.deleted_at IS NULL
     AND (o.next_verify_at IS NULL OR o.next_verify_at <= now())
   ORDER BY o.deadline_at NULLS LAST
   LIMIT greatest(1, p_limit)
$$;

-- ── §5.3 change detection ───────────────────────────────────────────────────

/**
 * Record a changed field, and tell the people tracking it — ONCE.
 *
 * §5.3 `[PR]`: a change to deadline, eligibility, cost or apply URL notifies every
 * user tracking the record with "old value, new value and the source". Other fields
 * update silently but are logged. A deadline moving LATER still notifies, because
 * people plan around deadlines.
 *
 * "Exactly one notification" is the part that needs enforcing, and the enforcement
 * is a key in the payload: one per (change row, user). A re-extraction that produces
 * the same diff twice therefore cannot double-notify, and the guard survives the job
 * being re-run — which §1 requires of every stage.
 */
CREATE OR REPLACE FUNCTION record_opportunity_change(
  p_opportunity_id uuid,
  p_field text,
  p_old jsonb,
  p_new jsonb,
  p_changed_by text DEFAULT 'reverify'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notify boolean;
  v_change_id uuid;
  v_opp record;
  r record;
  v_key text;
BEGIN
  IF p_old IS NOT DISTINCT FROM p_new THEN
    RETURN NULL;   -- not a change
  END IF;

  -- IDEMPOTENCE, and it has to be by CONTENT rather than by row id.
  --
  -- §1 requires every stage to be independently re-runnable, and re-verification
  -- re-extracts the whole document: a source whose deadline moved last Tuesday
  -- still reports the same old-to-new transition on every run afterwards, because
  -- the comparison is against what we stored before that change. Keying the
  -- notification on a freshly inserted change row would therefore notify every
  -- tracker on every run — the opposite of §5.3's "exactly one".
  --
  -- So an identical transition already recorded is THE SAME change, and the
  -- existing row is returned. The 30-day window is what keeps that from being
  -- wrong in the other direction: a deadline that genuinely moves back and forth
  -- months apart is real news each time, while a re-extraction hours later is not.
  SELECT id INTO v_change_id
    FROM opportunity_changes
   WHERE opportunity_id = p_opportunity_id
     AND field = p_field
     AND old_value IS NOT DISTINCT FROM p_old
     AND new_value IS NOT DISTINCT FROM p_new
     AND created_at > now() - interval '30 days'
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_change_id IS NOT NULL THEN
    RETURN v_change_id;
  END IF;

  v_notify := p_field IN ('deadline_at','deadline_precision','eligibility_scope',
                          'eligible_countries','cost','apply_url','eligibility_rules');

  INSERT INTO opportunity_changes (opportunity_id, field, old_value, new_value,
                                   changed_by, notify_trackers)
  VALUES (p_opportunity_id, p_field, p_old, p_new, p_changed_by, v_notify)
  RETURNING id INTO v_change_id;

  IF NOT v_notify THEN
    RETURN v_change_id;
  END IF;

  SELECT o.slug, o.title, o.deadline_at, o.is_rolling,
         coalesce(o.official_url, o.source_url) AS source_link
    INTO v_opp
    FROM opportunities o WHERE o.id = p_opportunity_id;

  FOR r IN
    SELECT t.user_id
      FROM tracker_entries t
     WHERE t.opportunity_id = p_opportunity_id
       -- Terminal states are not tracking any more; telling someone a deadline
       -- moved on something they withdrew from is noise.
       AND t.state IN ('saved','planning_to_apply','applied','submitted','participating')
  LOOP
    v_key := v_change_id::text || ':' || r.user_id::text;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM notifications
       WHERE user_id = r.user_id AND type = 'opportunity_changed'
         AND payload->>'key' = v_key
    );

    PERFORM enqueue_notification(
      r.user_id, 'opportunity_changed',
      format('You are tracking this, and its %s changed.', replace(p_field,'_',' ')),
      jsonb_build_object(
        'key', v_key,
        'opportunity_id', p_opportunity_id,
        'slug', v_opp.slug,
        'title', v_opp.title,
        'field', p_field,
        'old', p_old,
        'new', p_new,
        'source', v_opp.source_link),
      CASE WHEN v_opp.deadline_at IS NULL THEN NULL
           ELSE extract(epoch FROM (v_opp.deadline_at - now())) / 3600 END,
      false);
  END LOOP;

  RETURN v_change_id;
END
$$;

-- ── §5.4 staleness and expiry ───────────────────────────────────────────────

/**
 * The four state transitions of §5.4, as one idempotent job.
 *
 * Expired records are NEVER deleted (§5.4 `[PR]`): they keep their URL, keep an
 * expired banner, stay on the organisation page as history, and are excluded from
 * search and feeds. That preserves inbound links honestly and is the historical
 * record that later makes "this runs annually" possible.
 */
CREATE OR REPLACE FUNCTION apply_staleness_and_expiry()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stale int;
  v_expired int;
  v_closed int;
  r record;
BEGIN
  -- Stale: past due for verification by more than a week. Badge shown, ranking
  -- reduced, but still published — an unverified record is not a false one.
  WITH s AS (
    UPDATE opportunities
       SET verification = 'stale'
     WHERE status = 'published'
       AND deleted_at IS NULL
       AND verification NOT IN ('stale','disputed','community_flagged')
       AND next_verify_at IS NOT NULL
       AND next_verify_at < now() - interval '7 days'
    RETURNING 1)
  SELECT count(*)::int INTO v_stale FROM s;

  -- Expired, with a precision buffer: a date-only deadline is treated as expiring
  -- at the END of that day here, the opposite of how it is DISPLAYED. Displaying
  -- conservatively protects the applicant; expiring generously avoids removing
  -- something that may still be open. Both err away from harm.
  FOR r IN
    SELECT id FROM opportunities
     WHERE status = 'published'
       AND deleted_at IS NULL
       AND deadline_at IS NOT NULL
       AND NOT is_rolling
       AND deadline_at < now() - CASE
             WHEN deadline_precision = 'month_only' THEN interval '31 days'
             WHEN deadline_precision = 'date_only'  THEN interval '1 day'
             ELSE interval '0'
           END
  LOOP
    UPDATE opportunities
       SET status = 'expired', verification = 'expired'
     WHERE id = r.id;
  END LOOP;
  SELECT count(*)::int INTO v_expired FROM opportunities
   WHERE status = 'expired' AND updated_at >= now() - interval '1 minute';

  -- Two consecutive link failures, recorded by the link-health job.
  WITH c AS (
    UPDATE opportunities
       SET status = 'closed'
     WHERE status = 'published'
       AND deleted_at IS NULL
       AND link_ok = false
       AND link_checked_at < now() - interval '6 hours'
    RETURNING 1)
  SELECT count(*)::int INTO v_closed FROM c;

  RETURN jsonb_build_object('marked_stale', v_stale, 'expired', v_expired, 'closed', v_closed);
END
$$;

-- ── §4.7 score and route ────────────────────────────────────────────────────

/**
 * May this candidate publish itself, or must a person look at it?
 *
 * Returns the decision AND the reason, because "why is my queue full" is the
 * question an operator actually asks, and a boolean cannot answer it.
 *
 * The absolute review triggers are checked FIRST and are not overridable by any
 * confidence score. §4.7 marks them `[PR]`, and every one of them is a place where
 * being wrong costs a user money: a fee, an implausible prize, an unclear scope
 * attached to a prize, an untrusted source, a flagged link, or a source that has
 * not yet proved itself.
 */
CREATE OR REPLACE FUNCTION route_for_publication(
  p_source_id uuid,
  p_extraction_confidence numeric,
  p_deadline_confidence numeric,
  p_country_confidence numeric,
  p_cost cost_kind,
  p_prize_amount numeric,
  p_prize_currency char(3),
  p_eligibility_scope eligibility_scope,
  p_link_ok boolean,
  p_organisation_id uuid,
  p_fee_keyword_hit boolean DEFAULT false,
  p_safe_browsing_hit boolean DEFAULT false
)
RETURNS TABLE (decision text, reason text)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_trust numeric;
  v_published int;
  v_prize_threshold numeric := 50000;
BEGIN
  SELECT s.trust_score, s.records_published INTO v_trust, v_published
    FROM sources s WHERE s.id = p_source_id;

  -- ── Absolute review triggers. Never auto-publish. ────────────────────────
  IF p_cost = 'paid' OR p_fee_keyword_hit THEN
    RETURN QUERY SELECT 'review', 'a fee to apply was detected — invariant 13 forbids publishing this at all without a person confirming it is wrong';
    RETURN;
  END IF;
  IF p_safe_browsing_hit THEN
    RETURN QUERY SELECT 'review', 'a link was flagged by Safe Browsing';
    RETURN;
  END IF;
  IF p_prize_amount IS NOT NULL AND p_prize_currency = 'USD' AND p_prize_amount > v_prize_threshold THEN
    RETURN QUERY SELECT 'review', format('prize above USD %s — high-value listings are the most attractive scam vector', v_prize_threshold);
    RETURN;
  END IF;
  IF p_eligibility_scope = 'unclear' AND p_prize_amount IS NOT NULL THEN
    RETURN QUERY SELECT 'review', 'unclear eligibility combined with a stated prize';
    RETURN;
  END IF;
  IF coalesce(v_trust, 0) < 0.4 THEN
    RETURN QUERY SELECT 'review', 'source trust below 0.4';
    RETURN;
  END IF;
  IF coalesce(v_published, 0) < 5 THEN
    RETURN QUERY SELECT 'review', format('this source has published %s records; its first 5 are always reviewed', coalesce(v_published,0));
    RETURN;
  END IF;

  -- ── Then the confidence gate. ────────────────────────────────────────────
  IF coalesce(p_extraction_confidence, 0) < 0.75 THEN
    RETURN QUERY SELECT 'review', format('extraction confidence %s is below 0.75', coalesce(p_extraction_confidence,0));
    RETURN;
  END IF;
  IF coalesce(p_deadline_confidence, 0) < 0.80 THEN
    RETURN QUERY SELECT 'review', format('deadline confidence %s is below 0.80', coalesce(p_deadline_confidence,0));
    RETURN;
  END IF;
  IF coalesce(p_country_confidence, 0) < 0.80 THEN
    RETURN QUERY SELECT 'review', format('country confidence %s is below 0.80', coalesce(p_country_confidence,0));
    RETURN;
  END IF;
  IF p_link_ok IS NOT TRUE THEN
    RETURN QUERY SELECT 'review', 'the link has not been confirmed reachable';
    RETURN;
  END IF;
  IF p_organisation_id IS NULL THEN
    RETURN QUERY SELECT 'review', 'the organisation could not be resolved';
    RETURN;
  END IF;
  IF coalesce(v_trust, 0) < 0.60 THEN
    RETURN QUERY SELECT 'review', format('source trust %s is below 0.60', coalesce(v_trust,0));
    RETURN;
  END IF;

  RETURN QUERY SELECT 'publish', 'every gate in OPPORTUNITY_INGESTION.md §4.7 passed';
END
$$;

/**
 * Expand region words to country codes using OUR table, never a model's list.
 *
 * AI_SYSTEM.md §5 post-validation rule 2 is explicit about this, and §4.5 repeats
 * it: "Region words -> country arrays from our own regions table." A model asked to
 * list African countries will give 52, or 55, or include Yemen.
 */
CREATE OR REPLACE FUNCTION expand_regions(p_codes text[])
RETURNS char(2)[]
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(array_agg(DISTINCT c), '{}'::char(2)[])
    FROM (
      SELECT unnest(r.member_countries) AS c
        FROM regions r
       WHERE r.code = ANY (coalesce(p_codes, '{}'::text[]))
    ) x
$$;

/**
 * §5 post-validation rule 3: overlapping country_in and country_not_in is a
 * contradiction, and a contradiction means a person looks at it.
 *
 * Returned rather than raised: the pipeline needs to route the opportunity to
 * review, and an exception would abandon the whole document instead.
 */
CREATE OR REPLACE FUNCTION contradictory_rules(p_opportunity_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM eligibility_rules a
      JOIN eligibility_rules b ON b.opportunity_id = a.opportunity_id
     WHERE a.opportunity_id = p_opportunity_id
       AND a.rule_type = 'country_in'
       AND b.rule_type = 'country_not_in'
       AND jsonb_text_array(a.params->'countries')
           && jsonb_text_array(b.params->'countries')
  )
$$;

-- ── §6 user-reported corrections ────────────────────────────────────────────

/**
 * A reporter's weight. §6 `[PR]`: "A reporter whose reports are consistently upheld
 * gains weight (their single report triggers what normally needs two); one whose
 * reports are consistently dismissed loses it."
 */
ALTER TABLE users ADD COLUMN reporter_weight numeric(3,2) NOT NULL DEFAULT 1.00
  CHECK (reporter_weight BETWEEN 0 AND 3);

COMMENT ON COLUMN users.reporter_weight IS
  'OPPORTUNITY_INGESTION.md §6. Above 2.0, one report counts as the two independent reports an expiry claim normally needs.';

/**
 * §6's remaining automatic effects, folded into 0006's existing trigger function
 * rather than added as a second trigger.
 *
 * 0006 already de-disputes scam and payment reports immediately and files the
 * priority-1 queue item — that part is unchanged and is repeated verbatim below,
 * because REPLACING the function is the only way to extend it and a partial rewrite
 * would silently drop behaviour. What §6 additionally requires, and 0006 did not
 * have, is: the two-independent-reporters rule for expiry (with the reporter-weight
 * shortcut), an immediate link re-check rather than an assumption that the link is
 * dead, and duplicate reports going to the dedupe queue.
 *
 * A second trigger would have been the smaller diff and the worse design: two
 * triggers on one table, each half-knowing the rules, is how the effects of a
 * report become impossible to reason about.
 */
CREATE OR REPLACE FUNCTION reports_auto_dispute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_weight numeric := 1.0;
  v_independent numeric;
BEGIN
  IF NEW.reporter_user_id IS NOT NULL THEN
    SELECT coalesce(reporter_weight, 1.0) INTO v_weight FROM users WHERE id = NEW.reporter_user_id;
  END IF;

  IF NEW.subject_type = 'opportunity'
     AND NEW.reason IN ('possible_scam', 'requires_payment') THEN

    -- MODERATION_AND_TRUST.md §2.2, unchanged from 0006: disputed immediately,
    -- before any human sees it. "False positives cost us one listing. False
    -- negatives cost someone money. Act first, review second."
    UPDATE opportunities
       SET verification = 'disputed', updated_at = now()
     WHERE id = NEW.subject_id
       AND verification <> 'disputed';

    INSERT INTO review_queue (queue, subject_type, subject_id, priority)
    VALUES ('report_scam', 'opportunity', NEW.subject_id, 1);

    NEW.priority := 1;

  ELSIF NEW.reason IN ('harassment', 'impersonation', 'inappropriate') THEN
    INSERT INTO review_queue (queue, subject_type, subject_id, priority)
    VALUES ('report_safety', NEW.subject_type, NEW.subject_id, 1);
    NEW.priority := 1;

  ELSIF NEW.subject_type = 'opportunity' AND NEW.reason = 'expired' THEN
    -- §6: two independent reporters, or one whose reports are consistently upheld
    -- (weight >= 2.0 means "their single report triggers what normally needs two").
    -- Counting the row being inserted requires adding it: BEFORE INSERT means it is
    -- not in the table yet.
    SELECT coalesce(sum(greatest(coalesce(u.reporter_weight, 1.0), 1.0)), 0) + greatest(v_weight, 1.0)
      INTO v_independent
      FROM reports r
      LEFT JOIN users u ON u.id = r.reporter_user_id
     WHERE r.subject_type = 'opportunity' AND r.subject_id = NEW.subject_id
       AND r.reason = 'expired' AND r.state = 'open';

    IF v_independent >= 2 OR v_weight >= 2.0 THEN
      UPDATE opportunities
         SET verification = 'community_flagged',
             -- §6: "Re-verify job triggered immediately", not on the next tick.
             next_verify_at = now()
       WHERE id = NEW.subject_id;
    END IF;

    INSERT INTO review_queue (queue, subject_type, subject_id, priority)
    VALUES ('low_confidence', 'opportunity', NEW.subject_id, 2);
    NEW.priority := 2;

  ELSIF NEW.subject_type = 'opportunity' AND NEW.reason = 'broken_link' THEN
    -- §6: "Immediate link check triggered... Auto-resolves if the check passes."
    -- Deliberately NOT setting link_ok = false: a reporter behind a captive portal
    -- sees a broken link that is not broken, and marking it closed on their word
    -- would remove a live opportunity.
    UPDATE opportunities SET link_checked_at = NULL, next_verify_at = now()
     WHERE id = NEW.subject_id;

    INSERT INTO review_queue (queue, subject_type, subject_id, priority)
    VALUES ('low_confidence', 'opportunity', NEW.subject_id, 2);
    NEW.priority := 2;

  ELSIF NEW.subject_type = 'opportunity'
        AND NEW.reason IN ('wrong_deadline', 'wrong_eligibility') THEN
    INSERT INTO review_queue (queue, subject_type, subject_id, priority)
    VALUES ('low_confidence', 'opportunity', NEW.subject_id, 2);
    NEW.priority := 2;

  ELSIF NEW.subject_type = 'opportunity' AND NEW.reason = 'duplicate' THEN
    INSERT INTO review_queue (queue, subject_type, subject_id, priority)
    VALUES ('duplicate', 'opportunity', NEW.subject_id, 3);
    NEW.priority := 3;
  END IF;

  RETURN NEW;
END
$$;

/**
 * Resolve a report, tell the reporter, and adjust their weight.
 *
 * §6 `[PR]`: "Reporters are told the outcome." Being told is what makes reporting
 * feel like participation rather than shouting into a void, and it is also what
 * makes the weight adjustment fair — nobody loses standing without hearing why.
 */
CREATE OR REPLACE FUNCTION resolve_report(
  p_report_id uuid,
  p_upheld boolean,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r record;
BEGIN
  UPDATE reports
     -- 0006's CHECK allows open/actioned/dismissed/duplicate. "Upheld" is
     -- 'actioned': the report was right and something was done about it.
     SET state = CASE WHEN p_upheld THEN 'actioned' ELSE 'dismissed' END,
         resolved_at = now(),
         outcome_note = left(p_note, 1000)
   WHERE id = p_report_id AND state = 'open'
  RETURNING reporter_user_id, subject_id, reason INTO r;

  IF r IS NULL THEN RETURN; END IF;

  IF r.reporter_user_id IS NOT NULL THEN
    -- Small steps, bounded by the column's CHECK. Weight should move on a pattern
    -- of reports, not on one.
    UPDATE users
       SET reporter_weight = greatest(0, least(3, reporter_weight + CASE WHEN p_upheld THEN 0.25 ELSE -0.25 END))
     WHERE id = r.reporter_user_id;

    PERFORM enqueue_notification(
      r.reporter_user_id, 'moderation_outcome',
      CASE WHEN p_upheld
        THEN 'You reported this and you were right. Thank you — it is fixed.'
        ELSE 'You reported this and we checked. We could not confirm the problem, so it stays as it is.'
      END,
      jsonb_build_object('report_id', p_report_id, 'opportunity_id', r.subject_id,
                         'reason', r.reason, 'upheld', p_upheld, 'note', p_note));
  END IF;
END
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Every function here is batch tier or admin. None is granted to anon or
-- authenticated: the report TRIGGER is what a user's insert reaches, and a trigger
-- runs as its definer without needing a grant on anything.
REVOKE ALL ON FUNCTION record_source_fetch(uuid, fetch_status, int, int, int, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_opportunity_change(uuid, text, jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_staleness_and_expiry() FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_verification_cadence() FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_report(uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION due_for_verification(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_usage_today() FROM PUBLIC;
