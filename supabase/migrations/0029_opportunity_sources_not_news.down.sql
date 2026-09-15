-- Reverses the registry change. The three news sources go back to active and the three
-- researched ones are removed.
--
-- Rows added by the up migration are deleted only if nothing has been ingested through
-- them: once a source has documents, deleting it would orphan or cascade real records,
-- and a down migration is not the place to decide that. If the delete is skipped the
-- source is deactivated instead, which has the same effect on a run.
UPDATE sources SET is_active = false
 WHERE url IN ('https://devpost.com/api/hackathons?status[]=open&status[]=upcoming',
               'https://youthopportunitieshub.com/feed/',
               'https://opportunitiesforyouth.org/feed/');

DELETE FROM sources s
 WHERE s.url IN ('https://devpost.com/api/hackathons?status[]=open&status[]=upcoming',
                 'https://youthopportunitieshub.com/feed/',
                 'https://opportunitiesforyouth.org/feed/')
   AND NOT EXISTS (SELECT 1 FROM raw_documents r WHERE r.source_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM source_fetches f WHERE f.source_id = s.id);

UPDATE sources SET is_active = true
 WHERE name IN ('TechCabal', 'Techpoint Africa', 'Disrupt Africa')
   AND robots_allowed IS TRUE AND robots_checked_at IS NOT NULL;

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_api_adapter_for_api_kinds;
ALTER TABLE sources DROP COLUMN IF EXISTS api_adapter;
