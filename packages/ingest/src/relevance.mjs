/**
 * Is this page an opportunity at all, or an article about opportunities?
 *
 * FOUR THINGS ON THE LIVE BOARD WERE NOT OPPORTUNITIES:
 *
 *   MCAT 2026: Complete Guide for Students Who Want To Study Medicine In US
 *   France Student Visa Financial Requirements 2026/2027
 *   6 Countries That Allow International Students to Work While Studying
 *   Coursera Introduction to Generative AI
 *
 * They are on the board because extract.v1.md opens by TELLING the model "the page is about an
 * opportunity" and never invites it to disagree. The aggregator feeds the catalogue reads —
 * Opportunity Desk, Scholarship Region, After School Africa — mix advice posts in with
 * listings, and CONTENT_AND_LAUNCH.md §40 said so in advance: "Expect heavy filtering: most
 * items will be global scholarships rather than builder opportunities, so category and
 * relevance filters do the work." The relevance filter was the part that did not exist.
 *
 * WHY A PATTERN AND NOT A MODEL, when I have just argued the other way for categories. The
 * distinction there was semantic — a mention of a scholarship against a declaration of one —
 * and semantics is a model's job. This one is not semantic at all. "How to", "Complete Guide",
 * "6 Countries That…" are a HEADLINE FORM: journalism has spent a century making these shapes
 * instantly recognisable, and they live in the title, where AI_SYSTEM.md §10's "deterministic
 * checks run first and are never skipped" applies.
 *
 * IT NEVER DELETES AND NEVER REJECTS. A match routes the record to `in_review`, which is §10's
 * action for a pre-screen signal: a person sees it, the record is not lost, and the board stops
 * carrying visa explainers in the meantime. Every pattern here is one a reader could argue
 * with, so the answer to a wrong one is a queue and not a deletion.
 */

/**
 * Headline forms, each with the name of the shape it recognises so a log line and a review
 * queue can both say WHY rather than just "filtered".
 *
 * Ordered by how sure they are. Everything is anchored to structure — a leading count, a
 * colon-and-guide, an interrogative opening — rather than to subject matter, because subject
 * words are what produce false positives: a "Guide" in the middle of a real programme's name
 * ("Guide Dogs Innovation Grant") must not match, and does not.
 *
 * @type {ReadonlyArray<readonly [RegExp, string]>}
 */
const ARTICLE_SHAPES = /** @type {const} */ ([
  // A COUNT, NOT A YEAR. The first draft was /^\d+\s+[A-Z]?[a-z]+/ and it flagged "2027 Khalifa
  // University Graduate Scholarship in UAE" as a listicle. Leading years are ordinary in this
  // catalogue — "2026 UBA National Essay Competition" — so they are excluded by name rather
  // than left to the accident that UBA has no lowercase letters. A listicle counts things, so
  // the noun after the number is plural.
  [/^(?!(?:19|20)\d{2}\b)\d{1,2}\s+[A-Za-z]+s\b/, "a listicle: it opens with a count"],
  [/\b(?:complete|ultimate|full|step[- ]by[- ]step)\s+guide\b/i, "a guide"],
  [/\ba\s+guide\s+to\b|\bguide\s+(?:for|to)\s+(?:students|applicants|beginners)\b/i, "a guide"],
  [/^how\s+to\b|\bhere'?s\s+how\b/i, "an instructional headline"],
  [/\beverything\s+you\s+need\s+to\know\b|\beverything\s+you\s+need\s+to\s+know\b/i, "an explainer"],
  [/^(?:what|why|when|where|who|which)\s+(?:is|are|was|were|do|does|did|you|to)\b/i, "a question headline"],
  [/^top\s+\d+\b/i, "a ranked list"],
  [/\bvisa\s+(?:requirements?|financial\s+requirements?|process)\b/i, "a visa explainer"],
  [/\b(?:explained|demystified)\b/i, "an explainer"],
  [/\b(?:tips|checklist|faqs?)\s+(?:for|on)\b/i, "advice"],
]);

/** Every reason this module can give, for the drift test. */
export const ARTICLE_REASONS = [...new Set(ARTICLE_SHAPES.map(([, reason]) => reason))];

/**
 * The reason this title reads as an article, or null when it reads as an opportunity.
 *
 * The title alone, for the reason given in packages/ingest/src/categorise.mjs: a page's body
 * mentions things, and a mention is not a declaration. An opportunity page that explains how
 * to apply says "how to apply" in its body constantly.
 *
 * @param {{ title?: string | null }} record
 * @returns {string | null}
 */
export function articleShape(record) {
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) return null;
  for (const [pattern, reason] of ARTICLE_SHAPES) if (pattern.test(title)) return reason;
  return null;
}
