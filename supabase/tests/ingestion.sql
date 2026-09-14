-- Ingestion, routing and freshness behaviour.
--
-- OPPORTUNITY_INGESTION.md §3, §4.7, §5 and §6, and Phase 3's acceptance criterion
-- 5 in IMPLEMENTATION_PLAN.md §5:
--
--   "A deadline change on a tracked opportunity produces exactly one notification
--    showing old and new values."
--
-- Everything runs in one transaction and rolls back.

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

CREATE OR REPLACE FUNCTION assert_true(label text, actual boolean)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL  %: expected true, got %', label, coalesce(actual::text,'null');
  END IF;
  RAISE NOTICE 'PASS  %', label;
END $$;

-- ── §5.1 the cadence bands ──────────────────────────────────────────────────
-- A wrong deadline matters most when the deadline is near, so the bands are the
-- product's attention budget and are asserted exactly.

SELECT assert_eq('2 days out is re-verified every 12 hours',
  next_verify_interval(now() + interval '2 days'), interval '12 hours');
SELECT assert_eq('5 days out, every 24 hours',
  next_verify_interval(now() + interval '5 days'), interval '24 hours');
SELECT assert_eq('20 days out, every 3 days',
  next_verify_interval(now() + interval '20 days'), interval '3 days');
SELECT assert_eq('60 days out, weekly',
  next_verify_interval(now() + interval '60 days'), interval '7 days');
SELECT assert_eq('no deadline, fortnightly',
  next_verify_interval(NULL), interval '14 days');
SELECT assert_eq('rolling, fortnightly even with a date attached',
  next_verify_interval(now() + interval '2 days', true), interval '14 days');

-- ── Fixtures ────────────────────────────────────────────────────────────────

INSERT INTO organisations (id, name, slug, website_domain)
VALUES ('aaaa0000-0000-0000-0000-00000000000a', 'Ingest Org', 'ingest-org', 'ingest.example');

-- Two sources: one proven, one brand new. §4.7's "first 5 records are always
-- reviewed" makes the difference between them the whole point.
-- robots_checked_at is not optional on an active source: the schema refuses one
-- without it (§2.1 rule 1 — "record the check in sources.robots_checked_at").
INSERT INTO sources (id, name, kind, url, trust_score, records_published,
                     robots_allowed, robots_checked_at, tos_posture, is_active)
VALUES
  ('bbbb0000-0000-0000-0000-00000000000a', 'Proven feed', 'rss', 'https://proven.example/feed', 0.80, 40, true, now(), 'permits_feeds', true),
  ('bbbb0000-0000-0000-0000-00000000000b', 'Brand new feed', 'rss', 'https://new.example/feed', 0.80, 0, true, now(), 'permits_feeds', true),
  ('bbbb0000-0000-0000-0000-00000000000c', 'Untrusted feed', 'rss', 'https://sketchy.example/feed', 0.30, 40, true, now(), 'silent', true);

-- ── §4.7 score and route ────────────────────────────────────────────────────

SELECT assert_eq(
  'a clean record from a proven source auto-publishes',
  (SELECT decision FROM route_for_publication(
     'bbbb0000-0000-0000-0000-00000000000a', 0.90, 0.95, 0.95, 'free', NULL, NULL,
     'africa_wide', true, 'aaaa0000-0000-0000-0000-00000000000a')),
  'publish');

-- Absolute review triggers. Each one is a place where being wrong costs a user
-- money, and none of them is overridable by a confidence score.
SELECT assert_eq(
  'a fee to apply never auto-publishes, whatever the confidence',
  (SELECT decision FROM route_for_publication(
     'bbbb0000-0000-0000-0000-00000000000a', 1.0, 1.0, 1.0, 'paid', NULL, NULL,
     'africa_wide', true, 'aaaa0000-0000-0000-0000-00000000000a')),
  'review');

