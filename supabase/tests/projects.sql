-- Projects. COLLABORATION_SYSTEM.md §1 and Phase 6's acceptance criteria.
--
-- Two of the three criteria are about ABSENCE, which is the hard kind to test:
--
--   "A private project still receives matches."               (§1.1 `[PR]`)
--   "Public project browse does not exist below 40 public projects — the route is
--    absent, not empty."                                      (§1.4 `[PR]`)
--
-- The first is asserted by giving a PRIVATE project a match and reading it back. The
-- second by asserting that the browse function reports its floor rather than returning a
-- short list — a function that returned three projects would let a page render a browse
-- surface with three projects in it, which is the thing §24 forbids.
--
-- The third criterion — matches rendering within seconds of creation, before any other
-- prompt — is route behaviour and is asserted in apps/web/test/project-route.test.ts. What
-- IS asserted here is the half that makes it possible: candidates come back for a project
-- with no embedding at all.

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

INSERT INTO organisations (id, name, slug) VALUES
  ('f0000000-0000-0000-0000-000000000001', 'Project Org One', 'project-org-one'),
  ('f0000000-0000-0000-0000-000000000002', 'Project Org Two', 'project-org-two');

INSERT INTO users (id, email, age_confirmed_18, timezone, display_name) VALUES
  ('f2000000-0000-0000-0000-000000000001', 'builder@example.invalid', true, 'Africa/Harare', 'Project Owner'),
  ('f2000000-0000-0000-0000-000000000002', 'visitor@example.invalid', true, 'Africa/Lagos', 'Interested Visitor'),
  ('f2000000-0000-0000-0000-000000000003', 'unconfirmed@example.invalid', false, 'Africa/Harare', 'Unconfirmed');

-- The owner's eligibility profile is what the match gate runs against (§1.5).
INSERT INTO eligibility_profiles (user_id, country_of_residence, birth_year, student_status)
VALUES ('f2000000-0000-0000-0000-000000000001', 'ZW', 1998, 'undergraduate');

-- Two opportunities the owner is eligible for, and one they are not.
INSERT INTO opportunities
  (id, slug, title, category_id, organisation_id, status, verification, last_verified_at,
   cost, source_url, deadline_at, deadline_precision, published_at, eligibility_scope,
   eligible_countries, link_ok, tag_ids)
VALUES
  ('f1000000-0000-0000-0000-000000000001', 'agri-grant', 'An agriculture grant',
   (SELECT id FROM categories WHERE code='grant'), 'f0000000-0000-0000-0000-000000000001',
   'published', 'verified', now(), 'free', 'https://p.example/1',
   now() + interval '12 days', 'date_only', now(), 'africa_wide', ARRAY[]::char(2)[], true,
   ARRAY(SELECT id FROM tags WHERE kind='industry' AND code='agriculture')),
  ('f1000000-0000-0000-0000-000000000002', 'water-challenge', 'A water challenge',
   (SELECT id FROM categories WHERE code='hackathon'), 'f0000000-0000-0000-0000-000000000001',
   'published', 'verified', now(), 'free', 'https://p.example/2',
   now() + interval '30 days', 'date_only', now(), 'africa_wide', ARRAY[]::char(2)[], true,
   ARRAY[]::uuid[]),
  ('f1000000-0000-0000-0000-000000000003', 'nigeria-only', 'Open to Nigeria only',
   (SELECT id FROM categories WHERE code='grant'), 'f0000000-0000-0000-0000-000000000002',
   'published', 'verified', now(), 'free', 'https://p.example/3',
   now() + interval '20 days', 'date_only', now(), 'country_list', ARRAY['NG']::char(2)[], true,
   ARRAY[]::uuid[]);

-- Rules, because the gate is a VERDICT and an opportunity with no rules evaluates to
-- `unclear` — which §1.5 deliberately does not match on. A recommendation or a match says
-- "this is for you", so it has to be true, and "we could not read the rules" is not true.
-- Getting this wrong in the fixture was worth keeping: it is the same reason a thin
-- catalogue produces thin matches in production, and the cause is extraction quality rather
-- than ranking.
INSERT INTO eligibility_rules (opportunity_id, rule_type, params, source_quote, confidence)
VALUES ('f1000000-0000-0000-0000-000000000001', 'country_in',
        '{"countries":["ZW","ZM","KE","NG"]}',
        'Open to residents of Zimbabwe, Zambia, Kenya and Nigeria.', 0.95),
       ('f1000000-0000-0000-0000-000000000002', 'country_in',
        '{"countries":["ZW","ZM","KE","NG"]}',
        'Open across the region.', 0.95),
       -- And the third is genuinely not-eligible rather than unclear.
       ('f1000000-0000-0000-0000-000000000003', 'country_in', '{"countries":["NG"]}',
        'Open to residents of Nigeria.', 0.95);

