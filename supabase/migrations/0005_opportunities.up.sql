-- 0005 sources, raw documents, opportunities, eligibility rules
-- DATA_MODEL.md §4–5. IMPLEMENTATION_PLAN.md §15 step 2.
--
-- Two invariants are enforced by the schema itself here, not by application
-- discipline:
--   Invariant 1  — never publish an opportunity without a source URL
--   Invariant 2  — never store an eligibility rule without a verbatim quote
-- Both are CHECK constraints, so a bad write path cannot bypass them.

CREATE TYPE source_kind AS ENUM (
  'rss','atom','json_api','sitemap','jsonld','html_page','manual',
  'org_submission','github_api','kaggle_api','eventbrite_api');
CREATE TYPE fetch_status AS ENUM (
  'ok','not_modified','fetch_error','parse_error','blocked','rate_limited');
CREATE TYPE opp_status AS ENUM (
  'draft','in_review','published','closed','expired','cancelled','rejected','merged');
CREATE TYPE opp_verification AS ENUM (
  'official','verified','auto','community_flagged','stale','expired','disputed');
CREATE TYPE participation_mode AS ENUM ('online','in_person','hybrid','unknown');
CREATE TYPE deadline_precision AS ENUM ('exact_time','date_only','month_only','rolling','unknown');
CREATE TYPE eligibility_scope AS ENUM ('country_list','region','africa_wide','global','unclear');
CREATE TYPE cost_kind AS ENUM ('free','paid','unknown');
CREATE TYPE rule_type AS ENUM (
  'country_in','country_not_in','nationality_in','residency_required',
  'age_between','student_status_in','year_of_study_in','institution_type_in',
  'experience_between','team_size_between','individual_only','team_only',
  'gender_restricted','language_required','cost','travel_required','other_unstructured');

-- ── Sources. OPPORTUNITY_INGESTION.md §3: managed entities, not code. ────────
CREATE TABLE sources (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  kind                 source_kind NOT NULL,
  url                  text NOT NULL,
  organisation_id      uuid REFERENCES organisations(id),
  cadence_minutes      int NOT NULL DEFAULT 720 CHECK (cadence_minutes >= 15),
  -- OPPORTUNITY_INGESTION.md §2.1 rule 1 and ADMIN_SYSTEM.md §5: a source whose
  -- robots.txt disallows our path cannot be enabled. Enforced below.
  robots_allowed       boolean,
  robots_checked_at    timestamptz,
  tos_url              text,
  tos_posture          text CHECK (tos_posture IN
                         ('permits_feeds','silent','restricts_automation','requires_permission')),
  legal_note           text,
  attribution_required boolean NOT NULL DEFAULT true,
  is_active            boolean NOT NULL DEFAULT false,
  trust_score          numeric(4,3) NOT NULL DEFAULT 0.500 CHECK (trust_score BETWEEN 0 AND 1),
  default_categories   uuid[] NOT NULL DEFAULT '{}',
  default_region       text REFERENCES regions(code),
  last_fetch_at        timestamptz,
  last_success_at      timestamptz,
  consecutive_failures int NOT NULL DEFAULT 0,
  etag                 text,
  last_modified        text,
  records_published    int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- A source cannot be active until robots has been checked AND allows us.
  -- README.md §6 item 3 keeps tier-6 activation a human decision; this makes the
  -- machine half of that unbypassable.
  CONSTRAINT sources_active_requires_robots_ok
    CHECK (NOT is_active OR (robots_allowed IS TRUE AND robots_checked_at IS NOT NULL)),
  -- A source whose ToS restricts automation may only be ingested via its feed
  -- (OPPORTUNITY_INGESTION.md §2.1 rule 9).
  CONSTRAINT sources_restricted_feeds_only
    CHECK (tos_posture IS DISTINCT FROM 'restricts_automation'
           OR kind IN ('rss','atom','json_api','org_submission','manual'))
);
CREATE INDEX sources_active_idx ON sources (is_active, last_fetch_at) WHERE is_active;

