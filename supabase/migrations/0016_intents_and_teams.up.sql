-- 0016 intent, team rooms, teams, join requests, threads, handoff, blocking
--
-- TEAM_FORMATION.md and COLLABORATION_SYSTEM.md.
--
-- THE SHAPE OF THIS FILE IS THE PRODUCT DECISION. TEAM_FORMATION.md §1's three moves are
-- all constraints on what NOT to build:
--
--   Move 1 `[PR]`: anchor to the opportunity, never to a directory. There is no table
--     here that lists people. Intent exists only in the context of one opportunity, and
--     the RLS policies enforce that rather than the UI hiding it.
--   Move 2 `[PR]`: intent is the primitive, and it EXPIRES. `expires_at` is set
--     server-side from the opportunity's deadline by a trigger, so there is no write path
--     that can create a permanent one. "No stale profiles" is a schema property here.
--   Move 3 `[PR]`: do not fight the host platform. Threads are deliberately poor, and
--     handoff to Telegram or WhatsApp with two-sided consent is the designed exit.
--
-- What is DELIBERATELY ABSENT, per TEAM_FORMATION.md §3.2 `[PR]`: chat rooms, feeds,
-- activity streams, likes, follower counts, online indicators, profile-view counts. None
-- of them has a table, because a table is where a feature starts.
--
-- Every surface here is behind a density flag that ships DISABLED (PRODUCT_SPEC.md §24,
-- invariant 4). The flags are in 0003; the density CONDITIONS are functions at the bottom
-- of this file. A surface renders only when the flag is on AND the condition is met.

-- ── §2 Intent ───────────────────────────────────────────────────────────────

CREATE TYPE intent_stance AS ENUM (
  'going_solo', 'looking_for_team', 'have_team_looking_for_roles', 'just_interested');

CREATE TABLE intents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  stance         intent_stance NOT NULL,
  roles_offered  text[] NOT NULL DEFAULT '{}',
  note           text CHECK (note IS NULL OR char_length(note) <= 300),
  -- §2.2 `[PR]`: "expires_at is set server-side to the opportunity's deadline. Intent is
  -- never permanent." NOT NULL so no write path can omit it; set by trigger so no write
  -- path can choose it.
  expires_at     timestamptz NOT NULL,
  withdrawn_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- §2.2: "One intent per user per opportunity; changing stance updates it."
  UNIQUE (user_id, opportunity_id)
);

CREATE INDEX intents_opportunity_idx ON intents (opportunity_id)
  WHERE withdrawn_at IS NULL;
CREATE INDEX intents_user_idx ON intents (user_id);

COMMENT ON TABLE intents IS
  'TEAM_FORMATION.md §2. Visible ONLY inside the opportunity''s room — never on a profile, never in search, never in another room (§2.2 [PR]).';

/**
 * Set expiry from the opportunity, and refuse intent from an account that may not have it.
 *
 * §2.2's last rule: "Anyone with account_state != 'active' or without 18+ confirmation
 * cannot declare intent." That is the same gate as socialWritesAllowed in the app, and it
 * is repeated here because the app is one write path and this is all of them.
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

CREATE TRIGGER intents_set_expiry
  BEFORE INSERT OR UPDATE ON intents
  FOR EACH ROW EXECUTE FUNCTION intents_before_write();

-- ── §4 Teams ────────────────────────────────────────────────────────────────

CREATE TYPE team_state AS ENUM (
  'forming', 'open_for_roles', 'full', 'submitted', 'disbanded', 'archived');

CREATE TABLE teams (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  owner_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 80),
  pitch          text CHECK (pitch IS NULL OR char_length(pitch) <= 600),
  roles_needed   text[] NOT NULL DEFAULT '{}',
  max_size       smallint NOT NULL CHECK (max_size BETWEEN 2 AND 20),
  state          team_state NOT NULL DEFAULT 'forming',
  -- §4.2: "owner inactive for 14 days with pending requests → team marked stale in the
  -- room and requests expire, so nobody waits on a dead team."
  owner_last_seen_at timestamptz NOT NULL DEFAULT now(),
  project_id     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- §4.1: "max one per opportunity per user as owner".
  UNIQUE (opportunity_id, owner_user_id)
);

CREATE INDEX teams_opportunity_idx ON teams (opportunity_id)
  WHERE state IN ('forming','open_for_roles','full');

CREATE TABLE team_members (
  team_id   uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      text CHECK (role IS NULL OR char_length(role) <= 80),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX team_members_user_idx ON team_members (user_id);

/**
 * §4.1 `[PR]`: "max_size is validated against the opportunity's own team_size_max rule.
 * If the opportunity says teams of 2–5, a team of 6 cannot be created. The eligibility
 * data directly constrains the collaboration feature — the two systems are not
 * independent."
 *
 * A trigger rather than a CHECK because the constraint crosses tables. The point of
 * putting it here at all is that it then holds for the admin path, the API path and any
 * future import — the two systems being coupled is the product decision, and coupling
 * enforced in one form handler is not coupling.
 */
