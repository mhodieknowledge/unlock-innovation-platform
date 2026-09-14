-- Projects. COLLABORATION_SYSTEM.md §1, DATA_MODEL.md §8.
--
-- §1.1 is the whole reason this table exists, and it is worth quoting before the DDL:
-- "A project at `private` visibility still receives opportunity matches. THAT IS THE POINT
-- — the feature is valuable to a user with nobody else on the platform." `[PR]`
--
-- So nothing here is gated on an audience. The matching functions take no notice of
-- visibility, the density floor applies only to BROWSING other people's projects, and a
-- project that nobody but its owner will ever see gets the same matches as a public one.
-- That is what makes projects work on day one, with forty users and no community.
--
-- The scoring split follows Phase 4's division: Postgres returns SIGNALS
-- (project_match_candidates), TypeScript applies §1.5's weights from the one file that
-- holds them (packages/config/src/ranking.mjs). Two callers need it — the synchronous
-- first pass in the request tier and the nightly batch — and they must produce identical
-- scores, which they do by sharing both halves.

CREATE TYPE project_state AS ENUM (
  'idea', 'looking_for_collaborators', 'team_forming', 'building', 'testing',
  'launched', 'completed', 'paused', 'archived');

CREATE TYPE project_visibility AS ENUM ('private', 'unlisted', 'public');

CREATE TABLE projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Always carries a random suffix. §1.4 makes `unlisted` mean "anyone with the link", so
  -- the link has to be unguessable: a slug derived from the title alone would make every
  -- unlisted project enumerable by anyone who can imagine a project name.
  slug           text UNIQUE NOT NULL,
  owner_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 2 AND 120),
  pitch          text CHECK (pitch IS NULL OR char_length(pitch) <= 200),
  problem        text CHECK (problem IS NULL OR char_length(problem) <= 2000),
  solution       text CHECK (solution IS NULL OR char_length(solution) <= 2000),
  target_users   text CHECK (target_users IS NULL OR char_length(target_users) <= 500),
  state          project_state NOT NULL DEFAULT 'idea',
  visibility     project_visibility NOT NULL DEFAULT 'private',
  -- §1.4 `[PR]`: indexable is a SEPARATE opt-in on top of public. Two decisions, because
  -- "other people can see this" and "search engines should index this under my name" are
  -- not the same decision.
  indexable      boolean NOT NULL DEFAULT false,
  category_ids   uuid[] NOT NULL DEFAULT '{}',
  industry_ids   uuid[] NOT NULL DEFAULT '{}',
  skill_ids      uuid[] NOT NULL DEFAULT '{}',
  technology_ids uuid[] NOT NULL DEFAULT '{}',
  roles_needed   uuid[] NOT NULL DEFAULT '{}',
  repo_url       text CHECK (repo_url IS NULL OR char_length(repo_url) <= 500),
  demo_url       text CHECK (demo_url IS NULL OR char_length(demo_url) <= 500),
  docs_url       text CHECK (docs_url IS NULL OR char_length(docs_url) <= 500),
  country_iso2   char(2) REFERENCES countries(iso2),
  -- halfvec, not vector: the same decision as opportunities and profiles. pgvector 0.8's
  -- halfvec halves the index size, and DATA_MODEL.md's `vector(384)` predates that choice.
  embedding      halfvec(384),
  search_vector  tsvector,
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  matched_at     timestamptz,
  inactivity_prompted_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

CREATE INDEX projects_owner_idx ON projects (owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX projects_public_idx ON projects (created_at DESC)
  WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE INDEX projects_search_idx ON projects USING gin (search_vector);
CREATE INDEX projects_embedding_idx ON projects
  USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
-- For the inactivity sweep (§1.3), which reads only the live ones.
CREATE INDEX projects_activity_idx ON projects (last_activity_at)
  WHERE deleted_at IS NULL AND state NOT IN ('paused', 'archived', 'completed');

COMMENT ON TABLE projects IS
  'COLLABORATION_SYSTEM.md §1. A private project still receives opportunity matches (§1.1 [PR]) — that is the point of the feature, so no matching path consults visibility.';

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    uuid REFERENCES tags(id),
  is_owner   boolean NOT NULL DEFAULT false,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX project_members_user_idx ON project_members (user_id);

CREATE TABLE project_opportunity_matches (
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  score          numeric(5,4) NOT NULL,
  rank           int NOT NULL,
  eligibility_verdict text NOT NULL,
  -- §1.5: "templated strings + matched tag ids". Templated, never generated —
  -- PRODUCT_SPEC.md §14.3 `[PR]`. A reason a model wrote is a reason nobody can check.
  reasons        jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, opportunity_id)
);

