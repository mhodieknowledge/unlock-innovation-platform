-- 0004 users, profiles, eligibility profiles, organisations
-- DATA_MODEL.md §2–3.
--
-- The two-layer profile model (PRODUCT_SPEC.md §16.1) is the whole point of this
-- migration: `profiles` is opt-in public, `eligibility_profiles` is private with
-- exactly ONE read principal — the owning user. No admin path exists. That is a
-- hard invariant (DATA_MODEL.md §15, SECURITY.md §2, ADMIN_SYSTEM.md §1).

CREATE TYPE profile_visibility AS ENUM ('private', 'discoverable_in_rooms', 'public');
CREATE TYPE account_state AS ENUM ('active', 'restricted', 'suspended', 'deleted', 'pending_age_review');
CREATE TYPE org_verification AS ENUM ('unclaimed', 'claimed_pending', 'verified', 'rejected', 'suspended');

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext UNIQUE,
  email_verified_at timestamptz,
  auth_provider     text,
  handle            citext UNIQUE,
  display_name      text CHECK (char_length(display_name) <= 80),
  is_admin          boolean NOT NULL DEFAULT false,
  admin_role        text CHECK (admin_role IN ('reviewer', 'moderator', 'superadmin')),
  account_state     account_state NOT NULL DEFAULT 'active',
  -- PRODUCT_SPEC.md §22.1: minimum account age is 18, self-asserted at signup.
  -- A false value must block every social surface (SYSTEM_ARCHITECTURE.md §11.3).
  age_confirmed_18  boolean NOT NULL DEFAULT false,
  timezone          text NOT NULL DEFAULT 'UTC',
  locale            text NOT NULL DEFAULT 'en',
  low_data_mode     boolean NOT NULL DEFAULT false,
  last_seen_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX users_last_seen_idx ON users (last_seen_at) WHERE deleted_at IS NULL;
CREATE INDEX users_admin_idx ON users (admin_role) WHERE is_admin;

