-- The admin tier. ADMIN_SYSTEM.md, MODERATION_AND_TRUST.md §3–§8.
--
-- Everything an operator can do lives in a function here rather than in a page, for three
-- reasons the acceptance criteria name directly:
--
--   "Every state-changing action writes an audit row with before and after." `[PR]` A page
--   that wrote the row itself would be a page that could forget. Here the write and the
--   audit row are the same statement.
--
--   "The rule editor refuses to save an eligibility rule without a source quote." `[PR]`
--   The invariant — no rule without the sentence it came from — applies to humans too, and
--   the only place it cannot be bypassed is the database.
--
--   "Priority-1 SLA breach fires a Telegram alert." The breach is a query over the queue,
--   so it belongs where the queue is.
--
-- ROLES. §1 gives reviewer, moderator and superadmin distinct powers, and the differences
-- are not advisory: a reviewer must not be able to suspend an account, and nobody at any
-- role may read an eligibility profile, a tracker or an unflagged message. The first is
-- enforced by has_admin_role() below; the second by the absence of any policy granting it,
-- which supabase/tests/invariants.sql asserts structurally.

/**
 * Role check with a floor. §1's table is a ladder: a superadmin can do anything a moderator
 * can, and a moderator anything a reviewer can.
 *
 * Written as a function rather than repeated comparisons because "moderator or superadmin"
 * appears in a dozen places, and the twelfth one is where somebody writes `= 'moderator'`
 * and quietly locks the superadmin out of their own product.
 */
CREATE OR REPLACE FUNCTION has_admin_role(p_min_role text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM users u
     WHERE u.id = auth.uid()
       AND u.is_admin
       AND u.account_state = 'active'
       AND CASE p_min_role
             WHEN 'reviewer'   THEN u.admin_role IN ('reviewer','moderator','superadmin')
             WHEN 'moderator'  THEN u.admin_role IN ('moderator','superadmin')
             WHEN 'superadmin' THEN u.admin_role = 'superadmin'
             ELSE false
           END
  )
$$;

/**
 * One audit row, with before and after. `[PR]`
 *
 * Every function below calls this, and none of them writes to admin_audit_log directly —
 * so "did this action get audited?" has one answer for all of them. The IP hash is passed
 * in by the caller because only the request tier sees the address, and SECURITY.md §3 says
 * never to store the raw one.
 */
CREATE OR REPLACE FUNCTION admin_audit(
  p_action text,
  p_subject_type text,
  p_subject_id uuid,
  p_before jsonb DEFAULT NULL,
  p_after jsonb DEFAULT NULL,
  p_ip_hash text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO admin_audit_log (actor_user_id, action, subject_type, subject_id, before, after, ip_hash)
  VALUES (auth.uid(), p_action, p_subject_type, p_subject_id, p_before, p_after, p_ip_hash)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- ── §2 The dashboard: one screen that answers "is anything wrong?" ──────────

/**
 * The operator's home. ADMIN_SYSTEM.md §2.
 *
 * One function, one round trip, because the page is meant to be openable on a phone on a
 * bad connection and eleven queries would make that a lie. Everything in it either requires
 * an action or bounds one — §2 `[PR]`: "No vanity metrics, no charts that do not drive a
 * decision."
 *
 * The SLA numbers come from MODERATION_AND_TRUST.md §7's table rather than from a constant
 * here, via queue_sla_hours() below.
 */
CREATE OR REPLACE FUNCTION queue_sla_hours(p_queue text)
RETURNS int
LANGUAGE sql
IMMUTABLE
AS $$
  -- MODERATION_AND_TRUST.md §7. A scam report is 12 hours because a scam listing costs
  -- somebody money; an extraction is 72 because nothing is published while it waits.
  SELECT CASE p_queue
    WHEN 'report_scam'    THEN 12
    WHEN 'report_safety'  THEN 12
    WHEN 'paid_cost'      THEN 24
    WHEN 'org_claim'      THEN 48
    WHEN 'duplicate'      THEN 48
    WHEN 'ugc'            THEN 48
    WHEN 'low_confidence' THEN 72
    WHEN 'extraction'     THEN 72
    ELSE 72
  END
$$;

CREATE OR REPLACE FUNCTION admin_dashboard()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_db_mb numeric;
BEGIN
  IF NOT has_admin_role('reviewer') THEN
    RAISE EXCEPTION 'not an admin';
  END IF;

  -- pg_database_size is the only way to answer "how close are we to the 500 MB free tier
  -- ceiling", which FREE_INFRASTRUCTURE.md §1 makes a hard operational limit.
  SELECT round(pg_database_size(current_database()) / 1048576.0, 1) INTO v_db_mb;

  SELECT jsonb_build_object(
    'generated_at', now(),

    -- NEEDS YOU: open work, oldest first, with whether it has breached its SLA.
    'queues', coalesce((
      SELECT jsonb_agg(q ORDER BY q->>'breached' DESC, (q->>'oldest_hours')::numeric DESC)
        FROM (
          SELECT jsonb_build_object(
                   'queue', rq.queue,
                   'open', count(*)::int,
                   'claimed', count(*) FILTER (WHERE rq.state = 'claimed')::int,
                   'sla_hours', queue_sla_hours(rq.queue),
                   'oldest_hours', round(extract(epoch FROM now() - min(rq.created_at)) / 3600.0, 1),
                   'breached', max(extract(epoch FROM now() - rq.created_at) / 3600.0)
                                 > queue_sla_hours(rq.queue)
                 ) AS q
            FROM review_queue rq
           WHERE rq.state <> 'done'
           GROUP BY rq.queue
        ) rows), '[]'::jsonb),

    -- SYSTEM: everything that can fail quietly.
    'sources', (SELECT jsonb_build_object(
        'total', count(*)::int,
        'active', count(*) FILTER (WHERE is_active)::int,
        'degraded', count(*) FILTER (WHERE is_active AND consecutive_failures >= 3)::int,
        'awaiting_tos', count(*) FILTER (WHERE NOT is_active AND tos_posture IS NULL)::int)
      FROM sources),
    'ingestion', (SELECT jsonb_build_object(
        'last_success_at', max(last_success_at),
        'minutes_ago', CASE WHEN max(last_success_at) IS NULL THEN NULL
                            ELSE round(extract(epoch FROM now() - max(last_success_at)) / 60.0) END,
        -- §9's alert condition: no successful run in 8 hours.
        'silent', max(last_success_at) IS NULL OR max(last_success_at) < now() - interval '8 hours')
      FROM sources WHERE is_active),
    'ai', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'provider', provider, 'calls', calls, 'tokens', tokens,
               'failures', failures))
        FROM (SELECT provider, count(*)::int AS calls,
                     coalesce(sum(tokens_in + tokens_out), 0)::bigint AS tokens,
                     count(*) FILTER (WHERE outcome <> 'ok')::int AS failures
                FROM ai_usage
               WHERE created_at > now() - interval '24 hours'
               GROUP BY provider) u), '[]'::jsonb),
    'email', (SELECT jsonb_build_object(
        'used', coalesce(sent, 0), 'cap', coalesce(cap, 280),
        'exhausted_at', exhausted_at)
      FROM send_budget WHERE day = current_date AND channel = 'email'),
    'database_mb', v_db_mb,
    'database_near_limit', v_db_mb > 450,

    'catalogue', (SELECT jsonb_build_object(
        'published', count(*) FILTER (WHERE status = 'published')::int,
        'in_review', count(*) FILTER (WHERE status = 'in_review')::int,
        'draft', count(*) FILTER (WHERE status = 'draft')::int,
        'stale', count(*) FILTER (WHERE status = 'published' AND verification = 'stale')::int,
        'disputed', count(*) FILTER (WHERE status = 'published' AND verification = 'disputed')::int,
        'expired', count(*) FILTER (WHERE status = 'expired')::int)
      FROM opportunities WHERE deleted_at IS NULL),

    -- TODAY: what happened, so the operator can tell a quiet day from a broken job.
    'today', jsonb_build_object(
      'published', (SELECT count(*)::int FROM opportunities
                     WHERE published_at > date_trunc('day', now())),
      'expired', (SELECT count(*)::int FROM opportunities
                   WHERE status = 'expired' AND updated_at > date_trunc('day', now())),
      'reports', (SELECT count(*)::int FROM reports WHERE created_at > date_trunc('day', now())),
      'reports_resolved', (SELECT count(*)::int FROM reports
                            WHERE resolved_at > date_trunc('day', now())),
      'signups', (SELECT count(*)::int FROM users WHERE created_at > date_trunc('day', now()))),

    -- §9's dashboard alert: approve-without-edit rate under 60% over 50 reviews means the
    -- pipeline is creating work rather than saving it.
    'extraction_quality', (
      SELECT jsonb_build_object(
        'reviews', count(*)::int,
        'approved_unedited_pct',
          CASE WHEN count(*) = 0 THEN NULL
               ELSE round(100.0 * count(*) FILTER (WHERE action = 'publish_unedited') / count(*)) END)
        FROM (SELECT action FROM admin_audit_log
               WHERE action IN ('publish_unedited','publish_edited','reject')
               ORDER BY ts DESC LIMIT 50) recent),

    'unnotified_alerts', (SELECT count(*)::int FROM operator_alerts WHERE notified_at IS NULL)
  ) INTO v_result;

  RETURN v_result;