SELECT assert_eq(
  'a fee KEYWORD anywhere in the source is enough, even when cost parsed as free',
  (SELECT decision FROM route_for_publication(
     'bbbb0000-0000-0000-0000-00000000000a', 1.0, 1.0, 1.0, 'free', NULL, NULL,
     'africa_wide', true, 'aaaa0000-0000-0000-0000-00000000000a', true)),
  'review');

SELECT assert_eq(
  'a Safe Browsing hit never auto-publishes',
  (SELECT decision FROM route_for_publication(
     'bbbb0000-0000-0000-0000-00000000000a', 1.0, 1.0, 1.0, 'free', NULL, NULL,
     'africa_wide', true, 'aaaa0000-0000-0000-0000-00000000000a', false, true)),
  'review');

SELECT assert_eq(
  'a prize above USD 50,000 is reviewed — the most attractive scam vector',
  (SELECT decision FROM route_for_publication(
     'bbbb0000-0000-0000-0000-00000000000a', 1.0, 1.0, 1.0, 'free', 75000, 'USD',
     'africa_wide', true, 'aaaa0000-0000-0000-0000-00000000000a')),
  'review');

SELECT assert_eq(
  'unclear scope plus a stated prize is reviewed',
  (SELECT decision FROM route_for_publication(
     'bbbb0000-0000-0000-0000-00000000000a', 1.0, 1.0, 1.0, 'free', 5000, 'USD',
     'unclear', true, 'aaaa0000-0000-0000-0000-00000000000a')),
  'review');

SELECT assert_eq(
  'a source below 0.4 trust is reviewed',
  (SELECT decision FROM route_for_publication(
     'bbbb0000-0000-0000-0000-00000000000c', 1.0, 1.0, 1.0, 'free', NULL, NULL,
     'africa_wide', true, 'aaaa0000-0000-0000-0000-00000000000a')),
  'review');

SELECT assert_eq(
  'a brand-new source has its first records reviewed',
  (SELECT decision FROM route_for_publication(
     'bbbb0000-0000-0000-0000-00000000000b', 1.0, 1.0, 1.0, 'free', NULL, NULL,
     'africa_wide', true, 'aaaa0000-0000-0000-0000-00000000000a')),
  'review');
SELECT assert_true(
  'and the reason says so, because "why is my queue full" is the real question',
  (SELECT reason LIKE '%first 5%' FROM route_for_publication(
     'bbbb0000-0000-0000-0000-00000000000b', 1.0, 1.0, 1.0, 'free', NULL, NULL,
     'africa_wide', true, 'aaaa0000-0000-0000-0000-00000000000a')));

-- The confidence gate itself.
SELECT assert_eq(
  'extraction confidence below 0.75 is reviewed',
  (SELECT decision FROM route_for_publication(
     'bbbb0000-0000-0000-0000-00000000000a', 0.70, 1.0, 1.0, 'free', NULL, NULL,
     'africa_wide', true, 'aaaa0000-0000-0000-0000-00000000000a')),
  'review');
SELECT assert_eq(
  'deadline confidence below 0.80 is reviewed even when extraction is strong',
  (SELECT decision FROM route_for_publication(
     'bbbb0000-0000-0000-0000-00000000000a', 0.95, 0.79, 1.0, 'free', NULL, NULL,
     'africa_wide', true, 'aaaa0000-0000-0000-0000-00000000000a')),
  'review');
SELECT assert_eq(
  'country confidence below 0.80 is reviewed',
  (SELECT decision FROM route_for_publication(
     'bbbb0000-0000-0000-0000-00000000000a', 0.95, 0.95, 0.60, 'free', NULL, NULL,
     'africa_wide', true, 'aaaa0000-0000-0000-0000-00000000000a')),
  'review');
SELECT assert_eq(
  'an unresolved organisation is reviewed',
  (SELECT decision FROM route_for_publication(
     'bbbb0000-0000-0000-0000-00000000000a', 0.95, 0.95, 0.95, 'free', NULL, NULL,
     'africa_wide', true, NULL)),
  'review');
