/**
 * URL canonicalisation is the dedupe key for the whole catalogue
 * (OPPORTUNITY_INGESTION.md §4.6 rule 1 makes a canonical-URL match a CERTAIN
 * duplicate and auto-merges on it), so both directions of error are user-visible:
 * too little normalisation creates duplicate listings, too much merges two
 * different opportunities into one.
 */

import { describe, expect, it } from "vitest";

import { canonicaliseUrl, hostOf, sameHost } from "../src/urls.mjs";

describe("canonicaliseUrl", () => {
  it("strips the tracking parameters §4.3 names", () => {
    expect(
      canonicaliseUrl("https://example.org/grant?utm_source=twitter&utm_medium=social&fbclid=abc"),
    ).toBe("https://example.org/grant");
    expect(canonicaliseUrl("https://example.org/g?gclid=x&PHPSESSID=y")).toBe(
      "https://example.org/g",
    );
  });

  it("keeps parameters that might select content", () => {
    // Stripping these would merge two different opportunities into one, which is
    // the expensive direction of this error.
    expect(canonicaliseUrl("https://example.org/list?id=42")).toBe("https://example.org/list?id=42");
    expect(canonicaliseUrl("https://example.org/list?page=2&year=2026")).toBe(
      "https://example.org/list?page=2&year=2026",
    );
  });

  it("orders the surviving parameters, so one page is one key", () => {
    expect(canonicaliseUrl("https://example.org/a?b=2&a=1")).toBe(
      canonicaliseUrl("https://example.org/a?a=1&b=2"),
    );
  });

  it("lowercases the host but never the path", () => {
    // Paths are case-sensitive on most servers: /Grant and /grant can be two pages.
    expect(canonicaliseUrl("https://EXAMPLE.org/Grant")).toBe("https://example.org/Grant");
  });

  it("drops a trailing slash from a path but keeps the root one", () => {
    expect(canonicaliseUrl("https://example.org/grant/")).toBe("https://example.org/grant");
    expect(canonicaliseUrl("https://example.org/")).toBe("https://example.org/");
  });

  it("drops the fragment, which never identifies a different page", () => {
    expect(canonicaliseUrl("https://example.org/grant#eligibility")).toBe(
      "https://example.org/grant",
    );
  });

  it("drops a default port", () => {
    expect(canonicaliseUrl("https://example.org:443/grant")).toBe("https://example.org/grant");
    expect(canonicaliseUrl("http://example.org:80/grant")).toBe("http://example.org/grant");
  });

  it("keeps a non-default port, which really is a different service", () => {
    expect(canonicaliseUrl("https://example.org:8443/grant")).toBe("https://example.org:8443/grant");
  });

  it("strips credentials rather than storing them", () => {
    expect(canonicaliseUrl("https://user:pass@example.org/grant")).toBe("https://example.org/grant");
  });

  it("refuses anything that is not http(s)", () => {
    // These must never reach the database: a stored javascript: URL is a stored XSS.
    expect(canonicaliseUrl("javascript:alert(1)")).toBeNull();
    expect(canonicaliseUrl("data:text/html,<script>")).toBeNull();
    expect(canonicaliseUrl("mailto:someone@example.org")).toBeNull();
    expect(canonicaliseUrl("ftp://example.org/f")).toBeNull();
  });

  it("refuses nonsense instead of inventing a URL", () => {
    expect(canonicaliseUrl("")).toBeNull();
    expect(canonicaliseUrl("   ")).toBeNull();
    expect(canonicaliseUrl("not a url")).toBeNull();
  });

  it("resolves a relative URL against the page it was found on", () => {
    expect(canonicaliseUrl("/apply", "https://example.org/grants/one")).toBe(
      "https://example.org/apply",
    );
    expect(canonicaliseUrl("two", "https://example.org/grants/one")).toBe(
      "https://example.org/grants/two",
    );
  });
});

describe("hostOf and sameHost", () => {
  it("ignores www but keeps real subdomains", () => {
    // grants.example.org and careers.example.org are often different departments;
    // collapsing them would attach an opportunity to the wrong organisation.
    expect(hostOf("https://www.example.org/x")).toBe("example.org");
    expect(hostOf("https://grants.example.org/x")).toBe("grants.example.org");
    expect(sameHost("https://www.example.org/a", "https://example.org/b")).toBe(true);
    expect(sameHost("https://grants.example.org/a", "https://example.org/b")).toBe(false);
  });

  it("is how §5.2 detects a redirect to a different host", () => {
    // A programme that moved domain and a domain that was sold to someone else look
    // identical from the outside, and the second is a known scam vector.
    expect(sameHost("https://programme.example.org/a", "https://prize-winners.example/a")).toBe(
      false,
    );
  });
});