-- PUBLIC layer. Opt-in, off by default (PRODUCT_SPEC.md §16.1).
CREATE TABLE profiles (
  user_id                     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  visibility                  profile_visibility NOT NULL DEFAULT 'private',
  headline                    text CHECK (char_length(headline) <= 120),
  bio                         text CHECK (char_length(bio) <= 1000),
  country_iso2                char(2) REFERENCES countries(iso2),
  -- Coarse and never geocoded (PRIVACY_AND_COMPLIANCE.md §1).
  city                        text CHECK (char_length(city) <= 80),
  github_url                  text,
  portfolio_url               text,
  other_url                   text,
  open_to                     text[] NOT NULL DEFAULT '{}',
  availability_hours_per_week smallint,
  -- SEO.md §1: a user who fills in a profile has not consented to being found on
  -- Google. Indexing is a separate, explicit opt-in.
  indexable                   boolean NOT NULL DEFAULT false,
  embedding                   halfvec(384),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profiles_visibility_idx ON profiles (visibility) WHERE visibility <> 'private';

-- PRIVATE layer. Never exposed to another user, at any visibility level, and
-- never sent to any AI provider (invariant 6, PRIVACY_AND_COMPLIANCE.md §2).
CREATE TABLE eligibility_profiles (
  user_id                     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  country_of_residence        char(2) REFERENCES countries(iso2),
  nationalities               char(2)[] NOT NULL DEFAULT '{}',
  -- Year only. PRIVACY_AND_COMPLIANCE.md §1 deliberately collects no full date
  -- of birth, which is why the engine treats boundary ages as `unclear`.
  birth_year                  smallint CHECK (birth_year BETWEEN 1900 AND 2100),
  student_status              text CHECK (student_status IN
                                ('not_student','secondary','undergraduate','postgraduate','recent_graduate')),
  year_of_study               smallint CHECK (year_of_study BETWEEN 1 AND 12),
  institution_name            text CHECK (char_length(institution_name) <= 200),
  institution_type            text CHECK (institution_type IN
                                ('university','polytechnic','secondary','bootcamp','none')),
  field_of_study              text CHECK (char_length(field_of_study) <= 200),
  years_experience            smallint CHECK (years_experience BETWEEN 0 AND 80),
  languages                   text[] NOT NULL DEFAULT '{}',
  -- Optional, self-declared, never inferred, used ONLY to evaluate a
  -- gender_restricted rule, never displayed (PRODUCT_SPEC.md §12.2).
  gender                      text,
  availability_hours_per_week smallint,
  available_from              date,
  available_until             date,
  can_travel                  boolean,
  has_valid_passport          boolean,
  remote_only                 boolean,
  skills                      uuid[] NOT NULL DEFAULT '{}',
  technologies                uuid[] NOT NULL DEFAULT '{}',
  interests                   uuid[] NOT NULL DEFAULT '{}',
  -- Deliberately NO embedding column. AI_SYSTEM.md §8: never embed eligibility
  -- profile fields. Matching uses the public profile's embedding instead.
  completeness                smallint NOT NULL DEFAULT 0 CHECK (completeness BETWEEN 0 AND 100),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE eligibility_profiles IS
  'Exactly one read principal: the owning user. No admin read path exists (DATA_MODEL.md §15). Never sent to an LLM (invariant 6).';

CREATE TABLE organisations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL CHECK (char_length(name) <= 200),
  slug           text UNIQUE NOT NULL,
  description    text CHECK (char_length(description) <= 4000),
  website_url    text,
  website_domain text,
  logo_key       text,
  country_iso2   char(2) REFERENCES countries(iso2),
  region_code    text REFERENCES regions(code),
  org_type       text CHECK (org_type IN
                   ('foundation','university','company','community','government','ngo','platform')),
  verification   org_verification NOT NULL DEFAULT 'unclaimed',
  verified_at    timestamptz,
  -- Feeds the auto-publish threshold: a proven source publishes at a lower
  -- confidence bar than an unproven one (OPPORTUNITY_INGESTION.md §3).
  trust_score    numeric(4,3) NOT NULL DEFAULT 0.500 CHECK (trust_score BETWEEN 0 AND 1),
  duplicate_of   uuid REFERENCES organisations(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX organisations_name_trgm_idx ON organisations USING gin (name gin_trgm_ops);
CREATE INDEX organisations_domain_idx ON organisations (website_domain);
CREATE INDEX organisations_verification_idx ON organisations (verification);

CREATE TABLE organisation_members (
  organisation_id uuid REFERENCES organisations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, user_id)
);

-- ── RLS. DATA_MODEL.md §15, SECURITY.md §2: default deny, enabled everywhere ──

ALTER TABLE users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE eligibility_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_members ENABLE ROW LEVEL SECURITY;

-- Helper: is the caller an admin? Used by policies below. SECURITY DEFINER so it
-- can read `users` without recursing into that table's own policies.
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND is_admin) $$;

CREATE POLICY users_self_read   ON users FOR SELECT USING (id = auth.uid() OR is_admin());
CREATE POLICY users_self_update ON users FOR UPDATE USING (id = auth.uid());

-- A profile is visible when public, or when discoverable-in-rooms AND the viewer
-- shares an active intent on the same opportunity. The intents half is added in
-- the migration that creates `intents`; until then the stricter rule applies.
CREATE POLICY profiles_public_read ON profiles FOR SELECT
  USING (visibility = 'public' OR user_id = auth.uid() OR is_admin());
CREATE POLICY profiles_own_write ON profiles FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- THE hard invariant. One policy, one principal, no admin clause. Note the
-- deliberate absence of `OR is_admin()` here — that omission is the control.
CREATE POLICY eligibility_profiles_owner_only ON eligibility_profiles FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY organisations_public_read ON organisations FOR SELECT
  USING (verification <> 'suspended' AND deleted_at IS NULL);
CREATE POLICY organisations_member_update ON organisations FOR UPDATE
  USING (EXISTS (SELECT 1 FROM organisation_members m
                  WHERE m.organisation_id = organisations.id AND m.user_id = auth.uid()));

CREATE POLICY organisation_members_read ON organisation_members FOR SELECT
  USING (user_id = auth.uid()
         OR EXISTS (SELECT 1 FROM organisation_members m2
                     WHERE m2.organisation_id = organisation_members.organisation_id
                       AND m2.user_id = auth.uid())
         OR is_admin());