SELECT assert_eq(
  'an unconfirmed link is reviewed',
  (SELECT decision FROM route_for_publication(
     'bbbb0000-0000-0000-0000-00000000000a', 0.95, 0.95, 0.95, 'free', NULL, NULL,
     'africa_wide', NULL, 'aaaa0000-0000-0000-0000-00000000000a')),
  'review');

-- ── Region expansion comes from OUR table, never a model ────────────────────

SELECT assert_eq(
  'africa_wide expands to all 54 African countries from our own regions table',
  (SELECT cardinality(expand_regions(ARRAY['africa_wide']))), 54);
SELECT assert_eq(
  'an unknown region word expands to nothing rather than guessing',
  (SELECT cardinality(expand_regions(ARRAY['narnia']))), 0);
SELECT assert_true(
  'and a real region contains a country we can name',
  (SELECT 'ZW' = ANY (expand_regions(ARRAY['africa_wide']))));

-- ── §3 source health ────────────────────────────────────────────────────────

SELECT record_source_fetch('bbbb0000-0000-0000-0000-00000000000a', 'fetch_error', 500, 0, 0, 'timeout');
SELECT record_source_fetch('bbbb0000-0000-0000-0000-00000000000a', 'fetch_error', 500, 0, 0, 'timeout');
SELECT assert_eq(
  'two failures is not yet degraded',
  (SELECT count(*)::int FROM degraded_sources() WHERE id = 'bbbb0000-0000-0000-0000-00000000000a'),
  0);

SELECT record_source_fetch('bbbb0000-0000-0000-0000-00000000000a', 'fetch_error', 500, 0, 0, 'timeout');
SELECT assert_eq(
  'three consecutive failures marks a source degraded',
  (SELECT count(*)::int FROM degraded_sources() WHERE id = 'bbbb0000-0000-0000-0000-00000000000a'),
  1);

SELECT record_source_fetch('bbbb0000-0000-0000-0000-00000000000a', 'not_modified', 304);
SELECT assert_eq(
  'a 304 is a success — a well-behaved source that rarely changes is not failing',
  (SELECT consecutive_failures FROM sources WHERE id = 'bbbb0000-0000-0000-0000-00000000000a'),
  0);

SELECT assert_eq(
  'every fetch is recorded, successes and failures alike (§1: an auditable row per stage)',
  (SELECT count(*)::int FROM source_fetches WHERE source_id = 'bbbb0000-0000-0000-0000-00000000000a'),
  4);

-- §3's alert needs three sources failing for over twelve hours, not three failing
-- at once — alerting on a network blip trains the operator to ignore alerts.
UPDATE sources SET consecutive_failures = 5, last_success_at = now() - interval '1 hour'
 WHERE id IN ('bbbb0000-0000-0000-0000-00000000000a','bbbb0000-0000-0000-0000-00000000000b','bbbb0000-0000-0000-0000-00000000000c');
SELECT assert_eq('three sources failing for an hour does not alert',
  source_health_alert_due(), NULL::text);

UPDATE sources SET last_success_at = now() - interval '13 hours'
 WHERE id IN ('bbbb0000-0000-0000-0000-00000000000a','bbbb0000-0000-0000-0000-00000000000b','bbbb0000-0000-0000-0000-00000000000c');
SELECT assert_true('three sources failing for thirteen hours alerts the operator',
  source_health_alert_due() IS NOT NULL);

UPDATE sources SET consecutive_failures = 0, last_success_at = now()
 WHERE id::text LIKE 'bbbb0000%';

-- ── Phase 3 criterion 5: one notification, old and new values ───────────────

INSERT INTO opportunities
  (id, slug, title, category_id, organisation_id, source_id, status, verification,
   last_verified_at, cost, source_url, official_url, deadline_at, deadline_precision,
   published_at, eligibility_scope, link_ok, link_checked_at)
VALUES
  ('cccc0000-0000-0000-0000-00000000000a', 'ingest-tracked', 'A tracked opportunity',
   (SELECT id FROM categories WHERE code='grant'), 'aaaa0000-0000-0000-0000-00000000000a',
   'bbbb0000-0000-0000-0000-00000000000a', 'published', 'verified', now(), 'free',
   'https://proven.example/x', 'https://ingest.example/x', now() + interval '20 days',
   'date_only', now() - interval '1 day', 'africa_wide', true, now());

