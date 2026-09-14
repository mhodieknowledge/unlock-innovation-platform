-- 0010 notification enqueue, the budgeted dispatch queue, and deadline reminders
--
-- NOTIFICATIONS.md is the spec; 0007 gave it tables. This file gives it BEHAVIOUR,
-- and it lives in the database rather than in the dispatcher script for one
-- reason: the caps, the quiet hours and the budget rules are product promises
-- (§1 is tagged `[PR]`), and a promise enforced in one calling script is a promise
-- the next caller breaks. Every write path — web, bot, batch — goes through
-- enqueue_notification and therefore cannot exceed the caps.
--
-- TWO READINGS HAD TO BE RECONCILED.
--
-- §1.2 caps "at most 1 digest/day and 3 non-request transactional messages/day",
-- exempting "direct request and acceptance events" only. §3's table marks more
-- types cap-exempt (security, a deadline within 48h, opportunity_changed,
-- moderation_outcome). §1 is tagged `[PR]` and §3's table is not, so §1's narrower
-- exemption list wins — the conservative direction, fewer messages.
--
-- But the cap here limits PUSHES, not records. §2: "Every notification is always
-- written in-app, regardless of whether any push channel delivers it... Nothing is
-- lost, only delayed", and §10 makes that an invariant. So a capped notification
-- still exists, is still read in-app, and only its push is dropped. `security` is
-- additionally exempt from the push cap: it is priority 1, and silently not
-- telling someone their email address changed is a security defect, not noise
-- control.

-- ── A real claim state ──────────────────────────────────────────────────────
-- 0007's states describe outcomes, not the moment in between. Without a claimed
-- state, a dispatcher run that takes longer than the 15-minute schedule overlaps
-- the next one and both send the same message: SELECT ... FOR UPDATE holds the row
-- only until the claiming transaction commits, and it commits with the row still
-- 'queued'. So claiming is a state transition, and requeue_stale_claims below
-- recovers anything a crashed run left behind.
ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_state_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_state_check
  CHECK (state IN ('queued','claimed','deferred','sent','failed','suppressed'));

-- ── When the budget ran out, so §4 rule 5 can see two consecutive days ──────
ALTER TABLE send_budget ADD COLUMN exhausted_at timestamptz;

COMMENT ON COLUMN send_budget.exhausted_at IS
  'First moment the day''s cap was reached. NOTIFICATIONS.md §4: exhausted before 18:00 on two consecutive days alerts the operator.';

/**
 * Operator alerts. NOTIFICATIONS.md §4 and §10 both require the operator to be
 * told when capacity binds or a job fails; without a record, "alert" degrades to
 * "log line nobody reads".
 *
 * Deduplicated by (kind, day) so a failing dispatcher cannot itself become the
 * flood it is meant to warn about.
 */
CREATE TABLE operator_alerts (
  kind       text NOT NULL,
  day        date NOT NULL DEFAULT current_date,
  detail     text NOT NULL,
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, day)
);
ALTER TABLE operator_alerts ENABLE ROW LEVEL SECURITY;
-- No policy: batch tier only, like notification_deliveries.

/** The daily cap per channel. NOTIFICATIONS.md §2. */
CREATE OR REPLACE FUNCTION channel_daily_cap(p_channel notif_channel)
RETURNS int
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_channel
    -- 300 Brevo minus 20 reserved for auth OTP (§4). The reserve is not
    -- negotiable: running out of OTP capacity locks people out of the product.
    WHEN 'email' THEN 280
    -- Unmetered (§2). A number is still recorded so the dispatcher has one code
    -- path, and so a runaway loop is capped by something.
    WHEN 'telegram' THEN 20000
    ELSE 100000
  END
$$;

/**
 * §3's priority table, as a function.
 *
 * p_hours_to_deadline distinguishes the two deadline_reminder rows: ≤48h is
 * priority 2 and reaches email, 7d/3d is priority 3 and does not.
 */
