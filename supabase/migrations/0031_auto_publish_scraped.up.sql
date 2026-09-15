-- 0031 scraped sources may publish without a person; submissions still may not
--
-- The operator's position, and it is a reasonable one: one person cannot hand-review
-- three hundred records a card at a time, and CONTENT_AND_LAUNCH.md §2 asks for exactly
-- that before launch. What they want reviewed is what STRANGERS send, and that is a
-- different path entirely — public_submit_opportunity inserts with status 'draft'
-- straight into the 'ugc' queue and never calls this function at all. So nothing below
-- touches user submissions; they keep needing a person, which is what was asked for.
--
-- WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT.
--
-- Twelve gates stood between a scraped record and the board. They are not one kind of
-- thing, and collapsing them would have been the easy mistake. Five exist because being
-- wrong costs a READER something — money, or an application they were entitled to make.
-- Seven exist because the pipeline had not yet earned confidence in itself.
--
-- The five stay, for every source, with no override. A fee to apply, a Safe Browsing
-- hit, a prize above USD 50,000, unclear eligibility beside a stated prize, and a source
-- trusted below 0.4 still go to a person. Invariant 13 and MODERATION_AND_TRUST.md are
-- not throughput problems and auto_publish is not a way past them.
--
-- The seven become a per-source decision. On a source an operator has vetted, "this
-- source has published fewer than 5 records", "source trust is below 0.60" and "the
-- organisation could not be resolved" describe our own caution rather than any risk to
-- the reader, and they were unanimously blocking: nine of the seeded sources carry trust
-- 0.50, so no record from them could EVER auto-publish however good the extraction.
--
-- Two narrower checks replace them, because these are still about the reader:
--   * a deadline we extracted but are unsure of is worse than no deadline at all —
--     someone plans around it. Claimed-but-uncertain goes to review; absent is fine.
--   * a country list we are unsure of tells someone they cannot apply for something
--     they can. Only checked when the record actually asserts a country list; 'global',
--     'africa_wide' and 'unclear' assert nothing and are displayed honestly as such.

ALTER TABLE sources ADD COLUMN IF NOT EXISTS auto_publish boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN sources.auto_publish IS
  'When true, records from this source skip the caution gates in route_for_publication '
  '(first-five, trust floor, organisation resolution, link-health pre-check) but NOT the '
  'safety gates (fee, Safe Browsing, large prize, unclear-scope-with-prize, trust<0.4). '
  'A judgement about a source an operator has vetted. Never set on org_submission or '
  'manual sources: those are people, and people are reviewed.';

-- A submission source must never be auto-published, whatever anyone sets later.
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_auto_publish_never_for_people;
ALTER TABLE sources ADD CONSTRAINT sources_auto_publish_never_for_people
  CHECK (NOT auto_publish OR kind NOT IN ('org_submission', 'manual'));

CREATE OR REPLACE FUNCTION route_for_publication(
  p_source_id uuid,
  p_extraction_confidence numeric,
  p_deadline_confidence numeric,
  p_country_confidence numeric,
  p_cost cost_kind,
  p_prize_amount numeric,
  p_prize_currency char(3),
  p_eligibility_scope eligibility_scope,
  p_link_ok boolean,
  p_organisation_id uuid,
  p_fee_keyword_hit boolean DEFAULT false,
  p_safe_browsing_hit boolean DEFAULT false
)
RETURNS TABLE (decision text, reason text)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_trust numeric;
  v_published int;
  v_auto boolean;
  v_prize_threshold numeric := 50000;
