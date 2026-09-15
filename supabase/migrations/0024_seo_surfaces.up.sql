-- 0024 the country × category matrix, and the counts the SEO surfaces are built on
--
-- SEO.md §2 is the growth engine: "a `/countries/[slug]/[category]` page is generated and
-- indexed only when it holds >= 5 currently-open opportunities. Below that, the route
-- 301-redirects to `/countries/[slug]`." UX_FLOWS.md §13 adds the country page's own states:
-- healthy, thin (fewer than 10 open), and empty.
--
-- All three need the same thing the product has never had: a COUNT of what is open to a
-- country, and per category. Counting in the request tier would mean fetching every matching
-- row to length-check it, so the counts live here. The lists the pages render use the same
-- predicate, because a page saying "12 open to Malawi" above nine rows is exactly the thin,
-- untrustworthy content SEO.md §6 is written to avoid.

/**
 * Is this opportunity open to this country?
 *
 * The one definition. The same expression is currently inlined in five places — 0011's digest,
 * 0014's `search_candidates` and `recommendation_candidates`, 0014's `country_matches`, and
 * 0018's `project_match_candidates` — and every new surface in this migration calls this
 * instead. The five predate it and are semantically identical; this is the one to converge on,
 * and a sixth copy would have been the sixth drift bug in this codebase's history.
 *
 * What it deliberately does NOT consider:
 *
 *   `excluded_countries`. Discovery is coarse and the VERDICT is exact: an opportunity open to
 *   Africa except Egypt is still open to Africa, and an Egyptian reader gets `not_eligible`
 *   from the rules engine with the sentence that says so. Filtering it out of discovery would
 *   hide the record from the one person who most needs to see why it is not for them.
 *
 *   `region_codes`. Not because regions do not matter, but because they are resolved on the
 *   way IN by the trigger below, into the country array this reads. One expansion at write
 *   time beats an expansion in every query.
 */
