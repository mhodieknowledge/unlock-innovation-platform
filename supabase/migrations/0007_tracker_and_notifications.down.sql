-- 0007 tracker, notification channels, preferences, deliveries, send budget (down)

DROP TRIGGER IF EXISTS tracker_validate_transition_trigger ON tracker_entries;
DROP FUNCTION IF EXISTS tracker_validate_transition();
DROP FUNCTION IF EXISTS tracker_allowed_transitions(tracker_state);
DROP FUNCTION IF EXISTS tracker_reminder_offsets(tracker_state);

DROP TABLE IF EXISTS send_budget;
DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS user_notification_settings;
DROP TABLE IF EXISTS notification_preferences;
DROP TABLE IF EXISTS notification_channels;
DROP TABLE IF EXISTS tracker_entries;

DROP TYPE IF EXISTS notif_channel;
DROP TYPE IF EXISTS notif_type;
DROP TYPE IF EXISTS tracker_state;
