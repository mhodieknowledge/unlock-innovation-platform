-- Rolls 0019 back to 0011's versions of all three functions.
--
-- Every object here is a REPLACEMENT, not an addition, so the rollback is a restoration.
-- 0011's bodies are reproduced verbatim below; the consequence of rolling back is that an
-- export stops including projects and Phase 5 content, and a deletion stops withdrawing
-- presence — which is exactly the state 0011 left behind and documented.

CREATE OR REPLACE FUNCTION intents_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_deadline timestamptz;
  v_status opp_status;
  v_state account_state;
  v_confirmed boolean;
BEGIN
  SELECT account_state, age_confirmed_18 INTO v_state, v_confirmed
    FROM users WHERE id = NEW.user_id;

  IF v_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'only an active account may declare intent (account_state=%)', v_state;
  END IF;
  IF v_confirmed IS NOT TRUE THEN
    -- PRODUCT_SPEC.md §22.1: accounts are 18+, and the features that connect people to
    -- each other stay off until that is confirmed. Read and eligibility are unaffected.
    RAISE EXCEPTION 'connecting with other people requires confirming you are 18 or over';
  END IF;

  SELECT deadline_at, status INTO v_deadline, v_status
    FROM opportunities WHERE id = NEW.opportunity_id;

  IF v_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'intent may only be declared on a published opportunity';
  END IF;

  -- A rolling or undated opportunity has no deadline to expire against, so intent gets
  -- 90 days. Something has to bound it: §2.2 marks "never permanent" as the rule, and an
  -- unbounded intent on a rolling call is exactly the stale profile it forbids.
  NEW.expires_at := coalesce(v_deadline, now() + interval '90 days');
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

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
