-- Notification behaviour tests. NOTIFICATIONS.md, and Phase 2's acceptance
-- criteria 3 and 4 in IMPLEMENTATION_PLAN.md §4:
--
--   "A Telegram-linked user receives a deadline reminder without any email
--    being sent."
--   "Email dispatcher respects the 280/day budget and defers by priority rather
--    than dropping."
--
-- Both are claims about behaviour, not about schema, so they are asserted by
-- driving the real functions and reading what they did. Everything runs inside one
-- transaction and rolls back.

\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION assert_eq(label text, actual anyelement, expected anyelement)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL  %: expected %, got %', label, expected, actual;
  END IF;
  RAISE NOTICE 'PASS  %', label;
END $$;

-- ── Fixtures ────────────────────────────────────────────────────────────────

INSERT INTO organisations (id, name, slug)
VALUES ('22222222-2222-2222-2222-222222222222', 'Notify Org', 'notify-org');

-- Deadlines are set relative to now() so the reminder windows are exercised as
-- the job would see them.
INSERT INTO opportunities
  (id, slug, title, category_id, organisation_id, status, last_verified_at, cost,
   source_url, deadline_at, starts_at)
VALUES
  ('33333333-3333-3333-3333-333333333331', 'notify-closing-soon', 'Closing in 36 hours',
   (SELECT id FROM categories WHERE code='grant'), '22222222-2222-2222-2222-222222222222',
   'published', now(), 'free', 'https://example.invalid/a', now() + interval '36 hours', NULL),
  ('33333333-3333-3333-3333-333333333332', 'notify-closing-week', 'Closing in 6 days',
   (SELECT id FROM categories WHERE code='grant'), '22222222-2222-2222-2222-222222222222',
   'published', now(), 'free', 'https://example.invalid/b', now() + interval '6 days', NULL);

-- Telegram-linked user, in a timezone where "now" is irrelevant to the assertions
-- that matter (quiet hours are tested directly, with an explicit instant).
INSERT INTO users (id, email, age_confirmed_18, timezone)
VALUES ('44444444-4444-4444-4444-444444444441', 'telegram-user@example.invalid', true, 'Africa/Harare');
INSERT INTO notification_channels (user_id, channel, address, verified_at)
VALUES ('44444444-4444-4444-4444-444444444441', 'telegram', 'chat-1', now());

-- Email-only user: no telegram channel at all.
INSERT INTO users (id, email, age_confirmed_18, timezone)
VALUES ('44444444-4444-4444-4444-444444444442', 'email-user@example.invalid', true, 'Africa/Lagos');

INSERT INTO tracker_entries (user_id, opportunity_id, state)
VALUES ('44444444-4444-4444-4444-444444444441', '33333333-3333-3333-3333-333333333331', 'saved'),
       ('44444444-4444-4444-4444-444444444441', '33333333-3333-3333-3333-333333333332', 'saved');

-- ── Phase 2 criterion 3: telegram reminder, no email ────────────────────────
-- The 36-hour deadline is inside the 2-day window for a `saved` item and is ≤48h,
-- so §3 offers telegram, email and in_app. The `[PR]` acceptance criterion is that
-- a Telegram-linked user gets the reminder "without any email being sent", so email
-- must be a fallback rather than a second copy. That is the assertion below, and it
-- is the whole reason enqueue_notification drops email when telegram is live.

SELECT schedule_deadline_reminders();

SELECT assert_eq(
  'a saved item closing in 36h produces exactly one reminder',
  (SELECT count(*)::int FROM notifications
    WHERE user_id = '44444444-4444-4444-4444-444444444441'
      AND type = 'deadline_reminder'
      AND payload->>'opportunity_id' = '33333333-3333-3333-3333-333333333331'),
  1);

SELECT assert_eq(
  'the reminder is pushed to telegram',
  (SELECT count(*)::int FROM notification_deliveries d
     JOIN notifications n ON n.id = d.notification_id
    WHERE n.user_id = '44444444-4444-4444-4444-444444444441'
      AND n.type = 'deadline_reminder' AND d.channel = 'telegram'
      AND n.payload->>'opportunity_id' = '33333333-3333-3333-3333-333333333331'),
  1);

