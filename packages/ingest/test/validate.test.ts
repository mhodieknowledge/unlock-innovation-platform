/**
 * Deterministic post-validation of model output. AI_SYSTEM.md §2, §4, §5, §10.
 *
 * §12's severity-1 defect is a false `eligible`, and the route to one runs straight
 * through this file: a rule accepted without a real quote, a country code the model
 * invented, a deadline parsed a month wrong. Each test below is one of those routes,
 * closed.
 */

import { describe, expect, it } from "vitest";

import {
  clearsConfidenceFloors,
  detectFeeLanguage,
  parseDeadline,
  validateCountryCodes,
  validateExtraction,
  validateRules,
} from "../src/validate.mjs";

const KNOWN_COUNTRIES = ["ZW", "ZM", "MW", "KE", "NG", "ZA", "GH", "BW", "NA", "US", "GB"];

const RULE_TYPES = [
  "country_in",
  "country_not_in",
  "nationality_in",
  "residency_required",
  "age_between",
  "student_status_in",
  "year_of_study_in",
  "institution_type_in",
  "experience_between",
  "language_required",
  "gender_restricted",
  "travel_required",
  "team_size_between",
  "individual_only",
  "team_only",
  "cost",
  "other_unstructured",
];

const SOURCE = `
Southern Africa Climate Innovation Grant

Applicants must be resident in Zimbabwe, Zambia or Malawi at the time of application.
Applicants must be aged between 18 and 30 on 1 January 2027.
Teams of two to five people are required.

Applications close on 15 March 2027 at 23:59 CAT. There is no fee to apply.
`;

describe("validateCountryCodes", () => {
  it("keeps codes we recognise", () => {
    expect(validateCountryCodes(["ZW", "zm"], KNOWN_COUNTRIES).valid).toEqual(["ZW", "ZM"]);
  });

  it("rejects two-letter strings that are not country codes", () => {
    // Shape alone is not enough: "UK" and "EU" are both two uppercase letters, and
    // a model asked for African countries will occasionally produce "AF".
    const { valid, invalid } = validateCountryCodes(["UK", "EU", "AF", "ZW"], KNOWN_COUNTRIES);
    expect(valid).toEqual(["ZW"]);
    expect(invalid).toEqual(["UK", "EU", "AF"]);
  });

  it("de-duplicates", () => {
    expect(validateCountryCodes(["ZW", "ZW", "zw"], KNOWN_COUNTRIES).valid).toEqual(["ZW"]);
  });

  it("treats a non-array as no codes rather than throwing", () => {
    expect(validateCountryCodes("ZW", KNOWN_COUNTRIES).valid).toEqual([]);
    expect(validateCountryCodes(null, KNOWN_COUNTRIES).valid).toEqual([]);
  });
});

describe("parseDeadline", () => {
  it("accepts ISO 8601", () => {
    expect(parseDeadline("2027-03-15")?.toISOString()).toBe("2027-03-15T00:00:00.000Z");
    expect(parseDeadline("2027-03-15T23:59:00Z")?.toISOString()).toBe("2027-03-15T23:59:00.000Z");
    expect(parseDeadline("2027-03-15T23:59:00+02:00")?.toISOString()).toBe(
      "2027-03-15T21:59:00.000Z",
    );
  });

  it("REFUSES ambiguous formats rather than guessing", () => {
    // "03/04/2026" is 3 April or 4 March depending on the runtime's locale, and a
    // deadline wrong by a month is the worst defect this product can ship.
    expect(parseDeadline("03/04/2026")).toBeNull();
    expect(parseDeadline("15 March 2027")).toBeNull();
    expect(parseDeadline("March 15, 2027")).toBeNull();
    expect(parseDeadline("next Friday")).toBeNull();
  });

  it("refuses a date far outside the plausible range", () => {
    expect(parseDeadline("1970-01-01")).toBeNull();
    expect(parseDeadline("2999-01-01")).toBeNull();
  });

  it("refuses a non-string", () => {
    expect(parseDeadline(20270315)).toBeNull();
    expect(parseDeadline(null)).toBeNull();
  });
});

