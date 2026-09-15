-- The country × category matrix and the counts behind it. SEO.md §2, UX_FLOWS.md §13.
--
-- Three things are asserted here, and each one has a wrong answer that looks right from the page:
--
--   A count that disagrees with the list under it. The page says "12 open to Malawi" and shows
--   nine, which is precisely the thin, untrustworthy content SEO.md §6 is about. So the count
--   functions and the list predicate are asserted against the same fixtures.
--
--   A region-scoped opportunity that no country filter can see. `expand_regions()` existed from
--   0012 and nothing called it: a call open to Southern Africa carried whatever country list the
--   model returned, and `eligible_countries` is what every filter reads. The trigger in 0024
--   fixes it, and the assertions below are the proof that it does.
--
--   A cell that crosses the five-item floor. The floor lives in TypeScript (one place, read by
--   the route and the sitemap), so what is asserted here is the COUNT it decides on.

\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION assert_eq(label text, actual anyelement, expected anyelement)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL  %: expected %, got %', label, expected, actual;
  END IF;
  RAISE NOTICE 'PASS  %', label;
END $$;

-- ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * The counts before anything is inserted, so every assertion below is a DELTA.
 *
 * This suite shares a database with the ones that commit their fixtures, and an absolute count
 * here would be an assertion about whatever else ran today. That exact failure has already
 * happened once in supabase/tests/admin.sql.
 */
CREATE TEMP TABLE baseline AS
  SELECT iso2, open_count, specific_count FROM country_open_counts();

CREATE TEMP TABLE baseline_cells AS
  SELECT iso2, category_code, open_count FROM country_category_counts(NULL);

CREATE OR REPLACE FUNCTION base_open(p_iso2 char(2)) RETURNS int LANGUAGE sql AS
  $$ SELECT coalesce((SELECT open_count FROM baseline WHERE iso2 = p_iso2), 0) $$;
CREATE OR REPLACE FUNCTION base_specific(p_iso2 char(2)) RETURNS int LANGUAGE sql AS
  $$ SELECT coalesce((SELECT specific_count FROM baseline WHERE iso2 = p_iso2), 0) $$;
CREATE OR REPLACE FUNCTION base_cell(p_iso2 char(2), p_code text) RETURNS int LANGUAGE sql AS
  $$ SELECT coalesce((SELECT open_count FROM baseline_cells WHERE iso2 = p_iso2 AND category_code = p_code), 0) $$;

INSERT INTO organisations (id, name, slug) VALUES
  ('e1000000-0000-0000-0000-000000000001', 'A Matrix Host', 'a-matrix-host');

/**
 * Five hackathons open to Zimbabwe by name (the floor exactly), one open Africa-wide, one open
 * only to Kenya, one region-scoped to Southern Africa, one expired and one draft.
 *
 * The last two are the ones that make the counts worth asserting: an expired or unpublished
 * record must not be counted anywhere, and both are easy to include by accident.
 */
INSERT INTO opportunities
  (id, slug, title, organisation_id, category_id, status, cost, source_url, last_verified_at,
   deadline_at, eligibility_scope, eligible_countries, region_codes)
SELECT ('e2000000-0000-0000-0000-00000000000' || n)::uuid,
       'matrix-zw-' || n,
       'Zimbabwe hackathon ' || n,
       'e1000000-0000-0000-0000-000000000001',
       (SELECT id FROM categories WHERE code = 'hackathon'),
       'published', 'free', 'https://example.invalid/m', now(),
       now() + interval '30 days',
       'country_list', ARRAY['ZW']::char(2)[], '{}'::text[]
  FROM generate_series(1, 5) AS n;

INSERT INTO opportunities
  (id, slug, title, organisation_id, category_id, status, cost, source_url, last_verified_at,
   deadline_at, eligibility_scope, eligible_countries, region_codes)
