-- Everything scraped goes back to a person. Restores §4.7's twelve gates exactly.
UPDATE sources SET auto_publish = false;
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_auto_publish_never_for_people;
ALTER TABLE sources DROP COLUMN IF EXISTS auto_publish;

CREATE OR REPLACE FUNCTION route_for_publication(
  p_source_id uuid, p_extraction_confidence numeric, p_deadline_confidence numeric,
  p_country_confidence numeric, p_cost cost_kind, p_prize_amount numeric,
  p_prize_currency char(3), p_eligibility_scope eligibility_scope, p_link_ok boolean,
  p_organisation_id uuid, p_fee_keyword_hit boolean DEFAULT false,
  p_safe_browsing_hit boolean DEFAULT false)
RETURNS TABLE (decision text, reason text)
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE v_trust numeric; v_published int; v_prize_threshold numeric := 50000;
BEGIN
  SELECT s.trust_score, s.records_published INTO v_trust, v_published FROM sources s WHERE s.id = p_source_id;
  IF p_cost = 'paid' OR p_fee_keyword_hit THEN
    RETURN QUERY SELECT 'review', 'a fee to apply was detected — invariant 13 forbids publishing this at all without a person confirming it is wrong'; RETURN; END IF;
  IF p_safe_browsing_hit THEN RETURN QUERY SELECT 'review', 'a link was flagged by Safe Browsing'; RETURN; END IF;
  IF p_prize_amount IS NOT NULL AND p_prize_currency = 'USD' AND p_prize_amount > v_prize_threshold THEN
    RETURN QUERY SELECT 'review', format('prize above USD %s — high-value listings are the most attractive scam vector', v_prize_threshold); RETURN; END IF;
  IF p_eligibility_scope = 'unclear' AND p_prize_amount IS NOT NULL THEN
    RETURN QUERY SELECT 'review', 'unclear eligibility combined with a stated prize'; RETURN; END IF;
  IF coalesce(v_trust, 0) < 0.4 THEN RETURN QUERY SELECT 'review', 'source trust below 0.4'; RETURN; END IF;
  IF coalesce(v_published, 0) < 5 THEN
    RETURN QUERY SELECT 'review', format('this source has published %s records; its first 5 are always reviewed', coalesce(v_published,0)); RETURN; END IF;
  IF coalesce(p_extraction_confidence, 0) < 0.75 THEN
    RETURN QUERY SELECT 'review', format('extraction confidence %s is below 0.75', coalesce(p_extraction_confidence,0)); RETURN; END IF;
  IF coalesce(p_deadline_confidence, 0) < 0.80 THEN
    RETURN QUERY SELECT 'review', format('deadline confidence %s is below 0.80', coalesce(p_deadline_confidence,0)); RETURN; END IF;
  IF coalesce(p_country_confidence, 0) < 0.80 THEN
    RETURN QUERY SELECT 'review', format('country confidence %s is below 0.80', coalesce(p_country_confidence,0)); RETURN; END IF;
  IF p_link_ok IS NOT TRUE THEN RETURN QUERY SELECT 'review', 'the link has not been confirmed reachable'; RETURN; END IF;
  IF p_organisation_id IS NULL THEN RETURN QUERY SELECT 'review', 'the organisation could not be resolved'; RETURN; END IF;
  IF coalesce(v_trust, 0) < 0.60 THEN
    RETURN QUERY SELECT 'review', format('source trust %s is below 0.60', coalesce(v_trust,0)); RETURN; END IF;
  RETURN QUERY SELECT 'publish', 'every gate in OPPORTUNITY_INGESTION.md §4.7 passed';
END $$;
