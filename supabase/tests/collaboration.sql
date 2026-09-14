-- Intent, team rooms, requests, threads, handoff and blocking.
--
-- TEAM_FORMATION.md, COLLABORATION_SYSTEM.md, and Phase 5's acceptance criteria in
-- IMPLEMENTATION_PLAN.md §7 — all five of which are `[PR]`:
--
--   "A room below its floor is NEVER RENDERED — the route returns the opportunity page
--    with a single CTA."
--   "Intent count is hidden entirely below 5."
--   "No endpoint returns another user's contact details at any point before mutual
--    handoff consent."
--   "max_size is validated against the opportunity's own team-size rule."
--   "Rate limits enforced and visible to the user before composing."
--
-- The third is the one to read carefully. It is not "the UI does not show contact
-- details"; it is that no endpoint returns them. So the test below tries to read them
-- directly, as the authorised participant, before consent — the attack a UI check would
-- not catch.

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

CREATE OR REPLACE FUNCTION assert_raises(label text, stmt text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'PASS  % (refused: %)', label, left(SQLERRM, 90);
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL  %: the statement was ACCEPTED but must be refused', label;
END $$;

-- ── Fixtures ────────────────────────────────────────────────────────────────

INSERT INTO organisations (id, name, slug)
VALUES ('c0000000-0000-0000-0000-000000000001', 'Collab Org', 'collab-org');

-- Teams of 2 to 4, per the opportunity's own rule. §4.1 `[PR]` makes that rule binding on
-- the collaboration feature, which is the coupling this fixture exists to test.
INSERT INTO opportunities
  (id, slug, title, category_id, organisation_id, status, verification, last_verified_at,
   cost, source_url, deadline_at, deadline_precision, published_at, eligibility_scope,
   eligible_countries, link_ok, team_required, team_size_min, team_size_max)
VALUES
  ('c1000000-0000-0000-0000-000000000001', 'collab-hack', 'A hackathon with team rules',
   (SELECT id FROM categories WHERE code='hackathon'), 'c0000000-0000-0000-0000-000000000001',
   'published', 'verified', now(), 'free', 'https://collab.example/hack',
   now() + interval '30 days', 'date_only', now(), 'africa_wide', ARRAY[]::char(2)[], true,
   true, 2, 4);

INSERT INTO users (id, email, age_confirmed_18, timezone, display_name) VALUES
  ('c2000000-0000-0000-0000-000000000001', 'owner@example.invalid', true, 'Africa/Harare', 'Team Owner'),
  ('c2000000-0000-0000-0000-000000000002', 'joiner@example.invalid', true, 'Africa/Lagos', 'Joiner'),
  ('c2000000-0000-0000-0000-000000000003', 'third@example.invalid', true, 'Africa/Nairobi', 'Third'),
  ('c2000000-0000-0000-0000-000000000004', 'fourth@example.invalid', true, 'Africa/Accra', 'Fourth'),
  ('c2000000-0000-0000-0000-000000000005', 'minor@example.invalid', false, 'Africa/Harare', 'Unconfirmed'),
  ('c2000000-0000-0000-0000-000000000006', 'restricted@example.invalid', true, 'Africa/Harare', 'Restricted');

UPDATE users SET account_state = 'restricted' WHERE id = 'c2000000-0000-0000-0000-000000000006';

-- ── §2.2 intent rules ───────────────────────────────────────────────────────

INSERT INTO intents (user_id, opportunity_id, stance, roles_offered, note)
VALUES ('c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001',
        'have_team_looking_for_roles', ARRAY['backend'], 'Building an irrigation monitor.');

SELECT assert_eq(
  'intent expires at the opportunity''s deadline, set server-side (§2.2 [PR])',
  (SELECT date_trunc('minute', i.expires_at) = date_trunc('minute', o.deadline_at)
     FROM intents i JOIN opportunities o ON o.id = i.opportunity_id
    WHERE i.user_id = 'c2000000-0000-0000-0000-000000000001'),
  true);

-- "Intent is never permanent." A write path cannot choose its own expiry.
UPDATE intents SET expires_at = now() + interval '100 years'
 WHERE user_id = 'c2000000-0000-0000-0000-000000000001';
SELECT assert_eq(
  'a caller cannot set a longer expiry — the trigger overwrites it',
  (SELECT expires_at < now() + interval '60 days' FROM intents
    WHERE user_id = 'c2000000-0000-0000-0000-000000000001'),
  true);

SELECT assert_raises(
  'an account without the 18+ confirmation cannot declare intent (§2.2)',
  $q$INSERT INTO intents (user_id, opportunity_id, stance)
     VALUES ('c2000000-0000-0000-0000-000000000005','c1000000-0000-0000-0000-000000000001','just_interested')$q$);

SELECT assert_raises(
  'a restricted account cannot declare intent (§2.2)',
  $q$INSERT INTO intents (user_id, opportunity_id, stance)
     VALUES ('c2000000-0000-0000-0000-000000000006','c1000000-0000-0000-0000-000000000001','just_interested')$q$);

SELECT assert_raises(
  'one intent per user per opportunity',
  $q$INSERT INTO intents (user_id, opportunity_id, stance)
     VALUES ('c2000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','going_solo')$q$);

SELECT assert_raises(
  'a note longer than 300 characters is refused',
  format($q$INSERT INTO intents (user_id, opportunity_id, stance, note)
            VALUES ('c2000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000001','going_solo','%s')$q$,
         repeat('x', 301)));

-- ── §2.3 the intent count floor ─────────────────────────────────────────────

SELECT assert_eq(
  'the intent count is NULL while the flag is off, whatever the count',
  intent_count_public('c1000000-0000-0000-0000-000000000001'),
  NULL::int);

-- Turn the flag on, as an operator would, and the FLOOR still applies. Both conditions,
-- never either (PRODUCT_SPEC.md §24).
UPDATE feature_flags SET enabled = true WHERE key = 'intent_count_visible';

SELECT assert_eq(
  'with the flag on and 1 intent, the count is still hidden — not 1, not 0 (§2.3 [PR])',
  intent_count_public('c1000000-0000-0000-0000-000000000001'),
  NULL::int);

INSERT INTO intents (user_id, opportunity_id, stance) VALUES
  ('c2000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000001','looking_for_team'),
  ('c2000000-0000-0000-0000-000000000003','c1000000-0000-0000-0000-000000000001','looking_for_team'),
  ('c2000000-0000-0000-0000-000000000004','c1000000-0000-0000-0000-000000000001','just_interested');

SELECT assert_eq(
  'at 4 intents it is STILL hidden — showing a low number is worse than showing nothing',
  intent_count_public('c1000000-0000-0000-0000-000000000001'),
  NULL::int);

INSERT INTO users (id, email, age_confirmed_18) VALUES
  ('c2000000-0000-0000-0000-000000000007','fifth@example.invalid', true);
INSERT INTO intents (user_id, opportunity_id, stance)
VALUES ('c2000000-0000-0000-0000-000000000007','c1000000-0000-0000-0000-000000000001','going_solo');

SELECT assert_eq('at 5 the count appears', intent_count_public('c1000000-0000-0000-0000-000000000001'), 5);

-- A withdrawn intent stops counting immediately. §2.2: "Withdrawable at any time,
-- immediately and completely."
UPDATE intents SET withdrawn_at = now() WHERE user_id = 'c2000000-0000-0000-0000-000000000007';
SELECT assert_eq(
  'withdrawing drops the count back below the floor and hides it again',
  intent_count_public('c1000000-0000-0000-0000-000000000001'),
  NULL::int);
UPDATE intents SET withdrawn_at = NULL WHERE user_id = 'c2000000-0000-0000-0000-000000000007';

-- ── §3.1 the room floor ─────────────────────────────────────────────────────

SELECT assert_eq(
  'the room is DISABLED while its flag is off, whatever the intent count',
  (SELECT state FROM room_state('c1000000-0000-0000-0000-000000000001')),
  'disabled');

UPDATE feature_flags SET enabled = true WHERE key = 'team_room_entry';

SELECT assert_eq(
  'with 5 intents the room opens',
  (SELECT state FROM room_state('c1000000-0000-0000-0000-000000000001')),
  'open');

-- Below the floor it is not "empty" — it is a different state with its own CTA.
INSERT INTO opportunities
  (id, slug, title, category_id, organisation_id, status, verification, last_verified_at,
   cost, source_url, deadline_at, published_at, eligibility_scope, link_ok)
VALUES ('c1000000-0000-0000-0000-000000000002', 'collab-quiet', 'Nobody has said anything yet',
   (SELECT id FROM categories WHERE code='grant'), 'c0000000-0000-0000-0000-000000000001',
   'published', 'verified', now(), 'free', 'https://collab.example/quiet',
   now() + interval '30 days', now(), 'africa_wide', true);

SELECT assert_eq(
  'a room with no intents is BELOW FLOOR, not empty (§3.1, Phase 5 criterion 1 [PR])',
  (SELECT state FROM room_state('c1000000-0000-0000-0000-000000000002')),
  'below_floor');
SELECT assert_eq(
  'and it carries the CTA the opportunity page should show instead',
  (SELECT reason FROM room_state('c1000000-0000-0000-0000-000000000002')),
  'Be the first to say you''re going for this');

-- §3.3: a closed opportunity archives its room, read-only. Nothing is deleted.
UPDATE opportunities SET status = 'expired' WHERE id = 'c1000000-0000-0000-0000-000000000002';
SELECT assert_eq(
  'a closed opportunity''s room is archived, not absent',
  (SELECT state FROM room_state('c1000000-0000-0000-0000-000000000002')),
  'archived');
UPDATE opportunities SET status = 'published' WHERE id = 'c1000000-0000-0000-0000-000000000002';

-- ── §4.1 max_size against the opportunity's own rule ────────────────────────

SELECT assert_raises(
  'a team larger than the opportunity allows is refused (§4.1 [PR], criterion 4)',
  $q$INSERT INTO teams (opportunity_id, owner_user_id, name, max_size)
     VALUES ('c1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','Too Big',6)$q$);

SELECT assert_raises(
  'a maximum below the opportunity''s minimum is refused too',
  $q$INSERT INTO teams (opportunity_id, owner_user_id, name, max_size)
     VALUES ('c1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','Too Small',1)$q$);

SELECT assert_raises(
  'a team from someone with no intent on the opportunity is refused (§4.1)',
  $q$INSERT INTO teams (opportunity_id, owner_user_id, name, max_size)
     VALUES ('c1000000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000001','No Intent Here',3)$q$);

INSERT INTO teams (id, opportunity_id, owner_user_id, name, pitch, roles_needed, max_size, state)
VALUES ('c3000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',
        'c2000000-0000-0000-0000-000000000001','Irrigation Crew',
        'Monitoring soil moisture with cheap sensors.', ARRAY['frontend','data'], 3, 'open_for_roles');

SELECT assert_eq(
  'the owner is a member from the moment the team exists (§4.3)',
  (SELECT count(*)::int FROM team_members WHERE team_id = 'c3000000-0000-0000-0000-000000000001'),
  1);

SELECT assert_raises(
  'one team per opportunity per owner (§4.1)',
  $q$INSERT INTO teams (opportunity_id, owner_user_id, name, max_size)
     VALUES ('c1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','Second Team',3)$q$);

-- §4.2's auto-transition: reaching max_size makes a team full.
INSERT INTO team_members (team_id, user_id) VALUES
  ('c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000003'),
  ('c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000004');
SELECT assert_eq(
  'reaching max_size transitions the team to full automatically (§4.2)',
  (SELECT state::text FROM teams WHERE id = 'c3000000-0000-0000-0000-000000000001'),
  'full');

DELETE FROM team_members
 WHERE team_id = 'c3000000-0000-0000-0000-000000000001'
   AND user_id = 'c2000000-0000-0000-0000-000000000004';
SELECT assert_eq(
  'losing a member reopens it — a full team with a free seat nobody can request is worse',
  (SELECT state::text FROM teams WHERE id = 'c3000000-0000-0000-0000-000000000001'),
  'open_for_roles');

-- ── §5.2 rate limits ────────────────────────────────────────────────────────

INSERT INTO collaboration_requests
  (context, team_id, requester_user_id, target_user_id, role, message)
VALUES ('team_request','c3000000-0000-0000-0000-000000000001',
        'c2000000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000001',
        'frontend','I build interfaces for low-end Android and would like to help.');

-- §2.3 has two branches and they need separating. This opportunity closes in 30 days, so
-- `deadline - 72 hours` is 27 days out and the 14-day cap is the binding one. now() is
-- transaction-stable in Postgres, so expires_at is EXACTLY now() + 14 days here — a strict
-- `<` would fail against correct code, which is how this assertion was first written.
SELECT assert_eq(
  'against a far deadline a request expires at the 14-day cap (§2.3)',
  (SELECT expires_at = now() + interval '14 days' FROM collaboration_requests
    WHERE requester_user_id = 'c2000000-0000-0000-0000-000000000002'),
  true);

-- The other branch, which is the half worth proving: a deadline near enough that 72 hours
-- before it comes first. Without a fixture like this the rule could be `now() + 14 days`
-- unconditionally and the suite would not notice.
INSERT INTO opportunities
  (id, slug, title, category_id, organisation_id, status, verification, last_verified_at,
   cost, source_url, deadline_at, deadline_precision, published_at, eligibility_scope,
   eligible_countries, link_ok)
VALUES
  ('c1000000-0000-0000-0000-000000000003', 'collab-soon', 'Closing in five days',
   (SELECT id FROM categories WHERE code='hackathon'), 'c0000000-0000-0000-0000-000000000001',
   'published', 'verified', now(), 'free', 'https://collab.example/soon',
   now() + interval '5 days', 'date_only', now(), 'africa_wide', ARRAY[]::char(2)[], true);

INSERT INTO collaboration_requests
  (context, opportunity_id, requester_user_id, target_user_id, message)
VALUES ('opportunity_intent','c1000000-0000-0000-0000-000000000003',
        'c2000000-0000-0000-0000-000000000004','c2000000-0000-0000-0000-000000000003',
        'I saw your intent on the five-day one and have a half-built prototype.');

SELECT assert_eq(
  'against a near deadline it expires 72 hours before it instead (§2.3)',
  (SELECT r.expires_at = o.deadline_at - interval '72 hours'
     FROM collaboration_requests r
     JOIN opportunities o ON o.id = r.opportunity_id
    WHERE r.requester_user_id = 'c2000000-0000-0000-0000-000000000004'),
  true);

-- §5.1: the target is told a request arrived. Without this the flow has a silent gap —
-- the request sits in a room nobody was told to open, and expires.
SELECT assert_eq(
  'a new request notifies the person it was sent to (§5.1)',
  (SELECT count(*)::int FROM notifications
    WHERE user_id = 'c2000000-0000-0000-0000-000000000001' AND type = 'request_received'),
  1);

SELECT assert_eq(
  'and the message carries no name and no quoted text of theirs',
  (SELECT bool_and(reason NOT ILIKE '%joiner%' AND payload::text NOT ILIKE '%interfaces%')
     FROM notifications
    WHERE user_id = 'c2000000-0000-0000-0000-000000000001' AND type = 'request_received'),
  true);

SELECT assert_raises(
  'one pending request per target and context (§2.4)',
  $q$INSERT INTO collaboration_requests (context, team_id, requester_user_id, target_user_id, message)
     VALUES ('team_request','c3000000-0000-0000-0000-000000000001',
             'c2000000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000001','Again')$q$);

SELECT assert_raises(
  'a request to yourself is refused',
  $q$INSERT INTO collaboration_requests (context, team_id, requester_user_id, target_user_id, message)
     VALUES ('team_request','c3000000-0000-0000-0000-000000000001',
             'c2000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','Hi me')$q$);

SELECT assert_raises(
  'a message longer than 500 characters is refused (§2.2)',
  format($q$INSERT INTO collaboration_requests (context, team_id, requester_user_id, target_user_id, message)
            VALUES ('team_request','c3000000-0000-0000-0000-000000000001',
                    'c2000000-0000-0000-0000-000000000003','c2000000-0000-0000-0000-000000000001','%s')$q$,
         repeat('x', 501)));

-- The hourly limit. §5.2: 3/hour.
DO $$
DECLARE i int;
BEGIN
  FOR i IN 1..2 LOOP
    INSERT INTO users (id, email, age_confirmed_18)
    VALUES (('c4000000-0000-0000-0000-00000000000' || i)::uuid,
            'target' || i || '@example.invalid', true);
    INSERT INTO collaboration_requests (context, opportunity_id, requester_user_id, target_user_id, message)
    VALUES ('opportunity_intent','c1000000-0000-0000-0000-000000000001',
            'c2000000-0000-0000-0000-000000000002',
            ('c4000000-0000-0000-0000-00000000000' || i)::uuid,
            'A distinct message number ' || i);
  END LOOP;
END $$;

INSERT INTO users (id, email, age_confirmed_18)
VALUES ('c4000000-0000-0000-0000-000000000009','target9@example.invalid', true);

SELECT assert_raises(
  'the fourth request in an hour is refused (§5.2 [PR]: 3/hour)',
  $q$INSERT INTO collaboration_requests (context, opportunity_id, requester_user_id, target_user_id, message)
     VALUES ('opportunity_intent','c1000000-0000-0000-0000-000000000001',
             'c2000000-0000-0000-0000-000000000002','c4000000-0000-0000-0000-000000000009','One more')$q$);

-- §5.3's copy-paste detection, the dominant spam vector on platforms of this shape.
DELETE FROM collaboration_requests WHERE requester_user_id = 'c2000000-0000-0000-0000-000000000002';

DO $$
DECLARE i int;
BEGIN
  FOR i IN 1..3 LOOP
    INSERT INTO users (id, email, age_confirmed_18)
    VALUES (('c5000000-0000-0000-0000-00000000000' || i)::uuid,
            'spamtarget' || i || '@example.invalid', true);
  END LOOP;
END $$;

-- Three identical messages are allowed; the fourth identical one is not. Sent from
-- different accounts to stay inside the per-sender hourly limit, which is a different rule.
INSERT INTO collaboration_requests (context, opportunity_id, requester_user_id, target_user_id, message)
VALUES ('opportunity_intent','c1000000-0000-0000-0000-000000000001',
        'c2000000-0000-0000-0000-000000000003','c5000000-0000-0000-0000-000000000001','hi lets team up'),
       ('opportunity_intent','c1000000-0000-0000-0000-000000000001',
        'c2000000-0000-0000-0000-000000000003','c5000000-0000-0000-0000-000000000002','hi lets team up'),
       ('opportunity_intent','c1000000-0000-0000-0000-000000000001',
        'c2000000-0000-0000-0000-000000000003','c5000000-0000-0000-0000-000000000003','hi lets team up');

SELECT assert_raises(
  'the same message to a fourth person within the hour is refused (§5.3)',
  $q$INSERT INTO collaboration_requests (context, opportunity_id, requester_user_id, target_user_id, message)
     VALUES ('opportunity_intent','c1000000-0000-0000-0000-000000000001',
             'c2000000-0000-0000-0000-000000000003','c4000000-0000-0000-0000-000000000009','HI LETS TEAM UP')$q$);

SELECT assert_eq(
  'the message text is stored as a digest for that check, not as a searchable corpus',
  (SELECT count(*)::int FROM collaboration_requests
    WHERE requester_user_id = 'c2000000-0000-0000-0000-000000000003'
      AND message_digest IS NOT NULL),
  3);

-- ── §4 blocking is absolute ─────────────────────────────────────────────────

INSERT INTO collaboration_requests
  (id, context, team_id, requester_user_id, target_user_id, message)
VALUES ('c6000000-0000-0000-0000-000000000001','team_request','c3000000-0000-0000-0000-000000000001',
        'c2000000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000001',
        'Would like to join your team.');

INSERT INTO blocks (blocker_user_id, blocked_user_id)
VALUES ('c2000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002');

SELECT assert_eq(
  'blocking cancels the pending request in the same transaction (§4)',
  (SELECT state::text FROM collaboration_requests WHERE id = 'c6000000-0000-0000-0000-000000000001'),
  'withdrawn');

SELECT assert_raises(
  'a blocked user cannot send a new request',
  $q$INSERT INTO collaboration_requests (context, team_id, requester_user_id, target_user_id, message)
     VALUES ('team_request','c3000000-0000-0000-0000-000000000001',
             'c2000000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000001','Please?')$q$);

SELECT assert_raises(
  'and neither can the blocker, in the other direction — blocking is symmetric in effect',
  $q$INSERT INTO collaboration_requests (context, team_id, requester_user_id, target_user_id, message)
     VALUES ('team_request','c3000000-0000-0000-0000-000000000001',
             'c2000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002','Actually')$q$);

DELETE FROM blocks WHERE blocker_user_id = 'c2000000-0000-0000-0000-000000000001';

-- ── §5.2 / §3.1 no contact details before consent ───────────────────────────

INSERT INTO collaboration_requests
  (id, context, team_id, requester_user_id, target_user_id, role, message)
VALUES ('c6000000-0000-0000-0000-000000000002','team_request','c3000000-0000-0000-0000-000000000001',
        'c2000000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000001',
        'frontend','Second attempt, now that the block is gone.');

SELECT assert_eq(
  'a pending request opens no thread — §3.1 [PR]: only on acceptance',
  (SELECT count(*)::int FROM threads WHERE request_id = 'c6000000-0000-0000-0000-000000000002'),
  0);

SET LOCAL request.jwt.claim.sub = 'c2000000-0000-0000-0000-000000000001';

DO $$
DECLARE v_thread uuid; v_count int;
BEGIN
  v_thread := accept_request('c6000000-0000-0000-0000-000000000002');

  PERFORM assert_eq('accepting opens exactly one thread', v_thread IS NOT NULL, true);
  PERFORM assert_eq(
    'and adds the requester to the team',
    (SELECT count(*)::int FROM team_members
      WHERE team_id = 'c3000000-0000-0000-0000-000000000001'
        AND user_id = 'c2000000-0000-0000-0000-000000000002'),
    1);
  PERFORM assert_eq(
    'and tells the requester (§5.1)',
    (SELECT count(*)::int FROM notifications
      WHERE user_id = 'c2000000-0000-0000-0000-000000000002' AND type = 'request_accepted'),
    1);

  -- §3.3's consent gate, tested from INSIDE the thread as an authorised participant.
  -- This is the attack a UI check would miss.
  INSERT INTO handoff_proposals (thread_id, proposer_user_id, channel, proposer_identifier)
  VALUES (v_thread, 'c2000000-0000-0000-0000-000000000001', 'telegram', '@teamowner');

  SELECT count(*)::int INTO v_count FROM handoff_identifiers(v_thread);
  PERFORM assert_eq(
    'a PROPOSED handoff releases nothing — no contact detail before consent (criterion 3 [PR])',
    v_count, 0);

  -- The other side accepts, supplying their own. Both, or neither.
  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000002', true);
  PERFORM assert_eq(
    'the other participant can accept',
    accept_handoff((SELECT id FROM handoff_proposals WHERE thread_id = v_thread), '@joiner'),
    true);

  SELECT count(*)::int INTO v_count FROM handoff_identifiers(v_thread);
  PERFORM assert_eq('after mutual consent, exactly one channel is released', v_count, 1);

  PERFORM assert_eq(
    'and each side gets the OTHER person''s identifier, not their own',
    (SELECT their_identifier FROM handoff_identifiers(v_thread)),
    '@teamowner');

  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000001', true);
  PERFORM assert_eq(
    'and the proposer gets the accepter''s',
    (SELECT their_identifier FROM handoff_identifiers(v_thread)),
    '@joiner');

  -- A third party in neither side of the thread gets nothing.
  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000003', true);
  SELECT count(*)::int INTO v_count FROM handoff_identifiers(v_thread);
  PERFORM assert_eq('someone outside the thread gets nothing at all', v_count, 0);

  PERFORM set_config('request.jwt.claim.sub', NULL, true);
  SELECT count(*)::int INTO v_count FROM handoff_identifiers(v_thread);
  PERFORM assert_eq('an anonymous caller gets nothing', v_count, 0);
END $$;

RESET request.jwt.claim.sub;

-- §5.1 decline: no reason taken, and no re-request for 7 days.
SET LOCAL request.jwt.claim.sub = 'c2000000-0000-0000-0000-000000000001';

INSERT INTO collaboration_requests
  (id, context, opportunity_id, requester_user_id, target_user_id, message)
VALUES ('c6000000-0000-0000-0000-000000000003','opportunity_intent','c1000000-0000-0000-0000-000000000001',
        'c2000000-0000-0000-0000-000000000004','c2000000-0000-0000-0000-000000000001','Want to team up?');

SELECT assert_eq('declining works', decline_request('c6000000-0000-0000-0000-000000000003'), true);
SELECT assert_eq(
  'the requester is told (§5.1)',
  (SELECT count(*)::int FROM notifications
    WHERE user_id = 'c2000000-0000-0000-0000-000000000004' AND type = 'request_declined'),
  1);
SELECT assert_eq(
  'no reason is stored, because no reason is taken (§2.5)',
  (SELECT count(*)::int FROM information_schema.columns
    WHERE table_name = 'collaboration_requests' AND column_name IN ('decline_reason','reason')),
  0);

RESET request.jwt.claim.sub;

SELECT assert_raises(
  'no re-request to the same target and context for 7 days (§2.5)',
  $q$INSERT INTO collaboration_requests (context, opportunity_id, requester_user_id, target_user_id, message)
     VALUES ('opportunity_intent','c1000000-0000-0000-0000-000000000001',
             'c2000000-0000-0000-0000-000000000004','c2000000-0000-0000-0000-000000000001','Please reconsider')$q$);

-- ── The tables that deliberately do not exist ───────────────────────────────
--
-- TEAM_FORMATION.md §3.2 `[PR]` lists what is NOT in a room: chat, feed, activity stream,
-- likes, follower counts, online indicators, profile-view counts. A table is where a
-- feature starts, so their absence is asserted rather than assumed.

SELECT assert_eq(
  'no table exists for the surfaces §3.2 forbids',
  (SELECT count(*)::int FROM pg_tables
    WHERE schemaname = 'public'
      AND (tablename LIKE '%follow%' OR tablename LIKE '%like%' OR tablename LIKE '%feed%'
           OR tablename LIKE '%activity%' OR tablename LIKE '%presence%'
           OR tablename LIKE '%profile_view%')),
  0);

SELECT assert_eq(
  'and no column counts followers or views on a person',
  (SELECT count(*)::int FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (column_name LIKE '%follower%' OR column_name LIKE '%like_count%'
           OR column_name = 'profile_views' OR column_name = 'is_online')),
  0);

-- ── Migration 0017: what the pages read, and the limits they show ───────────
--
-- IMPLEMENTATION_PLAN.md §7's fifth `[PR]` criterion is "rate limits enforced and visible
-- to the user before composing". Two code paths, one rule — so the strongest available
-- assertion is that the sentence the compose page would show is character-for-character the
-- sentence the INSERT raises. That is asserted below by catching the exception and
-- comparing it to the function's own blocked_reason.

-- A requester with a clean sheet: the page can say what is left before anything is typed.
DO $$
DECLARE a record;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000005', true);
  SELECT * INTO a FROM request_allowance_for('c2000000-0000-0000-0000-000000000005');
  PERFORM assert_eq('the daily limit is 10 (§2.4 [PR])', a.day_limit, 10);
  PERFORM assert_eq('the hourly limit is 3', a.hour_limit, 3);
  PERFORM assert_eq('and 5 may be pending at once', a.pending_limit, 5);
  PERFORM assert_eq('nothing blocks a requester who has sent nothing', a.blocked_reason, NULL::text);
  PERFORM set_config('request.jwt.claim.sub', NULL, true);
END $$;

-- request_allowance() is the callable half: it reports on the CALLER and on nobody else, so
-- a signed-in user cannot use it to learn how much someone else has been asking around.
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', NULL, true);
  SELECT count(*)::int INTO n FROM request_allowance();
  PERFORM assert_eq('an anonymous caller gets no allowance row at all', n, 0);
END $$;

-- The one that matters. Three sent this hour, then the fourth is refused — and the refusal
-- text is the text the form was already showing.
DO $$
DECLARE
  a record;
  v_message text;
  i int;
BEGIN
  INSERT INTO users (id, email, age_confirmed_18)
  VALUES ('c7000000-0000-0000-0000-000000000001','allowance@example.invalid', true);

  FOR i IN 1..3 LOOP
    INSERT INTO users (id, email, age_confirmed_18)
    VALUES (('c7000000-0000-0000-0000-00000000001' || i)::uuid,
            'allowance-target' || i || '@example.invalid', true);
    INSERT INTO collaboration_requests (context, opportunity_id, requester_user_id, target_user_id, message)
    VALUES ('opportunity_intent','c1000000-0000-0000-0000-000000000001',
            'c7000000-0000-0000-0000-000000000001',
            ('c7000000-0000-0000-0000-00000000001' || i)::uuid,
            'A distinct note for person number ' || i);
  END LOOP;

  SELECT * INTO a FROM request_allowance_for('c7000000-0000-0000-0000-000000000001');
  PERFORM assert_eq('three sent counts as three used', a.hour_used, 3);
  PERFORM assert_eq('and the page is told why it cannot offer the form',
                    a.blocked_reason IS NOT NULL, true);
  PERFORM assert_eq('with a time the next slot opens, not just a refusal',
                    a.next_slot_at > now(), true);

  INSERT INTO users (id, email, age_confirmed_18)
  VALUES ('c7000000-0000-0000-0000-000000000099','allowance-target9@example.invalid', true);

  BEGIN
    INSERT INTO collaboration_requests (context, opportunity_id, requester_user_id, target_user_id, message)
    VALUES ('opportunity_intent','c1000000-0000-0000-0000-000000000001',
            'c7000000-0000-0000-0000-000000000001',
            'c7000000-0000-0000-0000-000000000099','One more, which must not be accepted');
    RAISE EXCEPTION 'FAIL  the fourth request in an hour was ACCEPTED';
  EXCEPTION WHEN others THEN
    v_message := SQLERRM;
  END;

  PERFORM assert_eq(
    'the limit the page SHOWS and the limit the database ENFORCES are the same sentence (criterion 5 [PR])',
    v_message, a.blocked_reason);
END $$;

-- ── The room, as a page reads it ────────────────────────────────────────────

-- Fixtures: countries and headlines, so the five permitted fields have values to leak.
INSERT INTO profiles (user_id, visibility, headline, country_iso2) VALUES
  ('c2000000-0000-0000-0000-000000000001','private','Builds irrigation sensors','ZW'),
  ('c2000000-0000-0000-0000-000000000002','private','Front-end for low-end Android','NG'),
  ('c2000000-0000-0000-0000-000000000003','private','Data and dashboards','KE');

SELECT assert_eq(
  'a viewer with no intent on this opportunity sees no builders — §2.2: only inside the room',
  (SELECT count(*)::int FROM room_builders('c1000000-0000-0000-0000-000000000001')),
  0);

-- §2.1: `going_solo` and `just_interested` are "counted only". Only the two team-seeking
-- stances are listed, and this fixture set contains both kinds.
DO $$
DECLARE n int; r record;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000001', true);

  SELECT count(*)::int INTO n FROM room_builders('c1000000-0000-0000-0000-000000000001');
  PERFORM assert_eq('a co-present viewer sees the builders looking for a team', n > 0, true);

  PERFORM assert_eq(
    'and nobody who is only watching or going alone is listed (§2.1)',
    (SELECT count(*)::int FROM room_builders('c1000000-0000-0000-0000-000000000001')
      WHERE stance NOT IN ('looking_for_team','have_team_looking_for_roles')),
    0);

  PERFORM assert_eq(
    'the viewer is not listed to themselves',
    (SELECT count(*)::int FROM room_builders('c1000000-0000-0000-0000-000000000001')
      WHERE user_id = 'c2000000-0000-0000-0000-000000000001'),
    0);

  SELECT * INTO r FROM room_builders('c1000000-0000-0000-0000-000000000001')
   WHERE user_id = 'c2000000-0000-0000-0000-000000000002';
  PERFORM assert_eq('a builder card carries the country §2.2 permits', r.country_iso2, 'NG'::char(2));
  PERFORM assert_eq('and the headline', r.headline, 'Front-end for low-end Android');

  PERFORM set_config('request.jwt.claim.sub', NULL, true);
END $$;

-- §2.2 `[PR]`: "It exposes: display name, country, headline, roles offered and the note.
-- Nothing else, ever." Asserted against the function's RESULT TYPE, so adding an email or a
-- handle to the room card fails here rather than in review.
DO $$
DECLARE cols text;
BEGIN
  SELECT pg_get_function_result(p.oid) INTO cols
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'room_builders';

  IF cols IS NULL THEN
    RAISE EXCEPTION 'FAIL  room_builders not found — the assertion is vacuous';
  END IF;
  IF cols ~* '(email|handle|last_seen|phone|telegram|view_count|birth|age)' THEN
    RAISE EXCEPTION 'FAIL  room_builders returns more than §2.2 permits: %', cols;
  END IF;
  RAISE NOTICE 'PASS  a builder card can return nothing beyond the five fields §2.2 permits';
END $$;

-- §4: a block removes the person from the shared surface, in both directions, silently.
DO $$
BEGIN
  INSERT INTO blocks (blocker_user_id, blocked_user_id)
  VALUES ('c2000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000003');

  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000001', true);
  PERFORM assert_eq(
    'a blocked builder is gone from the blocker''s room (§4)',
    (SELECT count(*)::int FROM room_builders('c1000000-0000-0000-0000-000000000001')
      WHERE user_id = 'c2000000-0000-0000-0000-000000000003'),
    0);

  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000003', true);
  PERFORM assert_eq(
    'and the blocker is gone from theirs — absence, never an explanation',
    (SELECT count(*)::int FROM room_builders('c1000000-0000-0000-0000-000000000001')
      WHERE user_id = 'c2000000-0000-0000-0000-000000000001'),
    0);

  PERFORM set_config('request.jwt.claim.sub', NULL, true);
  DELETE FROM blocks WHERE blocker_user_id = 'c2000000-0000-0000-0000-000000000001'
                       AND blocked_user_id = 'c2000000-0000-0000-0000-000000000003';
END $$;

-- Team cards: §3.2 item 2's fields, and §4.2's staleness.
DO $$
DECLARE t record;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000003', true);

  SELECT * INTO t FROM room_teams('c1000000-0000-0000-0000-000000000001')
   WHERE team_id = 'c3000000-0000-0000-0000-000000000001';

  PERFORM assert_eq('a team card carries the size against the maximum', t.max_size, 3);
  PERFORM assert_eq('and counts the members it has', t.member_count > 0, true);
  PERFORM assert_eq('and the country mix, as a distinct list', t.countries @> ARRAY['ZW']::char(2)[], true);
  PERFORM assert_eq('a fresh owner is not marked stale', t.owner_stale, false);

  UPDATE teams SET owner_last_seen_at = now() - interval '20 days'
   WHERE id = 'c3000000-0000-0000-0000-000000000001';
  PERFORM assert_eq(
    'an owner absent for over 14 days is marked stale in the room (§4.2 [PR])',
    (SELECT owner_stale FROM room_teams('c1000000-0000-0000-0000-000000000001')
      WHERE team_id = 'c3000000-0000-0000-0000-000000000001'),
    true);
  UPDATE teams SET owner_last_seen_at = now()
   WHERE id = 'c3000000-0000-0000-0000-000000000001';

  PERFORM set_config('request.jwt.claim.sub', NULL, true);
END $$;

SELECT assert_eq(
  'and a viewer with no intent sees no teams either',
  (SELECT count(*)::int FROM room_teams('c1000000-0000-0000-0000-000000000001')),
  0);

-- "Your status" — one row for a signed-in viewer, whatever they have or have not done.
DO $$
DECLARE s record;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000001', true);
  SELECT * INTO s FROM my_room_status('c1000000-0000-0000-0000-000000000001');
  PERFORM assert_eq('your status knows your stance', s.stance::text, 'have_team_looking_for_roles');
  PERFORM assert_eq('and your team', s.my_team_id, 'c3000000-0000-0000-0000-000000000001'::uuid);
  PERFORM assert_eq('and that you own it', s.i_own_my_team, true);

  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000004', true);
  SELECT * INTO s FROM my_room_status('c1000000-0000-0000-0000-000000000001');
  PERFORM assert_eq(
    'someone with an intent and no team still gets a row, with nulls rather than nothing',
    s.stance IS NOT NULL AND s.my_team_id IS NULL, true);

  PERFORM set_config('request.jwt.claim.sub', NULL, true);
END $$;

-- The bug this last case exists for: a member of a team on ANOTHER opportunity, with intent
-- here and no team here. The first version of my_room_status joined team_members into the
-- same row as the intent, so those memberships produced rows the filter then dropped — and
-- the room told someone who HAD declared intent that they had said nothing at all.
DO $$
DECLARE s record; n int;
BEGIN
  INSERT INTO opportunities
    (id, slug, title, category_id, organisation_id, status, verification, last_verified_at,
     cost, source_url, deadline_at, deadline_precision, published_at, eligibility_scope,
     eligible_countries, link_ok)
  VALUES
    ('c1000000-0000-0000-0000-000000000004', 'collab-elsewhere', 'A different hackathon entirely',
     (SELECT id FROM categories WHERE code='hackathon'), 'c0000000-0000-0000-0000-000000000001',
     'published', 'verified', now(), 'free', 'https://collab.example/elsewhere',
     now() + interval '40 days', 'date_only', now(), 'africa_wide', ARRAY[]::char(2)[], true);

  INSERT INTO intents (user_id, opportunity_id, stance)
  VALUES ('c2000000-0000-0000-0000-000000000004','c1000000-0000-0000-0000-000000000004','have_team_looking_for_roles');

  INSERT INTO teams (opportunity_id, owner_user_id, name, max_size)
  VALUES ('c1000000-0000-0000-0000-000000000004','c2000000-0000-0000-0000-000000000004','Elsewhere Crew',3);

  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000004', true);

  SELECT count(*)::int INTO n FROM my_room_status('c1000000-0000-0000-0000-000000000001');
  PERFORM assert_eq('a team in another room does not erase your status in this one', n, 1);

  SELECT * INTO s FROM my_room_status('c1000000-0000-0000-0000-000000000001');
  PERFORM assert_eq('your intent here is still reported', s.stance IS NOT NULL, true);
  PERFORM assert_eq('and the other room''s team is not shown as yours here',
                    s.my_team_id, NULL::uuid);

  SELECT * INTO s FROM my_room_status('c1000000-0000-0000-0000-000000000004');
  PERFORM assert_eq('while in that room it is', s.my_team_id IS NOT NULL, true);

  PERFORM set_config('request.jwt.claim.sub', NULL, true);
END $$;

-- The decide list, and the same §2.2 limit on what it may return.
DO $$
DECLARE cols text; n int;
BEGIN
  SELECT pg_get_function_result(p.oid) INTO cols
    FROM pg_proc p JOIN pg_namespace n2 ON n2.oid = p.pronamespace
   WHERE n2.nspname = 'public' AND p.proname = 'my_requests';
  IF cols IS NULL THEN
    RAISE EXCEPTION 'FAIL  my_requests not found — the assertion is vacuous';
  END IF;
  IF cols ~* '(email|phone|telegram|whatsapp|identifier)' THEN
    RAISE EXCEPTION
      'FAIL  the decide list returns a contact detail before acceptance (criterion 3 [PR]): %', cols;
  END IF;
  RAISE NOTICE 'PASS  the decide list carries no contact detail — criterion 3 holds on this endpoint too';

  PERFORM set_config('request.jwt.claim.sub', NULL, true);
  SELECT count(*)::int INTO n FROM my_requests('in');
  PERFORM assert_eq('an anonymous caller has no requests to decide', n, 0);

  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000001', true);
  SELECT count(*)::int INTO n FROM my_requests('sideways');
  PERFORM assert_eq('and a direction that is neither in nor out returns nothing', n, 0);
  PERFORM set_config('request.jwt.claim.sub', NULL, true);
END $$;

-- §2.3's state machine, and the hole 0017 closed: a requester deciding their own request.
DO $$
DECLARE chk text; qual text;
BEGIN
  SELECT coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
         coalesce(pg_get_expr(p.polqual, p.polrelid), '')
    INTO chk, qual
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname = 'collaboration_requests' AND p.polcmd = 'w';

  IF chk IS NULL THEN
    RAISE EXCEPTION 'FAIL  no UPDATE policy on collaboration_requests — the assertion is vacuous';
  END IF;
  IF chk NOT ILIKE '%withdrawn%' THEN
    RAISE EXCEPTION
      'FAIL  the UPDATE policy lets a participant write any state, including accepting their own request: %',
      chk;
  END IF;
  RAISE NOTICE 'PASS  the only state a requester may write directly is withdrawn (§2.3)';
END $$;

-- Handoff, from the other end: proposing is not exchanging.
DO $$
DECLARE v_thread uuid; v_proposal uuid; v_view record; n int;
BEGIN
  SELECT th.id INTO v_thread FROM threads th
    JOIN collaboration_requests r ON r.id = th.request_id
   WHERE r.id = 'c6000000-0000-0000-0000-000000000002';

  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000001', true);

  SELECT * INTO v_view FROM thread_view(v_thread);
  PERFORM assert_eq('the thread header names the other person, not you',
                    v_view.counterpart_display_name, 'Joiner');
  PERFORM assert_eq('and says what the conversation is about',
                    v_view.context_label, 'Irrigation Crew');

  -- This thread already reached an accepted handoff earlier in the suite, so a second
  -- proposal is refused rather than quietly stacking another channel on top.
  BEGIN
    v_proposal := propose_handoff(v_thread, 'whatsapp', '+263700000000');
    RAISE EXCEPTION 'FAIL  a second handoff was accepted after contacts were already swapped';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    RAISE NOTICE 'PASS  once contacts are swapped there is nothing left to propose (refused: %)',
      left(SQLERRM, 60);
  END;

  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000005', true);
  SELECT count(*)::int INTO n FROM thread_view(v_thread);
  PERFORM assert_eq('someone outside the thread cannot read its header either', n, 0);

  PERFORM assert_eq('and cannot propose a handoff into it',
                    propose_handoff(v_thread, 'telegram', '@stranger'), NULL::uuid);

  PERFORM set_config('request.jwt.claim.sub', NULL, true);
END $$;

-- A fresh thread, to exercise the propose → decline → propose path §3.3 describes.
DO $$
DECLARE v_thread uuid; v_proposal uuid; v_view record; n int;
BEGIN
  INSERT INTO intents (user_id, opportunity_id, stance)
  VALUES ('c2000000-0000-0000-0000-000000000007','c1000000-0000-0000-0000-000000000001','looking_for_team')
  ON CONFLICT (user_id, opportunity_id) DO UPDATE SET stance = 'looking_for_team';

  INSERT INTO collaboration_requests
    (id, context, opportunity_id, requester_user_id, target_user_id, message)
  VALUES ('c6000000-0000-0000-0000-000000000004','opportunity_intent',
          'c1000000-0000-0000-0000-000000000001',
          'c2000000-0000-0000-0000-000000000007','c2000000-0000-0000-0000-000000000003',
          'Fancy entering this together?');

  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000003', true);
  v_thread := accept_request('c6000000-0000-0000-0000-000000000004');

  v_proposal := propose_handoff(v_thread, 'telegram', '@third');
  PERFORM assert_eq('a handoff can be proposed in an open thread', v_proposal IS NOT NULL, true);

  SELECT count(*)::int INTO n FROM handoff_identifiers(v_thread);
  PERFORM assert_eq('and still releases nothing on its own (§3.3 [PR])', n, 0);

  SELECT * INTO v_view FROM thread_view(v_thread);
  PERFORM assert_eq('the banner knows a proposal is outstanding', v_view.handoff_state, 'proposed');
  PERFORM assert_eq('and that it is the viewer''s own', v_view.handoff_is_mine, true);

  -- §3.3: "Either side can decline without explanation. Declining does not close the thread."
  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000007', true);
  PERFORM assert_eq('the other side can decline it', decline_handoff(v_proposal), true);

  SELECT * INTO v_view FROM thread_view(v_thread);
  PERFORM assert_eq('declining leaves no live proposal', v_view.handoff_state, NULL::text);
  PERFORM assert_eq('and does not close the thread', v_view.state, 'open');

  SELECT count(*)::int INTO n FROM handoff_identifiers(v_thread);
  PERFORM assert_eq('and nothing was released by the attempt', n, 0);

  -- A declined proposal does not consume the option: either side may try again.
  v_proposal := propose_handoff(v_thread, 'whatsapp', '+263700000001');
  PERFORM assert_eq('and either side may propose again afterwards', v_proposal IS NOT NULL, true);

  PERFORM set_config('request.jwt.claim.sub', NULL, true);
END $$;

-- The thread list, which is the only way to find a conversation again.
DO $$
DECLARE r record; n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000007', true);
  SELECT count(*)::int INTO n FROM my_threads();
  PERFORM assert_eq('your threads are listed for you', n, 1);

  SELECT * INTO r FROM my_threads();
  PERFORM assert_eq('with the other person''s name', r.counterpart_display_name, 'Third');
  PERFORM assert_eq('and what it was about', r.context_label, 'A hackathon with team rules');

  PERFORM set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000005', true);
  SELECT count(*)::int INTO n FROM my_threads();
  PERFORM assert_eq('and nobody else''s are', n, 0);
  PERFORM set_config('request.jwt.claim.sub', NULL, true);
END $$;

-- ── Expiry ──────────────────────────────────────────────────────────────────

UPDATE collaboration_requests SET expires_at = now() - interval '1 minute', state = 'pending'
 WHERE id = 'c6000000-0000-0000-0000-000000000003';

DO $$
DECLARE report jsonb;
BEGIN
  report := expire_collaboration();
  PERFORM assert_eq(
    'an expired request is marked expired, not deleted',
    (SELECT state::text FROM collaboration_requests WHERE id = 'c6000000-0000-0000-0000-000000000003'),
    'expired');
  PERFORM assert_eq('and the job reports what it did', report ? 'requests_expired', true);
END $$;

ROLLBACK;
