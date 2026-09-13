// Per-rule evaluators. Pure: no I/O, no network, no LLM, no clock access
// except the injected `asOf`. One function per rule_type in DATA_MODEL.md §5.1.

import type {
  EligibilityInput,
  EligibilityRule,
  ProfileField,
  RuleOutcome,
  RuleType,
} from "./types.js";

export interface RuleEvaluation {
  outcome: RuleOutcome;
  explanation: string;
  resolves_with: ProfileField[];
}

// ── param coercion ───────────────────────────────────────────────────────────
// `params` is untrusted jsonb. Anything unusable yields `unparsed` rather than
// throwing, so one malformed row can never break a page.

function strArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length > 0 ? out : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

const upper = (s: string) => s.trim().toUpperCase();
const lower = (s: string) => s.trim().toLowerCase();

function countrySet(v: unknown): Set<string> | null {
  const arr = strArray(v);
  return arr ? new Set(arr.map(upper)) : null;
}

function list(items: readonly string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]!} and ${items[1]!}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]!}`;
}

const UNPARSED = (why: string): RuleEvaluation => ({
  outcome: "unparsed",
  explanation: why,
  resolves_with: [],
});

const MISSING = (field: ProfileField, why: string): RuleEvaluation => ({
  outcome: "unknown",
  explanation: why,
  resolves_with: [field],
});

// ── evaluators ───────────────────────────────────────────────────────────────

function countryIn(rule: EligibilityRule, input: EligibilityInput): RuleEvaluation {
  const allowed = countrySet(rule.params["countries"]);
  if (!allowed) return UNPARSED("We couldn't read the country list for this rule.");
  const residence = input.country_of_residence ? upper(input.country_of_residence) : null;
  if (!residence) return MISSING("country_of_residence", "Add your country to resolve this.");
  return allowed.has(residence)
    ? { outcome: "pass", explanation: `${residence} is included.`, resolves_with: [] }
    : { outcome: "fail", explanation: `${residence} is not in the eligible country list.`, resolves_with: [] };
}

function countryNotIn(rule: EligibilityRule, input: EligibilityInput): RuleEvaluation {
  const excluded = countrySet(rule.params["countries"]);
  if (!excluded) return UNPARSED("We couldn't read the excluded country list for this rule.");
  const residence = input.country_of_residence ? upper(input.country_of_residence) : null;
  if (!residence) return MISSING("country_of_residence", "Add your country to resolve this.");
  return excluded.has(residence)
    ? { outcome: "fail", explanation: `${residence} is excluded.`, resolves_with: [] }
    : { outcome: "pass", explanation: `${residence} is not excluded.`, resolves_with: [] };
}

function nationalityIn(rule: EligibilityRule, input: EligibilityInput): RuleEvaluation {
  const allowed = countrySet(rule.params["countries"]);
  if (!allowed) return UNPARSED("We couldn't read the nationality list for this rule.");
  const held = (input.nationalities ?? []).map(upper);
  if (held.length === 0)
    return MISSING("nationalities", "Add your nationality to resolve this.");
  const match = held.find((n) => allowed.has(n));
  return match
    ? { outcome: "pass", explanation: `${match} nationality qualifies.`, resolves_with: [] }
    : {
        outcome: "fail",
        explanation: `This is limited to nationals of other countries.`,
        resolves_with: [],
      };
}

/**
 * Residency, distinct from nationality — PRODUCT_SPEC.md §28 requires the two
 * never be conflated.
 */
function residencyRequired(rule: EligibilityRule, input: EligibilityInput): RuleEvaluation {
  const required = countrySet(rule.params["countries"]) ?? countrySet([str(rule.params["country"])]);
  if (!required)
    return UNPARSED("This requires residency somewhere specific, but the rule doesn't say where.");
  const residence = input.country_of_residence ? upper(input.country_of_residence) : null;
  if (!residence)
    return MISSING("country_of_residence", "Add your country of residence to resolve this.");
  return required.has(residence)
    ? { outcome: "pass", explanation: `You live in ${residence}, which qualifies.`, resolves_with: [] }
    : {
        outcome: "fail",
        explanation: `This requires residency in ${list([...required])}.`,
        resolves_with: [],
      };
}

/**
 * Age, from birth YEAR only (PRIVACY_AND_COMPLIANCE.md §1 collects no full date
 * of birth). A year alone leaves a person's age ambiguous by one, so:
 *   pass  — only when BOTH possible ages satisfy the rule
 *   fail  — only when NEITHER does
 *   unknown — on the boundary, stated honestly
 *
 * The boundary case is deliberately not resolvable: we will not ask for a full
 * date of birth to close it. INVARIANT 3 — ambiguity is never `eligible`.
 */
function ageBetween(rule: EligibilityRule, input: EligibilityInput, asOf: Date): RuleEvaluation {
  const min = num(rule.params["min"]);
  const max = num(rule.params["max"]);
  if (min === null && max === null) return UNPARSED("We couldn't read the age limits for this rule.");
  const birthYear = num(input.birth_year);
  if (birthYear === null) return MISSING("birth_year", "Add your birth year to resolve this.");

  const upperAge = asOf.getUTCFullYear() - birthYear;
  const lowerAge = upperAge - 1;
  const ok = (age: number) => (min === null || age >= min) && (max === null || age <= max);

  const bound =
    min !== null && max !== null
      ? `between ${min} and ${max}`
      : min !== null
        ? `at least ${min}`
        : `at most ${max}`;

  if (ok(lowerAge) && ok(upperAge))
    return { outcome: "pass", explanation: `Your age qualifies (must be ${bound}).`, resolves_with: [] };
  if (!ok(lowerAge) && !ok(upperAge))
    return { outcome: "fail", explanation: `This requires you to be ${bound}.`, resolves_with: [] };
  return {
    outcome: "unknown",
    explanation: `Your birth year puts you at ${lowerAge} or ${upperAge}, and this requires ${bound} — we can't tell from the year alone.`,
    resolves_with: [],
  };
}