CREATE TABLE source_fetches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      fetch_status NOT NULL,
  http_status int,
  items_seen  int NOT NULL DEFAULT 0,
  items_new   int NOT NULL DEFAULT 0,
  error       text
);
CREATE INDEX source_fetches_source_idx ON source_fetches (source_id, started_at DESC);

CREATE TABLE raw_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES sources(id),
  source_fetch_id uuid REFERENCES source_fetches(id),
  url             text NOT NULL,
  canonical_url   text NOT NULL,
  content_hash    text NOT NULL,
  title_raw       text,
  -- Truncated to 40 KB by the pipeline: DATA_MODEL.md §14 names this the single
  -- largest storage consumer, archived to R2 after 90 days.
  text_raw        text,
  jsonld          jsonb,
  archived_key    text,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canonical_url, content_hash)
);
CREATE INDEX raw_documents_hash_idx ON raw_documents (content_hash);
CREATE INDEX raw_documents_fetched_idx ON raw_documents (fetched_at);

-- ── Opportunities ───────────────────────────────────────────────────────────
CREATE TABLE opportunities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  text UNIQUE NOT NULL,
  title                 text NOT NULL CHECK (char_length(title) <= 300),
  organisation_id       uuid REFERENCES organisations(id),
  -- OUR words, never a copy of the source. CONTENT_AND_LAUNCH.md §4 validates an
  -- 8-consecutive-word overlap check against the source at ingestion.
  summary               text CHECK (char_length(summary) <= 400),
  description_md        text,
  category_id           uuid NOT NULL REFERENCES categories(id),
  subcategory_ids       uuid[] NOT NULL DEFAULT '{}',
  tag_ids               uuid[] NOT NULL DEFAULT '{}',
  skill_ids             uuid[] NOT NULL DEFAULT '{}',
  technology_ids        uuid[] NOT NULL DEFAULT '{}',
  industry_ids          uuid[] NOT NULL DEFAULT '{}',

  -- geography
  eligibility_scope     eligibility_scope NOT NULL DEFAULT 'unclear',
  eligible_countries    char(2)[] NOT NULL DEFAULT '{}',
  excluded_countries    char(2)[] NOT NULL DEFAULT '{}',
  region_codes          text[] NOT NULL DEFAULT '{}',
  participation_mode    participation_mode NOT NULL DEFAULT 'unknown',
  venue_country_iso2    char(2) REFERENCES countries(iso2),
  venue_city            text,

  -- dates
  opens_at              timestamptz,
  deadline_at           timestamptz,
  deadline_precision    deadline_precision NOT NULL DEFAULT 'unknown',
  deadline_timezone     text,
  -- Always displayed when precision is coarser than exact_time
  -- (PRODUCT_SPEC.md §11.3), so the user sees what the source actually said.
  deadline_raw          text,
  starts_at             timestamptz,
  ends_at               timestamptz,
  is_rolling            boolean NOT NULL DEFAULT false,

  -- participation
  team_required         boolean,
  team_size_min         smallint CHECK (team_size_min >= 1),
  team_size_max         smallint CHECK (team_size_max >= 1),
  experience_level      text CHECK (experience_level IN ('beginner','intermediate','advanced','any')),

  -- value and cost
  prize_amount          numeric(14,2) CHECK (prize_amount >= 0),
  prize_currency        char(3),
  prize_description     text,
  funding_description   text,
  cost                  cost_kind NOT NULL DEFAULT 'unknown',
  cost_description      text,

  -- provenance
  source_id             uuid REFERENCES sources(id),
  raw_document_id       uuid REFERENCES raw_documents(id),
  source_url            text,
  official_url          text,
  apply_url             text,
  submitted_by_user_id  uuid REFERENCES users(id),

  -- state
  status                opp_status NOT NULL DEFAULT 'draft',
  verification          opp_verification NOT NULL DEFAULT 'auto',
  extraction_confidence numeric(4,3) CHECK (extraction_confidence BETWEEN 0 AND 1),
  last_verified_at      timestamptz,
  next_verify_at        timestamptz,
  link_ok               boolean,
  link_checked_at       timestamptz,
  duplicate_of          uuid REFERENCES opportunities(id),
  -- Aggregate only. NEVER shown to users as social proof (PRODUCT_SPEC.md §27,
  -- ANALYTICS.md §9). Invariant-adjacent: this product shows no vanity metrics.
  view_count            int NOT NULL DEFAULT 0,

  search_vector         tsvector,
  embedding             halfvec(384),

  published_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,

  -- INVARIANT 1: never publish an opportunity without a source URL. A published
  -- row must name where it came from — attribution is also PRODUCT_SPEC.md §8
  -- principle 9.
  CONSTRAINT opportunities_published_needs_source
    CHECK (status <> 'published' OR source_url IS NOT NULL OR official_url IS NOT NULL),

  -- INVARIANT 13: never publish an opportunity that charges a fee to apply.
  -- MODERATION_AND_TRUST.md §2.1 rule 1 is explicit that such a listing is
  -- rejected, not reviewed-and-approved. The database refuses it outright.
  CONSTRAINT opportunities_published_never_charges_to_apply
    CHECK (status <> 'published' OR cost <> 'paid'),

  CONSTRAINT opportunities_team_size_ordered
    CHECK (team_size_min IS NULL OR team_size_max IS NULL OR team_size_min <= team_size_max),

  -- A published record must carry the freshness date the UI always shows
  -- (MODERATION_AND_TRUST.md §1: "We never show a badge without a date").
  CONSTRAINT opportunities_published_needs_verified_at
    CHECK (status <> 'published' OR last_verified_at IS NOT NULL)
);

