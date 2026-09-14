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
