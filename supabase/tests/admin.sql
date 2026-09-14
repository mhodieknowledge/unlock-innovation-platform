-- The admin tier. ADMIN_SYSTEM.md, and Phase 8's five acceptance criteria.
--
-- Three of the five are database claims and are asserted here:
--
--   "Every state-changing action writes an audit row with before and after."   `[PR]`
--   "The rule editor refuses to save an eligibility rule without a source quote." `[PR]`
--   "Priority-1 SLA breach fires a Telegram alert."                            `[PR]`
--
-- The other two — queues clearable one-handed, admin routes within 200 KB — are route
-- claims, and live in apps/web/test/byte-budget-ssr.test.ts and admin-route.test.ts.
--
-- The first assertion block is about ROLES, because §1's table is the thing most likely to
-- rot: it is easy to write a new admin function and forget that a reviewer must not be able
-- to touch an account.

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

-- ── Fixtures: one of each role, plus somebody to act on ─────────────────────

INSERT INTO users (id, email, age_confirmed_18, display_name, is_admin, admin_role) VALUES
  ('da000000-0000-0000-0000-000000000001', 'reviewer@example.invalid', true, 'A Reviewer', true, 'reviewer'),
  ('da000000-0000-0000-0000-000000000002', 'moderator@example.invalid', true, 'A Moderator', true, 'moderator'),
  ('da000000-0000-0000-0000-000000000003', 'super@example.invalid', true, 'A Superadmin', true, 'superadmin'),
  ('da000000-0000-0000-0000-000000000004', 'member@example.invalid', true, 'An Ordinary Member', false, NULL),
  ('da000000-0000-0000-0000-000000000005', 'reporter@example.invalid', true, 'A Reporter', false, NULL),
  ('da000000-0000-0000-0000-000000000006', 'tracker@example.invalid', true, 'A Tracker', false, NULL);

INSERT INTO organisations (id, name, slug, website_url, website_domain)
VALUES ('db000000-0000-0000-0000-000000000001', 'Review Org', 'review-org',
        'https://review.example', 'review.example');

INSERT INTO sources (id, name, kind, url, robots_allowed, robots_checked_at, tos_posture)
VALUES
  ('dc000000-0000-0000-0000-000000000001', 'A checked source', 'html_page',
   'https://review.example/calls', true, now(), 'permits_feeds'),
  ('dc000000-0000-0000-0000-000000000002', 'An unchecked source', 'html_page',
   'https://other.example/calls', NULL, NULL, NULL),
  ('dc000000-0000-0000-0000-000000000003', 'A disallowed source', 'html_page',
   'https://closed.example/calls', false, now(), 'permits_feeds');

-- A record waiting in review, with a low-confidence rule and a high-confidence one.
INSERT INTO opportunities
  (id, slug, title, category_id, organisation_id, source_id, status, verification,
   extraction_confidence, cost, source_url, deadline_at, deadline_precision,
   eligibility_scope, eligible_countries, link_ok, last_verified_at)
VALUES
  ('dd000000-0000-0000-0000-000000000001', 'review-me', 'A record waiting for review',
   (SELECT id FROM categories WHERE code='grant'), 'db000000-0000-0000-0000-000000000001',
   'dc000000-0000-0000-0000-000000000001', 'in_review', 'auto', 0.71, 'free',
   'https://review.example/calls/1', now() + interval '30 days', 'date_only',
   'africa_wide', ARRAY[]::char(2)[], true, now()),
  ('dd000000-0000-0000-0000-000000000002', 'paid-one', 'A record that charges a fee',
   (SELECT id FROM categories WHERE code='grant'), 'db000000-0000-0000-0000-000000000001',
   NULL, 'in_review', 'auto', 0.80, 'paid',
   'https://review.example/calls/2', now() + interval '30 days', 'date_only',
   'africa_wide', ARRAY[]::char(2)[], true, now());

INSERT INTO eligibility_rules (opportunity_id, rule_type, params, source_quote, confidence) VALUES
  ('dd000000-0000-0000-0000-000000000001', 'country_in', '{"countries":["ZW","ZM"]}',
   'Open to residents of Zimbabwe and Zambia.', 0.88),
  ('dd000000-0000-0000-0000-000000000001', 'age_between', '{"min":18,"max":35}',
   'Applicants must be between 18 and 35.', 0.62);

INSERT INTO review_queue (id, queue, subject_type, subject_id, priority) VALUES
  ('de000000-0000-0000-0000-000000000001', 'low_confidence', 'opportunity',
   'dd000000-0000-0000-0000-000000000001', 3),
  ('de000000-0000-0000-0000-000000000002', 'paid_cost', 'opportunity',
   'dd000000-0000-0000-0000-000000000002', 2);