VALUES
  ('e2000000-0000-0000-0000-000000000010', 'matrix-continental', 'Continental grant',
   'e1000000-0000-0000-0000-000000000001', (SELECT id FROM categories WHERE code = 'grant'),
   'published', 'free', 'https://example.invalid/m', now(), now() + interval '40 days',
   'africa_wide', '{}'::char(2)[], '{}'::text[]),
  ('e2000000-0000-0000-0000-000000000011', 'matrix-kenya-only', 'Kenya only fellowship',
   'e1000000-0000-0000-0000-000000000001', (SELECT id FROM categories WHERE code = 'fellowship'),
   'published', 'free', 'https://example.invalid/m', now(), now() + interval '40 days',
   'country_list', ARRAY['KE']::char(2)[], '{}'::text[]),
  ('e2000000-0000-0000-0000-000000000012', 'matrix-southern', 'Southern Africa bootcamp',
   'e1000000-0000-0000-0000-000000000001', (SELECT id FROM categories WHERE code = 'bootcamp'),
   'published', 'free', 'https://example.invalid/m', now(), now() + interval '40 days',
   'region', '{}'::char(2)[], ARRAY['southern_africa']::text[]),
  ('e2000000-0000-0000-0000-000000000013', 'matrix-expired', 'Closed hackathon',
   'e1000000-0000-0000-0000-000000000001', (SELECT id FROM categories WHERE code = 'hackathon'),
   'published', 'free', 'https://example.invalid/m', now(), now() - interval '1 day',
   'country_list', ARRAY['ZW']::char(2)[], '{}'::text[]),
  ('e2000000-0000-0000-0000-000000000014', 'matrix-draft', 'Unpublished hackathon',
   'e1000000-0000-0000-0000-000000000001', (SELECT id FROM categories WHERE code = 'hackathon'),
   'draft', 'free', 'https://example.invalid/m', now(), now() + interval '30 days',
   'country_list', ARRAY['ZW']::char(2)[], '{}'::text[]);

-- ── The region expansion, which nothing did before 0024 ─────────────────────

-- The expansion uses OUR regions table and nothing else. This dataset follows the UN M49
-- subregions, where `southern_africa` is Botswana, Lesotho, Namibia, Eswatini and South Africa —
-- Zimbabwe and Zambia are `eastern_africa`. That is exactly why AI_SYSTEM.md §5 insists region
-- words are expanded "from our own regions table" rather than by a model: a model asked to list
-- Southern Africa would include Zimbabwe, and the answer has to match the table the filters read.
SELECT assert_eq('a region scope is expanded to its countries on write',
  (SELECT 'ZA' = ANY (eligible_countries) FROM opportunities
    WHERE id = 'e2000000-0000-0000-0000-000000000012'), true);

SELECT assert_eq('and to every other member of that region',
  (SELECT 'BW' = ANY (eligible_countries) AND 'LS' = ANY (eligible_countries)
     AND 'NA' = ANY (eligible_countries) AND 'SZ' = ANY (eligible_countries)
     FROM opportunities WHERE id = 'e2000000-0000-0000-0000-000000000012'), true);

SELECT assert_eq('to exactly the members our own table names, and no others',
  (SELECT array_length(eligible_countries, 1) FROM opportunities
    WHERE id = 'e2000000-0000-0000-0000-000000000012'), 5);

SELECT assert_eq('so a country the table does not put in that region is not included',
  (SELECT 'ZW' = ANY (eligible_countries) FROM opportunities
    WHERE id = 'e2000000-0000-0000-0000-000000000012'), false);

-- A country named explicitly AND a region: the union, because dropping either would narrow what
-- the source said.
UPDATE opportunities
   SET eligible_countries = ARRAY['KE']::char(2)[]
 WHERE id = 'e2000000-0000-0000-0000-000000000012';

SELECT assert_eq('an explicit country outside the region survives the expansion',
  (SELECT 'KE' = ANY (eligible_countries) AND 'ZA' = ANY (eligible_countries)
     FROM opportunities WHERE id = 'e2000000-0000-0000-0000-000000000012'), true);

-- An africa_wide record must NOT be given a country list: 0012's validator deliberately empties
-- it, because a list of five under "open to all of Africa" reads as narrower than the truth.
UPDATE opportunities SET region_codes = ARRAY['southern_africa']::text[]
 WHERE id = 'e2000000-0000-0000-0000-000000000010';

SELECT assert_eq('an africa_wide record keeps an empty country list',
  (SELECT coalesce(array_length(eligible_countries, 1), 0) FROM opportunities
    WHERE id = 'e2000000-0000-0000-0000-000000000010'), 0);

-- ── The predicate every new surface shares ──────────────────────────────────

SELECT assert_eq('africa_wide is open to everyone',
  open_to_country('africa_wide'::eligibility_scope, '{}'::char(2)[], 'ZW'), true);
SELECT assert_eq('global is open to everyone',
  open_to_country('global'::eligibility_scope, '{}'::char(2)[], 'MW'), true);
SELECT assert_eq('a country list matches the country in it',
  open_to_country('country_list'::eligibility_scope, ARRAY['ZW','ZM']::char(2)[], 'ZM'), true);
