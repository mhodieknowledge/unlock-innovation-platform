-- 0014 (down)

DROP FUNCTION IF EXISTS closing_soon_for_country(char(2), int);
DROP FUNCTION IF EXISTS active_users_for_recommendations(int);
DROP FUNCTION IF EXISTS replace_user_recommendations(uuid, jsonb);
DROP FUNCTION IF EXISTS recommendation_candidates(uuid, int);
DROP FUNCTION IF EXISTS search_candidates(text, halfvec, uuid, char(2), text, text, text, text, boolean, int);

DROP TABLE IF EXISTS user_recommendations;

-- opportunities_embedding_idx belongs to 0005 and is left alone.
DROP INDEX IF EXISTS profiles_embedding_idx;

-- Restore 0005's trigger function and trigger, then rebuild the vectors with it, so a
-- rollback leaves search in the state 0005 established rather than half-migrated.
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

DROP TRIGGER IF EXISTS opportunities_search_vector ON opportunities;
CREATE TRIGGER opportunities_search_vector
  BEFORE INSERT OR UPDATE OF title, summary, organisation_id ON opportunities
  FOR EACH ROW EXECUTE FUNCTION opportunities_search_vector_update();

UPDATE opportunities SET title = title WHERE true;

DROP TEXT SEARCH CONFIGURATION IF EXISTS mbele_search;
