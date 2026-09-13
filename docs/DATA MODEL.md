# DATA_MODEL.md

**Database:** PostgreSQL 15+ with `pgvector`, `pg_trgm`, `unaccent`, `citext`, `uuid-ossp`.
**Conventions:** `snake_case`; primary keys `uuid` default `gen_random_uuid()`; all timestamps `timestamptz` in UTC; `created_at`/`updated_at` on every table; soft delete via `deleted_at` where content is user-visible; enums as Postgres `ENUM` types where the set is stable, as lookup tables where admins must extend them without a migration.

**Extensibility rule `[PR]`:** categories, skills, technologies, industries and tags are **lookup tables**, not enums. Adding one is a row insert.

---

## 1. REFERENCE / TAXONOMY

```sql
CREATE TABLE countries (
  iso2            char(2) PRIMARY KEY,          -- 'ZW'
  iso3            char(3) NOT NULL,
  name            text NOT NULL,
  common_names    text[] DEFAULT '{}',          -- search aliases
  region          text NOT NULL,                -- 'southern_africa' | 'western_africa' | ... | 'non_africa'
  is_african      boolean NOT NULL,
  slug            text UNIQUE NOT NULL,
  priority_tier   smallint DEFAULT 3,           -- seeding/promotion only, never eligibility
  timezone_default text
);

CREATE TABLE regions (
  code   text PRIMARY KEY,      -- 'southern_africa','africa_wide','global','remote_accessible'
  name   text NOT NULL,
  slug   text UNIQUE NOT NULL,
  member_countries char(2)[] DEFAULT '{}'
);

CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE NOT NULL,   -- 'hackathon'
  name        text NOT NULL,
  slug        text UNIQUE NOT NULL,
  parent_id   uuid REFERENCES categories(id),
  description text,
  sort_order  int DEFAULT 100,
  is_active   boolean DEFAULT true
);

CREATE TABLE tags (            -- also used for skills / technologies / industries
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind      text NOT NULL,     -- 'skill' | 'technology' | 'industry' | 'theme' | 'role'
  code      text NOT NULL,
  name      text NOT NULL,
  slug      text NOT NULL,
  aliases   text[] DEFAULT '{}',
  is_active boolean DEFAULT true,
  UNIQUE (kind, code)
);
```

---

## 2. ORGANISATIONS

```sql
CREATE TYPE org_verification AS ENUM
  ('unclaimed','claimed_pending','verified','rejected','suspended');

CREATE TABLE organisations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  slug              text UNIQUE NOT NULL,
  description       text,
  website_url       text,
  website_domain    text,                       -- normalised, used for claim matching
  logo_key          text,                       -- R2 object key
  country_iso2      char(2) REFERENCES countries(iso2),
  region_code       text REFERENCES regions(code),
  org_type          text,                       -- 'foundation','university','company','community','government','ngo','platform'
  verification      org_verification NOT NULL DEFAULT 'unclaimed',
  verified_at       timestamptz,
  trust_score       numeric(4,3) DEFAULT 0.500, -- 0..1, drives auto-publish thresholds
  duplicate_of      uuid REFERENCES organisations(id),
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX ON organisations USING gin (name gin_trgm_ops);
CREATE INDEX ON organisations (website_domain);

CREATE TABLE organisation_claims (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claim_email    citext NOT NULL,
  email_domain   text NOT NULL,
  domain_matches boolean NOT NULL,              -- claim_email domain == website_domain
  evidence_url   text,
  status         text NOT NULL DEFAULT 'pending', -- pending|approved|rejected
  token_hash     text,
  token_expires_at timestamptz,
  reviewed_by    uuid REFERENCES users(id),
  reviewed_at    timestamptz,
  created_at     timestamptz DEFAULT now()
);

CREATE TABLE organisation_members (
  organisation_id uuid REFERENCES organisations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'editor',  -- owner|editor
  created_at      timestamptz DEFAULT now(),
  PRIMARY KEY (organisation_id, user_id)
);
```

---

## 3. USERS, PROFILES, ELIGIBILITY