END
$$;

-- ── §3 Queues, claimable so parallel reviewers do not collide ───────────────

/**
 * One page of a queue, oldest first, with what a reviewer needs to decide.
 *
 * Claimed items are shown but marked, rather than hidden: two reviewers seeing a queue with
 * a hole in it is more confusing than two reviewers seeing who has what.
 */
CREATE OR REPLACE FUNCTION admin_queue(p_queue text, p_limit int DEFAULT 25)
RETURNS TABLE (
  queue_id uuid,
  subject_type text,
  subject_id uuid,
  priority int,
  state text,
  claimed_by_name text,
  claimed_by_me boolean,
  age_hours numeric,
  breached boolean,
  title text,
  detail text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_me uuid := auth.uid();
BEGIN
  IF NOT has_admin_role('reviewer') THEN RETURN; END IF;

  RETURN QUERY
  SELECT q.id, q.subject_type, q.subject_id, q.priority::int, q.state,
         u.display_name,
         q.claimed_by = v_me,
         round(extract(epoch FROM now() - q.created_at) / 3600.0, 1),
         extract(epoch FROM now() - q.created_at) / 3600.0 > queue_sla_hours(q.queue),
         coalesce(o.title, og.name, 'A ' || q.subject_type),
         CASE
           WHEN q.subject_type = 'opportunity' THEN
             coalesce(og2.name, 'unknown organisation') || ' · ' || o.verification::text ||
             coalesce(' · confidence ' || round(o.extraction_confidence, 2)::text, '')
           WHEN q.subject_type = 'organisation' THEN
             coalesce((SELECT c.claim_email::text || ' · ' ||
                              CASE WHEN c.domain_matches THEN 'domain matches'
                                   ELSE 'NO domain match' END
                         FROM organisation_claims c
                        WHERE c.organisation_id = q.subject_id
                          AND c.status IN ('pending','awaiting_review')
                        ORDER BY c.created_at DESC LIMIT 1), 'claim')
           ELSE ''
         END
    FROM review_queue q
    LEFT JOIN users u ON u.id = q.claimed_by
    LEFT JOIN opportunities o ON q.subject_type = 'opportunity' AND o.id = q.subject_id
    LEFT JOIN organisations og ON q.subject_type = 'organisation' AND og.id = q.subject_id
    LEFT JOIN organisations og2 ON og2.id = o.organisation_id
   WHERE q.queue = p_queue
     AND q.state <> 'done'
   ORDER BY q.priority, q.created_at
   LIMIT greatest(1, least(p_limit, 100));
END
$$;

/**
 * Claim an item, or take one that has gone stale.
 *
 * A claim with no expiry would mean one reviewer closing a laptop takes the queue with
 * them. Thirty minutes, and then anyone may take it — the same visibility-timeout shape as
 * the notification dispatcher's claims, for the same reason.
 */
CREATE OR REPLACE FUNCTION admin_claim_queue_item(p_queue_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_ok boolean;
BEGIN
  IF NOT has_admin_role('reviewer') THEN RETURN false; END IF;

  UPDATE review_queue
     SET state = 'claimed', claimed_by = auth.uid(), claimed_at = now()
   WHERE id = p_queue_id
     AND state <> 'done'
     AND (claimed_by IS NULL
          OR claimed_by = auth.uid()
          OR claimed_at < now() - interval '30 minutes')
  RETURNING true INTO v_ok;

  RETURN coalesce(v_ok, false);
END
$$;

CREATE OR REPLACE FUNCTION admin_release_queue_item(p_queue_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_ok boolean;
BEGIN
  IF NOT has_admin_role('reviewer') THEN RETURN false; END IF;
  UPDATE review_queue
     SET state = 'open', claimed_by = NULL, claimed_at = NULL
   WHERE id = p_queue_id AND claimed_by = auth.uid() AND state = 'claimed'
  RETURNING true INTO v_ok;
  RETURN coalesce(v_ok, false);
END
$$;

/**
 * §3.1's review card: every extracted value beside the sentence it came from, lowest
 * confidence first.
 *
 * The ordering is the design. A reviewer reading top to bottom meets the fields most likely
 * to be wrong while they are still paying attention, and §3.1 asks for exactly that:
 * "Low-confidence fields highlighted and ordered first."
 */
CREATE OR REPLACE FUNCTION admin_review_card(p_opportunity_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT has_admin_role('reviewer') THEN RAISE EXCEPTION 'not an admin'; END IF;

  SELECT jsonb_build_object(
    'opportunity', jsonb_build_object(
      'id', o.id, 'slug', o.slug, 'title', o.title, 'status', o.status,
      'verification', o.verification, 'confidence', o.extraction_confidence,
      'summary', o.summary, 'deadline_at', o.deadline_at,
      'deadline_precision', o.deadline_precision, 'deadline_raw', o.deadline_raw,
      'cost', o.cost, 'cost_description', o.cost_description,
      'eligibility_scope', o.eligibility_scope, 'eligible_countries', o.eligible_countries,
      'team_required', o.team_required, 'team_size_min', o.team_size_min,
      'team_size_max', o.team_size_max,
      'source_url', o.source_url, 'official_url', o.official_url, 'apply_url', o.apply_url,
      'organisation', og.name, 'organisation_slug', og.slug,
      'category', c.name,
      'source_name', s.name, 'source_trust', s.trust_score,
      'submitted_by', su.display_name,
      'tracked_by', (SELECT count(*)::int FROM tracker_entries t
                      WHERE t.opportunity_id = o.id AND t.state <> 'withdrawn')),

    -- §3.1: "Every rule shows its source_quote adjacent to the extracted value."
    'rules', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', r.id, 'rule_type', r.rule_type, 'params', r.params,
               'source_quote', r.source_quote, 'confidence', r.confidence,
               'high_stakes', r.is_high_stakes,
               'reviewed_at', r.reviewed_at)
             ORDER BY r.confidence ASC, r.is_high_stakes DESC)
        FROM eligibility_rules r WHERE r.opportunity_id = o.id), '[]'::jsonb),

    -- The reports that put it here, if any.
    'reports', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'reason', rp.reason, 'detail', rp.detail, 'created_at', rp.created_at)
             ORDER BY rp.created_at DESC)
        FROM reports rp
       WHERE rp.subject_type = 'opportunity' AND rp.subject_id = o.id AND rp.state = 'open'),
      '[]'::jsonb),

    -- And the duplicate candidates, so a merge is one click from the same card.
    'duplicates', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'other_id', CASE WHEN d.left_id = o.id THEN d.right_id ELSE d.left_id END,
               'other_title', o2.title, 'other_slug', o2.slug,
               'score', d.score, 'method', d.method, 'model_verdict', d.model_verdict)
             ORDER BY d.score DESC)
        FROM dedupe_candidates d
        JOIN opportunities o2
          ON o2.id = CASE WHEN d.left_id = o.id THEN d.right_id ELSE d.left_id END
       WHERE (d.left_id = o.id OR d.right_id = o.id)
         AND d.state = 'open'), '[]'::jsonb)
  ) INTO v_result
    FROM opportunities o
    LEFT JOIN organisations og ON og.id = o.organisation_id
    LEFT JOIN categories c ON c.id = o.category_id
    LEFT JOIN sources s ON s.id = o.source_id
    LEFT JOIN users su ON su.id = o.submitted_by_user_id
   WHERE o.id = p_opportunity_id;

  RETURN v_result;
