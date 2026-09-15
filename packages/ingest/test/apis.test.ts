/**
 * Official API adapters. OPPORTUNITY_INGESTION.md §2 tier 1.
 *
 * These tests exist because an adapter is the one part of the pipeline that fails
 * SILENTLY when a publisher changes something. A renamed field does not raise: it
 * produces zero items, or items missing a deadline, and the run reports a source that
 * simply had nothing new. So the fixtures below are real Devpost responses, and the
 * assertions are about the fields a record cannot do without.
 */

import { describe, expect, it } from "vitest";

import { devpostHackathons, itemsFromApi, parseDateRange } from "../src/apis.mjs";
import { recordFromJsonLd } from "../src/jsonld.mjs";

/** Trimmed from https://devpost.com/api/hackathons on 2026-09-15. */
const DEVPOST = {
  hackathons: [
    {
      id: 29969,
      title: "RevenueCat Shipaton 2026",
      displayed_location: { icon: "globe", location: "Online" },
      open_state: "open",
      url: "https://revenuecat-shipaton-2026.devpost.com/",
      submission_period_dates: "Jul 31 - Oct 01, 2026",
      themes: [{ id: 18, name: "Design" }, { id: 4, name: "Gaming" }],
      prize_amount: "$<span data-currency-value>740,000</span>",
      organization_name: "RevenueCat",
      invite_only: false,
    },
    {
      id: 30992,
      title: "Lagos Climate Hack",
      displayed_location: { icon: "map-marker", location: "Lagos, Nigeria" },
      open_state: "upcoming",
      url: "https://lagos-climate.devpost.com/",
      submission_period_dates: "Dec 01, 2026 - Jan 15, 2027",
      themes: [],
      organization_name: "Climate Africa",
      invite_only: false,
    },
  ],
};

describe("devpostHackathons", () => {
  it("turns each hackathon into an item with schema.org data attached", () => {
    const items = devpostHackathons(DEVPOST, "https://devpost.com/api/hackathons");
    expect(items).toHaveLength(2);
    expect(items[0]?.url).toBe("https://revenuecat-shipaton-2026.devpost.com/");
    expect(items[0]?.title).toBe("RevenueCat Shipaton 2026");
  });

  it("produces a full record with no model call — the point of the whole adapter", () => {
    // §4.4 gives publisher-authored structured data priority over the model, so an item
    // carrying this reaches a record without spending a token. On the free tiers this
    // project runs on that is the difference between reading the catalogue and not.
    const [first] = devpostHackathons(DEVPOST, "https://devpost.com/api/hackathons");
    const derived = recordFromJsonLd(first!.jsonld, first!.url);

    expect(derived).not.toBeNull();
    expect(derived!.record["title"]).toBe("RevenueCat Shipaton 2026");
    expect(derived!.record["organisation_name"]).toBe("RevenueCat");
    expect(derived!.record["participation_mode"]).toBe("online");
    expect(String(derived!.record["deadline_at"])).toContain("2026-10-01");
  });

  it("never states a cost Devpost did not state", () => {
    // AI_SYSTEM.md §10 and invariant 13 both turn on this field. Devpost says nothing
    // about entry fees, so neither do we — a guessed `free` could publish something
    // that charges.
    const [first] = devpostHackathons(DEVPOST, "https://devpost.com/api/hackathons");
    const derived = recordFromJsonLd(first!.jsonld, first!.url);
    expect(derived!.record["cost"]).toBeUndefined();
  });

  it("carries an in-person location rather than calling everything online", () => {
    const [, second] = devpostHackathons(DEVPOST, "https://devpost.com/api/hackathons");
    const derived = recordFromJsonLd(second!.jsonld, second!.url);
    expect(derived!.record["participation_mode"]).toBe("in_person");
  });

  it("skips an entry with no url or no title instead of inventing one", () => {
    const items = devpostHackathons(
      { hackathons: [{ title: "No URL" }, { url: "https://x.devpost.com/" }, null, "nonsense"] },
      "https://devpost.com/api/hackathons",
    );
    expect(items).toHaveLength(0);
  });

  it("returns nothing for a shape it does not recognise, rather than throwing", () => {
    // A publisher renaming the top-level key is the failure this guards: zero items is
    // recoverable and visible in the log; an exception takes down the whole run.
    expect(devpostHackathons({ results: [] }, "https://devpost.com/api/hackathons")).toEqual([]);
    expect(devpostHackathons(null, "https://devpost.com/api/hackathons")).toEqual([]);
  });
});

describe("parseDateRange", () => {
  it("applies the trailing year to both halves", () => {
    expect(parseDateRange("Aug 21 - Sep 30, 2026")).toEqual({
      start: "2026-08-21T00:00:00.000Z",
      end: "2026-09-30T00:00:00.000Z",
    });
  });

  it("handles a range that crosses into the next year", () => {
    expect(parseDateRange("Dec 01, 2026 - Jan 15, 2027")).toEqual({
      start: "2026-12-01T00:00:00.000Z",
      end: "2027-01-15T00:00:00.000Z",
    });
  });

  it("reads the stated year as the END's when the range wraps a year boundary", () => {
    // "Dec 20 - Jan 10, 2026" closes in January 2026, so it opened in December 2025.
    // The stated date is the deadline, and the deadline is the half that must not move.
    const { start, end } = parseDateRange("Dec 20 - Jan 10, 2026");
    expect(end).toBe("2026-01-10T00:00:00.000Z");
    expect(start).toBe("2025-12-20T00:00:00.000Z");
  });

  it("reads a range that states its month once", () => {
    // "Sep 06 - 20, 2026". 137 of Devpost's 183 open hackathons were losing their
    // deadline to this shape, because a bare day was read as unparseable and took the
    // whole range down with it.
    expect(parseDateRange("Sep 06 - 20, 2026")).toEqual({
      start: "2026-09-06T00:00:00.000Z",
      end: "2026-09-20T00:00:00.000Z",
    });
  });

  it("rolls a bare day into the next month when it falls before the start", () => {
    // "Sep 30 - 02, 2026" is a fortnight, not a year. Read as the same month the end
    // lands before its own start, and the year-boundary rule then drags the start back
    // to 2025 — a deadline wrong by a year, which is worse than no deadline.
    expect(parseDateRange("Sep 30 - 02, 2026")).toEqual({
      start: "2026-09-30T00:00:00.000Z",
      end: "2026-10-02T00:00:00.000Z",
    });
    expect(parseDateRange("Dec 28 - 03, 2026")).toEqual({
      start: "2026-12-28T00:00:00.000Z",
      end: "2027-01-03T00:00:00.000Z",
    });
  });

  it("rejects a bare day that does not exist in its month", () => {
    expect(parseDateRange("Sep 06 - 31, 2026")).toEqual({ start: null, end: null });
  });

  it("returns nulls rather than a guess", () => {
    // A wrong deadline is worse than none: the record either expires early and vanishes
    // or stays published telling people to apply for something that has closed.
    for (const input of ["garbage", "Feb 31 - Mar 02, 2026", "Sometime in spring", "", null]) {
      expect(parseDateRange(input)).toEqual({ start: null, end: null });
    }
  });
});

describe("itemsFromApi", () => {
  it("names an adapter it does not have", () => {
    expect(() => itemsFromApi("nope", "{}", "https://x.test")).toThrow(/no API adapter/);
  });

  it("says so when the response is not JSON", () => {
    expect(() => itemsFromApi("devpost_hackathons", "<html>bot wall</html>", "https://x.test")).toThrow(
      /not JSON/,
    );
  });
});