INSERT INTO users (id, email, age_confirmed_18, timezone)
VALUES ('dddd0000-0000-0000-0000-00000000000a', 'tracker@example.invalid', true, 'Africa/Harare'),
       ('dddd0000-0000-0000-0000-00000000000b', 'withdrew@example.invalid', true, 'Africa/Lagos');

INSERT INTO tracker_entries (user_id, opportunity_id, state)
VALUES ('dddd0000-0000-0000-0000-00000000000a', 'cccc0000-0000-0000-0000-00000000000a', 'planning_to_apply'),
       ('dddd0000-0000-0000-0000-00000000000b', 'cccc0000-0000-0000-0000-00000000000a', 'withdrawn');

DO $$
DECLARE v_change uuid; v_payload jsonb;
BEGIN
  v_change := record_opportunity_change(
    'cccc0000-0000-0000-0000-00000000000a', 'deadline_at',
    to_jsonb('2026-10-04T23:59:00Z'::text), to_jsonb('2026-10-11T23:59:00Z'::text));

  PERFORM assert_eq(
    'a deadline change on a tracked opportunity produces exactly one notification',
    (SELECT count(*)::int FROM notifications
      WHERE user_id = 'dddd0000-0000-0000-0000-00000000000a' AND type = 'opportunity_changed'),
    1);

  SELECT payload INTO v_payload FROM notifications
   WHERE user_id = 'dddd0000-0000-0000-0000-00000000000a' AND type = 'opportunity_changed';

  PERFORM assert_eq('it carries the old value', v_payload->>'old', '2026-10-04T23:59:00Z');
  PERFORM assert_eq('it carries the new value', v_payload->>'new', '2026-10-11T23:59:00Z');
  PERFORM assert_true('and the source, so the reader can check it themselves',
    v_payload->>'source' IS NOT NULL);

  PERFORM assert_eq(
    'someone who withdrew is not told — that is noise, not news',
    (SELECT count(*)::int FROM notifications
      WHERE user_id = 'dddd0000-0000-0000-0000-00000000000b' AND type = 'opportunity_changed'),
    0);

  -- §1: every stage is independently re-runnable and idempotent. A re-extraction
  -- that produces the same diff must not notify twice.
  PERFORM record_opportunity_change(
    'cccc0000-0000-0000-0000-00000000000a', 'deadline_at',
    to_jsonb('2026-10-04T23:59:00Z'::text), to_jsonb('2026-10-11T23:59:00Z'::text));
  PERFORM assert_eq(
    'and a re-run of the same change still produces exactly one',
    (SELECT count(*)::int FROM notifications
      WHERE user_id = 'dddd0000-0000-0000-0000-00000000000a' AND type = 'opportunity_changed'),
    1);
  PERFORM assert_eq(
    'nor does the re-run log a second change row',
    (SELECT count(*)::int FROM opportunity_changes
      WHERE opportunity_id = 'cccc0000-0000-0000-0000-00000000000a' AND field = 'deadline_at'),
    1);

  -- A DIFFERENT transition on the same field is a different change, and does notify.
  PERFORM record_opportunity_change(
    'cccc0000-0000-0000-0000-00000000000a', 'deadline_at',
    to_jsonb('2026-10-11T23:59:00Z'::text), to_jsonb('2026-10-18T23:59:00Z'::text));
  PERFORM assert_eq(
    'a further deadline move is news again',
    (SELECT count(*)::int FROM notifications
      WHERE user_id = 'dddd0000-0000-0000-0000-00000000000a' AND type = 'opportunity_changed'),
    2);
END $$;

SELECT assert_eq(
  'a deadline moving LATER still notifies — people plan around deadlines',
  (SELECT notify_trackers FROM opportunity_changes
    WHERE opportunity_id = 'cccc0000-0000-0000-0000-00000000000a' AND field = 'deadline_at' LIMIT 1),
  true);

