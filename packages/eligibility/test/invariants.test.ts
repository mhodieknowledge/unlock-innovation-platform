// SYSTEM_ARCHITECTURE.md §7: "Bias rule: ambiguity resolves to `unclear`, never
// to `eligible`. Encoded as a test suite invariant."
//
// These tests fuzz the engine over a seeded, reproducible space of rule sets and
// profiles, so invariant 3 is enforced mechanically rather than by review.

import { describe, expect, it } from "vitest";

import {
  CONFIDENCE_FLOOR,
  evaluate,
  HIGH_STAKES_CONFIDENCE_FLOOR,
  isInformational,
  RULE_TYPES,
} from "../src/index.js";
import type {
  EligibilityInput,
  EligibilityRule,
  RuleType,
  Verdict,
} from "../src/index.js";

const VERDICTS: readonly Verdict[] = [
  "eligible",
  "likely_eligible",
  "unclear",
  "not_eligible",
];

const AS_OF = new Date("2026-09-13T00:00:00Z");

/** mulberry32 — small, seeded, deterministic. Reproducible fuzz runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
        a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COUNTRIES = ["ZW", "ZM", "BW", "NA", "MW", "MZ", "KE", "NG", "GH", "ZA"];
const STATUSES = ["not_student", "secondary", "undergraduate", "postgraduate", "recent_graduate"];
const INSTITUTIONS = ["university", "polytechnic", "secondary", "bootcamp", "none"];

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

function paramsFor(type: RuleType, r: () => number): Record<string, unknown> {
  switch (type) {
    case "country_in":
    case "country_not_in":
    case "nationality_in":
    case "residency_required":
      return { countries: [pick(r, COUNTRIES), pick(r, COUNTRIES)] };
    case "age_between":
      return { min: 16 + Math.floor(r() * 6), max: 22 + Math.floor(r() * 10) };
    case "student_status_in":
      return { statuses: [pick(r, STATUSES)] };
    case "year_of_study_in":
      return { years: [1 + Math.floor(r() * 4)] };
    case "institution_type_in":
      return { types: [pick(r, INSTITUTIONS)] };
    case "experience_between":
      return { min: 0, max: 1 + Math.floor(r() * 8) };
    case "team_size_between":
      return { min: 2, max: 5 };
    case "gender_restricted":
      return { genders: ["female"] };
    case "language_required":
      return { languages: ["English", "French"] };
    case "cost":
      return { kind: pick(r, ["free", "paid", "unknown"]) };
    case "other_unstructured":
      return { text: "an unstructured requirement" };
    default:
      return {};
  }
}

function randomRule(r: () => number): EligibilityRule {
  const type = pick(r, RULE_TYPES);
  // Deliberately include blank quotes and out-of-band confidences so the engine
  // is exercised against malformed rows, not only well-formed ones.
  const blankQuote = r() < 0.08;
  return {
    rule_type: type,
    params: r() < 0.08 ? {} : paramsFor(type, r),
    source_quote: blankQuote ? (r() < 0.5 ? "" : "   ") : `Source sentence for ${type}.`,
    confidence: Math.round(r() * 100) / 100,
  };
}

function randomInput(r: () => number): EligibilityInput {
  const maybe = <T>(v: T): T | null => (r() < 0.3 ? null : v);
  return {
    country_of_residence: maybe(pick(r, COUNTRIES)),
    nationalities: maybe([pick(r, COUNTRIES)]),
    birth_year: maybe(1996 + Math.floor(r() * 14)),
    student_status: maybe(pick(r, STATUSES)) as EligibilityInput["student_status"],
    year_of_study: maybe(1 + Math.floor(r() * 5)),
    institution_type: maybe(pick(r, INSTITUTIONS)) as EligibilityInput["institution_type"],
    years_experience: maybe(Math.floor(r() * 10)),
    languages: maybe([pick(r, ["English", "French", "Portuguese"])]),
    gender: maybe(pick(r, ["female", "male", "other"])),
    can_travel: maybe(r() < 0.5),
    remote_only: maybe(r() < 0.5),
  };
}

function* fuzzCases(count: number, seed = 20260913) {
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const ruleCount = Math.floor(r() * 5); // 0..4, so empty sets are covered
    const rules = Array.from({ length: ruleCount }, () => randomRule(r));
    yield { rules, input: randomInput(r), index: i };
  }
}

const FUZZ_N = 4000;

describe("invariant 3 — ambiguity is never `eligible`", () => {
  it("only returns `eligible` when every gating rule passes, at or above the confidence floor, with a real source quote", () => {
    for (const { rules, input, index } of fuzzCases(FUZZ_N)) {
      const result = evaluate(rules, input, { asOf: AS_OF });
      if (result.verdict !== "eligible") continue;

      const gating = result.rule_results.filter((x) => !isInformational(x.rule_type));
      expect(gating.length, `case ${index}: eligible with no gating rules`).toBeGreaterThan(0);

      for (const ruleResult of gating) {
        expect(ruleResult.outcome, `case ${index}`).toBe("pass");
        expect(ruleResult.confidence, `case ${index}`).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
        expect(ruleResult.source_quote.trim().length, `case ${index}`).toBeGreaterThan(0);
      }
    }
  });

  it("never returns `eligible` when a rule carries no source quote", () => {
    for (const { rules, input, index } of fuzzCases(FUZZ_N)) {
      const result = evaluate(rules, input, { asOf: AS_OF });
      const blank = rules.some(
        (rule) => !isInformational(rule.rule_type) && rule.source_quote.trim().length === 0,
      );
      if (blank) {
        expect(result.verdict, `case ${index}`).not.toBe("eligible");
      }
    }
  });
});

describe("a low-confidence high-stakes rule decides nothing, in either direction", () => {
  for (const type of ["country_in", "country_not_in", "nationality_in", "age_between", "student_status_in"] as const) {
    it(`${type} below the floor yields unclear`, () => {
      const r = rng(7);
      for (let i = 0; i < 200; i++) {
        const rule: EligibilityRule = {
          rule_type: type,
          params: paramsFor(type, r),
          source_quote: "A real sentence from the document.",
          confidence: Math.round(r() * HIGH_STAKES_CONFIDENCE_FLOOR * 100) / 100 * 0.99,
        };
        if (rule.confidence >= HIGH_STAKES_CONFIDENCE_FLOOR) continue;
        const result = evaluate([rule], randomInput(r), { asOf: AS_OF });
        expect(result.verdict, `${type} @ ${rule.confidence}`).toBe("unclear");
      }
    });
  }
});

describe("totality and determinism (SYSTEM_ARCHITECTURE.md §7)", () => {
  it("always returns one of the four verdicts and never throws", () => {
    for (const { rules, input, index } of fuzzCases(FUZZ_N)) {
      const result = evaluate(rules, input, { asOf: AS_OF });
      expect(VERDICTS, `case ${index}`).toContain(result.verdict);
      expect(result.rule_results).toHaveLength(rules.length);
      expect(result.disclaimer.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic for identical inputs", () => {
    for (const { rules, input } of fuzzCases(500, 4242)) {
      const a = evaluate(rules, input, { asOf: AS_OF });
      const b = evaluate(rules, input, { asOf: AS_OF });
      expect(a).toEqual(b);
    }
  });

  it("reports missing_fields as exactly the fields its unknown rules name", () => {
    for (const { rules, input, index } of fuzzCases(FUZZ_N)) {
      const result = evaluate(rules, input, { asOf: AS_OF });
      const expected = [
        ...new Set(
          result.rule_results
            .filter((x) => !isInformational(x.rule_type) && x.outcome === "unknown")
            .flatMap((x) => x.resolves_with),
        ),
      ];
      expect([...result.missing_fields].sort(), `case ${index}`).toEqual(expected.sort());
    }
  });

  it("treats an empty rule set as unclear, never as eligible", () => {
    const result = evaluate([], { country_of_residence: "ZW" }, { asOf: AS_OF });
    expect(result.verdict).toBe("unclear");
    expect(result.rule_results).toEqual([]);
    expect(result.confidence).toBe(0);
  });
});