```sql
CREATE TYPE profile_visibility AS ENUM ('private','discoverable_in_rooms','public');
CREATE TYPE account_state AS ENUM ('active','restricted','suspended','deleted','pending_age_review');

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext UNIQUE,
  email_verified_at timestamptz,
  auth_provider     text,                    -- 'github'|'google'|'email_otp'
  handle            citext UNIQUE,           -- URL slug for public profile
  display_name      text,
  is_admin          boolean DEFAULT false,
  admin_role        text,                    -- 'reviewer'|'moderator'|'superadmin'
  account_state     account_state DEFAULT 'active',
  age_confirmed_18  boolean DEFAULT false,   -- PRODUCT_SPEC §22.1
  timezone          text DEFAULT 'UTC',
  locale            text DEFAULT 'en',
  low_data_mode     boolean DEFAULT false,
  last_seen_at      timestamptz,
  created_at        timestamptz DEFAULT now(),
  deleted_at        timestamptz
);

-- PUBLIC layer
CREATE TABLE profiles (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  visibility     profile_visibility NOT NULL DEFAULT 'private',
  headline       text CHECK (char_length(headline) <= 120),
  bio            text CHECK (char_length(bio) <= 1000),
  country_iso2   char(2) REFERENCES countries(iso2),
  city           text,                       -- optional, coarse, never geocoded
  github_url     text,
  portfolio_url  text,
  other_url      text,
  open_to        text[] DEFAULT '{}',        -- 'hackathon_teams','projects','research','mentoring'
  availability_hours_per_week smallint,
  indexable      boolean DEFAULT false,      -- SEO opt-in, default off
  embedding      vector(384),
  updated_at     timestamptz DEFAULT now()
);

-- PRIVATE layer. Never exposed to other users. See PRIVACY_AND_COMPLIANCE.md
CREATE TABLE eligibility_profiles (
  user_id                  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  country_of_residence     char(2) REFERENCES countries(iso2),
  nationalities            char(2)[] DEFAULT '{}',
  birth_year               smallint,          -- year only, not full DOB
  student_status           text,              -- not_student|secondary|undergraduate|postgraduate|recent_graduate
  year_of_study            smallint,
  institution_name         text,
  institution_type         text,              -- university|polytechnic|secondary|bootcamp|none
  field_of_study           text,
  years_experience         smallint,
  languages                text[] DEFAULT '{}',
  gender                   text,              -- OPTIONAL, self-declared, used only for gender_restricted rules
  availability_hours_per_week smallint,
  available_from           date,
  available_until          date,
  can_travel               boolean,
  has_valid_passport       boolean,
  remote_only              boolean,
  skills                   uuid[] DEFAULT '{}',   -- tags.id
  technologies             uuid[] DEFAULT '{}',
  interests                uuid[] DEFAULT '{}',
  embedding                vector(384),
  completeness             smallint DEFAULT 0,    -- 0..100, drives prompts
  updated_at               timestamptz DEFAULT now()
);
```

**Anonymous eligibility `[PR]`:** logged-out users may run a verdict. Their inputs are held **client-side only** (localStorage) and posted per-request; they are never persisted server-side. See `API_SPEC.md` `POST /api/eligibility/evaluate`.

---

## 4. SOURCES AND INGESTION