DO $$
BEGIN
  -- Other fields are logged, silently.
  PERFORM record_opportunity_change(
    'cccc0000-0000-0000-0000-00000000000a', 'summary',
    to_jsonb('old summary'::text), to_jsonb('new summary'::text));
  PERFORM assert_eq(
    'a summary change is logged but nobody is told',
    (SELECT notify_trackers FROM opportunity_changes
      WHERE opportunity_id = 'cccc0000-0000-0000-0000-00000000000a' AND field = 'summary'),
    false);
  PERFORM assert_eq(
    'a non-change writes nothing at all',
    record_opportunity_change('cccc0000-0000-0000-0000-00000000000a', 'summary',
                              to_jsonb('same'::text), to_jsonb('same'::text)),
    NULL::uuid);
END $$;

-- ── §5.4 staleness and expiry ───────────────────────────────────────────────

SELECT apply_verification_cadence();
SELECT assert_true(
  'a published record gets a next_verify_at from its urgency band',
  (SELECT next_verify_at IS NOT NULL AND next_verify_at <= now() + interval '3 days'
     FROM opportunities WHERE id = 'cccc0000-0000-0000-0000-00000000000a'));

UPDATE opportunities SET next_verify_at = now() - interval '8 days'
 WHERE id = 'cccc0000-0000-0000-0000-00000000000a';
SELECT apply_staleness_and_expiry();
SELECT assert_eq(
  'a record eight days past due for verification is marked stale, not removed',
  (SELECT verification::text || '/' || status::text FROM opportunities
    WHERE id = 'cccc0000-0000-0000-0000-00000000000a'),
  'stale/published');

-- Expiry, with §5.4's precision buffer: displayed conservatively, expired
-- generously. Both directions err away from harming the applicant.
UPDATE opportunities
   SET deadline_at = now() - interval '2 hours', deadline_precision = 'date_only',
       verification = 'verified'
 WHERE id = 'cccc0000-0000-0000-0000-00000000000a';
SELECT apply_staleness_and_expiry();
SELECT assert_eq(
  'a date-only deadline two hours past is NOT yet expired (the day may not be over)',
  (SELECT status::text FROM opportunities WHERE id = 'cccc0000-0000-0000-0000-00000000000a'),
  'published');

UPDATE opportunities SET deadline_at = now() - interval '2 days'
 WHERE id = 'cccc0000-0000-0000-0000-00000000000a';
SELECT apply_staleness_and_expiry();
SELECT assert_eq(
  'two days past a date-only deadline is expired',
  (SELECT status::text FROM opportunities WHERE id = 'cccc0000-0000-0000-0000-00000000000a'),
  'expired');

SELECT assert_eq(
  'an expired record is never deleted — the URL still resolves (§5.4 [PR])',
  (SELECT count(*)::int FROM opportunities
    WHERE id = 'cccc0000-0000-0000-0000-00000000000a' AND deleted_at IS NULL),
  1);

-- ── §5 contradictions force review ──────────────────────────────────────────

INSERT INTO eligibility_rules (opportunity_id, rule_type, params, source_quote, confidence)
VALUES ('cccc0000-0000-0000-0000-00000000000a', 'country_in', '{"countries":["ZW","ZM"]}',
        'Open to residents of Zimbabwe and Zambia.', 0.9);
SELECT assert_eq('one country rule is not a contradiction',
  contradictory_rules('cccc0000-0000-0000-0000-00000000000a'), false);

INSERT INTO eligibility_rules (opportunity_id, rule_type, params, source_quote, confidence)
VALUES ('cccc0000-0000-0000-0000-00000000000a', 'country_not_in', '{"countries":["ZM"]}',
        'Not open to residents of Zambia.', 0.9);
SELECT assert_eq('an overlapping include and exclude is a contradiction',
  contradictory_rules('cccc0000-0000-0000-0000-00000000000a'), true);

-- ── §6 user-reported corrections ────────────────────────────────────────────

INSERT INTO opportunities
  (id, slug, title, category_id, organisation_id, source_id, status, verification,
   last_verified_at, cost, source_url, deadline_at, published_at, eligibility_scope, link_ok)