CREATE OR REPLACE FUNCTION teams_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  o record;
  v_state account_state;
  v_confirmed boolean;
  v_members int;
BEGIN
  SELECT team_size_min, team_size_max, team_required, status, deadline_at
    INTO o FROM opportunities WHERE id = NEW.opportunity_id;

  IF o.status IS DISTINCT FROM 'published' AND TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'a team may only be created on a published opportunity';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT account_state, age_confirmed_18 INTO v_state, v_confirmed
      FROM users WHERE id = NEW.owner_user_id;
    IF v_state IS DISTINCT FROM 'active' OR v_confirmed IS NOT TRUE THEN
      RAISE EXCEPTION 'only an active, 18+-confirmed account may create a team';
    END IF;

    -- §4.1: "Any user with active intent on the opportunity may create one team."
    IF NOT EXISTS (
      SELECT 1 FROM intents i
       WHERE i.user_id = NEW.owner_user_id
         AND i.opportunity_id = NEW.opportunity_id
         AND i.withdrawn_at IS NULL
         AND i.expires_at > now()
    ) THEN
      RAISE EXCEPTION 'declare intent on this opportunity before creating a team';
    END IF;
  END IF;

  IF o.team_size_max IS NOT NULL AND NEW.max_size > o.team_size_max THEN
    RAISE EXCEPTION
      'this opportunity allows teams of at most %, so a team of % cannot be created',
      o.team_size_max, NEW.max_size;
  END IF;
  IF o.team_size_min IS NOT NULL AND NEW.max_size < o.team_size_min THEN
    RAISE EXCEPTION
      'this opportunity requires teams of at least %, so a maximum of % cannot be met',
      o.team_size_min, NEW.max_size;
  END IF;

  -- §4.2's auto-transition: reaching max_size makes a team full. Applied on update so a
  -- team that loses a member reopens rather than staying closed.
  IF TG_OP = 'UPDATE' THEN
    SELECT count(*)::int INTO v_members FROM team_members WHERE team_id = NEW.id;
    IF NEW.state IN ('open_for_roles','forming') AND v_members >= NEW.max_size THEN
      NEW.state := 'full';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER teams_validate
  BEFORE INSERT OR UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION teams_before_write();

/**
 * The owner is a member, always. §4.3 gives the owner the same rights a member has plus
 * more, and a team whose owner is not in team_members would have a size of zero and a
 * membership nobody could leave.
 */
CREATE OR REPLACE FUNCTION teams_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  INSERT INTO team_members (team_id, user_id, role)
  VALUES (NEW.id, NEW.owner_user_id, 'owner')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;

CREATE TRIGGER teams_add_owner
  AFTER INSERT ON teams
  FOR EACH ROW EXECUTE FUNCTION teams_after_insert();

/** §4.2's auto-transition to full, applied when a member is added. */
CREATE OR REPLACE FUNCTION team_members_after_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_team uuid := coalesce(NEW.team_id, OLD.team_id);
  v_count int;
  v_max int;
  v_state team_state;
BEGIN
  SELECT count(*)::int INTO v_count FROM team_members WHERE team_id = v_team;
  SELECT max_size, state INTO v_max, v_state FROM teams WHERE id = v_team;

  IF v_state IN ('forming','open_for_roles') AND v_count >= v_max THEN
    UPDATE teams SET state = 'full', updated_at = now() WHERE id = v_team;
  ELSIF v_state = 'full' AND v_count < v_max THEN
    -- A team that loses a member reopens. Staying 'full' with a free seat would mean
    -- nobody could request it and the room would show a team that is not actually closed.
    UPDATE teams SET state = 'open_for_roles', updated_at = now() WHERE id = v_team;
  END IF;

  RETURN NULL;