describe("validateExtraction", () => {
  const good = {
    title: "Southern Africa Climate Innovation Grant",
    summary: "Funding for early-stage climate ventures run by young people in southern Africa.",
    organisation_name: "Example Foundation",
    eligibility_scope: "country_list",
    eligible_countries: ["ZW", "ZM", "MW"],
    cost: "free",
    participation_mode: "online",
    team: { required: true, min: 2, max: 5 },
    prize: { amount: 10000, currency: "USD" },
    deadline: {
      value: "2027-03-15T23:59:00+02:00",
      precision: "exact_time",
      timezone: "Africa/Harare",
      raw_string: "Applications close on 15 March 2027 at 23:59 CAT.",
    },
    field_confidence: { title: 0.98, deadline: 0.93, eligible_countries: 0.95, cost: 0.99 },
    confidence: 0.92,
  };

  const context = { sourceText: SOURCE, knownCountries: KNOWN_COUNTRIES, now: new Date("2026-09-14T00:00:00Z") };

  it("accepts a well-formed record", () => {
    const { record, issues } = validateExtraction(good, context);
    expect(issues).toEqual([]);
    expect(record["title"]).toBe("Southern Africa Climate Innovation Grant");
    expect(record["eligible_countries"]).toEqual(["ZW", "ZM", "MW"]);
    expect(record["deadline_at"]).toBe("2027-03-15T21:59:00.000Z");
  });

  it("discards a record with no title — there is nothing to publish", () => {
    const { issues } = validateExtraction({ ...good, title: "" }, context);
    expect(issues.some((i) => i.effect === "discard")).toBe(true);
  });

  it("discards output that is not an object at all", () => {
    expect(validateExtraction("sorry, I cannot help with that", context).issues[0]?.effect).toBe(
      "discard",
    );
    expect(validateExtraction(null, context).issues[0]?.effect).toBe("discard");
  });

  it("drops a summary that copies the source (§2.1 rule 6)", () => {
    const copied = {
      ...good,
      summary: "Applicants must be resident in Zimbabwe, Zambia or Malawi at the time of application.",
    };
    const { record, issues } = validateExtraction(copied, context);
    expect(record["summary"]).toBeUndefined();
    expect(issues.find((i) => i.field === "summary")?.effect).toBe("drop_field");
    // The rest of the record survives: a copied summary is not a reason to lose a
    // correct deadline.
    expect(record["deadline_at"]).toBe("2027-03-15T21:59:00.000Z");
  });

  it("drops a deadline whose quoted text is not in the source", () => {
    // §4: "deadline.raw_string must appear verbatim in the source text." A deadline
    // with invented supporting text is the most expensive thing to get wrong.
    const invented = {
      ...good,
      deadline: { ...good.deadline, raw_string: "Applications close on 15 April 2027." },
    };
    const { record, issues } = validateExtraction(invented, context);
    expect(record["deadline_at"]).toBeUndefined();
    expect(issues.find((i) => i.field === "deadline")?.problem).toContain("not in the source");
  });

  it("drops an unparseable deadline rather than storing a guess", () => {
    const { record } = validateExtraction(
      { ...good, deadline: { ...good.deadline, value: "15 March 2027" } },
      context,
    );
    expect(record["deadline_at"]).toBeUndefined();
  });

  it("flags a deadline already in the past and downgrades its precision", () => {
    const past = {
      ...good,
      deadline: {
        value: "2026-01-01T00:00:00Z",
        precision: "exact_time",
        raw_string: "",
      },
    };
    const { record, issues } = validateExtraction(past, context);
    expect(record["deadline_precision"]).toBe("unknown");
    expect(issues.find((i) => i.field === "deadline")?.effect).toBe("review");
  });

  it("reviews invented country codes but keeps the valid ones", () => {
    const { record, issues } = validateExtraction(
      { ...good, eligible_countries: ["ZW", "XX", "UK"] },
      context,
    );
    expect(record["eligible_countries"]).toEqual(["ZW"]);
    expect(issues.find((i) => i.field === "eligible_countries")?.effect).toBe("review");
  });

  it("reviews a country_list scope with no countries in it", () => {
    const { issues } = validateExtraction({ ...good, eligible_countries: [] }, context);
    expect(issues.find((i) => i.field === "eligible_countries")?.effect).toBe("review");
  });

  it("drops a prize in a currency we do not recognise", () => {
    const { record, issues } = validateExtraction(
      { ...good, prize: { amount: 5000, currency: "XYZ" } },
      context,
    );
    expect(record["prize_amount"]).toBeUndefined();
    expect(issues.find((i) => i.field === "prize")?.problem).toContain("ISO 4217");
  });

  it("drops an inverted team range", () => {
    const { record, issues } = validateExtraction(
      { ...good, team: { required: true, min: 5, max: 2 } },
      context,
    );
    expect(record["team_size_min"]).toBeUndefined();
    expect(record["team_size_max"]).toBeUndefined();
    expect(issues.find((i) => i.field === "team")).toBeDefined();
  });

  it("falls back to unclear rather than inventing a scope", () => {
    const { record } = validateExtraction({ ...good, eligibility_scope: "pan_african" }, context);
    expect(record["eligibility_scope"]).toBe("unclear");
  });

  it("falls back to unknown rather than inventing a cost — invariant 13 turns on this", () => {
    const { record } = validateExtraction({ ...good, cost: "probably free" }, context);
    expect(record["cost"]).toBe("unknown");
  });

  it("takes the WEAKEST field confidence when the model gives no overall score", () => {
    // An average lets a confident title carry an unreliable deadline.
    const { confidence } = validateExtraction(
      {
        ...good,
        confidence: undefined,
        field_confidence: { title: 0.99, deadline: 0.4, eligible_countries: 0.99 },
      },
      context,
    );
    expect(confidence["overall"]).toBe(0.4);
  });
});