SELECT assert_eq(
  'a telegram-linked user is reminded WITHOUT any email (Phase 2 criterion 3)',
  (SELECT count(*)::int FROM notification_deliveries d
     JOIN notifications n ON n.id = d.notification_id
    WHERE n.user_id = '44444444-4444-4444-4444-444444444441'
      AND n.type = 'deadline_reminder' AND d.channel = 'email'),
  0);

SELECT assert_eq(
  'the 7-day reminder never costs an email (NOTIFICATIONS.md §3)',
  (SELECT count(*)::int FROM notification_deliveries d
     JOIN notifications n ON n.id = d.notification_id
    WHERE n.user_id = '44444444-4444-4444-4444-444444444441'
      AND n.payload->>'opportunity_id' = '33333333-3333-3333-3333-333333333332'
      AND d.channel = 'email'),
  0);

SELECT assert_eq(
  'every notification is written in-app, always (NOTIFICATIONS.md §2)',
  (SELECT count(*)::int FROM notifications n
    WHERE n.user_id = '44444444-4444-4444-4444-444444444441'
      AND NOT EXISTS (SELECT 1 FROM notification_deliveries d
                       WHERE d.notification_id = n.id AND d.channel = 'in_app')),
  0);

-- The other half of "fallback": with no telegram link, the same reminder must go
-- out by email. A rule that only ever drops a channel would pass the criterion
-- above by delivering nothing.
INSERT INTO tracker_entries (user_id, opportunity_id, state)
VALUES ('44444444-4444-4444-4444-444444444442', '33333333-3333-3333-3333-333333333331', 'saved');
SELECT schedule_deadline_reminders();

SELECT assert_eq(
  'a user with no telegram link is emailed the 48h reminder instead',
  (SELECT count(*)::int FROM notification_deliveries d
     JOIN notifications n ON n.id = d.notification_id
    WHERE n.user_id = '44444444-4444-4444-4444-444444444442'
      AND n.type = 'deadline_reminder' AND d.channel = 'email'),
  1);

-- Idempotence. The job runs on a schedule and will see the same window again; a
-- second reminder for the same item would be exactly the noise §1.3 forbids.
SELECT schedule_deadline_reminders();
SELECT assert_eq(
  'running the reminder job twice does not remind twice',
  (SELECT count(*)::int FROM notifications
    WHERE user_id = '44444444-4444-4444-4444-444444444441' AND type = 'deadline_reminder'),
  (SELECT count(DISTINCT payload->>'key')::int FROM notifications
    WHERE user_id = '44444444-4444-4444-4444-444444444441' AND type = 'deadline_reminder'));

-- ── §6 `[PR]`: cancelled, not sent ──────────────────────────────────────────
-- A reminder for an item that has since been withdrawn must be suppressed at send
-- time. Re-checking at schedule time would not be enough: the state can change
-- while the message sits in the queue.

UPDATE tracker_entries SET state = 'withdrawn'
 WHERE user_id = '44444444-4444-4444-4444-444444444441'
   AND opportunity_id = '33333333-3333-3333-3333-333333333331';

-- Make the queued telegram delivery due.
UPDATE notification_deliveries d SET scheduled_for = now() - interval '1 minute'
  FROM notifications n
 WHERE n.id = d.notification_id AND d.channel = 'telegram'
   AND n.payload->>'opportunity_id' = '33333333-3333-3333-3333-333333333331';

CREATE TEMP TABLE claimed AS SELECT * FROM claim_deliveries('telegram', 50);

SELECT assert_eq(
  'a reminder for a withdrawn item is cancelled, not sent',
  (SELECT count(*)::int FROM claimed c
     JOIN notifications n ON n.id = c.notification_id
    WHERE n.payload->>'opportunity_id' = '33333333-3333-3333-3333-333333333331'),
  0);

SELECT assert_eq(
  'and it is recorded as suppressed rather than left to retry forever',
  (SELECT count(*)::int FROM notification_deliveries d
     JOIN notifications n ON n.id = d.notification_id
    WHERE n.payload->>'opportunity_id' = '33333333-3333-3333-3333-333333333331'
      AND d.channel = 'telegram' AND d.state = 'suppressed'),
  1);

-- ── Phase 2 criterion 4: the email budget defers by priority ────────────────
-- Remaining = 100: priority 3 sends (needs > 40), priority 5 defers (needs > 120).

