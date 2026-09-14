-- 0005 sources, raw documents, opportunities, eligibility rules (down)

DROP TRIGGER IF EXISTS opportunities_search_vector ON opportunities;
DROP FUNCTION IF EXISTS opportunities_search_vector_update();

DROP TABLE IF EXISTS opportunity_briefs;
DROP TABLE IF EXISTS opportunity_changes;
DROP TABLE IF EXISTS eligibility_rules;
DROP TABLE IF EXISTS opportunities;
DROP TABLE IF EXISTS raw_documents;
DROP TABLE IF EXISTS source_fetches;
DROP TABLE IF EXISTS sources;

DROP TYPE IF EXISTS rule_type;
DROP TYPE IF EXISTS cost_kind;
DROP TYPE IF EXISTS eligibility_scope;
DROP TYPE IF EXISTS deadline_precision;
DROP TYPE IF EXISTS participation_mode;
DROP TYPE IF EXISTS opp_verification;
DROP TYPE IF EXISTS opp_status;
DROP TYPE IF EXISTS fetch_status;
DROP TYPE IF EXISTS source_kind;