describe("clearsConfidenceFloors", () => {
  it("requires 0.75 overall and 0.80 on deadline and countries (§4)", () => {
    expect(clearsConfidenceFloors({ overall: 0.8, deadline: 0.9, eligible_countries: 0.9 })).toBe(true);
    expect(clearsConfidenceFloors({ overall: 0.74, deadline: 0.9, eligible_countries: 0.9 })).toBe(false);
    expect(clearsConfidenceFloors({ overall: 0.9, deadline: 0.79, eligible_countries: 0.9 })).toBe(false);
    expect(clearsConfidenceFloors({ overall: 0.9, deadline: 0.9, eligible_countries: 0.79 })).toBe(false);
  });

  it("treats a missing score as failing, never as passing", () => {
    expect(clearsConfidenceFloors({})).toBe(false);
  });
});

describe("validateRules", () => {
  const context = {
    sourceText: SOURCE,
    knownCountries: KNOWN_COUNTRIES,
    knownRuleTypes: RULE_TYPES,
    expandRegions: (codes: string[]) =>
      codes.includes("southern_africa") ? ["ZW", "ZM", "MW", "BW", "NA", "ZA"] : [],
  };

  it("accepts a rule whose quote is really in the document", () => {
    const { rules, rejected } = validateRules(
      [
        {
          rule_type: "country_in",
          params: { countries: ["ZW", "ZM", "MW"] },
          source_quote:
            "Applicants must be resident in Zimbabwe, Zambia or Malawi at the time of application.",
          confidence: 0.94,
        },
      ],
      context,
    );
    expect(rejected).toEqual([]);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.params["countries"]).toEqual(["ZW", "ZM", "MW"]);
  });

  it("REJECTS a rule with no quote", () => {
    const { rules, rejected } = validateRules(
      [{ rule_type: "age_between", params: { min: 18, max: 30 }, confidence: 0.9 }],
      context,
    );
    expect(rules).toEqual([]);
    expect(rejected[0]?.reason).toBe("no source_quote");
  });

  it("REJECTS a rule whose quote is not in the document, however confident", () => {
    // The trust invariant. A model's confidence is irrelevant here by design.
    const { rules, rejected } = validateRules(
      [
        {
          rule_type: "country_in",
          params: { countries: ["KE"] },
          source_quote: "Applicants must be resident in Kenya.",
          confidence: 0.99,
        },
      ],
      context,
    );
    expect(rules).toEqual([]);
    expect(rejected[0]?.reason).toContain("not verbatim");
  });

  it("REJECTS an unknown rule type instead of storing it", () => {
    const { rejected } = validateRules(
      [
        {
          rule_type: "must_be_cool",
          params: {},
          source_quote: "Applicants must be aged between 18 and 30 on 1 January 2027.",
          confidence: 0.9,
        },
      ],
      context,
    );
    expect(rejected[0]?.reason).toContain("unknown rule_type");
  });

  it("REJECTS a rule with no usable confidence", () => {
    const quote = "Applicants must be aged between 18 and 30 on 1 January 2027.";
    expect(validateRules([{ rule_type: "age_between", params: {}, source_quote: quote }], context).rejected)
      .toHaveLength(1);
    expect(
      validateRules(
        [{ rule_type: "age_between", params: {}, source_quote: quote, confidence: 1.4 }],
        context,
      ).rejected,
    ).toHaveLength(1);
  });

  it("expands region words using OUR table, never the model's country list", () => {
    // §5 rule 2. A model asked to list southern African countries will give a
    // different set each time, and the failure is silent.
    const { rules } = validateRules(
      [
        {
          rule_type: "country_in",
          params: { regions: ["southern_africa"] },
          source_quote:
            "Applicants must be resident in Zimbabwe, Zambia or Malawi at the time of application.",
          confidence: 0.9,
        },
      ],
      context,
    );
    expect(rules[0]?.params["countries"]).toEqual(["ZW", "ZM", "MW", "BW", "NA", "ZA"]);
    expect(rules[0]?.params["regions"]).toBeUndefined();
  });

  it("REJECTS a country rule whose codes are all invented", () => {
    const { rules, rejected } = validateRules(
      [
        {
          rule_type: "country_in",
          params: { countries: ["XX", "YY"] },
          source_quote:
            "Applicants must be resident in Zimbabwe, Zambia or Malawi at the time of application.",
          confidence: 0.9,
        },
      ],
      context,
    );
    expect(rules).toEqual([]);
    expect(rejected[0]?.reason).toContain("no valid country codes");
  });

  it("survives junk without throwing — one bad rule must not lose the good ones", () => {
    const { rules } = validateRules(
      [
        null,
        "not a rule",
        42,
        {
          rule_type: "age_between",
          params: { min: 18, max: 30 },
          source_quote: "Applicants must be aged between 18 and 30 on 1 January 2027.",
          confidence: 0.91,
        },
      ],
      context,
    );
    expect(rules).toHaveLength(1);
  });

  it("treats a non-array as no rules", () => {
    expect(validateRules(null, context).rules).toEqual([]);
    expect(validateRules({ rule_type: "country_in" }, context).rules).toEqual([]);
  });
});