```sql
CREATE TYPE source_kind AS ENUM ('rss','atom','json_api','sitemap','jsonld','html_page','manual','org_submission','github_api','kaggle_api','eventbrite_api');
CREATE TYPE fetch_status AS ENUM ('ok','not_modified','fetch_error','parse_error','blocked','rate_limited');

CREATE TABLE sources (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  kind               source_kind NOT NULL,
  url                text NOT NULL,
  organisation_id    uuid REFERENCES organisations(id),
  cadence_minutes    int NOT NULL DEFAULT 720,
  robots_allowed     boolean,
  robots_checked_at  timestamptz,
  tos_url            text,
  tos_posture        text,        -- 'permits_feeds'|'silent'|'restricts_automation'|'requires_permission'
  legal_note         text,
  attribution_required boolean DEFAULT true,
  is_active          boolean DEFAULT true,
  trust_score        numeric(4,3) DEFAULT 0.500,
  default_categories uuid[] DEFAULT '{}',
  default_region     text,
  last_fetch_at      timestamptz,
  last_success_at    timestamptz,
  consecutive_failures int DEFAULT 0,
  etag               text,
  last_modified      text,
  created_at         timestamptz DEFAULT now()
);

CREATE TABLE source_fetches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  started_at   timestamptz DEFAULT now(),
  finished_at  timestamptz,
  status       fetch_status NOT NULL,
  http_status  int,
  items_seen   int DEFAULT 0,
  items_new    int DEFAULT 0,
  error        text
);

CREATE TABLE raw_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES sources(id),
  source_fetch_id uuid REFERENCES source_fetches(id),
  url             text NOT NULL,
  canonical_url   text NOT NULL,
  content_hash    text NOT NULL,              -- sha256 of normalised text
  title_raw       text,
  text_raw        text,                       -- extracted readable text, retained for review + quoting
  jsonld          jsonb,
  fetched_at      timestamptz DEFAULT now(),
  UNIQUE (canonical_url, content_hash)
);
CREATE INDEX ON raw_documents (content_hash);

CREATE TABLE extraction_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_document_id uuid NOT NULL REFERENCES raw_documents(id) ON DELETE CASCADE,
  provider        text NOT NULL,              -- 'groq'|'gemini'|'workers_ai'|'cerebras'|'deterministic'
  model           text NOT NULL,
  prompt_version  text NOT NULL,
  output          jsonb NOT NULL,
  schema_valid    boolean NOT NULL,
  confidence      numeric(4,3),
  field_confidence jsonb,                     -- {"deadline_at":0.91,"country_in":0.62,...}
  tokens_in       int, tokens_out int,
  latency_ms      int,
  error           text,
  created_at      timestamptz DEFAULT now()
);
```

---

## 5. OPPORTUNITIES

```sql
CREATE TYPE opp_status AS ENUM
  ('draft','in_review','published','closed','expired','cancelled','rejected','merged');
CREATE TYPE opp_verification AS ENUM
  ('official','verified','auto','community_flagged','stale','expired','disputed');
CREATE TYPE participation_mode AS ENUM ('online','in_person','hybrid','unknown');
CREATE TYPE deadline_precision AS ENUM ('exact_time','date_only','month_only','rolling','unknown');
CREATE TYPE eligibility_scope AS ENUM ('country_list','region','africa_wide','global','unclear');
CREATE TYPE cost_kind AS ENUM ('free','paid','unknown');

CREATE TABLE opportunities (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text UNIQUE NOT NULL,
  title              text NOT NULL,
  organisation_id    uuid REFERENCES organisations(id),
  summary            text CHECK (char_length(summary) <= 400),   -- OUR words, never copied
  description_md     text,                                       -- normalised, our structure
  category_id        uuid NOT NULL REFERENCES categories(id),
  subcategory_ids    uuid[] DEFAULT '{}',
  tag_ids            uuid[] DEFAULT '{}',
  skill_ids          uuid[] DEFAULT '{}',
  technology_ids     uuid[] DEFAULT '{}',
  industry_ids       uuid[] DEFAULT '{}',

  -- geography
  eligibility_scope  eligibility_scope NOT NULL DEFAULT 'unclear',
  eligible_countries char(2)[] DEFAULT '{}',
  excluded_countries char(2)[] DEFAULT '{}',
  region_codes       text[] DEFAULT '{}',
  participation_mode participation_mode NOT NULL DEFAULT 'unknown',
  venue_country_iso2 char(2) REFERENCES countries(iso2),
  venue_city         text,

  -- dates
  opens_at           timestamptz,
  deadline_at        timestamptz,
  deadline_precision deadline_precision NOT NULL DEFAULT 'unknown',
  deadline_timezone  text,
  deadline_raw       text,                 -- verbatim source string, always displayed when precision < exact_time
  starts_at          timestamptz,
  ends_at            timestamptz,
  is_rolling         boolean DEFAULT false,

  -- participation
  team_required      boolean,
  team_size_min      smallint,
  team_size_max      smallint,
  experience_level   text,                 -- beginner|intermediate|advanced|any

  -- value & cost
  prize_amount       numeric(14,2),
  prize_currency     char(3),
  prize_description  text,
  funding_description text,
  cost               cost_kind NOT NULL DEFAULT 'unknown',
  cost_description   text,

  -- provenance
  source_id          uuid REFERENCES sources(id),
  raw_document_id    uuid REFERENCES raw_documents(id),
  source_url         text,
  official_url       text,
  apply_url          text,
  submitted_by_user_id uuid REFERENCES users(id),

  -- state
  status             opp_status NOT NULL DEFAULT 'draft',
  verification       opp_verification NOT NULL DEFAULT 'auto',
  extraction_confidence numeric(4,3),
  last_verified_at   timestamptz,
  next_verify_at     timestamptz,
  link_ok            boolean,
  link_checked_at    timestamptz,
  duplicate_of       uuid REFERENCES opportunities(id),
  view_count         int DEFAULT 0,        -- aggregate, never shown to users as social proof

  search_vector      tsvector,
  embedding          vector(384),

  published_at       timestamptz,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  deleted_at         timestamptz
);

CREATE INDEX ON opportunities USING gin (search_vector);
CREATE INDEX ON opportunities USING gin (eligible_countries);
CREATE INDEX ON opportunities USING gin (tag_ids);
CREATE INDEX ON opportunities (status, deadline_at)
  WHERE status = 'published';
CREATE INDEX ON opportunities USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON opportunities (next_verify_at) WHERE status = 'published';
```

