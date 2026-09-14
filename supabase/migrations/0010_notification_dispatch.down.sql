-- 0010 notification dispatch (down)

DROP FUNCTION IF EXISTS requeue_stale_claims();
DROP FUNCTION IF EXISTS budget_alert_due(notif_channel);
DROP FUNCTION IF EXISTS record_delivery_result(uuid, boolean, text, boolean);
DROP FUNCTION IF EXISTS claim_deliveries(notif_channel, int);
DROP FUNCTION IF EXISTS schedule_deadline_reminders();
DROP FUNCTION IF EXISTS enqueue_notification(uuid, notif_type, text, jsonb, numeric, boolean);
DROP FUNCTION IF EXISTS notif_pushes_today(uuid, notif_type);
DROP FUNCTION IF EXISTS notif_quiet_adjusted(uuid, timestamptz);
DROP FUNCTION IF EXISTS notif_cap_exempt(notif_type);
DROP FUNCTION IF EXISTS notif_default_channels(notif_type, numeric);
DROP FUNCTION IF EXISTS notif_priority(notif_type, numeric);
DROP FUNCTION IF EXISTS channel_daily_cap(notif_channel);

DROP TABLE IF EXISTS operator_alerts;

ALTER TABLE send_budget DROP COLUMN IF EXISTS exhausted_at;

-- Anything still mid-flight loses its claim rather than blocking the constraint.
UPDATE notification_deliveries SET state = 'queued' WHERE state = 'claimed';
ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_state_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_state_check
  CHECK (state IN ('queued','sent','deferred','failed','suppressed'));
