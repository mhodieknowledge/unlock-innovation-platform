-- 0017 — the read side of the room, and one source of truth for the request limits.
--
-- Migration 0016 put the collaboration RULES in the database. This migration adds what
-- the PAGES need, and it exists as a separate migration for a reason worth stating: the
-- room cannot be rendered with plain table reads. §2.2 of TEAM_FORMATION.md fixes exactly
-- what another builder's intent exposes — "display name, country, headline, roles offered
-- and the note. Nothing else, ever" — and `users` has no cross-user read policy at all, so
-- a page that SELECTed from users to draw a builder card would either get nothing or
-- require a policy that exposes more than that list. The functions below return precisely
-- the permitted fields and nothing adjacent to them.
--
-- The other half of this migration is IMPLEMENTATION_PLAN.md §7's fifth `[PR]` criterion:
-- "Rate limits enforced and visible to the user before composing." Enforced and visible
-- are two different code paths, and two code paths with the same numbers written twice is
-- the drift bug this repository has already produced three times (the byte budgets, the
-- secret scanner, the search configuration). So the limits now live in ONE function,
-- request_allowance_for(), which the compose page reads and the INSERT trigger calls. The
-- refusal text the trigger raises is the same string the page shows.

-- ── The request allowance: one place, two callers ────────────────────────────

/**
 * What this user may still send, and why not if not.
 *
 * COLLABORATION_SYSTEM.md §2.4 `[PR]`: "10/day, 3/hour, 5 pending at once."
 *
 * `blocked_reason` is NULL when a request can be sent and otherwise carries the sentence
 * shown to the user — which is also the sentence the trigger raises, because they are read
 * from here. A limit the form believes and a limit the database enforces must never be two
 * different numbers.
 *
 * next_slot_at is the clock answer to "when can I ask someone else?". Pending is the one
 * limit with no clock answer: it clears when somebody replies, not when time passes, so it
 * stays NULL there rather than inventing a time.
 */
