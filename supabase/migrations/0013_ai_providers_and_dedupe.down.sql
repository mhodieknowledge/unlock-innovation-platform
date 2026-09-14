-- 0013 (down)

DROP FUNCTION IF EXISTS merge_opportunities(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS dedupe_candidates_for(uuid);
DROP FUNCTION IF EXISTS record_dedupe_candidate(uuid, uuid, text, numeric);
DROP FUNCTION IF EXISTS ai_chain_for(text, boolean);

DROP TABLE IF EXISTS dedupe_candidates;
DROP TABLE IF EXISTS ai_providers;