BEGIN
  SELECT s.trust_score, s.records_published, s.auto_publish
    INTO v_trust, v_published, v_auto
    FROM sources s WHERE s.id = p_source_id;

  -- ── Absolute review triggers. Never auto-publish, auto_publish included. ──
  IF p_cost = 'paid' OR p_fee_keyword_hit THEN
    RETURN QUERY SELECT 'review', 'a fee to apply was detected — invariant 13 forbids publishing this at all without a person confirming it is wrong';
    RETURN;
  END IF;
  IF p_safe_browsing_hit THEN
    RETURN QUERY SELECT 'review', 'a link was flagged by Safe Browsing';
    RETURN;
  END IF;
  IF p_prize_amount IS NOT NULL AND p_prize_currency = 'USD' AND p_prize_amount > v_prize_threshold THEN
    RETURN QUERY SELECT 'review', format('prize above USD %s — high-value listings are the most attractive scam vector', v_prize_threshold);
    RETURN;
  END IF;
  IF p_eligibility_scope = 'unclear' AND p_prize_amount IS NOT NULL THEN
    RETURN QUERY SELECT 'review', 'unclear eligibility combined with a stated prize';
    RETURN;
  END IF;
  IF coalesce(v_trust, 0) < 0.4 THEN
    RETURN QUERY SELECT 'review', 'source trust below 0.4';
    RETURN;
  END IF;

  -- ── A vetted source: only the checks a reader can be harmed by remain. ───
  IF coalesce(v_auto, false) THEN
    IF coalesce(p_deadline_confidence, 0) > 0 AND p_deadline_confidence < 0.80 THEN
      RETURN QUERY SELECT 'review', format('a deadline was extracted at confidence %s — a date someone plans around is not published unsure', p_deadline_confidence);
      RETURN;
    END IF;
    IF p_eligibility_scope = 'country_list' AND coalesce(p_country_confidence, 0) < 0.80 THEN
      RETURN QUERY SELECT 'review', format('a country list asserted at confidence %s — telling someone they cannot apply is the expensive way to be wrong', coalesce(p_country_confidence, 0));
      RETURN;
    END IF;
    RETURN QUERY SELECT 'publish', 'auto_publish is set on this source and every safety gate passed';
    RETURN;
  END IF;

  -- ── Otherwise §4.7 unchanged. ────────────────────────────────────────────
  IF coalesce(v_published, 0) < 5 THEN
    RETURN QUERY SELECT 'review', format('this source has published %s records; its first 5 are always reviewed', coalesce(v_published,0));
    RETURN;
  END IF;
  IF coalesce(p_extraction_confidence, 0) < 0.75 THEN
    RETURN QUERY SELECT 'review', format('extraction confidence %s is below 0.75', coalesce(p_extraction_confidence,0));
    RETURN;
  END IF;
  IF coalesce(p_deadline_confidence, 0) < 0.80 THEN
    RETURN QUERY SELECT 'review', format('deadline confidence %s is below 0.80', coalesce(p_deadline_confidence,0));
    RETURN;
  END IF;
  IF coalesce(p_country_confidence, 0) < 0.80 THEN
    RETURN QUERY SELECT 'review', format('country confidence %s is below 0.80', coalesce(p_country_confidence,0));
    RETURN;
  END IF;
  IF p_link_ok IS NOT TRUE THEN
    RETURN QUERY SELECT 'review', 'the link has not been confirmed reachable';
    RETURN;
  END IF;
  IF p_organisation_id IS NULL THEN
    RETURN QUERY SELECT 'review', 'the organisation could not be resolved';
    RETURN;
  END IF;
  IF coalesce(v_trust, 0) < 0.60 THEN
    RETURN QUERY SELECT 'review', format('source trust %s is below 0.60', coalesce(v_trust,0));
    RETURN;
  END IF;

  RETURN QUERY SELECT 'publish', 'every gate in OPPORTUNITY_INGESTION.md §4.7 passed';
END
$$;

-- The twelve sources measured in 0030. Each was fetched, its content read, and its
-- items confirmed to be calls to apply rather than articles about them.
UPDATE sources SET auto_publish = true
 WHERE is_active AND kind IN ('rss', 'atom', 'json_api', 'jsonld', 'html_page', 'sitemap');