function studentStatusIn(rule: EligibilityRule, input: EligibilityInput): RuleEvaluation {
  const allowed = strArray(rule.params["statuses"]);
  if (!allowed) return UNPARSED("We couldn't read the student-status list for this rule.");
  const status = input.student_status ?? null;
  if (!status) return MISSING("student_status", "Add your student status to resolve this.");
  const set = new Set(allowed.map(lower));
  return set.has(lower(status))
    ? { outcome: "pass", explanation: `Your status (${status.replace(/_/g, " ")}) qualifies.`, resolves_with: [] }
    : {
        outcome: "fail",
        explanation: `This is limited to ${list(allowed.map((s) => s.replace(/_/g, " ")))}.`,
        resolves_with: [],
      };
}

function yearOfStudyIn(rule: EligibilityRule, input: EligibilityInput): RuleEvaluation {
  const years = Array.isArray(rule.params["years"])
    ? (rule.params["years"] as unknown[]).map(num).filter((n): n is number => n !== null)
    : [];
  const min = num(rule.params["min"]);
  const max = num(rule.params["max"]);
  if (years.length === 0 && min === null && max === null)
    return UNPARSED("We couldn't read the year-of-study limits for this rule.");
  const year = num(input.year_of_study);
  if (year === null) return MISSING("year_of_study", "Add your year of study to resolve this.");

  const ok =
    years.length > 0
      ? years.includes(year)
      : (min === null || year >= min) && (max === null || year <= max);
  return ok
    ? { outcome: "pass", explanation: `Year ${year} qualifies.`, resolves_with: [] }
    : { outcome: "fail", explanation: `Year ${year} is outside the eligible years.`, resolves_with: [] };
}

function institutionTypeIn(rule: EligibilityRule, input: EligibilityInput): RuleEvaluation {
  const allowed = strArray(rule.params["types"]);
  if (!allowed) return UNPARSED("We couldn't read the institution types for this rule.");
  const type = input.institution_type ?? null;
  if (!type) return MISSING("institution_type", "Add your institution type to resolve this.");
  return new Set(allowed.map(lower)).has(lower(type))
    ? { outcome: "pass", explanation: `${type} qualifies.`, resolves_with: [] }
    : { outcome: "fail", explanation: `This is limited to ${list(allowed)}.`, resolves_with: [] };
}

function experienceBetween(rule: EligibilityRule, input: EligibilityInput): RuleEvaluation {
  const min = num(rule.params["min"]);
  const max = num(rule.params["max"]);
  if (min === null && max === null)
    return UNPARSED("We couldn't read the experience limits for this rule.");
  const years = num(input.years_experience);
  if (years === null)
    return MISSING("years_experience", "Add your years of experience to resolve this.");
  const ok = (min === null || years >= min) && (max === null || years <= max);
  const bound =
    min !== null && max !== null
      ? `between ${min} and ${max} years`
      : min !== null
        ? `at least ${min} years`
        : `at most ${max} years`;
  return ok
    ? { outcome: "pass", explanation: `Your experience qualifies (needs ${bound}).`, resolves_with: [] }
    : { outcome: "fail", explanation: `This needs ${bound} of experience.`, resolves_with: [] };
}

function genderRestricted(rule: EligibilityRule, input: EligibilityInput): RuleEvaluation {
  const allowed = strArray(rule.params["genders"]);
  if (!allowed) return UNPARSED("We couldn't read the eligibility for this rule.");
  // Never inferred — only evaluated against a value the user explicitly gave
  // (PRODUCT_SPEC.md §12.2).
  const gender = input.gender ?? null;
  if (!gender)
    return MISSING("gender", "This programme is open to a specific group. Add the optional field to resolve it.");
  return new Set(allowed.map(lower)).has(lower(gender))
    ? { outcome: "pass", explanation: "You are in the group this is open to.", resolves_with: [] }
    : { outcome: "fail", explanation: `This is open to ${list(allowed)} applicants.`, resolves_with: [] };
}

