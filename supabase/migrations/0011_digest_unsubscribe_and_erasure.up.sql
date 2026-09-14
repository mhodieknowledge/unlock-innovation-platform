-- 0011 the digest, sessionless unsubscribe, self-serve export and erasure
--
-- NOTIFICATIONS.md §5 and §9; PRIVACY_AND_COMPLIANCE.md §5 and §8.
--
-- Phase 2's last two acceptance criteria live here: "Export produces complete
-- JSON; delete removes the account within the stated 30 days."

-- ── §9 unsubscribe, without a session ───────────────────────────────────────
--
-- "The in-message link works without a session, via a signed token, and
-- unsubscribes from THAT TYPE ONLY — never from everything, and never silently
-- from security messages."
--
-- A STORED random token rather than an HMAC. A signature would put the signing key
-- in two tiers that cannot share code — the batch tier writes the link, the edge
-- redeems it — and the two implementations would have to agree forever. A stored
-- capability needs no key at all, is revocable, and is inert once used. The
-- property §9 actually asks for is "works without a session", which this has.
CREATE TABLE unsubscribe_tokens (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       notif_type NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz,
  UNIQUE (user_id, type)
);
ALTER TABLE unsubscribe_tokens ENABLE ROW LEVEL SECURITY;
-- No policy. Reachable only through the definer functions below, so possession of
-- the token is the only thing that grants anything — and it grants one narrow act.

COMMENT ON TABLE unsubscribe_tokens IS
  'One long-lived capability per (user, type). Long-lived on purpose: the unsubscribe link in a six-month-old email must still work.';

/**
 * Issue (or fetch) the token for one type. Batch tier: called while rendering a
 * message. Stable across messages, so every email for a type carries the same link.
 */
CREATE OR REPLACE FUNCTION issue_unsubscribe_token(p_user_id uuid, p_type notif_type)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE v_token text;
BEGIN
  -- 32 bytes of urlsafe randomness. Guessing one is not a realistic attack, and
  -- the worst outcome of a guess is that someone receives fewer messages.
  INSERT INTO unsubscribe_tokens (user_id, type, token)
  VALUES (p_user_id, p_type,
          rtrim(replace(replace(encode(gen_random_bytes(32),'base64'),'+','-'),'/','_'), '='))
  ON CONFLICT (user_id, type) DO UPDATE SET user_id = EXCLUDED.user_id
  RETURNING token INTO v_token;
  RETURN v_token;
END
$$;

/**
 * What a token would do, without doing it.
 *
 * §9's confirmation page has to name the type and offer "reduce frequency instead"
 * as an EQUAL-WEIGHT option, which it cannot do without knowing the type first. A
 * GET that already unsubscribed you would also be unsafe: mail scanners follow
 * links.
 */
