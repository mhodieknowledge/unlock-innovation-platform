-- Rolls 0017 back to 0016's behaviour.
--
-- Two things here are RESTORATIONS rather than drops, because 0017 replaced objects that
-- 0016 created: requests_before_insert() (whose limits 0017 moved into
-- request_allowance_for) and the requests_decide policy (which 0017 narrowed to
-- requests_withdraw). A down migration that only dropped what 0017 added would leave the
-- requests table with no limits and no write policy at all — which is why 0016's originals
-- are reproduced below verbatim.

DROP FUNCTION IF EXISTS close_thread(uuid);
DROP TRIGGER IF EXISTS requests_notify ON collaboration_requests;
DROP FUNCTION IF EXISTS requests_after_insert();
DROP FUNCTION IF EXISTS decline_handoff(uuid);
DROP FUNCTION IF EXISTS propose_handoff(uuid, text, text);
DROP FUNCTION IF EXISTS thread_view(uuid);
DROP FUNCTION IF EXISTS my_threads();
DROP FUNCTION IF EXISTS my_requests(text);
DROP FUNCTION IF EXISTS my_room_status(uuid);
DROP FUNCTION IF EXISTS room_teams(uuid);
DROP FUNCTION IF EXISTS room_builders(uuid);
DROP FUNCTION IF EXISTS request_allowance();

DROP POLICY IF EXISTS requests_withdraw ON collaboration_requests;

CREATE POLICY requests_decide ON collaboration_requests FOR UPDATE
  USING (requester_user_id = auth.uid() OR target_user_id = auth.uid());

-- 0016's version, verbatim. The trigger still points at this name, so replacing the body
-- is the whole rollback — the trigger itself is 0016's and stays.
CREATE OR REPLACE FUNCTION requests_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
DECLARE
  v_day int;
  v_hour int;
  v_pending int;
  v_same_message int;
  v_deadline timestamptz;
  v_state account_state;
  v_confirmed boolean;
  v_declined_at timestamptz;
BEGIN
  SELECT account_state, age_confirmed_18 INTO v_state, v_confirmed
    FROM users WHERE id = NEW.requester_user_id;
  IF v_state IS DISTINCT FROM 'active' OR v_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'only an active, 18+-confirmed account may send a request';
  END IF;

  -- §4 of COLLABORATION_SYSTEM.md: "Blocking is absolute and immediate." A blocked user
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

  SELECT count(*)::int INTO v_day
    FROM collaboration_requests
   WHERE requester_user_id = NEW.requester_user_id AND created_at > now() - interval '24 hours';
  IF v_day >= 10 THEN
    RAISE EXCEPTION 'you have sent 10 requests today, which is the daily limit';
  END IF;

  SELECT count(*)::int INTO v_hour
    FROM collaboration_requests
   WHERE requester_user_id = NEW.requester_user_id AND created_at > now() - interval '1 hour';
  IF v_hour >= 3 THEN
    RAISE EXCEPTION 'you have sent 3 requests in the last hour, which is the hourly limit';
  END IF;

  SELECT count(*)::int INTO v_pending
    FROM collaboration_requests
   WHERE requester_user_id = NEW.requester_user_id AND state = 'pending';
  IF v_pending >= 5 THEN
    RAISE EXCEPTION 'you have 5 requests waiting for an answer, which is the limit';
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

-- Dropped last: the restored trigger function above no longer calls it.
DROP FUNCTION IF EXISTS request_allowance_for(uuid);