CREATE INDEX opportunities_search_idx ON opportunities USING gin (search_vector);
CREATE INDEX opportunities_eligible_countries_idx ON opportunities USING gin (eligible_countries);
CREATE INDEX opportunities_tags_idx ON opportunities USING gin (tag_ids);
CREATE INDEX opportunities_open_deadline_idx ON opportunities (deadline_at)
  WHERE status = 'published';
CREATE INDEX opportunities_embedding_idx ON opportunities
  USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX opportunities_next_verify_idx ON opportunities (next_verify_at)
  WHERE status = 'published';
CREATE INDEX opportunities_org_idx ON opportunities (organisation_id);
CREATE INDEX opportunities_category_idx ON opportunities (category_id);
CREATE INDEX opportunities_title_trgm_idx ON opportunities USING gin (title gin_trgm_ops);

-- ── Eligibility rules — the spine's storage ─────────────────────────────────
CREATE TABLE eligibility_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  rule_type      rule_type NOT NULL,
  params         jsonb NOT NULL DEFAULT '{}',

  -- INVARIANT 2: verbatim sentence from raw_documents.text_raw. NOT NULL is not
  -- sufficient on its own — a whitespace-only string would satisfy it — so the
  -- constraint requires real content. The engine independently refuses to count
  -- a quote-less rule as passing, giving two layers.
  source_quote   text NOT NULL CHECK (btrim(source_quote) <> ''),

  confidence     numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  -- Mirrors packages/eligibility/src/constants.ts HIGH_STAKES_RULE_TYPES. A
  -- generated column so the two cannot drift silently.
  is_high_stakes boolean GENERATED ALWAYS AS (
    rule_type IN ('country_in','country_not_in','nationality_in','age_between','student_status_in')
  ) STORED,
  reviewed_by    uuid REFERENCES users(id),
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eligibility_rules_opportunity_idx ON eligibility_rules (opportunity_id);

COMMENT ON COLUMN eligibility_rules.source_quote IS
  'Invariant 2. Verbatim, whitespace-normalised substring of the source document. Verified by substring match at ingestion, never by trusting the model (AI_SYSTEM.md §5).';

