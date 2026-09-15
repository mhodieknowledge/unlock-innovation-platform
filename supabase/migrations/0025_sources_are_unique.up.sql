-- 0025 one row per source, enforced rather than assumed
--
-- `npm run db:seed` runs on every deploy, and .github/workflows/deploy.yml says why that is
-- safe: "Reference data is idempotent (every seed is ON CONFLICT DO NOTHING)". For countries,
-- categories, regions, tags, feature flags and AI providers that is true — each has a natural
-- key with a unique constraint behind it, so the second run conflicts and does nothing.
--
-- `sources` has no natural key. Its only unique thing is `id uuid PRIMARY KEY DEFAULT
-- gen_random_uuid()`, which is a different value on every insert, so the clause at the foot of
-- 006_source_registry.sql has nothing to conflict ON and suppresses nothing. `ON CONFLICT DO
-- NOTHING` without a target is not a no-op guard; it is a promise that only holds if some
-- constraint exists to break.
--
-- Eighteen deploys later, `SELECT count(*) FROM sources` returned 432 — the 24 researched
-- sources, eighteen times over. It surfaced as `npm run sources:check` reporting "432 source(s)
-- checked: 378 allowed by robots, 18 disallowed, 36 unreadable" and printing "Zindi
-- competitions" eighteen times in a row.
--
-- Nobody noticed because every copy was inactive, and an inactive source does nothing. The
-- moment one was activated it would have stopped being harmless: eighteen rows pointing at the
-- same feed are eighteen fetchers of that feed, and OPPORTUNITY_INGESTION.md §2.1 rule 4
-- promises one request per ten seconds per host. That promise is not ours to break by
-- accident.
--
-- So: collapse the duplicates, then make the state that caused them unrepresentable.

-- ── Collapse ────────────────────────────────────────────────────────────────
-- The survivor is the OLDEST row per URL, and deliberately so: it is the one any earlier
-- foreign key already points at, and the one whose id an operator may have written down.
CREATE TEMP TABLE source_survivors ON COMMIT DROP AS
SELECT DISTINCT ON (url) url, id AS keep_id
  FROM sources
 ORDER BY url, created_at, id;

-- Re-point every child before deleting anything. `source_fetches` cascades on delete and
-- `raw_documents` does not, so relying on the cascade would silently lose fetch history for
-- the copies and fail outright on the documents — and a migration that half-works is worse
-- than one that refuses.
UPDATE source_fetches f SET source_id = s.keep_id
  FROM sources o JOIN source_survivors s ON s.url = o.url
 WHERE f.source_id = o.id AND f.source_id <> s.keep_id;

UPDATE raw_documents d SET source_id = s.keep_id
  FROM sources o JOIN source_survivors s ON s.url = o.url
 WHERE d.source_id = o.id AND d.source_id <> s.keep_id;

UPDATE opportunities p SET source_id = s.keep_id
  FROM sources o JOIN source_survivors s ON s.url = o.url
 WHERE p.source_id = o.id AND p.source_id <> s.keep_id;

-- An activated copy means a person made a judgement about that source; carry it to the
-- survivor rather than discarding it with the row. Same for the robots finding, which cost a
-- request to obtain.
UPDATE sources keep SET
    is_active         = keep.is_active OR dup.is_active,
    tos_posture       = COALESCE(keep.tos_posture, dup.tos_posture),
    robots_allowed    = COALESCE(keep.robots_allowed, dup.robots_allowed),
    robots_checked_at = GREATEST(keep.robots_checked_at, dup.robots_checked_at)
  FROM (
    SELECT s.keep_id,
           bool_or(o.is_active)             AS is_active,
           min(o.tos_posture)               AS tos_posture,
           bool_or(o.robots_allowed)        AS robots_allowed,
           max(o.robots_checked_at)         AS robots_checked_at
      FROM sources o JOIN source_survivors s ON s.url = o.url
     WHERE o.id <> s.keep_id
     GROUP BY s.keep_id
  ) dup
 WHERE keep.id = dup.keep_id;

DELETE FROM sources o
 USING source_survivors s
 WHERE s.url = o.url AND o.id <> s.keep_id;

-- ── Make it unrepresentable ─────────────────────────────────────────────────
-- The URL is the identity of a source: two rows fetching the same address are the same
-- source, whatever they are called. Naming it `sources_url_key` rather than an index alone
-- gives the seed something to write `ON CONFLICT (url)` against.
ALTER TABLE sources ADD CONSTRAINT sources_url_key UNIQUE (url);
