-- Schema-level invariant tests. Run in CI after migrations.
--
-- These prove the database REFUSES invariant violations, rather than merely that
-- the constraints exist. A constraint nobody has tried to violate is a guess.
--
-- Each case wraps the offending write in a savepoint, asserts it raises, and
-- rolls back, so the whole file leaves no residue.

\set ON_ERROR_STOP on

BEGIN;

-- Fixtures.
INSERT INTO organisations (id, name, slug)
VALUES ('11111111-1111-1111-1111-111111111111', 'Test Org', 'test-org-invariants');

-- The caught list is deliberately SHORT rather than `WHEN others`. A typo in a column name
-- also raises, and a test that treats any error as a pass is a test that passes for the wrong
-- reason — it would report the invariant enforced while asserting nothing at all.
--
-- `unique_violation` joined it with migration 0025, which made a source's URL its identity.
CREATE OR REPLACE FUNCTION assert_rejects(label text, stmt text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN check_violation OR not_null_violation OR unique_violation THEN
    RAISE NOTICE 'PASS  %', label;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL  %: the write was ACCEPTED but must be rejected', label;
END $$;

CREATE OR REPLACE FUNCTION assert_accepts(label text, stmt text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RAISE NOTICE 'PASS  %', label;
EXCEPTION WHEN others THEN
  RAISE EXCEPTION 'FAIL  %: the write was REJECTED but must be accepted (%)', label, SQLERRM;
END $$;

-- Invariant 1 — never publish an opportunity without a source URL.
SELECT assert_rejects(
  'invariant 1: published row with no source_url or official_url',
  $q$INSERT INTO opportunities
       (slug, title, category_id, status, last_verified_at, cost)
     VALUES ('inv1-no-source', 'No source', (SELECT id FROM categories WHERE code='grant'),
             'published', now(), 'free')$q$);

-- Invariant 13 — never publish an opportunity that charges a fee to apply.
SELECT assert_rejects(
  'invariant 13: published row with cost = paid',
  $q$INSERT INTO opportunities
       (slug, title, category_id, status, last_verified_at, cost, source_url)
     VALUES ('inv13-paid', 'Pay to apply', (SELECT id FROM categories WHERE code='grant'),
             'published', now(), 'paid', 'https://example.org/x')$q$);

-- MODERATION_AND_TRUST.md §1 — no badge without a date.
SELECT assert_rejects(
  'published row with no last_verified_at',
  $q$INSERT INTO opportunities
       (slug, title, category_id, status, cost, source_url)
     VALUES ('no-verified-at', 'No date', (SELECT id FROM categories WHERE code='grant'),
             'published', 'free', 'https://example.org/x')$q$);

-- A paid record may exist as a DRAFT — it just cannot be published. The
-- anti-scam queue needs to hold it for review (MODERATION_AND_TRUST.md §2.1).
SELECT assert_accepts(
  'a paid opportunity may exist as a draft for review',
  $q$INSERT INTO opportunities
       (slug, title, category_id, status, cost, source_url)
     VALUES ('inv13-paid-draft', 'Pay to apply', (SELECT id FROM categories WHERE code='grant'),
             'draft', 'paid', 'https://example.org/x')$q$);

-- A well-formed published record is accepted.
SELECT assert_accepts(
  'a well-formed published opportunity is accepted',
  $q$INSERT INTO opportunities
       (id, slug, title, category_id, status, last_verified_at, cost, source_url, organisation_id)
     VALUES ('22222222-2222-2222-2222-222222222222', 'good-one', 'Good one',
             (SELECT id FROM categories WHERE code='grant'), 'published', now(), 'free',
             'https://example.org/good', '11111111-1111-1111-1111-111111111111')$q$);

-- Invariant 2 — never store an eligibility rule without a verbatim source quote.
SELECT assert_rejects(
  'invariant 2: rule with an empty source_quote',
  $q$INSERT INTO eligibility_rules (opportunity_id, rule_type, params, source_quote, confidence)
     VALUES ('22222222-2222-2222-2222-222222222222', 'country_in',
             '{"countries":["ZW"]}', '', 0.9)$q$);

SELECT assert_rejects(
  'invariant 2: rule with a whitespace-only source_quote',
  $q$INSERT INTO eligibility_rules (opportunity_id, rule_type, params, source_quote, confidence)
     VALUES ('22222222-2222-2222-2222-222222222222', 'country_in',
             '{"countries":["ZW"]}', '     ', 0.9)$q$);

SELECT assert_rejects(
  'invariant 2: rule with a NULL source_quote',
  $q$INSERT INTO eligibility_rules (opportunity_id, rule_type, params, source_quote, confidence)
     VALUES ('22222222-2222-2222-2222-222222222222', 'country_in',
             '{"countries":["ZW"]}', NULL, 0.9)$q$);

SELECT assert_accepts(
  'a rule with a real quote is accepted',
  $q$INSERT INTO eligibility_rules (opportunity_id, rule_type, params, source_quote, confidence)
     VALUES ('22222222-2222-2222-2222-222222222222', 'country_in',
             '{"countries":["ZW"]}', 'Open to residents of Zimbabwe.', 0.93)$q$);

-- is_high_stakes must mirror the engine's constant list exactly.
DO $$
DECLARE hs boolean;
BEGIN
  SELECT is_high_stakes INTO hs FROM eligibility_rules
   WHERE opportunity_id = '22222222-2222-2222-2222-222222222222' AND rule_type = 'country_in';
  IF hs IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL  country_in must be high-stakes (DATA_MODEL.md §5.1)';
  END IF;
  RAISE NOTICE 'PASS  is_high_stakes mirrors the engine constant list';
END $$;

-- A source cannot be activated before robots.txt has been checked and allows us.
SELECT assert_rejects(
  'ingestion: a source cannot be active without a passing robots check',
  $q$INSERT INTO sources (name, kind, url, is_active)
     VALUES ('Unchecked', 'html_page', 'https://example.org/unchecked', true)$q$);

SELECT assert_rejects(
  'ingestion: a robots-disallowed source cannot be active',
  $q$INSERT INTO sources (name, kind, url, is_active, robots_allowed, robots_checked_at)
     VALUES ('Disallowed', 'html_page', 'https://example.org/disallowed', true, false, now())$q$);

SELECT assert_accepts(
  'ingestion: a checked and allowed source can be active',
  $q$INSERT INTO sources (name, kind, url, is_active, robots_allowed, robots_checked_at)
     VALUES ('Allowed', 'rss', 'https://example.org/allowed-feed', true, true, now())$q$);

-- A ToS that restricts automation limits us to feeds only.
SELECT assert_rejects(
  'ingestion: restricts_automation forbids an html_page source',
  $q$INSERT INTO sources (name, kind, url, tos_posture)
     VALUES ('Restricted', 'html_page', 'https://example.org/restricted-page', 'restricts_automation')$q$);

SELECT assert_accepts(
  'ingestion: restricts_automation still permits its RSS feed',
  $q$INSERT INTO sources (name, kind, url, tos_posture)
     VALUES ('Restricted feed', 'rss', 'https://example.org/restricted-feed', 'restricts_automation')$q$);

-- A source's URL is its identity (migration 0025). Before that constraint existed, the seed's
-- `ON CONFLICT DO NOTHING` had nothing to conflict on and eighteen deploys turned 24 researched
-- sources into 432 rows — eighteen fetchers of every feed, against a promise of one request per
-- ten seconds per host (OPPORTUNITY_INGESTION.md §2.1 rule 4).
SELECT assert_rejects(
  'ingestion: two sources cannot share a URL',
  $q$INSERT INTO sources (name, kind, url)
     VALUES ('A second row for the same feed', 'rss', 'https://example.org/allowed-feed')$q$);

-- MODERATION_AND_TRUST.md §2.2 — a scam or payment report must set
-- verification='disputed' IMMEDIATELY and AUTOMATICALLY, before any human sees
-- it. "False positives cost us one listing. False negatives cost someone money.
-- Act first, review second." Enforced by trigger so no future write path can
-- forget it.
INSERT INTO reports (subject_type, subject_id, reason, reporter_fingerprint)
VALUES ('opportunity', '22222222-2222-2222-2222-222222222222', 'possible_scam', 'test-fp');

DO $$
DECLARE v text; q int; p int;
BEGIN
  SELECT verification INTO v FROM opportunities
   WHERE id = '22222222-2222-2222-2222-222222222222';
  IF v <> 'disputed' THEN
    RAISE EXCEPTION 'FAIL  a scam report must auto-dispute the listing (got %)', v;
  END IF;

  SELECT count(*) INTO q FROM review_queue WHERE queue = 'report_scam' AND priority = 1;
  IF q <> 1 THEN
    RAISE EXCEPTION 'FAIL  a scam report must queue at priority 1 (found % items)', q;
  END IF;

  SELECT priority INTO p FROM reports WHERE reason = 'possible_scam';
  IF p <> 1 THEN
    RAISE EXCEPTION 'FAIL  a scam report must be escalated to priority 1 (got %)', p;
  END IF;

  RAISE NOTICE 'PASS  a scam report auto-disputes, escalates and queues at priority 1';
END $$;

-- A safety report routes to its own queue, never batched with data-quality
-- reports (ADMIN_SYSTEM.md §8: different urgency, different mindset).
INSERT INTO reports (subject_type, subject_id, reason, reporter_fingerprint)
VALUES ('profile', '22222222-2222-2222-2222-222222222222', 'harassment', 'test-fp2');

DO $$
DECLARE q int;
BEGIN
  SELECT count(*) INTO q FROM review_queue WHERE queue = 'report_safety' AND priority = 1;
  IF q <> 1 THEN
    RAISE EXCEPTION 'FAIL  a harassment report must queue to report_safety at priority 1 (found %)', q;
  END IF;
  RAISE NOTICE 'PASS  a safety report routes to its own priority-1 queue';
END $$;

-- The audit log must be append-only: a SELECT policy for superadmins and an
-- INSERT policy for admins exist, and there is deliberately NO update or delete
-- policy, so it cannot be rewritten through the API (ADMIN_SYSTEM.md §11).
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname = 'admin_audit_log' AND p.polcmd IN ('w', 'd');
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL  admin_audit_log must have no UPDATE or DELETE policy (found %)', n;
  END IF;
  RAISE NOTICE 'PASS  admin_audit_log is append-only by policy';
END $$;

-- The hard invariant, asserted structurally. DATA_MODEL.md §15: eligibility
-- profiles are "readable by exactly one principal — the owning user. Admin roles
-- have no read path."
--
-- Deliberately NOT asserted as "exactly one policy". An earlier version did, and
-- it broke the moment migration 0008 added the owner-scoped INSERT policy a user
-- needs to create their own row. Counting policies was a proxy for the real rule;
-- this checks the rule itself, which is that EVERY policy is confined to the
-- owning user and none consults admin status.
--
-- Applied to the other owner-only tables too: tracker contents and digest history
-- are equally off-limits to admins (ADMIN_SYSTEM.md §6).
DO $$
DECLARE
  bad record;
  checked int := 0;
BEGIN
  FOR bad IN
    SELECT c.relname AS tbl,
           p.polname AS pol,
           coalesce(pg_get_expr(p.polqual, p.polrelid), '') AS qual,
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS chk
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname IN ('eligibility_profiles', 'tracker_entries',
                         'notification_channels', 'notification_preferences')
  LOOP
    checked := checked + 1;

    IF bad.qual ILIKE '%is_admin%' OR bad.chk ILIKE '%is_admin%' THEN
      RAISE EXCEPTION
        'FAIL  %.% must grant NO admin path (qual=%, check=%)',
        bad.tbl, bad.pol, bad.qual, bad.chk;
    END IF;

    -- Every policy must be scoped to the caller. A policy with neither a
    -- USING nor a WITH CHECK expression would be unrestricted.
    IF bad.qual NOT ILIKE '%auth.uid()%' AND bad.chk NOT ILIKE '%auth.uid()%' THEN
      RAISE EXCEPTION
        'FAIL  %.% is not scoped to auth.uid() (qual=%, check=%)',
        bad.tbl, bad.pol, bad.qual, bad.chk;
    END IF;
  END LOOP;

  IF checked = 0 THEN
    RAISE EXCEPTION 'FAIL  found no policies to check — the assertion is vacuous';
  END IF;

  RAISE NOTICE
    'PASS  all % owner-only policies are scoped to auth.uid() with no admin path', checked;
END $$;

-- Deliveries and the send budget must have NO user-facing policy at all: they are
-- dispatcher-only, written in the batch tier (NOTIFICATIONS.md §4).
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname IN ('notification_deliveries', 'send_budget', 'rate_limit_counters');
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL  dispatcher tables must have no policy at all (found %)', n;
  END IF;
  RAISE NOTICE 'PASS  dispatcher tables are unreachable by any user (default deny)';
END $$;

ROLLBACK;
