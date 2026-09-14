-- 0006 reports, review queues, moderation actions, audit log, rate limits
-- DATA_MODEL.md §11–12, MODERATION_AND_TRUST.md §3, ADMIN_SYSTEM.md §11.
--
-- Also adds the admin WRITE policies. Until now every table was read-only to
-- every principal except the service role, which is correct as a default
-- (SECURITY.md §2: default deny) but means nothing could be published.
--
-- Admin writes go through an authenticated admin USER, never a service key in the
-- request tier. SECURITY.md §2 is explicit that the service-role key exists in
-- exactly one place — GitHub Actions — and is never present in a Worker reachable
-- from the edge. That constraint is what makes RLS the real boundary rather than
-- a formality.

CREATE TYPE report_reason AS ENUM (
  'expired','wrong_deadline','wrong_eligibility','broken_link','possible_scam',
  'requires_payment','duplicate','incorrect_info','spam','harassment',
  'impersonation','inappropriate','other');

CREATE TABLE reports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id     uuid REFERENCES users(id),
  -- Logged-out reporting is allowed on opportunities: most people spotting a
  -- dead link will not have an account, and we want that signal
  -- (MODERATION_AND_TRUST.md §5). A coarse fingerprint supports rate limiting
  -- without storing an IP.
  reporter_fingerprint text,
  subject_type         text NOT NULL CHECK (subject_type IN
                         ('opportunity','project','profile','team','message','organisation')),
  subject_id           uuid NOT NULL,
  reason               report_reason NOT NULL,
  detail               text CHECK (char_length(detail) <= 1000),
  state                text NOT NULL DEFAULT 'open'
                         CHECK (state IN ('open','actioned','dismissed','duplicate')),
  priority             smallint NOT NULL DEFAULT 5,
  resolved_by          uuid REFERENCES users(id),
  resolved_at          timestamptz,
  outcome_note         text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_triage_idx ON reports (state, priority, created_at);
CREATE INDEX reports_subject_idx ON reports (subject_type, subject_id);

CREATE TABLE review_queue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue        text NOT NULL CHECK (queue IN
                 ('report_scam','report_safety','paid_cost','low_confidence',
                  'duplicate','org_claim','ugc','extraction')),
  subject_type text NOT NULL,
  subject_id   uuid NOT NULL,
  priority     smallint NOT NULL DEFAULT 5,
  state        text NOT NULL DEFAULT 'open' CHECK (state IN ('open','claimed','done')),
  claimed_by   uuid REFERENCES users(id),
  claimed_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_queue_open_idx ON review_queue (queue, priority, created_at)
  WHERE state <> 'done';

CREATE TABLE moderation_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id),
  action        text NOT NULL,
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,
  reason        text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ADMIN_SYSTEM.md §11: immutable, insert-only, superadmin-only read, 24 months.
CREATE TABLE admin_audit_log (
  id            bigserial PRIMARY KEY,
  ts            timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users(id),
  action        text NOT NULL,
  subject_type  text,
  subject_id    uuid,
  before        jsonb,
  after         jsonb,
  -- SECURITY.md §9: IPs are stored hashed, only where required for abuse
  -- control, and expire after 30 days.
  ip_hash       text
);
CREATE INDEX admin_audit_actor_idx ON admin_audit_log (actor_user_id, ts DESC);
CREATE INDEX admin_audit_subject_idx ON admin_audit_log (subject_type, subject_id);

CREATE TABLE rate_limit_counters (
  key        text PRIMARY KEY,
  count      int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);
CREATE INDEX rate_limit_expiry_idx ON rate_limit_counters (expires_at);

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE reports            ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_queue       ENABLE ROW LEVEL SECURITY;
ALTER TABLE moderation_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_counters ENABLE ROW LEVEL SECURITY;

-- Anyone may file a report, including logged out. Nobody but an admin may read
-- them: DATA_MODEL.md §11 and PRODUCT_SPEC.md §22.4 keep the report and the
-- reporter's identity out of public view entirely.
CREATE POLICY reports_anyone_insert ON reports FOR INSERT WITH CHECK (true);
CREATE POLICY reports_own_read ON reports FOR SELECT
  USING (reporter_user_id = auth.uid() OR is_admin());
CREATE POLICY reports_admin_write ON reports FOR UPDATE USING (is_admin());

CREATE POLICY review_queue_admin_all ON review_queue FOR ALL USING (is_admin());
CREATE POLICY moderation_actions_admin_all ON moderation_actions FOR ALL USING (is_admin());

-- Insert-only by construction: a SELECT policy for superadmins and NO update or
-- delete policy at all, so the log cannot be rewritten through the API even by
-- an admin. Append-only is the whole point of an audit log.
CREATE POLICY admin_audit_superadmin_read ON admin_audit_log FOR SELECT
  USING (EXISTS (SELECT 1 FROM users
                  WHERE id = auth.uid() AND admin_role = 'superadmin'));