CREATE INDEX project_matches_rank_idx ON project_opportunity_matches (project_id, rank);

CREATE TABLE project_submissions (
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  team_id        uuid REFERENCES teams(id) ON DELETE SET NULL,
  outcome        text NOT NULL DEFAULT 'submitted'
                   CHECK (outcome IN ('submitted','finalist','winner','not_selected','withdrawn')),
  note           text CHECK (note IS NULL OR char_length(note) <= 500),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, opportunity_id)
);

-- 0016 declared collaboration_requests.project_id with no foreign key, because projects
-- did not exist yet and a reference to a missing table would have failed the migration.
-- It exists now, so the constraint goes in: a `project_role` request pointing at nothing
-- is a request nobody can accept.
ALTER TABLE collaboration_requests
  ADD CONSTRAINT collaboration_requests_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- ── Slug ────────────────────────────────────────────────────────────────────

/**
 * A readable slug with an unguessable tail.
 *
 * The tail is what makes `unlisted` mean anything (§1.4): "anyone with the link" is only a
 * privacy level if the link cannot be guessed from the title. Six hex characters from
 * gen_random_bytes, so it is not derived from the id or the clock.
 */
CREATE OR REPLACE FUNCTION project_slug(p_title text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public, extensions
AS $$
DECLARE v_base text;
BEGIN
  v_base := lower(btrim(coalesce(p_title, '')));
  v_base := regexp_replace(v_base, '[^a-z0-9]+', '-', 'g');
  v_base := btrim(v_base, '-');
  IF v_base = '' THEN v_base := 'project'; END IF;
  RETURN left(v_base, 60) || '-' || encode(gen_random_bytes(3), 'hex');
END
$$;

-- ── Write-side rules ────────────────────────────────────────────────────────

/**
 * §1.2 and §1.4's rules, plus the one privacy rule that cannot live in a CHECK.
 *
 * `indexable` requires `public`: a private project marked indexable would be a
 * contradiction the SEO layer would eventually resolve in the wrong direction.
 *
 * Making a project non-private is a social act, so it needs the same 18+ confirmation
 * every other social write needs (PRODUCT_SPEC.md §22.1). CREATING a private project does
 * not: §1.1's whole point is that a project is useful to one person alone, and a read-only
 * account is still allowed its own tools.
 */
CREATE OR REPLACE FUNCTION projects_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_state account_state;
  v_confirmed boolean;
  v_bad int;
  v_is_retreat boolean := false;
BEGIN
  -- HIDING OR DELETING A PROJECT IS ALWAYS ALLOWED, whatever state the account is in.
  --
  -- The first version of this trigger refused every write from a suspended or deleted
  -- account, which broke the deletion path in migration 0019: closing your account sets
  -- your projects to private, and the trigger raised, so the deletion failed outright. The
  -- general rule is the same one intent follows — an account restriction limits what
  -- someone can put in FRONT of other people, never their ability to withdraw it.
  --
  -- Recognised narrowly: visibility moving toward private (or the row being soft-deleted)
  -- with no content change. Anything else is an edit and is checked below.
  IF TG_OP = 'UPDATE' THEN
    v_is_retreat :=
      (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
       OR (NEW.visibility = 'private' AND OLD.visibility <> 'private'))
      AND NEW.indexable IS NOT TRUE
      AND NEW.title = OLD.title
      AND NEW.pitch IS NOT DISTINCT FROM OLD.pitch
      AND NEW.problem IS NOT DISTINCT FROM OLD.problem
      AND NEW.solution IS NOT DISTINCT FROM OLD.solution
      AND NEW.target_users IS NOT DISTINCT FROM OLD.target_users
      AND NEW.roles_needed = OLD.roles_needed;
  END IF;

  IF v_is_retreat THEN
    NEW.slug := OLD.slug;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  SELECT account_state, age_confirmed_18 INTO v_state, v_confirmed
    FROM users WHERE id = NEW.owner_user_id;

  IF v_state IN ('suspended', 'deleted') THEN
    RAISE EXCEPTION 'this account cannot create or edit projects';
  END IF;

  IF NEW.visibility <> 'private' AND v_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION
      'showing a project to other people needs 18+ confirmation; a private project does not';
  END IF;

  IF NEW.visibility <> 'private' AND v_state <> 'active' THEN
    RAISE EXCEPTION 'this account is read-only, so a project can only be private for now';
  END IF;

  IF NEW.indexable AND NEW.visibility <> 'public' THEN
    RAISE EXCEPTION 'only a public project can be indexable (§1.4)';
  END IF;

  -- roles_needed holds tag ids, and they must be ROLE tags. A skill id in this column
  -- would render as "we need a Python" on the project page.
  SELECT count(*)::int INTO v_bad
    FROM unnest(NEW.roles_needed) AS r(id)
   WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.id = r.id AND t.kind = 'role');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'roles_needed must reference role tags (% unknown)', v_bad;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.slug IS NULL OR btrim(NEW.slug) = '' THEN
      NEW.slug := project_slug(NEW.title);
    END IF;
  ELSE
    -- The slug never changes. A project's URL is a link someone may have kept, and §1.4's
    -- unlisted level is built on that link.
    NEW.slug := OLD.slug;

    IF NEW.state IS DISTINCT FROM OLD.state THEN
      NEW.state_changed_at := now();
    END IF;
  END IF;

  NEW.updated_at := now();

  -- §1.3's inactivity clock. Editing the project is activity; the matcher writing matches
  -- into it is not, which is why matched_at is a separate column.
  IF TG_OP = 'INSERT'
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.pitch IS DISTINCT FROM OLD.pitch
     OR NEW.problem IS DISTINCT FROM OLD.problem
     OR NEW.solution IS DISTINCT FROM OLD.solution
     OR NEW.state IS DISTINCT FROM OLD.state
     OR NEW.roles_needed IS DISTINCT FROM OLD.roles_needed THEN
    NEW.last_activity_at := now();
    NEW.inactivity_prompted_at := NULL;
  END IF;

  NEW.search_vector :=
      setweight(to_tsvector('mbele_search', coalesce(NEW.title, '')), 'A')
   || setweight(to_tsvector('mbele_search', coalesce(NEW.pitch, '')), 'B')
   || setweight(to_tsvector('mbele_search', coalesce(NEW.problem, '')), 'C')
   || setweight(to_tsvector('mbele_search', coalesce(NEW.solution, '')), 'D');

  RETURN NEW;
