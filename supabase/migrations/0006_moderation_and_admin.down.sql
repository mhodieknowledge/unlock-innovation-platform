-- 0006 reports, review queues, moderation, audit log, rate limits (down)
--
-- Policies added to tables created by EARLIER migrations must be dropped here,
-- not left behind: 0005's down would otherwise fail, and a policy referencing
-- is_admin() would block 0004's down from dropping the function.

DROP POLICY IF EXISTS feature_flags_admin_write ON feature_flags;
DROP POLICY IF EXISTS sources_admin_write ON sources;
DROP POLICY IF EXISTS opportunity_briefs_admin_write ON opportunity_briefs;
DROP POLICY IF EXISTS opportunity_changes_admin_write ON opportunity_changes;
DROP POLICY IF EXISTS organisations_admin_write ON organisations;
DROP POLICY IF EXISTS eligibility_rules_admin_write ON eligibility_rules;
DROP POLICY IF EXISTS opportunities_admin_write ON opportunities;

DROP TRIGGER IF EXISTS reports_auto_dispute_trigger ON reports;
DROP FUNCTION IF EXISTS reports_auto_dispute();
DROP FUNCTION IF EXISTS next_verify_interval(timestamptz);
DROP FUNCTION IF EXISTS check_rate_limit(text, int, interval);

DROP TABLE IF EXISTS rate_limit_counters;
DROP TABLE IF EXISTS admin_audit_log;
DROP TABLE IF EXISTS moderation_actions;
DROP TABLE IF EXISTS review_queue;
DROP TABLE IF EXISTS reports;

DROP TYPE IF EXISTS report_reason;
