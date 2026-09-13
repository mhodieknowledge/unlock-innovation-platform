import type { RuleType } from "./types.js";

/**
 * DATA_MODEL.md §5.1 — `is_high_stakes` is a generated column over exactly
 * these five rule types. Kept identical here; a mismatch between the database
 * and the engine would be a correctness bug in the product's spine.
 */
export const HIGH_STAKES_RULE_TYPES: readonly RuleType[] = [
  "country_in",
  "country_not_in",
  "nationality_in",
  "age_between",
  "student_status_in",
];

/**
 * AI_SYSTEM.md §5.4 — a high-stakes rule below this confidence is stored with
 * its confidence intact but forces the aggregate verdict to `unclear`.
 */
export const HIGH_STAKES_CONFIDENCE_FLOOR = 0.8;

/**
 * PRODUCT_SPEC.md §12.3 — all rules passing at or above this confidence gives
 * `eligible`; all passing with any rule below it gives `likely_eligible`.
 */
export const CONFIDENCE_FLOOR = 0.8;

/**
 * Rules describing the opportunity rather than the person. Displayed, but
 * excluded from pass/fail aggregation — a team-size range cannot make an
 * individual ineligible.
 */
export const INFORMATIONAL_RULE_TYPES: readonly RuleType[] = [
  "team_size_between",
  "individual_only",
  "team_only",
  "cost",
];

/** PRODUCT_SPEC.md §12.4 — verbatim, on every verdict. */
export const DISCLAIMER = "Always confirm on the official page — rules change.";

/**
 * AI_SYSTEM.md §5, fallback path: with no rules extracted, every verdict is
 * `unclear`, stated honestly rather than hidden.
 */
export const NO_RULES_EXPLANATION =
  "We haven't been able to confirm the eligibility rules for this one — check the official page.";