### 5.1 Eligibility rules

```sql
CREATE TYPE rule_type AS ENUM (
  'country_in','country_not_in','nationality_in','residency_required',
  'age_between','student_status_in','year_of_study_in','institution_type_in',
  'experience_between','team_size_between','individual_only','team_only',
  'gender_restricted','language_required','cost','travel_required','other_unstructured'
);

CREATE TABLE eligibility_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  rule_type       rule_type NOT NULL,
  params          jsonb NOT NULL,        -- {"countries":["ZW","ZM"]} / {"min":18,"max":25}
  source_quote    text NOT NULL,         -- verbatim sentence from raw_documents.text_raw
  confidence      numeric(4,3) NOT NULL,
  is_high_stakes  boolean GENERATED ALWAYS AS
    (rule_type IN ('country_in','country_not_in','nationality_in','age_between','student_status_in')) STORED,
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX ON eligibility_rules (opportunity_id);
```

**Invariant `[PR]`:** `source_quote` is `NOT NULL`. A rule without a quote cannot exist, therefore no verdict can ever be rendered without a citable source.

### 5.2 Change log and briefs

```sql
CREATE TABLE opportunity_changes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  field          text NOT NULL,
  old_value      jsonb,
  new_value      jsonb,
  changed_by     text NOT NULL,        -- 'ingestion'|'admin:<uuid>'|'org:<uuid>'
  notify_trackers boolean DEFAULT false,
  created_at     timestamptz DEFAULT now()
);

CREATE TABLE opportunity_briefs (        -- Brief Decoder output, cached forever
  opportunity_id uuid PRIMARY KEY REFERENCES opportunities(id) ON DELETE CASCADE,
  theme          jsonb,   -- {"text":"...","quote":"..."}
  deliverables   jsonb,   -- [{"text":"...","quote":"..."}]
  judging_criteria jsonb, -- [{"name":"Impact","weight":30,"quote":"..."}]
  key_dates      jsonb,
  prohibitions   jsonb,
  submission_format jsonb,
  generated_by   text, model text, prompt_version text,
  generated_at   timestamptz DEFAULT now()
);
```

---

## 6. TRACKER AND INTENT

```sql
CREATE TYPE tracker_state AS ENUM
  ('saved','planning_to_apply','applied','submitted','participating','completed',
   'outcome_won','outcome_placed','outcome_not_selected','withdrawn','missed_deadline');

CREATE TABLE tracker_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  state          tracker_state NOT NULL DEFAULT 'saved',
  note           text CHECK (char_length(note) <= 2000),
  applied_at     date,
  remind_at      timestamptz,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  UNIQUE (user_id, opportunity_id)
);

CREATE TYPE intent_stance AS ENUM
  ('going_solo','looking_for_team','have_team_looking_for_roles','just_interested');

CREATE TABLE intents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  stance         intent_stance NOT NULL,
  roles_offered  uuid[] DEFAULT '{}',     -- tags.kind='role'
  note           text CHECK (char_length(note) <= 300),
  is_active      boolean DEFAULT true,
  expires_at     timestamptz,             -- set to opportunity.deadline_at on insert
  created_at     timestamptz DEFAULT now(),
  UNIQUE (user_id, opportunity_id)
);
CREATE INDEX ON intents (opportunity_id) WHERE is_active;
```

---

## 7. TEAMS