END
$$;

CREATE TRIGGER projects_validate
  BEFORE INSERT OR UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION projects_before_write();

/** The owner is a member from the start, for the same reason a team owner is (§4.3). */
CREATE OR REPLACE FUNCTION projects_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO project_members (project_id, user_id, is_owner)
  VALUES (NEW.id, NEW.owner_user_id, true)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;

CREATE TRIGGER projects_add_owner
  AFTER INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION projects_after_insert();

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE projects                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members             ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_opportunity_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_submissions         ENABLE ROW LEVEL SECURITY;

-- The owner can do anything with their own project, including delete it. DATA_MODEL.md
-- §14's row for projects: "SELECT where visibility='public' · ALL own · members SELECT".
CREATE POLICY projects_own ON projects FOR ALL
  USING (owner_user_id = auth.uid()) WITH CHECK (owner_user_id = auth.uid());

CREATE POLICY projects_readable ON projects FOR SELECT
  USING (
    deleted_at IS NULL
    AND (
      -- Public and unlisted differ in DISCOVERABILITY, not in read permission: unlisted
      -- rests on the random slug, and the page is noindex. A policy cannot see the link.
      visibility IN ('public', 'unlisted')
      OR owner_user_id = auth.uid()
      OR EXISTS (SELECT 1 FROM project_members m
                  WHERE m.project_id = projects.id AND m.user_id = auth.uid())
    )
  );

CREATE POLICY project_members_read ON project_members FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM projects p
                WHERE p.id = project_members.project_id
                  AND (p.owner_user_id = auth.uid() OR p.visibility = 'public'))
  );

CREATE POLICY project_members_leave ON project_members FOR DELETE
  USING (
    -- A member may leave; an owner may remove someone. Nobody may remove the owner.
    (user_id = auth.uid() AND is_owner = false)
    OR (is_owner = false
        AND EXISTS (SELECT 1 FROM projects p
                     WHERE p.id = project_members.project_id AND p.owner_user_id = auth.uid()))
  );