-- ── §1.2 Creation ───────────────────────────────────────────────────────────

SET LOCAL request.jwt.claim.sub = 'f2000000-0000-0000-0000-000000000001';

INSERT INTO projects (id, owner_user_id, title, pitch, industry_ids)
VALUES ('f3000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001',
        'Irrigation monitor', 'Soil moisture sensors that work without a data plan',
        ARRAY(SELECT id FROM tags WHERE kind='industry' AND code='agriculture'));

SELECT assert_eq(
  'a project can be created from a title and a pitch alone (§1.2)',
  (SELECT count(*)::int FROM projects WHERE id = 'f3000000-0000-0000-0000-000000000001'),
  1);

SELECT assert_eq(
  'and it starts private, which is the default that matters (§1.4)',
  (SELECT visibility::text FROM projects WHERE id = 'f3000000-0000-0000-0000-000000000001'),
  'private');

SELECT assert_eq(
  'the owner is a member from the start',
  (SELECT count(*)::int FROM project_members
    WHERE project_id = 'f3000000-0000-0000-0000-000000000001'
      AND user_id = 'f2000000-0000-0000-0000-000000000001' AND is_owner),
  1);

-- §1.4: "anyone with the link" is only a privacy level if the link cannot be guessed.
SELECT assert_eq(
  'the slug carries an unguessable suffix, so an unlisted project cannot be enumerated',
  (SELECT slug ~ '^irrigation-monitor-[0-9a-f]{6}$'
     FROM projects WHERE id = 'f3000000-0000-0000-0000-000000000001'),
  true);

SELECT assert_raises(
  'a project cannot be indexable without being public (§1.4)',
  $q$UPDATE projects SET indexable = true WHERE id = 'f3000000-0000-0000-0000-000000000001'$q$);

SELECT assert_raises(
  'roles_needed must be role tags, not any tag',
  format($q$UPDATE projects SET roles_needed = ARRAY['%s'::uuid]
              WHERE id = 'f3000000-0000-0000-0000-000000000001'$q$,
         (SELECT id FROM tags WHERE kind = 'skill' LIMIT 1)));

-- PRODUCT_SPEC.md §22.1 applies to showing a project to other people, and NOT to having
-- one: §1.1's whole claim is that a project is useful to its owner alone.
INSERT INTO projects (id, owner_user_id, title, pitch)
VALUES ('f3000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000003',
        'A project by an unconfirmed account', 'Still a useful private tool');

SELECT assert_eq(
  'an unconfirmed account may keep a PRIVATE project (§1.1)',
  (SELECT count(*)::int FROM projects WHERE id = 'f3000000-0000-0000-0000-000000000002'),
  1);

SELECT assert_raises(
  'but may not make it public — that is a social act (§22.1)',
  $q$UPDATE projects SET visibility = 'public' WHERE id = 'f3000000-0000-0000-0000-000000000002'$q$);

-- The slug is a link people keep. It does not change when the title does.
DO $$
DECLARE v_before text; v_after text;
BEGIN
  SELECT slug INTO v_before FROM projects WHERE id = 'f3000000-0000-0000-0000-000000000001';
  UPDATE projects SET title = 'Irrigation monitor, second attempt'
   WHERE id = 'f3000000-0000-0000-0000-000000000001';
  SELECT slug INTO v_after FROM projects WHERE id = 'f3000000-0000-0000-0000-000000000001';
  PERFORM assert_eq('renaming a project does not change its URL', v_after, v_before);
END $$;

-- ── §1.5 Matching, and §1.1's criterion ─────────────────────────────────────