END
$$;

CREATE TRIGGER team_members_size
  AFTER INSERT OR DELETE ON team_members
  FOR EACH ROW EXECUTE FUNCTION team_members_after_change();

-- ── §5 / COLLABORATION_SYSTEM.md §2 Join requests ───────────────────────────

CREATE TYPE request_context AS ENUM ('team_request', 'project_role', 'opportunity_intent');
CREATE TYPE request_state AS ENUM ('pending', 'accepted', 'declined', 'withdrawn', 'expired');

CREATE TABLE collaboration_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context         request_context NOT NULL,
  -- Exactly one of these is set, per context. A request with no context is impossible:
  -- COLLABORATION_SYSTEM.md §2.1 `[PR]` — "There is no context-free 'connect' action
  -- anywhere in the product."
  team_id         uuid REFERENCES teams(id) ON DELETE CASCADE,
  project_id      uuid,
  opportunity_id  uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  requester_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text CHECK (role IS NULL OR char_length(role) <= 80),
  -- §2.2 `[PR]`: a message <= 500 characters. "Nothing else. No attachments, no links in
  -- the first message." Links are stripped by the application before this is written; the
  -- length is enforced here.
  message         text CHECK (message IS NULL OR char_length(message) <= 500),
  -- For §2.4's copy-paste detection, which needs to compare messages without storing a
  -- searchable corpus of them.
  message_digest  text,
  state           request_state NOT NULL DEFAULT 'pending',
  -- §2.3: 14 days, or 72 hours before the related deadline, whichever is sooner. Set
  -- server-side by trigger.
  expires_at      timestamptz NOT NULL,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT request_has_a_context CHECK (
    (context = 'team_request' AND team_id IS NOT NULL) OR
    (context = 'project_role' AND project_id IS NOT NULL) OR
    (context = 'opportunity_intent' AND opportunity_id IS NOT NULL)
  ),
  CONSTRAINT request_not_to_self CHECK (requester_user_id <> target_user_id)
);

-- §2.4: "one per (target, context)" while pending.
CREATE UNIQUE INDEX requests_one_pending_per_target
  ON collaboration_requests (requester_user_id, target_user_id, context,
                             coalesce(team_id, project_id, opportunity_id))
  WHERE state = 'pending';

CREATE INDEX requests_target_idx ON collaboration_requests (target_user_id, state, created_at DESC);
CREATE INDEX requests_requester_idx ON collaboration_requests (requester_user_id, created_at DESC);
CREATE INDEX requests_expiry_idx ON collaboration_requests (expires_at) WHERE state = 'pending';

COMMENT ON TABLE collaboration_requests IS
  'COLLABORATION_SYSTEM.md §2. No contact detail is exchanged before acceptance — not email, not Telegram, not phone (TEAM_FORMATION.md §5.2 [PR]).';

/**
 * Rate limits, expiry and the anti-spam check, in one place.
 *
 * §5.2 `[PR]`: "Rate limits: 10 requests/day, 3/hour, max 5 pending at once."
 * §2.4 adds: "Identical message to >3 targets within an hour → soft warning, then a
 * 24-hour cooldown."
 *
 * Enforced in a trigger because §5.3 identifies bulk identical requests as "the dominant
 * spam vector on every platform of this shape", and a limit enforced in a form handler is
 * a limit the API route does not have.
 */
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

-- ── §4 Blocking ─────────────────────────────────────────────────────────────
--
-- Created before the requests trigger fires, but declared after the table it references,
-- so the table comes first and the trigger is attached at the end of this file.

CREATE TABLE blocks (
  blocker_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CONSTRAINT no_self_block CHECK (blocker_user_id <> blocked_user_id)
);

CREATE INDEX blocks_blocked_idx ON blocks (blocked_user_id);

COMMENT ON TABLE blocks IS
  'COLLABORATION_SYSTEM.md §4 [PR]: absolute and immediate. "Blocks are never revealed — the blocked user sees absence, never an explanation." Block lists are private and never inferable through counts or ordering.';

CREATE TRIGGER requests_validate
  BEFORE INSERT ON collaboration_requests
  FOR EACH ROW EXECUTE FUNCTION requests_before_insert();

/**
 * A block cancels everything in flight. §4: "All pending requests between them are
 * cancelled; threads close."
 *
 * Immediately, in the same transaction as the block. A block that takes effect on the
 * next cron run is not absolute.
 */
