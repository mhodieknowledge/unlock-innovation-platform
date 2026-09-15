/**
 * Board diversification. PRODUCT_SPEC.md §13.4.
 *
 * The board sorts by urgency and that is a promise, so the test that matters most is not
 * "does it look balanced" but "did anything move EARLIER than something more urgent".
 * A spread that reorders within a category would bury a deadline, which is the one
 * failure this feature must not have.
 */

import { describe, expect, it } from "vitest";

import { spreadByCategory } from "../src/lib/db";

/** Rows in deadline order, as PostgREST returns them. */
const row = (id: number, code: string) => ({ id, categories: { code } });

/** The live shape on 2026-09-15: Devpost's short windows crowd out everything else. */
const hackathonFlood = [
  ...Array.from({ length: 30 }, (_, i) => row(i + 1, "hackathon")),
  row(101, "scholarship"),
  row(102, "fellowship"),
  row(103, "grant"),
];

describe("spreadByCategory", () => {
  it("lets other categories onto a page a single one would have filled", () => {
    const board = spreadByCategory(hackathonFlood, 12);
    const codes = board.map((r) => r.categories.code);
    expect(codes).toContain("scholarship");
    expect(codes).toContain("fellowship");
    expect(codes).toContain("grant");
  });

  it("caps one category at a quarter of the page when there IS enough else", () => {
    // Enough of everything to fill a page without the flood.
    const plenty = [
      ...Array.from({ length: 30 }, (_, i) => row(i + 1, "hackathon")),
      ...Array.from({ length: 10 }, (_, i) => row(200 + i, "scholarship")),
      ...Array.from({ length: 10 }, (_, i) => row(300 + i, "fellowship")),
      ...Array.from({ length: 10 }, (_, i) => row(400 + i, "grant")),
    ];
    const board = spreadByCategory(plenty, 12);
    expect(board.filter((r) => r.categories.code === "hackathon")).toHaveLength(3); // ceil(12*0.25)
    expect(board).toHaveLength(12);
  });

  it("refills from the capped category when there is NOT enough else", () => {
    // The rule is "no category dominates once there is enough else to show" — not "leave
    // the page half empty to look balanced". With only three non-hackathons in the
    // catalogue, a board of twelve is mostly hackathons and honestly so.
    const board = spreadByCategory(hackathonFlood, 12);
    expect(board).toHaveLength(12);
    expect(board.filter((r) => r.categories.code !== "hackathon")).toHaveLength(3);
    // Every one of the three scarce categories got its place before the refill.
    expect(board.slice(0, 6).map((r) => r.categories.code)).toContain("scholarship");
  });

  it("never moves a row EARLIER than a more urgent one in its own category", () => {
    // The promise. Rows arrive in deadline order, so within any category the ids must
    // still ascend: a row may be pushed back, never brought forward past a sooner one.
    const board = spreadByCategory(hackathonFlood, 20);
    const seen = new Map<string, number>();
    for (const r of board) {
      const code = r.categories.code;
      const previous = seen.get(code);
      if (previous !== undefined) expect(r.id).toBeGreaterThan(previous);
      seen.set(code, r.id);
    }
  });

  it("fills the page rather than leaving gaps when one category is all there is", () => {
    // A catalogue that genuinely holds only hackathons renders exactly as before —
    // balance is a courtesy to the reader, not a claim about the collection.
    const only = Array.from({ length: 30 }, (_, i) => row(i + 1, "hackathon"));
    const board = spreadByCategory(only, 10);
    expect(board).toHaveLength(10);
    expect(board.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("keeps the most urgent row first", () => {
    // Whatever else moves, the soonest deadline in the catalogue still leads the board.
    expect(spreadByCategory(hackathonFlood, 12)[0]?.id).toBe(1);
  });

  it("treats a row with no category as its own bucket rather than dropping it", () => {
    const mixed = [row(1, "hackathon"), { id: 2, categories: null }, row(3, "hackathon")];
    expect(spreadByCategory(mixed, 3).map((r) => r.id)).toEqual([1, 2, 3]);
  });
});