INSERT INTO send_budget (day, channel, cap, sent)
VALUES (current_date, 'email', 280, 180)
ON CONFLICT (day, channel) DO UPDATE SET cap = 280, sent = 180;

-- Two email deliveries for the email-only user, one of each priority band.
WITH n3 AS (
  INSERT INTO notifications (user_id, type, payload, reason, priority)
  VALUES ('44444444-4444-4444-4444-444444444442', 'moderation_outcome', '{}',
          'You reported a listing and we acted on it.', 3)
  RETURNING id
), n5 AS (
  INSERT INTO notifications (user_id, type, payload, reason, priority)
  VALUES ('44444444-4444-4444-4444-444444444442', 'digest', '{}',
          'You asked for a weekly digest.', 5)
  RETURNING id
)
INSERT INTO notification_deliveries (notification_id, channel, scheduled_for)
SELECT id, 'email'::notif_channel, now() - interval '1 minute' FROM n3
UNION ALL
SELECT id, 'email'::notif_channel, now() - interval '1 minute' FROM n5;

CREATE TEMP TABLE claimed_email AS SELECT * FROM claim_deliveries('email', 50);

SELECT assert_eq(
  'priority 3 sends while 100 of the 280 remain',
  (SELECT count(*)::int FROM claimed_email WHERE priority = 3),
  1);

SELECT assert_eq(
  'priority 5 does not send while remaining is under 120',
  (SELECT count(*)::int FROM claimed_email WHERE priority = 5),
  0);

SELECT assert_eq(
  'and it is DEFERRED, not dropped',
  (SELECT d.state FROM notification_deliveries d
     JOIN notifications n ON n.id = d.notification_id
    WHERE n.user_id = '44444444-4444-4444-4444-444444444442' AND n.priority = 5),
  'deferred');

SELECT assert_eq(
  'the deferral is counted, so the 2-deferral limit can be reached',
  (SELECT d.deferrals::int FROM notification_deliveries d
     JOIN notifications n ON n.id = d.notification_id
    WHERE n.user_id = '44444444-4444-4444-4444-444444444442' AND n.priority = 5),
  1);

-- Third look, after two deferrals: downgrade to in-app, visibly.
UPDATE notification_deliveries d SET deferrals = 2, scheduled_for = now() - interval '1 minute'
  FROM notifications n
 WHERE n.id = d.notification_id AND n.user_id = '44444444-4444-4444-4444-444444444442'
   AND n.priority = 5;

SELECT count(*) FROM claim_deliveries('email', 50);

SELECT assert_eq(
  'after two deferrals the digest is suppressed',
  (SELECT d.state FROM notification_deliveries d
     JOIN notifications n ON n.id = d.notification_id
    WHERE n.user_id = '44444444-4444-4444-4444-444444444442' AND n.priority = 5
      AND n.type = 'digest'),
  'suppressed');

SELECT assert_eq(
  'the downgrade is visible: an in-app notice explains it and names the fix',
  (SELECT count(*)::int FROM notifications
    WHERE user_id = '44444444-4444-4444-4444-444444444442'
      AND type = 'system' AND payload->>'kind' = 'budget_downgrade'),
  1);

-- Priority 1-2 must go out even with nothing left. §4: "send (always; if budget
-- exhausted, borrow from tomorrow and alert the operator)".
UPDATE send_budget SET sent = 280 WHERE day = current_date AND channel = 'email';

WITH n1 AS (
  INSERT INTO notifications (user_id, type, payload, reason, priority)
  VALUES ('44444444-4444-4444-4444-444444444442', 'security', '{}',
          'Your email address was changed.', 1)
  RETURNING id
)
INSERT INTO notification_deliveries (notification_id, channel, scheduled_for)
SELECT id, 'email'::notif_channel, now() - interval '1 minute' FROM n1;

SELECT assert_eq(
  'a priority 1 message is sent even with the budget exhausted',
  (SELECT count(*)::int FROM claim_deliveries('email', 50) WHERE priority = 1),
  1);

SELECT assert_eq(
  'exhaustion is timestamped so the two-day operator alert can fire',
  (SELECT exhausted_at IS NOT NULL FROM send_budget
    WHERE day = current_date AND channel = 'email'),
  true);

-- ── §1.2 caps: pushes are capped, records never are ─────────────────────────

