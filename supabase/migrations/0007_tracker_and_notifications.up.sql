-- 0007 tracker, notification channels, preferences, deliveries, send budget
-- DATA_MODEL.md §6 and §10, NOTIFICATIONS.md throughout.
--
-- The email budget is the single most consequential free-tier limit in the system
-- (FREE_INFRASTRUCTURE.md §3.6): ~300/day on Brevo, shared with auth. That is why
-- delivery is a budgeted PRIORITY QUEUE modelled in the schema rather than a
-- send-and-hope call at the point of use.

CREATE TYPE tracker_state AS ENUM (
  'saved','planning_to_apply','applied','submitted','participating','completed',
  'outcome_won','outcome_placed','outcome_not_selected','withdrawn','missed_deadline');

CREATE TYPE notif_type AS ENUM (
  'deadline_reminder','digest','request_received','request_accepted','request_declined',
  'team_update','opportunity_changed','opportunity_closed','project_match',
  'moderation_outcome','security','system');

CREATE TYPE notif_channel AS ENUM ('in_app','email','telegram','web_push');

CREATE TABLE tracker_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  state          tracker_state NOT NULL DEFAULT 'saved',
  -- Private, never read, never scanned, never used for anything
  -- (MODERATION_AND_TRUST.md §10).
  note           text CHECK (char_length(note) <= 2000),
  applied_at     date,
  remind_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, opportunity_id)
);
CREATE INDEX tracker_user_state_idx ON tracker_entries (user_id, state);
CREATE INDEX tracker_remind_idx ON tracker_entries (remind_at) WHERE remind_at IS NOT NULL;

COMMENT ON COLUMN tracker_entries.note IS
  'Private. Never read, scanned or moderated (MODERATION_AND_TRUST.md §10).';

CREATE TABLE notification_channels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     notif_channel NOT NULL,
  -- Telegram chat_id or push endpoint. Never exposed to another user
  -- (COLLABORATION_SYSTEM.md §5.2).
  address     text,
  verified_at timestamptz,
  is_active   boolean NOT NULL DEFAULT true,
  -- NOTIFICATIONS.md §7: /pause suspends pushes for 30 days without unlinking.
  paused_until timestamptz,
  consecutive_failures smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel)
);

CREATE TABLE notification_preferences (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  type    notif_type,
  channel notif_channel,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, type, channel)
);

CREATE TABLE user_notification_settings (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- NOTIFICATIONS.md §5.3: weekly is the DEFAULT, because a weekly digest that is
  -- always worth reading beats a daily one that is sometimes padded.
  digest_frequency text NOT NULL DEFAULT 'weekly'
                     CHECK (digest_frequency IN ('daily','weekly','off')),
  quiet_hours_start smallint NOT NULL DEFAULT 21 CHECK (quiet_hours_start BETWEEN 0 AND 23),
  quiet_hours_end   smallint NOT NULL DEFAULT 7 CHECK (quiet_hours_end BETWEEN 0 AND 23),
  paused_until      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       notif_type NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  -- NOTIFICATIONS.md §1 rule 1: every message states why it was sent. Required,
  -- not optional, so a notification cannot exist without its reason.
  reason     text NOT NULL CHECK (btrim(reason) <> ''),
  priority   smallint NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 5),
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE notification_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         notif_channel NOT NULL,
  state           text NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','sent','deferred','failed','suppressed')),
  attempts        smallint NOT NULL DEFAULT 0,
  deferrals       smallint NOT NULL DEFAULT 0,
  scheduled_for   timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  error           text
);
CREATE INDEX deliveries_dispatch_idx ON notification_deliveries (state, scheduled_for)
  WHERE state IN ('queued', 'deferred');

CREATE TABLE send_budget (
  day     date NOT NULL,
  channel notif_channel NOT NULL,
  sent    int NOT NULL DEFAULT 0,
  cap     int NOT NULL,
  PRIMARY KEY (day, channel)
);

COMMENT ON TABLE send_budget IS
  'Email cap is 280/day: 300 Brevo minus 20 reserved for auth OTP (NOTIFICATIONS.md §4). Telegram is unmetered and is the scaling plan.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Everything here is private to its owner. PRODUCT_SPEC.md §22.3 lists tracker,
-- notes, saved items and digests as private by default, and §22.4 puts tracker
-- history in the "never public" column. ADMIN_SYSTEM.md §6 forbids any admin from
-- seeing tracker contents or digest history, so these policies have no admin
-- clause either — the same deliberate omission as eligibility_profiles.

ALTER TABLE tracker_entries            ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_channels      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications              ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_budget                ENABLE ROW LEVEL SECURITY;

CREATE POLICY tracker_owner_only ON tracker_entries FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY channels_owner_only ON notification_channels FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY prefs_owner_only ON notification_preferences FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY notif_settings_owner_only ON user_notification_settings FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY notifications_owner_read ON notifications FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY notifications_owner_update ON notifications FOR UPDATE
  USING (user_id = auth.uid());

-- Deliveries and the budget are dispatcher-only: written in the batch tier under
-- the service role, never readable by a user. No policy at all, so default deny.

-- ── Tracker state machine ───────────────────────────────────────────────────

/**
 * API_SPEC.md §5: an invalid transition returns 409 with allowed_transitions,
 * rather than silently accepting it. Encoded here so the rule holds for every
 * write path, including the batch tier.
 *
 * PRODUCT_SPEC.md §15 gives the pipeline; terminal states accept nothing further.
 */
CREATE OR REPLACE FUNCTION tracker_allowed_transitions(from_state tracker_state)
RETURNS tracker_state[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE from_state
    WHEN 'saved' THEN
      ARRAY['planning_to_apply','applied','withdrawn','missed_deadline']::tracker_state[]
    WHEN 'planning_to_apply' THEN
      ARRAY['applied','saved','withdrawn','missed_deadline']::tracker_state[]
    WHEN 'applied' THEN
      ARRAY['submitted','participating','outcome_not_selected','withdrawn']::tracker_state[]
    WHEN 'submitted' THEN
      ARRAY['participating','outcome_won','outcome_placed','outcome_not_selected','withdrawn']::tracker_state[]
    WHEN 'participating' THEN
      ARRAY['completed','outcome_won','outcome_placed','outcome_not_selected','withdrawn']::tracker_state[]
    WHEN 'completed' THEN
      ARRAY['outcome_won','outcome_placed','outcome_not_selected']::tracker_state[]
    ELSE ARRAY[]::tracker_state[]
  END
$$;

CREATE OR REPLACE FUNCTION tracker_validate_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    IF NOT (NEW.state = ANY (tracker_allowed_transitions(OLD.state))) THEN
      RAISE EXCEPTION
        'invalid tracker transition % -> %. Allowed: %',
        OLD.state, NEW.state, tracker_allowed_transitions(OLD.state)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER tracker_validate_transition_trigger
  BEFORE UPDATE ON tracker_entries
  FOR EACH ROW EXECUTE FUNCTION tracker_validate_transition();

/**
 * NOTIFICATIONS.md §6 — reminder schedule is driven by tracker STATE, not by
 * browsing. Terminal states get none.
 */
CREATE OR REPLACE FUNCTION tracker_reminder_offsets(state tracker_state)
RETURNS int[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE state
    WHEN 'saved'             THEN ARRAY[7, 2]
    WHEN 'planning_to_apply' THEN ARRAY[7, 3, 1]
    ELSE ARRAY[]::int[]
  END
$$;
