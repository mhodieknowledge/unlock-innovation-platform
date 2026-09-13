# Golden corpus — status and obligation

`golden-corpus.json` holds 60 regression cases for the eligibility engine. They
cover every one of the 17 `rule_type` values in `DATA_MODEL.md` §5.1, all six
Tier-1 countries (ZW, ZM, BW, NA, MW, MZ), all four verdicts, and every branch
of the aggregation in `PRODUCT_SPEC.md` §12.3.

## These fixtures are SYNTHETIC

The rule text is representative of the phrasing real calls use, but it was
**authored for this test suite**. It is not transcribed from real opportunity
documents.

`AI_SYSTEM.md` §12 and `SYSTEM_ARCHITECTURE.md` §7 both require something
different and stronger:

> at least 60 **hand-labelled real opportunities** covering every rule type and
> each of the six Tier-1 countries, as a regression suite

That requirement is **not yet met** and is tracked as outstanding.

## Why it was built this way

Producing 60 "real" records without fetching them from real sources would mean
inventing opportunities and labelling them as real. That is barred by
`CONTENT_AND_LAUNCH.md` §1 ("No fabrication, ever") and by invariant 9. Fetching
them for real is gated on per-source robots and ToS review, which `README.md` §6
lists as a decision the coding agent must not take alone.

So the corpus was built to do the job it can legitimately do now — prove the
engine's logic is correct, exhaustively — while being explicit that it does not
yet do the job the specs ask of it, which is to prove the engine copes with real
documents' phrasing.

## What must happen before the engine gates publication

1. Hand-label ≥60 real opportunity records, spanning every rule type and all six
   Tier-1 countries, sourced through the tier 1–5 paths in
   `OPPORTUNITY_INGESTION.md` §2 (feeds, APIs, org submissions), or tier 6 after
   the per-source review in `README.md` §6 item 3.
2. Add them to this directory as a separate file; **keep these synthetic cases**
   — they cover boundary logic that real records rarely exercise (the birth-year
   ±1 ambiguity, blank source quotes, malformed params).
3. Wire the real corpus into the `AI_SYSTEM.md` §12 metric gates: deadline
   exact-match ≥0.90, country-eligibility F1 ≥0.92, quote-verbatim ≥0.98,
   schema-valid ≥0.95, false-`eligible` rate exactly 0.
