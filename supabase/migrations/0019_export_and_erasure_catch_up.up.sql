-- Export, deletion and retention, brought up to date with Phases 5 and 6.
--
-- Migration 0011 wrote these three functions before intents, teams, requests, threads,
-- messages or projects existed. It said so honestly — purge_expired_data() returns a
-- `not_yet_enforced` list naming the rules it could not apply yet, because "a no-op that
-- looks like enforcement is worse than a gap that is documented".
--
-- The tables exist now, so the gap has to close rather than stay documented:
--
--   PRIVACY_AND_COMPLIANCE.md §5 portability covers "the tracker, PROJECTS and profile",
--   and export_my_account() carried neither projects nor anything from Phase 5. An export
--   that silently omits half of what a person wrote is worse than no export, because they
--   have no way to know what is missing.
--
--   §5 erasure: "immediate deactivation" must actually stop everything. Before this
--   migration a deleted account's intents stayed listed in rooms, its teams kept accepting
--   requests, and its threads stayed open — the account was deactivated and its presence
--   was not.
--
--   §8 retention: closed threads are purged by expire_collaboration(), but declined
--   requests had no rule anywhere.
--
-- All three of 0011's originals are reproduced verbatim in this migration's down file.

/**
 * Withdrawing intent must always be possible — even for an account that is restricted,
 * suspended or being deleted.
 *
 * 0016's trigger refused ANY write to `intents` from a non-active account, which is right
 * for declaring intent and wrong for taking it back. Two consequences, both real:
 * request_account_deletion below could not withdraw a leaving user's intent (the trigger
 * raised, and the deletion failed outright), and a restricted user could not remove
 * themselves from a room they no longer wanted to be in. §2.2 `[PR]` says intent is
 * "withdrawable at any time, immediately and completely", and moderation restricts what
 * someone can PUT in front of other people, never their ability to step back.
 *
 * A withdrawal is recognised narrowly: withdrawn_at goes from NULL to set and nothing else
 * changes. Anything else is still a declaration and still checked.
 *
 * 0016's version is reproduced verbatim in this migration's down file.
 */
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
  v_is_withdrawal boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_is_withdrawal :=
      NEW.withdrawn_at IS NOT NULL
      AND OLD.withdrawn_at IS NULL
      AND NEW.stance = OLD.stance
      AND NEW.roles_offered = OLD.roles_offered
      AND NEW.note IS NOT DISTINCT FROM OLD.note;
  END IF;

  IF v_is_withdrawal THEN
    -- Nothing to check and nothing to recompute: the row is being stood down, and the
    -- expiry it already carries stays as the record of when it would have lapsed anyway.
    NEW.expires_at := OLD.expires_at;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  SELECT account_state, age_confirmed_18 INTO v_state, v_confirmed
    FROM users WHERE id = NEW.user_id;

  IF v_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'only an active account may declare intent (account_state=%)', v_state;
  END IF;
  IF v_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'connecting with other people requires confirming you are 18 or over';
  END IF;

  SELECT deadline_at, status INTO v_deadline, v_status
    FROM opportunities WHERE id = NEW.opportunity_id;

  IF v_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'intent may only be declared on a published opportunity';
  END IF;

  NEW.expires_at := coalesce(v_deadline, now() + interval '90 days');
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