CREATE OR REPLACE FUNCTION blocks_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE collaboration_requests
     SET state = 'withdrawn', decided_at = now()
   WHERE state = 'pending'
     AND ((requester_user_id = NEW.blocker_user_id AND target_user_id = NEW.blocked_user_id)
       OR (requester_user_id = NEW.blocked_user_id AND target_user_id = NEW.blocker_user_id));

  UPDATE threads
     SET state = 'closed', closed_at = now(), closed_reason = 'blocked'
   WHERE state = 'open'
     AND ((user_a = NEW.blocker_user_id AND user_b = NEW.blocked_user_id)
       OR (user_a = NEW.blocked_user_id AND user_b = NEW.blocker_user_id));

  RETURN NEW;
END
$$;

-- ── COLLABORATION_SYSTEM.md §3 Threads ──────────────────────────────────────

CREATE TABLE threads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- §3.1 `[PR]`: "A thread opens ONLY on acceptance. There is no way to message anyone
  -- who has not accepted a request from you." The request is therefore required, not
  -- optional, and it is unique — one thread per accepted request.
  request_id    uuid NOT NULL UNIQUE REFERENCES collaboration_requests(id) ON DELETE CASCADE,
  -- Ordered pair, so a thread between two people is one row however it is looked up.
  user_a        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state         text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  closed_at     timestamptz,
  closed_reason text,
  last_message_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT thread_pair_ordered CHECK (user_a < user_b)
);

CREATE INDEX threads_participant_idx ON threads (user_a, state);
CREATE INDEX threads_participant_b_idx ON threads (user_b, state);

CREATE TABLE thread_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- §3.2: "Text only, <= 2000 characters per message. No attachments, no images, no
  -- voice." Every omission costs bytes or moderation surface, usually both.
  body       text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX thread_messages_thread_idx ON thread_messages (thread_id, created_at);

COMMENT ON TABLE thread_messages IS
  'COLLABORATION_SYSTEM.md §3.4: closed threads are read-only for 90 days, then the messages are deleted and only the fact of the connection remains.';

/**
 * §3.3 `[PR]` handoff — the intended exit.
 *
 * "A proposes a channel → B accepts → ONLY THEN are identifiers exchanged, and only the
 * one channel chosen."
 *
 * The identifier is stored on the proposal and released by a function that checks consent,
 * rather than being copied into the thread when proposed. That is the difference between a
 * consent gate and a consent notice: with the identifier already in the thread row, any
 * read path bug exposes it.
 */
CREATE TABLE handoff_proposals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  proposer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('telegram','whatsapp','email')),
  -- The proposer's own identifier on that channel, held until the other side accepts.
  proposer_identifier text NOT NULL CHECK (char_length(proposer_identifier) <= 200),
  -- The accepter's, supplied at acceptance. Both sides give one, or neither is released.
  accepter_identifier text CHECK (accepter_identifier IS NULL OR char_length(accepter_identifier) <= 200),
  state       text NOT NULL DEFAULT 'proposed'
                CHECK (state IN ('proposed','accepted','declined','withdrawn')),
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX handoff_thread_idx ON handoff_proposals (thread_id, state);

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE intents                ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members           ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocks                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads                ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_messages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoff_proposals       ENABLE ROW LEVEL SECURITY;

-- Intent: your own always; other people's only inside a room you are also in.
--
-- §2.2 `[PR]`: "Intent is visible only inside that opportunity's room — never on a
-- profile, never in search, never in another room." The second clause is what this policy
-- is for: co-presence in the same room is the ONLY thing that makes another person's
-- intent visible, and a block removes it (§4).
CREATE POLICY intents_own ON intents FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY intents_same_room ON intents FOR SELECT
  USING (
    withdrawn_at IS NULL
    AND expires_at > now()
    AND EXISTS (
      SELECT 1 FROM intents mine
       WHERE mine.opportunity_id = intents.opportunity_id
         AND mine.user_id = auth.uid()
         AND mine.withdrawn_at IS NULL
         AND mine.expires_at > now()
    )
    AND NOT EXISTS (
      SELECT 1 FROM blocks b
       WHERE (b.blocker_user_id = auth.uid() AND b.blocked_user_id = intents.user_id)
          OR (b.blocker_user_id = intents.user_id AND b.blocked_user_id = auth.uid())
    )
  );