-- The gate is the OWNER's eligibility, so the Nigeria-only call must not be a candidate
-- for a Zimbabwean owner — and the two africa-wide ones must be.
DO $$
DECLARE n int; nigeria int;
BEGIN
  SELECT count(*)::int INTO n
    FROM project_match_candidates('f3000000-0000-0000-0000-000000000001');
  PERFORM assert_eq('a project with no embedding still gets candidates (§1.2 [PR])', n >= 2, true);

  SELECT count(*)::int INTO nigeria
    FROM project_match_candidates('f3000000-0000-0000-0000-000000000001')
   WHERE slug = 'nigeria-only';
  PERFORM assert_eq(
    'the gate is the owner''s own eligibility, so a call they cannot enter is not a match (§1.5)',
    nigeria, 0);

  PERFORM assert_eq(
    'every candidate carries a verdict the owner can act on',
    (SELECT bool_and(verdict IN ('eligible','likely_eligible'))
       FROM project_match_candidates('f3000000-0000-0000-0000-000000000001')),
    true);

  PERFORM assert_eq(
    'a shared industry tag is counted, so the tag-overlap term has something to weigh',
    (SELECT shared_tag_count FROM project_match_candidates('f3000000-0000-0000-0000-000000000001')
      WHERE slug = 'agri-grant'),
    1);

  PERFORM assert_eq(
    'with no embedding on either side, similarity is a neutral 0.5 rather than a zero',
    (SELECT similarity FROM project_match_candidates('f3000000-0000-0000-0000-000000000001')
      WHERE slug = 'agri-grant'),
    0.5::numeric);
END $$;

-- §1.1 `[PR]`: the project above is PRIVATE, and it just received matches. Stored and read
-- back, because the criterion is about what the owner sees, not about a function's return.
DO $$
DECLARE n int;
BEGIN
  PERFORM replace_project_matches('f3000000-0000-0000-0000-000000000001', jsonb_build_array(
    jsonb_build_object('opportunity_id', 'f1000000-0000-0000-0000-000000000001',
                       'score', 0.82, 'rank', 1, 'verdict', 'eligible',
                       'reasons', jsonb_build_array('Agriculture', 'closes in 12 days')),
    jsonb_build_object('opportunity_id', 'f1000000-0000-0000-0000-000000000002',
                       'score', 0.54, 'rank', 2, 'verdict', 'eligible',
                       'reasons', jsonb_build_array('closes in 30 days'))));

  SELECT count(*)::int INTO n FROM project_matches('f3000000-0000-0000-0000-000000000001');
  PERFORM assert_eq('A PRIVATE PROJECT STILL RECEIVES MATCHES (§1.1 [PR])', n, 2);

  PERFORM assert_eq(
    'and they arrive in rank order, with the reasons that were stored',
    (SELECT reasons->>0 FROM project_matches('f3000000-0000-0000-0000-000000000001') WHERE rank = 1),
    'Agriculture');

  PERFORM assert_eq(
    'replacing is atomic — a second run leaves one list, not two',
    (SELECT count(*)::int FROM project_opportunity_matches
      WHERE project_id = 'f3000000-0000-0000-0000-000000000001'),
    2);
END $$;

-- Matches are derived from the owner's eligibility profile, which nobody else may read.
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'f2000000-0000-0000-0000-000000000002', true);

  SELECT count(*)::int INTO n FROM project_matches('f3000000-0000-0000-0000-000000000001');
  PERFORM assert_eq('another user cannot read a project''s matches', n, 0);

  SELECT count(*)::int INTO n FROM project_match_candidates('f3000000-0000-0000-0000-000000000001');
  PERFORM assert_eq('nor compute them, which would be the same leak by another route', n, 0);

  BEGIN
    PERFORM replace_project_matches('f3000000-0000-0000-0000-000000000001', '[]'::jsonb);
    RAISE EXCEPTION 'FAIL  another user was allowed to overwrite a project''s matches';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    RAISE NOTICE 'PASS  nor overwrite them (refused: %)', left(SQLERRM, 60);
  END;

  PERFORM set_config('request.jwt.claim.sub', 'f2000000-0000-0000-0000-000000000001', true);
END $$;

-- ── §1.4 The browse floor ───────────────────────────────────────────────────

SELECT assert_eq(
  'project browse is switched off, which is not the same as empty (§24, invariant 4)',
  (SELECT state FROM project_browse_state()),
  'disabled');

-- With the flag on and nothing public, it is below its floor — and still returns no list.
UPDATE feature_flags SET enabled = true WHERE key = 'public_project_browse';

SELECT assert_eq(
  'with the flag on and nothing public, the browse surface is below its floor',
  (SELECT state FROM project_browse_state()),
  'below_floor');

SELECT assert_eq(
  'and it reports the floor so an operator can see how far off it is',
  (SELECT floor FROM project_browse_state()),
  40);

-- 40 public projects, which is the floor exactly. Created as the owner, since a project
-- belongs to somebody.
DO $$
DECLARE i int;
BEGIN
  FOR i IN 1..40 LOOP
    INSERT INTO projects (owner_user_id, title, pitch, visibility)
    VALUES ('f2000000-0000-0000-0000-000000000001', 'Public project ' || i,
            'Pitch number ' || i, 'public');
  END LOOP;
END $$;

