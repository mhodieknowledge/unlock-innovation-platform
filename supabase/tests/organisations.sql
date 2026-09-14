-- Organisations, self-serve. PRODUCT_SPEC.md §19, MODERATION_AND_TRUST.md §9, and Phase 7's
-- two acceptance criteria:
--
--   "A domain-matched claim completes end to end."
--   "An organisation edit to a deadline re-enters review and notifies trackers."
--
-- The first is tested through the functions a route would call, in order, including the part
-- that must NOT work: a claim from a non-matching address must not produce a token, because
-- a token is the thing that skips human review.
--
-- The second is tested by editing a deadline AS a member and reading back the status, the
-- verification, the queue and the tracker's inbox. All four change together or the criterion
-- is not met — a record sent back to review that nobody was told about is worse than one
-- left alone, because the person tracking it still believes the old date.

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

INSERT INTO organisations (id, name, slug, website_url, website_domain, verification)
VALUES
  ('ba000000-0000-0000-0000-000000000001', 'Kavango Foundation', 'kavango-foundation',
   'https://www.kavango.example', 'kavango.example', 'unclaimed'),
  ('ba000000-0000-0000-0000-000000000002', 'Second Org', 'second-org',
   'https://second.example', 'second.example', 'unclaimed');

INSERT INTO users (id, email, age_confirmed_18, display_name) VALUES
  ('bb000000-0000-0000-0000-000000000001', 'programme.officer@kavango.example', true, 'Programme Officer'),
  ('bb000000-0000-0000-0000-000000000002', 'someone@gmail.example', true, 'Someone Else'),
  ('bb000000-0000-0000-0000-000000000003', 'tracker@example.invalid', true, 'A Tracker'),
  ('bb000000-0000-0000-0000-000000000009', 'admin@example.invalid', true, 'An Admin');

UPDATE users SET is_admin = true, admin_role = 'superadmin'
 WHERE id = 'bb000000-0000-0000-0000-000000000009';

-- ── Domain normalisation, which the whole control rests on ──────────────────

SELECT assert_eq('a leading www is not part of the domain',
  normalise_domain('https://www.kavango.example'), 'kavango.example');
SELECT assert_eq('nor is the scheme', normalise_domain('HTTPS://Kavango.Example'), 'kavango.example');
SELECT assert_eq('an email domain is the part after the @',
  email_domain('Programme.Officer@Kavango.Example'), 'kavango.example');
SELECT assert_eq('an address with no domain is nothing, not an empty match',
  email_domain('not-an-email'), NULL::text);

-- A subdomain is NOT a match. It fails toward human review, which is the right direction
-- for a control that decides who may publish as an institution.
SELECT assert_eq('a subdomain address does not auto-match',
  email_domain('officer@mail.kavango.example') = normalise_domain('kavango.example'), false);

-- ── Criterion 1: a domain-matched claim, end to end ─────────────────────────

SET LOCAL request.jwt.claim.sub = 'bb000000-0000-0000-0000-000000000001';

