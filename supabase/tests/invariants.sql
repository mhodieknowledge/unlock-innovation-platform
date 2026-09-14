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

CREATE OR REPLACE FUNCTION assert_rejects(label text, stmt text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN check_violation OR not_null_violation THEN
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
     VALUES ('Unchecked', 'html_page', 'https://example.org/feed', true)$q$);

SELECT assert_rejects(
  'ingestion: a robots-disallowed source cannot be active',
  $q$INSERT INTO sources (name, kind, url, is_active, robots_allowed, robots_checked_at)
     VALUES ('Disallowed', 'html_page', 'https://example.org/feed', true, false, now())$q$);

SELECT assert_accepts(
  'ingestion: a checked and allowed source can be active',
  $q$INSERT INTO sources (name, kind, url, is_active, robots_allowed, robots_checked_at)
     VALUES ('Allowed', 'rss', 'https://example.org/feed', true, true, now())$q$);

-- A ToS that restricts automation limits us to feeds only.
SELECT assert_rejects(
  'ingestion: restricts_automation forbids an html_page source',
  $q$INSERT INTO sources (name, kind, url, tos_posture)
     VALUES ('Restricted', 'html_page', 'https://example.org/page', 'restricts_automation')$q$);

SELECT assert_accepts(
  'ingestion: restricts_automation still permits its RSS feed',
  $q$INSERT INTO sources (name, kind, url, tos_posture)
     VALUES ('Restricted feed', 'rss', 'https://example.org/feed', 'restricts_automation')$q$);

ROLLBACK;