INSERT INTO tracker_entries (user_id, opportunity_id, state)
VALUES ('da000000-0000-0000-0000-000000000006', 'dd000000-0000-0000-0000-000000000001', 'saved');

-- ── §1 Roles are a ladder, and the rungs are enforced ───────────────────────

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'da000000-0000-0000-0000-000000000001', true);
  PERFORM assert_eq('a reviewer is a reviewer', has_admin_role('reviewer'), true);
  PERFORM assert_eq('and is not a moderator', has_admin_role('moderator'), false);
  PERFORM assert_eq('and is certainly not a superadmin', has_admin_role('superadmin'), false);

  PERFORM set_config('request.jwt.claim.sub', 'da000000-0000-0000-0000-000000000002', true);
  PERFORM assert_eq('a moderator can do what a reviewer can', has_admin_role('reviewer'), true);
  PERFORM assert_eq('and moderator things', has_admin_role('moderator'), true);
  PERFORM assert_eq('and not superadmin things', has_admin_role('superadmin'), false);

  PERFORM set_config('request.jwt.claim.sub', 'da000000-0000-0000-0000-000000000003', true);
  PERFORM assert_eq('a superadmin can do everything below them too',
                    has_admin_role('reviewer') AND has_admin_role('moderator')
                    AND has_admin_role('superadmin'), true);

  PERFORM set_config('request.jwt.claim.sub', 'da000000-0000-0000-0000-000000000004', true);
  PERFORM assert_eq('an ordinary member is none of them',
                    has_admin_role('reviewer') OR has_admin_role('moderator'), false);

  PERFORM set_config('request.jwt.claim.sub', NULL, true);
  PERFORM assert_eq('and neither is nobody', has_admin_role('reviewer'), false);
END $$;

-- A suspended admin is not an admin. An account that has been taken away must stop working
-- the moment it is taken away, not at the next deploy.
DO $$
BEGIN
  UPDATE users SET account_state = 'suspended' WHERE id = 'da000000-0000-0000-0000-000000000001';
  PERFORM set_config('request.jwt.claim.sub', 'da000000-0000-0000-0000-000000000001', true);
  PERFORM assert_eq('a suspended admin has no admin rights', has_admin_role('reviewer'), false);
  UPDATE users SET account_state = 'active' WHERE id = 'da000000-0000-0000-0000-000000000001';
  PERFORM set_config('request.jwt.claim.sub', NULL, true);
END $$;

SELECT assert_eq(
  'an anonymous caller gets no dashboard, and no hint of what is in it',
  (SELECT count(*)::int FROM admin_queue('low_confidence')),
  0);

-- ── §2 The dashboard ────────────────────────────────────────────────────────

SET LOCAL request.jwt.claim.sub = 'da000000-0000-0000-0000-000000000001';

DO $$
DECLARE d jsonb;
BEGIN
  d := admin_dashboard();

  PERFORM assert_eq('the dashboard counts the open queues', jsonb_array_length(d->'queues'), 2);
  PERFORM assert_eq('and names each queue''s SLA from §7''s table',
    (SELECT (q->>'sla_hours')::int FROM jsonb_array_elements(d->'queues') q
      WHERE q->>'queue' = 'paid_cost'),
    24);
  PERFORM assert_eq('it counts the catalogue',
    (d->'catalogue'->>'in_review')::int, 2);
  -- Relative, not absolute: the seed registers two dozen real sources, all inactive and
  -- awaiting a human's terms-of-service judgement (OPPORTUNITY_INGESTION.md §7). An
  -- absolute number here would be an assertion about the seed rather than the dashboard.
  PERFORM assert_eq('and the sources, including the ones nobody has cleared yet',
    (d->'sources'->>'awaiting_tos')::int >= 2, true);
  PERFORM assert_eq('it knows how big the database is',
    (d->>'database_mb')::numeric > 0, true);
  PERFORM assert_eq('and whether that is a problem yet',
    (d->>'database_near_limit')::boolean, false);

  -- §2 `[PR]`: no vanity metrics. Asserted as an absence of keys, because the temptation is
  -- to add one and the only defence is a test that notices.
  PERFORM assert_eq('the dashboard holds no vanity metric',
    d::text !~* '(page_?views|impressions|followers|likes|engagement)', true);
END $$;