DO $$
DECLARE r record; v_token text; c record;
BEGIN
  SELECT * INTO r FROM start_org_claim('kavango-foundation', 'programme.officer@kavango.example');

  PERFORM assert_eq('a matching address is recognised server-side', r.domain_matches, true);
  PERFORM assert_eq('and the claim is pending confirmation, not review', r.status, 'pending');

  PERFORM assert_eq(
    'the organisation reads as claim-pending, so its page stops inviting claims',
    (SELECT verification::text FROM organisations WHERE slug = 'kavango-foundation'),
    'claimed_pending');

  -- The confirmation is an email, and it is NOT capped, paused or opt-out-able: §9 gives
  -- security messages no switch, and this is a message the person just asked for.
  PERFORM assert_eq(
    'the claimant is sent a confirmation',
    (SELECT count(*)::int FROM notifications
      WHERE user_id = 'bb000000-0000-0000-0000-000000000001' AND type = 'security'
        AND payload->>'kind' = 'org_claim'),
    1);

  PERFORM assert_eq(
    'and it is addressed to the claimed address rather than the account address',
    (SELECT payload->>'email_override' FROM notifications
      WHERE user_id = 'bb000000-0000-0000-0000-000000000001'
        AND payload->>'kind' = 'org_claim'),
    'programme.officer@kavango.example');

  -- THE TOKEN IS NOT IN THE NOTIFICATION. A token the claimant can read in their own inbox
  -- would prove nothing about who controls the organisation's mailbox — it would make the
  -- domain check decorative.
  SELECT token INTO v_token FROM organisation_claims WHERE id = r.claim_id;
  PERFORM assert_eq('a token exists for a matched claim', length(v_token) >= 40, true);
  PERFORM assert_eq(
    'but it is nowhere in the notification the claimant can read',
    (SELECT payload::text NOT LIKE '%' || v_token || '%' FROM notifications
      WHERE user_id = 'bb000000-0000-0000-0000-000000000001'
        AND payload->>'kind' = 'org_claim'),
    true);

  -- Nor is it readable through the claimant's own view of their claims.
  PERFORM assert_eq(
    'the claimant can see their claim',
    (SELECT count(*)::int FROM my_org_claims() WHERE claim_id = r.claim_id),
    1);
  PERFORM assert_eq(
    'and that view cannot return a token at all',
    (SELECT pg_get_function_result(p.oid) ILIKE '%token%'
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'my_org_claims'),
    false);

  -- Confirming it. This is the whole criterion.
  SELECT * INTO c FROM confirm_org_claim(v_token);
  PERFORM assert_eq('confirming the token works', c.ok, true);
  PERFORM assert_eq('and names the organisation back', c.organisation_slug, 'kavango-foundation');

  PERFORM assert_eq(
    'the organisation is verified, with no human involved (§19)',
    (SELECT verification::text FROM organisations WHERE slug = 'kavango-foundation'),
    'verified');
  PERFORM assert_eq(
    'and the date is recorded, because the badge states it',
    (SELECT verified_at IS NOT NULL FROM organisations WHERE slug = 'kavango-foundation'),
    true);
  PERFORM assert_eq(
    'the claimant becomes an owner',
    (SELECT role FROM organisation_members
      WHERE organisation_id = 'ba000000-0000-0000-0000-000000000001'
        AND user_id = 'bb000000-0000-0000-0000-000000000001'),
    'owner');

  -- Single use, and the same answer for every kind of bad token.
  SELECT * INTO c FROM confirm_org_claim(v_token);
  PERFORM assert_eq('a spent token does not work twice', c.ok, false);
  SELECT * INTO c FROM confirm_org_claim('deadbeef' || repeat('0', 40));
  PERFORM assert_eq('and an invented one says exactly the same thing', c.ok, false);
END $$;

-- Already verified: no second claim.
SELECT assert_raises(
  'a verified organisation cannot be claimed again',
  $q$SELECT start_org_claim('kavango-foundation', 'someone@kavango.example')$q$);

RESET request.jwt.claim.sub;

-- The dispatcher must send the confirmation to the CLAIMED address, not the account's.
SET LOCAL request.jwt.claim.sub = 'bb000000-0000-0000-0000-000000000001';
DO $$
DECLARE v_claim uuid; v_row record;
BEGIN
  -- A fresh claim on the second organisation, so there is an unsent confirmation to claim.
  UPDATE organisations SET verification = 'unclaimed' WHERE slug = 'second-org';
  SELECT claim_id INTO v_claim FROM start_org_claim('second-org', 'officer@second.example');

  -- The dispatcher's own view of what to send, through the function the batch tier calls.
  SELECT * INTO v_row FROM claim_deliveries('email', 50) d
   WHERE d.payload->>'kind' = 'org_claim' AND (d.payload->>'claim_id')::uuid = v_claim;

  PERFORM assert_eq(
    'the dispatcher addresses the confirmation to the claimed address, not the account''s',
    v_row.address, 'officer@second.example');

  PERFORM assert_eq(
    'and it is priority 1, so no budget rule can defer it',
    v_row.priority::int, 1);

  -- Reset for the section below, which starts from an unclaimed second-org.
  UPDATE organisation_claims SET status = 'rejected', token = NULL
   WHERE organisation_id = 'ba000000-0000-0000-0000-000000000002';
  UPDATE organisations SET verification = 'unclaimed' WHERE slug = 'second-org';
END $$;
RESET request.jwt.claim.sub;

-- ── §9: a non-matching claim gets review, and NO token ──────────────────────