DO $$
DECLARE i int;
BEGIN
  FOR i IN 1..5 LOOP
    PERFORM enqueue_notification(
      '44444444-4444-4444-4444-444444444441', 'opportunity_closed',
      'Something you saved has closed.', jsonb_build_object('n', i));
  END LOOP;
END $$;

SELECT assert_eq(
  'the push cap holds at 3 non-exempt messages a day (NOTIFICATIONS.md §1.2)',
  (SELECT count(*)::int FROM notification_deliveries d
     JOIN notifications n ON n.id = d.notification_id
    WHERE n.user_id = '44444444-4444-4444-4444-444444444441'
      AND n.type = 'opportunity_closed' AND d.channel <> 'in_app'),
  3);

SELECT assert_eq(
  'but nothing is lost: all five exist in-app (NOTIFICATIONS.md §2, §10)',
  (SELECT count(*)::int FROM notification_deliveries d
     JOIN notifications n ON n.id = d.notification_id
    WHERE n.user_id = '44444444-4444-4444-4444-444444444441'
      AND n.type = 'opportunity_closed' AND d.channel = 'in_app'),
  5);

-- A security message is never held back by the cap.
DO $$
DECLARE v_id uuid;
BEGIN
  v_id := enqueue_notification('44444444-4444-4444-4444-444444444441', 'security',
                               'A new device signed in to your account.');
  PERFORM assert_eq(
    'a security message is pushed even after the cap is spent',
    (SELECT count(*)::int FROM notification_deliveries
      WHERE notification_id = v_id AND channel = 'email'),
    1);
END $$;

-- ── §1.5 quiet hours ────────────────────────────────────────────────────────
-- Asserted against an explicit instant rather than now(), so the test does not
-- depend on what time CI happens to run.

SELECT assert_eq(
  'a 22:00 local send is held until 07:00 (default quiet hours)',
  to_char(notif_quiet_adjusted('44444444-4444-4444-4444-444444444441',
          '2026-09-14 20:00:00+00'::timestamptz)  -- 22:00 in Africa/Harare
          AT TIME ZONE 'Africa/Harare', 'YYYY-MM-DD HH24:MI'),
  '2026-09-15 07:00');

SELECT assert_eq(
  'a 03:00 local send is held until 07:00 the same morning',
  to_char(notif_quiet_adjusted('44444444-4444-4444-4444-444444444441',
          '2026-09-15 01:00:00+00'::timestamptz)  -- 03:00 in Africa/Harare
          AT TIME ZONE 'Africa/Harare', 'YYYY-MM-DD HH24:MI'),
  '2026-09-15 07:00');

SELECT assert_eq(
  'a midday send is not held at all',
  notif_quiet_adjusted('44444444-4444-4444-4444-444444444441',
    '2026-09-15 10:00:00+00'::timestamptz),
  '2026-09-15 10:00:00+00'::timestamptz);

-- ── §3: the digest takes ONE push channel ───────────────────────────────────

DO $$
DECLARE v_id uuid;
BEGIN
  v_id := enqueue_notification('44444444-4444-4444-4444-444444444441', 'digest',
                               'You asked for a weekly digest.');
  PERFORM assert_eq(
    'a telegram-linked user gets the digest on telegram, not by email',
    (SELECT string_agg(channel::text, ',' ORDER BY channel::text)
       FROM notification_deliveries WHERE notification_id = v_id),
    'in_app,telegram');

  v_id := enqueue_notification('44444444-4444-4444-4444-444444444442', 'digest',
                               'You asked for a weekly digest.');
  PERFORM assert_eq(
    'a user with no telegram link gets it by email',
    (SELECT string_agg(channel::text, ',' ORDER BY channel::text)
       FROM notification_deliveries WHERE notification_id = v_id),
    'email,in_app');
END $$;

-- ── §8 preferences and §9 unsubscribe ───────────────────────────────────────

INSERT INTO notification_preferences (user_id, type, channel, enabled)
VALUES ('44444444-4444-4444-4444-444444444442', 'security', 'email', false),
       ('44444444-4444-4444-4444-444444444442', 'moderation_outcome', 'email', false);

