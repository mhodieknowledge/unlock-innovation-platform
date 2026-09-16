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

import { acceptModelCategory, CATEGORISER_CODES, categoriseFromText } from "../src/categorise.mjs";

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
    // The title is read alone. A hackathon whose page mentions the organiser's scholarship
    // programme elsewhere is still a hackathon.
    expect(
      categoriseFromText({
        title: "Climate Data Hackathon 2026",
        summary: "Run by a foundation that also offers a scholarship programme.",
      }),
    ).toBe("hackathon");
  });
});

describe("the summary, which this used to read and no longer does", () => {
  /**
   * These four are the entire case for the change, and they are not hypotheticals: run 43 of
   * the Ingestion workflow proposed all four against the live catalogue, from summaries, while
   * every answer it took from a title was correct.
   *
   * The pattern is the same each time. A title DECLARES what a thing is; any other prose
   * MENTIONS things — the prize, the organiser's other programmes, the topics a panel will
   * discuss — and a mention is indistinguishable from a declaration to a regex.
   */
  const productionMistakes: [string, string][] = [
    [
      "UBA Foundation 2026 National Essay Competition for Nigerian senior secondary students",
      "Winners receive education grants towards their studies.",
    ],
    [
      "2026 UBA National Essay Competition For Nigerian Students",
      "The overall winner receives a scholarship covering undergraduate study.",
    ],
    [
      "Northeastern University Global Study Expo – Africa 2026",
      "Meet admissions staff and learn about scholarships and funding options.",
    ],
    [
      "Cassava and Vodafone bring Nvidia-powered AI data centre to Egypt",
      "The partnership includes a scholarship fund for local engineers.",
    ],
  ];

  for (const [title, summary] of productionMistakes) {
    it(`is not read for "${title.slice(0, 40)}…"`, () => {
      expect(categoriseFromText({ title, summary })).toBeNull();
    });
  }

  it("is ignored even when it would have been right", () => {
    // The honest cost of the change: a real scholarship whose title does not say so is now
    // left for prompts/classify.v1.md instead of being caught here. That is the trade — a
    // model can tell a mention from a declaration and this cannot — and `other` in the
    // meantime is a worse listing, where a wrong category is a wrong promise to a reader.
    expect(
      categoriseFromText({ title: "Mbele Programme 2027", summary: "A fully funded scholarship." }),
    ).toBeNull();
  });
});

describe("the classify prompt, which reads what a title cannot say", () => {
  const promptFile = readFileSync(
    new URL("../../../prompts/classify.v1.md", import.meta.url).pathname,
    "utf8",
  );

  /**
   * The `## System` section, and ONLY that, because that is the whole of what the runner sends
   * — `prompt()` in scripts/ingest.mjs extracts this section and discards the rest.
   *
   * That distinction is the difference between a drift risk and a comment. The documentation
   * above it names the two categories a previous version of this prompt got wrong in
   * production, which is exactly the kind of note the next person needs; asserting over the
   * whole file would fail on that note and teach them to delete it.
   */
  const promptText = ((): string => {
    const section = /##\s*System\s*\n([\s\S]*?)(?=\n##\s|\s*$)/.exec(promptFile)?.[1];
    if (section === undefined) throw new Error("classify.v1.md has no System section");
    return section;
  })();

  it("holds no copy of the taxonomy", () => {
    // The same rule as extract.v1.md, and the same trap: "grant", "scholarship" and
    // "fellowship" are ordinary English, and the prompt uses them in the examples that teach
    // the distinction it exists to teach ("a conference that mentions travel grants is not a
    // grant"). Asserting the file never says "grant" would fail on a true sentence and teach
    // the next person to delete it.
    //
    // A COPIED LIST HAS A DIFFERENT SHAPE. It holds the codes nobody writes in a sentence —
    // `open_source_program`, `conference_cfp` — and it holds many of them on one line.
    expect(promptText).toContain("{{CATEGORY_CODES}}");

    const multiWord = TAXONOMY.filter((code) => code.includes("_"));
    expect(multiWord.length, "the taxonomy should have codes no one writes in prose").toBeGreaterThan(5);
    for (const code of multiWord) {
      expect(promptText, `${code} can only be here as a copy of the database`).not.toContain(code);
    }

    // The single-word codes need a different test, because "grant", "scholarship" and
    // "fellowship" are ordinary English and the prompt's own examples use three of them in one
    // sentence — "a competition whose prize is a scholarship is a competition, not a
    // scholarship". Counting codes per line called that a list. What actually marks a LIST is
    // adjacency: codes separated by nothing but punctuation, with no sentence between them.
    const single = TAXONOMY.filter((code) => !code.includes("_")).join("|");
    const adjacent = new RegExp(`\\b(?:${single})\\b\\s*[,|/]\\s*\\b(?:${single})\\b`, "i");
    const found = adjacent.exec(promptText);
    expect(found?.[0], "two codes side by side is a vocabulary, not a sentence").toBeUndefined();
  });

  it("allows `other` as an answer", () => {
    // Without this the model is forced to pick a near-miss, which is the outcome the whole
    // change exists to avoid — though run 44 showed that permitting `other` is not enough on
    // its own, which is what acceptModelCategory is for.
    expect(promptText).toMatch(/`other`[^.]*is a correct answer/);
  });

  it("asks for a verbatim quote, because a bare code was not checkable", () => {
    expect(promptText).toMatch(/COPIED CHARACTER FOR CHARACTER/);
    expect(promptText).toMatch(/\bevidence\b/);
  });

  it("asks what the thing IS, not what it awards", () => {
    expect(promptText).toMatch(/prize is a scholarship is a competition/);
  });
});

