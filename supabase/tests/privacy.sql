-- Export, erasure, retention and sessionless unsubscribe.
--
-- PRIVACY_AND_COMPLIANCE.md §5 and §8, NOTIFICATIONS.md §9, and Phase 2's last
-- acceptance criterion: "Export produces complete JSON; delete removes the account
-- within the stated 30 days."
--
-- The caller is impersonated with request.jwt.claim.sub, the same claim
-- auth.uid() reads on Supabase, so these exercise the real authorisation path
-- rather than a test-only bypass.

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

-- ── Fixtures ────────────────────────────────────────────────────────────────

INSERT INTO organisations (id, name, slug)
VALUES ('55555555-5555-5555-5555-555555555555', 'Privacy Org', 'privacy-org');

INSERT INTO opportunities
  (id, slug, title, category_id, organisation_id, status, last_verified_at, cost,
   source_url, deadline_at, published_at, eligibility_scope)
VALUES
  ('66666666-6666-6666-6666-666666666661', 'privacy-soon', 'Closes in two days',
   (SELECT id FROM categories WHERE code='grant'), '55555555-5555-5555-5555-555555555555',
   'published', now(), 'free', 'https://example.invalid/p1',
   now() + interval '2 days', now() - interval '1 day', 'africa_wide'),
  ('66666666-6666-6666-6666-666666666662', 'privacy-new', 'New and open Africa-wide',
   (SELECT id FROM categories WHERE code='grant'), '55555555-5555-5555-5555-555555555555',
   'published', now(), 'free', 'https://example.invalid/p2',
   now() + interval '20 days', now() - interval '2 hours', 'africa_wide');

INSERT INTO eligibility_rules (opportunity_id, rule_type, params, source_quote, confidence)
VALUES ('66666666-6666-6666-6666-666666666662', 'country_in', '{"countries":["ZW"]}',
        'Open to applicants resident in Zimbabwe.', 0.95);

INSERT INTO users (id, email, age_confirmed_18, timezone, display_name)
VALUES ('77777777-7777-7777-7777-777777777777', 'privacy@example.invalid', true,
        'Africa/Harare', 'Test Person');

INSERT INTO profiles (user_id, visibility, headline, bio, indexable)
VALUES ('77777777-7777-7777-7777-777777777777', 'public', 'Builder in Harare', 'A bio.', true);

INSERT INTO eligibility_profiles (user_id, country_of_residence, birth_year)
VALUES ('77777777-7777-7777-7777-777777777777', 'ZW', 1998);

INSERT INTO tracker_entries (user_id, opportunity_id, state, note)
VALUES ('77777777-7777-7777-7777-777777777777', '66666666-6666-6666-6666-666666666661',
        'planning_to_apply', 'Private note that must appear in the export.');

INSERT INTO notification_channels (user_id, channel, address, verified_at)
VALUES ('77777777-7777-7777-7777-777777777777', 'telegram', 'privacy-chat', now());

-- ── §5.1 digest composition ─────────────────────────────────────────────────

SELECT assert_eq(
  'a tracked item closing within 3 days is section 1',
  (SELECT count(*)::int FROM digest_items('77777777-7777-7777-7777-777777777777')
    WHERE section = 1 AND slug = 'privacy-soon'),
  1);

SELECT assert_eq(
  'a new, eligible, Africa-wide item is section 2',
  (SELECT count(*)::int FROM digest_items('77777777-7777-7777-7777-777777777777')
    WHERE section = 2 AND slug = 'privacy-new'),
  1);

SELECT assert_eq(
  'the digest carries the same verdict the engine would give',
  (SELECT verdict FROM digest_items('77777777-7777-7777-7777-777777777777')
    WHERE slug = 'privacy-new'),
  'eligible');

SELECT assert_eq(
  'a tracked item is never repeated as "new"',
  (SELECT count(*)::int FROM digest_items('77777777-7777-7777-7777-777777777777')
    WHERE section = 2 AND slug = 'privacy-soon'),
  0);

SELECT assert_true(
  'the digest is never more than 8 items (NOTIFICATIONS.md §5.1)',
  (SELECT count(*) FROM digest_items('77777777-7777-7777-7777-777777777777')) <= 8);

-- A not_eligible item is not pushed at all, which is the one place the product
-- hides it rather than down-ranking it.
INSERT INTO opportunities
  (id, slug, title, category_id, organisation_id, status, last_verified_at, cost,
   source_url, deadline_at, published_at, eligibility_scope)
VALUES ('66666666-6666-6666-6666-666666666663', 'privacy-elsewhere', 'Kenya only',
        (SELECT id FROM categories WHERE code='grant'), '55555555-5555-5555-5555-555555555555',
        'published', now(), 'free', 'https://example.invalid/p3',
        now() + interval '20 days', now() - interval '1 hour', 'country_list');
