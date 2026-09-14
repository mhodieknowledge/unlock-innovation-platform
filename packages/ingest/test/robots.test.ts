/**
 * robots.txt handling. OPPORTUNITY_INGESTION.md §2.1 rule 1, "non-negotiable".
 *
 * §2 puts the legal posture above coverage, and the source tiers exist so that
 * losing one page costs little. So the tests here check that we honour a refusal
 * even when it is expressed in the awkward ways real files use.
 */

import { describe, expect, it } from "vitest";

import { delayFor, isAllowed, parseRobots } from "../src/robots.mjs";

const AGENT = "mbelebot";

describe("parseRobots", () => {
  it("reads the group that names us", () => {
    const robots = parseRobots(
      `User-agent: *\nDisallow: /\n\nUser-agent: MbeleBot\nAllow: /\nCrawl-delay: 5\n`,
      AGENT,
    );
    expect(robots.explicit).toBe(true);
    expect(isAllowed(robots, "https://example.org/grants")).toBe(true);
    expect(robots.crawlDelaySeconds).toBe(5);
  });

  it("falls back to the wildcard group", () => {
    const robots = parseRobots(`User-agent: *\nDisallow: /private/\n`, AGENT);
    expect(isAllowed(robots, "https://example.org/grants")).toBe(true);
    expect(isAllowed(robots, "https://example.org/private/x")).toBe(false);
  });

  it("treats consecutive User-agent lines as ONE group", () => {
    // The classic parsing bug: reading each line as a new group makes a crawler
    // ignore a directive that was meant for it.
    const robots = parseRobots(
      `User-agent: GoogleBot\nUser-agent: MbeleBot\nDisallow: /secret/\n`,
      AGENT,
    );
    expect(isAllowed(robots, "https://example.org/secret/x")).toBe(false);
  });

  it("matches a prefix of our token, as crawlers are expected to", () => {
    const robots = parseRobots(`User-agent: mbele\nDisallow: /\n`, AGENT);
    expect(isAllowed(robots, "https://example.org/anything")).toBe(false);
  });

  it("prefers the group naming us over the wildcard, even when stricter", () => {
    const robots = parseRobots(
      `User-agent: *\nAllow: /\n\nUser-agent: MbeleBot\nDisallow: /\n`,
      AGENT,
    );
    expect(isAllowed(robots, "https://example.org/grants")).toBe(false);
  });

  it("ignores comments and blank lines", () => {
    const robots = parseRobots(`# a comment\n\nUser-agent: *  # inline\nDisallow: /x  # here\n`, AGENT);
    expect(isAllowed(robots, "https://example.org/x")).toBe(false);
  });

  it("reads an empty Disallow as allow-everything", () => {
    const robots = parseRobots(`User-agent: *\nDisallow:\n`, AGENT);
    expect(isAllowed(robots, "https://example.org/anything")).toBe(true);
  });

  it("collects sitemaps, which are global rather than per group", () => {
    const robots = parseRobots(
      `Sitemap: https://example.org/sitemap.xml\nUser-agent: *\nDisallow: /x\n`,
      AGENT,
    );
    expect(robots.sitemaps).toEqual(["https://example.org/sitemap.xml"]);
  });

  it("returns nothing useful for junk, rather than inventing permission", () => {
    const robots = parseRobots("<html>404 not found</html>", AGENT);
    expect(robots.explicit).toBe(false);
    expect(robots.rules).toEqual([]);
  });
});

describe("isAllowed", () => {
  it("gives the longest matching pattern precedence", () => {
    // This is what lets a site disallow a directory and allow one page inside it.
    const robots = parseRobots(
      `User-agent: *\nDisallow: /programmes/\nAllow: /programmes/open-call\n`,
      AGENT,
    );
    expect(isAllowed(robots, "https://example.org/programmes/anything")).toBe(false);
    expect(isAllowed(robots, "https://example.org/programmes/open-call")).toBe(true);
  });

  it("gives Allow the tie on an equal-length match", () => {
    const robots = parseRobots(`User-agent: *\nDisallow: /x\nAllow: /x\n`, AGENT);
    expect(isAllowed(robots, "https://example.org/x")).toBe(true);
  });

  it("handles * inside a pattern", () => {
    const robots = parseRobots(`User-agent: *\nDisallow: /*/private\n`, AGENT);
    expect(isAllowed(robots, "https://example.org/a/private")).toBe(false);
    expect(isAllowed(robots, "https://example.org/a/public")).toBe(true);
  });

  it("handles the $ anchor", () => {
    const robots = parseRobots(`User-agent: *\nDisallow: /*.pdf$\n`, AGENT);
    expect(isAllowed(robots, "https://example.org/rules.pdf")).toBe(false);
    expect(isAllowed(robots, "https://example.org/rules.pdf.html")).toBe(true);
  });

  it("matches against the query string as well as the path", () => {
    const robots = parseRobots(`User-agent: *\nDisallow: /search?\n`, AGENT);
    expect(isAllowed(robots, "https://example.org/search?q=x")).toBe(false);
  });

  it("refuses a URL it cannot parse", () => {
    const robots = parseRobots(`User-agent: *\nAllow: /\n`, AGENT);
    expect(isAllowed(robots, "not a url")).toBe(false);
  });

  it("allows a path no rule mentions", () => {
    // A robots.txt that says nothing about a path is not a refusal. The fail-closed
    // rule is about a robots.txt we could not READ, which the fetcher decides.
    const robots = parseRobots(`User-agent: *\nDisallow: /private/\n`, AGENT);
    expect(isAllowed(robots, "https://example.org/")).toBe(true);
  });
});

describe("delayFor", () => {
  it("honours our own ten-second floor when robots asks for less", () => {
    // §2.1 rule 4 is our promise, not the site's. Being asked to go faster is not
    // permission to.
    const robots = parseRobots(`User-agent: *\nCrawl-delay: 1\n`, AGENT);
    expect(delayFor(robots)).toBe(10_000);
  });

  it("honours a longer delay when a site asks for one", () => {
    const robots = parseRobots(`User-agent: *\nCrawl-delay: 30\n`, AGENT);
    expect(delayFor(robots)).toBe(30_000);
  });

  it("defaults to the floor when no delay is stated", () => {
    expect(delayFor(parseRobots(`User-agent: *\nAllow: /\n`, AGENT))).toBe(10_000);
  });
});
