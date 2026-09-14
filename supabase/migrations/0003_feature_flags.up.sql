-- 0003 feature flags
-- DATA_MODEL.md §12, SYSTEM_ARCHITECTURE.md §19.
--
-- Every density-dependent surface is gated here so Phase-2+ features can ship
-- dark, and so SECURITY.md §11's requirement for "a feature-flag kill switch on
-- every non-core surface" is satisfied without a deploy.
--
-- Invariant 4: never render a social surface below its density floor. A surface
-- renders only when its flag is enabled AND `condition_sql` evaluates true —
-- both, never either. Seeded rows are all `enabled = false`
-- (PRODUCT_SPEC.md §24).

CREATE TABLE feature_flags (
  key           text PRIMARY KEY,
  enabled       boolean NOT NULL DEFAULT false,
  description   text,
  -- Optional density condition. Must be a scalar boolean SELECT. Evaluated by
  -- the application against precomputed counts, never by interpolating user
  -- input (SECURITY.md §3: no string-concatenated SQL anywhere).
  condition_sql text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid
);

COMMENT ON TABLE feature_flags IS
  'Density floors and kill switches. Rows default to disabled; PRODUCT_SPEC.md §24.';

ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;

-- Readable by anyone, because the public site must know whether a surface is
-- live. Writable only via the service role in the batch/admin tier, which
-- bypasses RLS; no anon or authenticated write policy exists, so default deny
-- applies to every other principal.
CREATE POLICY feature_flags_public_read ON feature_flags FOR SELECT USING (true);

INSERT INTO feature_flags (key, enabled, description, condition_sql) VALUES
  ('intent_count_visible', false,
   'Show the aggregate intent count on an opportunity. Floor: >=5 active intents. Below it no number is shown at all, not even 0 (TEAM_FORMATION.md §2.3).',
   'SELECT count(*) >= 5 FROM intents WHERE opportunity_id = $1 AND is_active'),

  ('team_room_entry', false,
   'Show the team room entry point. Floor: >=3 active intents OR >=1 team. Below it the route returns the opportunity page with a single CTA (IMPLEMENTATION_PLAN.md §7).',
   'SELECT (SELECT count(*) FROM intents WHERE opportunity_id = $1 AND is_active) >= 3 OR (SELECT count(*) FROM teams WHERE opportunity_id = $1) >= 1'),

  ('teams_list_in_room', false,
   'Show the teams list inside a room. Floor: >=1 open team. Below it, solo builders only.',
   'SELECT count(*) >= 1 FROM teams WHERE opportunity_id = $1 AND state IN (''forming'',''open_for_roles'')'),

  ('builders_also_going', false,
   'Show "builders also going for this". Floor: >=5 discoverable builders.',
   'SELECT count(*) >= 5 FROM intents i JOIN profiles p ON p.user_id = i.user_id WHERE i.opportunity_id = $1 AND i.is_active AND p.visibility IN (''discoverable_in_rooms'',''public'')'),

  ('public_project_browse', false,
   'Public project browse. Floor: >=40 public projects platform-wide. Below it the route is absent and the nav item unrendered (UX_FLOWS.md §9.3).',
   'SELECT count(*) >= 40 FROM projects WHERE visibility = ''public'' AND deleted_at IS NULL'),

  ('global_builder_index', false,
   'Global builder index. Floor: >=250 public profiles AND >=1000 MAU. Not built in Phase 1 (PRODUCT_SPEC.md §16.3).',
   'SELECT (SELECT count(*) FROM profiles WHERE visibility = ''public'') >= 250 AND (SELECT count(*) FROM users WHERE last_seen_at > now() - interval ''30 days'') >= 1000'),

  ('related_projects_on_opportunity', false,
   'Show related projects on an opportunity. Floor: >=3 matching public projects.',
   'SELECT count(*) >= 3 FROM project_opportunity_matches m JOIN projects p ON p.id = m.project_id WHERE m.opportunity_id = $1 AND p.visibility = ''public''');

-- Non-density kill switches. Also off until their phase ships.
INSERT INTO feature_flags (key, enabled, description) VALUES
  ('nl_query_compiler', false, 'NL query compiler island. Falls back to the deterministic heuristic matcher when off or unavailable (AI_SYSTEM.md §7).'),
  ('brief_decoder', false, 'Brief Decoder generation on demand (AI_SYSTEM.md §6).'),
  ('telegram_bot', false, 'Telegram bot webhook and push delivery (NOTIFICATIONS.md §7).'),
  ('org_self_serve', false, 'Organisation claim and self-serve publishing (PRODUCT_SPEC.md §19).'),
  ('projects', false, 'Project records and project->opportunity matching (COLLABORATION_SYSTEM.md §1).'),
  ('intents', false, 'Intent declaration (TEAM_FORMATION.md §2).');