CREATE OR REPLACE FUNCTION describe_unsubscribe_token(p_token text)
RETURNS TABLE (type notif_type, already_used boolean, digest_frequency text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.type,
         t.used_at IS NOT NULL,
         coalesce(s.digest_frequency, 'weekly')
    FROM unsubscribe_tokens t
    LEFT JOIN user_notification_settings s ON s.user_id = t.user_id
   WHERE t.token = p_token
$$;

/**
 * Redeem it. 'off' turns that one type off on every channel; 'reduce' moves a daily
 * digest to weekly instead.
 *
 * Security messages are never turned off (§9). The token for them exists so the
 * link in a security email is not broken, and redeeming it says so plainly rather
 * than pretending to have worked.
 */
CREATE OR REPLACE FUNCTION redeem_unsubscribe_token(p_token text, p_action text DEFAULT 'off')
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_type notif_type;
  v_channel notif_channel;
BEGIN
  SELECT user_id, type INTO v_user, v_type FROM unsubscribe_tokens WHERE token = p_token;
  IF v_user IS NULL THEN RETURN 'unknown'; END IF;

  IF v_type = 'security' THEN
    RETURN 'security_cannot_be_disabled';
  END IF;

  IF p_action = 'reduce' THEN
    INSERT INTO user_notification_settings (user_id, digest_frequency)
    VALUES (v_user, 'weekly')
    ON CONFLICT (user_id) DO UPDATE SET digest_frequency = 'weekly', updated_at = now();
    UPDATE unsubscribe_tokens SET used_at = now() WHERE token = p_token;
    RETURN 'reduced';
  END IF;

  IF v_type = 'digest' THEN
    INSERT INTO user_notification_settings (user_id, digest_frequency)
    VALUES (v_user, 'off')
    ON CONFLICT (user_id) DO UPDATE SET digest_frequency = 'off', updated_at = now();
  END IF;

  FOREACH v_channel IN ARRAY ARRAY['email','telegram','web_push']::notif_channel[] LOOP
    INSERT INTO notification_preferences (user_id, type, channel, enabled)
    VALUES (v_user, v_type, v_channel, false)
    ON CONFLICT (user_id, type, channel) DO UPDATE SET enabled = false;
  END LOOP;

  -- §9: "honoured immediately and never followed by a 'are you sure?' email."
  -- Anything already queued for this type is dropped, not sent.
  UPDATE notification_deliveries d
     SET state = 'suppressed', error = 'unsubscribed'
    FROM notifications n
   WHERE n.id = d.notification_id
     AND n.user_id = v_user AND n.type = v_type
     AND d.channel <> 'in_app'
     AND d.state IN ('queued','deferred');

  UPDATE unsubscribe_tokens SET used_at = now() WHERE token = p_token;
  RETURN 'unsubscribed';
END
$$;

-- ── §5.1 the digest ─────────────────────────────────────────────────────────

/**
 * The digest's contents for one user, in §5.1's fixed order and hard caps:
 *
 *   1. Closing in <= 3 days from your tracker        (max 3)
 *   2. New, eligible, closing <= 30 days             (max 4)
 *   3. New matches for your projects                 (max 2)  -- Phase 6
 *   4. Pending requests awaiting your decision       (max 1)  -- Phase 5
 *   Total: never more than 8.
 *
 * Sections 3 and 4 return nothing until the features behind them exist. They are
 * present as empty sections rather than absent so the shape of the digest does not
 * change when they arrive — and so nobody is tempted to pad the digest to eight
 * items, which §5.1's suppression rules exist to prevent.
 *
 * The verdict comes from user_verdicts, the same SQL mirror the bot uses, so the
 * digest cannot claim an eligibility the site would not.
 */
CREATE OR REPLACE FUNCTION digest_items(p_user_id uuid)
RETURNS TABLE (
  section     int,
  slug        text,
  title       text,
  organisation text,
  deadline_at timestamptz,
  deadline_precision text,
  is_rolling  boolean,
  verdict     text,
  detail      text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz;
  v_country char(2);
BEGIN
  -- "New" means new to this reader: anything published since their last digest.
  -- Falling back to seven days on the first digest keeps the first one from being
  -- a dump of the entire catalogue.
  SELECT coalesce(max(created_at), now() - interval '7 days') INTO v_since
    FROM notifications WHERE user_id = p_user_id AND type = 'digest';

  SELECT country_of_residence INTO v_country
    FROM eligibility_profiles WHERE user_id = p_user_id;

  RETURN QUERY
  -- 1. From your tracker, closing within 3 days.
  SELECT 1, o.slug, o.title, org.name, o.deadline_at, o.deadline_precision::text,
         o.is_rolling, v.verdict, NULL::text
    FROM tracker_entries t
    JOIN opportunities o ON o.id = t.opportunity_id
    LEFT JOIN organisations org ON org.id = o.organisation_id
    LEFT JOIN LATERAL (SELECT uv.verdict FROM user_verdicts(p_user_id, ARRAY[o.id]) uv) v ON true
   WHERE t.user_id = p_user_id
     AND t.state IN ('saved','planning_to_apply')
     AND o.status = 'published'
     AND o.deadline_at IS NOT NULL
     AND o.deadline_at > now()
     AND o.deadline_at <= now() + interval '3 days'
   ORDER BY o.deadline_at
   LIMIT 3;

  RETURN QUERY
  -- 2. New since the last digest, open to this reader, closing within 30 days.
  SELECT 2, o.slug, o.title, org.name, o.deadline_at, o.deadline_precision::text,
         o.is_rolling, v.verdict, NULL::text
    FROM opportunities o
    LEFT JOIN organisations org ON org.id = o.organisation_id
    LEFT JOIN LATERAL (SELECT uv.verdict FROM user_verdicts(p_user_id, ARRAY[o.id]) uv) v ON true
   WHERE o.status = 'published'
     AND o.published_at > v_since
     AND o.deadline_at IS NOT NULL
     AND o.deadline_at > now()
     AND o.deadline_at <= now() + interval '30 days'
     AND (v_country IS NULL
          OR o.eligibility_scope IN ('africa_wide','global')
          OR btrim(v_country) = ANY (SELECT btrim(c) FROM unnest(o.eligible_countries) AS c))
     -- §5.1 says "new, ELIGIBLE". not_eligible items are excluded here — unlike a
     -- search page, where they are down-ranked but never hidden, because a push
     -- costs the reader attention they did not ask to spend.
     AND coalesce(v.verdict, 'unclear') <> 'not_eligible'
     AND NOT EXISTS (SELECT 1 FROM tracker_entries t
                      WHERE t.user_id = p_user_id AND t.opportunity_id = o.id)
   ORDER BY o.deadline_at
   LIMIT 4;
END
$$;

-- ── PRIVACY_AND_COMPLIANCE.md §5 export ─────────────────────────────────────

/**
 * "JSON of everything held" for the CALLER. Takes no user id on purpose: a
 * SECURITY DEFINER function that exports any account by id is an export oracle,
 * and one wrong grant would turn it into a breach. auth.uid() cannot be forged by
 * a caller holding only the anon key.
 *
 * Includes the eligibility profile, which is otherwise unreadable by anyone but
 * its owner — the point of §5's access right is that the owner IS entitled to it.
 */
CREATE OR REPLACE FUNCTION export_my_account()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'export_my_account requires a signed-in caller';
  END IF;

  RETURN jsonb_build_object(
    'exported_at', now(),
    'format', 'mbele-account-export-v1',
    'notice', 'Everything this product holds about your account. Opportunity records are public data and are referenced by slug rather than copied.',
    'account', (SELECT to_jsonb(x) FROM (
        SELECT id, email, handle, display_name, account_state, age_confirmed_18,
               timezone, locale, low_data_mode, auth_provider, created_at, last_seen_at
          FROM users WHERE id = v_user) x),
    'profile', (SELECT to_jsonb(p) FROM profiles p WHERE p.user_id = v_user),
    'eligibility_profile', (SELECT to_jsonb(e) FROM eligibility_profiles e WHERE e.user_id = v_user),
    'tracker', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'opportunity', o.slug, 'title', o.title, 'state', t.state,
          'note', t.note, 'applied_at', t.applied_at, 'remind_at', t.remind_at,
          'created_at', t.created_at, 'updated_at', t.updated_at)
          ORDER BY t.created_at)
        FROM tracker_entries t JOIN opportunities o ON o.id = t.opportunity_id
       WHERE t.user_id = v_user), '[]'::jsonb),
    'notification_settings', (SELECT to_jsonb(s) FROM user_notification_settings s
                               WHERE s.user_id = v_user),
    'notification_channels', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'channel', c.channel, 'address', c.address, 'verified_at', c.verified_at,
          'is_active', c.is_active, 'paused_until', c.paused_until))
        FROM notification_channels c WHERE c.user_id = v_user), '[]'::jsonb),
    'notification_preferences', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'type', pr.type, 'channel', pr.channel, 'enabled', pr.enabled))
        FROM notification_preferences pr WHERE pr.user_id = v_user), '[]'::jsonb),
    'notifications', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'type', n.type, 'reason', n.reason, 'payload', n.payload,
          'created_at', n.created_at, 'read_at', n.read_at) ORDER BY n.created_at)
        FROM notifications n WHERE n.user_id = v_user), '[]'::jsonb),
    'organisation_memberships', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'organisation', og.slug, 'role', m.role, 'created_at', m.created_at))
        FROM organisation_members m JOIN organisations og ON og.id = m.organisation_id
       WHERE m.user_id = v_user), '[]'::jsonb),
    'reports_i_filed', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'reason', rp.reason, 'detail', rp.detail, 'state', rp.state, 'created_at', rp.created_at)
          ORDER BY rp.created_at)
        FROM reports rp WHERE rp.reporter_user_id = v_user), '[]'::jsonb)
  );