-- ── §3 Queues, claimable so two reviewers do not collide ────────────────────

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM admin_queue('low_confidence') LIMIT 1;
  PERFORM assert_eq('a queue item carries the title, not just an id',
                    r.title, 'A record waiting for review');
  PERFORM assert_eq('and enough detail to decide whether to open it',
                    r.detail LIKE 'Review Org%', true);
  PERFORM assert_eq('and is not claimed yet', r.state, 'open');

  PERFORM assert_eq('a reviewer can claim it',
                    admin_claim_queue_item('de000000-0000-0000-0000-000000000001'), true);

  PERFORM set_config('request.jwt.claim.sub', 'da000000-0000-0000-0000-000000000002', true);
  PERFORM assert_eq(
    'and a second reviewer cannot take it while the claim is fresh (§3.1)',
    admin_claim_queue_item('de000000-0000-0000-0000-000000000001'), false);

  SELECT * INTO r FROM admin_queue('low_confidence') LIMIT 1;
  PERFORM assert_eq('but they can see who has it, rather than seeing a hole in the queue',
                    r.claimed_by_name, 'A Reviewer');

  -- A claim that outlives the reviewer's attention is a queue item nobody can work on.
  UPDATE review_queue SET claimed_at = now() - interval '45 minutes'
   WHERE id = 'de000000-0000-0000-0000-000000000001';
  PERFORM assert_eq(
    'a stale claim can be taken over after 30 minutes',
    admin_claim_queue_item('de000000-0000-0000-0000-000000000001'), true);

  PERFORM assert_eq('and released again',
    admin_release_queue_item('de000000-0000-0000-0000-000000000001'), true);

  PERFORM set_config('request.jwt.claim.sub', 'da000000-0000-0000-0000-000000000004', true);
  PERFORM assert_eq('an ordinary member cannot claim anything',
                    admin_claim_queue_item('de000000-0000-0000-0000-000000000001'), false);
  PERFORM set_config('request.jwt.claim.sub', 'da000000-0000-0000-0000-000000000001', true);
END $$;

-- §3.1's review card: the quote beside the value, worst confidence first.
DO $$
DECLARE c jsonb;
BEGIN
  c := admin_review_card('dd000000-0000-0000-0000-000000000001');

  PERFORM assert_eq('the card carries the record', c->'opportunity'->>'title',
                    'A record waiting for review');
  PERFORM assert_eq('and the source it came from', c->'opportunity'->>'source_name',
                    'A checked source');
  PERFORM assert_eq('and how many people are already waiting on it',
                    (c->'opportunity'->>'tracked_by')::int, 1);

  PERFORM assert_eq('every rule comes with its quote (§3.1 [PR])',
    (SELECT bool_and(length(r->>'source_quote') > 10)
       FROM jsonb_array_elements(c->'rules') r),
    true);

  -- §3.1: "Low-confidence fields highlighted and ORDERED FIRST." The reviewer meets the
  -- field most likely to be wrong while they are still paying attention.
  PERFORM assert_eq('the least confident rule is first',
    (c->'rules'->0->>'rule_type'), 'age_between');
  PERFORM assert_eq('and it is the one at 0.62',
    (c->'rules'->0->>'confidence')::numeric, 0.62);
END $$;

-- ── THE RULE EDITOR CRITERION `[PR]` ────────────────────────────────────────

SELECT assert_raises(
  'a rule cannot be saved with no source quote at all (criterion 4 [PR])',
  $q$SELECT admin_save_rule('dd000000-0000-0000-0000-000000000001', 'student_status_in',
        '{"statuses":["undergraduate"]}', NULL)$q$);

SELECT assert_raises(
  'nor with an empty one',
  $q$SELECT admin_save_rule('dd000000-0000-0000-0000-000000000001', 'student_status_in',
        '{"statuses":["undergraduate"]}', '   ')$q$);

SELECT assert_raises(
  'nor with a single character that technically is not empty',
  $q$SELECT admin_save_rule('dd000000-0000-0000-0000-000000000001', 'student_status_in',
        '{"statuses":["undergraduate"]}', 'x')$q$);

SELECT assert_raises(
  'and a rule with no parameters decides nothing, so it is refused too',
  $q$SELECT admin_save_rule('dd000000-0000-0000-0000-000000000001', 'student_status_in',
        '{}', 'Open to currently enrolled undergraduate students.')$q$);

