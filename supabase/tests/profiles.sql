-- The public builder profile. PRODUCT_SPEC.md §16, UX_FLOWS.md §8.2, SEO.md §1.
--
-- Everything asserted here is a decision about who can see somebody's name, and every one of
-- them has a wrong answer that is invisible from the outside:
--
--   A `private` profile that returns a row looks identical to a `public` one in the page code.
--   A `discoverable_in_rooms` profile returned to a stranger looks identical to one returned
--   to a room-mate. A suspended account whose page stays up looks like any other page.
--
-- So the read path is asserted from four viewpoints — nobody, a stranger, a room-mate, and
-- the owner — against all three visibility levels, because the function is the only thing
-- standing between them.

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

INSERT INTO users (id, email, age_confirmed_18, display_name, handle) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'open@example.invalid',    true, 'Open Builder',   'openbuilder'),
  ('d0000000-0000-0000-0000-000000000002', 'rooms@example.invalid',   true, 'Room Builder',   'roombuilder'),
  ('d0000000-0000-0000-0000-000000000003', 'private@example.invalid', true, 'Quiet Builder',  'quietbuilder'),
  ('d0000000-0000-0000-0000-000000000004', 'mate@example.invalid',    true, 'A Room Mate',    'roommate'),
  ('d0000000-0000-0000-0000-000000000005', 'stranger@example.invalid',true, 'A Stranger',     'stranger'),
  ('d0000000-0000-0000-0000-000000000006', 'gone@example.invalid',    true, 'Suspended One',  'suspendedone');

INSERT INTO profiles (user_id, visibility, indexable, headline, bio, country_iso2, city, github_url, open_to)
VALUES
  ('d0000000-0000-0000-0000-000000000001', 'public', true, 'Builds irrigation sensors',
   'Ten years of field work in Matabeleland.', 'ZW', 'Bulawayo', 'https://github.example/open', '{hackathons}'),
  ('d0000000-0000-0000-0000-000000000002', 'discoverable_in_rooms', false, 'Backend, mostly Go',
   NULL, 'KE', NULL, NULL, '{teams}'),
  ('d0000000-0000-0000-0000-000000000003', 'private', false, 'Nothing to see', NULL, 'GH', NULL, NULL, '{}'),
  ('d0000000-0000-0000-0000-000000000004', 'public', false, 'Front end', NULL, 'ZW', NULL, NULL, '{}'),
  ('d0000000-0000-0000-0000-000000000006', 'public', true, 'Was here', NULL, 'NG', NULL, NULL, '{}');

UPDATE users SET account_state = 'suspended' WHERE id = 'd0000000-0000-0000-0000-000000000006';

-- A shared room: the room builder and the room mate both hold a live intent on the same
-- opportunity. The stranger holds one on a different opportunity, which must not count.
INSERT INTO organisations (id, name, slug) VALUES
  ('d1000000-0000-0000-0000-000000000001', 'A Host', 'a-host-for-profiles');

INSERT INTO opportunities (id, slug, title, organisation_id, category_id, status, cost,
                           source_url, last_verified_at, deadline_at)
SELECT ('d2000000-0000-0000-0000-00000000000' || n)::uuid,
       'profile-fixture-' || n,
       'Profile fixture ' || n,
       'd1000000-0000-0000-0000-000000000001',
       (SELECT id FROM categories ORDER BY code LIMIT 1),
       'published', 'free',
       'https://example.invalid/profile-fixture',
       now(), now() + interval '30 days'
  FROM generate_series(1, 2) AS n;

INSERT INTO intents (user_id, opportunity_id, stance, expires_at) VALUES
  ('d0000000-0000-0000-0000-000000000002', 'd2000000-0000-0000-0000-000000000001', 'looking_for_team', now() + interval '20 days'),
  ('d0000000-0000-0000-0000-000000000004', 'd2000000-0000-0000-0000-000000000001', 'looking_for_team', now() + interval '20 days'),
  ('d0000000-0000-0000-0000-000000000005', 'd2000000-0000-0000-0000-000000000002', 'looking_for_team', now() + interval '20 days');

-- ── Handle hygiene ──────────────────────────────────────────────────────────

SELECT assert_eq('a handle is stored lower case whatever was typed',
  (SELECT handle::text FROM users WHERE id = 'd0000000-0000-0000-0000-000000000001'), 'openbuilder');

DO $$
BEGIN
  UPDATE users SET handle = 'MixedCase' WHERE id = 'd0000000-0000-0000-0000-000000000005';
END $$;
SELECT assert_eq('and normalised on the way in, not merely refused',
  (SELECT handle::text FROM users WHERE id = 'd0000000-0000-0000-0000-000000000005'), 'mixedcase');

SELECT assert_raises('a handle that impersonates the product is refused',
  $$UPDATE users SET handle = 'admin' WHERE id = 'd0000000-0000-0000-0000-000000000005'$$);
SELECT assert_raises('so is one that reads as a route',
  $$UPDATE users SET handle = 'opportunities' WHERE id = 'd0000000-0000-0000-0000-000000000005'$$);
SELECT assert_raises('a handle with a space in it is refused',
  $$UPDATE users SET handle = 'two words' WHERE id = 'd0000000-0000-0000-0000-000000000005'$$);
