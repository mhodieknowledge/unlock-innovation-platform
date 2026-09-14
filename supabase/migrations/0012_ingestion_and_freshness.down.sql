-- 0012 (down)
--
-- Two functions here are RESTORED rather than dropped: 0012 replaced 0006's
-- versions in place, so dropping them would leave the schema missing behaviour that
-- 0006 installed. The original bodies are reproduced below so a rollback lands
-- exactly where 0006 left off.

DROP FUNCTION IF EXISTS resolve_report(uuid, boolean, text);
DROP FUNCTION IF EXISTS contradictory_rules(uuid);
DROP FUNCTION IF EXISTS expand_regions(text[]);
DROP FUNCTION IF EXISTS route_for_publication(uuid, numeric, numeric, numeric, cost_kind, numeric, char(3), eligibility_scope, boolean, uuid, boolean, boolean);
DROP FUNCTION IF EXISTS apply_staleness_and_expiry();
DROP FUNCTION IF EXISTS record_opportunity_change(uuid, text, jsonb, jsonb, text);
DROP FUNCTION IF EXISTS due_for_verification(int);
DROP FUNCTION IF EXISTS apply_verification_cadence();
DROP FUNCTION IF EXISTS source_health_alert_due();
DROP FUNCTION IF EXISTS degraded_sources();
DROP FUNCTION IF EXISTS record_source_fetch(uuid, fetch_status, int, int, int, text, text, text);
DROP FUNCTION IF EXISTS ai_usage_today();

-- Restore 0006's single-argument cadence function.
DROP FUNCTION IF EXISTS next_verify_interval(timestamptz, boolean);

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

-- Restore 0006's report trigger function, without §6's additions.
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

ALTER TABLE users DROP COLUMN IF EXISTS reporter_weight;

DROP TABLE IF EXISTS ai_usage;
