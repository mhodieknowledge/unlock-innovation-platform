// Types for the deterministic eligibility engine.
// Mirrors DATA_MODEL.md §5.1 (rule_type enum) and §3 (eligibility_profiles columns).

/** DATA_MODEL.md §5.1 — the `rule_type` Postgres enum, in the same order. */
export const RULE_TYPES = [
  "country_in",
  "country_not_in",
  "nationality_in",
  "residency_required",
  "age_between",
  "student_status_in",
  "year_of_study_in",
  "institution_type_in",
  "experience_between",
  "team_size_between",
  "individual_only",
  "team_only",
  "gender_restricted",
  "language_required",
  "cost",
  "travel_required",
  "other_unstructured",
] as const;

export type RuleType = (typeof RULE_TYPES)[number];

export type StudentStatus =
  | "not_student"
  | "secondary"
  | "undergraduate"
  | "postgraduate"
  | "recent_graduate";

export type InstitutionType =
  | "university"
  | "polytechnic"
  | "secondary"
  | "bootcamp"
  | "none";

export type CostKind = "free" | "paid" | "unknown";

/** PRODUCT_SPEC.md §12.3 — per-rule outcome. */
export type RuleOutcome = "pass" | "fail" | "unknown" | "unparsed";

/** PRODUCT_SPEC.md §12.3 — the four aggregate verdicts. */
export type Verdict =
  | "eligible"
  | "likely_eligible"
  | "unclear"
  | "not_eligible";

/**
 * A stored eligibility rule.
 *
 * INVARIANT 2 (README.md §5): `source_quote` is never empty. The database
 * enforces NOT NULL (DATA_MODEL.md §5.1); this engine additionally refuses to
 * count a quote-less rule as passing, so the invariant cannot be bypassed by a
 * bad write path.
 */
export interface EligibilityRule {
  id?: string;
  rule_type: RuleType;
  params: Readonly<Record<string, unknown>>;
  source_quote: string;
  /** 0..1, from extraction or a human reviewer. */
  confidence: number;
}

/**
 * The subset of `eligibility_profiles` the engine reads (DATA_MODEL.md §3).
 *
 * Every field is optional by design (PRODUCT_SPEC.md §12.1): a missing field
 * produces `unknown` on the rules that need it, never a block.
 *
 * Note `birth_year` rather than a full date of birth — PRIVACY_AND_COMPLIANCE.md
 * §1 deliberately collects the year only.
 */
export interface EligibilityInput {
  country_of_residence?: string | null;
  nationalities?: readonly string[] | null;
  birth_year?: number | null;
  student_status?: StudentStatus | null;
  year_of_study?: number | null;
  institution_type?: InstitutionType | null;
  years_experience?: number | null;
  languages?: readonly string[] | null;
  /** Optional, self-declared, never inferred (PRODUCT_SPEC.md §12.2). */
  gender?: string | null;
  can_travel?: boolean | null;
  remote_only?: boolean | null;
}

export type ProfileField = keyof EligibilityInput;

export interface RuleResult {
  rule_type: RuleType;
  outcome: RuleOutcome;
  confidence: number;
  /** Verbatim sentence from the source document. Always present. */
  source_quote: string;
  /** Plain-language, templated. Never model-generated (PRODUCT_SPEC.md §14.3). */
  explanation: string;
  /** Which profile fields would move this off `unknown`. */
  resolves_with: ProfileField[];
  is_high_stakes: boolean;
  /**
   * True for rules that describe the opportunity's shape rather than gate a
   * person (team size, individual/team, cost). They are displayed but cannot
   * make anyone ineligible.
   */
  informational: boolean;
}

export interface VerdictResult {
  verdict: Verdict;
  rule_results: RuleResult[];
  /** Exactly which fields would resolve an `unclear` (PRODUCT_SPEC.md §12.3). */
  missing_fields: ProfileField[];
  /** Lowest confidence among the gating rules; 0 when there are none. */
  confidence: number;
  /** PRODUCT_SPEC.md §12.4 — carried on every verdict, without exception. */
  disclaimer: string;
}

export interface EvaluateOptions {
  /**
   * Reference date for age arithmetic. Required for determinism in tests;
   * defaults to the current date.
   */
  asOf?: Date;
}