```sql
CREATE TYPE team_state AS ENUM ('forming','open_for_roles','full','submitted','disbanded','archived');
CREATE TYPE request_state AS ENUM ('pending','accepted','declined','withdrawn','expired');

CREATE TABLE teams (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  owner_user_id  uuid NOT NULL REFERENCES users(id),
  name           text NOT NULL CHECK (char_length(name) <= 80),
  pitch          text CHECK (char_length(pitch) <= 600),
  project_id     uuid REFERENCES projects(id),
  roles_needed   uuid[] DEFAULT '{}',
  max_size       smallint,                -- bounded by opportunity.team_size_max
  state          team_state NOT NULL DEFAULT 'forming',
  created_at     timestamptz DEFAULT now(),
  archived_at    timestamptz
);

CREATE TABLE team_members (
  team_id   uuid REFERENCES teams(id) ON DELETE CASCADE,
  user_id   uuid REFERENCES users(id) ON DELETE CASCADE,
  role_id   uuid REFERENCES tags(id),
  is_owner  boolean DEFAULT false,
  joined_at timestamptz DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE team_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     uuid REFERENCES tags(id),
  message     text CHECK (char_length(message) <= 500),
  state       request_state NOT NULL DEFAULT 'pending',
  decided_by  uuid REFERENCES users(id),
  decided_at  timestamptz,
  created_at  timestamptz DEFAULT now(),
  UNIQUE (team_id, user_id)
);
```

---

## 8. PROJECTS

```sql
CREATE TYPE project_state AS ENUM
  ('idea','looking_for_collaborators','team_forming','building','testing','launched','completed','paused','archived');
CREATE TYPE project_visibility AS ENUM ('private','unlisted','public');

CREATE TABLE projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text UNIQUE,
  owner_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          text NOT NULL CHECK (char_length(title) <= 120),
  pitch          text CHECK (char_length(pitch) <= 200),
  problem        text CHECK (char_length(problem) <= 2000),
  solution       text CHECK (char_length(solution) <= 2000),
  target_users   text CHECK (char_length(target_users) <= 500),
  state          project_state NOT NULL DEFAULT 'idea',
  visibility     project_visibility NOT NULL DEFAULT 'private',
  indexable      boolean DEFAULT false,
  category_ids   uuid[] DEFAULT '{}',
  industry_ids   uuid[] DEFAULT '{}',
  skill_ids      uuid[] DEFAULT '{}',
  technology_ids uuid[] DEFAULT '{}',
  roles_needed   uuid[] DEFAULT '{}',
  repo_url text, demo_url text, docs_url text,
  country_iso2   char(2) REFERENCES countries(iso2),
  embedding      vector(384),
  search_vector  tsvector,
  last_activity_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE project_members (
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  role_id    uuid REFERENCES tags(id),
  is_owner   boolean DEFAULT false,
  joined_at  timestamptz DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE project_opportunity_matches (   -- precomputed nightly
  project_id     uuid REFERENCES projects(id) ON DELETE CASCADE,
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  score          numeric(5,4) NOT NULL,
  eligibility_verdict text NOT NULL,
  reasons        jsonb NOT NULL,           -- templated strings + matched tag ids
  computed_at    timestamptz DEFAULT now(),
  PRIMARY KEY (project_id, opportunity_id)
);

CREATE TABLE project_submissions (           -- project entered into an opportunity
  project_id     uuid REFERENCES projects(id) ON DELETE CASCADE,
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  team_id        uuid REFERENCES teams(id),
  outcome        text,                      -- submitted|finalist|winner|not_selected
  recorded_at    timestamptz DEFAULT now(),
  PRIMARY KEY (project_id, opportunity_id)
);
```

---

## 9. CONNECTIONS AND THREADS

```sql
CREATE TYPE connection_context AS ENUM ('team_request','project_role','opportunity_intent');

CREATE TABLE connection_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  context       connection_context NOT NULL,
  context_id    uuid NOT NULL,             -- team/project/opportunity id
  role_id       uuid REFERENCES tags(id),
  message       text CHECK (char_length(message) <= 500),
  state         request_state NOT NULL DEFAULT 'pending',
  decided_at    timestamptz,
  created_at    timestamptz DEFAULT now(),
  UNIQUE (from_user_id, to_user_id, context, context_id)
);

CREATE TABLE threads (                      -- opens ONLY on mutual accept
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context      connection_context NOT NULL,
  context_id   uuid NOT NULL,
  created_at   timestamptz DEFAULT now(),
  closed_at    timestamptz
);
CREATE TABLE thread_participants (
  thread_id uuid REFERENCES threads(id) ON DELETE CASCADE,
  user_id   uuid REFERENCES users(id) ON DELETE CASCADE,
  handoff_consent text,                    -- null|'telegram'|'email'|'whatsapp'
  PRIMARY KEY (thread_id, user_id)
);
CREATE TABLE messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  body       text NOT NULL CHECK (char_length(body) <= 2000),
  flagged    boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE blocks (
  blocker_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);
```

