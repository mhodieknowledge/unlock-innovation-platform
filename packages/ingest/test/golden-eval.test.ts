/**
 * The extraction quality gate. AI_SYSTEM.md §12 `[PR]`.
 *
 *   | Metric                  | Target  | If breached                          |
 *   | Deadline exact-match    | >= 0.90 | roll back the prompt version         |
 *   | Country-eligibility F1  | >= 0.92 | roll back; raise the confidence gate |
 *   | Quote-verbatim pass     | >= 0.98 | investigate immediately — the trust invariant |
 *   | Schema-valid rate       | >= 0.95 | add a repair step                    |
 *   | False `eligible` rate   | 0       | STOP auto-publish until resolved     |
 *
 * "A false `eligible` is treated as a SEVERITY-1 DEFECT, not a quality metric. The
 * system is allowed to be unhelpful; it is not allowed to be wrong about
 * eligibility."
 *
 * It runs against RECORDED model replies, which is what makes it a gate rather than a
 * weather report: no API key, the same answer twice, and it measures exactly what the
 * deterministic validators do with a given model output. `npm run golden:record`
 * refreshes the recordings from live providers, which is how a prompt change is
 * evaluated before it ships.
 *
 * The fixtures are SYNTHETIC and say so. §12 asks for 60 hand-labelled real
 * opportunities; eval/golden/README.md records exactly what closing that gap needs and
 * why a coding agent inventing them would be worse than the gap.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { evaluate } from "@mbele/eligibility";
import type { EligibilityInput, EligibilityRule } from "@mbele/eligibility";
import { detectFeeLanguage, parseJsonLoose, validateExtraction, validateRules } from "../src/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** §12's thresholds, verbatim. */
const TARGETS = {
  deadline_exact_match: 0.9,
  country_f1: 0.92,
  quote_verbatim_pass: 0.98,
  schema_valid: 0.95,
} as const;

interface ExpectedRule {
  rule_type: string;
  countries?: string[];
  region?: string;
  expect_country_count?: number;
}

interface GoldenCase {
  id: string;
  synthetic: boolean;
  /**
   * Failure modes this case deliberately contains.
   *
   * §12's quote-verbatim pass rate is a measure of the MODEL's output on a
   * representative set. A fixture set built entirely out of traps would score badly on
   * it by design, and failing the build on that would be measuring the fixture design
   * rather than the system. So a declared trap is excluded from the aggregate metric
   * AND asserted individually, which is the stronger check of the two.
   */
  traps?: string[];
  note: string;
  document: string;
  profile?: EligibilityInput;
  expected: {
    deadline_at?: string | null;
    deadline_precision?: string | null;
    eligibility_scope?: string;
    eligible_countries?: string[];
    cost?: string;
    verdict?: string;
    rules?: ExpectedRule[];
    schema_invalid_expected?: boolean;
    fee_expected?: boolean;
    summary_expected?: null;
    contradiction_expected?: boolean;
  };
  recorded: { prompt_version: string; extract_reply: string; rules_reply: string };
}

const fixtures = JSON.parse(
  readFileSync(join(ROOT, "eval/golden/synthetic.json"), "utf8"),
) as { cases: GoldenCase[] };

// Reference data, stated here rather than hidden: the whole point of §5 rule 2 is that
// country lists come from OUR data and never from a model's.
const AFRICAN_54 = [
  "DZ","AO","BJ","BW","BF","BI","CM","CV","CF","TD","KM","CD","CG","CI","DJ","EG","GQ",
  "ER","SZ","ET","GA","GM","GH","GN","GW","KE","LS","LR","LY","MG","MW","ML","MR","MU",
  "MA","MZ","NA","NE","NG","RW","ST","SN","SC","SL","SO","ZA","SS","SD","TZ","TG","TN",
  "UG","ZM","ZW",
];
const KNOWN_COUNTRIES = new Set([...AFRICAN_54, "US", "GB", "IN", "CN", "BR", "FR", "DE"]);
const REGIONS: Record<string, string[]> = { africa_wide: AFRICAN_54 };
const RULE_TYPES = [
  "country_in","country_not_in","nationality_in","residency_required","age_between",
  "student_status_in","year_of_study_in","institution_type_in","experience_between",
  "language_required","gender_restricted","travel_required","team_size_between",
  "individual_only","team_only","cost","other_unstructured",
];