VALUES ('cccc0000-0000-0000-0000-00000000000b', 'ingest-reported', 'A reported opportunity',
   (SELECT id FROM categories WHERE code='grant'), 'aaaa0000-0000-0000-0000-00000000000a',
   'bbbb0000-0000-0000-0000-00000000000a', 'published', 'verified', now(), 'free',
   'https://proven.example/y', now() + interval '30 days', now(), 'africa_wide', true);

-- One ordinary reporter claiming it has expired is not enough to flag it.
INSERT INTO reports (subject_type, subject_id, reason, reporter_fingerprint)
VALUES ('opportunity', 'cccc0000-0000-0000-0000-00000000000b', 'expired', 'fp-1');
SELECT assert_eq(
  'one expiry report does not flag a listing',
  (SELECT verification::text FROM opportunities WHERE id = 'cccc0000-0000-0000-0000-00000000000b'),
  'verified');

-- A second independent one is.
INSERT INTO reports (subject_type, subject_id, reason, reporter_fingerprint)
VALUES ('opportunity', 'cccc0000-0000-0000-0000-00000000000b', 'expired', 'fp-2');
SELECT assert_eq(
  'two independent expiry reports flag it and trigger an immediate re-verify',
  (SELECT verification::text FROM opportunities WHERE id = 'cccc0000-0000-0000-0000-00000000000b'),
  'community_flagged');
SELECT assert_true(
  'and the re-verify is immediate, not on the next cadence tick',
  (SELECT next_verify_at <= now() FROM opportunities WHERE id = 'cccc0000-0000-0000-0000-00000000000b'));

-- A reporter whose reports are consistently upheld counts for two on their own.
INSERT INTO opportunities
  (id, slug, title, category_id, organisation_id, source_id, status, verification,
   last_verified_at, cost, source_url, deadline_at, published_at, eligibility_scope, link_ok)
VALUES ('cccc0000-0000-0000-0000-00000000000c', 'ingest-trusted-report', 'Reported by a trusted reporter',
   (SELECT id FROM categories WHERE code='grant'), 'aaaa0000-0000-0000-0000-00000000000a',
   'bbbb0000-0000-0000-0000-00000000000a', 'published', 'verified', now(), 'free',
   'https://proven.example/z', now() + interval '30 days', now(), 'africa_wide', true);

UPDATE users SET reporter_weight = 2.25 WHERE id = 'dddd0000-0000-0000-0000-00000000000a';
INSERT INTO reports (subject_type, subject_id, reason, reporter_user_id)
VALUES ('opportunity', 'cccc0000-0000-0000-0000-00000000000c', 'expired', 'dddd0000-0000-0000-0000-00000000000a');
SELECT assert_eq(
  'a consistently-upheld reporter triggers on their own report (§6 weight rule)',
  (SELECT verification::text FROM opportunities WHERE id = 'cccc0000-0000-0000-0000-00000000000c'),
  'community_flagged');

-- A broken-link report triggers a CHECK, and deliberately does not assert the link
-- is dead: a reporter behind a captive portal sees a break that is not there.
INSERT INTO reports (subject_type, subject_id, reason, reporter_fingerprint)
VALUES ('opportunity', 'cccc0000-0000-0000-0000-00000000000b', 'broken_link', 'fp-3');
SELECT assert_eq(
  'a broken-link report does not mark the link dead on one person''s word',
  (SELECT link_ok FROM opportunities WHERE id = 'cccc0000-0000-0000-0000-00000000000b'),
  true);
SELECT assert_true(
  'it queues an immediate check instead',
  (SELECT link_checked_at IS NULL AND next_verify_at <= now()
     FROM opportunities WHERE id = 'cccc0000-0000-0000-0000-00000000000b'));