DO $$
DECLARE v_rule uuid; v_audit int;
BEGIN
  v_rule := admin_save_rule('dd000000-0000-0000-0000-000000000001', 'student_status_in',
    '{"statuses":["undergraduate"]}',
    'Open to currently enrolled undergraduate students.');

  PERFORM assert_eq('a rule WITH a quote saves', v_rule IS NOT NULL, true);
  PERFORM assert_eq('and is marked as reviewed by the person who saved it',
    (SELECT reviewed_by FROM eligibility_rules WHERE id = v_rule),
    'da000000-0000-0000-0000-000000000001'::uuid);

  SELECT count(*)::int INTO v_audit FROM admin_audit_log
   WHERE action = 'rule_add' AND subject_id = v_rule;
  PERFORM assert_eq('and it is audited', v_audit, 1);

  -- Editing keeps the same requirement, and records what it was before.
  PERFORM admin_save_rule('dd000000-0000-0000-0000-000000000001', 'student_status_in',
    '{"statuses":["undergraduate","masters"]}',
    'Open to undergraduate and masters students.', v_rule);

  PERFORM assert_eq('an edit records the before state (§11 [PR])',
    (SELECT before->>'source_quote' FROM admin_audit_log
      WHERE action = 'rule_edit' AND subject_id = v_rule),
    'Open to currently enrolled undergraduate students.');
  PERFORM assert_eq('and the after state',
    (SELECT after->'params'->'statuses'->>1 FROM admin_audit_log
      WHERE action = 'rule_edit' AND subject_id = v_rule),
    'masters');

  -- Deleting a rule needs a reason: a verdict changed by a deletion nobody explained is
  -- indistinguishable from a bug.
  BEGIN
    PERFORM admin_delete_rule(v_rule, '');
    RAISE EXCEPTION 'FAIL  a rule was deleted with no reason';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    RAISE NOTICE 'PASS  deleting a rule needs a reason (refused: %)', left(SQLERRM, 50);
  END;

  PERFORM assert_eq('with a reason, it goes',
    admin_delete_rule(v_rule, 'The page does not say this.'), true);
  PERFORM assert_eq('and the deleted rule is still in the log, in full',
    (SELECT before->>'source_quote' FROM admin_audit_log
      WHERE action = 'rule_delete' AND subject_id = v_rule),
    'Open to undergraduate and masters students.');
END $$;

-- ── §4 Publishing, and invariant 13 ─────────────────────────────────────────

SELECT assert_raises(
  'a record that charges a fee to enter is never published (invariant 13)',
  $q$SELECT admin_publish_opportunity('dd000000-0000-0000-0000-000000000002')$q$);

DO $$
DECLARE v_audit record;
BEGIN
  PERFORM assert_eq('a reviewed record publishes',
    admin_publish_opportunity('dd000000-0000-0000-0000-000000000001', false), true);

  PERFORM assert_eq('it is published',
    (SELECT status::text FROM opportunities WHERE id = 'dd000000-0000-0000-0000-000000000001'),
    'published');
  PERFORM assert_eq('and reads as human-verified, not machine-extracted',
    (SELECT verification::text FROM opportunities WHERE id = 'dd000000-0000-0000-0000-000000000001'),
    'verified');
  PERFORM assert_eq('the queue item is closed',
    (SELECT count(*)::int FROM review_queue
      WHERE subject_id = 'dd000000-0000-0000-0000-000000000001' AND state <> 'done'),
    0);
  PERFORM assert_eq('every rule is marked reviewed',
    (SELECT count(*)::int FROM eligibility_rules
      WHERE opportunity_id = 'dd000000-0000-0000-0000-000000000001' AND reviewed_at IS NULL),
    0);

  -- §4's notify-trackers default: on, for a record coming back from review.
  PERFORM assert_eq('and the person tracking it is told it is back',
    (SELECT count(*)::int FROM notifications
      WHERE user_id = 'da000000-0000-0000-0000-000000000006' AND type = 'opportunity_changed'),
    1);

  -- §7's headline number depends on the distinction between an edited and an unedited
  -- approval, so the action name has to carry it.
  SELECT * INTO v_audit FROM admin_audit_log
   WHERE subject_id = 'dd000000-0000-0000-0000-000000000001'
     AND action LIKE 'publish%' ORDER BY ts DESC LIMIT 1;
  PERFORM assert_eq('an unedited approval is recorded as one', v_audit.action, 'publish_unedited');
  PERFORM assert_eq('with the before state', v_audit.before->>'status', 'in_review');
  PERFORM assert_eq('and the after state', v_audit.after->>'status', 'published');
END $$;