CREATE OR REPLACE FUNCTION notif_priority(
  p_type notif_type,
  p_hours_to_deadline numeric DEFAULT NULL
)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_type = 'security' THEN 1
    WHEN p_type = 'deadline_reminder' THEN
      CASE WHEN p_hours_to_deadline IS NOT NULL AND p_hours_to_deadline <= 48 THEN 2 ELSE 3 END
    WHEN p_type IN ('request_received','request_accepted','request_declined','opportunity_changed') THEN 2
    WHEN p_type IN ('opportunity_closed','moderation_outcome') THEN 3
    WHEN p_type IN ('team_update','project_match') THEN 4
    ELSE 5
  END::smallint
$$;

/**
 * §3's default-channels column. in_app is always included: it is the system of
 * record, and every other channel is an optimisation on top of it.
 */
CREATE OR REPLACE FUNCTION notif_default_channels(
  p_type notif_type,
  p_hours_to_deadline numeric DEFAULT NULL
)
RETURNS notif_channel[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_type = 'security' THEN ARRAY['in_app','email']::notif_channel[]
    WHEN p_type = 'deadline_reminder' THEN
      CASE WHEN p_hours_to_deadline IS NOT NULL AND p_hours_to_deadline <= 48
           THEN ARRAY['in_app','telegram','email']::notif_channel[]
           ELSE ARRAY['in_app','telegram']::notif_channel[] END
    WHEN p_type IN ('request_received','request_accepted','request_declined',
                    'opportunity_changed','opportunity_closed')
      THEN ARRAY['in_app','telegram']::notif_channel[]
    WHEN p_type = 'moderation_outcome' THEN ARRAY['in_app','email']::notif_channel[]
    -- digest picks ONE push channel (§3), resolved in enqueue_notification
    -- because it depends on what the user has linked.
    WHEN p_type = 'digest' THEN ARRAY['in_app']::notif_channel[]
    ELSE ARRAY['in_app']::notif_channel[]
  END
$$;

/** §1.2's exemption list, plus security. See the header note. */
CREATE OR REPLACE FUNCTION notif_cap_exempt(p_type notif_type)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_type IN ('request_received','request_accepted','request_declined','security')
$$;

/**
 * The next moment outside the user's quiet hours, in their own timezone.
 *
 * §1.5: default 21:00–07:00, "never overridden except for a deadline within 6
 * hours on a tracked item". The override is the caller's to assert, because only
 * the caller knows how close the deadline is.
 *
 * Quiet hours wrap midnight in the default case, so the comparison has to handle
 * start > end. Getting that wrong would silently mean no quiet hours at all.
 */
CREATE OR REPLACE FUNCTION notif_quiet_adjusted(p_user_id uuid, p_at timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_tz text;
  v_start smallint;
  v_end smallint;
  v_local timestamp;
  v_hour int;
  v_target timestamp;
BEGIN
  SELECT coalesce(u.timezone, 'UTC'),
         coalesce(s.quiet_hours_start, 21),
         coalesce(s.quiet_hours_end, 7)
    INTO v_tz, v_start, v_end
    FROM users u
    LEFT JOIN user_notification_settings s ON s.user_id = u.id
   WHERE u.id = p_user_id;

  IF v_tz IS NULL THEN
    RETURN p_at;
  END IF;

  -- A zero-length window means quiet hours are off.
  IF v_start = v_end THEN
    RETURN p_at;
  END IF;

  v_local := p_at AT TIME ZONE v_tz;
  v_hour := extract(hour FROM v_local)::int;

  IF v_start < v_end THEN
    -- Same-day window, e.g. 01:00-06:00.
    IF v_hour < v_start OR v_hour >= v_end THEN RETURN p_at; END IF;
    v_target := date_trunc('day', v_local) + make_interval(hours => v_end);
  ELSE
    -- Wraps midnight, e.g. 21:00-07:00 (the default).
    IF v_hour < v_start AND v_hour >= v_end THEN RETURN p_at; END IF;
    v_target := date_trunc('day', v_local) + make_interval(hours => v_end);
    IF v_hour >= v_start THEN
      v_target := v_target + interval '1 day';
    END IF;
  END IF;

  RETURN v_target AT TIME ZONE v_tz;
END
$$;

/**
 * Today's push count for a user, for the §1.2 caps.
 *
 * Counts DELIVERIES on push channels, not notifications: the cap is on messages
 * sent to a person, and an in-app record is not a message sent to anyone.
 */
CREATE OR REPLACE FUNCTION notif_pushes_today(p_user_id uuid, p_type notif_type DEFAULT NULL)
RETURNS int
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT count(*)::int
    FROM notification_deliveries d
    JOIN notifications n ON n.id = d.notification_id
   WHERE n.user_id = p_user_id
     AND d.channel <> 'in_app'
     AND d.state IN ('queued','deferred','sent')
     AND n.created_at >= date_trunc('day', now())
     AND (p_type IS NULL OR n.type = p_type)
     AND (p_type IS NOT NULL OR NOT notif_cap_exempt(n.type))
     AND (p_type IS NOT NULL OR n.type <> 'digest')
$$;

/**
 * THE one way to create a notification.
 *
 * Order matters: the in-app record is written FIRST and unconditionally, so §10's
 * invariant ("a notification failure never loses information") holds even if every
 * push decision below goes against sending. Returns the notification id.
 *
 * p_urgent is §1.5's single quiet-hours override: a deadline within 6 hours on a
 * tracked item. It does not bypass the caps.
 */
CREATE OR REPLACE FUNCTION enqueue_notification(
  p_user_id uuid,
  p_type notif_type,
  p_reason text,
  p_payload jsonb DEFAULT '{}',
  p_hours_to_deadline numeric DEFAULT NULL,
  p_urgent boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_priority smallint;
  v_channels notif_channel[];
  v_channel notif_channel;
  v_at timestamptz := now();
  v_scheduled timestamptz;
  v_paused timestamptz;
  v_state text;
  v_has_telegram boolean;
  v_allowed boolean;
BEGIN
  IF p_user_id IS NULL OR btrim(coalesce(p_reason,'')) = '' THEN
    -- §1.1: the reason is a required field, "rendered in the message". A
    -- notification without one cannot be shown honestly, so it is not created.
    RAISE EXCEPTION 'enqueue_notification needs a user and a reason';
  END IF;

  SELECT account_state INTO v_state FROM users WHERE id = p_user_id;
  IF v_state IS NULL OR v_state IN ('deleted','suspended') THEN
    RETURN NULL;
  END IF;

  v_priority := notif_priority(p_type, p_hours_to_deadline);

  INSERT INTO notifications (user_id, type, payload, reason, priority)
  VALUES (p_user_id, p_type, coalesce(p_payload,'{}'), p_reason, v_priority)
  RETURNING id INTO v_id;

  INSERT INTO notification_deliveries (notification_id, channel, state, scheduled_for, sent_at)
  VALUES (v_id, 'in_app', 'sent', v_at, v_at);

  -- ── From here on, everything is about PUSH, and may decide not to. ────────

  SELECT paused_until INTO v_paused FROM user_notification_settings WHERE user_id = p_user_id;
  IF v_paused IS NOT NULL AND v_paused > v_at AND p_type <> 'security' THEN
    RETURN v_id;   -- "pause everything for 30 days" (§8). Security still lands.
  END IF;

  IF NOT notif_cap_exempt(p_type) THEN
    IF p_type = 'digest' THEN
      IF notif_pushes_today(p_user_id, 'digest') >= 1 THEN RETURN v_id; END IF;
    ELSIF notif_pushes_today(p_user_id) >= 3 THEN
      RETURN v_id;
    END IF;
  END IF;

  v_channels := notif_default_channels(p_type, p_hours_to_deadline);

  -- EMAIL IS A FALLBACK, NEVER A DUPLICATE.
  --
  -- §3 lists "Telegram + email + in-app" for a deadline_reminder within 48 hours,
  -- while IMPLEMENTATION_PLAN.md §4's acceptance criteria require that "a
  -- Telegram-linked user receives a deadline reminder without any email being
  -- sent" — and that one is tagged `[PR]`. Both hold if the two channels are
  -- alternatives rather than copies: the message is offered both routes, and the
  -- free one wins when it is available. §4's arithmetic says the same thing in
  -- another register — 280 emails a day is the binding constraint, and spending one
  -- on a message already delivered is the least defensible way to spend it.
  IF 'telegram' = ANY(v_channels) AND 'email' = ANY(v_channels) THEN
    SELECT EXISTS (
      SELECT 1 FROM notification_channels
       WHERE user_id = p_user_id AND channel = 'telegram'
         AND is_active AND verified_at IS NOT NULL
         AND (paused_until IS NULL OR paused_until <= v_at)
    ) INTO v_has_telegram;
    IF v_has_telegram THEN
      v_channels := array_remove(v_channels, 'email'::notif_channel);
    END IF;
  END IF;

  -- §3: the digest takes ONE push channel. Telegram first — it is free, and §4's
  -- arithmetic makes email the scarce resource that Telegram exists to spare.
  IF p_type = 'digest' THEN
    SELECT EXISTS (
      SELECT 1 FROM notification_channels
       WHERE user_id = p_user_id AND channel = 'telegram'
         AND is_active AND verified_at IS NOT NULL
         AND (paused_until IS NULL OR paused_until <= v_at)
    ) INTO v_has_telegram;
    v_channels := v_channels ||
      CASE WHEN v_has_telegram THEN 'telegram'::notif_channel ELSE 'email'::notif_channel END;
  END IF;

  v_scheduled := CASE
    -- Priority 1 is security: it is not held for the morning.
    WHEN p_urgent OR v_priority <= 1 THEN v_at
    ELSE notif_quiet_adjusted(p_user_id, v_at)
  END;

  FOREACH v_channel IN ARRAY v_channels LOOP
    CONTINUE WHEN v_channel = 'in_app';

    -- A per-type opt-out (§8's matrix). Absent row means the default, which is on.
    SELECT coalesce(
      (SELECT enabled FROM notification_preferences
        WHERE user_id = p_user_id AND type = p_type AND channel = v_channel),
      true) INTO v_allowed;

    -- §9: unsubscribe "never silently from security messages".
    IF p_type = 'security' THEN v_allowed := true; END IF;
    CONTINUE WHEN NOT v_allowed;

    -- The channel must exist, be verified and not be paused. Email falls back to
    -- the account address, which is verified by definition of how sign-in works.
    IF v_channel = 'email' THEN
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id AND email IS NOT NULL);
    ELSE
      CONTINUE WHEN NOT EXISTS (
        SELECT 1 FROM notification_channels
         WHERE user_id = p_user_id AND channel = v_channel
           AND is_active AND verified_at IS NOT NULL AND address IS NOT NULL
           AND (paused_until IS NULL OR paused_until <= v_at)
      );
    END IF;

    INSERT INTO notification_deliveries (notification_id, channel, scheduled_for)
    VALUES (v_id, v_channel, v_scheduled);
  END LOOP;

  RETURN v_id;
END
$$;

/**
 * Deadline reminders. NOTIFICATIONS.md §6, "driven by tracker state, not by
 * browsing":
 *   saved             -> 7 days, 2 days before
 *   planning_to_apply -> 7, 3, 1 days before
 *   applied/submitted -> start date only
 *   participating     -> event start, submission deadline
 *   terminal states   -> none
 *
 * Plus one custom reminder per tracked item (tracker_entries.remind_at).
 *
 * Idempotent by construction: a reminder is keyed by (tracker entry, offset) in
 * the payload and the function refuses to create a second one. The job runs on a
 * schedule and WILL see the same window twice; without that key it would remind
 * someone hourly, which is precisely the noise §1.3 forbids.
 *
 * State is re-checked here, at send-scheduling time, not when the item was saved
 * — §6's `[PR]`: "A reminder for an opportunity that has since expired or been
 * rejected is cancelled, not sent."
 */
CREATE OR REPLACE FUNCTION schedule_deadline_reminders()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_offsets int[];
  v_offset int;
  v_target int;
  v_hours numeric;
  v_created int := 0;
  v_key text;
BEGIN
  FOR r IN
    SELECT t.id AS tracker_id, t.user_id, t.state, t.remind_at, t.created_at AS saved_at,
           o.id AS opportunity_id, o.slug, o.title, o.deadline_at, o.deadline_precision,
           o.starts_at, o.ends_at, o.is_rolling, o.status,
           org.name AS org_name
      FROM tracker_entries t
      JOIN opportunities o ON o.id = t.opportunity_id
      LEFT JOIN organisations org ON org.id = o.organisation_id
     WHERE t.state IN ('saved','planning_to_apply','applied','submitted','participating')
       AND o.status = 'published'
       AND o.deleted_at IS NULL
  LOOP
    -- Which offsets this state earns.
    v_offsets := CASE r.state
      WHEN 'saved' THEN ARRAY[7,2]
      WHEN 'planning_to_apply' THEN ARRAY[7,3,1]
      ELSE ARRAY[]::int[]
    END;

    -- applied/submitted/participating are reminded about the START date instead,
    -- because the application is already in and the next thing that matters is
    -- showing up.
    IF r.state IN ('applied','submitted','participating') AND r.starts_at IS NOT NULL THEN
      IF r.starts_at > now() AND r.starts_at < now() + interval '3 days' THEN
        v_key := r.tracker_id::text || ':start';
        IF NOT EXISTS (
          SELECT 1 FROM notifications
           WHERE user_id = r.user_id AND type = 'deadline_reminder'
             AND payload->>'key' = v_key
        ) THEN
          PERFORM enqueue_notification(
            r.user_id, 'deadline_reminder',
            'You marked this as ' || replace(r.state::text,'_',' ') || ' on your tracker.',
            jsonb_build_object(
              'key', v_key, 'kind', 'start',
              'opportunity_id', r.opportunity_id, 'slug', r.slug, 'title', r.title,
              'organisation', r.org_name, 'at', r.starts_at, 'days', 0),
            extract(epoch FROM (r.starts_at - now())) / 3600,
            false);
          v_created := v_created + 1;
        END IF;
      END IF;
    END IF;

    -- §6 gives `participating` two reminders: event start (above) and the
    -- submission deadline. `ends_at` is the closest thing the data model has to a
    -- participant's submission cut-off, so that is what is used, and the payload
    -- says which field it came from rather than implying more precision.
    IF r.state = 'participating' AND r.ends_at IS NOT NULL
       AND r.ends_at > now() AND r.ends_at < now() + interval '3 days' THEN
      v_key := r.tracker_id::text || ':ends';
      IF NOT EXISTS (
        SELECT 1 FROM notifications
         WHERE user_id = r.user_id AND type = 'deadline_reminder'
           AND payload->>'key' = v_key
      ) THEN
        PERFORM enqueue_notification(
          r.user_id, 'deadline_reminder',
          'You marked yourself as taking part in this.',
          jsonb_build_object(
            'key', v_key, 'kind', 'submission',
            'opportunity_id', r.opportunity_id, 'slug', r.slug, 'title', r.title,
            'organisation', r.org_name, 'at', r.ends_at, 'days', NULL),
          extract(epoch FROM (r.ends_at - now())) / 3600,
          extract(epoch FROM (r.ends_at - now())) / 3600 <= 6);
        v_created := v_created + 1;
      END IF;
    END IF;

    CONTINUE WHEN r.deadline_at IS NULL OR r.is_rolling;

    v_hours := extract(epoch FROM (r.deadline_at - now())) / 3600;
    CONTINUE WHEN v_hours <= 0;

    -- ONLY the tightest window fires.
    --
    -- Every offset whose window has been entered still satisfies
    -- `hours <= offset * 24` for the rest of the item's life, so firing each match
    -- would send the 7-day and 2-day reminders together to anyone who saved an
    -- item 36 hours before its deadline, and would re-send the 7-day one on every
    -- later run. The tightest applicable window is also the only honest one: at 36
    -- hours, "closes in 7 days" is false.
    v_target := NULL;
    FOREACH v_offset IN ARRAY v_offsets LOOP
      IF v_hours <= v_offset * 24 AND (v_target IS NULL OR v_offset < v_target) THEN
        v_target := v_offset;
      END IF;
    END LOOP;

    IF v_target IS NOT NULL THEN
      v_offset := v_target;
      v_key := r.tracker_id::text || ':' || v_offset::text;
      IF NOT EXISTS (
        SELECT 1 FROM notifications
         WHERE user_id = r.user_id AND type = 'deadline_reminder'
           AND payload->>'key' = v_key
      ) THEN

      PERFORM enqueue_notification(
        r.user_id, 'deadline_reminder',
        'You saved this on ' || to_char(r.saved_at, 'FMDD FMMonth') || '.',
        jsonb_build_object(
          'key', v_key, 'kind', 'deadline',
          'opportunity_id', r.opportunity_id, 'slug', r.slug, 'title', r.title,
          'organisation', r.org_name, 'at', r.deadline_at,
          'precision', r.deadline_precision, 'days', v_offset),
        v_hours,
        -- §1.5's only quiet-hours override: a deadline within 6 hours on a
        -- tracked item.
        v_hours <= 6);
        v_created := v_created + 1;
      END IF;
    END IF;

    -- The user's own custom reminder, honoured once.
    IF r.remind_at IS NOT NULL AND r.remind_at <= now() THEN
      v_key := r.tracker_id::text || ':custom:' || to_char(r.remind_at,'YYYYMMDDHH24MI');
      IF NOT EXISTS (
        SELECT 1 FROM notifications
         WHERE user_id = r.user_id AND type = 'deadline_reminder'
           AND payload->>'key' = v_key
      ) THEN
        PERFORM enqueue_notification(
          r.user_id, 'deadline_reminder',
          'You asked to be reminded about this.',
          jsonb_build_object(
            'key', v_key, 'kind', 'custom',
            'opportunity_id', r.opportunity_id, 'slug', r.slug, 'title', r.title,
            'organisation', r.org_name, 'at', r.deadline_at, 'days', NULL),
          v_hours, false);
        v_created := v_created + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN v_created;
END
$$;

/**
 * Claim a batch of deliveries to send, applying §4's budget rules.
 *
 *   priority 1-2  -> send always; if the budget is gone, borrow from tomorrow
 *                    and alert the operator
 *   priority 3    -> send if remaining > 40
 *   priority 4-5  -> send if remaining > 120
 *   otherwise     -> defer 24h, max 2 deferrals, then in-app only, 'suppressed'
 *
 * Claiming and deferring happen in ONE statement per delivery under
 * FOR UPDATE SKIP LOCKED, so two dispatcher runs overlapping — which the 15-minute
 * schedule makes likely on a slow run — cannot send the same message twice.
 *
 * Also the point at which §6's cancellation is enforced: a reminder whose
 * opportunity is no longer published, or whose tracker entry has moved to a
 * terminal state, is suppressed here rather than sent.
 */
CREATE OR REPLACE FUNCTION claim_deliveries(p_channel notif_channel, p_limit int DEFAULT 50)
RETURNS TABLE (
  delivery_id uuid,
  notification_id uuid,
  user_id uuid,
  type notif_type,
  payload jsonb,
  reason text,
  priority smallint,
  address text,
  timezone text,
  low_data_mode boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap int := channel_daily_cap(p_channel);
  v_sent int;
  v_remaining int;
  r record;
  v_send boolean;
  v_downgrade_id uuid;
BEGIN
  INSERT INTO send_budget (day, channel, cap)
  VALUES (current_date, p_channel, v_cap)
  ON CONFLICT (day, channel) DO NOTHING;

  SELECT sent INTO v_sent FROM send_budget
   WHERE day = current_date AND channel = p_channel FOR UPDATE;
  v_remaining := v_cap - v_sent;

  FOR r IN
    SELECT d.id, d.notification_id, d.deferrals, n.user_id, n.type, n.payload,
           n.reason, n.priority
      FROM notification_deliveries d
      JOIN notifications n ON n.id = d.notification_id
     WHERE d.channel = p_channel
       AND d.state IN ('queued','deferred')
       AND d.scheduled_for <= now()
     ORDER BY n.priority ASC, d.scheduled_for ASC
     LIMIT p_limit
     FOR UPDATE OF d SKIP LOCKED
  LOOP
    -- §6 `[PR]`: re-check at send time, not schedule time.
    IF r.type = 'deadline_reminder' THEN
      IF NOT EXISTS (
        SELECT 1 FROM tracker_entries t
          JOIN opportunities o ON o.id = t.opportunity_id
         WHERE t.user_id = r.user_id
           AND o.id = (r.payload->>'opportunity_id')::uuid
           AND o.status = 'published'
           AND t.state IN ('saved','planning_to_apply','applied','submitted','participating')
      ) THEN
        UPDATE notification_deliveries
           SET state = 'suppressed',
               error = 'cancelled at send time: opportunity or tracker state changed'
         WHERE id = r.id;
        CONTINUE;
      END IF;
    END IF;

    v_send := CASE
      WHEN r.priority <= 2 THEN true
      WHEN r.priority = 3 THEN v_remaining > 40
      ELSE v_remaining > 120
    END;

    IF v_send THEN
      v_remaining := v_remaining - 1;
      UPDATE notification_deliveries SET state = 'claimed' WHERE id = r.id;
      RETURN QUERY
        SELECT r.id, r.notification_id, r.user_id, r.type, r.payload, r.reason, r.priority,
               CASE WHEN p_channel = 'email' THEN u.email::text
                    ELSE c.address END,
               u.timezone, u.low_data_mode
          FROM users u
          LEFT JOIN notification_channels c
                 ON c.user_id = u.id AND c.channel = p_channel
         WHERE u.id = r.user_id;
    ELSIF r.deferrals >= 2 THEN
      -- §4: "Downgrade is visible, not silent."
      UPDATE notification_deliveries
         SET state = 'suppressed', error = 'budget: downgraded to in-app after 2 deferrals'
       WHERE id = r.id;

      -- §4: "This converts a capacity limit into the exact nudge that fixes it."
      INSERT INTO notifications (user_id, type, payload, reason, priority)
      VALUES (r.user_id, 'system',
              jsonb_build_object('kind','budget_downgrade','notification_id', r.notification_id,
                                 'downgraded_type', r.type),
              CASE WHEN r.type = 'digest'
                THEN 'Your digest is waiting — link Telegram to get it delivered.'
                ELSE 'We could not email this one today. Link Telegram and messages arrive straight away.'
              END, 5)
      RETURNING id INTO v_downgrade_id;

      INSERT INTO notification_deliveries (notification_id, channel, state, sent_at)
      VALUES (v_downgrade_id, 'in_app', 'sent', now());
    ELSE
      UPDATE notification_deliveries
         SET state = 'deferred',
             deferrals = deferrals + 1,
             scheduled_for = now() + interval '24 hours'
       WHERE id = r.id;
    END IF;
  END LOOP;

  -- Record exhaustion the moment it happens, for §4 rule 5's two-day test.
  IF v_remaining <= 0 THEN
    UPDATE send_budget SET exhausted_at = coalesce(exhausted_at, now())
     WHERE day = current_date AND channel = p_channel;
  END IF;
END
$$;

/**
 * Record what happened to a claimed delivery.
 *
 * §10: three consecutive Telegram failures mark the channel inactive and fall
 * back. A success resets the counter — a user who blocked and then unblocked the
 * bot should not carry the old strikes.
 */
CREATE OR REPLACE FUNCTION record_delivery_result(
  p_delivery_id uuid,
  p_ok boolean,
  p_error text DEFAULT NULL,
  p_permanent boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_channel notif_channel;
  v_user uuid;
  v_attempts smallint;
  v_failures smallint;
BEGIN
  SELECT d.channel, n.user_id, d.attempts INTO v_channel, v_user, v_attempts
    FROM notification_deliveries d
    JOIN notifications n ON n.id = d.notification_id
   WHERE d.id = p_delivery_id;

  IF v_channel IS NULL THEN RETURN; END IF;

  IF p_ok THEN
    UPDATE notification_deliveries
       SET state = 'sent', sent_at = now(), attempts = attempts + 1, error = NULL
     WHERE id = p_delivery_id;

    UPDATE send_budget SET sent = sent + 1
     WHERE day = current_date AND channel = v_channel;

    UPDATE notification_channels SET consecutive_failures = 0
     WHERE user_id = v_user AND channel = v_channel AND consecutive_failures > 0;
    RETURN;
  END IF;

  -- §10: retry with backoff, three attempts, then fail. A permanent error (the
  -- user blocked the bot, the address is invalid) skips the retries: repeating a
  -- request that cannot succeed only burns quota.
  UPDATE notification_deliveries
     SET attempts = attempts + 1,
         error = left(coalesce(p_error,'unknown'), 500),
         state = CASE WHEN p_permanent OR attempts + 1 >= 3 THEN 'failed' ELSE 'queued' END,
         scheduled_for = CASE
           WHEN p_permanent OR attempts + 1 >= 3 THEN scheduled_for
           -- 2 min, then 8 min.
           ELSE now() + make_interval(mins => 2 * power(4, attempts)::int)
         END
   WHERE id = p_delivery_id;

  IF v_channel = 'telegram' THEN
    UPDATE notification_channels
       SET consecutive_failures = consecutive_failures + 1
     WHERE user_id = v_user AND channel = 'telegram'
    RETURNING consecutive_failures INTO v_failures;

    IF v_failures IS NOT NULL AND v_failures >= 3 THEN
      UPDATE notification_channels SET is_active = false
       WHERE user_id = v_user AND channel = 'telegram';

      -- The user finds out in-app on their next visit, per §10's table.
      PERFORM enqueue_notification(
        v_user, 'system',
        'We could not reach you on Telegram three times, so pushes there are off.',
        jsonb_build_object('kind','telegram_inactive'));
    END IF;
  END IF;
END
$$;

/**
 * §4 rule 5: budget exhausted before 18:00 on two consecutive days.
 *
 * Returns the alert to raise, or nothing. Deliberately a query rather than a send:
 * the dispatcher owns the outbound call, and this owns the judgement.
 */
CREATE OR REPLACE FUNCTION budget_alert_due(p_channel notif_channel DEFAULT 'email')
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE v_days int;
BEGIN
  SELECT count(*) INTO v_days
    FROM send_budget
   WHERE channel = p_channel
     AND day >= current_date - 1
     AND exhausted_at IS NOT NULL
     AND extract(hour FROM exhausted_at) < 18;

  IF v_days >= 2 THEN
    RETURN format(
      'The %s budget has run out before 18:00 two days running. Telegram adoption is the fix (NOTIFICATIONS.md §4).',
      p_channel);
  END IF;
  RETURN NULL;
END
$$;

/**
 * Recover deliveries a crashed dispatcher left claimed.
 *
 * The visibility timeout is 20 minutes — longer than the 15-minute schedule, so a
 * run that is merely slow is never overtaken by the reaper, and short enough that
 * a crash costs one cycle rather than a day.
 */
CREATE OR REPLACE FUNCTION requeue_stale_claims()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n int;
BEGIN
  WITH stale AS (
    UPDATE notification_deliveries
       SET state = 'queued'
     WHERE state = 'claimed'
       AND scheduled_for < now() - interval '20 minutes'
    RETURNING 1
  )
  SELECT count(*)::int INTO n FROM stale;
  RETURN n;
END
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- enqueue_notification is reachable by a signed-in user because their own actions
-- create notifications for other people (a team request). It is SECURITY DEFINER
-- and validates the target account, and it cannot be used to write an arbitrary
-- row: type, priority and channels are all derived, not passed.
REVOKE ALL ON FUNCTION enqueue_notification(uuid, notif_type, text, jsonb, numeric, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION schedule_deadline_reminders() FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_deliveries(notif_channel, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_delivery_result(uuid, boolean, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION budget_alert_due(notif_channel) FROM PUBLIC;
REVOKE ALL ON FUNCTION requeue_stale_claims() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION enqueue_notification(uuid, notif_type, text, jsonb, numeric, boolean) TO authenticated;

-- claim_deliveries, record_delivery_result and schedule_deadline_reminders are
-- batch-tier only: they are reachable by the service role, which needs no grant,
-- and by nobody else.