CREATE OR REPLACE FUNCTION open_to_country(
  p_scope eligibility_scope,
  p_eligible char(2)[],
  p_country char(2)
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_country IS NULL
      OR p_scope IN ('africa_wide', 'global')
      OR btrim(p_country) = ANY (SELECT btrim(c) FROM unnest(coalesce(p_eligible, '{}'::char(2)[])) AS c)
$$;

COMMENT ON FUNCTION open_to_country(eligibility_scope, char(2)[], char(2)) IS
  'THE country-scope predicate for discovery. Coarse by design: exclusions are the verdict''s job, not the filter''s.';

/**
 * A `region` scope becomes countries at write time. AI_SYSTEM.md §5 post-validation rule 2:
 * "Region words -> country arrays from our own regions table."
 *
 * `expand_regions()` has existed since 0012 and nothing called it, which left a real hole: an
 * opportunity extracted as `eligibility_scope = 'region'` with `region_codes = {southern_africa}`
 * carried whatever country list the model happened to return — often none — and every country
 * filter in the product reads `eligible_countries`. So a Southern-African call was invisible to
 * Zimbabwe, Zambia, Botswana and the rest of the region it was explicitly open to.
 *
 * Fixed here rather than in each query, and as a UNION rather than a replacement: a record can
 * legitimately name a region AND a country outside it, and dropping either would narrow what
 * the source said.
 */
CREATE OR REPLACE FUNCTION opportunities_expand_region_countries()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.region_codes IS NULL OR array_length(NEW.region_codes, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only for a scope where a region means "these countries". Under africa_wide or global the
  -- country array is deliberately empty (packages/ingest/src/validate.mjs drops it), and
  -- filling it in here would undo that with a list that means the same thing but reads as
  -- narrower.
  IF NEW.eligibility_scope NOT IN ('region', 'country_list') THEN
    RETURN NEW;
  END IF;

  NEW.eligible_countries := ARRAY(
    SELECT DISTINCT c
      FROM unnest(coalesce(NEW.eligible_countries, '{}'::char(2)[]) || expand_regions(NEW.region_codes)) AS c
     WHERE c IS NOT NULL
     ORDER BY c
  );

  RETURN NEW;
END
$$;

CREATE TRIGGER opportunities_expand_region_countries
  BEFORE INSERT OR UPDATE OF region_codes, eligibility_scope, eligible_countries ON opportunities
  FOR EACH ROW EXECUTE FUNCTION opportunities_expand_region_countries();

-- Backfill. Every region-scoped record written before this trigger existed is still carrying
-- whatever country list it was given, which for most of them is none.
UPDATE opportunities SET region_codes = region_codes
 WHERE eligibility_scope IN ('region', 'country_list')
   AND array_length(region_codes, 1) IS NOT NULL;

/**
 * What is open, per country. SEO.md §2: "Country pages themselves are generated for all 54
 * regardless, because Africa-wide and global opportunities give every country real content."
 *
 * So every African country comes back, including the ones with nothing of their own — the
 * page's job is to be honest about the difference, and UX_FLOWS.md §13 gives it the words:
 * "3 open to Malawi, plus 180 Africa-wide".
 *
 * `specific_count` is what names the country explicitly; `open_count` is everything a reader
 * there can enter. The two are separate because the page says both, and computing the second
 * by adding two queries in the request tier is how they come to disagree.
 */
CREATE OR REPLACE FUNCTION country_open_counts()
RETURNS TABLE (
  iso2 char(2),
  name text,
  slug text,
  region text,
  open_count int,
  specific_count int,
  soonest_deadline timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH live AS (
    SELECT o.eligibility_scope, o.eligible_countries, o.deadline_at
      FROM opportunities o
     WHERE o.status = 'published'
       AND o.deleted_at IS NULL
       AND o.duplicate_of IS NULL
       AND (o.deadline_at IS NULL OR o.deadline_at > now())
  )
  SELECT c.iso2,
         c.name,
         c.slug,
         c.region,
         count(l.*)::int,
         count(l.*) FILTER (
           WHERE btrim(c.iso2) = ANY (SELECT btrim(x) FROM unnest(l.eligible_countries) AS x)
         )::int,
         min(l.deadline_at)
    FROM countries c
    LEFT JOIN live l ON open_to_country(l.eligibility_scope, l.eligible_countries, c.iso2)
   WHERE c.is_african
   GROUP BY c.iso2, c.name, c.slug, c.region
   ORDER BY c.name
$$;

/**
 * The matrix, as counts. One row per (country, category) cell that holds anything at all.
 *
 * The 5-item floor is NOT applied here. It lives in packages/config — `SEO_MATRIX_FLOOR` — and
 * is applied by the two callers that need it, the matrix route and the sitemap, because they
 * have to agree with each other and a number in two places does not. What this returns is the
 * truth; what to do below five is a policy.
 *
 * `p_iso2` null returns every cell, for the sitemap; one country returns its own row set, for
 * the country page's category list.
 */
CREATE OR REPLACE FUNCTION country_category_counts(p_iso2 char(2) DEFAULT NULL)
RETURNS TABLE (
  iso2 char(2),
  country_name text,
  country_slug text,
  category_code text,
  category_name text,
  category_slug text,
  open_count int
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT c.iso2,
         c.name,
         c.slug,
         cat.code,
         cat.name,
         cat.slug,
         count(*)::int
    FROM opportunities o
    JOIN categories cat ON cat.id = o.category_id
    JOIN countries c ON c.is_african
     AND (p_iso2 IS NULL OR c.iso2 = p_iso2)
     AND open_to_country(o.eligibility_scope, o.eligible_countries, c.iso2)
   WHERE o.status = 'published'
     AND o.deleted_at IS NULL
     AND o.duplicate_of IS NULL
     AND (o.deadline_at IS NULL OR o.deadline_at > now())
     AND cat.is_active
   GROUP BY c.iso2, c.name, c.slug, cat.code, cat.name, cat.slug
   ORDER BY count(*) DESC, cat.name
$$;

/** Per category, across every country. The `/categories` index, and its sitemap. */
CREATE OR REPLACE FUNCTION category_open_counts()
RETURNS TABLE (
  code text,
  name text,
  slug text,
  open_count int,
  soonest_deadline timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT cat.code,
         cat.name,
         cat.slug,
         count(o.*)::int,
         min(o.deadline_at)
    FROM categories cat
    LEFT JOIN opportunities o
      ON o.category_id = cat.id
     AND o.status = 'published'
     AND o.deleted_at IS NULL
     AND o.duplicate_of IS NULL
     AND (o.deadline_at IS NULL OR o.deadline_at > now())
   WHERE cat.is_active
   GROUP BY cat.code, cat.name, cat.slug, cat.sort_order
   ORDER BY cat.sort_order
$$;

/**
 * Organisations running something open to a country. UX_FLOWS.md §13's "organisations active
 * there".
 *
 * An organisation with nothing open is not "active there", so this is an inner join and not a
 * list of everyone we have ever recorded — an ecosystem page that lists dormant organisations
 * is a directory, and a directory of the dormant is what the incumbents already have.
 */
CREATE OR REPLACE FUNCTION country_organisations(p_iso2 char(2), p_limit int DEFAULT 12)
RETURNS TABLE (
  slug text,
  name text,
  verification org_verification,
  open_count int
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT g.slug, g.name, g.verification, count(*)::int
    FROM opportunities o
    JOIN organisations g ON g.id = o.organisation_id AND g.deleted_at IS NULL
   WHERE o.status = 'published'
     AND o.deleted_at IS NULL
     AND o.duplicate_of IS NULL
     AND (o.deadline_at IS NULL OR o.deadline_at > now())
     AND open_to_country(o.eligibility_scope, o.eligible_countries, p_iso2)
   GROUP BY g.slug, g.name, g.verification
   ORDER BY count(*) DESC, g.name
   LIMIT greatest(1, least(coalesce(p_limit, 12), 50))
$$;

GRANT EXECUTE ON FUNCTION open_to_country(eligibility_scope, char(2)[], char(2)) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION country_open_counts() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION country_category_counts(char(2)) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION category_open_counts() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION country_organisations(char(2), int) TO anon, authenticated;