-- Matches are the owner's own derived data, computed from their eligibility profile. Not
-- readable by a member, and certainly not by the public: a match list is a readable
-- summary of what its owner is eligible for.
CREATE POLICY project_matches_owner ON project_opportunity_matches FOR SELECT
  USING (EXISTS (SELECT 1 FROM projects p
                  WHERE p.id = project_opportunity_matches.project_id
                    AND p.owner_user_id = auth.uid()));

CREATE POLICY project_submissions_read ON project_submissions FOR SELECT
  USING (EXISTS (SELECT 1 FROM projects p
                  WHERE p.id = project_submissions.project_id
                    AND (p.owner_user_id = auth.uid()
                         OR p.visibility = 'public'
                         OR EXISTS (SELECT 1 FROM project_members m
                                     WHERE m.project_id = p.id AND m.user_id = auth.uid()))));

CREATE POLICY project_submissions_write ON project_submissions FOR ALL
  USING (EXISTS (SELECT 1 FROM projects p
                  WHERE p.id = project_submissions.project_id AND p.owner_user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM projects p
                       WHERE p.id = project_submissions.project_id AND p.owner_user_id = auth.uid()));

-- ── §1.5 Matching: signals out, weights applied in TypeScript ───────────────

/**
 * Candidates for one project, with the raw signals §1.5's formula needs.
 *
 * THE GATE IS THE OWNER'S ELIGIBILITY. "published, open, verdict(owner) ∈ {eligible,
 * likely_eligible}" — so a project match never suggests a call its owner cannot enter,
 * which is the difference between this feature and a keyword alert.
 *
 * Callable by the owner (the request tier's synchronous first pass, §1.2 `[PR]`) and by
 * the batch tier, where auth.uid() is NULL. Nobody else: the verdicts in here are derived
 * from the eligibility profile, which ADMIN_SYSTEM.md §6 keeps unreadable by every other
 * principal including admins.
 */
CREATE OR REPLACE FUNCTION project_match_candidates(p_project_id uuid, p_limit int DEFAULT 200)
RETURNS TABLE (
  id uuid,
  slug text,
  title text,
  similarity numeric,
  shared_tag_count int,
  shared_tags text[],
  verdict text,
  deadline_at timestamptz,
  is_rolling boolean,
  organisation_slug text,
  organisation_name text,
  category_name text,
  cost text,
  team_required boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_embedding halfvec(384);
  v_tags uuid[];
  v_country char(2);
BEGIN
  SELECT p.owner_user_id, p.embedding,
         p.category_ids || p.industry_ids || p.skill_ids || p.technology_ids
    INTO v_owner, v_embedding, v_tags
    FROM projects p
   WHERE p.id = p_project_id AND p.deleted_at IS NULL;

  IF v_owner IS NULL THEN RETURN; END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> v_owner THEN RETURN; END IF;

  SELECT e.country_of_residence INTO v_country
    FROM eligibility_profiles e WHERE e.user_id = v_owner;

  RETURN QUERY
  WITH candidates AS (
    SELECT o.*
      FROM opportunities o
     WHERE o.status = 'published'
       AND o.deleted_at IS NULL
       AND o.duplicate_of IS NULL
       AND (o.deadline_at IS NULL AND o.is_rolling
            OR o.deadline_at > now())
       AND (v_country IS NULL
            OR o.eligibility_scope IN ('africa_wide','global')
            OR btrim(v_country) = ANY (SELECT btrim(c) FROM unnest(o.eligible_countries) AS c))
     ORDER BY o.deadline_at ASC NULLS LAST
     LIMIT p_limit
  )
  SELECT c.id,
         c.slug,
         c.title,
         -- No embedding on either side yet is a 0.5, not a zero: a project created two
         -- seconds ago has no vector, and §1.2 `[PR]` still requires matches in seconds.
         -- The tag and urgency terms carry that first pass; the nightly run refines it
         -- once the embedder has been past.
         CASE WHEN v_embedding IS NULL OR c.embedding IS NULL THEN 0.5::numeric
              ELSE (1 - (c.embedding <=> v_embedding))::numeric END,
         (SELECT count(*)::int FROM unnest(v_tags) AS t(id)
           WHERE t.id = ANY (c.tag_ids || c.skill_ids || c.technology_ids || c.industry_ids
                             || ARRAY[c.category_id])),
         coalesce(ARRAY(
           SELECT t.name FROM tags t
            WHERE t.id = ANY (v_tags)
              AND t.id = ANY (c.tag_ids || c.skill_ids || c.technology_ids || c.industry_ids)
            LIMIT 3), '{}'::text[]),
         v.verdict,
         c.deadline_at,
         c.is_rolling,
         og.slug,
         og.name,
         cat.name,
         c.cost::text,
         c.team_required
    FROM candidates c
    LEFT JOIN organisations og ON og.id = c.organisation_id
    LEFT JOIN categories cat ON cat.id = c.category_id
    CROSS JOIN LATERAL (SELECT uv.verdict FROM user_verdicts(v_owner, ARRAY[c.id]) uv) v
   WHERE v.verdict IN ('eligible','likely_eligible');
END
$$;

/**
 * Store a project's matches, atomically.
 *
 * Same owner-or-batch rule as the candidate function. The delete-then-insert happens in
 * one statement pair inside one function call, so a reader never sees a half-replaced list
 * — which on this surface would read as "your matches disappeared".
 */
CREATE OR REPLACE FUNCTION replace_project_matches(p_project_id uuid, p_rows jsonb)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_written int;
BEGIN
  SELECT owner_user_id INTO v_owner FROM projects WHERE id = p_project_id AND deleted_at IS NULL;
  IF v_owner IS NULL THEN RETURN 0; END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'only the owner of a project may write its matches';
  END IF;

  DELETE FROM project_opportunity_matches WHERE project_id = p_project_id;

  INSERT INTO project_opportunity_matches
    (project_id, opportunity_id, score, rank, eligibility_verdict, reasons)
  SELECT p_project_id,
         (row ->> 'opportunity_id')::uuid,
         (row ->> 'score')::numeric,
         (row ->> 'rank')::int,
         row ->> 'verdict',
         coalesce(row -> 'reasons', '[]'::jsonb)
    FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) AS row;

  SELECT count(*)::int INTO v_written
    FROM project_opportunity_matches WHERE project_id = p_project_id;

  UPDATE projects SET matched_at = now() WHERE id = p_project_id;

  RETURN v_written;
