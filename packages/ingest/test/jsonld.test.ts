/**
 * JSON-LD parsing. OPPORTUNITY_INGESTION.md §4.4 ("JSON-LD wins over the model on
 * any field it supplies, because it is publisher-authored") and AI_SYSTEM.md §4,
 * where this path IS the NO_AI fallback — the one that keeps the pipeline producing
 * records when every LLM quota is gone.
 */

import { describe, expect, it } from "vitest";

import { extractJsonLd, findOpportunityNode, recordFromJsonLd } from "../src/jsonld.mjs";

const page = (json: string) =>
  `<html><head><script type="application/ld+json">${json}</script></head><body>x</body></html>`;

const EVENT = {
  "@context": "https://schema.org",
  "@type": "Event",
  name: "Climate Innovation Challenge 2027",
  startDate: "2027-04-01",
  endDate: "2027-04-03",
  eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
  isAccessibleForFree: true,
  url: "https://example.org/challenge?utm_source=newsletter",
  organizer: { "@type": "Organization", name: "Example Foundation" },
  offers: { "@type": "Offer", price: 0, validThrough: "2027-03-15T23:59:00Z" },
};

describe("extractJsonLd", () => {
  it("finds a block", () => {
    expect(extractJsonLd(page(JSON.stringify(EVENT)))).toHaveLength(1);
  });

  it("finds several blocks, which is normal on a real page", () => {
    const html = page(JSON.stringify(EVENT)) + page(JSON.stringify({ "@type": "WebSite" }));
    expect(extractJsonLd(html)).toHaveLength(2);
  });

  it("does not lose the good blocks when one is malformed", () => {
    // Publishers ship broken JSON-LD routinely; a parse failure is their bug and
    // not worth failing the fetch over.
    const html = page("{ not json ,,, }") + page(JSON.stringify(EVENT));
    expect(extractJsonLd(html)).toHaveLength(1);
  });

  it("unwraps a block hidden inside an HTML comment", () => {
    expect(extractJsonLd(page(`<!-- ${JSON.stringify(EVENT)} -->`))).toHaveLength(1);
  });

  it("returns nothing for a page with no structured data", () => {
    expect(extractJsonLd("<html><body><p>A grant</p></body></html>")).toEqual([]);
  });
});

describe("findOpportunityNode", () => {
  it("reaches into @graph, where most CMSs put it", () => {
    const blocks = extractJsonLd(
      page(JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "WebPage" }, EVENT] })),
    );
    expect(findOpportunityNode(blocks)?.["name"]).toBe("Climate Innovation Challenge 2027");
  });

  it("ignores node types that are not opportunities", () => {
    const blocks = extractJsonLd(page(JSON.stringify({ "@type": "BreadcrumbList" })));
    expect(findOpportunityNode(blocks)).toBeNull();
  });

  it("handles a fully-qualified @type", () => {
    const blocks = extractJsonLd(
      page(JSON.stringify({ ...EVENT, "@type": "https://schema.org/Event" })),
    );
    expect(findOpportunityNode(blocks)).not.toBeNull();
  });
});

describe("recordFromJsonLd — the NO_AI fallback", () => {
  it("builds a partial record from publisher-authored fields", () => {
    const blocks = extractJsonLd(page(JSON.stringify(EVENT)));
    const out = recordFromJsonLd(blocks, "https://example.org/challenge");
    expect(out).not.toBeNull();
    expect(out?.record["title"]).toBe("Climate Innovation Challenge 2027");
    expect(out?.record["organisation_name"]).toBe("Example Foundation");
    expect(out?.record["participation_mode"]).toBe("online");
    expect(out?.record["cost"]).toBe("free");
    expect(out?.record["starts_at"]).toBe("2027-04-01T00:00:00.000Z");
  });

  it("takes the deadline from validThrough, never from endDate", () => {
    // A deadline is when you must apply. When an event finishes is not that, and
    // using it would tell someone they have days left after applications closed.
    const blocks = extractJsonLd(page(JSON.stringify(EVENT)));
    const out = recordFromJsonLd(blocks, "https://example.org/challenge");
    expect(out?.record["deadline_at"]).toBe("2027-03-15T23:59:00.000Z");
  });

  it("prefers applicationDeadline when the publisher states one", () => {
    const blocks = extractJsonLd(
      page(JSON.stringify({ ...EVENT, applicationDeadline: "2027-02-01" })),
    );
    expect(recordFromJsonLd(blocks, "https://example.org/x")?.record["deadline_at"]).toBe(
      "2027-02-01T00:00:00.000Z",
    );
  });

  it("canonicalises the URL it found", () => {
    const blocks = extractJsonLd(page(JSON.stringify(EVENT)));
    expect(recordFromJsonLd(blocks, "https://example.org/x")?.record["official_url"]).toBe(
      "https://example.org/challenge",
    );
  });

  it("marks every field it supplies as certain, because nothing was inferred", () => {
    const blocks = extractJsonLd(page(JSON.stringify(EVENT)));
    const out = recordFromJsonLd(blocks, "https://example.org/x");
    expect(out?.confidence["title"]).toBe(1);
    expect(out?.confidence["deadline"]).toBe(1);
  });

  it("leaves cost unknown rather than guessing — invariant 13 turns on this field", () => {
    const { isAccessibleForFree, offers, ...noCostInfo } = EVENT;
    const blocks = extractJsonLd(page(JSON.stringify(noCostInfo)));
    const out = recordFromJsonLd(blocks, "https://example.org/x");
    expect(out?.record["cost"]).toBeUndefined();
  });

  it("reads a paid offer as paid", () => {
    const blocks = extractJsonLd(
      page(
        JSON.stringify({
          ...EVENT,
          isAccessibleForFree: undefined,
          offers: { price: 25, priceCurrency: "USD" },
        }),
      ),
    );
    expect(recordFromJsonLd(blocks, "https://example.org/x")?.record["cost"]).toBe("paid");
  });

  it("handles offers given as an array, which the spec allows", () => {
    const blocks = extractJsonLd(
      page(JSON.stringify({ ...EVENT, offers: [{ price: 0, validThrough: "2027-03-01" }] })),
    );
    expect(recordFromJsonLd(blocks, "https://example.org/x")?.record["deadline_at"]).toBe(
      "2027-03-01T00:00:00.000Z",
    );
  });

  it("ignores a locale-ambiguous date rather than guessing the month", () => {
    const blocks = extractJsonLd(
      page(JSON.stringify({ ...EVENT, applicationDeadline: "03/04/2027" })),
    );
    // Falls through to validThrough, which is well-formed.
    expect(recordFromJsonLd(blocks, "https://example.org/x")?.record["deadline_at"]).toBe(
      "2027-03-15T23:59:00.000Z",
    );
  });

  it("returns null when there is nothing usable, so the document waits", () => {
    // §4: "Otherwise the document waits. Nothing is published from a failed
    // extraction."
    expect(recordFromJsonLd([], "https://example.org/x")).toBeNull();
    expect(
      recordFromJsonLd(extractJsonLd(page(JSON.stringify({ "@type": "Event" }))), "https://e.org/x"),
    ).toBeNull();
  });
});