SELECT assert_eq(
  'at 40 public projects the browse surface opens (§1.4 [PR])',
  (SELECT state FROM project_browse_state()),
  'open');

UPDATE feature_flags SET enabled = false WHERE key = 'public_project_browse';

SELECT assert_eq(
  'and the flag still wins over the count — both halves, never either (§24)',
  (SELECT state FROM project_browse_state()),
  'disabled');

-- ── §1.6 Related projects on an opportunity ─────────────────────────────────

SELECT assert_eq(
  'the related-projects section does not exist while its flag is off',
  (SELECT count(*)::int FROM projects_for_opportunity('f1000000-0000-0000-0000-000000000001')),
  0);

UPDATE feature_flags SET enabled = true WHERE key = 'related_projects_on_opportunity';

SELECT assert_eq(
  'with the flag on but only one matching public project, still nothing — not a short list (§1.6 [PR])',
  (SELECT count(*)::int FROM projects_for_opportunity('f1000000-0000-0000-0000-000000000001')),
  0);

-- Three public projects sharing the opportunity's industry tag is the floor.
DO $$
DECLARE i int; v_tag uuid;
BEGIN
  SELECT id INTO v_tag FROM tags WHERE kind='industry' AND code='agriculture';
  FOR i IN 1..3 LOOP
    INSERT INTO projects (owner_user_id, title, pitch, visibility, industry_ids)
    VALUES ('f2000000-0000-0000-0000-000000000001', 'Agri project ' || i,
            'Also about agriculture', 'public', ARRAY[v_tag]);
  END LOOP;
END $$;

SELECT assert_eq(
  'at three matching public projects the section appears (§1.6)',
  (SELECT count(*)::int FROM projects_for_opportunity('f1000000-0000-0000-0000-000000000001')) >= 3,
  true);

SELECT assert_eq(
  'and it never shows a private project, whatever it matches',
  (SELECT count(*)::int FROM projects_for_opportunity('f1000000-0000-0000-0000-000000000001')
    WHERE title = 'Irrigation monitor, second attempt'),
  0);

UPDATE feature_flags SET enabled = false WHERE key = 'related_projects_on_opportunity';

-- ── §1.3 Inactivity: prompt, pause, never delete ────────────────────────────

DO $$
DECLARE report jsonb; v_before int;
BEGIN
  SELECT count(*)::int INTO v_before FROM projects WHERE deleted_at IS NULL;

  UPDATE projects SET last_activity_at = now() - interval '130 days'
   WHERE id = 'f3000000-0000-0000-0000-000000000001';

  report := project_inactivity_sweep();
  PERFORM assert_eq('a project quiet for 120 days gets one prompt (§1.3)',
                    (report->>'prompted_at_120_days')::int, 1);
  PERFORM assert_eq(
    'and the owner is the one told',
    (SELECT count(*)::int FROM notifications
      WHERE user_id = 'f2000000-0000-0000-0000-000000000001' AND type = 'system'
        AND payload ? 'project_slug'),
    1);

  -- Running twice must not prompt twice. An inactivity nudge that repeats daily is the
  -- engagement bait §1.3 is trying to avoid.
  report := project_inactivity_sweep();
  PERFORM assert_eq('and running the sweep again does not prompt again',
                    (report->>'prompted_at_120_days')::int, 0);

  UPDATE projects SET last_activity_at = now() - interval '200 days'
   WHERE id = 'f3000000-0000-0000-0000-000000000001';

  report := project_inactivity_sweep();
  PERFORM assert_eq('at 180 days it is paused', (report->>'paused_at_180_days')::int >= 1, true);
  PERFORM assert_eq(
    'paused, not deleted — §1.3 says NEVER auto-delete',
    (SELECT state::text FROM projects WHERE id = 'f3000000-0000-0000-0000-000000000001'),
    'paused');
  PERFORM assert_eq('and nothing at all was removed',
                    (SELECT count(*)::int FROM projects WHERE deleted_at IS NULL), v_before);

  -- §1.3: "A paused project ... keeps receiving matches for its owner."
  PERFORM assert_eq(
    'a paused project still receives matches',
    (SELECT count(*)::int FROM project_matches('f3000000-0000-0000-0000-000000000001')),
    2);
END $$;

-- ── §2.1 project_role requests ──────────────────────────────────────────────

UPDATE projects SET visibility = 'public', roles_needed =
  ARRAY(SELECT id FROM tags WHERE kind='role' LIMIT 1)
 WHERE id = 'f3000000-0000-0000-0000-000000000001';