SET LOCAL request.jwt.claim.sub = 'bb000000-0000-0000-0000-000000000002';

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM start_org_claim('second-org', 'someone@gmail.example',
                                       'https://second.example/team');

  PERFORM assert_eq('a non-matching address is not treated as a match', r.domain_matches, false);
  PERFORM assert_eq('it waits for a human (§9)', r.status, 'awaiting_review');

  PERFORM assert_eq(
    'and NO token is issued, because a token is what skips the review',
    (SELECT token IS NULL FROM organisation_claims WHERE id = r.claim_id),
    true);

  PERFORM assert_eq(
    'the claim is queued at the priority MODERATION_AND_TRUST.md §7 gives it',
    (SELECT priority::int FROM review_queue
      WHERE queue = 'org_claim' AND subject_id = 'ba000000-0000-0000-0000-000000000002'),
    3);

  PERFORM assert_eq(
    'no confirmation email is sent for a claim that has not been reviewed',
    (SELECT count(*)::int FROM notifications
      WHERE user_id = 'bb000000-0000-0000-0000-000000000002'
        AND payload->>'kind' = 'org_claim'),
    0);

  PERFORM assert_eq('and the organisation is not verified by asking',
    (SELECT verification::text FROM organisations WHERE slug = 'second-org'),
    'claimed_pending');
END $$;

-- One at a time, and three a day.
SELECT assert_raises(
  'a second claim on the same organisation by the same person is refused',
  $q$SELECT start_org_claim('second-org', 'someone.else@gmail.example')$q$);

RESET request.jwt.claim.sub;

-- A non-admin cannot approve anything.
SET LOCAL request.jwt.claim.sub = 'bb000000-0000-0000-0000-000000000002';
SELECT assert_raises(
  'a claimant cannot approve their own claim',
  $q$SELECT review_org_claim(
       (SELECT id FROM organisation_claims WHERE user_id = 'bb000000-0000-0000-0000-000000000002'),
       true)$q$);
RESET request.jwt.claim.sub;

-- An admin can, and approval runs the same path a confirmation does.
SET LOCAL request.jwt.claim.sub = 'bb000000-0000-0000-0000-000000000009';

DO $$
DECLARE v_claim uuid;
BEGIN
  SELECT id INTO v_claim FROM organisation_claims
   WHERE user_id = 'bb000000-0000-0000-0000-000000000002';

  PERFORM assert_eq('an admin can approve a reviewed claim',
                    review_org_claim(v_claim, true, 'Checked the staff page.'), true);

  PERFORM assert_eq(
    'and the organisation ends up in exactly the state a matched claim reaches',
    (SELECT verification::text FROM organisations WHERE slug = 'second-org'),
    'verified');

  PERFORM assert_eq(
    'the queue row is closed rather than left for the next reviewer',
    (SELECT count(*)::int FROM review_queue
      WHERE queue = 'org_claim' AND subject_id = 'ba000000-0000-0000-0000-000000000002'
        AND state <> 'done'),
    0);

  PERFORM assert_eq(
    'and the decision is audited',
    (SELECT count(*)::int FROM admin_audit_log
      WHERE action = 'org_claim_approve' AND subject_id = v_claim),
    1);

  PERFORM assert_eq(
    'no token survives an approved claim',
    (SELECT token IS NULL FROM organisation_claims WHERE id = v_claim),
    true);
END $$;

RESET request.jwt.claim.sub;

-- ── §19: an organisation publishes as `official` ────────────────────────────

SET LOCAL request.jwt.claim.sub = 'bb000000-0000-0000-0000-000000000001';

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM org_submit_opportunity(
    'kavango-foundation', 'Kavango Climate Innovation Fund 2027', 'grant',
    'Funding for climate adaptation work in Southern Africa.',
    'Longer description.', 'https://kavango.example/apply',
    now() + interval '45 days');

  PERFORM assert_eq('an organisation''s own listing publishes (§19)', r.status, 'published');
  PERFORM assert_eq(
    'and it publishes as official, which only this path may claim',
    (SELECT verification::text FROM opportunities WHERE slug = r.opportunity_slug),
    'official');
  PERFORM assert_eq(
    'the submitter is recorded',
    (SELECT submitted_by_user_id FROM opportunities WHERE slug = r.opportunity_slug),
    'bb000000-0000-0000-0000-000000000001'::uuid);

  -- MODERATION_AND_TRUST.md §2: a paid-entry listing goes to a human whoever submitted it.
  -- An organisation's word is good enough to publish, and not good enough to charge people.
  SELECT * INTO r FROM org_submit_opportunity(
    'kavango-foundation', 'A programme with an entry fee attached', 'grant',
    'Summary.', NULL, 'https://kavango.example/fee',
    now() + interval '30 days', 'date_only', 'paid');

  PERFORM assert_eq('a paid-entry listing does not publish on anyone''s word', r.status, 'in_review');
  PERFORM assert_eq(
    'and it is queued for a human',
    (SELECT count(*)::int FROM review_queue q
       JOIN opportunities o ON o.id = q.subject_id
      WHERE o.slug = r.opportunity_slug AND q.queue = 'paid_cost'),
    1);