-- A rule with no quote cannot exist AT ALL, which is a stronger guarantee than the publish
-- gate. The attempt below is how that was discovered: this block originally set a quote to
-- '' to prove publication was blocked, and the table refused the setup — so the assertion
-- is about the table, which is where the invariant is actually unbypassable.
--
-- admin_publish_opportunity still checks (it is the last gate before a verdict is computed
-- from a rule), and that check is now defence in depth rather than the only defence.
SELECT assert_raises(
  'an eligibility rule cannot be stored with an empty source quote, by any route',
  $q$UPDATE eligibility_rules SET source_quote = ''
      WHERE opportunity_id = 'dd000000-0000-0000-0000-000000000001'$q$);

SELECT assert_raises(
  'nor with whitespace pretending to be one',
  $q$UPDATE eligibility_rules SET source_quote = '   '
      WHERE opportunity_id = 'dd000000-0000-0000-0000-000000000001'$q$);

SELECT assert_raises(
  'nor inserted without one',
  $q$INSERT INTO eligibility_rules (opportunity_id, rule_type, params, confidence)
     VALUES ('dd000000-0000-0000-0000-000000000001', 'language_required',
             '{"languages":["en"]}', 0.9)$q$);

SELECT assert_eq(
  'so every rule in the database has the sentence it came from',
  (SELECT count(*)::int FROM eligibility_rules
    WHERE source_quote IS NULL OR btrim(source_quote) = ''),
  0);

-- Rejecting needs a reason, and the reason is in the log.
SELECT assert_raises(
  'rejecting without a reason is refused (§4)',
  $q$SELECT admin_reject_opportunity('dd000000-0000-0000-0000-000000000001', '')$q$);

DO $$
BEGIN
  PERFORM assert_eq('with a reason, it rejects',
    admin_reject_opportunity('dd000000-0000-0000-0000-000000000001',
      'The organiser confirmed this was never open.'), true);
  PERFORM assert_eq('and the reason is in the audit row',
    (SELECT after->>'reason' FROM admin_audit_log
      WHERE action = 'reject' AND subject_id = 'dd000000-0000-0000-0000-000000000001'),
    'The organiser confirmed this was never open.');
END $$;

RESET request.jwt.claim.sub;

-- ── §1 and §6: a reviewer cannot touch an account ───────────────────────────

SET LOCAL request.jwt.claim.sub = 'da000000-0000-0000-0000-000000000001';

SELECT assert_raises(
  'a reviewer cannot restrict an account (§1)',
  $q$SELECT admin_user_action('da000000-0000-0000-0000-000000000004', 'restrict',
        'Sending identical requests to twenty people.')$q$);

SELECT assert_eq(
  'and cannot even search accounts, which is where the ladder starts',
  (SELECT count(*)::int FROM admin_user_search('member')),
  0);

RESET request.jwt.claim.sub;
SET LOCAL request.jwt.claim.sub = 'da000000-0000-0000-0000-000000000002';

SELECT assert_raises(
  'a reason of ten characters or fewer is not a reason (§8)',
  $q$SELECT admin_user_action('da000000-0000-0000-0000-000000000004', 'restrict', 'spam')$q$);

SELECT assert_raises(
  'nobody acts on their own account',
  $q$SELECT admin_user_action('da000000-0000-0000-0000-000000000002', 'suspend',
        'A long enough reason to pass the length check.')$q$);

SELECT assert_raises(
  'and a moderator cannot act on another admin',
  $q$SELECT admin_user_action('da000000-0000-0000-0000-000000000001', 'suspend',
        'A long enough reason to pass the length check.')$q$);

DO $$
BEGIN
  PERFORM assert_eq('a moderator can restrict an ordinary account',
    admin_user_action('da000000-0000-0000-0000-000000000004', 'restrict',
      'Sending identical requests to twenty people.'), true);

  PERFORM assert_eq('the account becomes read-only',
    (SELECT account_state::text FROM users WHERE id = 'da000000-0000-0000-0000-000000000004'),
    'restricted');

  -- §8: the person is told what happened and what it means. A silent restriction is
  -- indistinguishable from a bug to the person it happens to.
  PERFORM assert_eq('and the person is told, in words about what they can still do',
    (SELECT count(*)::int FROM notifications
      WHERE user_id = 'da000000-0000-0000-0000-000000000004' AND type = 'moderation_outcome'
        AND reason LIKE '%read-only%'),
    1);

  PERFORM assert_eq('the reason reaches them too',
    (SELECT payload->>'reason' FROM notifications
      WHERE user_id = 'da000000-0000-0000-0000-000000000004' AND type = 'moderation_outcome'),
    'Sending identical requests to twenty people.');

  PERFORM assert_eq('there is a moderation record',
    (SELECT count(*)::int FROM moderation_actions
      WHERE subject_id = 'da000000-0000-0000-0000-000000000004' AND action = 'restrict'),
    1);

  PERFORM assert_eq('and an audit row with both states (§11 [PR])',
    (SELECT before->>'account_state' || '→' || (after->>'account_state')
       FROM admin_audit_log
      WHERE action = 'user_restrict' AND subject_id = 'da000000-0000-0000-0000-000000000004'),
    'active→restricted');

  PERFORM assert_eq('reinstating puts it back',
    admin_user_action('da000000-0000-0000-0000-000000000004', 'reinstate',
      'They explained; the messages were not identical after all.'), true);
  PERFORM assert_eq('and the account is active again',
    (SELECT account_state::text FROM users WHERE id = 'da000000-0000-0000-0000-000000000004'),
    'active');
