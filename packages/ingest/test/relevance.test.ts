/**
 * Four things on the live board were not opportunities.
 *
 *   MCAT 2026: Complete Guide for Students Who Want To Study Medicine In US
 *   France Student Visa Financial Requirements 2026/2027
 *   6 Countries That Allow International Students to Work While Studying
 *   Coursera Introduction to Generative AI
 *
 * The aggregator feeds the catalogue reads publish advice posts alongside listings, and
 * extract.v1.md opens by telling the model "the page is about an opportunity" — so nothing ever
 * asked. CONTENT_AND_LAUNCH.md §40 predicted it: "Expect heavy filtering ... category and
 * relevance filters do the work."
 *
 * THE NEGATIVE CASES ARE THE POINT OF THIS FILE. A relevance filter that sends real
 * opportunities to review is worse than no filter, because a queue nobody can keep up with gets
 * ignored wholesale. So every title below the article ones is a real title from the live
 * catalogue on 16 September 2026, and none of them may match.
 */

import { describe, expect, it } from "vitest";

import { ARTICLE_REASONS, articleShape } from "../src/relevance.mjs";

/** The real non-opportunities, with the shape each one is recognised by. */
const ARTICLES: [string, RegExp][] = [
  ["MCAT 2026: Complete Guide for Students Who Want To Study Medicine In US", /guide/],
  ["France Student Visa Financial Requirements 2026/2027", /visa/],
  ["6 Countries That Allow International Students to Work While Studying", /listicle/],
];

/** Shapes the same feeds produce constantly, which had not yet reached the board. */
const MORE_ARTICLES: [string, RegExp][] = [
  ["10 Scholarships You Can Still Apply For This Month", /listicle/],
  ["How to Write a Winning Personal Statement", /instructional/],
  ["Top 5 Fellowships for African Researchers", /ranked/],
  ["What is a Chevening Scholarship?", /question/],
  ["Study in Canada: Everything You Need to Know", /explainer/],
  ["Tips for Applying to Graduate School", /advice/],
  ["The IELTS Explained", /explainer/],
];

/**
 * Real live titles that must NOT match. Several are deliberately close to an article shape:
 * a leading year, a programme with "Guide" in its name, a colon-and-subtitle headline.
 */
const OPPORTUNITIES = [
  "2027 Khalifa University Graduate Scholarship in UAE",
  "2026 UBA National Essay Competition For Nigerian Students",
  "Gates Cambridge Scholarships 2027-2028",
  "AfricaLics Visiting PhD Fellowship Programme 2027",
  "NextStep Hacks 2026",
  "Inside Mastercard: Interns & Launchers Americas 2026 – Explore Internship",
  "Build, Ship, Shape: Amazon Developer Hackathon",
  "Global Innovation Build Challenge V2",
  "RevenueCat Shipaton 2026",
  "Teach for Uganda STEM Fellowship 2026",
  "SAIBPP Bursary 2027",
  "Spirit Education Foundation Scholarship 2028",
  "TEF2025 - TEF Entrepreneurship Programme",
  "Anglo American Processing Development Programme 2026",
  "The Government of Japan Exchange and Teaching Programme 2027 for young Leaders",
  "Kectil Program 2027 for Young Leaders",
  "Collective Mind Collaboration Fellows 2026–2027",
  "Women in Foreign Affairs Mentorship Group 2026 with Alyse Nelson",
  "Nordic Baltic Youth Summit 2026",
  "R.O.A.D. Barbados Historic Handwriting Challenge",
  "The AWARD Leadership Program 2027 for Emerging African Women in Science",
  "Northeastern University Global Study Expo – Africa 2026",
  "The Clooney Foundation Waging Justice for Women Fellowship 2027",
  "Newberry Library Short-Term Fellowships 2027–28",
  "OpenCV AI Competition 2026, powered by AWS",
  // Planted traps, not from the catalogue: a real programme whose NAME contains a trigger word.
  "Guide Dogs Innovation Grant 2027",
  "How Foundation Fellowship 2027",
  "Top Gear Engineering Bursary",
];

describe("titles that are articles, not opportunities", () => {
  for (const [title, reason] of [...ARTICLES, ...MORE_ARTICLES]) {
    it(`"${title.slice(0, 44)}" is flagged`, () => {
      const shape = articleShape({ title });
      expect(shape, "should be recognised as an article").not.toBeNull();
      expect(shape!).toMatch(reason);
    });
  }

  it("gives a reason a review queue can display", () => {
    // "filtered" tells a reviewer nothing about whether the filter was right.
    for (const reason of ARTICLE_REASONS) expect(reason.length).toBeGreaterThan(4);
  });
});

describe("real listings, which must not be touched", () => {
  for (const title of OPPORTUNITIES) {
    it(`"${title.slice(0, 44)}" is left alone`, () => {
      expect(articleShape({ title })).toBeNull();
    });
  }

  it("says nothing about a missing title", () => {
    expect(articleShape({})).toBeNull();
    expect(articleShape({ title: "" })).toBeNull();
    expect(articleShape({ title: null })).toBeNull();
  });
});

describe("what it does not claim to catch", () => {
  it("does not recognise a course, because a course is not an article shape", () => {
    // "Coursera Introduction to Generative AI" was the fourth non-opportunity on the board and
    // this does not find it: it is a product page, structurally indistinguishable from a
    // programme's name. Pretending otherwise would mean a pattern loose enough to catch
    // "Introduction to Machine Learning Fellowship" too. It lands in `other`, where
    // --recategorise names it for a person.
    expect(articleShape({ title: "Coursera Introduction to Generative AI" })).toBeNull();
  });
});