interface CaseResult {
  id: string;
  note: string;
  deadlineChecked: boolean;
  deadlineMatched: boolean;
  countryTp: number;
  countryFp: number;
  countryFn: number;
  rulesKept: number;
  quoteFailures: number;
  traps: string[];
  schemaOk: boolean;
  falseEligible: string | null;
  noteLines: string[];
}

const results: CaseResult[] = [];

beforeAll(() => {
  for (const testCase of fixtures.cases) {
    const expected = testCase.expected ?? {};
    const noteLines: string[] = [];

    // ── Schema-valid rate ───────────────────────────────────────────────────
    const parsed = parseJsonLoose(testCase.recorded.extract_reply);
    const validated =
      parsed === null
        ? null
        : validateExtraction(parsed, {
            sourceText: testCase.document,
            knownCountries: KNOWN_COUNTRIES,
          });
    const discarded = validated === null || validated.issues.some((i) => i.effect === "discard");

    // A case whose point is that a refusal is HANDLED counts as correct behaviour when
    // the record is discarded, not as an invalid schema.
    const schemaOk = expected.schema_invalid_expected ? discarded : !discarded;

    const record = (validated?.record ?? {}) as Record<string, unknown>;

    // ── Deadline exact match ────────────────────────────────────────────────
    const deadlineChecked =
      expected.deadline_at !== undefined && !expected.schema_invalid_expected;
    const deadlineMatched =
      deadlineChecked && (record["deadline_at"] ?? null) === expected.deadline_at;

    // ── Country F1 ──────────────────────────────────────────────────────────
    let countryTp = 0;
    let countryFp = 0;
    let countryFn = 0;
    if (Array.isArray(expected.eligible_countries) && !expected.schema_invalid_expected) {
      const predicted = new Set((record["eligible_countries"] as string[]) ?? []);
      const truth = new Set(expected.eligible_countries);
      for (const code of predicted) if (truth.has(code)) countryTp += 1;
      countryFp = predicted.size - countryTp;
      countryFn = truth.size - countryTp;
    }

    // ── Quote-verbatim pass rate: THE trust invariant ───────────────────────
    const ruleReply = parseJsonLoose(testCase.recorded.rules_reply);
    const candidates =
      ruleReply !== null && typeof ruleReply === "object" && Array.isArray((ruleReply as { rules?: unknown }).rules)
        ? (ruleReply as { rules: unknown[] }).rules
        : [];
    const { rules, rejected } = validateRules(candidates, {
      sourceText: testCase.document,
      knownCountries: KNOWN_COUNTRIES,
      knownRuleTypes: RULE_TYPES,
      expandRegions: (codes: string[]) => codes.flatMap((c) => REGIONS[c] ?? []),
    });
    const quoteFailures = rejected.filter((r) => r.reason.includes("verbatim")).length;

    // ── False `eligible`: run the real engine over what the pipeline derived ─
    let falseEligible: string | null = null;
    if (testCase.profile && expected.verdict) {
      const derived = evaluate(rules as EligibilityRule[], testCase.profile).verdict;
      const claimsEligible = derived === "eligible" || derived === "likely_eligible";
      if (claimsEligible && expected.verdict === "not_eligible") {
        falseEligible = `derived "${derived}" where the truth is "not_eligible"`;
      }
      noteLines.push(`verdict: derived ${derived}, truth ${expected.verdict}`);
    }

    // ── Case-specific expectations the aggregate metrics do not cover ────────
    if (expected.fee_expected) {
      const fee = detectFeeLanguage(testCase.document);
      noteLines.push(
        fee.hit
          ? "fee detected deterministically, overriding the model's `free`"
          : "FEE MISSED — invariant 13 depends on this",
      );
      if (!fee.hit) falseEligible = "a fee to apply was not detected";
    }
    if (expected.summary_expected === null) {
      noteLines.push(
        record["summary"] ? "SUMMARY KEPT — a copied summary should have been dropped" : "copied summary dropped",
      );
    }
    if (expected.contradiction_expected) {
      const hasIn = rules.some((r) => r.rule_type === "country_in");
      const hasNotIn = rules.some((r) => r.rule_type === "country_not_in");
      noteLines.push(
        hasIn && hasNotIn
          ? "both sides of the contradiction kept, with their quotes"
          : "contradiction not represented",
      );
    }
    const regionRule = (expected.rules ?? []).find((r) => r.expect_country_count);
    if (regionRule) {
      const rule = rules.find((r) => r.rule_type === "country_in");
      const countries = rule?.params["countries"];
      const count = Array.isArray(countries) ? countries.length : 0;
      noteLines.push(
        count === regionRule.expect_country_count
          ? `region expanded to ${count} countries from our own table`
          : `region expanded to ${count}, expected ${regionRule.expect_country_count}`,
      );
    }

    results.push({
      id: testCase.id,
      note: testCase.note,
      traps: testCase.traps ?? [],
      deadlineChecked,
      deadlineMatched,
      countryTp,
      countryFp,
      countryFn,
      rulesKept: rules.length,
      quoteFailures,
      schemaOk,
      falseEligible,
      noteLines,
    });
  }
});