END
$$;

/**
 * The stored matches, as the project page shows them. §1.5: "a list with templated
 * reasons... Each carries the eligibility verdict for the owner and a one-tap track
 * action."
 */
CREATE OR REPLACE FUNCTION project_matches(p_project_id uuid)
RETURNS TABLE (
  opportunity_id uuid,
  slug text,
  title text,
  organisation_name text,
  deadline_at timestamptz,
  deadline_precision deadline_precision,
  is_rolling boolean,
  cost text,
  verdict text,
  score numeric,
  rank int,
  reasons jsonb,
  tracked boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid;
BEGIN
  SELECT owner_user_id INTO v_owner FROM projects WHERE id = p_project_id AND deleted_at IS NULL;
  IF v_owner IS NULL OR auth.uid() IS NULL OR auth.uid() <> v_owner THEN RETURN; END IF;

  RETURN QUERY
  SELECT o.id, o.slug, o.title, og.name, o.deadline_at, o.deadline_precision, o.is_rolling,
         o.cost::text, m.eligibility_verdict, m.score, m.rank, m.reasons,
         EXISTS (SELECT 1 FROM tracker_entries t
                  WHERE t.user_id = v_owner AND t.opportunity_id = o.id)
    FROM project_opportunity_matches m
    JOIN opportunities o ON o.id = m.opportunity_id
    LEFT JOIN organisations og ON og.id = o.organisation_id
   WHERE m.project_id = p_project_id
     AND o.status = 'published'
     AND o.deleted_at IS NULL
   ORDER BY m.rank;
END
$$;

-- ── Density floors (§1.4, §1.6, PRODUCT_SPEC.md §24) ────────────────────────

/**
 * Whether project browse exists at all. §1.4 and UX_FLOWS.md §9.3 `[PR]`: "Does not exist
 * below 40 public projects. Not an empty page, not a 'coming soon' — the route is absent
 * and the nav item is not rendered."
 *
 * Returns the count as well, so the admin density panel can show how far off it is without
 * a second query — and so the number never has to be recomputed by a caller that might
 * count something slightly different.
 */
CREATE OR REPLACE FUNCTION project_browse_state()
RETURNS TABLE (state text, public_projects int, floor int)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  v_count int;
BEGIN
  SELECT enabled INTO v_enabled FROM feature_flags WHERE key = 'public_project_browse';

  -- Every column qualified: this function has an OUT parameter called `state`, and an
  -- unqualified `state` in here is ambiguous against projects.state. Postgres says so
  -- rather than guessing, which is the good outcome; it said so at the first call.
  SELECT count(*)::int INTO v_count
    FROM projects p
   WHERE p.visibility = 'public' AND p.deleted_at IS NULL
     AND p.state <> 'archived';

  IF v_enabled IS NOT TRUE THEN
    RETURN QUERY SELECT 'disabled', v_count, 40;
    RETURN;
  END IF;
  IF v_count < 40 THEN
    RETURN QUERY SELECT 'below_floor', v_count, 40;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'open', v_count, 40;
END
$$;

/**
 * §1.6: matching PUBLIC projects on an opportunity page, "only at a density floor of 3
 * matching public projects. Below that, the section does not exist."
 *
 * Returns nothing at all below the floor rather than a short list, so a caller cannot
 * render two projects and call it a section.
 */
CREATE OR REPLACE FUNCTION projects_for_opportunity(p_opportunity_id uuid)
RETURNS TABLE (
  slug text,
  title text,
  pitch text,
  state project_state,
  roles_needed text[],
  country_iso2 char(2)
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  v_tags uuid[];
  v_matching int;
BEGIN
  SELECT enabled INTO v_enabled FROM feature_flags WHERE key = 'related_projects_on_opportunity';
  IF v_enabled IS NOT TRUE THEN RETURN; END IF;

  SELECT o.tag_ids || o.skill_ids || o.technology_ids || o.industry_ids || ARRAY[o.category_id]
    INTO v_tags
    FROM opportunities o
   WHERE o.id = p_opportunity_id AND o.status = 'published' AND o.deleted_at IS NULL;

  IF v_tags IS NULL THEN RETURN; END IF;

  SELECT count(*)::int INTO v_matching
    FROM projects p
   WHERE p.visibility = 'public'
     AND p.deleted_at IS NULL
     AND p.state IN ('idea','looking_for_collaborators','team_forming','building','testing')
     AND (p.category_ids || p.industry_ids || p.skill_ids || p.technology_ids) && v_tags;

  -- The floor, and the reason it is checked before the SELECT rather than after: a LIMIT
  -- with a short result is exactly the "empty surface" §24 forbids.
  IF v_matching < 3 THEN RETURN; END IF;

  RETURN QUERY
  SELECT p.slug, p.title, p.pitch, p.state,
         coalesce(ARRAY(SELECT t.name FROM tags t WHERE t.id = ANY (p.roles_needed)), '{}'::text[]),
         p.country_iso2
    FROM projects p
   WHERE p.visibility = 'public'
     AND p.deleted_at IS NULL
     AND p.state IN ('idea','looking_for_collaborators','team_forming','building','testing')
     AND (p.category_ids || p.industry_ids || p.skill_ids || p.technology_ids) && v_tags
   ORDER BY p.last_activity_at DESC
   LIMIT 6;
END
$$;

-- ── §1.3 Inactivity: prompt at 120 days, pause at 180, never delete ─────────

/**
 * "Inactivity handling: prompt at 120 days, auto-`paused` at 180 days. NEVER AUTO-DELETE."
 *
 * A paused project "is hidden from public browse but keeps receiving matches for its
 * owner" — which is why pausing changes `state` and nothing else. The matcher does not
 * read state, so the matches keep arriving, exactly as §1.3 says.
 */
CREATE OR REPLACE FUNCTION project_inactivity_sweep()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prompted int := 0;
  v_paused int := 0;
  r record;
BEGIN
  FOR r IN
    SELECT p.id, p.slug, p.title, p.owner_user_id
      FROM projects p
     WHERE p.deleted_at IS NULL
       AND p.state NOT IN ('paused','archived','completed','launched')
       AND p.last_activity_at < now() - interval '120 days'
       AND p.last_activity_at >= now() - interval '180 days'
       AND p.inactivity_prompted_at IS NULL
  LOOP
    PERFORM enqueue_notification(
      r.owner_user_id, 'system',
      'Your project "' || r.title || '" has been quiet for four months. Still going?',
      jsonb_build_object('project_slug', r.slug));
    UPDATE projects SET inactivity_prompted_at = now() WHERE id = r.id;
    v_prompted := v_prompted + 1;
  END LOOP;

  WITH paused AS (
    UPDATE projects
       SET state = 'paused', state_changed_at = now()
     WHERE deleted_at IS NULL
       AND state NOT IN ('paused','archived','completed','launched')
       AND last_activity_at < now() - interval '180 days'
    RETURNING 1)
  SELECT count(*)::int INTO v_paused FROM paused;

  RETURN jsonb_build_object(
    'prompted_at_120_days', v_prompted,
    'paused_at_180_days', v_paused,
    'deleted', 0);
END
$$;

-- ── Accepting a project-role request ────────────────────────────────────────

/**
 * Replaces 0016's accept_request, which knew about teams and not about projects — because
 * projects did not exist. §2.1's `project_role` context has been valid in the requests
 * table since 0016, so without this branch an accepted interest request opened a thread and
 * added nobody to anything.
 *
 * 0016's version is reproduced verbatim in this migration's down file.
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
  v_project projects;
BEGIN
  SELECT * INTO r FROM collaboration_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RETURN NULL; END IF;

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

  IF r.context = 'project_role' THEN
    SELECT * INTO v_project FROM projects WHERE id = r.project_id AND deleted_at IS NULL;
    IF v_project.id IS NULL THEN
      RAISE EXCEPTION 'that project no longer exists';
    END IF;
    -- Only the project's owner can accept someone into it. The requests table already
    -- enforces that the target decides; this is the check that the target is the owner.
    IF v_project.owner_user_id <> auth.uid() THEN
      RAISE EXCEPTION 'only the owner of a project can accept someone into it';
    END IF;
    INSERT INTO project_members (project_id, user_id, role_id)
    VALUES (v_project.id, r.requester_user_id,
            (SELECT t.id FROM tags t WHERE t.kind = 'role' AND t.name = r.role))
    ON CONFLICT DO NOTHING;
    -- Somebody joining is activity, whatever else has been quiet.
    UPDATE projects SET last_activity_at = now(), inactivity_prompted_at = NULL
     WHERE id = v_project.id;
  END IF;

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
 * A project a visitor is looking at, as the interest composer needs it: who to write to,
 * what roles are open, and nothing about the owner beyond their display name.
 *
 * Same five-field discipline as room_builders: a request composer has no business knowing
 * more about a person than the surface it was opened from showed.
 */
CREATE OR REPLACE FUNCTION project_interest_target(p_project_id uuid)
RETURNS TABLE (
  project_id uuid,
  slug text,
  title text,
  owner_user_id uuid,
  owner_display_name text,
  roles_needed text[],
  already_member boolean,
  my_request_state request_state
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  p projects;
BEGIN
  IF v_me IS NULL THEN RETURN; END IF;

  SELECT * INTO p FROM projects
   WHERE id = p_project_id AND deleted_at IS NULL
     -- Interest can only be expressed in something you were shown. A private project is
     -- not a surface, so there is nothing to be interested in.
     AND visibility IN ('public','unlisted');
  IF p.id IS NULL OR p.owner_user_id = v_me THEN RETURN; END IF;

  -- §4: a block removes the person from every surface you share, in both directions.
  IF EXISTS (SELECT 1 FROM blocks b
              WHERE (b.blocker_user_id = v_me AND b.blocked_user_id = p.owner_user_id)
                 OR (b.blocker_user_id = p.owner_user_id AND b.blocked_user_id = v_me)) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id, p.slug, p.title, p.owner_user_id, u.display_name,
         coalesce(ARRAY(SELECT t.name FROM tags t WHERE t.id = ANY (p.roles_needed)), '{}'::text[]),
         EXISTS (SELECT 1 FROM project_members m
                  WHERE m.project_id = p.id AND m.user_id = v_me),
         (SELECT r.state FROM collaboration_requests r
           WHERE r.requester_user_id = v_me AND r.context = 'project_role' AND r.project_id = p.id
           ORDER BY r.created_at DESC LIMIT 1)
    FROM users u
   WHERE u.id = p.owner_user_id;
END
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION project_inactivity_sweep() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION project_match_candidates(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION replace_project_matches(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION project_matches(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION project_browse_state() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION projects_for_opportunity(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION project_interest_target(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION project_slug(text) TO authenticated;