describe("a model's category, checked against its own quote", () => {
  /**
   * Run 44 of the Ingestion workflow, dry, against the live `other` bucket. The first version
   * of classify.v1 asked for a code and nothing else; it moved three records and two were
   * wrong. Those two are the first two cases here, with page text of the kind their real pages
   * carry.
   */
  const verbatim = (quote: string, source: string) =>
    source.replace(/\s+/g, " ").includes(quote.replace(/\s+/g, " "));

  it("refuses `scholarship` for a teaching exchange, which is what it answered", () => {
    const source =
      "The Japan Exchange and Teaching Programme invites young graduates to work in Japanese " +
      "schools as assistant language teachers. Participants receive a salary and a return flight.";
    const verdict = acceptModelCategory({
      code: "scholarship",
      // There is no sentence in that page calling it a scholarship, so a model reaching for the
      // nearest code has nothing to quote and has to invent one.
      evidence: "a scholarship for young graduates",
      source,
      quoteIsVerbatim: verbatim,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/not in the page/);
  });

  it("refuses `data_competition` for a transcription project even when the quote is real", () => {
    // The harder half. Here the quote IS in the page — so verbatim checking alone would pass it
    // — and the quote does not name a data competition, which is what the read-back catches.
    const source =
      "The R.O.A.D. Barbados Historic Handwriting Challenge asks volunteers to transcribe " +
      "eighteenth-century parish records so that the archive becomes searchable.";
    const verdict = acceptModelCategory({
      code: "data_competition",
      evidence: "asks volunteers to transcribe eighteenth-century parish records",
      source,
      quoteIsVerbatim: verbatim,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/reads as no category, not data_competition/);
  });

  it("accepts a code the page states in a phrase that names it", () => {
    const source =
      "Anglo American runs a twelve-month internship for graduates in mineral processing, " +
      "based at the Rustenburg operations.";
    const verdict = acceptModelCategory({
      code: "internship",
      evidence: "a twelve-month internship for graduates in mineral processing",
      source,
      quoteIsVerbatim: verbatim,
    });
    expect(verdict).toEqual({ ok: true, code: "internship" });
  });

  it("refuses a quote that names a DIFFERENT category than the code chosen", () => {
    // The near-miss inside the taxonomy rather than outside it: the page declares a fellowship,
    // the model files it as a research opportunity. Both are real codes; only one is quoted.
    const source = "The programme is a two-year fellowship for early-career African economists.";
    const verdict = acceptModelCategory({
      code: "research_opportunity",
      evidence: "a two-year fellowship for early-career African economists",
      source,
      quoteIsVerbatim: verbatim,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/reads as fellowship/);
  });

  it("treats `other` as an answer rather than a failure", () => {
    const verdict = acceptModelCategory({
      code: "other",
      evidence: null,
      source: "anything",
      quoteIsVerbatim: verbatim,
    });
    expect(verdict).toEqual({ ok: false, reason: "answered other" });
  });

  it("does not accept a claim it cannot check", () => {
    // An API record with no stored page. The quote may be perfectly true; nothing here can tell.
    const verdict = acceptModelCategory({
      code: "hackathon",
      evidence: "a 48-hour hackathon",
      source: "",
      quoteIsVerbatim: verbatim,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/no page text/);
  });

  it("never asks for the model's confidence", () => {
    // A confident wrong answer and a hesitant wrong answer are the same wrong answer, and the
    // quote is checkable where the confidence is not. This asserts the source, because the
    // temptation to add a threshold is exactly what the quote replaces.
    const source = readFileSync(new URL("../src/categorise.mjs", import.meta.url).pathname, "utf8");
    const acceptBody = source.slice(source.indexOf("export function acceptModelCategory"));
    expect(acceptBody).not.toMatch(/confidence\s*[><=]/);
  });
});

describe("the categoriser covers the taxonomy the model is offered", () => {
  it("can read back every code except other", () => {
    // acceptModelCategory rejects a code its own reader cannot produce, so a code in the
    // database that no pattern here recognises would be a code the model may never be given
    // credit for — permanently unreachable through the model path, silently.
    const unreachable = TAXONOMY.filter(
      (code) => code !== "other" && !CATEGORISER_CODES.includes(code),
    );
    expect(unreachable, "no pattern can produce these, so the model can never be believed about them")
      .toEqual([]);
  });
});