-- ── Change log and briefs ───────────────────────────────────────────────────
CREATE TABLE opportunity_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  field           text NOT NULL,
  old_value       jsonb,
  new_value       jsonb,
  changed_by      text NOT NULL,
  notify_trackers boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunity_changes_opp_idx ON opportunity_changes (opportunity_id, created_at DESC);

CREATE TABLE opportunity_briefs (
  opportunity_id    uuid PRIMARY KEY REFERENCES opportunities(id) ON DELETE CASCADE,
  theme             jsonb,
  deliverables      jsonb,
  judging_criteria  jsonb,
  key_dates         jsonb,
  prohibitions      jsonb,
  submission_format jsonb,
  generated_by      text,
  model             text,
  prompt_version    text,
  generated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Search vector maintenance ───────────────────────────────────────────────
-- SYSTEM_ARCHITECTURE.md §6.1 weighting: title A, org B, summary C, tags D.
CREATE OR REPLACE FUNCTION opportunities_search_vector_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE org_name text;
BEGIN
  SELECT name INTO org_name FROM organisations WHERE id = NEW.organisation_id;
  NEW.search_vector :=
      setweight(to_tsvector('simple', unaccent(coalesce(NEW.title, ''))), 'A')
   || setweight(to_tsvector('simple', unaccent(coalesce(org_name, ''))), 'B')
   || setweight(to_tsvector('simple', unaccent(coalesce(NEW.summary, ''))), 'C');
  RETURN NEW;
END
$$;

CREATE TRIGGER opportunities_search_vector
  BEFORE INSERT OR UPDATE OF title, summary, organisation_id ON opportunities
  FOR EACH ROW EXECUTE FUNCTION opportunities_search_vector_update();

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE sources             ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_fetches      ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_documents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities       ENABLE ROW LEVEL SECURITY;
ALTER TABLE eligibility_rules   ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_briefs  ENABLE ROW LEVEL SECURITY;

-- All opportunity content is public and readable logged out
-- (PRODUCT_SPEC.md §8 principle 3). Only published rows, though: an unpublished
-- record returns 404 for non-admins (API_SPEC.md §1.2).
CREATE POLICY opportunities_public_read ON opportunities FOR SELECT
  USING ((status = 'published' AND deleted_at IS NULL) OR is_admin());

-- Rules are readable exactly where their opportunity is, because a verdict
-- without its quotes would violate PRODUCT_SPEC.md §12.4.
CREATE POLICY eligibility_rules_public_read ON eligibility_rules FOR SELECT
  USING (EXISTS (SELECT 1 FROM opportunities o
                  WHERE o.id = eligibility_rules.opportunity_id
                    AND ((o.status = 'published' AND o.deleted_at IS NULL) OR is_admin())));

CREATE POLICY opportunity_changes_public_read ON opportunity_changes FOR SELECT
  USING (EXISTS (SELECT 1 FROM opportunities o
                  WHERE o.id = opportunity_changes.opportunity_id
                    AND ((o.status = 'published' AND o.deleted_at IS NULL) OR is_admin())));

CREATE POLICY opportunity_briefs_public_read ON opportunity_briefs FOR SELECT
  USING (EXISTS (SELECT 1 FROM opportunities o
                  WHERE o.id = opportunity_briefs.opportunity_id
                    AND ((o.status = 'published' AND o.deleted_at IS NULL) OR is_admin())));

-- Ingestion internals are operator-only. Source URLs and raw text are not user
-- content and exposing them adds nothing for a reader while widening the
-- surface. No anon policy: default deny applies.
CREATE POLICY sources_admin_read        ON sources        FOR SELECT USING (is_admin());
CREATE POLICY source_fetches_admin_read ON source_fetches FOR SELECT USING (is_admin());
CREATE POLICY raw_documents_admin_read  ON raw_documents  FOR SELECT USING (is_admin());
