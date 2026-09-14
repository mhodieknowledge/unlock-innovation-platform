/**
 * The verbatim-quote check and the 8-word overlap check.
 *
 * AI_SYSTEM.md §12 calls quote-verbatim pass rate "the trust invariant", and §2
 * guardrail 3 marks the rule `[PR]`: no verbatim quote, no rule. This file is where
 * that is held down, so the tests are written from the attacker's side — what would
 * a plausible-sounding model output have to do to smuggle a rule through?
 */

import { describe, expect, it } from "vitest";

import {
  checkNoCopiedPhrase,
  comparable,
  htmlToText,
  normaliseWhitespace,
  quoteIsVerbatim,
  truncateForStorage,
} from "../src/text.mjs";

const SOURCE = `
Eligibility

Applicants must be resident in Zimbabwe, Zambia or Malawi at the time of
application. Applicants must be aged between 18 and 30 on 1 January 2027.

Applications close on 15 March 2027 at 23:59 CAT. There is no fee to apply.
`;

describe("quoteIsVerbatim", () => {
  it("accepts a sentence that is really in the document", () => {
    expect(
      quoteIsVerbatim("Applicants must be aged between 18 and 30 on 1 January 2027.", SOURCE),
    ).toBe(true);
  });

  it("accepts a quote whose line wrapping differs", () => {
    // The document wraps mid-sentence; a model reproducing it faithfully will not.
    expect(
      quoteIsVerbatim(
        "Applicants must be resident in Zimbabwe, Zambia or Malawi at the time of application.",
        SOURCE,
      ),
    ).toBe(true);
  });

  it("accepts a quote whose typography was straightened", () => {
    const curly = "Applicants must be aged between 18 and 30 on 1 January 2027.";
    const withCurlyApostrophe = "The organiser’s decision is final and binding on all applicants.";
    const source = "The organiser's decision is final and binding on all applicants.";
    expect(quoteIsVerbatim(curly, SOURCE)).toBe(true);
    expect(quoteIsVerbatim(withCurlyApostrophe, source)).toBe(true);
  });

  it("REJECTS a plausible sentence the document does not contain", () => {
    // This is the whole point. A model asked for eligibility rules will happily
    // produce a sentence that sounds exactly like the rest of the page.
    expect(
      quoteIsVerbatim("Applicants must be resident in Kenya at the time of application.", SOURCE),
    ).toBe(false);
  });

  it("REJECTS a paraphrase, however faithful", () => {
    expect(quoteIsVerbatim("Applicants have to be between 18 and 30 years old.", SOURCE)).toBe(
      false,
    );
  });

  it("REJECTS a quote too short to be evidence of anything", () => {
    // "Africa" appears on every page in this catalogue; matching it would let a rule
    // through on a coincidence.
    expect(quoteIsVerbatim("Zimbabwe", SOURCE)).toBe(false);
    expect(quoteIsVerbatim("18 and 30", SOURCE)).toBe(false);
  });

  it("REJECTS an empty or missing quote", () => {
    expect(quoteIsVerbatim("", SOURCE)).toBe(false);
    expect(quoteIsVerbatim("   ", SOURCE)).toBe(false);
  });
});

