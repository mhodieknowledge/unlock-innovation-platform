-- 0002 reference and taxonomy
-- DATA_MODEL.md §1.
--
-- Extensibility rule [PR]: categories, skills, technologies, industries and tags
-- are LOOKUP TABLES, not enums. Adding one is a row insert, never a migration
-- and never a code change (PRODUCT_SPEC.md §11.1).

CREATE TABLE countries (
  iso2             char(2) PRIMARY KEY,
  iso3             char(3) NOT NULL,
  name             text NOT NULL,
  common_names     text[] NOT NULL DEFAULT '{}',
  region           text NOT NULL,
  is_african       boolean NOT NULL,
  slug             text UNIQUE NOT NULL,
  -- Seeding and promotion only. NEVER consulted by eligibility logic
  -- (PRODUCT_SPEC.md §4.2): all 54 countries are first-class from day one.
  priority_tier    smallint NOT NULL DEFAULT 3,
  timezone_default text,
  CONSTRAINT countries_priority_tier_range CHECK (priority_tier BETWEEN 1 AND 3)
);
CREATE INDEX countries_region_idx ON countries (region);
CREATE INDEX countries_is_african_idx ON countries (is_african);
CREATE INDEX countries_name_trgm_idx ON countries USING gin (name gin_trgm_ops);

COMMENT ON COLUMN countries.priority_tier IS
  'Content seeding and promotion only. Never used in eligibility evaluation (PRODUCT_SPEC.md §4.2).';

CREATE TABLE regions (
  code             text PRIMARY KEY,
  name             text NOT NULL,
  slug             text UNIQUE NOT NULL,
  member_countries char(2)[] NOT NULL DEFAULT '{}',
  is_african       boolean NOT NULL DEFAULT true,
  sort_order       int NOT NULL DEFAULT 100
);

CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE NOT NULL,
  name        text NOT NULL,
  slug        text UNIQUE NOT NULL,
  parent_id   uuid REFERENCES categories(id),
  description text,
  sort_order  int NOT NULL DEFAULT 100,
  is_active   boolean NOT NULL DEFAULT true
);
CREATE INDEX categories_parent_idx ON categories (parent_id);
CREATE INDEX categories_active_idx ON categories (is_active) WHERE is_active;

-- One table for skills, technologies, industries, themes and roles, keyed by
-- `kind`. DATA_MODEL.md §1.
CREATE TABLE tags (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind      text NOT NULL,
  code      text NOT NULL,
  name      text NOT NULL,
  slug      text NOT NULL,
  aliases   text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (kind, code),
  CONSTRAINT tags_kind_known
    CHECK (kind IN ('skill', 'technology', 'industry', 'theme', 'role'))
);
CREATE INDEX tags_kind_idx ON tags (kind) WHERE is_active;
CREATE UNIQUE INDEX tags_kind_slug_idx ON tags (kind, slug);
CREATE INDEX tags_name_trgm_idx ON tags USING gin (name gin_trgm_ops);

-- Reference data is world-readable: PRODUCT_SPEC.md §8 principle 3 requires all
-- opportunity, organisation and country content to be readable logged out, and
-- SECURITY.md §2 requires RLS on every table with default deny, so the
-- permission has to be granted explicitly rather than left implicit.
ALTER TABLE countries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE regions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags       ENABLE ROW LEVEL SECURITY;

CREATE POLICY countries_public_read  ON countries  FOR SELECT USING (true);
CREATE POLICY regions_public_read    ON regions    FOR SELECT USING (true);
CREATE POLICY categories_public_read ON categories FOR SELECT USING (is_active);
CREATE POLICY tags_public_read       ON tags       FOR SELECT USING (is_active);