function languageRequired(rule: EligibilityRule, input: EligibilityInput): RuleEvaluation {
  const required = strArray(rule.params["languages"]);
  if (!required) return UNPARSED("We couldn't read the language requirement for this rule.");
  const spoken = (input.languages ?? []).map(lower);
  if (spoken.length === 0)
    return MISSING("languages", "Add the languages you read to resolve this.");
  const set = new Set(spoken);
  const match = required.find((l) => set.has(lower(l)));
  return match
    ? { outcome: "pass", explanation: `You read ${match}.`, resolves_with: [] }
    : { outcome: "fail", explanation: `This requires ${list(required)}.`, resolves_with: [] };
}

function travelRequired(rule: EligibilityRule, input: EligibilityInput): RuleEvaluation {
  const canTravel = input.can_travel;
  if (canTravel === null || canTravel === undefined)
    // A `remote_only` preference is deliberately NOT read as ineligibility.
    // 01_PASS2_CRITIQUE.md §E2: wrongly excluding someone is worse than
    // wrongly including them.
    return MISSING("can_travel", "Tell us whether you can travel to resolve this.");
  return canTravel
    ? { outcome: "pass", explanation: "You said you can travel.", resolves_with: [] }
    : { outcome: "fail", explanation: "This requires travel and you said you cannot.", resolves_with: [] };
}

// Informational: describes the opportunity, cannot gate a person.

function teamSizeBetween(rule: EligibilityRule): RuleEvaluation {
  const min = num(rule.params["min"]);
  const max = num(rule.params["max"]);
  if (min === null && max === null) return UNPARSED("We couldn't read the team size for this rule.");
  const bound =
    min !== null && max !== null ? `${min}–${max} people` : min !== null ? `at least ${min}` : `at most ${max}`;
  return { outcome: "pass", explanation: `Teams of ${bound}.`, resolves_with: [] };
}

const individualOnly = (): RuleEvaluation => ({
  outcome: "pass",
  explanation: "Individual entries only — no team needed.",
  resolves_with: [],
});

const teamOnly = (): RuleEvaluation => ({
  outcome: "pass",
  explanation: "Team entries only.",
  resolves_with: [],
});

function cost(rule: EligibilityRule): RuleEvaluation {
  const kind = str(rule.params["kind"]);
  if (kind === "free") return { outcome: "pass", explanation: "Free to enter.", resolves_with: [] };
  if (kind === "paid")
    // INVARIANT 13 — a fee to apply must never be published. If one reaches
    // evaluation, say so plainly rather than scoring it.
    return {
      outcome: "unparsed",
      explanation: "This lists a cost. We never ask you to pay to apply — please report it.",
      resolves_with: [],
    };
  return UNPARSED("The cost of entering isn't stated.");
}

/**
 * Prose we could not structure — including requirements resting on attributes
 * we deliberately never collect (PRIVACY_AND_COMPLIANCE.md §3: disability,
 * ethnicity, health and the rest). Always `unparsed`, which forces `unclear`.
 */
function otherUnstructured(rule: EligibilityRule): RuleEvaluation {
  const text = str(rule.params["text"]);
  return {
    outcome: "unparsed",
    explanation: text
      ? `This has a requirement we don't check for you: ${text}. Check the official page.`
      : "This has a requirement we don't ask about. Check the official page.",
    resolves_with: [],
  };
}

// ── dispatch ─────────────────────────────────────────────────────────────────

type Evaluator = (
  rule: EligibilityRule,
  input: EligibilityInput,
  asOf: Date,
) => RuleEvaluation;

const EVALUATORS: Record<RuleType, Evaluator> = {
  country_in: (r, i) => countryIn(r, i),
  country_not_in: (r, i) => countryNotIn(r, i),
  nationality_in: (r, i) => nationalityIn(r, i),
  residency_required: (r, i) => residencyRequired(r, i),
  age_between: (r, i, d) => ageBetween(r, i, d),
  student_status_in: (r, i) => studentStatusIn(r, i),
  year_of_study_in: (r, i) => yearOfStudyIn(r, i),
  institution_type_in: (r, i) => institutionTypeIn(r, i),
  experience_between: (r, i) => experienceBetween(r, i),
  team_size_between: (r) => teamSizeBetween(r),
  individual_only: () => individualOnly(),
  team_only: () => teamOnly(),
  gender_restricted: (r, i) => genderRestricted(r, i),
  language_required: (r, i) => languageRequired(r, i),
  cost: (r) => cost(r),
  travel_required: (r, i) => travelRequired(r, i),
  other_unstructured: (r) => otherUnstructured(r),
};

export function evaluateRule(
  rule: EligibilityRule,
  input: EligibilityInput,
  asOf: Date,
): RuleEvaluation {
  const evaluator = EVALUATORS[rule.rule_type];
  if (!evaluator) return UNPARSED("We don't recognise this requirement.");
  return evaluator(rule, input, asOf);
}
