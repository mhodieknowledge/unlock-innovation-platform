-- 0034 an organisation is not another listing's title
--
-- The live board showed three of eight rows credited to an organisation that was a different
-- row's headline: the AFLI Archbishop Tutu Fellowship attributed to "AfricaLics Visiting PhD
-- Fellowship Programme 2027 for young African PhD Students (Funded)", a Khalifa University
-- scholarship to "France Student Visa Financial Requirements 2026/2027".
--
-- Two bugs compounded, both fixed in scripts/ingest.mjs alongside this migration:
--
--   1. When extraction produced no organisation name, the pipeline fell back to the feed
--      item's own title and CREATED an organisation with it. That is not a fallback, it is an
--      invention — and the row component has always rendered "Organisation not identified"
--      for a null, which is the honest output.
--
--   2. `resolveOrganisation` matches on the document's domain first. On an aggregator every
--      listing shares one domain, so once a bogus organisation held that domain, every later
--      listing from the same feed was attached to it.
--
-- This repairs what those two already wrote. It is deliberately narrow: only organisations
-- ingestion created (`unclaimed`), only where the name is EXACTLY some opportunity's title.
-- A real organisation that happens to resemble a title is left alone, because the cost of a
-- false positive here is deleting a legitimate body.

-- ── The bogus set, named once and reused ────────────────────────────────────
CREATE TEMP TABLE invented_organisations ON COMMIT DROP AS
SELECT o.id, o.name
  FROM organisations o
 WHERE o.verification = 'unclaimed'
   AND o.deleted_at IS NULL
   AND EXISTS (
     SELECT 1 FROM opportunities p
      WHERE p.deleted_at IS NULL
        AND lower(btrim(p.title)) = lower(btrim(o.name))
   );

-- Detach first. `organisations.id` is referenced by opportunities, and a listing whose
-- organiser we cannot name is a listing with no organiser — not a listing to delete.
UPDATE opportunities p
   SET organisation_id = NULL
  FROM invented_organisations i
 WHERE p.organisation_id = i.id;

-- Withdraw the review queue item each of these raised. A claim review for an organisation
-- that never existed is a reviewer's time spent on our own mistake.
DELETE FROM review_queue
 WHERE subject_type = 'organisation'
   AND subject_id IN (SELECT id FROM invented_organisations);

-- Soft delete, not a hard one: DATA_MODEL.md keeps `deleted_at` on this table precisely so a
-- removal is reversible and auditable, and a hard delete would take the row's history with it.
UPDATE organisations
   SET deleted_at = now()
 WHERE id IN (SELECT id FROM invented_organisations);

-- ── Stop an aggregator's domain from identifying anyone ─────────────────────
-- The second bug's residue. The first attempt here cleared the domain of any unclaimed
-- organisation whose domain matched a SOURCE's, and that was too blunt: Zindi is both a
-- source we crawl and the organisation that runs the competitions, so it lost its own
-- identity. Being a source is not the problem.
--
-- The signature of an aggregator domain is that MANY organisations claim it — which is
-- exactly what the invented ones did. One organisation on one domain is a body with a
-- website; four on one domain is a feed that got mistaken for four bodies. Counted before
-- the soft delete above takes effect within this transaction, because the invented rows are
-- most of the evidence.
UPDATE organisations o
   SET website_domain = NULL
 WHERE o.verification = 'unclaimed'
   AND o.website_domain IS NOT NULL
   AND o.id NOT IN (SELECT id FROM invented_organisations)
   AND (
     SELECT count(*) FROM organisations x
      WHERE regexp_replace(lower(x.website_domain), '^www\.', '')
          = regexp_replace(lower(o.website_domain), '^www\.', '')
   ) > 1;