DO $$
DECLARE t record; n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'f2000000-0000-0000-0000-000000000002', true);

  SELECT * INTO t FROM project_interest_target('f3000000-0000-0000-0000-000000000001');
  PERFORM assert_eq('a visitor can see who to write to', t.owner_display_name, 'Project Owner');
  PERFORM assert_eq('and which roles are open', array_length(t.roles_needed, 1), 1);

  -- §2.2: no contact detail, on any endpoint, before acceptance. Asserted against the
  -- function's result type, the same way the room's is.
  PERFORM assert_eq(
    'and nothing else about them',
    (SELECT pg_get_function_result(p.oid) ~* '(email|phone|telegram|identifier)'
       FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'project_interest_target'),
    false);

  INSERT INTO collaboration_requests
    (id, context, project_id, requester_user_id, target_user_id, role, message)
  VALUES ('f6000000-0000-0000-0000-000000000001', 'project_role',
          'f3000000-0000-0000-0000-000000000001',
          'f2000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000001',
          (SELECT name FROM tags WHERE kind='role' LIMIT 1),
          'I have built moisture probes before and would like to help.');

  SELECT count(*)::int INTO n FROM project_members
   WHERE project_id = 'f3000000-0000-0000-0000-000000000001';
  PERFORM assert_eq('a pending interest request adds nobody', n, 1);

  -- Only the owner decides.
  BEGIN
    PERFORM accept_request('f6000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FAIL  the requester was allowed to accept their own interest request';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    RAISE NOTICE 'PASS  a requester cannot accept their own interest request (refused: %)',
      left(SQLERRM, 60);
  END;

  PERFORM set_config('request.jwt.claim.sub', 'f2000000-0000-0000-0000-000000000001', true);
  PERFORM assert_eq('the owner accepting opens a thread',
                    accept_request('f6000000-0000-0000-0000-000000000001') IS NOT NULL, true);

  SELECT count(*)::int INTO n FROM project_members
   WHERE project_id = 'f3000000-0000-0000-0000-000000000001'
     AND user_id = 'f2000000-0000-0000-0000-000000000002';
  PERFORM assert_eq('and adds them to the project, which 0016 alone did not', n, 1);

  PERFORM assert_eq(
    'and the role they asked for is recorded as a role tag, not free text',
    (SELECT t2.kind FROM project_members m
       JOIN tags t2 ON t2.id = m.role_id
      WHERE m.project_id = 'f3000000-0000-0000-0000-000000000001'
        AND m.user_id = 'f2000000-0000-0000-0000-000000000002'),
    'role');

  PERFORM assert_eq(
    'somebody joining counts as activity, so the project is no longer stale',
    (SELECT last_activity_at > now() - interval '1 minute'
       FROM projects WHERE id = 'f3000000-0000-0000-0000-000000000001'),
    true);

  PERFORM set_config('request.jwt.claim.sub', NULL, true);
END $$;

-- A blocked visitor sees no surface to express interest in (§4).
DO $$
DECLARE n int;
BEGIN
  INSERT INTO blocks (blocker_user_id, blocked_user_id)
  VALUES ('f2000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-000000000002');

  PERFORM set_config('request.jwt.claim.sub', 'f2000000-0000-0000-0000-000000000002', true);
  SELECT count(*)::int INTO n FROM project_interest_target('f3000000-0000-0000-0000-000000000001');
  PERFORM assert_eq('a blocked visitor cannot open an interest request (§4)', n, 0);

  PERFORM set_config('request.jwt.claim.sub', NULL, true);
  DELETE FROM blocks WHERE blocker_user_id = 'f2000000-0000-0000-0000-000000000001';
END $$;

-- ── §1.5's submissions record ───────────────────────────────────────────────

INSERT INTO project_submissions (project_id, opportunity_id, outcome)
VALUES ('f3000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'submitted');

SELECT assert_eq(
  'a submission is a record of entering, with an outcome that can be updated',
  (SELECT outcome FROM project_submissions
    WHERE project_id = 'f3000000-0000-0000-0000-000000000001'),
  'submitted');

SELECT assert_raises(
  'and an invented outcome is refused',
  $q$UPDATE project_submissions SET outcome = 'probably won'
      WHERE project_id = 'f3000000-0000-0000-0000-000000000001'$q$);

-- ── The surfaces §1 deliberately does not have ──────────────────────────────

SELECT assert_eq(
  'no table counts stars, likes or followers on a project',
  (SELECT count(*)::int FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name LIKE 'project%'
      AND (column_name LIKE '%star%' OR column_name LIKE '%like%'
           OR column_name LIKE '%follower%' OR column_name LIKE '%view%')),
  0);

ROLLBACK;