-- A scam report still disputes immediately (0006's behaviour, preserved).
INSERT INTO reports (subject_type, subject_id, reason, reporter_fingerprint)
VALUES ('opportunity', 'cccc0000-0000-0000-0000-00000000000c', 'possible_scam', 'fp-4');
SELECT assert_eq(
  'a scam report disputes the listing immediately, before any human sees it',
  (SELECT verification::text FROM opportunities WHERE id = 'cccc0000-0000-0000-0000-00000000000c'),
  'disputed');
SELECT assert_eq(
  'and files a priority-1 queue item',
  (SELECT min(priority)::int FROM review_queue
    WHERE subject_id = 'cccc0000-0000-0000-0000-00000000000c' AND queue = 'report_scam'),
  1);

-- A duplicate report goes to the dedupe queue, not the scam queue.
INSERT INTO reports (subject_type, subject_id, reason, reporter_fingerprint)
VALUES ('opportunity', 'cccc0000-0000-0000-0000-00000000000b', 'duplicate', 'fp-5');
SELECT assert_eq(
  'a duplicate report is filed for dedupe review',
  (SELECT count(*)::int FROM review_queue
    WHERE subject_id = 'cccc0000-0000-0000-0000-00000000000b' AND queue = 'duplicate'),
  1);

-- §6 [PR]: reporters are told the outcome, and their weight moves on the pattern.
DO $$
DECLARE v_report uuid; v_before numeric; v_after numeric;
BEGIN
  SELECT reporter_weight INTO v_before FROM users WHERE id = 'dddd0000-0000-0000-0000-00000000000a';
  SELECT id INTO v_report FROM reports
   WHERE reporter_user_id = 'dddd0000-0000-0000-0000-00000000000a' LIMIT 1;

  PERFORM resolve_report(v_report, true, 'Checked the organiser page — it had closed.');

  PERFORM assert_eq('an upheld report is marked actioned',
    (SELECT state FROM reports WHERE id = v_report), 'actioned');

  SELECT reporter_weight INTO v_after FROM users WHERE id = 'dddd0000-0000-0000-0000-00000000000a';
  PERFORM assert_eq('an upheld report raises the reporter''s weight', v_after - v_before, 0.25);

  PERFORM assert_eq(
    'and the reporter is told the outcome (§6 [PR])',
    (SELECT count(*)::int FROM notifications
      WHERE user_id = 'dddd0000-0000-0000-0000-00000000000a' AND type = 'moderation_outcome'),
    1);

  -- Resolving twice must not pay twice.
  PERFORM resolve_report(v_report, true, 'again');
  SELECT reporter_weight INTO v_after FROM users WHERE id = 'dddd0000-0000-0000-0000-00000000000a';
  PERFORM assert_eq('resolving an already-resolved report changes nothing',
    v_after - v_before, 0.25);
END $$;

-- ── AI accounting (AI_SYSTEM.md §3.2) ───────────────────────────────────────

INSERT INTO ai_usage (provider, task, model, prompt_version, tokens_in, tokens_out, outcome)
VALUES ('groq', 'rules', 'a-model-name', 'rules.v1', 3000, 500, 'ok'),
       ('groq', 'rules', 'a-model-name', 'rules.v1', 2800, 450, 'rate_limited'),
       ('gemini', 'extract', 'another-model', 'extract.v1', 6000, 800, 'ok');

SELECT assert_eq('usage is counted per provider',
  (SELECT calls::int FROM ai_usage_today() WHERE provider = 'groq'), 2);
SELECT assert_eq('and failures are counted separately, so a quiet failure is visible',
  (SELECT errors::int FROM ai_usage_today() WHERE provider = 'groq'), 1);
SELECT assert_eq('tokens are summed for the budget report',
  (SELECT tokens_in::int FROM ai_usage_today() WHERE provider = 'gemini'), 6000);

-- No prompt or response text is stored: §2 guardrail 5 keeps user data away from
-- providers, and logging bodies would recreate the exposure in our own database.
SELECT assert_eq(
  'ai_usage holds no prompt or response text',
  (SELECT count(*)::int FROM information_schema.columns
    WHERE table_name = 'ai_usage'
      AND column_name IN ('prompt','response','input','output','body','text')),
  0);

ROLLBACK;
