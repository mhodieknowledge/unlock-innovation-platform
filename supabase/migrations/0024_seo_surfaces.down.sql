-- Rolls 0024 back. Every object is new in this migration, so the rollback is drops only.
--
-- The region backfill is NOT undone. It widened `eligible_countries` on region-scoped records
-- to the countries those regions contain, which is what the source said in the first place;
-- narrowing them again would hide those records from the countries they are open to, and an
-- undo that loses correct data is not an undo worth having.

DROP TRIGGER IF EXISTS opportunities_expand_region_countries ON opportunities;
DROP FUNCTION IF EXISTS opportunities_expand_region_countries();

DROP FUNCTION IF EXISTS country_organisations(char(2), int);
DROP FUNCTION IF EXISTS category_open_counts();
DROP FUNCTION IF EXISTS country_category_counts(char(2));
DROP FUNCTION IF EXISTS country_open_counts();
DROP FUNCTION IF EXISTS open_to_country(eligibility_scope, char(2)[], char(2));