---

## 10. NOTIFICATIONS AND CHANNELS

```sql
CREATE TYPE notif_type AS ENUM (
  'deadline_reminder','digest','request_received','request_accepted','request_declined',
  'team_update','opportunity_changed','opportunity_closed','project_match','moderation_outcome','system');
CREATE TYPE notif_channel AS ENUM ('in_app','email','telegram','web_push');

CREATE TABLE notification_channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel       notif_channel NOT NULL,
  address       text,                    -- telegram chat_id / push endpoint
  verified_at   timestamptz,
  is_active     boolean DEFAULT true,
  UNIQUE (user_id, channel)
);

CREATE TABLE notification_preferences (
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  type       notif_type,
  channel    notif_channel,
  enabled    boolean DEFAULT true,
  PRIMARY KEY (user_id, type, channel)
);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        notif_type NOT NULL,
  payload     jsonb NOT NULL,
  reason      text NOT NULL,          -- human-readable "why you got this"
  priority    smallint NOT NULL DEFAULT 5,   -- 1 highest
  read_at     timestamptz,
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE notification_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         notif_channel NOT NULL,
  state           text NOT NULL DEFAULT 'queued', -- queued|sent|deferred|failed|suppressed
  attempts        smallint DEFAULT 0,
  scheduled_for   timestamptz,
  sent_at         timestamptz,
  error           text
);

CREATE TABLE send_budget (            -- one row per channel per UTC day
  day      date, channel notif_channel, sent int DEFAULT 0, cap int NOT NULL,
  PRIMARY KEY (day, channel)
);
```

---

## 11. MODERATION

```sql
CREATE TYPE report_reason AS ENUM (
  'expired','wrong_deadline','wrong_eligibility','broken_link','possible_scam','requires_payment',
  'duplicate','incorrect_info','spam','harassment','impersonation','inappropriate','other');

CREATE TABLE reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id uuid REFERENCES users(id),
  reporter_fingerprint text,          -- for logged-out reports
  subject_type text NOT NULL,         -- opportunity|project|profile|team|message|organisation
  subject_id   uuid NOT NULL,
  reason       report_reason NOT NULL,
  detail       text CHECK (char_length(detail) <= 1000),
  state        text NOT NULL DEFAULT 'open',  -- open|actioned|dismissed|duplicate
  priority     smallint DEFAULT 5,
  resolved_by  uuid REFERENCES users(id),
  resolved_at  timestamptz,
  outcome_note text,
  created_at   timestamptz DEFAULT now()
);
CREATE INDEX ON reports (state, priority, created_at);

CREATE TABLE moderation_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id),
  action       text NOT NULL,         -- publish|reject|unpublish|merge|restrict_user|suspend_user|delete_content|verify_org
  subject_type text NOT NULL,
  subject_id   uuid NOT NULL,
  reason       text,
  metadata     jsonb,
  created_at   timestamptz DEFAULT now()
);

CREATE TABLE review_queue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue        text NOT NULL,   -- 'extraction'|'low_confidence'|'paid_cost'|'duplicate'|'org_claim'|'report'|'ugc'
  subject_type text NOT NULL,
  subject_id   uuid NOT NULL,
  priority     smallint DEFAULT 5,
  state        text DEFAULT 'open',
  claimed_by   uuid REFERENCES users(id),
  claimed_at   timestamptz,
  created_at   timestamptz DEFAULT now()
);

CREATE TABLE rate_limit_counters (
  key        text PRIMARY KEY,     -- 'user:<uuid>:team_request:2026-09-12'
  count      int DEFAULT 0,
  expires_at timestamptz NOT NULL
);
```

---

## 12. ANALYTICS AND OPS