describe("checkNoCopiedPhrase", () => {
  it("passes a summary written in our own words", () => {
    const summary =
      "A grant for young people in southern Africa, open until the middle of March next year.";
    expect(checkNoCopiedPhrase(summary, SOURCE).ok).toBe(true);
  });

  it("fails a summary that lifts eight consecutive words", () => {
    const summary = "Applicants must be resident in Zimbabwe, Zambia or Malawi and should apply now.";
    const result = checkNoCopiedPhrase(summary, SOURCE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The offending phrase is reported, because the operator rewriting the summary
      // needs to know which sentence was copied.
      expect(result.phrase).toContain("applicants must be resident in zimbabwe");
    }
  });

  it("allows a seven-word overlap, which is the stated boundary", () => {
    // §2.1 rule 6 says eight. Seven has to pass, or the check is not the one specified.
    const summary = "Applicants must be resident in Zimbabwe, Zambia and may apply once.";
    expect(checkNoCopiedPhrase(summary, SOURCE).ok).toBe(true);
  });

  it("is not fooled by punctuation or case changes", () => {
    const summary = "APPLICANTS MUST BE RESIDENT IN ZIMBABWE, ZAMBIA OR MALAWI!!!";
    expect(checkNoCopiedPhrase(summary, SOURCE).ok).toBe(false);
  });

  it("passes trivially when either side is shorter than the window", () => {
    expect(checkNoCopiedPhrase("Short summary.", SOURCE).ok).toBe(true);
    expect(checkNoCopiedPhrase("A rather longer summary than that one.", "tiny").ok).toBe(true);
  });
});

describe("htmlToText", () => {
  it("strips scripts, styles and page chrome", () => {
    const { text } = htmlToText(`
      <html><head><title>A Grant</title><style>.a{color:red}</style></head>
      <body>
        <nav><a href="/">Home</a><a href="/donate">Donate</a></nav>
        <header>Site header</header>
        <main><p>Applications close on 15 March.</p></main>
        <script>tracker()</script>
        <footer>Privacy policy</footer>
      </body></html>`);

    expect(text).toContain("Applications close on 15 March.");
    // Keeping chrome would put "Donate" and "Privacy policy" into every extraction.
    expect(text).not.toContain("Donate");
    expect(text).not.toContain("Privacy policy");
    expect(text).not.toContain("tracker()");
    expect(text).not.toContain("color:red");
  });

  it("returns the document title separately", () => {
    expect(htmlToText("<title>A &amp; B Grant</title><p>x</p>").title).toBe("A & B Grant");
  });

  it("keeps block boundaries so sentences do not fuse", () => {
    // Two list items run together would produce a sentence the document does not
    // contain — and then a real rule would fail the verbatim check.
    const { text } = htmlToText("<ul><li>Resident in Zimbabwe</li><li>Aged 18 to 30</li></ul>");
    expect(text.split("\n").filter(Boolean)).toEqual(["Resident in Zimbabwe", "Aged 18 to 30"]);
    expect(text).not.toContain("ZimbabweAged");
    expect(text).not.toContain("Zimbabwe Aged");
  });

  it("decodes the entities that appear in real listings", () => {
    const { text } = htmlToText("<p>R&amp;D grant &mdash; up to &pound;5,000 &nbsp;each</p>");
    expect(text).toBe("R&D grant — up to £5,000 each");
  });

  it("survives malformed markup rather than throwing", () => {
    expect(() => htmlToText("<p>unclosed <div><span>tags")).not.toThrow();
    expect(() => htmlToText("<!-- <p>commented out")).not.toThrow();
  });
});

describe("normaliseWhitespace and truncateForStorage", () => {
  it("collapses runs of space but keeps paragraph breaks", () => {
    // A deadline usually sits on its own line; flattening loses the only cue that
    // "15 March" is a heading rather than part of a sentence.
    expect(normaliseWhitespace("a  \t b\n\n\n\nc")).toBe("a b\n\nc");
  });

  it("truncates to the 40 KB storage limit at a sentence boundary", () => {
    const long = `${"Sentence one is here. ".repeat(4000)}`;
    const out = truncateForStorage(long);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(40 * 1024);
    expect(out.endsWith("here.")).toBe(true);
  });

  it("never splits a multi-byte character", () => {
    const out = truncateForStorage("é".repeat(30_000), 100);
    expect(out).not.toContain("�");
  });

  it("leaves a short document alone", () => {
    expect(truncateForStorage("Applications close on 15 March.")).toBe(
      "Applications close on 15 March.",
    );
  });
});

describe("comparable", () => {
  it("folds the punctuation a copy-paste mangles", () => {
    expect(comparable("“Don’t — really”")).toBe('"don\'t - really"');
  });
});
