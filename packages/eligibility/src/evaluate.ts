// The aggregation. PRODUCT_SPEC.md §12.3, SYSTEM_ARCHITECTURE.md §7.
//
// Deterministic and total: every input produces a verdict. No I/O, no network,
// no LLM, no clock except the injected `asOf`.

import {
  CONFIDENCE_FLOOR,
  DISCLAIMER,
  HIGH_STAKES_CONFIDENCE_FLOOR,
  HIGH_STAKES_RULE_TYPES,
  INFORMATIONAL_RULE_TYPES,
} from "./constants.js";
import { evaluateRule } from "./rules.js";
import type {
  EligibilityInput,
  EligibilityRule,
  EvaluateOptions,
  ProfileField,
  RuleResult,
  VerdictResult,
} from "./types.js";

export const isHighStakes = (t: EligibilityRule["rule_type"]): boolean =>
  HIGH_STAKES_RULE_TYPES.includes(t);

export const isInformational = (t: EligibilityRule["rule_type"]): boolean =>
  INFORMATIONAL_RULE_TYPES.includes(t);

/**
 * INVARIANT 2 (README.md §5) — a rule with no verbatim source quote cannot be
 * relied upon. The database enforces NOT NULL, but a whitespace-only string
 * would satisfy that, so the engine checks the substance too.
 */
export const hasSourceQuote = (rule: EligibilityRule): boolean =>
  typeof rule.source_quote === "string" && rule.source_quote.trim().length > 0;

/**
 * INVARIANT 13 (README.md §5) — support for the publication gate: never publish
 * an opportunity that charges a fee to apply. The gate itself lives in the
 * ingestion pipeline; this is the rule-level predicate it uses.
 */
export const chargesFeeToApply = (rules: readonly EligibilityRule[]): boolean =>
  rules.some((r) => r.rule_type === "cost" && r.params["kind"] === "paid");

/**
 * Evaluate a rule set against one profile.
 *
 * Aggregation, in order (PRODUCT_SPEC.md §12.3):
 *   no rules at all                      -> unclear
 *   any gating rule fails                -> not_eligible
 *   any gating rule unparsed             -> unclear
 *   any gating rule unknown              -> unclear, naming the fields
 *   all pass, all at/above the floor     -> eligible
 *   all pass, any below the floor        -> likely_eligible
 */
export function evaluate(
  rules: readonly EligibilityRule[],
  input: EligibilityInput,
  options: EvaluateOptions = {},
): VerdictResult {
  const asOf = options.asOf ?? new Date();

  // AI_SYSTEM.md §5 fallback: no rules extracted means every verdict is
  // `unclear`, said plainly. This is an acceptable degraded state, not an error.
  if (rules.length === 0) {
    return {
      verdict: "unclear",
      rule_results: [],
      missing_fields: [],
      confidence: 0,
      disclaimer: DISCLAIMER,
    };
  }

  const results: RuleResult[] = rules.map((rule) => {
    const highStakes = isHighStakes(rule.rule_type);
    const informational = isInformational(rule.rule_type);
    const confidence = Number.isFinite(rule.confidence) ? rule.confidence : 0;

    const base: Omit<RuleResult, "outcome" | "explanation" | "resolves_with"> = {
      rule_type: rule.rule_type,
      confidence,
      source_quote: rule.source_quote,
      is_high_stakes: highStakes,
      informational,
    };

    if (!hasSourceQuote(rule)) {
      return {
        ...base,
        outcome: "unparsed",
        explanation: "We can't show the sentence this rule came from, so we won't rely on it.",
        resolves_with: [],
      };
    }

    const evaluated = evaluateRule(rule, input, asOf);

    // AI_SYSTEM.md §5.4 — a high-stakes rule below the floor keeps its stored
    // confidence but cannot decide the verdict, in EITHER direction. Letting a
    // low-confidence country rule return `fail` would wrongly exclude someone,
    // which 01_PASS2_CRITIQUE.md §E2 rates as the worse error.
    if (highStakes && confidence < HIGH_STAKES_CONFIDENCE_FLOOR) {
      return {
        ...base,
        outcome: "unparsed",
        explanation: `We're not confident enough in how we read this requirement to judge it. ${evaluated.explanation}`,
        resolves_with: [],
      };
    }

    return { ...base, ...evaluated };
  });

  // Informational rules describe the opportunity, not the person, so they are
  // displayed but never gate the verdict.
  const gating = results.filter((r) => !r.informational);

  const missing_fields = dedupe(
    gating.filter((r) => r.outcome === "unknown").flatMap((r) => r.resolves_with),
  );

  const confidence = gating.length > 0 ? Math.min(...gating.map((r) => r.confidence)) : 0;

  const base = { rule_results: results, missing_fields, confidence, disclaimer: DISCLAIMER };

  // A `fail` is followed literally per §12.3, including below the confidence
  // floor for non-high-stakes types. The failing rule is always displayed with
  // its source quote and is one tap to dispute (PRODUCT_SPEC.md §12.4).
  if (gating.some((r) => r.outcome === "fail")) {
    return { ...base, verdict: "not_eligible" };
  }

  // INVARIANT 3 — unresolved ambiguity is `unclear`, never `eligible`. The spec
  // names high-stakes types explicitly; any unparsed rule is treated the same
  // way here, because an unreadable requirement is an unknown requirement.
  if (gating.some((r) => r.outcome === "unparsed")) {
    return { ...base, verdict: "unclear" };
  }

  if (gating.some((r) => r.outcome === "unknown")) {
    return { ...base, verdict: "unclear" };
  }

  // Nothing left but passes. A rule set with no gating rules at all (only
  // informational ones) tells us nothing about this person, so it is `unclear`.
  if (gating.length === 0) {
    return { ...base, verdict: "unclear" };
  }

  return {
    ...base,
    verdict: gating.every((r) => r.confidence >= CONFIDENCE_FLOOR) ? "eligible" : "likely_eligible",
  };
}

function dedupe(fields: readonly ProfileField[]): ProfileField[] {
  return [...new Set(fields)];
}