```sql
CREATE TABLE events (                  -- first-party only, no PII
  id          bigserial PRIMARY KEY,
  ts          timestamptz DEFAULT now(),
  name        text NOT NULL,
  user_id     uuid,                    -- null when logged out
  anon_id     text,                    -- rotating, non-identifying
  country_iso2 char(2),
  props       jsonb DEFAULT '{}'
);
CREATE INDEX ON events (name, ts);

CREATE TABLE event_rollups_daily (     -- events older than 30 days roll up here, then are deleted
  day date, name text, country_iso2 char(2), count int,
  PRIMARY KEY (day, name, country_iso2)
);

CREATE TABLE ai_usage (
  id bigserial PRIMARY KEY,
  ts timestamptz DEFAULT now(),
  provider text, model text, purpose text,
  tokens_in int, tokens_out int, latency_ms int,
  ok boolean, error_code text
);

CREATE TABLE feature_flags (
  key text PRIMARY KEY,
  enabled boolean DEFAULT false,
  condition_sql text,                  -- optional density-floor condition
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE admin_audit_log (
  id bigserial PRIMARY KEY,
  ts timestamptz DEFAULT now(),
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL,
  subject_type text, subject_id uuid,
  before jsonb, after jsonb,
  ip_hash text
);
```

---

## 13. DERIVED VALUES (not stored)

Computed at read time or in a view: deadline state (§11.3 of `PRODUCT_SPEC.md`), eligibility verdict, density-floor booleans, team open-slot count, profile completeness percentage.

**Never stored as a column:** eligibility verdict (depends on the viewer), deadline state (depends on `now()`).

---

## 14. STORAGE FOOTPRINT (Supabase free tier: 500 MB)

| Table | Rows @ 12mo | Bytes/row | Total |
|---|---|---|---|
| opportunities | 8,000 | ~4 KB | 32 MB |
| opportunity embeddings (384-dim `halfvec`) | 8,000 | 768 B | 6 MB |
| eligibility_rules | 48,000 | ~400 B | 19 MB |
| raw_documents (`text_raw` retained) | 20,000 | ~8 KB | **160 MB** |
| users + profiles + eligibility | 5,000 | ~2 KB | 10 MB |
| tracker/intents/teams/projects | 40,000 | ~500 B | 20 MB |
| events (30-day window) | 600,000 | ~200 B | 120 MB |
| everything else | — | — | ~40 MB |
| **Total** | | | **~407 MB** |

**Mitigations, required from day one `[TD]`:**
- `raw_documents.text_raw` is truncated to 40 KB and **moved to R2 after 90 days**, leaving a key reference. This is the largest single consumer.
- `events` roll up daily and are deleted after 30 days.
- Embeddings use `halfvec(384)` (2 bytes/dim) rather than `vector(384)`.
- Migration trigger: at 400 MB, move `raw_documents` and `events` to R2/external entirely. See `FREE_INFRASTRUCTURE.md` §Growth.

---

## 15. ROW-LEVEL SECURITY (Supabase RLS) `[TD]`

RLS **enabled on every table**. Summary policies:

| Table | Anonymous | Owner | Other user | Admin |
|---|---|---|---|---|
| `opportunities` | SELECT where `status='published'` | — | same | ALL |
| `organisations` | SELECT where not suspended | org members UPDATE | same | ALL |
| `profiles` | SELECT where `visibility='public'` | ALL own | SELECT if `public`, or `discoverable_in_rooms` **and** a shared active intent exists | ALL |
| `eligibility_profiles` | none | ALL own | **none, ever** | none (admins cannot read; see `PRIVACY_AND_COMPLIANCE.md`) |
| `tracker_entries`, `notifications` | none | ALL own | none | none |
| `intents` | none | ALL own | SELECT if same `opportunity_id` and both intents active | ALL |
| `teams`, `team_requests` | SELECT teams where opportunity published and team state public | owner ALL | members SELECT; requesters SELECT own request | ALL |
| `projects` | SELECT where `visibility='public'` | ALL own | members SELECT | ALL |
| `messages` | none | participants only | none | flagged rows only |
| `reports` | INSERT only | SELECT own | none | ALL |

**Hard invariant `[PR]`:** `eligibility_profiles` is readable by exactly one principal — the owning user. Admin roles have no read path. Eligibility evaluation runs in a security-definer function that returns only a verdict, never the inputs.