CREATE POLICY admin_audit_admin_insert ON admin_audit_log FOR INSERT
  WITH CHECK (is_admin());

-- ── Admin write policies on the content tables ──────────────────────────────

CREATE POLICY opportunities_admin_write ON opportunities FOR ALL USING (is_admin());
CREATE POLICY eligibility_rules_admin_write ON eligibility_rules FOR ALL USING (is_admin());
CREATE POLICY organisations_admin_write ON organisations FOR ALL USING (is_admin());
CREATE POLICY opportunity_changes_admin_write ON opportunity_changes FOR ALL USING (is_admin());
CREATE POLICY opportunity_briefs_admin_write ON opportunity_briefs FOR ALL USING (is_admin());
CREATE POLICY sources_admin_write ON sources FOR ALL USING (is_admin());
CREATE POLICY feature_flags_admin_write ON feature_flags FOR ALL
  USING (EXISTS (SELECT 1 FROM users
                  WHERE id = auth.uid() AND admin_role = 'superadmin'));

-- ── Trust and freshness automation ──────────────────────────────────────────

/**
 * MODERATION_AND_TRUST.md §2.2: a scam or payment report sets
 * verification='disputed' IMMEDIATELY AND AUTOMATICALLY, before any human sees
 * it — de-ranked, banner shown, excluded from digests.
 *
 * "Bias: false positives cost us one listing. False negatives cost someone
 * money. Act first, review second." Doing this in a trigger rather than in
 * application code means it cannot be forgotten by a future write path.
 */
CREATE OR REPLACE FUNCTION reports_auto_dispute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.subject_type = 'opportunity'
     AND NEW.reason IN ('possible_scam', 'requires_payment') THEN

    UPDATE opportunities
       SET verification = 'disputed', updated_at = now()
     WHERE id = NEW.subject_id
       AND verification <> 'disputed';

    -- Priority 1, 12-hour SLA (MODERATION_AND_TRUST.md §3).
    INSERT INTO review_queue (queue, subject_type, subject_id, priority)
    VALUES ('report_scam', 'opportunity', NEW.subject_id, 1);

    NEW.priority := 1;

  ELSIF NEW.reason IN ('harassment', 'impersonation', 'inappropriate') THEN
    INSERT INTO review_queue (queue, subject_type, subject_id, priority)
    VALUES ('report_safety', NEW.subject_type, NEW.subject_id, 1);
    NEW.priority := 1;

  ELSIF NEW.subject_type = 'opportunity'
        AND NEW.reason IN ('wrong_deadline', 'wrong_eligibility', 'broken_link', 'expired') THEN
    INSERT INTO review_queue (queue, subject_type, subject_id, priority)
    VALUES ('low_confidence', 'opportunity', NEW.subject_id, 2);
    NEW.priority := 2;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER reports_auto_dispute_trigger
  BEFORE INSERT ON reports
  FOR EACH ROW EXECUTE FUNCTION reports_auto_dispute();

/**
 * Exact per-action rate limiting. SECURITY.md §7 layer 2, API_SPEC.md §15.
 *
 * SECURITY DEFINER so an anonymous caller can increment a counter WITHOUT any
 * table access: `rate_limit_counters` has RLS on and no policy, so it is
 * unreachable directly. This is the only way in, and it returns a boolean rather
 * than any stored state.
 *
 * Cloudflare provides the coarse IP/ASN layer in front of this
 * (SECURITY.md §7 layer 1); this layer is the precise per-user, per-action one.
 */
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_key      text,
  p_limit    int,
  p_window   interval
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE current_count int;
BEGIN
  DELETE FROM rate_limit_counters WHERE expires_at < now();

  INSERT INTO rate_limit_counters (key, count, expires_at)
  VALUES (p_key, 1, now() + p_window)
  ON CONFLICT (key) DO UPDATE
    SET count = rate_limit_counters.count + 1
  RETURNING count INTO current_count;

  RETURN current_count <= p_limit;
END
$$;

REVOKE ALL ON FUNCTION check_rate_limit(text, int, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_rate_limit(text, int, interval) TO anon, authenticated;

/**
 * OPPORTUNITY_INGESTION.md §5.1 — re-verification cadence is a function of
 * urgency, because a wrong deadline matters most when the deadline is near.
 */
CREATE OR REPLACE FUNCTION next_verify_interval(deadline timestamptz)
RETURNS interval
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN deadline IS NULL                          THEN interval '14 days'
    WHEN deadline - now() <= interval '3 days'      THEN interval '12 hours'
    WHEN deadline - now() <= interval '7 days'      THEN interval '24 hours'
    WHEN deadline - now() <= interval '30 days'     THEN interval '3 days'
    ELSE                                                interval '7 days'
  END
$$;