END
$$;

-- ── PRIVACY_AND_COMPLIANCE.md §5 erasure ────────────────────────────────────

/**
 * Self-serve deletion: "30-day grace with immediate deactivation; user chooses
 * whether public content is anonymised or removed".
 *
 * Immediate deactivation is what makes the grace period acceptable. The account
 * stops working NOW — no sign-in, no notifications, nothing public — and the data
 * is destroyed at the end of the window, giving a person who acted in anger or by
 * mistake a way back without keeping their account alive in the meantime.
 *
 * The eligibility profile does NOT wait: §8 says it is "deleted immediately on
 * request", and it is the most sensitive thing held. It is destroyed here, in the
 * same statement, and a cancelled deletion does not bring it back. Deleting the
 * most sensitive data first is the right way round.
 */
CREATE OR REPLACE FUNCTION request_account_deletion(p_anonymise boolean DEFAULT true)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_purge_at timestamptz := now() + interval '30 days';
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'request_account_deletion requires a signed-in caller';
  END IF;

  UPDATE users
     SET account_state = 'deleted',
         deleted_at = now()
   WHERE id = v_user;

  -- Immediately, not in 30 days.
  DELETE FROM eligibility_profiles WHERE user_id = v_user;

  -- All processing stops except security (§5's "Restriction" row, applied here
  -- too: there is no reason to keep pushing to an account being deleted).
  DELETE FROM notification_channels WHERE user_id = v_user;
  UPDATE notification_deliveries d
     SET state = 'suppressed', error = 'account deletion requested'
    FROM notifications n
   WHERE n.id = d.notification_id AND n.user_id = v_user
     AND d.state IN ('queued','deferred');

  IF p_anonymise THEN
    -- The public profile stops saying anything about them, but the row survives so
    -- contributions other people are part of keep their shape. §5: the user chooses
    -- "whether public content is anonymised or removed", and this is the anonymised
    -- branch, so every free-text and link field goes.
    UPDATE profiles
       SET visibility = 'private', indexable = false,
           headline = NULL, bio = NULL, city = NULL, country_iso2 = NULL,
           github_url = NULL, portfolio_url = NULL, other_url = NULL,
           open_to = '{}'::text[], availability_hours_per_week = NULL,
           embedding = NULL
     WHERE user_id = v_user;
    -- The display name lives on users, and is what actually identifies someone.
    UPDATE users SET display_name = NULL, handle = NULL WHERE id = v_user;
  ELSE
    DELETE FROM profiles WHERE user_id = v_user;
    UPDATE users SET display_name = NULL, handle = NULL WHERE id = v_user;
  END IF;

  RETURN v_purge_at;