/**
 * Everything the product holds about the caller, now including what Phases 5 and 6 added.
 *
 * Other people's words are NOT here, with one exception. A thread has two sides, and the
 * export carries this person's own messages plus the fact of the conversation — not the
 * other participant's text, which is theirs. The exception is the request they received or
 * sent, because a request is addressed to one named person and its content is the reason
 * they are in each other's lives at all; excluding it would make the record unreadable.
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
    'format', 'mbele-account-export-v2',
    'notice', 'Everything this product holds about your account. Opportunity records are public data and are referenced by slug rather than copied. Messages other people wrote are not included — those are theirs.',
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
        FROM reports rp WHERE rp.reporter_user_id = v_user), '[]'::jsonb),

    -- ── Phase 6: projects, which §5 names explicitly ──
    'projects', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'slug', p.slug, 'title', p.title, 'pitch', p.pitch, 'problem', p.problem,
          'solution', p.solution, 'target_users', p.target_users,
          'state', p.state, 'visibility', p.visibility, 'indexable', p.indexable,
          'repo_url', p.repo_url, 'demo_url', p.demo_url, 'docs_url', p.docs_url,
          'country', p.country_iso2, 'created_at', p.created_at,
          'tags', coalesce(ARRAY(SELECT t.name FROM tags t
                                  WHERE t.id = ANY (p.category_ids || p.industry_ids
                                                    || p.skill_ids || p.technology_ids
                                                    || p.roles_needed)), '{}'::text[]),
          'entered', coalesce((SELECT jsonb_agg(jsonb_build_object(
                'opportunity', o2.slug, 'outcome', s.outcome, 'recorded_at', s.recorded_at))
              FROM project_submissions s JOIN opportunities o2 ON o2.id = s.opportunity_id
             WHERE s.project_id = p.id), '[]'::jsonb))
          ORDER BY p.created_at)
        FROM projects p WHERE p.owner_user_id = v_user AND p.deleted_at IS NULL), '[]'::jsonb),
    'project_memberships', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'project', p.slug, 'title', p.title, 'joined_at', m.joined_at,
          'role', (SELECT t.name FROM tags t WHERE t.id = m.role_id))
          ORDER BY m.joined_at)
        FROM project_members m JOIN projects p ON p.id = m.project_id
       WHERE m.user_id = v_user AND m.is_owner = false), '[]'::jsonb),

    -- ── Phase 5: intent, teams, requests, and your own messages ──
    'intents', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'opportunity', o.slug, 'stance', i.stance, 'roles_offered', i.roles_offered,
          'note', i.note, 'expires_at', i.expires_at, 'withdrawn_at', i.withdrawn_at,
          'created_at', i.created_at) ORDER BY i.created_at)
        FROM intents i JOIN opportunities o ON o.id = i.opportunity_id
       WHERE i.user_id = v_user), '[]'::jsonb),
    'teams', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'opportunity', o.slug, 'name', t.name, 'pitch', t.pitch,
          'roles_needed', t.roles_needed, 'max_size', t.max_size, 'state', t.state,
          'i_own_it', t.owner_user_id = v_user, 'joined_at', m.joined_at)
          ORDER BY m.joined_at)
        FROM team_members m
        JOIN teams t ON t.id = m.team_id
        JOIN opportunities o ON o.id = t.opportunity_id
       WHERE m.user_id = v_user), '[]'::jsonb),
    'requests_i_sent', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'context', r.context, 'role', r.role, 'message', r.message, 'state', r.state,
          'created_at', r.created_at, 'decided_at', r.decided_at) ORDER BY r.created_at)
        FROM collaboration_requests r WHERE r.requester_user_id = v_user), '[]'::jsonb),
    'requests_i_received', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'context', r.context, 'role', r.role, 'message', r.message, 'state', r.state,
          'created_at', r.created_at, 'decided_at', r.decided_at) ORDER BY r.created_at)
        FROM collaboration_requests r WHERE r.target_user_id = v_user), '[]'::jsonb),
    'my_messages', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'thread', msg.thread_id, 'body', msg.body, 'created_at', msg.created_at)
          ORDER BY msg.created_at)
        FROM thread_messages msg WHERE msg.sender_user_id = v_user), '[]'::jsonb),
    -- A block list is the one thing here that is about someone else, and it is included
    -- because it is a decision this person made and may want to keep. §4 keeps it private
    -- from the blocked user, not from its owner.
    'people_i_blocked', coalesce((SELECT jsonb_agg(b.blocked_user_id ORDER BY b.created_at)
        FROM blocks b WHERE b.blocker_user_id = v_user), '[]'::jsonb)
  );
END
$$;

/**
 * Deletion, with Phase 5 and 6 presence actually withdrawn.
 *
 * "Immediate deactivation" has to mean the account stops being PRESENT, not just that it
 * stops signing in. Before this, a deleted account's intent stayed listed in rooms, its
 * teams kept taking requests, and its threads stayed open — so the other people in them
 * were left waiting on someone who had gone.
 *
 * §4.3's ownership rule is applied here too: "If the owner leaves, ownership transfers to
 * the longest-standing member; if none, the team disbands."
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
  r record;
  v_heir uuid;
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

  DELETE FROM notification_channels WHERE user_id = v_user;
  UPDATE notification_deliveries d
     SET state = 'suppressed', error = 'account deletion requested'
    FROM notifications n
   WHERE n.id = d.notification_id AND n.user_id = v_user
     AND d.state IN ('queued','deferred');

  -- ── Presence, withdrawn now rather than at purge time ──

  -- Intent disappears from every room, in both directions.
  UPDATE intents SET withdrawn_at = now()
   WHERE user_id = v_user AND withdrawn_at IS NULL;

  -- Pending requests either way are withdrawn: nobody should be deciding on a request from
  -- an account that has gone, and nobody should be waiting for a decision that cannot come.
  UPDATE collaboration_requests
     SET state = 'withdrawn', decided_at = now()
   WHERE state = 'pending'
     AND (requester_user_id = v_user OR target_user_id = v_user);

  -- Open threads close, with a reason the other person can read.
  UPDATE threads
     SET state = 'closed', closed_at = now(), closed_reason = 'account_closed'
   WHERE state = 'open' AND (user_a = v_user OR user_b = v_user);

  UPDATE handoff_proposals SET state = 'withdrawn', decided_at = now()
   WHERE state = 'proposed' AND proposer_user_id = v_user;

  -- §4.3: teams they own pass to the longest-standing member, or disband.
  FOR r IN SELECT id FROM teams
            WHERE owner_user_id = v_user AND state IN ('forming','open_for_roles','full')
  LOOP
    SELECT m.user_id INTO v_heir
      FROM team_members m
      JOIN users u ON u.id = m.user_id
     WHERE m.team_id = r.id AND m.user_id <> v_user
       AND u.account_state = 'active'
     ORDER BY m.joined_at
     LIMIT 1;

    IF v_heir IS NULL THEN
      UPDATE teams SET state = 'disbanded' WHERE id = r.id;
      -- Requesters are notified, per §4.3, rather than left waiting for a team that is gone.
      UPDATE collaboration_requests SET state = 'withdrawn', decided_at = now()
       WHERE team_id = r.id AND state = 'pending';
    ELSE
      UPDATE teams SET owner_user_id = v_heir WHERE id = r.id;
      UPDATE team_members SET role = 'owner' WHERE team_id = r.id AND user_id = v_heir;
      PERFORM enqueue_notification(
        v_heir, 'team_update',
        'You are now the owner of a team you were in — the previous owner closed their account.',
        jsonb_build_object('team_id', r.id));
    END IF;
  END LOOP;

  DELETE FROM team_members WHERE user_id = v_user;

  -- Projects stop being visible immediately. They are NOT deleted here: the 30-day window
  -- is a way back, and a cancelled deletion that returned an empty project list would make
  -- the window worthless. The purge takes them with the user row.
  UPDATE projects SET visibility = 'private', indexable = false
   WHERE owner_user_id = v_user AND deleted_at IS NULL;
  DELETE FROM project_members WHERE user_id = v_user AND is_owner = false;

  IF p_anonymise THEN
    UPDATE profiles
       SET visibility = 'private', indexable = false,
           headline = NULL, bio = NULL, city = NULL, country_iso2 = NULL,
           github_url = NULL, portfolio_url = NULL, other_url = NULL,
           open_to = '{}'::text[], availability_hours_per_week = NULL,
           embedding = NULL
     WHERE user_id = v_user;
    UPDATE users SET display_name = NULL, handle = NULL WHERE id = v_user;
  ELSE
    DELETE FROM profiles WHERE user_id = v_user;
    UPDATE users SET display_name = NULL, handle = NULL WHERE id = v_user;
  END IF;

  RETURN v_purge_at;
END
$$;

/**
 * The retention job, with §8's remaining gap closed.
 *
 * Declined requests: 90 days. They are never surfaced publicly (§2.5) and their only
 * continuing purpose is the 7-day re-request cooldown, which has long expired by then — so
 * keeping the message text is holding someone's words for nothing.
 *
 * Message and thread retention stays in expire_collaboration() (migration 0016), which runs
 * hourly; duplicating it here would be a second implementation of one rule.
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
  v_requests int;
  v_matches int;
BEGIN
  WITH gone AS (
    DELETE FROM users
     WHERE account_state = 'deleted'
       AND deleted_at IS NOT NULL
       AND deleted_at < now() - interval '30 days'
    RETURNING 1)
  SELECT count(*)::int INTO v_accounts FROM gone;

  WITH gone AS (
    DELETE FROM rate_limit_counters WHERE expires_at < now() - interval '30 days'
    RETURNING 1)
  SELECT count(*)::int INTO v_events FROM gone;

  WITH gone AS (
    DELETE FROM admin_audit_log WHERE ts < now() - interval '24 months'
    RETURNING 1)
  SELECT count(*)::int INTO v_audit FROM gone;

  WITH gone AS (
    DELETE FROM moderation_actions WHERE created_at < now() - interval '24 months'
    RETURNING 1)
  SELECT count(*)::int INTO v_moderation FROM gone;

  WITH gone AS (
    DELETE FROM raw_documents WHERE fetched_at < now() - interval '90 days'
    RETURNING 1)
  SELECT count(*)::int INTO v_docs FROM gone;

  WITH gone AS (
    DELETE FROM unsubscribe_tokens WHERE used_at IS NOT NULL AND used_at < now() - interval '90 days'
    RETURNING 1)
  SELECT count(*)::int INTO v_tokens FROM gone;

  -- §2.5 and §8: declined and withdrawn requests, 90 days after the decision.
  WITH gone AS (
    DELETE FROM collaboration_requests
     WHERE state IN ('declined','withdrawn','expired')
       AND decided_at IS NOT NULL
       AND decided_at < now() - interval '90 days'
       -- A request with a thread on it is the record of a connection (§3.4), so it outlives
       -- the request. Deleting it would cascade the thread away.
       AND NOT EXISTS (SELECT 1 FROM threads th WHERE th.request_id = collaboration_requests.id)
    RETURNING 1)
  SELECT count(*)::int INTO v_requests FROM gone;

  -- Match rows for opportunities that have closed: derived data with nothing left to say.
  WITH gone AS (
    DELETE FROM project_opportunity_matches m
     USING opportunities o
     WHERE o.id = m.opportunity_id
       AND (o.status <> 'published' OR o.deleted_at IS NOT NULL)
    RETURNING 1)
  SELECT count(*)::int INTO v_matches FROM gone;

  RETURN jsonb_build_object(
    'accounts_purged', v_accounts,
    'rate_limit_rows_purged', v_events,
    'audit_rows_purged', v_audit,
    'moderation_rows_purged', v_moderation,
    'raw_documents_purged', v_docs,
    'unsubscribe_tokens_purged', v_tokens,
    'decided_requests_purged', v_requests,
    'stale_project_matches_purged', v_matches,
    'enforced_elsewhere', jsonb_build_array(
      'messages and threads: expire_collaboration(), hourly (migration 0016)',
      'project inactivity: project_inactivity_sweep(), nightly (migration 0018)'),
    'not_yet_enforced', jsonb_build_array(
      'raw event rollup to daily aggregates (no events table until Phase 3)')
  );
END
$$;