END $$;

-- §6 `[PR]`: what an admin may never see.
DO $$
DECLARE cols text;
BEGIN
  SELECT pg_get_function_result(p.oid) INTO cols
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'admin_user_search';

  IF cols IS NULL THEN
    RAISE EXCEPTION 'FAIL  admin_user_search not found — the assertion is vacuous';
  END IF;
  IF cols ~* '(birth|country_of_residence|student|tracker|saved|digest|message_body|note)' THEN
    RAISE EXCEPTION
      'FAIL  the admin user view returns something §6 forbids: %', cols;
  END IF;
  RAISE NOTICE 'PASS  the admin user view exposes counts, never an eligibility profile or a tracker (§6 [PR])';
END $$;

RESET request.jwt.claim.sub;

-- ── §8 The report inbox, grouped ────────────────────────────────────────────

INSERT INTO reports (reporter_user_id, subject_type, subject_id, reason, detail, priority) VALUES
  ('da000000-0000-0000-0000-000000000005', 'opportunity', 'dd000000-0000-0000-0000-000000000002',
   'possible_scam', 'They asked me for a registration fee by WhatsApp.', 1),
  ('da000000-0000-0000-0000-000000000006', 'opportunity', 'dd000000-0000-0000-0000-000000000002',
   'requires_payment', 'There is a fee on the application page.', 2),
  ('da000000-0000-0000-0000-000000000004', 'opportunity', 'dd000000-0000-0000-0000-000000000002',
   'possible_scam', 'Same here.', 1);

SET LOCAL request.jwt.claim.sub = 'da000000-0000-0000-0000-000000000001';

DO $$
DECLARE r record; n int;
BEGIN
  SELECT count(*)::int INTO n FROM admin_report_inbox();
  PERFORM assert_eq(
    'three reports about one listing are ONE card, not three (§8)', n, 1);

  SELECT * INTO r FROM admin_report_inbox();
  PERFORM assert_eq('the card counts them', r.report_count, 3);
  PERFORM assert_eq('and counts the people, which is the number that matters',
                    r.distinct_reporters, 3);
  PERFORM assert_eq('it weights them by reporter history',
                    r.weighted_score > 0, true);
  PERFORM assert_eq('and it is marked as a safety matter, not a data-quality one',
                    r.is_safety, true);

  -- §8: safety reports are never batched with data-quality ones.
  PERFORM assert_eq('the inbox can be asked for safety only',
    (SELECT count(*)::int FROM admin_report_inbox(true)), 1);
  PERFORM assert_eq('and for everything else',
    (SELECT count(*)::int FROM admin_report_inbox(false)), 0);

  -- One decision, one resolution, one notification each.
  PERFORM assert_eq('resolving the subject resolves every report about it',
    admin_resolve_subject_reports('opportunity', 'dd000000-0000-0000-0000-000000000002',
      true, 'Confirmed a fee on the application page; listing removed.'), 3);

  PERFORM assert_eq('and the inbox is empty afterwards',
    (SELECT count(*)::int FROM admin_report_inbox()), 0);

  PERFORM assert_eq('every reporter is told (§8)',
    (SELECT count(DISTINCT user_id)::int FROM notifications
      WHERE type = 'moderation_outcome'
        AND user_id IN ('da000000-0000-0000-0000-000000000004',
                        'da000000-0000-0000-0000-000000000005',
                        'da000000-0000-0000-0000-000000000006')),
    3);

  PERFORM assert_eq('and the decision is audited once, not three times',
    (SELECT count(*)::int FROM admin_audit_log
      WHERE action = 'reports_upheld' AND subject_id = 'dd000000-0000-0000-0000-000000000002'),
    1);