DO $$
DECLARE v_id uuid;
BEGIN
  v_id := enqueue_notification('44444444-4444-4444-4444-444444444442', 'moderation_outcome',
                               'We reviewed your report.');
  PERFORM assert_eq(
    'an opted-out type is not pushed',
    (SELECT count(*)::int FROM notification_deliveries
      WHERE notification_id = v_id AND channel = 'email'),
    0);

  v_id := enqueue_notification('44444444-4444-4444-4444-444444444442', 'security',
                               'Your email address was changed.');
  PERFORM assert_eq(
    'but security messages cannot be unsubscribed from (NOTIFICATIONS.md §9)',
    (SELECT count(*)::int FROM notification_deliveries
      WHERE notification_id = v_id AND channel = 'email'),
    1);
END $$;

-- ── §8 "pause everything for 30 days" ───────────────────────────────────────

INSERT INTO user_notification_settings (user_id, paused_until)
VALUES ('44444444-4444-4444-4444-444444444442', now() + interval '30 days')
ON CONFLICT (user_id) DO UPDATE SET paused_until = EXCLUDED.paused_until;

DO $$
DECLARE v_id uuid;
BEGIN
  v_id := enqueue_notification('44444444-4444-4444-4444-444444444442', 'opportunity_closed',
                               'Something you saved has closed.');
  PERFORM assert_eq(
    'a paused account receives no pushes',
    (SELECT count(*)::int FROM notification_deliveries
      WHERE notification_id = v_id AND channel <> 'in_app'),
    0);
  PERFORM assert_eq(
    'a paused account still gets in-app records',
    (SELECT count(*)::int FROM notification_deliveries
      WHERE notification_id = v_id AND channel = 'in_app'),
    1);
END $$;

-- ── §10: three telegram failures deactivate the channel ─────────────────────

DO $$
DECLARE v_notif uuid; v_delivery uuid; i int;
BEGIN
  FOR i IN 1..3 LOOP
    INSERT INTO notifications (user_id, type, payload, reason, priority)
    VALUES ('44444444-4444-4444-4444-444444444441', 'team_update', '{}', 'A team you are in changed.', 4)
    RETURNING id INTO v_notif;
    INSERT INTO notification_deliveries (notification_id, channel)
    VALUES (v_notif, 'telegram') RETURNING id INTO v_delivery;
    PERFORM record_delivery_result(v_delivery, false, 'Forbidden: bot was blocked by the user', true);
  END LOOP;
END $$;

SELECT assert_eq(
  'three consecutive telegram failures mark the channel inactive',
  (SELECT is_active FROM notification_channels
    WHERE user_id = '44444444-4444-4444-4444-444444444441' AND channel = 'telegram'),
  false);

-- ── A successful send spends exactly one unit of budget ─────────────────────

DO $$
DECLARE v_notif uuid; v_delivery uuid; v_before int; v_after int;
BEGIN
  SELECT sent INTO v_before FROM send_budget WHERE day = current_date AND channel = 'email';
  INSERT INTO notifications (user_id, type, payload, reason, priority)
  VALUES ('44444444-4444-4444-4444-444444444442', 'security', '{}', 'A new device signed in.', 1)
  RETURNING id INTO v_notif;
  INSERT INTO notification_deliveries (notification_id, channel)
  VALUES (v_notif, 'email') RETURNING id INTO v_delivery;
  PERFORM record_delivery_result(v_delivery, true);
  SELECT sent INTO v_after FROM send_budget WHERE day = current_date AND channel = 'email';
  PERFORM assert_eq('a sent email spends one unit of the daily budget', v_after - v_before, 1);
END $$;

-- ── A crashed dispatcher's claims come back ─────────────────────────────────

DO $$
DECLARE v_notif uuid; v_delivery uuid;
BEGIN
  INSERT INTO notifications (user_id, type, payload, reason, priority)
  VALUES ('44444444-4444-4444-4444-444444444441', 'system', '{}', 'Test.', 5)
  RETURNING id INTO v_notif;
  INSERT INTO notification_deliveries (notification_id, channel, state, scheduled_for)
  VALUES (v_notif, 'telegram', 'claimed', now() - interval '1 hour') RETURNING id INTO v_delivery;

  PERFORM requeue_stale_claims();
  PERFORM assert_eq(
    'a claim left behind by a crashed dispatcher is requeued, not lost',
    (SELECT state FROM notification_deliveries WHERE id = v_delivery),
    'queued');
END $$;

ROLLBACK;
