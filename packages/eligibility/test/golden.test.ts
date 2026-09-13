import { describe, expect, it } from "vitest";

import { chargesFeeToApply, evaluate, isInformational, RULE_TYPES } from "../src/index.js";
import type { EligibilityInput, EligibilityRule, Verdict } from "../src/index.js";
import corpus from "./golden/golden-corpus.json" with { type: "json" };

interface GoldenCase {
  id: string;
  name: string;
  covers: string[];
  rules: EligibilityRule[];
  input: EligibilityInput;
  as_of?: string;
  expect: {
    verdict: Verdict;
    missing_fields: string[];
    charges_fee?: boolean;
  };
}

const CASES = corpus.cases as unknown as GoldenCase[];
const DEFAULT_AS_OF = new Date(corpus.as_of_default);

describe("golden corpus", () => {
  it("holds exactly 60 cases, as AI_SYSTEM.md §12 requires", () => {
    expect(CASES).toHaveLength(60);
  });

  it("has unique, sequential case ids", () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(CASES.map((_, i) => `C${String(i + 1).padStart(2, "0")}`));
  });

  it("covers every rule_type in DATA_MODEL.md §5.1", () => {
    const covered = new Set(CASES.flatMap((c) => c.rules.map((r) => r.rule_type)));
    const missing = RULE_TYPES.filter((t) => !covered.has(t));
    expect(missing, `rule types with no fixture: ${missing.join(", ")}`).toEqual([]);
  });

  it("covers all six Tier-1 countries (CONTENT_AND_LAUNCH.md §2)", () => {
    const blob = JSON.stringify(CASES);
    for (const iso2 of ["ZW", "ZM", "BW", "NA", "MW", "MZ"]) {
      expect(blob, `no fixture mentions ${iso2}`).toContain(`"${iso2}"`);
    }
  });

  it("covers all four verdicts (PRODUCT_SPEC.md §12.3)", () => {
    const verdicts = new Set(CASES.map((c) => c.expect.verdict));
    expect([...verdicts].sort()).toEqual([
      "eligible",
      "likely_eligible",
      "not_eligible",
      "unclear",
    ]);
  });

  for (const testCase of CASES) {
    it(`${testCase.id} — ${testCase.name}`, () => {
      const asOf = testCase.as_of ? new Date(testCase.as_of) : DEFAULT_AS_OF;
      const result = evaluate(testCase.rules, testCase.input, { asOf });

      expect(result.verdict).toBe(testCase.expect.verdict);
      expect([...result.missing_fields].sort()).toEqual(
        [...testCase.expect.missing_fields].sort(),
      );

      if (testCase.expect.charges_fee !== undefined) {
        expect(chargesFeeToApply(testCase.rules)).toBe(testCase.expect.charges_fee);
      }

      // Every rule is accounted for in the output, so the UI can always render
      // a per-rule breakdown (PRODUCT_SPEC.md §12.4).
      expect(result.rule_results).toHaveLength(testCase.rules.length);
      expect(result.disclaimer).toMatch(/Always confirm on the official page/);
    });
  }
});

describe("golden corpus — invariant 3 across every case", () => {
  it("never returns `eligible` where any gating rule is unresolved", () => {
    for (const testCase of CASES) {
      const asOf = testCase.as_of ? new Date(testCase.as_of) : DEFAULT_AS_OF;
      const result = evaluate(testCase.rules, testCase.input, { asOf });
      if (result.verdict !== "eligible") continue;

      for (const ruleResult of result.rule_results) {
        if (isInformational(ruleResult.rule_type)) continue;
        expect(ruleResult.outcome, `${testCase.id} ${ruleResult.rule_type}`).toBe("pass");
        expect(ruleResult.source_quote.trim().length, testCase.id).toBeGreaterThan(0);
      }
    }
  });
});
