-- Rolls 0018 back.
--
-- accept_request is a RESTORATION, not a drop: 0016 created it and 0018 replaced it to add
-- the project branch. 0016's version is reproduced verbatim at the bottom, so a rollback
-- leaves team acceptance working rather than leaving no function at all.

DROP FUNCTION IF EXISTS project_interest_target(uuid);
DROP FUNCTION IF EXISTS project_inactivity_sweep();
DROP FUNCTION IF EXISTS projects_for_opportunity(uuid);
DROP FUNCTION IF EXISTS project_browse_state();
DROP FUNCTION IF EXISTS project_matches(uuid);
DROP FUNCTION IF EXISTS replace_project_matches(uuid, jsonb);
DROP FUNCTION IF EXISTS project_match_candidates(uuid, int);

ALTER TABLE collaboration_requests DROP CONSTRAINT IF EXISTS collaboration_requests_project_id_fkey;

-- Policies first, and explicitly.
--
-- projects_readable references project_members and project_members_read references
-- projects, so dropping either table while the other's policy stands fails with "cannot
-- drop table ... because other objects depend on it" — and a down migration that fails
-- halfway is worse than no down migration, because the ledger and the schema then disagree.
-- 0016's `blocks` taught this the same way.
DROP POLICY IF EXISTS project_submissions_write ON project_submissions;
DROP POLICY IF EXISTS project_submissions_read ON project_submissions;
DROP POLICY IF EXISTS project_matches_owner ON project_opportunity_matches;
DROP POLICY IF EXISTS project_members_leave ON project_members;
DROP POLICY IF EXISTS project_members_read ON project_members;
DROP POLICY IF EXISTS projects_readable ON projects;
DROP POLICY IF EXISTS projects_own ON projects;

DROP TRIGGER IF EXISTS projects_add_owner ON projects;
DROP TRIGGER IF EXISTS projects_validate ON projects;
DROP FUNCTION IF EXISTS projects_after_insert();
DROP FUNCTION IF EXISTS projects_before_write();
DROP FUNCTION IF EXISTS project_slug(text);

DROP TABLE IF EXISTS project_submissions;
DROP TABLE IF EXISTS project_opportunity_matches;
DROP TABLE IF EXISTS project_members;
DROP TABLE IF EXISTS projects;

DROP TYPE IF EXISTS project_visibility;
DROP TYPE IF EXISTS project_state;

-- 0016's version, verbatim.
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
