/**
 * §1.5's scoring, the shared half.
 *
 * This function is the one place the request tier and the nightly batch meet: if it scored
 * differently in either, a project's matches would reorder themselves overnight with no
 * explanation. So what is asserted here is mostly arithmetic and ordering — the boring
 * properties that a second implementation would have got subtly wrong.
 */

import { describe, expect, it } from "vitest";

import {
  PROJECT_MATCHES_STORED,
  PROJECT_MATCH_WEIGHTS,
  projectMatchReasons,
  scoreProjectMatches,
  tagOverlapScore,
  capPerOrganisation,
} from "../src/index.js";

const NOW = Date.parse("2026-09-14T00:00:00Z");

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "opp-1",
    slug: "opp-1",
    title: "An opportunity",
    similarity: 0.8,
    shared_tag_count: 2,
    shared_tags: ["AgriTech", "AI"],
    verdict: "eligible",
    deadline_at: "2026-09-26T00:00:00Z",
    is_rolling: false,
    organisation_slug: "org-a",
    organisation_name: "Org A",
    category_name: "Grant",
    cost: "free",
    team_required: false,
    ...overrides,
  };
}

describe("§1.5 project match scoring", () => {
  it("weights similarity, urgency and tag overlap as the spec states", () => {
    expect(PROJECT_MATCH_WEIGHTS.similarity).toBe(0.55);
    expect(PROJECT_MATCH_WEIGHTS.urgency).toBe(0.3);
    expect(PROJECT_MATCH_WEIGHTS.tagOverlap).toBe(0.15);
    // The three terms are a weighted average, so they must sum to 1 — otherwise a score is
    // not comparable to any other score.
    const sum = Object.values(PROJECT_MATCH_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("keeps every score inside 0..1, including the extremes", () => {
    const rows = scoreProjectMatches(
      [
        candidate({ id: "best", similarity: 1, shared_tag_count: 9, deadline_at: "2026-09-21T00:00:00Z" }),
        candidate({ id: "worst", similarity: 0, shared_tag_count: 0, deadline_at: null, is_rolling: false, organisation_slug: "org-b" }),
      ],
      { now: NOW },
    );
    for (const row of rows) {
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(1);
    }
  });

  it("ranks better matches first and numbers the ranks from one", () => {
    const rows = scoreProjectMatches(
      [
        candidate({ id: "weak", similarity: 0.2, shared_tag_count: 0, organisation_slug: "org-b" }),
        candidate({ id: "strong", similarity: 0.95, shared_tag_count: 4, organisation_slug: "org-c" }),
      ],
      { now: NOW },
    );
    expect(rows.map((r) => r.opportunity_id)).toEqual(["strong", "weak"]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("caps at ten, which is §1.5's stored limit", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      candidate({ id: `opp-${i}`, organisation_slug: `org-${i}`, similarity: 1 - i / 100 }),
    );
    expect(scoreProjectMatches(many, { now: NOW })).toHaveLength(PROJECT_MATCHES_STORED);
  });

  it("allows at most two per organisation, as a hard cap rather than a reshuffle", () => {
    // Five from one organisation and one from another. With displacement (what the
    // recommendation surface does) the third, fourth and fifth would land inside the top
    // ten anyway; §1.5 says max 2, so they are dropped.
    const rows = scoreProjectMatches(
      [
        ...Array.from({ length: 5 }, (_, i) =>
          candidate({ id: `a-${i}`, organisation_slug: "org-a", similarity: 0.9 - i / 100 }),
        ),
        candidate({ id: "b-0", organisation_slug: "org-b", similarity: 0.5 }),
      ],
      { now: NOW },
    );
    expect(rows.filter((r) => r.opportunity_id.startsWith("a-"))).toHaveLength(2);
    expect(rows.map((r) => r.opportunity_id)).toContain("b-0");
  });

  it("never drops an opportunity with no organisation, which cannot crowd anyone out", () => {
    const rows = capPerOrganisation(
      [{ org: null }, { org: null }, { org: null }],
      (row) => row.org,
    );
    expect(rows).toHaveLength(3);
  });

  it("saturates tag overlap rather than letting a broadly tagged listing win on tags alone", () => {
    expect(tagOverlapScore(0)).toBe(0);
    expect(tagOverlapScore(2)).toBe(0.5);
    expect(tagOverlapScore(4)).toBe(1);
    expect(tagOverlapScore(40)).toBe(1);
  });
});

describe("§1.5 reasons are templated, and the deadline survives truncation", () => {
  it("reads like the example in the spec", () => {
    expect(projectMatchReasons(candidate(), NOW)).toEqual([
      "AgriTech",
      "AI",
      "you're eligible",
      "closes in 12 days",
    ]);
  });

  it("keeps the closing date when there are more reasons than room", () => {
    // The regression this test exists for: an earlier ordering pushed "team entry" and
    // "free to enter" ahead of the deadline, so the top match lost the one fact that
    // decides whether a person can act at all.
    const reasons = projectMatchReasons(
      candidate({ team_required: true, cost: "free", deadline_at: "2026-09-22T00:00:00Z" }),
      NOW,
    );
    expect(reasons.some((r) => r.startsWith("closes"))).toBe(true);
  });

  it("says closes today and closes tomorrow rather than 'in 0 days'", () => {
    expect(
      projectMatchReasons(candidate({ shared_tags: [], deadline_at: "2026-09-14T06:00:00Z" }), NOW),
    ).toContain("closes today");
    expect(
      projectMatchReasons(candidate({ shared_tags: [], deadline_at: "2026-09-15T06:00:00Z" }), NOW),
    ).toContain("closes tomorrow");
  });

  it("is honest about a rolling call instead of inventing urgency", () => {
    const reasons = projectMatchReasons(
      candidate({ shared_tags: [], deadline_at: null, is_rolling: true }),
      NOW,
    );
    expect(reasons).toContain("rolling — no deadline");
  });

  it("names the one unconfirmed requirement for a likely_eligible match", () => {
    const reasons = projectMatchReasons(candidate({ verdict: "likely_eligible", shared_tags: [] }), NOW);
    expect(reasons[0]).toBe("likely eligible — one requirement we couldn't confirm");
  });
});
