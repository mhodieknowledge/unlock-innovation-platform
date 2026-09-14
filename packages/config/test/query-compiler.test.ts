/**
 * The deterministic query compiler. AI_SYSTEM.md §7.
 *
 * §7's fallback `[PR]` claims the heuristic "covers a large share of real queries without
 * any model". These tests are the evidence for that claim, written as the queries people
 * actually type rather than as unit cases.
 */

import { describe, expect, it } from "vitest";

import {
  compileQueryHeuristically,
  mergeModelChips,
  queryCacheKey,
  type QueryVocabulary,
} from "../src/query-compiler.js";

const VOCABULARY: QueryVocabulary = {
  countries: [
    { iso2: "ZW", name: "Zimbabwe" },
    { iso2: "ZM", name: "Zambia" },
    { iso2: "NG", name: "Nigeria" },
    { iso2: "NE", name: "Niger" },
    { iso2: "ZA", name: "South Africa", commonNames: ["RSA"] },
    { iso2: "CI", name: "Côte d'Ivoire", commonNames: ["Ivory Coast"] },
    { iso2: "KE", name: "Kenya" },
    { iso2: "GH", name: "Ghana" },
  ],
  categories: [
    { code: "grant", name: "Grant" },
    { code: "scholarship", name: "Scholarship" },
    { code: "hackathon", name: "Hackathon" },
    { code: "ai_challenge", name: "AI challenge" },
    { code: "internship", name: "Internship" },
  ],
};

const compile = (q: string) => compileQueryHeuristically(q, VOCABULARY);
const chipValues = (q: string, kind: string) =>
  compile(q)
    .chips.filter((c) => c.kind === kind)
    .map((c) => c.value);

describe("countries", () => {
  it("maps a country name", () => {
    expect(chipValues("grants in zimbabwe", "country")).toEqual(["ZW"]);
  });

  it("maps a demonym", () => {
    // "grants for Zimbabweans" is how people write it.
    expect(chipValues("scholarships for zimbabweans", "country")).toEqual(["ZW"]);
    expect(chipValues("opportunities for kenyans", "country")).toEqual(["KE"]);
  });

  it("maps a common name", () => {
    expect(chipValues("hackathons in ivory coast", "country")).toEqual(["CI"]);
    expect(chipValues("funding in rsa", "country")).toEqual(["ZA"]);
  });

  it("handles an accented name typed either way", () => {
    expect(chipValues("grants in côte d'ivoire", "country")).toEqual(["CI"]);
  });

  it("does NOT confuse Niger with Nigeria", () => {
    // The confusion that makes a country filter wrong rather than merely unhelpful.
    // Matching on word boundaries is what prevents it.
    expect(chipValues("grants in nigeria", "country")).toEqual(["NG"]);
    expect(chipValues("grants in niger", "country")).toEqual(["NE"]);
    expect(chipValues("nigerien fellowships", "country")).toEqual(["NE"]);
    expect(chipValues("nigerian fellowships", "country")).toEqual(["NG"]);
  });

  it("prefers the longest match, so 'south africa' is not 'africa'", () => {
    expect(chipValues("startup competitions in south africa", "country")).toEqual(["ZA"]);
  });

  it("maps several countries", () => {
    const values = chipValues("grants in zimbabwe and zambia", "country");
    expect(values).toContain("ZW");
    expect(values).toContain("ZM");
  });

  it("ignores a country that is not in the live vocabulary", () => {
    // The vocabulary comes from our own table, so a country we do not hold cannot
    // become a filter.
    expect(chipValues("grants in narnia", "country")).toEqual([]);
  });
});

describe("categories", () => {
  it("maps the category name", () => {
    expect(chipValues("hackathon", "category")).toEqual(["hackathon"]);
  });

  it("maps the words people actually use", () => {
    // None of these is the category's name.
    expect(chipValues("bursaries for engineering", "category")).toEqual(["scholarship"]);
    expect(chipValues("i need funding for my startup", "category")).toEqual(["grant"]);
    expect(chipValues("ml challenge", "category")).toEqual(["ai_challenge"]);
  });

  it("maps a multi-word synonym before a single-word one", () => {
    expect(chipValues("ai challenge in kenya", "category")).toEqual(["ai_challenge"]);
  });

  it("ignores a synonym pointing at a category the live list does not have", () => {
    // CATEGORY_SYNONYMS carries codes for categories this vocabulary omits; they must
    // simply not match rather than producing a filter nothing can apply.
    expect(chipValues("residency", "category")).toEqual([]);
  });
});

describe("mode, cost, team, deadline and prize", () => {
  it("maps remote and its synonyms to online", () => {
    expect(chipValues("remote internships", "mode")).toEqual(["online"]);
    expect(chipValues("virtual hackathons", "mode")).toEqual(["online"]);
    expect(chipValues("work from home", "mode")).toEqual(["online"]);
  });

  it("maps in-person however it is spelled", () => {
    expect(chipValues("in person conference", "mode")).toEqual(["in_person"]);
    expect(chipValues("in-person bootcamp", "mode")).toEqual(["in_person"]);
  });

  it("maps free to enter", () => {
    expect(chipValues("free hackathons", "cost")).toEqual(["free"]);
  });

  it("maps team and individual", () => {
    expect(chipValues("team hackathons", "team")).toEqual(["team"]);
    expect(chipValues("solo competitions", "team")).toEqual(["individual"]);
  });

  it("maps deadline language to a window", () => {
    expect(chipValues("grants closing soon", "deadline")).toEqual(["7"]);
    expect(chipValues("anything closing this month", "deadline")).toEqual(["30"]);
  });

  it("maps prize language", () => {
    expect(chipValues("competitions with a prize", "prize")).toEqual(["true"]);
  });
});

