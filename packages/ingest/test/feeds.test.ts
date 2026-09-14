/**
 * Feed parsing. OPPORTUNITY_INGESTION.md §2 tier 2 calls feeds "the backbone of this
 * pipeline", so these tests are about the ways real feeds are broken.
 */

import { describe, expect, it } from "vitest";

import { itemsSince, parseFeed, parseSitemap } from "../src/feeds.mjs";

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Opportunity Desk</title>
    <link>https://example.org</link>
    <item>
      <title><![CDATA[Climate Grant 2027 — Apply Now]]></title>
      <link>https://example.org/climate-grant?utm_source=rss</link>
      <pubDate>Mon, 08 Sep 2026 09:00:00 +0000</pubDate>
      <description><![CDATA[<p>A grant for <b>climate</b> work.</p>]]></description>
    </item>
    <item>
      <title>Scholarship Call</title>
      <guid isPermaLink="true">https://example.org/scholarship</guid>
      <dc:date>2026-09-07T12:00:00Z</dc:date>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Disrupt Africa</title>
  <link rel="self" href="https://example.org/feed"/>
  <entry>
    <title>Accelerator opens</title>
    <link rel="self" href="https://example.org/feed?entry=1"/>
    <link rel="alternate" href="https://example.org/accelerator"/>
    <updated>2026-09-06T08:00:00Z</updated>
    <summary>Applications open.</summary>
  </entry>
</feed>`;

describe("parseFeed", () => {
  it("reads RSS items", () => {
    const items = parseFeed(RSS, "https://example.org/feed");
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe("Climate Grant 2027 — Apply Now");
    expect(items[0]?.publishedAt).toBe("2026-09-08T09:00:00.000Z");
  });

  it("canonicalises item links, so tracking parameters do not create duplicates", () => {
    expect(parseFeed(RSS, "https://example.org/feed")[0]?.url).toBe(
      "https://example.org/climate-grant",
    );
  });

  it("unwraps CDATA and strips the HTML a description carries", () => {
    expect(parseFeed(RSS, "https://example.org/feed")[0]?.summary).toBe("A grant for climate work.");
  });

  it("falls back to guid when there is no link", () => {
    expect(parseFeed(RSS, "https://example.org/feed")[1]?.url).toBe("https://example.org/scholarship");
  });

  it("reads Atom entries and takes the ALTERNATE link", () => {
    // Taking the first link found gives the feed's own URL for every item, which is
    // how one article gets ingested forty times.
    const items = parseFeed(ATOM, "https://example.org/feed");
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe("https://example.org/accelerator");
  });

  it("resolves a relative link against the feed", () => {
    const xml = `<rss><channel><item><title>T</title><link>/relative-grant</link></item></channel></rss>`;
    expect(parseFeed(xml, "https://example.org/feed")[0]?.url).toBe(
      "https://example.org/relative-grant",
    );
  });

  it("drops an item with no usable link rather than inventing one", () => {
    const xml = `<rss><channel><item><title>No link here</title></item></channel></rss>`;
    expect(parseFeed(xml, "https://example.org/feed")).toEqual([]);
  });

  it("de-duplicates items that point at the same page", () => {
    const xml = `<rss><channel>
      <item><title>A</title><link>https://example.org/x</link></item>
      <item><title>B</title><link>https://example.org/x?utm_source=a</link></item>
    </channel></rss>`;
    expect(parseFeed(xml, "https://example.org/feed")).toHaveLength(1);
  });

  it("ignores a date from a broken clock", () => {
    const xml = `<rss><channel><item><title>T</title><link>https://example.org/x</link>
      <pubDate>Mon, 08 Sep 2099 09:00:00 +0000</pubDate></item></channel></rss>`;
    expect(parseFeed(xml, "https://example.org/feed")[0]?.publishedAt).toBeNull();
  });

  it("survives junk rather than throwing", () => {
    expect(parseFeed("<html>not a feed</html>", "https://example.org/feed")).toEqual([]);
    expect(parseFeed("", "https://example.org/feed")).toEqual([]);
    expect(parseFeed("<rss><channel><item><link>", "https://example.org/feed")).toEqual([]);
  });
});

describe("parseSitemap", () => {
  it("reads urls and lastmod", () => {
    const xml = `<urlset><url><loc>https://example.org/a</loc><lastmod>2026-09-01</lastmod></url>
      <url><loc>https://example.org/b</loc></url></urlset>`;
    const entries = parseSitemap(xml, "https://example.org/sitemap.xml");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.lastmod).toBe("2026-09-01T00:00:00.000Z");
    expect(entries[1]?.lastmod).toBeNull();
  });

  it("reads a sitemap index too", () => {
    const xml = `<sitemapindex><sitemap><loc>https://example.org/s1.xml</loc></sitemap></sitemapindex>`;
    expect(parseSitemap(xml, "https://example.org/sitemap.xml")[0]?.url).toBe(
      "https://example.org/s1.xml",
    );
  });
});

describe("itemsSince", () => {
  const items = parseFeed(RSS, "https://example.org/feed");

  it("filters by date when one is given", () => {
    expect(itemsSince(items, new Date("2026-09-08T00:00:00Z"))).toHaveLength(1);
  });

  it("KEEPS items with no date", () => {
    // A feed that omits pubDate is common; dropping those would silently ignore
    // whole sources. Re-seeing an old item is cheap — the content hash catches it.
    const undated = parseFeed(
      `<rss><channel><item><title>T</title><link>https://example.org/x</link></item></channel></rss>`,
      "https://example.org/feed",
    );
    expect(itemsSince(undated, new Date("2030-01-01"))).toHaveLength(1);
  });

  it("returns everything when no date is given", () => {
    expect(itemsSince(items, null)).toHaveLength(2);
  });
});