END $$;

SELECT assert_raises(
  'resolving with no note is refused: "we looked at it" is not an outcome',
  $q$SELECT admin_resolve_subject_reports('opportunity',
        'dd000000-0000-0000-0000-000000000001', false, '')$q$);

RESET request.jwt.claim.sub;

-- ── §5 The robots gate `[PR]` ───────────────────────────────────────────────

SET LOCAL request.jwt.claim.sub = 'da000000-0000-0000-0000-000000000003';

SELECT assert_raises(
  'a source whose robots.txt has never been checked cannot be activated (§5 [PR])',
  $q$SELECT admin_set_source_active('dc000000-0000-0000-0000-000000000002', true)$q$);

SELECT assert_raises(
  'and one whose robots.txt disallows us certainly cannot',
  $q$SELECT admin_set_source_active('dc000000-0000-0000-0000-000000000003', true)$q$);

DO $$
BEGIN
  PERFORM assert_eq('a checked, allowed source with a recorded ToS posture can be',
    admin_set_source_active('dc000000-0000-0000-0000-000000000001', true), true);

  PERFORM assert_eq('and the activation is audited with what was checked',
    (SELECT after->>'tos_posture' FROM admin_audit_log
      WHERE action = 'source_activate' AND subject_id = 'dc000000-0000-0000-0000-000000000001'),
    'permits_feeds');

  -- A stale robots check is not a check. §7 of OPPORTUNITY_INGESTION.md re-checks on a
  -- cadence, and a source activated on a year-old check is a source crawling on permission
  -- it may no longer have.
  UPDATE sources SET is_active = false, robots_checked_at = now() - interval '60 days'
   WHERE id = 'dc000000-0000-0000-0000-000000000001';

  BEGIN
    PERFORM admin_set_source_active('dc000000-0000-0000-0000-000000000001', true);
    RAISE EXCEPTION 'FAIL  a source was activated on a 60-day-old robots check';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    RAISE NOTICE 'PASS  a stale robots check does not count (refused: %)', left(SQLERRM, 50);
  END;

  -- And the UI is told the same thing the function would say, so the button can be greyed
  -- out for the right reason rather than failing on click.
  PERFORM assert_eq('the source list explains what is blocking activation',
    (SELECT blocker FROM admin_sources() WHERE source_id = 'dc000000-0000-0000-0000-000000000003'),
    'robots.txt disallows our path');
  PERFORM assert_eq('and says when nothing is',
    (SELECT can_activate FROM admin_sources()
      WHERE source_id = 'dc000000-0000-0000-0000-000000000002'),
    false);
END $$;

-- Sources are a superadmin's business only.
RESET request.jwt.claim.sub;
SET LOCAL request.jwt.claim.sub = 'da000000-0000-0000-0000-000000000002';
SELECT assert_raises(
  'a moderator cannot change a source (§1)',
  $q$SELECT admin_set_source_active('dc000000-0000-0000-0000-000000000001', false)$q$);
RESET request.jwt.claim.sub;

-- ── §9 The priority-1 SLA breach alert `[PR]` ───────────────────────────────

DO $$
DECLARE n int; d text;
BEGIN
  -- Nothing is breached yet.
  SELECT count(*)::int INTO n FROM operator_alerts_due() WHERE kind = 'sla_breach_p1';
  PERFORM assert_eq('no alert while nothing is overdue', n, 0);

  -- A priority-1 item, older than the tightest SLA in §7's table.
  INSERT INTO review_queue (id, queue, subject_type, subject_id, priority, created_at)
  VALUES ('de000000-0000-0000-0000-000000000009', 'report_scam', 'opportunity',
          'dd000000-0000-0000-0000-000000000002', 1, now() - interval '20 hours');

  SELECT count(*)::int INTO n FROM operator_alerts_due() WHERE kind = 'sla_breach_p1';
  PERFORM assert_eq('a priority-1 item past its SLA raises an alert (criterion 5 [PR])', n, 1);

  SELECT detail INTO d FROM operator_alerts_due() WHERE kind = 'sla_breach_p1';
  PERFORM assert_eq('and the alert says which queue and how late',
                    d LIKE '%report_scam%' AND d LIKE '%20h%', true);

  -- Recording is separate from detecting, and deduplicated by day: a failing job must not
  -- become the flood it exists to warn about.
  SELECT count(*)::int INTO n FROM record_operator_alerts();
  PERFORM assert_eq('recording it queues it for Telegram', n >= 1, true);
  SELECT count(*)::int INTO n FROM record_operator_alerts();
  PERFORM assert_eq('and recording again the same day queues nothing new', n, 0);

  PERFORM assert_eq('the operator alert is waiting to be sent',
    (SELECT count(*)::int FROM operator_alerts
      WHERE kind = 'sla_breach_p1' AND notified_at IS NULL),
    1);