describe("detectFeeLanguage", () => {
  it("catches the fee phrasings that real scams use", () => {
    // AI_SYSTEM.md §10: deterministic checks run first and are NEVER skipped. This
    // one protects invariant 13 whether or not any model is available.
    for (const text of [
      "A non-refundable application fee of $25 is required.",
      "Pay a registration fee to secure your place.",
      "There is a processing fee for all applicants.",
      "Applicants must pay USD 50 to apply.",
      "Send money via Western Union to confirm.",
      "Transfer funds to the account below.",
      "Payment accepted to our bitcoin wallet.",
      "Send to 0x1234567890abcdef1234567890abcdef12345678",
    ]) {
      expect(detectFeeLanguage(text).hit, text).toBe(true);
    }
  });

  it("does not fire on a page that says there is no fee", () => {
    // The common case, and a false positive here sends a good listing to review.
    // "no fee to apply" contains "fee to apply" — the patterns are anchored on the
    // fee NOUN PHRASE rather than the bare word.
    expect(detectFeeLanguage("There is no fee to apply.").hit).toBe(false);
    expect(detectFeeLanguage("Free to enter. No fees of any kind.").hit).toBe(false);
    expect(detectFeeLanguage("The prize is USD 10,000.").hit).toBe(false);
  });

  it("reports what it matched, so an operator can judge it", () => {
    const { matches } = detectFeeLanguage("A non-refundable application fee applies.");
    expect(matches.length).toBeGreaterThan(0);
  });
});
