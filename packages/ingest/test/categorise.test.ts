/**
 * The category a listing announces about itself.
 *
 * Thirty-five listings sat under "Other" on the live site while their titles said
 * "Scholarships", "Fellowship", "Internship", "Hackathon". Two separate bugs put them there:
 *
 *   The extract prompt carried its own list of category codes, and it had drifted from the
 *   `categories` table until the two shared NINE of twenty-one entries. Twelve codes the
 *   model was told to produce did not exist and fell silently to `other`; twelve real
 *   categories could never be chosen at all. That is why eighteen of twenty-one category
 *   pages were empty while the catalogue was not.
 *
 *   And an API source costs no model calls by design, so its records reached the writer with
 *   no category_code and took the same silent fallthrough.
 *
 * The titles below are the real ones from /categories/other on 16 September 2026.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CATEGORISER_CODES, categoriseFromText } from "../src/categorise.mjs";

/** The taxonomy as the database actually seeds it. */
const TAXONOMY = readFileSync(
  new URL("../../../supabase/seed/003_categories.sql", import.meta.url).pathname,
  "utf8",
)
  .split("\n")
  .flatMap((line) => line.match(/^ {2}\('([a-z_]+)'/)?.slice(1) ?? []);

describe("the taxonomy this can produce", () => {
  it("is read from the seed, not restated here", () => {
    expect(TAXONOMY.length).toBeGreaterThan(15);
    expect(TAXONOMY).toContain("other");
  });

  it("holds every code the categoriser can return", () => {
    // The drift that caused this: a code that exists in one place and not the other.
    const unknown = CATEGORISER_CODES.filter((code) => !TAXONOMY.includes(code));
    expect(unknown).toEqual([]);
  });

  it("is never told to produce `other`", () => {
    // `other` is what you get when nothing was determined. Returning it from here would
    // hide the difference between "this is uncategorised" and "I did not look".
    expect(CATEGORISER_CODES).not.toContain("other");
  });
});

describe("the extract prompt's vocabulary", () => {
  it("is no longer a second copy of the taxonomy", () => {
    // It used to list 21 codes of its own, overlapping the database on 9. It now carries a
    // placeholder that the runner fills from the `categories` table.
    const promptText = readFileSync(
      new URL("../../../prompts/extract.v1.md", import.meta.url).pathname,
      "utf8",
    );
    expect(promptText).toContain("{{CATEGORY_CODES}}");

    // Only the `category_code` line is the vocabulary. The prose above it lists the KINDS of
    // page the crawler meets — "a grant, scholarship, competition, hackathon ... or similar" —
    // and "residency" is ordinary English there, not a code. Asserting over the whole file
    // would fail on that sentence and teach the next person to delete a true description.
    const line = promptText.split("\n").find((l) => l.includes('"category_code"'));
    expect(line, "the category_code line is gone").toBeTruthy();
    for (const invented of ["call_for_proposals", "volunteering", "mentorship", "residency"]) {
      expect(line!, `${invented} was never a category in this product`).not.toContain(invented);
    }
  });
});

describe("reading the category out of a real title", () => {
  const cases: [string, string | null][] = [
    ["NextStep Hacks 2026", "hackathon"],
    ["OneAquaHealth IEEE Global Hackathon", "hackathon"],
    ["RevenueCat Shipaton 2026", "hackathon"],
    ["Gates Cambridge Scholarships 2027-2028", "scholarship"],
    ["2027 Khalifa University Graduate Scholarship in UAE", "scholarship"],
    ["ARC Ltd–GSSP Scholarship Program 2026 for Postgraduate Study in Africa", "scholarship"],
    ["AfricaLics Visiting PhD Fellowship Programme 2027", "fellowship"],
    ["The Clooney Foundation Waging Justice for Women Fellowship 2027", "fellowship"],
    ["Inside Mastercard: Interns & Launchers Americas 2026 – Explore Internship", "internship"],
    ["Global Innovation Build Challenge V2", "innovation_challenge"],
    ["Global Entrepreneurship Festival Entrepreneurs Investment Program (EIP) 2026",
      "entrepreneurship_program"],
  ];

  for (const [title, expected] of cases) {
    it(`"${title.slice(0, 48)}" → ${expected}`, () => {
      expect(categoriseFromText({ title })).toBe(expected);
    });
  }

  it("prefers what a thing IS over what it is ABOUT", () => {
    // Mentions innovation, pitching and startups. It is a fellowship.
    expect(
      categoriseFromText({
        title: "Pitch Perfect Africa 2026 Innovation Fellowship for African Health Startups",
      }),
    ).toBe("fellowship");
  });

  it("says nothing when the taxonomy has no word for it", () => {
    // Rather than reaching for a near-miss. A reader filtering by fellowship should not be
    // handed a teaching exchange, and `other` is the honest home for both of these.
    expect(categoriseFromText({ title: "Women in Foreign Affairs Mentorship Group 2026" })).toBeNull();
    expect(
      categoriseFromText({ title: "The Government of Japan Exchange and Teaching Programme 2027" }),
    ).toBeNull();
    expect(categoriseFromText({ title: "" })).toBeNull();
    expect(categoriseFromText({})).toBeNull();
  });

  it("does not let a page's footer rewrite the title", () => {
    // The title is read alone first. A hackathon whose page mentions the organiser's
    // scholarship programme elsewhere is still a hackathon.
    expect(
      categoriseFromText({
        title: "Climate Data Hackathon 2026",
        summary: "Run by a foundation that also offers a scholarship programme.",
      }),
    ).toBe("hackathon");
  });

  it("falls back to the summary only when the title is silent", () => {
    expect(
      categoriseFromText({ title: "Mbele Programme 2027", summary: "A fully funded scholarship." }),
    ).toBe("scholarship");
  });
});