-- Teams: readable by anyone who has intent on the same opportunity, writable by the owner.
CREATE POLICY teams_owner_write ON teams FOR ALL
  USING (owner_user_id = auth.uid()) WITH CHECK (owner_user_id = auth.uid());

CREATE POLICY teams_room_read ON teams FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM intents mine
       WHERE mine.opportunity_id = teams.opportunity_id
         AND mine.user_id = auth.uid()
         AND mine.withdrawn_at IS NULL
         AND mine.expires_at > now()
    )
    AND NOT EXISTS (
      SELECT 1 FROM blocks b
       WHERE (b.blocker_user_id = auth.uid() AND b.blocked_user_id = teams.owner_user_id)
          OR (b.blocker_user_id = teams.owner_user_id AND b.blocked_user_id = auth.uid())
    )
  );

CREATE POLICY team_members_own ON team_members FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY team_members_same_team ON team_members FOR SELECT
  USING (EXISTS (SELECT 1 FROM team_members mine
                  WHERE mine.team_id = team_members.team_id AND mine.user_id = auth.uid()));

CREATE POLICY team_members_leave ON team_members FOR DELETE
  USING (
    -- §4.3: "Members may leave freely." And the owner may remove a member.
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM teams t WHERE t.id = team_members.team_id AND t.owner_user_id = auth.uid())
  );

-- Requests: visible to the two people in them and nobody else.
CREATE POLICY requests_participant ON collaboration_requests FOR SELECT
  USING (requester_user_id = auth.uid() OR target_user_id = auth.uid());

CREATE POLICY requests_send ON collaboration_requests FOR INSERT
  WITH CHECK (requester_user_id = auth.uid());

CREATE POLICY requests_decide ON collaboration_requests FOR UPDATE
  USING (requester_user_id = auth.uid() OR target_user_id = auth.uid());

-- Blocks: entirely private. §4: "Block lists are private and never inferable through
-- counts or ordering", which is why the blocked user has NO read policy here — not a
-- filtered one, none.
CREATE POLICY blocks_own ON blocks FOR ALL
  USING (blocker_user_id = auth.uid()) WITH CHECK (blocker_user_id = auth.uid());

CREATE POLICY threads_participant ON threads FOR SELECT
  USING (user_a = auth.uid() OR user_b = auth.uid());

CREATE POLICY messages_participant ON thread_messages FOR SELECT
  USING (EXISTS (SELECT 1 FROM threads t
                  WHERE t.id = thread_messages.thread_id
                    AND (t.user_a = auth.uid() OR t.user_b = auth.uid())));

CREATE POLICY messages_send ON thread_messages FOR INSERT
  WITH CHECK (
    sender_user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM threads t
                 WHERE t.id = thread_messages.thread_id
                   AND t.state = 'open'
                   AND (t.user_a = auth.uid() OR t.user_b = auth.uid()))
  );

-- Handoff proposals: the identifiers are the sensitive part, so there is NO direct read
-- policy at all. Reading one goes through handoff_identifiers(), which checks consent.
CREATE POLICY handoff_propose ON handoff_proposals FOR INSERT
  WITH CHECK (
    proposer_user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM threads t
                 WHERE t.id = handoff_proposals.thread_id
                   AND t.state = 'open'
                   AND (t.user_a = auth.uid() OR t.user_b = auth.uid()))
  );

CREATE TRIGGER blocks_cancel_everything
  AFTER INSERT ON blocks
  FOR EACH ROW EXECUTE FUNCTION blocks_after_insert();

-- ── Density floors (PRODUCT_SPEC.md §24, invariant 4) ───────────────────────
--
-- "A surface becomes visible only when its flag is enabled AND its computed condition is
-- met — both, never either."
--
-- These functions are the CONDITION half. The flag half is feature_flags, seeded disabled.
-- Both halves are checked here rather than in the page, so a new page cannot render a
-- social surface by forgetting to ask.

/**
 * §2.3 `[PR]`: "Intent count is shown publicly on the opportunity page ONLY at >=5. Below
 * that, no number is shown at all — not '0', not '2'. Showing a low number is worse than
 * showing nothing."
 *
 * Returns NULL below the floor, not 0. A caller that gets NULL cannot accidentally render
 * it as a number, and a caller that gets 0 will.
 */