END $$;

RESET request.jwt.claim.sub;

-- Someone who is not a member cannot publish as the organisation.
SET LOCAL request.jwt.claim.sub = 'bb000000-0000-0000-0000-000000000003';
SELECT assert_raises(
  'a stranger cannot publish as an organisation',
  $q$SELECT org_submit_opportunity('kavango-foundation', 'A listing I should not be able to make',
        'grant', NULL, NULL, NULL, now() + interval '10 days')$q$);
RESET request.jwt.claim.sub;

-- ── Criterion 2: an edit to a deadline re-enters review and tells trackers ──

-- Somebody is tracking it. They acted on the old date, which is the whole reason the rule
-- exists.
INSERT INTO tracker_entries (user_id, opportunity_id, state)
SELECT 'bb000000-0000-0000-0000-000000000003', o.id, 'planning_to_apply'
  FROM opportunities o WHERE o.slug LIKE 'kavango-climate-innovation-fund-2027%';

SET LOCAL request.jwt.claim.sub = 'bb000000-0000-0000-0000-000000000001';

DO $$
DECLARE v_id uuid; v_slug text;
BEGIN
  SELECT id, slug INTO v_id, v_slug FROM opportunities
   WHERE slug LIKE 'kavango-climate-innovation-fund-2027%';

  -- A harmless edit first: fixing a typo must not cost an organisation its published
  -- state, or we teach them not to fix typos.
  UPDATE opportunities SET summary = 'Funding for climate adaptation work across the region.'
   WHERE id = v_id;

  PERFORM assert_eq('editing a summary changes nothing about review',
    (SELECT status::text FROM opportunities WHERE id = v_id), 'published');
  PERFORM assert_eq('and nothing about verification',
    (SELECT verification::text FROM opportunities WHERE id = v_id), 'official');
  PERFORM assert_eq('and tells nobody',
    (SELECT count(*)::int FROM notifications
      WHERE user_id = 'bb000000-0000-0000-0000-000000000003' AND type = 'opportunity_changed'),
    0);

  -- Now the deadline. This is the criterion.
  UPDATE opportunities SET deadline_at = now() + interval '20 days' WHERE id = v_id;

  PERFORM assert_eq(
    'changing a deadline sends the record back into review (§19 [PR])',
    (SELECT status::text FROM opportunities WHERE id = v_id),
    'in_review');

  PERFORM assert_eq(
    'and it stops being official until a human has looked',
    (SELECT verification::text FROM opportunities WHERE id = v_id),
    'auto');

  PERFORM assert_eq(
    'a reviewer has something to look at',
    (SELECT count(*)::int FROM review_queue
      WHERE subject_id = v_id AND queue = 'ugc' AND state <> 'done'),
    1);

  PERFORM assert_eq(
    'and everyone tracking it is told (Phase 7 criterion 2)',
    (SELECT count(*)::int FROM notifications
      WHERE user_id = 'bb000000-0000-0000-0000-000000000003'
        AND type = 'opportunity_changed'),
    1);

  PERFORM assert_eq(
    'the message names what changed rather than saying "something changed"',
    (SELECT payload->>'changed' FROM notifications
      WHERE user_id = 'bb000000-0000-0000-0000-000000000003'
        AND type = 'opportunity_changed'),
    'deadline');

  -- Eligibility and cost are the other two §19 names.
  UPDATE opportunities SET status = 'published', verification = 'official' WHERE id = v_id;
  UPDATE review_queue SET state = 'done' WHERE subject_id = v_id;

  UPDATE opportunities SET eligible_countries = ARRAY['ZW','ZM']::char(2)[],
                           eligibility_scope = 'country_list'
   WHERE id = v_id;
  PERFORM assert_eq('a changed eligibility rule re-enters review too',
    (SELECT status::text FROM opportunities WHERE id = v_id), 'in_review');

  UPDATE opportunities SET status = 'published', verification = 'official' WHERE id = v_id;
  UPDATE opportunities SET cost = 'paid' WHERE id = v_id;
  PERFORM assert_eq('and so does a changed cost',
    (SELECT status::text FROM opportunities WHERE id = v_id), 'in_review');
END $$;

RESET request.jwt.claim.sub;