INSERT INTO eligibility_rules (opportunity_id, rule_type, params, source_quote, confidence)
VALUES ('66666666-6666-6666-6666-666666666663', 'country_in', '{"countries":["KE"]}',
        'Open to applicants resident in Kenya.', 0.95);

SELECT assert_eq(
  'a not_eligible item is not put in the digest',
  (SELECT count(*)::int FROM digest_items('77777777-7777-7777-7777-777777777777')
    WHERE slug = 'privacy-elsewhere'),
  0);

-- §5.1's suppression rules, as encoded in 0009.
SELECT assert_eq('a digest of one item is not sent at all',
  digest_should_send(1, NULL, NULL, 'weekly'), false);
SELECT assert_eq('a digest of two items is sent',
  digest_should_send(2, NULL, NULL, 'weekly'), true);
SELECT assert_eq('digest_frequency off means never',
  digest_should_send(8, NULL, NULL, 'off'), false);
SELECT assert_eq(
  'someone who opened the app in the last 12 hours has daily downgraded to weekly',
  digest_should_send(4, now() - interval '1 day', now() - interval '2 hours', 'daily'),
  false);
SELECT assert_eq(
  'and someone who has not is sent their daily digest',
  digest_should_send(4, now() - interval '1 day', now() - interval '3 days', 'daily'),
  true);

-- ── §9 sessionless unsubscribe ──────────────────────────────────────────────

DO $$
DECLARE v_token text; v_result text;
BEGIN
  v_token := issue_unsubscribe_token('77777777-7777-7777-7777-777777777777', 'digest');

  PERFORM assert_eq(
    'the token names its type before anything is changed',
    (SELECT type::text FROM describe_unsubscribe_token(v_token)),
    'digest');

  PERFORM assert_eq(
    'the same type reuses one token, so old links keep working',
    issue_unsubscribe_token('77777777-7777-7777-7777-777777777777', 'digest'),
    v_token);

  -- §9 offers "reduce frequency instead" as an equal-weight option.
  v_result := redeem_unsubscribe_token(v_token, 'reduce');
  PERFORM assert_eq('reducing frequency is honoured', v_result, 'reduced');
  PERFORM assert_eq(
    'and it sets weekly rather than off',
    (SELECT digest_frequency FROM user_notification_settings
      WHERE user_id = '77777777-7777-7777-7777-777777777777'),
    'weekly');

  v_result := redeem_unsubscribe_token(v_token, 'off');
  PERFORM assert_eq('unsubscribing is honoured', v_result, 'unsubscribed');
  PERFORM assert_eq(
    'that type is now off on every push channel',
    (SELECT count(*)::int FROM notification_preferences
      WHERE user_id = '77777777-7777-7777-7777-777777777777'
        AND type = 'digest' AND enabled = false),
    3);
  PERFORM assert_eq(
    'and only that type (never everything)',
    (SELECT count(*)::int FROM notification_preferences
      WHERE user_id = '77777777-7777-7777-7777-777777777777'
        AND type <> 'digest' AND enabled = false),
    0);

  -- Security messages cannot be turned off.
  v_token := issue_unsubscribe_token('77777777-7777-7777-7777-777777777777', 'security');
  PERFORM assert_eq(
    'a security unsubscribe says so rather than pretending to work',
    redeem_unsubscribe_token(v_token, 'off'),
    'security_cannot_be_disabled');
  PERFORM assert_eq(
    'and security stays enabled',
    (SELECT count(*)::int FROM notification_preferences
      WHERE user_id = '77777777-7777-7777-7777-777777777777'
        AND type = 'security' AND enabled = false),
    0);

  PERFORM assert_eq(
    'an unknown token changes nothing',
    redeem_unsubscribe_token('not-a-real-token', 'off'),
    'unknown');
END $$;

-- A queued message for an unsubscribed type is dropped, not sent (§9's
-- "honoured immediately").
DO $$
DECLARE v_notif uuid; v_token text;
BEGIN
  INSERT INTO notifications (user_id, type, payload, reason, priority)
  VALUES ('77777777-7777-7777-7777-777777777777', 'opportunity_closed', '{}',
          'Something you saved has closed.', 3)
  RETURNING id INTO v_notif;
  INSERT INTO notification_deliveries (notification_id, channel) VALUES (v_notif, 'telegram');

  v_token := issue_unsubscribe_token('77777777-7777-7777-7777-777777777777', 'opportunity_closed');
  PERFORM redeem_unsubscribe_token(v_token, 'off');

  PERFORM assert_eq(
    'a message already queued for an unsubscribed type is dropped',
    (SELECT state FROM notification_deliveries WHERE notification_id = v_notif AND channel = 'telegram'),
    'suppressed');
END $$;

-- ── §5 export ───────────────────────────────────────────────────────────────

SET LOCAL request.jwt.claim.sub = '77777777-7777-7777-7777-777777777777';