END $$;

-- A scam report open past 12 hours is its own alert, because it costs somebody money.
DO $$
DECLARE n int;
BEGIN
  INSERT INTO reports (reporter_user_id, subject_type, subject_id, reason, detail, priority, created_at)
  VALUES ('da000000-0000-0000-0000-000000000005', 'opportunity',
          'dd000000-0000-0000-0000-000000000001', 'possible_scam',
          'They asked for money.', 1, now() - interval '13 hours');

  SELECT count(*)::int INTO n FROM operator_alerts_due() WHERE kind = 'scam_report_open';
  PERFORM assert_eq('a scam report open for 13 hours raises its own alert (§9)', n, 1);
END $$;

-- ── §11 The audit log ───────────────────────────────────────────────────────

SET LOCAL request.jwt.claim.sub = 'da000000-0000-0000-0000-000000000002';
SELECT assert_eq(
  'a moderator cannot read the audit log (§11: superadmin-only)',
  (SELECT count(*)::int FROM admin_audit_search()),
  0);
RESET request.jwt.claim.sub;

SET LOCAL request.jwt.claim.sub = 'da000000-0000-0000-0000-000000000003';
SELECT assert_eq(
  'a superadmin can, and it is not empty after all of the above',
  (SELECT count(*)::int FROM admin_audit_search()) > 5,
  true);
SELECT assert_eq(
  'it can be searched by action',
  (SELECT count(*)::int FROM admin_audit_search(NULL, NULL, 'rule_add')) >= 1,
  true);
SELECT assert_eq(
  'and names the actor rather than an id',
  (SELECT actor_name FROM admin_audit_search(NULL, NULL, 'user_restrict') LIMIT 1),
  'A Moderator');

-- §11: immutable. Insert-only, no update or delete grants — asserted structurally because a
-- log somebody can edit is not a log.
SELECT assert_eq(
  'the audit log has no UPDATE or DELETE policy at all',
  (SELECT count(*)::int FROM pg_policy p
     JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'admin_audit_log' AND p.polcmd IN ('w','d')),
  0);

-- §1: feature flags are a superadmin's. 0006's policy granted write access to any admin,
-- which would have let a reviewer switch a social surface on for everybody.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'da000000-0000-0000-0000-000000000001', true);
  BEGIN
    PERFORM admin_set_flag('team_room_entry', true);
    RAISE EXCEPTION 'FAIL  a reviewer switched a density flag on';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    RAISE NOTICE 'PASS  a reviewer cannot switch a density flag on (refused: %)', left(SQLERRM, 50);
  END;

  PERFORM set_config('request.jwt.claim.sub', 'da000000-0000-0000-0000-000000000003', true);
  PERFORM assert_eq('a superadmin can', admin_set_flag('team_room_entry', true), true);
  PERFORM assert_eq('and the flag is on',
    (SELECT enabled FROM feature_flags WHERE key = 'team_room_entry'), true);
  PERFORM assert_eq('and the change is audited, with both states',
    (SELECT before->>'enabled' || '→' || (after->>'enabled') FROM admin_audit_log
      WHERE action = 'flag_enable' AND after->>'key' = 'team_room_entry'),
    'false→true');

  PERFORM assert_eq('and it can be turned back off',
    admin_set_flag('team_room_entry', false), true);

  -- The policy itself, asserted structurally: a function is only unbypassable if the table
  -- underneath it is too.
  PERFORM assert_eq(
    'the feature_flags write policy is scoped to superadmin, not to any admin',
    (SELECT count(*)::int FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relname = 'feature_flags'
        AND p.polcmd = '*'
        AND pg_get_expr(p.polqual, p.polrelid) ILIKE '%superadmin%'),
    1);
END $$;

-- §10's density panel: what is about to unlock.
SELECT assert_eq(
  'the density panel lists every flag, with whether its condition is met',
  (SELECT count(*)::int FROM admin_density_status()) >= 7,
  true);
SELECT assert_eq(
  'and says how far off the project floor is, in the units the floor is in',
  (SELECT detail FROM admin_density_status() WHERE flag = 'public_project_browse'),
  '0 of 40 public projects');

RESET request.jwt.claim.sub;

ROLLBACK;