-- An admin's edit IS the review, so it must not bounce back into the queue it came from.
SET LOCAL request.jwt.claim.sub = 'bb000000-0000-0000-0000-000000000009';
DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM opportunities WHERE slug LIKE 'kavango-climate-innovation-fund-2027%';
  UPDATE opportunities SET status = 'published', verification = 'verified', cost = 'free'
   WHERE id = v_id;
  UPDATE opportunities SET deadline_at = now() + interval '25 days' WHERE id = v_id;

  PERFORM assert_eq('an admin editing a deadline does not send it back to review',
    (SELECT status::text FROM opportunities WHERE id = v_id), 'published');
END $$;
RESET request.jwt.claim.sub;

-- The working list an organisation manages its listings from.
SET LOCAL request.jwt.claim.sub = 'bb000000-0000-0000-0000-000000000001';
SELECT assert_eq(
  'an organisation sees its own listings, including the ones in review',
  (SELECT count(*)::int FROM org_opportunities('kavango-foundation')) >= 2,
  true);
SELECT assert_eq(
  'with the number of people tracking each, which is what makes an edit consequential',
  (SELECT max(tracked_by) FROM org_opportunities('kavango-foundation')),
  1);
RESET request.jwt.claim.sub;

SET LOCAL request.jwt.claim.sub = 'bb000000-0000-0000-0000-000000000003';
SELECT assert_eq(
  'and nobody else sees that list at all',
  (SELECT count(*)::int FROM org_opportunities('kavango-foundation')),
  0);
RESET request.jwt.claim.sub;

-- ── §12's public submission: anyone may suggest, nothing publishes ──────────

DO $$
DECLARE r record; v_key text := 'test-ip-hash-1';
BEGIN
  SELECT * INTO r FROM submit_opportunity_public(
    v_key, 'A grant somebody spotted on a notice board',
    'https://example.invalid/some-grant', 'grant',
    'Saw this at the university library.', 'Some Foundation', 'end of March');

  PERFORM assert_eq('anyone can suggest an opportunity', r.ok, true);

  PERFORM assert_eq(
    'and it lands as a draft, which is on no surface at all (§12)',
    (SELECT status::text FROM opportunities WHERE source_url = 'https://example.invalid/some-grant'),
    'draft');

  PERFORM assert_eq(
    'with a queue row for a human',
    (SELECT count(*)::int FROM review_queue q
       JOIN opportunities o ON o.id = q.subject_id
      WHERE o.source_url = 'https://example.invalid/some-grant' AND q.queue = 'ugc'),
    1);

  PERFORM assert_eq(
    'and the reviewer is told whether it came with a Turnstile token',
    (SELECT (after->>'turnstile_verified') FROM admin_audit_log
      WHERE action = 'public_submission'
      ORDER BY ts DESC LIMIT 1),
    'false');

  -- Re-submitting the same URL is thanked, not counted as new work.
  SELECT * INTO r FROM submit_opportunity_public(
    v_key, 'The same grant under another name', 'https://example.invalid/some-grant', 'grant');
  PERFORM assert_eq('a duplicate URL does not create a second draft', r.ok, true);
  PERFORM assert_eq(
    'and really does not',
    (SELECT count(*)::int FROM opportunities WHERE source_url = 'https://example.invalid/some-grant'),
    1);

  -- §14's limit: three a day per key.
  SELECT * INTO r FROM submit_opportunity_public(
    v_key, 'Another one entirely here', 'https://example.invalid/second-grant', 'grant');
  PERFORM assert_eq('a second distinct submission is accepted', r.ok, true);
  SELECT * INTO r FROM submit_opportunity_public(
    v_key, 'And a third one as well', 'https://example.invalid/third-grant', 'grant');
  PERFORM assert_eq('the fourth in a day is refused (§14)', r.ok, false);
  PERFORM assert_eq('and says so in words a person can act on',
    r.message LIKE '%limit%', true);

  -- No rate key, no endpoint.
  SELECT * INTO r FROM submit_opportunity_public(
    NULL, 'A submission with no rate key at all', 'https://example.invalid/fourth');
  PERFORM assert_eq('a caller that passes no rate key is refused', r.ok, false);

  -- Rubbish in, honest refusal out.
  SELECT * INTO r FROM submit_opportunity_public('another-key', 'Fine title here', 'not-a-url');
  PERFORM assert_eq('something that is not a URL is refused', r.ok, false);
  SELECT * INTO r FROM submit_opportunity_public('another-key', 'short', 'https://example.invalid/x');
  PERFORM assert_eq('and so is a title too short to recognise anything by', r.ok, false);
END $$;

ROLLBACK;