END
$$;

/** A way back inside the grace window. The profile is gone regardless. */
CREATE OR REPLACE FUNCTION cancel_account_deletion()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user uuid := auth.uid(); v_ok boolean;
BEGIN
  IF v_user IS NULL THEN RETURN false; END IF;
  UPDATE users
     SET account_state = 'active', deleted_at = NULL
   WHERE id = v_user AND account_state = 'deleted'
     AND deleted_at > now() - interval '30 days'
  RETURNING true INTO v_ok;
  RETURN coalesce(v_ok, false);
END
$$;

/**
 * The retention job. §8 `[PR]`: "Retention is enforced by a scheduled job, not by
 * policy alone. A retention rule nobody executes is not a retention rule."
 *
 * Returns what it destroyed, so the job's log is evidence rather than reassurance.
 * Rules for tables that do not exist yet (messages, requests) are absent rather
 * than stubbed — a no-op that looks like enforcement is worse than a gap that is
 * documented. They are listed in the RETURN so the gap is visible in the output.
 */
CREATE OR REPLACE FUNCTION purge_expired_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_accounts int;
  v_events int;
  v_audit int;
  v_moderation int;
  v_docs int;
  v_tokens int;
BEGIN
  -- Accounts past the 30-day grace. ON DELETE CASCADE carries the tracker,
  -- notifications, channels and preferences with them.
  WITH gone AS (
    DELETE FROM users
     WHERE account_state = 'deleted'
       AND deleted_at IS NOT NULL
       AND deleted_at < now() - interval '30 days'
    RETURNING 1)
  SELECT count(*)::int INTO v_accounts FROM gone;

  -- Hashed IPs and raw events: 30 days.
  WITH gone AS (
    DELETE FROM rate_limit_counters WHERE expires_at < now() - interval '30 days'
    RETURNING 1)
  SELECT count(*)::int INTO v_events FROM gone;

  -- Admin audit log: 24 months.
  WITH gone AS (
    DELETE FROM admin_audit_log WHERE ts < now() - interval '24 months'
    RETURNING 1)
  SELECT count(*)::int INTO v_audit FROM gone;

  -- Moderation records: 24 months, and only then. §5: records of confirmed safety
  -- violations are retained "for the protection of others" even past an account's
  -- deletion, which is why this is a time rule and not an account rule.
  WITH gone AS (
    DELETE FROM moderation_actions WHERE created_at < now() - interval '24 months'
    RETURNING 1)
  SELECT count(*)::int INTO v_moderation FROM gone;

  -- raw_documents: 90 days in the database (§8; also a storage measure).
  WITH gone AS (
    DELETE FROM raw_documents WHERE fetched_at < now() - interval '90 days'
    RETURNING 1)
  SELECT count(*)::int INTO v_docs FROM gone;

  -- Spent unsubscribe capabilities.
  WITH gone AS (
    DELETE FROM unsubscribe_tokens WHERE used_at IS NOT NULL AND used_at < now() - interval '90 days'
    RETURNING 1)
  SELECT count(*)::int INTO v_tokens FROM gone;

  RETURN jsonb_build_object(
    'accounts_purged', v_accounts,
    'rate_limit_rows_purged', v_events,
    'audit_rows_purged', v_audit,
    'moderation_rows_purged', v_moderation,
    'raw_documents_purged', v_docs,
    'unsubscribe_tokens_purged', v_tokens,
    'not_yet_enforced', jsonb_build_array(
      'messages: 60 days to close, deleted 90 days later (no messages table until Phase 5)',
      'declined requests: 90 days (no requests table until Phase 5)',
      'raw event rollup to daily aggregates (no events table until Phase 3)')
  );
END
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION issue_unsubscribe_token(uuid, notif_type) FROM PUBLIC;
REVOKE ALL ON FUNCTION describe_unsubscribe_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION redeem_unsubscribe_token(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION digest_items(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION export_my_account() FROM PUBLIC;
REVOKE ALL ON FUNCTION request_account_deletion(boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION cancel_account_deletion() FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_expired_data() FROM PUBLIC;

-- Sessionless by design (§9): the token IS the authorisation.
GRANT EXECUTE ON FUNCTION describe_unsubscribe_token(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION redeem_unsubscribe_token(text, text) TO anon, authenticated;

-- These read auth.uid() and can only ever act on the caller's own account.
GRANT EXECUTE ON FUNCTION export_my_account() TO authenticated;
GRANT EXECUTE ON FUNCTION request_account_deletion(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION cancel_account_deletion() TO authenticated;

-- issue_unsubscribe_token, digest_items and purge_expired_data stay batch-tier
-- only: each takes a user id or destroys data, and neither belongs at the edge.