SELECT assert_eq('and not one that is absent',
  open_to_country('country_list'::eligibility_scope, ARRAY['ZW','ZM']::char(2)[], 'KE'), false);
SELECT assert_eq('a null country is not a filter at all',
  open_to_country('country_list'::eligibility_scope, ARRAY['ZW']::char(2)[], NULL), true);

-- ── The counts the pages publish ────────────────────────────────────────────

DO $$
DECLARE zw record; ke record; mw record; za record;
BEGIN
  SELECT * INTO zw FROM country_open_counts() WHERE iso2 = 'ZW';
  SELECT * INTO ke FROM country_open_counts() WHERE iso2 = 'KE';
  SELECT * INTO mw FROM country_open_counts() WHERE iso2 = 'MW';
  SELECT * INTO za FROM country_open_counts() WHERE iso2 = 'ZA';

  -- Zimbabwe: five records naming it, plus the continental grant. NOT the region-scoped one
  -- (Zimbabwe is not in this table's southern_africa), NOT the Kenya-only one, NOT the expired
  -- one and NOT the draft. Exactly six, as a delta from the baseline.
  PERFORM assert_eq('a country counts what names it plus what is open to everyone',
                    zw.open_count - base_open('ZW'), 6);
  PERFORM assert_eq('and reports separately how much of that names it',
                    zw.specific_count - base_specific('ZW'), 5);

  -- South Africa: the continental grant, plus the region-scoped one the trigger expanded to it.
  PERFORM assert_eq('a region-scoped record counts for the countries in that region',
                    za.open_count - base_open('ZA'), 2);

  PERFORM assert_eq('a country with nothing of its own still has the continental set',
                    mw.open_count - base_open('MW'), 1);
  PERFORM assert_eq('and says so by reporting zero of its own',
                    mw.specific_count - base_specific('MW'), 0);

  -- Kenya: its own fellowship, the continental grant, and the region-scoped record after the
  -- explicit country was added to it above.
  PERFORM assert_eq('a country named by a record counts it', ke.specific_count - base_specific('KE'), 2);

  -- SEO.md §2: all 54, regardless.
  PERFORM assert_eq('every African country has a row', (SELECT count(*) FROM country_open_counts()), 54::bigint);
END $$;

DO $$
DECLARE hack record; cells int;
BEGIN
  SELECT * INTO hack FROM country_category_counts('ZW') WHERE category_code = 'hackathon';
  PERFORM assert_eq('the matrix counts the cell that is at the floor',
                    hack.open_count - base_cell('ZW', 'hackathon'), 5);

  SELECT count(*) INTO cells FROM country_category_counts('ZW');
  PERFORM assert_eq('and returns a row per category with anything in it', cells >= 2, true);

  -- A cell with nothing in it is absent rather than zero: the route treats "no row" and "below
  -- the floor" identically, and an empty row would be a page that redirects.
  PERFORM assert_eq('a category with nothing open to this country has no cell',
    (SELECT count(*) FROM country_category_counts('ZW') WHERE category_code = 'scholarship'), 0::bigint);

  -- Null means every country, which is what the sitemap reads.
  PERFORM assert_eq('the whole matrix comes back when no country is given',
    (SELECT count(*) > 20 FROM country_category_counts(NULL)), true);
END $$;

SELECT assert_eq('a category with nothing open reports zero rather than disappearing',
  (SELECT open_count FROM category_open_counts() WHERE code = 'scholarship'), 0);

SELECT assert_eq('and one with something open reports it',
  (SELECT open_count >= 5 FROM category_open_counts() WHERE code = 'hackathon'), true);

SELECT assert_eq('the bootcamp cell exists for a country the region expansion reached',
  (SELECT count(*) FROM country_category_counts('ZA') WHERE category_code = 'bootcamp'), 1::bigint);

SELECT assert_eq('every active category has a row, so the index can never be partial',
  (SELECT count(*) FROM category_open_counts()),
  (SELECT count(*) FROM categories WHERE is_active));

-- ── Organisations active in a country ───────────────────────────────────────

SELECT assert_eq('an organisation with something open to the country is listed',
  (SELECT count(*) FROM country_organisations('ZW') WHERE slug = 'a-matrix-host'), 1::bigint);

-- Six: the five naming Zimbabwe and the continental grant. The expired and the draft are not
-- "active" work, and a directory of the dormant is what the incumbents already have.
SELECT assert_eq('with the number it has open there, counting neither the expired nor the draft',
  (SELECT open_count FROM country_organisations('ZW') WHERE slug = 'a-matrix-host'), 6);

ROLLBACK;