CREATE OR REPLACE FUNCTION request_allowance_for(p_user_id uuid)
RETURNS TABLE (
  day_used int, day_limit int,
  hour_used int, hour_limit int,
  pending_used int, pending_limit int,
  next_slot_at timestamptz,
  blocked_reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_day_limit     CONSTANT int := 10;
  v_hour_limit    CONSTANT int := 3;
  v_pending_limit CONSTANT int := 5;
  v_day int;
  v_hour int;
  v_pending int;
  v_next timestamptz;
  v_reason text;
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;

  SELECT count(*)::int INTO v_day
    FROM collaboration_requests
   WHERE requester_user_id = p_user_id AND created_at > now() - interval '24 hours';

  SELECT count(*)::int INTO v_hour
    FROM collaboration_requests
   WHERE requester_user_id = p_user_id AND created_at > now() - interval '1 hour';

  SELECT count(*)::int INTO v_pending
    FROM collaboration_requests
   WHERE requester_user_id = p_user_id AND state = 'pending';

  -- Order matters: the day limit is the one that takes longest to clear, so it is the
  -- honest thing to report when both are hit.
  IF v_day >= v_day_limit THEN
    v_reason := format('you have sent %s requests today, which is the daily limit', v_day_limit);
    SELECT min(created_at) + interval '24 hours' INTO v_next
      FROM (SELECT created_at FROM collaboration_requests
             WHERE requester_user_id = p_user_id AND created_at > now() - interval '24 hours'
             ORDER BY created_at DESC LIMIT v_day_limit) recent;
  ELSIF v_hour >= v_hour_limit THEN
    v_reason := format('you have sent %s requests in the last hour, which is the hourly limit', v_hour_limit);
    SELECT min(created_at) + interval '1 hour' INTO v_next
      FROM (SELECT created_at FROM collaboration_requests
             WHERE requester_user_id = p_user_id AND created_at > now() - interval '1 hour'
             ORDER BY created_at DESC LIMIT v_hour_limit) recent;
  ELSIF v_pending >= v_pending_limit THEN
    v_reason := format('you have %s requests waiting for an answer, which is the limit', v_pending_limit);
    v_next := NULL;
  END IF;

  RETURN QUERY SELECT v_day, v_day_limit, v_hour, v_hour_limit,
                      v_pending, v_pending_limit, v_next, v_reason;
END
$$;

/** The signed-in caller's own allowance. Nothing comes back for an anonymous caller. */
CREATE OR REPLACE FUNCTION request_allowance()
RETURNS TABLE (
  day_used int, day_limit int,
  hour_used int, hour_limit int,
  pending_used int, pending_limit int,
  next_slot_at timestamptz,
  blocked_reason text
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT * FROM request_allowance_for(auth.uid());
$$;

/**
 * Replaces 0016's version. Identical behaviour; the three hard-coded limits are gone and
 * the counts now come from request_allowance_for(), so the number the compose page shows
 * and the number the INSERT enforces cannot drift apart.
 *
 * 0016's original is reproduced verbatim in this migration's down file.
 */
CREATE OR REPLACE FUNCTION requests_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
DECLARE
  v_same_message int;
  v_deadline timestamptz;
  v_state account_state;
  v_confirmed boolean;
  v_declined_at timestamptz;
  v_allow record;
BEGIN
  SELECT account_state, age_confirmed_18 INTO v_state, v_confirmed
    FROM users WHERE id = NEW.requester_user_id;
  IF v_state IS DISTINCT FROM 'active' OR v_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'only an active, 18+-confirmed account may send a request';
  END IF;

  -- COLLABORATION_SYSTEM.md §4: "Blocking is absolute and immediate." A blocked user
  -- cannot request, and the refusal must not reveal that a block exists — the application
  -- turns this into the same "could not send" message it shows for a rate limit.
  IF EXISTS (
    SELECT 1 FROM blocks b
     WHERE (b.blocker_user_id = NEW.target_user_id AND b.blocked_user_id = NEW.requester_user_id)
        OR (b.blocker_user_id = NEW.requester_user_id AND b.blocked_user_id = NEW.target_user_id)
  ) THEN
    RAISE EXCEPTION 'request_not_possible';
  END IF;

  -- §2.5: "No re-request to the same target/context for 7 days" after a decline.
  SELECT max(decided_at) INTO v_declined_at
    FROM collaboration_requests
   WHERE requester_user_id = NEW.requester_user_id
     AND target_user_id = NEW.target_user_id
     AND context = NEW.context
     AND state = 'declined';
  IF v_declined_at IS NOT NULL AND v_declined_at > now() - interval '7 days' THEN
    RAISE EXCEPTION 'this request was declined recently; you can try again after %',
      to_char(v_declined_at + interval '7 days', 'FMDD FMMonth');
  END IF;

  -- §2.4's three limits, from the one function the compose page also reads.
  SELECT * INTO v_allow FROM request_allowance_for(NEW.requester_user_id);
  IF v_allow.blocked_reason IS NOT NULL THEN
    RAISE EXCEPTION '%', v_allow.blocked_reason;
  END IF;

  -- §5.3's copy-paste detection. A digest rather than the text, so this check does not
  -- require a searchable store of everyone's messages.
  IF NEW.message IS NOT NULL AND btrim(NEW.message) <> '' THEN
    NEW.message_digest := encode(digest(lower(btrim(NEW.message)), 'sha256'), 'hex');
    SELECT count(DISTINCT target_user_id)::int INTO v_same_message
      FROM collaboration_requests
     WHERE requester_user_id = NEW.requester_user_id
       AND message_digest = NEW.message_digest
       AND created_at > now() - interval '1 hour';
    IF v_same_message >= 3 THEN
      RAISE EXCEPTION
        'that same message has gone to 3 people in the last hour. Write to people individually — identical messages are the main reason requests get ignored.';
    END IF;
  END IF;

  -- §2.3: 14 days, or 72 hours before the related deadline, whichever is sooner.
  SELECT o.deadline_at INTO v_deadline
    FROM opportunities o
   WHERE o.id = coalesce(
           NEW.opportunity_id,
           (SELECT t.opportunity_id FROM teams t WHERE t.id = NEW.team_id));

  NEW.expires_at := least(
    now() + interval '14 days',
    coalesce(v_deadline - interval '72 hours', now() + interval '14 days'));

  -- A deadline already inside 72 hours would give a negative window. The request still
  -- gets an hour: refusing it outright would block exactly the late scramble the room
  -- exists for.
  IF NEW.expires_at <= now() THEN
    NEW.expires_at := now() + interval '1 hour';
  END IF;

  RETURN NEW;
END
$$;

-- ── A requester may withdraw. Nobody may decide their own request ────────────
--
-- 0016's requests_decide policy allowed either participant to UPDATE with no WITH CHECK,
-- which let a REQUESTER write state = 'accepted' on their own request. No membership and
-- no thread would have followed — those only happen inside accept_request() — but the
-- target would have seen an accepted request they never accepted, and §2.3's state machine
-- would be lying. Deciding now has exactly one path: accept_request() / decline_request(),
-- both of which check that the caller is the target.
DROP POLICY IF EXISTS requests_decide ON collaboration_requests;

CREATE POLICY requests_withdraw ON collaboration_requests FOR UPDATE
  USING (requester_user_id = auth.uid() AND state = 'pending')
  WITH CHECK (requester_user_id = auth.uid() AND state = 'withdrawn');

-- ── The room, as the page needs it ───────────────────────────────────────────

/**
 * Builders looking for a team. TEAM_FORMATION.md §3.2 item 3.
 *
 * Returns the five fields §2.2 permits and nothing else. In particular: no handle, no
 * email, no last-seen time, no counts — §3.2 `[PR]` rules out follower counts and online
 * indicators, and the way to keep that true is for the data not to come out of the
 * database at all.
 *
 * Only `looking_for_team` and `have_team_looking_for_roles` are listed: §2.1's table says
 * `going_solo` and `just_interested` are "counted only", so a person watching quietly is
 * not put in front of anyone.
 *
 * The caller must hold an active intent themselves. That is §2.2's "visible only inside
 * that opportunity's room" — co-presence is the entire basis for seeing anyone here.
 */
CREATE OR REPLACE FUNCTION room_builders(p_opportunity_id uuid)
RETURNS TABLE (
  user_id uuid,
  display_name text,
  country_iso2 char(2),
  headline text,
  roles_offered text[],
  note text,
  stance intent_stance,
  leads_a_team boolean,
  request_state request_state
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room text;
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RETURN; END IF;

  SELECT rs.state INTO v_room FROM room_state(p_opportunity_id) rs;
  IF v_room NOT IN ('open', 'archived') THEN RETURN; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM intents mine
     WHERE mine.opportunity_id = p_opportunity_id
       AND mine.user_id = v_me
       AND mine.withdrawn_at IS NULL
       AND mine.expires_at > now()
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT i.user_id,
         u.display_name,
         p.country_iso2,
         p.headline,
         i.roles_offered,
         i.note,
         i.stance,
         EXISTS (SELECT 1 FROM teams t
                  WHERE t.opportunity_id = p_opportunity_id
                    AND t.owner_user_id = i.user_id
                    AND t.state IN ('forming','open_for_roles','full')),
         -- What the viewer has already sent this person, so the card shows "asked"
         -- instead of offering the same action again. Only the viewer's own request.
         (SELECT r.state FROM collaboration_requests r
           WHERE r.requester_user_id = v_me
             AND r.target_user_id = i.user_id
             AND r.context = 'opportunity_intent'
             AND r.opportunity_id = p_opportunity_id
           ORDER BY r.created_at DESC LIMIT 1)
    FROM intents i
    JOIN users u ON u.id = i.user_id
    LEFT JOIN profiles p ON p.user_id = i.user_id
   WHERE i.opportunity_id = p_opportunity_id
     AND i.user_id <> v_me
     AND i.withdrawn_at IS NULL
     AND i.expires_at > now()
     AND i.stance IN ('looking_for_team','have_team_looking_for_roles')
     AND u.account_state = 'active'
     AND u.deleted_at IS NULL
     -- §4: a block removes the person from every surface both people share, in both
     -- directions, and says nothing about why.
     AND NOT EXISTS (
       SELECT 1 FROM blocks b
        WHERE (b.blocker_user_id = v_me AND b.blocked_user_id = i.user_id)
           OR (b.blocker_user_id = i.user_id AND b.blocked_user_id = v_me))
   ORDER BY i.created_at DESC
   LIMIT 60;
END
$$;

/**
 * Open teams. §3.2 item 2: "name, pitch, roles still needed, current size / max, country
 * mix, a 'Request to join' action."
 *
 * The country mix is a distinct list, not a per-member list: it answers "would I be the
 * only one from my country" without telling anyone who is where.
 *
 * owner_stale carries §4.2's `[PR]` rule into the room — "owner inactive for 14 days with
 * pending requests → team marked stale in the room ... so nobody waits on a dead team".
 */
CREATE OR REPLACE FUNCTION room_teams(p_opportunity_id uuid)
RETURNS TABLE (
  team_id uuid,
  name text,
  pitch text,
  roles_needed text[],
  member_count int,
  max_size int,
  countries char(2)[],
  state team_state,
  owner_user_id uuid,
  owner_display_name text,
  owner_stale boolean,
  i_am_member boolean,
  i_own_it boolean,
  my_request_state request_state
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room text;
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RETURN; END IF;

  SELECT rs.state INTO v_room FROM room_state(p_opportunity_id) rs;
  IF v_room NOT IN ('open', 'archived') THEN RETURN; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM intents mine
     WHERE mine.opportunity_id = p_opportunity_id
       AND mine.user_id = v_me
       AND mine.withdrawn_at IS NULL
       AND mine.expires_at > now()
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT t.id,
         t.name,
         t.pitch,
         t.roles_needed,
         (SELECT count(*)::int FROM team_members m WHERE m.team_id = t.id),
         t.max_size::int,
         coalesce((SELECT array_agg(DISTINCT p.country_iso2)
                     FROM team_members m
                     JOIN profiles p ON p.user_id = m.user_id
                    WHERE m.team_id = t.id AND p.country_iso2 IS NOT NULL),
                  ARRAY[]::char(2)[]),
         t.state,
         t.owner_user_id,
         u.display_name,
         t.owner_last_seen_at < now() - interval '14 days',
         EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = v_me),
         t.owner_user_id = v_me,
         (SELECT r.state FROM collaboration_requests r
           WHERE r.requester_user_id = v_me
             AND r.context = 'team_request'
             AND r.team_id = t.id
           ORDER BY r.created_at DESC LIMIT 1)
    FROM teams t
    JOIN users u ON u.id = t.owner_user_id
   WHERE t.opportunity_id = p_opportunity_id
     AND t.state IN ('forming','open_for_roles','full','submitted','archived')
     AND NOT EXISTS (
       SELECT 1 FROM blocks b
        WHERE (b.blocker_user_id = v_me AND b.blocked_user_id = t.owner_user_id)
           OR (b.blocker_user_id = t.owner_user_id AND b.blocked_user_id = v_me))
   ORDER BY (t.state = 'open_for_roles') DESC, t.created_at DESC
   LIMIT 40;
END
$$;

/**
 * "Your status" — §3.2 item 4: your intent, your team, your pending requests.
 *
 * One row, always, for a signed-in caller: a page that has to ask three questions to draw
 * one panel will eventually ask two of them and forget the third.
 */
CREATE OR REPLACE FUNCTION my_room_status(p_opportunity_id uuid)
RETURNS TABLE (
  stance intent_stance,
  roles_offered text[],
  note text,
  intent_expires_at timestamptz,
  my_team_id uuid,
  my_team_name text,
  i_own_my_team boolean,
  requests_in int,
  requests_out int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH me AS (SELECT v_me AS uid),
  -- Your team in THIS room, found on its own rather than by joining team_members into the
  -- same row as your intent. Joining them cost a bug: a member of a team on a DIFFERENT
  -- opportunity produced rows the filter then dropped, so someone who had declared intent
  -- here and had a team elsewhere got no row at all and the room told them they had said
  -- nothing.
  mine AS (
    SELECT t.id, t.name, t.owner_user_id
      FROM team_members m
      JOIN teams t ON t.id = m.team_id
     WHERE m.user_id = v_me
       AND t.opportunity_id = p_opportunity_id
     LIMIT 1)
  SELECT i.stance,
         coalesce(i.roles_offered, ARRAY[]::text[]),
         i.note,
         i.expires_at,
         mt.id,
         mt.name,
         mt.owner_user_id = v_me,
         (SELECT count(*)::int FROM collaboration_requests r
           WHERE r.target_user_id = v_me AND r.state = 'pending'
             AND (r.opportunity_id = p_opportunity_id
                  OR r.team_id IN (SELECT t2.id FROM teams t2
                                    WHERE t2.opportunity_id = p_opportunity_id))),
         (SELECT count(*)::int FROM collaboration_requests r
           WHERE r.requester_user_id = v_me AND r.state = 'pending'
             AND (r.opportunity_id = p_opportunity_id
                  OR r.team_id IN (SELECT t2.id FROM teams t2
                                    WHERE t2.opportunity_id = p_opportunity_id)))
    FROM me
    LEFT JOIN intents i
           ON i.user_id = v_me AND i.opportunity_id = p_opportunity_id
          AND i.withdrawn_at IS NULL AND i.expires_at > now()
    LEFT JOIN mine mt ON true;
END
$$;

-- ── Requests and threads, as the pages need them ─────────────────────────────

/**
 * The decide list. UX_FLOWS.md §11.2: "requester name, country, roles, message".
 *
 * A profile link is in §11.2's list too, and is deliberately absent here: profiles are
 * private by default (COLLABORATION_SYSTEM.md §5.1 `[PR]`) and a request is not consent to
 * be looked up. The room card and this row carry the same five permitted fields, and the
 * page links to a profile only when that profile is actually public.
 */
CREATE OR REPLACE FUNCTION my_requests(p_direction text DEFAULT 'in')
RETURNS TABLE (
  request_id uuid,
  context request_context,
  state request_state,
  role text,
  message text,
  created_at timestamptz,
  expires_at timestamptz,
  counterpart_user_id uuid,
  counterpart_display_name text,
  counterpart_country char(2),
  counterpart_headline text,
  counterpart_roles text[],
  opportunity_slug text,
  opportunity_title text,
  team_id uuid,
  team_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL OR p_direction NOT IN ('in','out') THEN RETURN; END IF;

  RETURN QUERY
  SELECT r.id,
         r.context,
         r.state,
         r.role,
         r.message,
         r.created_at,
         r.expires_at,
         other.id,
         other.display_name,
         p.country_iso2,
         p.headline,
         coalesce(i.roles_offered, ARRAY[]::text[]),
         o.slug,
         o.title,
         t.id,
         t.name
    FROM collaboration_requests r
    JOIN users other
      ON other.id = CASE WHEN p_direction = 'in' THEN r.requester_user_id
                                                 ELSE r.target_user_id END
    LEFT JOIN profiles p ON p.user_id = other.id
    LEFT JOIN teams t ON t.id = r.team_id
    LEFT JOIN opportunities o ON o.id = coalesce(r.opportunity_id, t.opportunity_id)
    LEFT JOIN intents i ON i.user_id = other.id AND i.opportunity_id = o.id
                       AND i.withdrawn_at IS NULL
   WHERE (CASE WHEN p_direction = 'in' THEN r.target_user_id ELSE r.requester_user_id END) = v_me
     AND r.state IN ('pending','accepted','declined')
     -- A block makes the other person disappear from every shared surface (§4). Their
     -- pending requests are cancelled by the block trigger; this keeps the decided ones
     -- out of the list too.
     AND NOT EXISTS (
       SELECT 1 FROM blocks b
        WHERE (b.blocker_user_id = v_me AND b.blocked_user_id = other.id)
           OR (b.blocker_user_id = other.id AND b.blocked_user_id = v_me))
   ORDER BY (r.state = 'pending') DESC, r.created_at DESC
   LIMIT 100;
END
$$;

/** The thread list: who, about what, and when it last moved. */
CREATE OR REPLACE FUNCTION my_threads()
RETURNS TABLE (
  thread_id uuid,
  state text,
  closed_reason text,
  last_message_at timestamptz,
  created_at timestamptz,
  counterpart_display_name text,
  context_label text,
  opportunity_slug text,
  unread_from_them boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT th.id,
         th.state,
         th.closed_reason,
         th.last_message_at,
         th.created_at,
         other.display_name,
         coalesce(t.name, o.title, 'a request'),
         o.slug,
         -- "There is something here you have not sent yourself" — not a read receipt, and
         -- not a count. §3.2 rules out read receipts in the other direction; knowing your
         -- own thread has replies in it is not one.
         EXISTS (SELECT 1 FROM thread_messages msg
                  WHERE msg.thread_id = th.id AND msg.sender_user_id <> v_me)
    FROM threads th
    JOIN collaboration_requests r ON r.id = th.request_id
    JOIN users other ON other.id = CASE WHEN th.user_a = v_me THEN th.user_b ELSE th.user_a END
    LEFT JOIN teams t ON t.id = r.team_id
    LEFT JOIN opportunities o ON o.id = coalesce(r.opportunity_id, t.opportunity_id)
   WHERE th.user_a = v_me OR th.user_b = v_me
   ORDER BY coalesce(th.last_message_at, th.created_at) DESC
   LIMIT 50;
END
$$;

/**
 * One thread's header. The messages themselves come through RLS on thread_messages; this
 * is the part a page cannot read for itself: the other person's name, what the thread is
 * about, and where the handoff stands.
 *
 * handoff_state is a state, not an identifier. Identifiers come only from
 * handoff_identifiers(), which checks that both sides consented (§3.3 `[PR]`).
 */
CREATE OR REPLACE FUNCTION thread_view(p_thread_id uuid)
RETURNS TABLE (
  thread_id uuid,
  state text,
  closed_reason text,
  counterpart_user_id uuid,
  counterpart_display_name text,
  context_label text,
  opportunity_slug text,
  handoff_state text,
  handoff_channel text,
  handoff_proposal_id uuid,
  handoff_is_mine boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  t threads;
BEGIN
  IF v_me IS NULL THEN RETURN; END IF;
  SELECT * INTO t FROM threads WHERE id = p_thread_id;
  IF t.id IS NULL OR (t.user_a <> v_me AND t.user_b <> v_me) THEN RETURN; END IF;

  RETURN QUERY
  SELECT t.id,
         t.state,
         t.closed_reason,
         other.id,
         other.display_name,
         coalesce(tm.name, o.title, 'a request'),
         o.slug,
         h.state,
         h.channel,
         h.id,
         h.proposer_user_id = v_me
    FROM (SELECT 1) anchor
    JOIN users other ON other.id = CASE WHEN t.user_a = v_me THEN t.user_b ELSE t.user_a END
    LEFT JOIN collaboration_requests r ON r.id = t.request_id
    LEFT JOIN teams tm ON tm.id = r.team_id
    LEFT JOIN opportunities o ON o.id = coalesce(r.opportunity_id, tm.opportunity_id)
    LEFT JOIN LATERAL (
      SELECT hp.* FROM handoff_proposals hp
       WHERE hp.thread_id = t.id AND hp.state IN ('proposed','accepted')
       ORDER BY (hp.state = 'accepted') DESC, hp.created_at DESC
       LIMIT 1) h ON true;
END
$$;

/**
 * §3.3: A proposes a channel, B accepts, and only then are identifiers exchanged.
 *
 * A function rather than a bare INSERT because "one live proposal at a time" is the rule
 * that keeps the banner unambiguous: two open proposals on different channels would leave
 * the other side accepting one and not knowing about the other.
 */
CREATE OR REPLACE FUNCTION propose_handoff(p_thread_id uuid, p_channel text, p_identifier text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  t threads;
  v_id uuid;
BEGIN
  IF v_me IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO t FROM threads WHERE id = p_thread_id;
  IF t.id IS NULL OR t.state <> 'open' OR (t.user_a <> v_me AND t.user_b <> v_me) THEN
    RETURN NULL;
  END IF;
  IF p_channel NOT IN ('telegram','whatsapp','email') THEN
    RAISE EXCEPTION 'that is not a channel we hand off to';
  END IF;
  IF btrim(coalesce(p_identifier,'')) = '' THEN
    RAISE EXCEPTION 'give your own contact on that channel — the exchange goes both ways';
  END IF;

  IF EXISTS (SELECT 1 FROM handoff_proposals h
              WHERE h.thread_id = p_thread_id AND h.state = 'accepted') THEN
    RAISE EXCEPTION 'you have already swapped contacts in this conversation';
  END IF;

  -- A new proposal supersedes your own outstanding one rather than stacking on it.
  UPDATE handoff_proposals SET state = 'withdrawn', decided_at = now()
   WHERE thread_id = p_thread_id AND state = 'proposed' AND proposer_user_id = v_me;

  INSERT INTO handoff_proposals (thread_id, proposer_user_id, channel, proposer_identifier)
  VALUES (p_thread_id, v_me, p_channel, left(btrim(p_identifier), 200))
  RETURNING id INTO v_id;

  PERFORM enqueue_notification(
    CASE WHEN t.user_a = v_me THEN t.user_b ELSE t.user_a END,
    'team_update',
    'Someone suggested moving your conversation to ' || p_channel || '.',
    jsonb_build_object('thread_id', p_thread_id, 'channel', p_channel));

  RETURN v_id;
END
$$;

/** §3.3: "Either side can decline without explanation. Declining does not close the thread." */
CREATE OR REPLACE FUNCTION decline_handoff(p_proposal_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  h handoff_proposals;
  t threads;
BEGIN
  IF v_me IS NULL THEN RETURN false; END IF;
  SELECT * INTO h FROM handoff_proposals WHERE id = p_proposal_id;
  IF h.id IS NULL OR h.state <> 'proposed' THEN RETURN false; END IF;
  SELECT * INTO t FROM threads WHERE id = h.thread_id;
  IF t.id IS NULL OR (t.user_a <> v_me AND t.user_b <> v_me) THEN RETURN false; END IF;

  UPDATE handoff_proposals SET state = 'withdrawn', decided_at = now() WHERE id = h.id;
  RETURN true;
END
$$;

/**
 * Leaving a conversation. §3.4's closure list plus UX_FLOWS.md §11.3's overflow menu.
 *
 * threads has no UPDATE policy — deliberately, since a participant must not be able to
 * rewrite the reason or reopen something a block closed — so leaving goes through here.
 * The messages stay readable for 90 days (§3.4) and then the purge takes them; closing is
 * not deleting.
 */
CREATE OR REPLACE FUNCTION close_thread(p_thread_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  t threads;
BEGIN
  IF v_me IS NULL THEN RETURN false; END IF;
  SELECT * INTO t FROM threads WHERE id = p_thread_id;
  IF t.id IS NULL OR t.state <> 'open' OR (t.user_a <> v_me AND t.user_b <> v_me) THEN
    RETURN false;
  END IF;

  UPDATE threads SET state = 'closed', closed_at = now(), closed_reason = 'left'
   WHERE id = p_thread_id;

  -- An outstanding handoff proposal dies with the conversation rather than sitting
  -- acceptable in a thread nobody can write to.
  UPDATE handoff_proposals SET state = 'withdrawn', decided_at = now()
   WHERE thread_id = p_thread_id AND state = 'proposed';

  RETURN true;
END
$$;

/**
 * §5.1: "Owner sees it in the room AND GETS A NOTIFICATION."
 *
 * 0016 notified on accept and on decline but not on arrival, which left the one message the
 * flow actually depends on unsent: a request nobody hears about expires in 14 days and the
 * requester concludes the product is empty.
 *
 * No name and no message text in the payload. NOTIFICATIONS.md §1 writes every notification
 * in-app first, and a push preview carrying a stranger's words is a delivery channel for
 * exactly the thing §2.2 strips links to prevent.
 */
CREATE OR REPLACE FUNCTION requests_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_what text;
BEGIN
  SELECT coalesce(t.name, o.title, 'something you said you were going for')
    INTO v_what
    FROM (SELECT 1) anchor
    LEFT JOIN teams t ON t.id = NEW.team_id
    LEFT JOIN opportunities o ON o.id = coalesce(NEW.opportunity_id, t.opportunity_id);

  PERFORM enqueue_notification(
    NEW.target_user_id,
    'request_received',
    CASE WHEN NEW.context = 'team_request'
         THEN 'Someone asked to join ' || v_what || '.'
         ELSE 'Someone going for ' || v_what || ' asked to team up.' END,
    jsonb_build_object('request_id', NEW.id, 'context', NEW.context));

  RETURN NEW;
END
$$;

CREATE TRIGGER requests_notify
  AFTER INSERT ON collaboration_requests
  FOR EACH ROW EXECUTE FUNCTION requests_after_insert();

-- ── Grants ──────────────────────────────────────────────────────────────────
-- request_allowance_for() is NOT granted: it takes a user id, and the only caller that
-- may name a user other than themselves is the trigger, which runs as the table owner.
GRANT EXECUTE ON FUNCTION request_allowance() TO authenticated;
GRANT EXECUTE ON FUNCTION room_builders(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION room_teams(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION my_room_status(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION my_requests(text) TO authenticated;
GRANT EXECUTE ON FUNCTION my_threads() TO authenticated;
GRANT EXECUTE ON FUNCTION thread_view(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION propose_handoff(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION decline_handoff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION close_thread(uuid) TO authenticated;