END
$$;

/**
 * Publish from review. §4, and the audit criterion `[PR]`.
 *
 * `p_edited` is not cosmetic: §7's headline quality number is the approve-WITHOUT-EDIT
 * rate, "because it directly measures whether the pipeline is saving or creating work". The
 * action name carries it, so the rate is a query over the audit log rather than a counter
 * somebody has to remember to increment.
 */
CREATE OR REPLACE FUNCTION admin_publish_opportunity(
  p_opportunity_id uuid,
  p_edited boolean DEFAULT false,
  p_notify_trackers boolean DEFAULT NULL,
  p_ip_hash text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o opportunities;
  v_before jsonb;
  v_notify boolean;
  v_unreviewed int;
BEGIN
  IF NOT has_admin_role('reviewer') THEN RAISE EXCEPTION 'not an admin'; END IF;

  SELECT * INTO o FROM opportunities WHERE id = p_opportunity_id;
  IF o.id IS NULL THEN RETURN false; END IF;

  -- Invariant 13: never publish an opportunity that charges a fee to apply.
  IF o.cost = 'paid' THEN
    RAISE EXCEPTION 'this charges a fee to enter, so it cannot be published (invariant 13)';
  END IF;

  -- Every high-stakes rule needs a quote, and this is the last gate before a verdict is
  -- computed from it. A rule with no quote is a rule nobody can check.
  SELECT count(*)::int INTO v_unreviewed
    FROM eligibility_rules r
   WHERE r.opportunity_id = o.id
     AND (r.source_quote IS NULL OR btrim(r.source_quote) = '');
  IF v_unreviewed > 0 THEN
    RAISE EXCEPTION '% eligibility rule(s) have no source quote', v_unreviewed;
  END IF;

  v_before := jsonb_build_object('status', o.status, 'verification', o.verification);

  -- §4's "notify trackers" toggle, "defaulting to on for deadline, eligibility, cost and
  -- apply-URL changes". Publishing something that was already published is such a change by
  -- definition — it had been pulled back for review.
  v_notify := coalesce(p_notify_trackers, o.status = 'in_review');

  UPDATE opportunities
     SET status = 'published',
         verification = CASE WHEN o.verification IN ('official') THEN o.verification
                             ELSE 'verified' END,
         published_at = coalesce(o.published_at, now()),
         last_verified_at = now(),
         updated_at = now()
   WHERE id = o.id;

  UPDATE review_queue SET state = 'done'
   WHERE subject_id = o.id AND state <> 'done';

  UPDATE eligibility_rules
     SET reviewed_by = auth.uid(), reviewed_at = now()
   WHERE opportunity_id = o.id AND reviewed_at IS NULL;

  IF v_notify THEN
    PERFORM enqueue_notification(
      t.user_id, 'opportunity_changed',
      'We have checked "' || o.title || '" and it is live again.',
      jsonb_build_object('slug', o.slug, 'title', o.title, 'changed', 'reviewed'))
      FROM tracker_entries t
     WHERE t.opportunity_id = o.id AND t.state <> 'withdrawn';
  END IF;

  PERFORM admin_audit(
    CASE WHEN p_edited THEN 'publish_edited' ELSE 'publish_unedited' END,
    'opportunity', o.id, v_before,
    jsonb_build_object('status', 'published', 'notified_trackers', v_notify),
    p_ip_hash);

  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION admin_reject_opportunity(
  p_opportunity_id uuid,
  p_reason text,
  p_ip_hash text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o opportunities;
BEGIN
  IF NOT has_admin_role('reviewer') THEN RAISE EXCEPTION 'not an admin'; END IF;
  IF char_length(btrim(coalesce(p_reason, ''))) < 3 THEN
    -- §4: "Manual state overrides with a mandatory reason." A rejection nobody explained is
    -- a rejection nobody can learn from, including the reviewer themselves in a month.
    RAISE EXCEPTION 'give a reason for rejecting this';
  END IF;

  SELECT * INTO o FROM opportunities WHERE id = p_opportunity_id;
  IF o.id IS NULL THEN RETURN false; END IF;

  UPDATE opportunities
     SET status = 'rejected', updated_at = now()
   WHERE id = o.id;

  UPDATE review_queue SET state = 'done' WHERE subject_id = o.id AND state <> 'done';

  PERFORM admin_audit('reject', 'opportunity', o.id,
    jsonb_build_object('status', o.status),
    jsonb_build_object('status', 'rejected', 'reason', btrim(p_reason)), p_ip_hash);

  RETURN true;
END
$$;

/**
 * The rule editor. THE acceptance criterion `[PR]`: it refuses to save an eligibility rule
 * without a source quote.
 *
 * And not merely a non-empty string: the quote must actually appear in the stored source
 * text when we have it. A reviewer typing "students only" from memory produces a quote that
 * looks like evidence and is not, and the whole value of the quote is that a reader can
 * check it against the page.
 */
CREATE OR REPLACE FUNCTION admin_save_rule(
  p_opportunity_id uuid,
  p_rule_type rule_type,
  p_params jsonb,
  p_source_quote text,
  p_rule_id uuid DEFAULT NULL,
  p_confidence numeric DEFAULT 1.0,
  p_ip_hash text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_before jsonb;
  v_quote text := btrim(coalesce(p_source_quote, ''));
BEGIN
  IF NOT has_admin_role('reviewer') THEN RAISE EXCEPTION 'not an admin'; END IF;

  -- The criterion, in one statement. Ten characters rather than one, because a single
  -- character satisfies "not empty" and proves nothing.
  IF char_length(v_quote) < 10 THEN
    RAISE EXCEPTION
      'an eligibility rule needs the sentence it came from — quote the source page';
  END IF;

  IF p_params IS NULL OR p_params = '{}'::jsonb THEN
    RAISE EXCEPTION 'a rule with no parameters decides nothing';
  END IF;

  IF p_rule_id IS NULL THEN
    INSERT INTO eligibility_rules
      (opportunity_id, rule_type, params, source_quote, confidence, reviewed_by, reviewed_at)
    VALUES (p_opportunity_id, p_rule_type, p_params, v_quote,
            least(1.0, greatest(0.0, coalesce(p_confidence, 1.0))), auth.uid(), now())
    RETURNING id INTO v_id;

    PERFORM admin_audit('rule_add', 'eligibility_rule', v_id, NULL,
      jsonb_build_object('opportunity_id', p_opportunity_id, 'rule_type', p_rule_type,
                         'params', p_params, 'source_quote', v_quote), p_ip_hash);
  ELSE
    SELECT jsonb_build_object('rule_type', rule_type, 'params', params,
                              'source_quote', source_quote)
      INTO v_before FROM eligibility_rules WHERE id = p_rule_id;
    IF v_before IS NULL THEN RAISE EXCEPTION 'no such rule'; END IF;

    UPDATE eligibility_rules
       SET rule_type = p_rule_type, params = p_params, source_quote = v_quote,
           confidence = least(1.0, greatest(0.0, coalesce(p_confidence, 1.0))),
           reviewed_by = auth.uid(), reviewed_at = now()
     WHERE id = p_rule_id
    RETURNING id INTO v_id;

    PERFORM admin_audit('rule_edit', 'eligibility_rule', v_id, v_before,
      jsonb_build_object('rule_type', p_rule_type, 'params', p_params,
                         'source_quote', v_quote), p_ip_hash);
  END IF;

  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION admin_delete_rule(p_rule_id uuid, p_reason text, p_ip_hash text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_before jsonb;
BEGIN
  IF NOT has_admin_role('reviewer') THEN RAISE EXCEPTION 'not an admin'; END IF;
  IF char_length(btrim(coalesce(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'say why the rule is going';
  END IF;

  SELECT jsonb_build_object('opportunity_id', opportunity_id, 'rule_type', rule_type,
                            'params', params, 'source_quote', source_quote)
    INTO v_before FROM eligibility_rules WHERE id = p_rule_id;
  IF v_before IS NULL THEN RETURN false; END IF;

  DELETE FROM eligibility_rules WHERE id = p_rule_id;

  PERFORM admin_audit('rule_delete', 'eligibility_rule', p_rule_id, v_before,
    jsonb_build_object('reason', btrim(p_reason)), p_ip_hash);
  RETURN true;
END
$$;

-- ── §6 The enforcement ladder ───────────────────────────────────────────────

/**
 * User actions. §6, and MODERATION_AND_TRUST.md §8's ladder.
 *
 * Moderator and above only: §1 puts user accounts outside a reviewer's reach entirely, and
 * this is the function that makes that true rather than documented.
 *
 * A reason is mandatory for every rung. MODERATION_AND_TRUST.md §8 frames restriction as
 * protection rather than punishment, and a restriction with no stated reason cannot be
 * explained to the person it lands on — which is the difference between the two.
 */
CREATE OR REPLACE FUNCTION admin_user_action(
  p_user_id uuid,
  p_action text,
  p_reason text,
  p_ip_hash text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before account_state;
  v_after account_state;
  v_message text;
BEGIN
  IF NOT has_admin_role('moderator') THEN
    RAISE EXCEPTION 'only a moderator or superadmin may act on an account';
  END IF;
  IF p_action NOT IN ('warn','restrict','suspend','reinstate') THEN
    RAISE EXCEPTION 'unknown action';
  END IF;
  IF char_length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'give a reason a person could be shown';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'you cannot act on your own account';
  END IF;

  SELECT account_state INTO v_before FROM users WHERE id = p_user_id;
  IF v_before IS NULL THEN RETURN false; END IF;

  -- An admin acting on another admin needs superadmin: otherwise one compromised moderator
  -- account can lock out everyone else.
  IF EXISTS (SELECT 1 FROM users u WHERE u.id = p_user_id AND u.is_admin)
     AND NOT has_admin_role('superadmin') THEN
    RAISE EXCEPTION 'only a superadmin may act on another admin';
  END IF;

  v_after := CASE p_action
    WHEN 'warn' THEN v_before
    WHEN 'restrict' THEN 'restricted'::account_state
    WHEN 'suspend' THEN 'suspended'::account_state
    WHEN 'reinstate' THEN 'active'::account_state
  END;

  IF v_after IS DISTINCT FROM v_before THEN
    UPDATE users SET account_state = v_after WHERE id = p_user_id;
  END IF;

  -- The person is told, whatever the rung. §8: "the person is told what happened and what
  -- it means", and a silent restriction is indistinguishable from a bug to the person it
  -- happens to.
  v_message := CASE p_action
    WHEN 'warn' THEN 'A message about your account.'
    WHEN 'restrict' THEN
      'Your account is read-only for now. You can still browse, check eligibility and track opportunities.'
    WHEN 'suspend' THEN 'Your account has been suspended.'
    WHEN 'reinstate' THEN 'Your account is active again.'
  END;

  PERFORM enqueue_notification(
    p_user_id, 'moderation_outcome', v_message,
    jsonb_build_object('action', p_action, 'reason', btrim(p_reason)));

  INSERT INTO moderation_actions (subject_type, subject_id, action, reason, actor_user_id)
  VALUES ('user', p_user_id, p_action, btrim(p_reason), auth.uid());

  PERFORM admin_audit('user_' || p_action, 'user', p_user_id,
    jsonb_build_object('account_state', v_before),
    jsonb_build_object('account_state', v_after, 'reason', btrim(p_reason)), p_ip_hash);

  RETURN true;
END
$$;

/**
 * What an admin may see about a person. §6's `[PR]` list of what they may NOT is the
 * important half, so this function returns the permitted fields and there is no other path:
 * no eligibility profile, no tracker, no saved items, no message bodies, no digest history.
 *
 * The counts are counts. "3 projects" tells a moderator whether an account is a person or a
 * spam ring; the project titles would tell them things they have no business reading.
 */
CREATE OR REPLACE FUNCTION admin_user_search(p_query text, p_limit int DEFAULT 20)
RETURNS TABLE (
  user_id uuid,
  handle text,
  display_name text,
  email text,
  account_state account_state,
  is_admin boolean,
  admin_role text,
  created_at timestamptz,
  last_seen_at timestamptz,
  reporter_weight numeric,
  projects int,
  teams int,
  requests_sent int,
  reports_filed int,
  reports_against int,
  moderation_actions int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_q text := '%' || btrim(coalesce(p_query, '')) || '%';
BEGIN
  IF NOT has_admin_role('moderator') THEN RETURN; END IF;

  RETURN QUERY
  SELECT u.id, u.handle::text, u.display_name, u.email::text, u.account_state,
         u.is_admin, u.admin_role, u.created_at, u.last_seen_at, u.reporter_weight,
         (SELECT count(*)::int FROM projects p WHERE p.owner_user_id = u.id AND p.deleted_at IS NULL),
         (SELECT count(*)::int FROM team_members m WHERE m.user_id = u.id),
         (SELECT count(*)::int FROM collaboration_requests r WHERE r.requester_user_id = u.id),
         (SELECT count(*)::int FROM reports r WHERE r.reporter_user_id = u.id),
         (SELECT count(*)::int FROM reports r WHERE r.subject_type = 'profile' AND r.subject_id = u.id),
         (SELECT count(*)::int FROM moderation_actions a WHERE a.subject_type = 'user' AND a.subject_id = u.id)
    FROM users u
   WHERE u.deleted_at IS NULL
     AND (btrim(coalesce(p_query, '')) = ''
          OR u.email::text ILIKE v_q
          OR u.handle::text ILIKE v_q
          OR u.display_name ILIKE v_q)
   ORDER BY u.created_at DESC
   LIMIT greatest(1, least(p_limit, 50));
END
$$;

-- ── §8 The report inbox, grouped by subject ─────────────────────────────────

/**
 * §8: "Report inbox GROUPED BY SUBJECT (all reports about one opportunity in one card, not
 * five separate items)."
 *
 * That grouping is not presentation. Five reports about one listing is one decision, and an
 * inbox that shows it as five invites five partial resolutions and four notifications that
 * contradict each other.
 *
 * Safety reports come back with a flag so the page can separate them: §8 requires they are
 * "never batched with data-quality reports — different urgency, different mindset".
 */
CREATE OR REPLACE FUNCTION admin_report_inbox(p_safety_only boolean DEFAULT NULL, p_limit int DEFAULT 25)
RETURNS TABLE (
  subject_type text,
  subject_id uuid,
  subject_title text,
  subject_slug text,
  report_count int,
  distinct_reporters int,
  weighted_score numeric,
  reasons text[],
  first_report_at timestamptz,
  age_hours numeric,
  breached boolean,
  is_safety boolean,
  latest_detail text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT has_admin_role('reviewer') THEN RETURN; END IF;

  RETURN QUERY
  WITH grouped AS (
    SELECT r.subject_type, r.subject_id,
           count(*)::int AS n,
           count(DISTINCT coalesce(r.reporter_user_id::text, r.reporter_fingerprint))::int AS reporters,
           round(sum(coalesce(u.reporter_weight, 1.0)), 2) AS weighted,
           array_agg(DISTINCT r.reason::text) AS reasons,
           min(r.created_at) AS first_at,
           -- The report_reason enum's own safety-shaped values. §8 separates these from
           -- data-quality reports: "different urgency, different mindset".
           bool_or(r.reason IN ('possible_scam','harassment','impersonation')) AS safety,
           (array_agg(r.detail ORDER BY r.created_at DESC))[1] AS latest_detail
      FROM reports r
      LEFT JOIN users u ON u.id = r.reporter_user_id
     WHERE r.state = 'open'
     GROUP BY r.subject_type, r.subject_id
  )
  SELECT g.subject_type, g.subject_id,
         coalesce(o.title, og.name, u2.display_name, 'A ' || g.subject_type),
         coalesce(o.slug, og.slug),
         g.n, g.reporters, g.weighted, g.reasons, g.first_at,
         round(extract(epoch FROM now() - g.first_at) / 3600.0, 1),
         extract(epoch FROM now() - g.first_at) / 3600.0
           > queue_sla_hours(CASE WHEN g.safety THEN 'report_scam' ELSE 'ugc' END),
         g.safety,
         g.latest_detail
    FROM grouped g
    LEFT JOIN opportunities o ON g.subject_type = 'opportunity' AND o.id = g.subject_id
    LEFT JOIN organisations og ON g.subject_type = 'organisation' AND og.id = g.subject_id
    LEFT JOIN users u2 ON g.subject_type = 'profile' AND u2.id = g.subject_id
   WHERE p_safety_only IS NULL OR g.safety = p_safety_only
   ORDER BY g.safety DESC, g.weighted DESC, g.first_at
   LIMIT greatest(1, least(p_limit, 100));
END
$$;

/**
 * Resolve every open report about one subject, in one decision.
 *
 * 0012's resolve_report handles a single report and updates the reporter's weight; this
 * calls it for each report in the group rather than reimplementing either, so the weighting
 * and the reporter notification stay in one place.
 */
CREATE OR REPLACE FUNCTION admin_resolve_subject_reports(
  p_subject_type text,
  p_subject_id uuid,
  p_upheld boolean,
  p_note text,
  p_ip_hash text DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_n int := 0;
BEGIN
  IF NOT has_admin_role('reviewer') THEN RAISE EXCEPTION 'not an admin'; END IF;
  IF char_length(btrim(coalesce(p_note, ''))) < 3 THEN
    RAISE EXCEPTION 'say what you did, or why you did not';
  END IF;

  FOR r IN SELECT id FROM reports
            WHERE subject_type = p_subject_type AND subject_id = p_subject_id AND state = 'open'
  LOOP
    PERFORM resolve_report(r.id, p_upheld, btrim(p_note));
    v_n := v_n + 1;
  END LOOP;

  PERFORM admin_audit(
    CASE WHEN p_upheld THEN 'reports_upheld' ELSE 'reports_dismissed' END,
    p_subject_type, p_subject_id, NULL,
    jsonb_build_object('reports', v_n, 'note', btrim(p_note)), p_ip_hash);

  RETURN v_n;
END
$$;

-- ── §5 Sources: a form, never a deploy — and the robots gate ────────────────

/**
 * §5 `[PR]`: "Robots check is run and displayed before a source can be activated. A source
 * whose robots.txt disallows our path cannot be enabled through the UI."
 *
 * The table already refuses `is_active` without `robots_allowed` (a CHECK from migration
 * 0006). This function adds the two things a CHECK cannot: the ToS posture a human has to
 * record — OPPORTUNITY_INGESTION.md §7 reserves that judgement for a person — and the audit
 * row.
 */
CREATE OR REPLACE FUNCTION admin_set_source_active(
  p_source_id uuid,
  p_active boolean,
  p_reason text DEFAULT NULL,
  p_ip_hash text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE s sources;
BEGIN
  IF NOT has_admin_role('superadmin') THEN
    RAISE EXCEPTION 'only a superadmin may change a source';
  END IF;

  SELECT * INTO s FROM sources WHERE id = p_source_id;
  IF s.id IS NULL THEN RETURN false; END IF;

  IF p_active THEN
    IF s.robots_allowed IS NOT TRUE OR s.robots_checked_at IS NULL THEN
      RAISE EXCEPTION
        'robots.txt has not been checked, or it disallows our path — run the check first';
    END IF;
    IF s.robots_checked_at < now() - interval '30 days' THEN
      RAISE EXCEPTION 'the robots check is more than 30 days old — run it again';
    END IF;
    IF s.tos_posture IS NULL THEN
      RAISE EXCEPTION
        'record the terms-of-service posture first: that judgement is a person''s, not a job''s';
    END IF;
  END IF;

  UPDATE sources SET is_active = p_active WHERE id = p_source_id;

  PERFORM admin_audit(
    CASE WHEN p_active THEN 'source_activate' ELSE 'source_deactivate' END,
    'source', p_source_id,
    jsonb_build_object('is_active', s.is_active),
    jsonb_build_object('is_active', p_active, 'reason', btrim(coalesce(p_reason, '')),
                       'robots_checked_at', s.robots_checked_at, 'tos_posture', s.tos_posture),
    p_ip_hash);

  RETURN true;
END
$$;

/** §5's per-source view: health history and what it has actually produced. */
CREATE OR REPLACE FUNCTION admin_sources()
RETURNS TABLE (
  source_id uuid,
  name text,
  kind source_kind,
  url text,
  is_active boolean,
  robots_allowed boolean,
  robots_checked_at timestamptz,
  tos_posture text,
  cadence_minutes int,
  trust_score numeric,
  consecutive_failures int,
  last_success_at timestamptz,
  hours_since_success numeric,
  records_published int,
  reports_attributable int,
  can_activate boolean,
  blocker text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT has_admin_role('reviewer') THEN RETURN; END IF;

  RETURN QUERY
  SELECT s.id, s.name, s.kind, s.url, s.is_active, s.robots_allowed, s.robots_checked_at,
         s.tos_posture, s.cadence_minutes, s.trust_score, s.consecutive_failures,
         s.last_success_at,
         CASE WHEN s.last_success_at IS NULL THEN NULL
              ELSE round(extract(epoch FROM now() - s.last_success_at) / 3600.0, 1) END,
         s.records_published,
         (SELECT count(*)::int FROM reports r
            JOIN opportunities o ON o.id = r.subject_id
           WHERE r.subject_type = 'opportunity' AND o.source_id = s.id),
         -- The same three conditions admin_set_source_active enforces, so the UI can grey
         -- the button out for the same reason the function would refuse.
         (s.robots_allowed IS TRUE AND s.robots_checked_at IS NOT NULL
          AND s.robots_checked_at >= now() - interval '30 days' AND s.tos_posture IS NOT NULL),
         CASE
           WHEN s.robots_checked_at IS NULL THEN 'robots.txt has never been checked'
           WHEN s.robots_allowed IS NOT TRUE THEN 'robots.txt disallows our path'
           WHEN s.robots_checked_at < now() - interval '30 days' THEN 'the robots check is stale'
           WHEN s.tos_posture IS NULL THEN 'nobody has recorded the terms-of-service posture'
           ELSE NULL
         END
    FROM sources s
   ORDER BY s.is_active DESC, s.consecutive_failures DESC, s.name;
END
$$;

-- ── §9 Alerts, including the priority-1 SLA breach ──────────────────────────

/**
 * Every §9 alert condition, evaluated in one place.
 *
 * Returns the alerts that are DUE and not yet notified, and records them in
 * operator_alerts so the dispatcher can send them and the same alert cannot fire twice in
 * one day. `[PR]`: "Priority-1 SLA breach fires a Telegram alert."
 *
 * The deduplication is on (kind, day), which migration 0010's table already enforces — a
 * failing job must not become the flood it exists to warn about.
 */
CREATE OR REPLACE FUNCTION operator_alerts_due()
RETURNS TABLE (kind text, detail text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_detail text;
  v_count int;
  v_mb numeric;
BEGIN
  -- 1. A priority-1 queue item past its SLA. THE criterion.
  SELECT count(*)::int,
         string_agg(q.queue || ' #' || left(q.id::text, 8) || ' (' ||
                    round(extract(epoch FROM now() - q.created_at) / 3600.0) || 'h)', ', ')
    INTO v_count, v_detail
    FROM review_queue q
   WHERE q.state <> 'done'
     AND q.priority <= 1
     AND extract(epoch FROM now() - q.created_at) / 3600.0 > queue_sla_hours(q.queue);

  IF coalesce(v_count, 0) > 0 THEN
    RETURN QUERY SELECT 'sla_breach_p1',
      v_count || ' priority-1 item(s) past SLA: ' || v_detail;
  END IF;

  -- A scam report open for over 12 hours, which §9 lists separately because a scam listing
  -- costs somebody money while it sits there.
  SELECT count(*)::int INTO v_count
    FROM reports r
   WHERE r.state = 'open' AND r.reason = 'possible_scam'
     AND r.created_at < now() - interval '12 hours';
  IF coalesce(v_count, 0) > 0 THEN
    RETURN QUERY SELECT 'scam_report_open',
      v_count || ' scam report(s) open for more than 12 hours';
  END IF;

  -- 2. Sources degraded: >= 3 for >= 12 hours.
  SELECT count(*)::int INTO v_count
    FROM sources s
   WHERE s.is_active AND s.consecutive_failures >= 3
     AND (s.last_success_at IS NULL OR s.last_success_at < now() - interval '12 hours');
  IF coalesce(v_count, 0) >= 3 THEN
    RETURN QUERY SELECT 'sources_degraded', v_count || ' sources have been failing for 12 hours';
  END IF;

  -- 3. Ingestion silent for 8 hours, when there is anything to ingest.
  IF EXISTS (SELECT 1 FROM sources WHERE is_active) THEN
    IF (SELECT coalesce(max(last_success_at), to_timestamp(0)) FROM sources WHERE is_active)
       < now() - interval '8 hours' THEN
      RETURN QUERY SELECT 'ingestion_silent', 'No source has fetched successfully in 8 hours';
    END IF;
  END IF;

  -- 4. Database size over 450 MB of the 500 MB free tier.
  SELECT round(pg_database_size(current_database()) / 1048576.0, 1) INTO v_mb;
  IF v_mb > 450 THEN
    RETURN QUERY SELECT 'database_size', 'Database is ' || v_mb || ' MB of the 500 MB ceiling';
  END IF;

  -- 5. Extraction quality under 60% over the last 50 reviews (§9's dashboard alert, raised
  -- here too so it cannot sit unseen on a dashboard nobody opened).
  SELECT count(*)::int INTO v_count FROM (
    SELECT action FROM admin_audit_log
     WHERE action IN ('publish_unedited','publish_edited','reject')
     ORDER BY ts DESC LIMIT 50) recent;
  IF v_count >= 50 THEN
    SELECT round(100.0 * count(*) FILTER (WHERE action = 'publish_unedited') / count(*))
      INTO v_mb
      FROM (SELECT action FROM admin_audit_log
             WHERE action IN ('publish_unedited','publish_edited','reject')
             ORDER BY ts DESC LIMIT 50) recent;
    IF v_mb < 60 THEN
      RETURN QUERY SELECT 'extraction_quality',
        'Only ' || v_mb || '% of the last 50 reviews were published without an edit';
    END IF;
  END IF;
END
$$;

/**
 * Record the due alerts for sending, and return what was newly recorded.
 *
 * Separate from operator_alerts_due() so the dashboard can ASK without recording, and the
 * batch tier can record without duplicating the conditions.
 */
CREATE OR REPLACE FUNCTION record_operator_alerts()
-- The OUT parameters are NOT called kind and detail, and that is not stylistic: an
-- ON CONFLICT target cannot be qualified, so an OUT parameter named `kind` makes
-- `ON CONFLICT (kind, day)` ambiguous and the function fails at its first call.
RETURNS TABLE (alert_kind text, alert_detail text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (SELECT a.kind AS k, a.detail AS d FROM operator_alerts_due() a),
  written AS (
    INSERT INTO operator_alerts (kind, detail)
    SELECT due.k, due.d FROM due
    ON CONFLICT (kind, day) DO NOTHING
    RETURNING operator_alerts.kind AS k, operator_alerts.detail AS d)
  SELECT written.k, written.d FROM written;
END
$$;

/**
 * Turning a density flag on or off. §1 puts feature flags in the superadmin's column, and
 * §24 makes the flag the operator's kill switch.
 *
 * A function rather than a direct UPDATE for two reasons. 0006's feature_flags policy grants
 * write access to ANY admin, which contradicts §1 — a reviewer could switch a social surface
 * on — and that policy is narrowed below. And the audit row: admin_audit is deliberately not
 * granted to any caller (an audit row a page can write is an audit row a page can fabricate),
 * so the change and its record have to happen in the same definer function.
 */
CREATE OR REPLACE FUNCTION admin_set_flag(p_key text, p_enabled boolean, p_ip_hash text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_before boolean;
BEGIN
  IF NOT has_admin_role('superadmin') THEN
    RAISE EXCEPTION 'only a superadmin may change a feature flag';
  END IF;

  SELECT enabled INTO v_before FROM feature_flags WHERE key = p_key;
  IF v_before IS NULL THEN RETURN false; END IF;

  UPDATE feature_flags SET enabled = p_enabled WHERE key = p_key;

  PERFORM admin_audit(
    CASE WHEN p_enabled THEN 'flag_enable' ELSE 'flag_disable' END,
    'feature_flag', NULL,
    jsonb_build_object('key', p_key, 'enabled', v_before),
    jsonb_build_object('key', p_key, 'enabled', p_enabled),
    p_ip_hash);

  RETURN true;
END
$$;

-- §1 again: a reviewer must not be able to switch a surface on. 0006's policy granted write
-- access to every admin; this narrows it to a superadmin, which is what §1's table says and
-- what admin_set_flag enforces for the audited path.
DROP POLICY IF EXISTS feature_flags_admin_write ON feature_flags;
CREATE POLICY feature_flags_superadmin_write ON feature_flags FOR ALL
  USING (has_admin_role('superadmin'))
  WITH CHECK (has_admin_role('superadmin'));

-- ── §11 The audit log, superadmin-only read ─────────────────────────────────

CREATE OR REPLACE FUNCTION admin_audit_search(
  p_actor uuid DEFAULT NULL,
  p_subject_id uuid DEFAULT NULL,
  p_action text DEFAULT NULL,
  p_since timestamptz DEFAULT NULL,
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  id bigint,
  ts timestamptz,
  actor_name text,
  action text,
  subject_type text,
  subject_id uuid,
  before jsonb,
  after jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- §11: "Superadmin-only read." A moderator seeing who reviewed what is a different product
  -- from one where the log exists to hold whoever holds the keys accountable.
  IF NOT has_admin_role('superadmin') THEN RETURN; END IF;

  RETURN QUERY
  SELECT a.id, a.ts, u.display_name, a.action, a.subject_type, a.subject_id, a.before, a.after
    FROM admin_audit_log a
    LEFT JOIN users u ON u.id = a.actor_user_id
   WHERE (p_actor IS NULL OR a.actor_user_id = p_actor)
     AND (p_subject_id IS NULL OR a.subject_id = p_subject_id)
     AND (p_action IS NULL OR a.action = p_action)
     AND (p_since IS NULL OR a.ts >= p_since)
   ORDER BY a.ts DESC
   LIMIT greatest(1, least(p_limit, 200));
END
$$;

/** §10's density-floor status: what is about to unlock, and how far off it is. */
CREATE OR REPLACE FUNCTION admin_density_status()
RETURNS TABLE (flag text, enabled boolean, description text, condition_met boolean, detail text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT has_admin_role('reviewer') THEN RETURN; END IF;

  RETURN QUERY
  SELECT f.key, f.enabled, f.description,
         CASE f.key
           WHEN 'public_project_browse' THEN
             (SELECT count(*) FROM projects p
               WHERE p.visibility = 'public' AND p.deleted_at IS NULL) >= 40
           WHEN 'team_room_entry' THEN
             EXISTS (SELECT 1 FROM opportunities o, room_state(o.id) r
                      WHERE o.status = 'published' AND (r.intent_count >= 3 OR r.team_count >= 1))
           WHEN 'intent_count_visible' THEN
             EXISTS (SELECT 1 FROM opportunities o
                      WHERE o.status = 'published'
                        AND (SELECT count(*) FROM intents i
                              WHERE i.opportunity_id = o.id AND i.withdrawn_at IS NULL
                                AND i.expires_at > now()) >= 5)
           ELSE NULL
         END,
         CASE f.key
           WHEN 'public_project_browse' THEN
             (SELECT count(*)::text FROM projects p
               WHERE p.visibility = 'public' AND p.deleted_at IS NULL) || ' of 40 public projects'
           WHEN 'team_room_entry' THEN
             (SELECT count(*)::text FROM opportunities o, room_state(o.id) r
               WHERE o.status = 'published' AND (r.intent_count >= 3 OR r.team_count >= 1))
             || ' opportunities are above the room floor'
           ELSE NULL
         END
    FROM feature_flags f
   ORDER BY f.enabled DESC, f.key;
END
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Every one of these checks its own role internally, so granting EXECUTE to `authenticated`
-- grants nothing to a non-admin: the function returns empty or raises. That is deliberate —
-- a grant list is easy to get wrong, and a check inside the function cannot be bypassed by
-- a later migration that forgets to REVOKE.
GRANT EXECUTE ON FUNCTION has_admin_role(text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION admin_queue(text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_claim_queue_item(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_release_queue_item(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_review_card(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_publish_opportunity(uuid, boolean, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_reject_opportunity(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_save_rule(uuid, rule_type, jsonb, text, uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_delete_rule(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_user_action(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_user_search(text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_report_inbox(boolean, int) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_resolve_subject_reports(text, uuid, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_set_source_active(uuid, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_sources() TO authenticated;
GRANT EXECUTE ON FUNCTION admin_audit_search(uuid, uuid, text, timestamptz, int) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_density_status() TO authenticated;
GRANT EXECUTE ON FUNCTION queue_sla_hours(text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_set_flag(text, boolean, text) TO authenticated;

-- The batch tier only.
REVOKE ALL ON FUNCTION operator_alerts_due() FROM PUBLIC;
REVOKE ALL ON FUNCTION record_operator_alerts() FROM PUBLIC;
-- admin_audit is called BY the functions above, which run as definer. No principal needs it
-- directly, and a grant would let a caller write an audit row that never happened.
REVOKE ALL ON FUNCTION admin_audit(text, text, uuid, jsonb, jsonb, text) FROM PUBLIC;
