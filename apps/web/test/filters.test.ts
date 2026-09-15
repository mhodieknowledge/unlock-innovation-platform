/**
 * URL filter state. PRODUCT_SPEC.md §13.1, AI_SYSTEM.md §7.
 *
 * The one thing asserted here that nothing else can be: a filter that appears in the URL is a
 * filter something applies. Three separate layers have to agree — the query compiler emits a
 * chip, compiledToParams turns it into a parameter, parseFilters reads it, and the data layer
 * filters on it — and when they disagree the product renders a chip, changes nothing, and says
 * nothing about it. That happened to `category`, `organisation`, `region`, `deadline_state` and
 * the manifest's own shortcut before these tests existed.
 */

import { describe, expect, it } from "vitest";

import { compileQueryHeuristically } from "@mbele/config";
import { activeChips, compiledToParams, parseFilters } from "../src/lib/filters";

const VOCABULARY = {
  countries: [{ iso2: "ZW", name: "Zimbabwe", commonNames: ["zim"] }],
  categories: [{ code: "ai_challenge", name: "AI challenge" }],
};

const at = (query: string) => new URL(`https://example.invalid/opportunities?${query}`);

describe("compiled chips become filters that are actually read", () => {
  it("turns a whole natural-language query into URL state", () => {
    const compiled = compileQueryHeuristically(
      "remote ai challenges in zimbabwe closing soon, free to enter",
      VOCABULARY,
    );
    const params = compiledToParams(compiled);
    const filters = parseFilters(at(params.toString()));

    expect(filters.country).toBe("ZW");
    expect(filters.category).toBe("ai_challenge");
    expect(filters.mode).toBe("online");
    expect(filters.cost).toBe("free");
    // "closing soon" is a seven-day window, which is the state the list query applies.
    expect(filters.deadlineState).toBe("closing_this_week");
  });

  it("maps a month-long deadline to the month state", () => {
    const params = compiledToParams({
      chips: [{ kind: "deadline", value: "30" }],
      keywords: "",
    });
    expect(parseFilters(at(params.toString())).deadlineState).toBe("closing_this_month");
  });

  it("puts no parameter in the URL for a window the product has no state for", () => {
    // 90 days is a chip the compiler can emit and §13.2 has no state for. Inventing one would
    // put a filter in the URL that nothing applies — the bug this file exists for.
    const params = compiledToParams({ chips: [{ kind: "deadline", value: "90" }], keywords: "x" });
    expect(params.get("deadline_state")).toBeNull();
    expect(params.get("q")).toBe("x");
  });

  it("leaves every parameter it does write readable by the parser", () => {
    const compiled = compileQueryHeuristically(
      "team hackathons with a prize in zimbabwe",
      VOCABULARY,
    );
    const params = compiledToParams(compiled);
    const filters = parseFilters(at(params.toString())) as unknown as Record<string, unknown>;

    for (const [key, value] of params) {
      if (key === "q") continue;
      // Every written parameter has to show up as a parsed filter with a value. A parameter the
      // parser ignores reads as the default here and fails.
      const parsed = Object.entries(filters).some(([, v]) => {
        if (v === null || v === false) return false;
        return String(v) === value || (value === "1" && v === true);
      });
      expect(parsed, `${key}=${value} is written to the URL but nothing reads it`).toBe(true);
    }
  });
});

describe("chips are dismissible one at a time", () => {
  it("removes exactly one filter per chip, keeping the rest", () => {
    const filters = parseFilters(at("country=ZW&category=ai_challenge&cost=free"));
    const chips = activeChips(filters);

    expect(chips.map((c) => c.label)).toEqual(
      expect.arrayContaining(["Open to ZW", "ai challenge", "Free to enter"]),
    );

    const removeCountry = chips.find((c) => c.label === "Open to ZW")!.removeHref;
    const after = parseFilters(new URL(removeCountry, "https://example.invalid"));
    expect(after.country).toBeNull();
    expect(after.category).toBe("ai_challenge");
    expect(after.cost).toBe("free");
  });

  it("falls back to the bare path when the last chip goes", () => {
    const chips = activeChips(parseFilters(at("cost=free")));
    expect(chips).toHaveLength(1);
    expect(chips[0]!.removeHref).toBe("/opportunities");
  });
});

describe("parsing is defensive about what arrives", () => {
  it("normalises a country code and ignores junk", () => {
    expect(parseFilters(at("country=zw")).country).toBe("ZW");
    expect(parseFilters(at("mode=telepathy")).mode).toBeNull();
    expect(parseFilters(at("deadline_state=whenever")).deadlineState).toBeNull();
    expect(parseFilters(at("sort=nonsense")).sort).toBe("urgency");
  });

  it("clamps the page size, so a URL cannot ask for the whole catalogue", () => {
    expect(parseFilters(at("limit=100000")).limit).toBe(100);
    expect(parseFilters(at("limit=-4")).limit).toBe(1);
    expect(parseFilters(at("limit=abc")).limit).toBe(20);
  });
});
