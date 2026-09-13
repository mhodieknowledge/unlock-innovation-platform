/**
 * The deterministic eligibility engine — the product's spine.
 *
 * SYSTEM_ARCHITECTURE.md §7: a pure function, no I/O, no LLM, no network,
 * fully unit-testable, deterministic and total.
 *
 * INVARIANT 3 (README.md §5): ambiguity resolves to `unclear`, never to
 * `eligible`. Enforced by the test suite, not only by review.
 */

export {
  chargesFeeToApply,
  evaluate,
  hasSourceQuote,
  isHighStakes,
  isInformational,
} from "./evaluate.js";

export {
  CONFIDENCE_FLOOR,
  DISCLAIMER,
  HIGH_STAKES_CONFIDENCE_FLOOR,
  HIGH_STAKES_RULE_TYPES,
  INFORMATIONAL_RULE_TYPES,
  NO_RULES_EXPLANATION,
} from "./constants.js";

export { evaluateRule } from "./rules.js";
export type { RuleEvaluation } from "./rules.js";

export { RULE_TYPES } from "./types.js";
export type {
  CostKind,
  EligibilityInput,
  EligibilityRule,
  EvaluateOptions,
  InstitutionType,
  ProfileField,
  RuleOutcome,
  RuleResult,
  RuleType,
  StudentStatus,
  Verdict,
  VerdictResult,
} from "./types.js";