describe("the whole parse", () => {
  it("handles a realistic query end to end", () => {
    const result = compile("i am looking for remote ai challenges in zimbabwe closing soon");
    const byKind = Object.fromEntries(result.chips.map((c) => [c.kind, c.value]));
    expect(byKind).toEqual({
      country: "ZW",
      category: "ai_challenge",
      mode: "online",
      deadline: "7",
    });
    // Nothing meaningful left over: this query needed no model at all.
    expect(result.keywords).toBe("");
  });

  it("leaves genuinely unmapped words as search text", () => {
    const result = compile("solar irrigation grants in zambia");
    expect(result.chips.some((c) => c.kind === "country" && c.value === "ZM")).toBe(true);
    expect(result.keywords).toContain("solar");
    expect(result.keywords).toContain("irrigation");
    expect(result.unmapped).toContain("solar");
  });

  it("strips the words that carry nothing", () => {
    expect(compile("show me grants please").keywords).toBe("");
  });

  it("drops single letters and bare numbers from the keywords", () => {
    // They match everything and mean nothing.
    expect(compile("a 2027 grant x").keywords).toBe("");
  });

  it("drops the connectives the filters left behind", () => {
    // "grants in zimbabwe" should not leave "in" showing in the keyword chip as though
    // the user had searched for it.
    expect(compile("grants in zimbabwe").keywords).toBe("");
    expect(compile("solar grants for and of the zambia").keywords).toBe("solar");
  });

  it("tells the user where each chip came from", () => {
    // §7: the chips are editable, which means they have to be explicable.
    const result = compile("scholarships for zimbabweans");
    const country = result.chips.find((c) => c.kind === "country");
    // The chip reports the words the USER typed, not the phrase we listed.
    expect(country?.from).toBe("zimbabweans");
    expect(country?.source).toBe("heuristic");
  });

  it("never returns results or prose — only chips and keywords", () => {
    // §7 `[PR]`: "filter chips only. Never results, never prose."
    const result = compile("what is the best grant for me");
    expect(Object.keys(result).sort()).toEqual(["chips", "keywords", "unmapped"]);
  });

  it("survives an empty or nonsense query", () => {
    for (const query of ["", "   ", "!!!", "?????", "\n\t"]) {
      const result = compile(query);
      expect(result.chips).toEqual([]);
      expect(result.keywords).toBe("");
    }
  });
});

describe("mergeModelChips", () => {
  const heuristic = compile("grants in zimbabwe");

  it("adds a chip the heuristic had no phrase for", () => {
    const merged = mergeModelChips(
      heuristic,
      [{ kind: "mode", value: "online" }],
      VOCABULARY,
    );
    expect(merged.chips.some((c) => c.kind === "mode" && c.source === "model")).toBe(true);
  });

  it("DISCARDS a value not in the live vocabulary", () => {
    // §7's guardrail. The model can widen a parse; it cannot invent a filter.
    const merged = mergeModelChips(
      heuristic,
      [
        { kind: "country", value: "XX" },
        { kind: "category", value: "time_travel" },
      ],
      VOCABULARY,
    );
    expect(merged.chips).toHaveLength(heuristic.chips.length);
  });

  it("discards a chip kind the UI cannot render", () => {
    // A filter the interface cannot show and the search cannot apply would silently do
    // nothing, which is worse than not existing.
    const merged = mergeModelChips(heuristic, [{ kind: "vibes", value: "good" }], VOCABULARY);
    expect(merged.chips).toHaveLength(heuristic.chips.length);
  });

  it("lets the HEURISTIC win on a conflict", () => {
    // The heuristic read the word "zimbabwe". The model is guessing at intent.
    const merged = mergeModelChips(heuristic, [{ kind: "country", value: "KE" }], VOCABULARY);
    const countries = merged.chips.filter((c) => c.kind === "country");
    expect(countries).toHaveLength(2);
    expect(countries[0]?.value).toBe("ZW");
    expect(countries[0]?.source).toBe("heuristic");
  });

  it("survives junk from the model rather than throwing", () => {
    for (const junk of [null, "sorry", 42, [null, "x", {}], [{ kind: null }]]) {
      expect(() => mergeModelChips(heuristic, junk, VOCABULARY)).not.toThrow();
    }
  });
});

describe("queryCacheKey", () => {
  it("collapses word order, because the chips are the same either way", () => {
    expect(queryCacheKey("grants zimbabwe")).toBe(queryCacheKey("zimbabwe grants"));
  });

  it("collapses case and punctuation", () => {
    expect(queryCacheKey("Grants in Zimbabwe!")).toBe(queryCacheKey("grants in zimbabwe"));
  });

  it("distinguishes genuinely different queries", () => {
    expect(queryCacheKey("grants zimbabwe")).not.toBe(queryCacheKey("grants zambia"));
  });
});
