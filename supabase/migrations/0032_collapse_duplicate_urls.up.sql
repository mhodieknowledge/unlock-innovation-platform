-- 0032 one opportunity per URL, and collapse the ones already written
--
-- The 18:38 run stored seventeen records, and eight of them were second copies:
-- `revenuecat-shipaton-2026-2`, `ai-builders-hackathon-2`, `nextstep-hacks-2026-2` and
-- the rest of the Devpost set, each arriving with "2 duplicate candidate(s)" already
-- attached to it.
--
-- §4.1 skips a URL "whose content hash we already hold", which is idempotent for a
-- document that sits still. A Devpost hackathon page does not: it shows a countdown and
-- a live registration count, so its text differs on every fetch, the hash never matches
-- and every three-hourly run wrote the whole set again. About seventy duplicates a day,
-- and the dedupe queue was noticing them without preventing them.
--
-- scripts/ingest.mjs now treats the URL as the identity and refreshes in place. This
-- migration is the other half: the copies already written.
--
-- WHICH COPY SURVIVES. The published one, then the oldest. A published row may already
-- be on the board, in someone's tracker, or linked from a sitemap, and keeping it means
-- none of that breaks. The losers are marked `merged` and pointed at the survivor
-- through duplicate_of, which is the vocabulary the schema already has for this and what
-- every read path already filters on — nothing is deleted, and an operator can see what
-- happened.

WITH ranked AS (
  SELECT id, source_url,
         first_value(id) OVER (
           PARTITION BY source_url
           ORDER BY (status = 'published') DESC, created_at ASC, id ASC
         ) AS keeper
    FROM opportunities
   WHERE source_url IS NOT NULL
     AND deleted_at IS NULL
     AND duplicate_of IS NULL
)
UPDATE opportunities o
   SET duplicate_of = r.keeper,
       status = 'merged',
       updated_at = now()
  FROM ranked r
 WHERE o.id = r.id
   AND r.keeper <> r.id;

-- Anything queued against a row that is now a duplicate is work nobody should be shown.
UPDATE review_queue q
   SET state = 'done'
  FROM opportunities o
 WHERE q.subject_type = 'opportunity'
   AND q.subject_id = o.id
   AND o.duplicate_of IS NOT NULL
   AND q.state <> 'done';

-- And make the state unrepresentable rather than merely cleaned up. A partial unique
-- index, so it constrains only the rows that are actually live: a merged copy keeps its
-- source_url, and so does a soft-deleted one.
CREATE UNIQUE INDEX IF NOT EXISTS opportunities_one_live_row_per_url
  ON opportunities (source_url)
  WHERE source_url IS NOT NULL AND deleted_at IS NULL AND duplicate_of IS NULL;