CREATE OR REPLACE FUNCTION intent_count_public(p_opportunity_id uuid)
RETURNS int
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  v_count int;
BEGIN
  SELECT enabled INTO v_enabled FROM feature_flags WHERE key = 'intent_count_visible';
  IF v_enabled IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::int INTO v_count
    FROM intents i
   WHERE i.opportunity_id = p_opportunity_id
     AND i.withdrawn_at IS NULL
     AND i.expires_at > now();

  -- The floor. Below it, nothing at all.
  IF v_count < 5 THEN
    RETURN NULL;
  END IF;
  RETURN v_count;
END
$$;

/**
 * Whether a team room renders, and if not, what to show instead.
 *
 * TEAM_FORMATION.md §3.1's table, and IMPLEMENTATION_PLAN.md §7's acceptance criterion
 * `[PR]`: "A room below its floor is NEVER RENDERED — the route returns the opportunity
 * page with a single CTA."
 *
 * Returns a state rather than a boolean so the caller can tell "not enough people yet"
 * from "closed" from "switched off" — three situations that need three different pages and
 * would otherwise all render as the same absence.
 */
CREATE OR REPLACE FUNCTION room_state(p_opportunity_id uuid)
RETURNS TABLE (state text, intent_count int, team_count int, reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  v_status opp_status;
  v_intents int;
  v_teams int;
BEGIN
  SELECT enabled INTO v_enabled FROM feature_flags WHERE key = 'team_room_entry';
  SELECT o.status INTO v_status FROM opportunities o WHERE o.id = p_opportunity_id;

  IF v_status IS NULL THEN
    RETURN QUERY SELECT 'absent', 0, 0, 'no such opportunity';
    RETURN;
  END IF;

  SELECT count(*)::int INTO v_intents
    FROM intents i
   WHERE i.opportunity_id = p_opportunity_id
     AND i.withdrawn_at IS NULL
     AND i.expires_at > now();

  SELECT count(*)::int INTO v_teams
    FROM teams t
   WHERE t.opportunity_id = p_opportunity_id
     AND t.state IN ('forming','open_for_roles','full');

  IF v_enabled IS NOT TRUE THEN
    -- The flag is the operator's kill switch (SECURITY.md §11). Off means the route does
    -- not exist, which is different from below the floor: the counts are still returned so
    -- the admin density panel can show how close it is.
    RETURN QUERY SELECT 'disabled', v_intents, v_teams,
      'team rooms are switched off for now';
    RETURN;
  END IF;

  -- §3.3: "When the opportunity closes, the room becomes read-only... Nothing is deleted."
  IF v_status IN ('expired','closed','cancelled','rejected','merged') THEN
    RETURN QUERY SELECT 'archived', v_intents, v_teams,
      'this opportunity has closed, so the room is read-only';
    RETURN;
  END IF;

  -- §3.1's floor: >= 3 intents OR >= 1 team.
  IF v_intents < 3 AND v_teams = 0 THEN
    RETURN QUERY SELECT 'below_floor', v_intents, v_teams,
      'Be the first to say you''re going for this';
    RETURN;
  END IF;

  RETURN QUERY SELECT 'open', v_intents, v_teams, 'room is open';
END
$$;

/**
 * §5.1 accept: add the member, open the thread, tell both sides.
 *
 * One function because the three steps must not come apart. An accepted request with no
 * thread is a dead end; a thread with no membership is a conversation about nothing; and
 * §5.1 says both parties are notified, which is how the requester learns at all.
 */
CREATE OR REPLACE FUNCTION accept_request(p_request_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r collaboration_requests;
  v_thread uuid;
  v_a uuid;
  v_b uuid;
  v_team teams;
BEGIN
  SELECT * INTO r FROM collaboration_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RETURN NULL; END IF;

  -- Only the target decides. The requester can withdraw, which is a different function.
  IF r.target_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'only the person who received a request can accept it';
  END IF;
  IF r.state <> 'pending' THEN
    RAISE EXCEPTION 'this request is already %', r.state;
  END IF;
  IF r.expires_at <= now() THEN
    UPDATE collaboration_requests SET state = 'expired', decided_at = now() WHERE id = r.id;
    RAISE EXCEPTION 'this request has expired';
  END IF;

  UPDATE collaboration_requests
     SET state = 'accepted', decided_at = now()
   WHERE id = r.id;

  IF r.context = 'team_request' THEN
    SELECT * INTO v_team FROM teams WHERE id = r.team_id;
    IF v_team.id IS NULL THEN
      RAISE EXCEPTION 'that team no longer exists';
    END IF;
    IF (SELECT count(*) FROM team_members WHERE team_id = v_team.id) >= v_team.max_size THEN
      RAISE EXCEPTION 'that team is full';
    END IF;
    INSERT INTO team_members (team_id, user_id, role)
    VALUES (v_team.id, r.requester_user_id, r.role)
    ON CONFLICT DO NOTHING;
  END IF;

  -- §3.1 `[PR]`: the thread opens on acceptance, and only then.
  v_a := least(r.requester_user_id, r.target_user_id);
  v_b := greatest(r.requester_user_id, r.target_user_id);

  INSERT INTO threads (request_id, user_a, user_b)
  VALUES (r.id, v_a, v_b)
  ON CONFLICT (request_id) DO NOTHING
  RETURNING id INTO v_thread;

  IF v_thread IS NULL THEN
    SELECT id INTO v_thread FROM threads WHERE request_id = r.id;
  END IF;

  PERFORM enqueue_notification(
    r.requester_user_id, 'request_accepted',
    'Someone you asked to join accepted.',
    jsonb_build_object('request_id', r.id, 'thread_id', v_thread, 'context', r.context));

  RETURN v_thread;
END
$$;

/**
 * §5.1 decline. "requester notified, no reason required, no re-request for 7 days".
 *
 * No reason is TAKEN, not merely not required: a decline reason field would become a place
 * to be unkind, and §2.5 says declines are private and never surfaced.
 */
CREATE OR REPLACE FUNCTION decline_request(p_request_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r collaboration_requests;
BEGIN
  SELECT * INTO r FROM collaboration_requests WHERE id = p_request_id;
  IF r.id IS NULL OR r.target_user_id IS DISTINCT FROM auth.uid() OR r.state <> 'pending' THEN
    RETURN false;
  END IF;

  UPDATE collaboration_requests SET state = 'declined', decided_at = now() WHERE id = r.id;

  PERFORM enqueue_notification(
    r.requester_user_id, 'request_declined',
    'You asked to join something and the answer was no.',
    jsonb_build_object('request_id', r.id, 'context', r.context));

  RETURN true;
END
$$;

/**
 * §3.3 `[PR]` handoff, the consent gate.
 *
 * Identifiers are released ONLY when the proposal is accepted, and only the one channel
 * chosen. Reading a proposal directly is impossible — there is no SELECT policy on
 * handoff_proposals — so this function is the only way any identifier comes out, and it
 * checks the state before it does.
 */
CREATE OR REPLACE FUNCTION accept_handoff(p_proposal_id uuid, p_my_identifier text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p handoff_proposals;
  t threads;
BEGIN
  SELECT * INTO p FROM handoff_proposals WHERE id = p_proposal_id;
  IF p.id IS NULL OR p.state <> 'proposed' THEN RETURN false; END IF;

  SELECT * INTO t FROM threads WHERE id = p.thread_id;
  IF t.id IS NULL OR t.state <> 'open' THEN RETURN false; END IF;

  -- The accepter must be the OTHER participant. Accepting your own proposal would release
  -- nothing and confuse everything.
  IF auth.uid() IS NULL
     OR auth.uid() = p.proposer_user_id
     OR (auth.uid() <> t.user_a AND auth.uid() <> t.user_b) THEN
    RETURN false;
  END IF;

  IF btrim(coalesce(p_my_identifier, '')) = '' THEN
    RAISE EXCEPTION 'give your own contact on that channel — the exchange goes both ways';
  END IF;

  UPDATE handoff_proposals
     SET state = 'accepted',
         accepter_identifier = left(btrim(p_my_identifier), 200),
         decided_at = now()
   WHERE id = p.id;

  RETURN true;
END
$$;

/**
 * The identifiers, released only after acceptance.
 *
 * The reason this is a function and not a policy: a SELECT policy scoped to "accepted"
 * would still put both identifiers in a row the participants can read, and the whole
 * design of §3.3 is that nothing is exchanged until consent. Here the check and the
 * release are the same statement.
 */
CREATE OR REPLACE FUNCTION handoff_identifiers(p_thread_id uuid)
RETURNS TABLE (channel text, their_identifier text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE t threads;
BEGIN
  SELECT * INTO t FROM threads WHERE id = p_thread_id;
  IF t.id IS NULL THEN RETURN; END IF;
  IF auth.uid() IS NULL OR (auth.uid() <> t.user_a AND auth.uid() <> t.user_b) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT h.channel,
         CASE WHEN auth.uid() = h.proposer_user_id THEN h.accepter_identifier
              ELSE h.proposer_identifier END
    FROM handoff_proposals h
   WHERE h.thread_id = p_thread_id
     AND h.state = 'accepted';
END
$$;

/**
 * Expiry and staleness, for the batch tier. TEAM_FORMATION.md §4.2 and §5.1.
 *
 * "owner inactive for 14 days with pending requests → team marked stale in the room and
 * requests expire, so nobody waits on a dead team." `[PR]`
 *
 * Waiting on a dead team is the specific harm here: a requester with 5 pending slots and
 * one abandoned team has lost a fifth of their capacity to ask anyone else.
 */
CREATE OR REPLACE FUNCTION expire_collaboration()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requests int;
  v_intents int;
  v_teams int;
  v_threads int;
  v_purged int;
BEGIN
  WITH gone AS (
    UPDATE collaboration_requests SET state = 'expired', decided_at = now()
     WHERE state = 'pending' AND expires_at <= now()
    RETURNING 1)
  SELECT count(*)::int INTO v_requests FROM gone;

  -- An abandoned team's pending requests expire with it.
  WITH stale AS (
    UPDATE collaboration_requests r SET state = 'expired', decided_at = now()
      FROM teams t
     WHERE r.team_id = t.id
       AND r.state = 'pending'
       AND t.owner_last_seen_at < now() - interval '14 days'
    RETURNING 1)
  SELECT count(*)::int INTO v_teams FROM stale;

  -- §3.3: a closed opportunity archives its room. Nothing is deleted.
  UPDATE teams t SET state = 'archived', updated_at = now()
    FROM opportunities o
   WHERE t.opportunity_id = o.id
     AND t.state IN ('forming','open_for_roles','full')
     AND o.status IN ('expired','closed','cancelled','rejected');

  WITH gone AS (
    UPDATE intents SET withdrawn_at = now()
     WHERE withdrawn_at IS NULL AND expires_at <= now()
    RETURNING 1)
  SELECT count(*)::int INTO v_intents FROM gone;

  -- §3.4: threads close 60 days after the last message.
  WITH gone AS (
    UPDATE threads SET state = 'closed', closed_at = now(), closed_reason = 'inactive'
     WHERE state = 'open'
       AND coalesce(last_message_at, created_at) < now() - interval '60 days'
    RETURNING 1)
  SELECT count(*)::int INTO v_threads FROM gone;

  -- §3.4: "Closed threads are read-only for 90 days, then messages are deleted and only
  -- the fact of the connection remains." The thread row survives; the words do not.
  WITH gone AS (
    DELETE FROM thread_messages m
     USING threads t
     WHERE m.thread_id = t.id
       AND t.state = 'closed'
       AND t.closed_at < now() - interval '90 days'
    RETURNING 1)
  SELECT count(*)::int INTO v_purged FROM gone;

  RETURN jsonb_build_object(
    'requests_expired', v_requests,
    'requests_expired_on_stale_teams', v_teams,
    'intents_expired', v_intents,
    'threads_closed', v_threads,
    'messages_purged', v_purged);
END
$$;

/** Keep a thread's activity stamp current, for §3.4's closure rule. */
CREATE OR REPLACE FUNCTION thread_messages_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE threads SET last_message_at = NEW.created_at WHERE id = NEW.thread_id;
  RETURN NULL;
END
$$;

CREATE TRIGGER thread_messages_touch
  AFTER INSERT ON thread_messages
  FOR EACH ROW EXECUTE FUNCTION thread_messages_after_insert();

-- ── Grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION intent_count_public(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION room_state(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION accept_request(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION decline_request(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION accept_handoff(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION handoff_identifiers(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION expire_collaboration() FROM PUBLIC;

-- The count and the room state are public reads: both return the same thing to everyone,
-- and both refuse to reveal anything below their floor.
GRANT EXECUTE ON FUNCTION intent_count_public(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION room_state(uuid) TO anon, authenticated;

GRANT EXECUTE ON FUNCTION accept_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION decline_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION accept_handoff(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION handoff_identifiers(uuid) TO authenticated;

-- expire_collaboration is batch tier only.
