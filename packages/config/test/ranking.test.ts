/**
 * Ranking weights and curves. SYSTEM_ARCHITECTURE.md §6.1 and §8.
 *
 * These are tested because they are the numbers most likely to be changed casually.
 * A test that states what a weight is FOR turns a nudge into a decision.
 */

import { describe, expect, it } from "vitest";

import {
  DIVERSITY,
  ELIGIBILITY_BOOST,
  RRF_K,
  URGENCY,
  applyDiversity,
  rrfScore,
  urgencyBoost,
} from "../src/ranking.js";

describe("eligibility boost", () => {
  it("down-ranks not_eligible without hiding it", () => {
    // §6.1: "down-ranked, never hidden — the user may be checking for someone else."
    expect(ELIGIBILITY_BOOST.not_eligible).toBeGreaterThan(0);
    expect(ELIGIBILITY_BOOST.not_eligible).toBeLessThan(ELIGIBILITY_BOOST.unclear);
  });

  it("does not penalise unclear", () => {
    // An opportunity whose rules we could not confirm is not a worse opportunity.
    // Penalising it would bury everything our extraction found hard.
    expect(ELIGIBILITY_BOOST.unclear).toBe(1.0);
  });

  it("orders the four verdicts as the spec does", () => {
    expect(ELIGIBILITY_BOOST.eligible).toBeGreaterThan(ELIGIBILITY_BOOST.likely_eligible);
    expect(ELIGIBILITY_BOOST.likely_eligible).toBeGreaterThan(ELIGIBILITY_BOOST.unclear);
    expect(ELIGIBILITY_BOOST.unclear).toBeGreaterThan(ELIGIBILITY_BOOST.not_eligible);
  });
});

describe("urgencyBoost", () => {
  const now = new Date("2026-09-14T00:00:00Z");
  const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000);

  it("peaks at seven days out, not at one", () => {
    // Something closing tomorrow is nearly useless to surface — most applications
    // cannot be assembled overnight. A week is the most actionable thing a deadline
    // product can show.
    const atPeak = urgencyBoost(inDays(URGENCY.peakDays), now);
    expect(atPeak).toBeCloseTo(URGENCY.peak, 5);
    expect(urgencyBoost(inDays(1), now)).toBeLessThan(atPeak);
    expect(urgencyBoost(inDays(30), now)).toBeLessThan(atPeak);
  });

  it("never boosts something closing tomorrow below neutral", () => {
    expect(urgencyBoost(inDays(0.5), now)).toBeGreaterThanOrEqual(1.0);
  });

  it("decays to neutral by the horizon", () => {
    expect(urgencyBoost(inDays(URGENCY.neutralDays), now)).toBeCloseTo(1.0, 5);
    expect(urgencyBoost(inDays(365), now)).toBe(1.0);
  });

  it("gives a past deadline no boost at all", () => {
    expect(urgencyBoost(inDays(-1), now)).toBe(0);
  });

  it("treats a rolling or unknown deadline as slightly below neutral", () => {
    // Slightly below, not zero: rolling opportunities are real and worth showing, but a
    // dated one is more actionable.
    expect(urgencyBoost(null, now)).toBe(URGENCY.noDeadline);
    expect(URGENCY.noDeadline).toBeLessThan(1.0);
    expect(URGENCY.noDeadline).toBeGreaterThan(0.5);
  });

  it("survives a malformed date rather than throwing", () => {
    expect(urgencyBoost("not a date", now)).toBe(URGENCY.noDeadline);
  });

  it("accepts an ISO string as well as a Date", () => {
    expect(urgencyBoost(inDays(7).toISOString(), now)).toBeCloseTo(URGENCY.peak, 5);
  });
});

describe("rrfScore", () => {
  it("rewards agreement between the two retrievers", () => {
    // The property RRF is chosen for: a result both retrievers rank highly beats one
    // only one of them loves.
    const bothSecond = rrfScore(2) + rrfScore(2);
    const firstAndTwentieth = rrfScore(1) + rrfScore(20);
    expect(bothSecond).toBeGreaterThan(firstAndTwentieth);
  });

  it("decays gently, per k=60", () => {
    expect(rrfScore(1)).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(rrfScore(10) / rrfScore(1)).toBeGreaterThan(0.85);
  });

  it("scores an unranked result as zero", () => {
    expect(rrfScore(0)).toBe(0);
    expect(rrfScore(-1)).toBe(0);
  });
});

describe("applyDiversity", () => {
  const row = (id: number, organisation: string, category: string) => ({ id, organisation, category });
  const keyOf = (r: { organisation: string; category: string }) => ({
    organisation: r.organisation,
    category: r.category,
  });

  it("caps one organisation at two in the first twenty", () => {
    // Without this, one organisation running twelve regional rounds takes the whole
    // first page and the page stops being a view of the catalogue.
    const items = [1, 2, 3, 4].map((i) => row(i, "big-org", `cat-${i}`));
    const ordered = applyDiversity(items, keyOf);
    expect(ordered.slice(0, 2).map((r) => r.id)).toEqual([1, 2]);
    expect(ordered.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });

  it("moves capped items down rather than removing them", () => {
    // The catalogue should not pretend an organisation's fourth programme does not exist.
    const items = [1, 2, 3].map((i) => row(i, "big-org", "grant"));
    expect(applyDiversity(items, keyOf)).toHaveLength(3);
  });

  it("caps a category at three, letting a diverse result take the place", () => {
    const items = [1, 2, 3, 4].map((i) => row(i, `org-${i}`, "grant"));
    const withAlternative = [...items, row(5, "org-5", "scholarship")];
    expect(applyDiversity(withAlternative, keyOf).map((r) => r.id)).toEqual([1, 2, 3, 5, 4]);
  });

  it("stops capping past the first twenty", () => {
    // Past that point a user is deliberately looking for more of something.
    const items = Array.from({ length: 30 }, (_, i) => row(i, `org-${i % 15}`, `cat-${i % 10}`));
    expect(applyDiversity(items, keyOf)).toHaveLength(30);
    expect(DIVERSITY.withinFirst).toBe(20);
  });

  it("leaves an item with no organisation or category alone", () => {
    const items = [
      { id: 1, organisation: null, category: null },
      { id: 2, organisation: null, category: null },
      { id: 3, organisation: null, category: null },
    ];
    expect(
      applyDiversity(items, (r) => ({ organisation: r.organisation, category: r.category })).map(
        (r) => r.id,
      ),
    ).toEqual([1, 2, 3]);
  });

  it("keeps an empty list empty", () => {
    expect(applyDiversity([], keyOf)).toEqual([]);
  });
});
