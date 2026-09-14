-- Rolls 0022 back. Every object is new in this migration, so the rollback is drops only.

-- Restore 0006's feature-flag policy, which granted write access to any admin. Both drops
-- run first so this is safe to re-run: a down migration that fails halfway leaves the schema
-- and the ledger disagreeing, which is worse than no down migration at all.
DROP POLICY IF EXISTS feature_flags_superadmin_write ON feature_flags;
DROP POLICY IF EXISTS feature_flags_admin_write ON feature_flags;
CREATE POLICY feature_flags_admin_write ON feature_flags FOR ALL
  USING (is_admin()) WITH CHECK (is_admin());

DROP FUNCTION IF EXISTS admin_set_flag(text, boolean, text);
DROP FUNCTION IF EXISTS admin_density_status();
DROP FUNCTION IF EXISTS admin_audit_search(uuid, uuid, text, timestamptz, int);
DROP FUNCTION IF EXISTS record_operator_alerts();
DROP FUNCTION IF EXISTS operator_alerts_due();
DROP FUNCTION IF EXISTS admin_sources();
DROP FUNCTION IF EXISTS admin_set_source_active(uuid, boolean, text, text);
DROP FUNCTION IF EXISTS admin_resolve_subject_reports(text, uuid, boolean, text, text);
DROP FUNCTION IF EXISTS admin_report_inbox(boolean, int);
DROP FUNCTION IF EXISTS admin_user_search(text, int);
DROP FUNCTION IF EXISTS admin_user_action(uuid, text, text, text);
DROP FUNCTION IF EXISTS admin_delete_rule(uuid, text, text);
DROP FUNCTION IF EXISTS admin_save_rule(uuid, rule_type, jsonb, text, uuid, numeric, text);
DROP FUNCTION IF EXISTS admin_reject_opportunity(uuid, text, text);
DROP FUNCTION IF EXISTS admin_publish_opportunity(uuid, boolean, boolean, text);
DROP FUNCTION IF EXISTS admin_review_card(uuid);
DROP FUNCTION IF EXISTS admin_release_queue_item(uuid);
DROP FUNCTION IF EXISTS admin_claim_queue_item(uuid);
DROP FUNCTION IF EXISTS admin_queue(text, int);
DROP FUNCTION IF EXISTS admin_dashboard();
DROP FUNCTION IF EXISTS queue_sla_hours(text);
DROP FUNCTION IF EXISTS admin_audit(text, text, uuid, jsonb, jsonb, text);
DROP FUNCTION IF EXISTS has_admin_role(text);