SELECT assert_raises('and one that ends in a separator',
  $$UPDATE users SET handle = 'trailing-' WHERE id = 'd0000000-0000-0000-0000-000000000005'$$);
SELECT assert_raises('two people cannot hold the same handle, whatever the case',
  $$UPDATE users SET handle = 'OpenBuilder' WHERE id = 'd0000000-0000-0000-0000-000000000005'$$);

-- ── Who can read what ───────────────────────────────────────────────────────

-- Signed out.
DO $$ BEGIN PERFORM set_config('request.jwt.claim.sub', NULL, true); END $$;

SELECT assert_eq('a public profile is readable by a signed-out visitor',
  (SELECT display_name FROM public_profile('openbuilder')), 'Open Builder');
SELECT assert_eq('and carries the country name, not only the code',
  (SELECT country_name FROM public_profile('openbuilder')), 'Zimbabwe');
SELECT assert_eq('a discoverable-in-rooms profile is not',
  (SELECT count(*) FROM public_profile('roombuilder')), 0::bigint);
SELECT assert_eq('a private profile is not',
  (SELECT count(*) FROM public_profile('quietbuilder')), 0::bigint);
SELECT assert_eq('a suspended account has no public page, whatever its visibility says',
  (SELECT count(*) FROM public_profile('suspendedone')), 0::bigint);
SELECT assert_eq('an unknown handle is nothing, not an error',
  (SELECT count(*) FROM public_profile('nobody-at-all')), 0::bigint);
SELECT assert_eq('an empty handle is nothing',
  (SELECT count(*) FROM public_profile('')), 0::bigint);
SELECT assert_eq('a signed-out visitor shares no context with anyone',
  (SELECT shared_context FROM public_profile('openbuilder')), false);

-- A stranger: signed in, no shared intent.
DO $$ BEGIN PERFORM set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000005', true); END $$;

SELECT assert_eq('a stranger cannot read a discoverable-in-rooms profile',
  (SELECT count(*) FROM public_profile('roombuilder')), 0::bigint);
SELECT assert_eq('and shares no context with a public one either',
  (SELECT shared_context FROM public_profile('openbuilder')), false);

-- A room mate: shares an active intent on the same opportunity.
DO $$ BEGIN PERFORM set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000004', true); END $$;

SELECT assert_eq('a room-mate CAN read a discoverable-in-rooms profile',
  (SELECT display_name FROM public_profile('roombuilder')), 'Room Builder');
SELECT assert_eq('and the page is told there is a shared context to ask from',
  (SELECT shared_context FROM public_profile('roombuilder')), true);
SELECT assert_eq('with the opportunity it is, so the request composer knows what it is for',
  (SELECT shared_opportunity_slug FROM public_profile('roombuilder')), 'profile-fixture-1');
SELECT assert_eq('a room-mate still cannot read a private profile',
  (SELECT count(*) FROM public_profile('quietbuilder')), 0::bigint);

-- The room ends: a withdrawn intent is not a shared context.
UPDATE intents SET withdrawn_at = now()
 WHERE user_id = 'd0000000-0000-0000-0000-000000000004';

SELECT assert_eq('withdrawing the intent closes the window again',
  (SELECT count(*) FROM public_profile('roombuilder')), 0::bigint);

-- The owner.
DO $$ BEGIN PERFORM set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000003', true); END $$;

SELECT assert_eq('the owner of a private profile can always read their own',
  (SELECT display_name FROM public_profile('quietbuilder')), 'Quiet Builder');
SELECT assert_eq('but shares no context with themselves',
  (SELECT shared_context FROM public_profile('quietbuilder')), false);

-- ── What it must never return ───────────────────────────────────────────────

DO $$ BEGIN PERFORM set_config('request.jwt.claim.sub', NULL, true); END $$;

-- The private layer is not reachable through this function, by construction: assert the
-- shape, which is stronger than asserting one absent value.
--
-- The count of ALL parameters is asserted first, because "no row matches these names" is also
-- what an empty catalogue query returns — the guard against an assertion that measures nothing.
SELECT assert_eq('the result shape is visible to this check at all',
  (SELECT count(*) > 10 FROM information_schema.parameters
    WHERE specific_schema = 'public'
      AND specific_name IN (SELECT specific_name FROM information_schema.routines
                             WHERE routine_name = 'public_profile')), true);
SELECT assert_eq('no eligibility-profile field is in the result shape at all (invariant 6)',
  (SELECT count(*) FROM information_schema.parameters
    WHERE specific_schema = 'public'
      AND specific_name IN (SELECT specific_name FROM information_schema.routines
                             WHERE routine_name = 'public_profile')
      AND parameter_name IN ('birth_year','student_status','nationalities','country_of_residence',
                             'gender','languages','years_experience','institution_name')), 0::bigint);

SELECT assert_eq('and no email address either',
  (SELECT count(*) FROM information_schema.parameters
    WHERE specific_schema = 'public'
      AND specific_name IN (SELECT specific_name FROM information_schema.routines
                             WHERE routine_name = 'public_profile')
      AND parameter_name = 'email'), 0::bigint);

SELECT assert_eq('the indexable opt-in is separate from visibility and defaults off',
  (SELECT indexable FROM public_profile('roommate')), false);

ROLLBACK;