DO $$
DECLARE j jsonb;
BEGIN
  j := export_my_account();

  PERFORM assert_eq('the export names its format',
    j->>'format', 'mbele-account-export-v1');
  PERFORM assert_eq('the export includes the account',
    j->'account'->>'email', 'privacy@example.invalid');
  PERFORM assert_true('the export includes the eligibility profile',
    j->'eligibility_profile' IS NOT NULL AND j->'eligibility_profile'->>'birth_year' = '1998');
  PERFORM assert_eq('the export includes tracker notes, which nothing else exposes',
    j->'tracker'->0->>'note', 'Private note that must appear in the export.');
  PERFORM assert_eq('the export references opportunities by slug, not by copy',
    j->'tracker'->0->>'opportunity', 'privacy-soon');
  PERFORM assert_true('the export includes notification channels',
    jsonb_array_length(j->'notification_channels') >= 1);
  PERFORM assert_true('the export includes notification preferences',
    jsonb_array_length(j->'notification_preferences') >= 1);

  -- Everything §5's portability row names must be present as a key, even when
  -- empty, so a reader can tell "nothing held" from "not exported".
  PERFORM assert_true('every documented section is present as a key',
    j ? 'account' AND j ? 'profile' AND j ? 'eligibility_profile' AND j ? 'tracker'
    AND j ? 'notification_settings' AND j ? 'notification_channels'
    AND j ? 'notification_preferences' AND j ? 'notifications'
    AND j ? 'organisation_memberships' AND j ? 'reports_i_filed');
END $$;

-- An unauthenticated caller gets nothing, and says why.
RESET request.jwt.claim.sub;
DO $$
BEGIN
  BEGIN
    PERFORM export_my_account();
    RAISE EXCEPTION 'FAIL  export_my_account must refuse an anonymous caller';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS  export_my_account refuses an anonymous caller';
  END;
END $$;

-- ── §5 erasure ──────────────────────────────────────────────────────────────

SET LOCAL request.jwt.claim.sub = '77777777-7777-7777-7777-777777777777';

DO $$
DECLARE v_purge_at timestamptz;
BEGIN
  v_purge_at := request_account_deletion(true);

  PERFORM assert_true(
    'deletion is scheduled 30 days out, as stated',
    v_purge_at BETWEEN now() + interval '29 days' AND now() + interval '31 days');

  PERFORM assert_eq(
    'the account is deactivated immediately, not in 30 days',
    (SELECT account_state::text FROM users WHERE id = '77777777-7777-7777-7777-777777777777'),
    'deleted');

  PERFORM assert_eq(
    'the eligibility profile is destroyed immediately (§8)',
    (SELECT count(*)::int FROM eligibility_profiles
      WHERE user_id = '77777777-7777-7777-7777-777777777777'),
    0);

  PERFORM assert_eq(
    'push channels are removed, so nothing is sent during the grace period',
    (SELECT count(*)::int FROM notification_channels
      WHERE user_id = '77777777-7777-7777-7777-777777777777'),
    0);

  PERFORM assert_eq(
    'the public profile is anonymised when that is what was chosen',
    (SELECT bio IS NULL AND headline IS NULL AND visibility = 'private' AND indexable = false
       FROM profiles WHERE user_id = '77777777-7777-7777-7777-777777777777'),
    true);

  PERFORM assert_eq(
    'and the name that identifies them is gone from the account too',
    (SELECT display_name IS NULL AND handle IS NULL FROM users
      WHERE id = '77777777-7777-7777-7777-777777777777'),
    true);

  PERFORM assert_eq(
    'a deactivated account can no longer be sent anything',
    enqueue_notification('77777777-7777-7777-7777-777777777777', 'opportunity_closed',
                         'Something you saved has closed.'),
    NULL::uuid);
END $$;

-- The grace period is real: a purge run today deletes nothing.
SELECT assert_eq(
  'a purge inside the grace window deletes no account',
  (purge_expired_data()->>'accounts_purged')::int,
  0);

SELECT assert_eq(
  'the account still exists during the grace period',
  (SELECT count(*)::int FROM users WHERE id = '77777777-7777-7777-7777-777777777777'),
  1);

-- Backdate past the window and the purge destroys it.
UPDATE users SET deleted_at = now() - interval '31 days'
 WHERE id = '77777777-7777-7777-7777-777777777777';

SELECT assert_eq(
  'a purge after the window deletes the account',
  (purge_expired_data()->>'accounts_purged')::int,
  1);

SELECT assert_eq(
  'and everything hanging off it goes with it',
  (SELECT count(*)::int FROM tracker_entries
    WHERE user_id = '77777777-7777-7777-7777-777777777777')
  + (SELECT count(*)::int FROM notifications
      WHERE user_id = '77777777-7777-7777-7777-777777777777')
  + (SELECT count(*)::int FROM profiles
      WHERE user_id = '77777777-7777-7777-7777-777777777777'),
  0);

SELECT assert_true(
  'the purge reports the retention rules it cannot yet enforce',
  jsonb_array_length(purge_expired_data()->'not_yet_enforced') = 3);

ROLLBACK;