function metrics() {
  const deadlineChecked = results.filter((r) => r.deadlineChecked).length;
  const deadlineMatched = results.filter((r) => r.deadlineMatched).length;
  const tp = results.reduce((n, r) => n + r.countryTp, 0);
  const fp = results.reduce((n, r) => n + r.countryFp, 0);
  const fn = results.reduce((n, r) => n + r.countryFn, 0);
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  // Ordinary cases only — see the note on GoldenCase.traps.
  const ordinary = results.filter((r) => !r.traps.includes("non_verbatim_quote"));
  const kept = ordinary.reduce((n, r) => n + r.rulesKept, 0);
  const quoteFailures = ordinary.reduce((n, r) => n + r.quoteFailures, 0);

  return {
    deadline_exact_match: deadlineChecked === 0 ? 0 : deadlineMatched / deadlineChecked,
    country_f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    quote_verbatim_pass: kept + quoteFailures === 0 ? 0 : kept / (kept + quoteFailures),
    schema_valid: results.length === 0 ? 0 : results.filter((r) => r.schemaOk).length / results.length,
    kept,
    quoteFailures,
  };
}

describe("extraction quality gate (AI_SYSTEM.md §12)", () => {
  it("measured something — an empty gate is not a gate", () => {
    expect(results.length).toBe(fixtures.cases.length);
    expect(results.length).toBeGreaterThanOrEqual(8);
    const m = metrics();
    // A run where no rule survived would score a perfect quote-pass rate by
    // measuring nothing, which is exactly the vacuous pass this repository has been
    // bitten by before.
    expect(m.kept).toBeGreaterThan(0);
  });

  it("reports what it measured, and on what", () => {
    const m = metrics();
    const lines = [
      "",
      `  Extraction quality gate — recorded replies, ${results.length} case(s)`,
      "",
    ];
    for (const r of results) {
      lines.push(`  ${r.id}  ${r.note}`);
      lines.push(`        ${r.rulesKept} rule(s) kept${r.quoteFailures > 0 ? `, ${r.quoteFailures} rejected for a quote not in the document` : ""}`);
      for (const note of r.noteLines) lines.push(`        ${note}`);
    }
    lines.push("");
    lines.push("  metric                    value   target");
    for (const [name, target] of Object.entries(TARGETS)) {
      const value = m[name as keyof typeof TARGETS];
      lines.push(`  ${value >= target ? "✓" : "✗"} ${name.padEnd(24)} ${value.toFixed(3)}   ${target.toFixed(2)}`);
    }
    lines.push(`  ${results.every((r) => !r.falseEligible) ? "✓" : "✗"} ${"false_eligible".padEnd(24)} ${results.filter((r) => r.falseEligible).length}       0`);
    lines.push("");
    lines.push(
      `  ${results.filter((r) => r.traps.length > 0).length} case(s) carry a declared trap; those are asserted individually and`,
    );
    lines.push("  excluded from the quote-verbatim rate, which measures ordinary model output.");
    lines.push("");
    lines.push(`  All ${fixtures.cases.filter((c) => c.synthetic).length} fixtures are SYNTHETIC. §12 asks for 60 hand-labelled REAL`);
    lines.push("  opportunities; eval/golden/README.md records what closing that gap needs.");
    console.log(lines.join("\n"));
    expect(true).toBe(true);
  });

  it("meets the deadline exact-match target", () => {
    expect(metrics().deadline_exact_match).toBeGreaterThanOrEqual(TARGETS.deadline_exact_match);
  });

  it("meets the country-eligibility F1 target", () => {
    expect(metrics().country_f1).toBeGreaterThanOrEqual(TARGETS.country_f1);
  });

  it("meets the quote-verbatim pass rate — the trust invariant", () => {
    expect(metrics().quote_verbatim_pass).toBeGreaterThanOrEqual(TARGETS.quote_verbatim_pass);
  });

  it("meets the schema-valid rate", () => {
    expect(metrics().schema_valid).toBeGreaterThanOrEqual(TARGETS.schema_valid);
  });

  it("has a FALSE ELIGIBLE RATE OF ZERO — §12 severity 1", () => {
    // "The system is allowed to be unhelpful; it is not allowed to be wrong about
    // eligibility." One occurrence stops auto-publish.
    const offenders = results.filter((r) => r.falseEligible);
    expect(
      offenders.map((r) => `${r.id}: ${r.falseEligible}`),
      "a false `eligible` is a severity-1 defect, not a quality metric",
    ).toEqual([]);
  });

  it("catches every declared trap", () => {
    // The stronger half of the trap handling: each one is checked for the specific
    // failure it sets, rather than diluted into an average.
    const byId = new Map(results.map((r) => [r.id, r]));

    // A paraphrase presented as a quote is discarded.
    expect(byId.get("G02")?.quoteFailures).toBe(1);
    // An invented country list under an africa_wide scope is dropped entirely.
    expect(byId.get("G03")?.countryFp).toBe(0);
    // An ambiguous date is refused rather than guessed.
    expect(byId.get("G04")?.deadlineMatched).toBe(true);
    // A fee the model called free is caught deterministically.
    expect(byId.get("G05")?.noteLines.some((n) => n.includes("fee detected"))).toBe(true);
    // A copied summary is dropped.
    expect(byId.get("G06")?.noteLines.some((n) => n.includes("copied summary dropped"))).toBe(true);
    // A refusal stores nothing.
    expect(byId.get("G07")?.rulesKept).toBe(0);
  });

  it("rejects the paraphrased quote in G02 while keeping the real rule", () => {
    // The single most important case in the set: a model returning a sentence that
    // sounds exactly like the page but is not on it.
    const g02 = results.find((r) => r.id === "G02");
    expect(g02?.quoteFailures).toBe(1);
    expect(g02?.rulesKept).toBe(1);
  });

  it("handles a model refusal without storing anything", () => {
    const g07 = results.find((r) => r.id === "G07");
    expect(g07?.schemaOk).toBe(true);
    expect(g07?.rulesKept).toBe(0);
  });
});
