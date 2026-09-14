/**
 * RSS and Atom parsing. OPPORTUNITY_INGESTION.md §2 tier 2 — "publisher-intended
 * machine consumption. THE BACKBONE OF THIS PIPELINE."
 *
 * A hand-written parser rather than a dependency, for the reason §2 gives feeds
 * pride of place in the first instance: this is the highest-volume path in the
 * system, it runs on a free tier, and every dependency in the batch tier is
 * supply-chain surface (SECURITY.md §8). What is needed from a feed is four fields
 * per item, and the failure mode of getting them slightly wrong is a document that
 * goes to review rather than a wrong published record.
 *
 * Written to be forgiving in the ways real feeds are broken and strict about the one
 * thing that matters: a link we cannot canonicalise is not an item.
 */

import { canonicaliseUrl } from "./urls.mjs";
import { decodeEntities, normaliseWhitespace } from "./text.mjs";

/**
 * @typedef {object} FeedItem
 * @property {string} url        canonical
 * @property {string | null} title
 * @property {string | null} publishedAt  ISO 8601
 * @property {string | null} summary      the feed's own description, for triage only
 */

/** @param {string} xml @param {string} tag @returns {string[]} */
function blocks(xml, tag) {
  /** @type {string[]} */
  const out = [];
  const rx = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let m;
  while ((m = rx.exec(xml)) !== null) out.push(m[1] ?? "");
  return out;
}

/** First value of a simple element, CDATA unwrapped. @param {string} xml @param {string} tag */
function value(xml, tag) {
  const rx = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = rx.exec(xml);
  if (!m) return null;
  const raw = (m[1] ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const text = normaliseWhitespace(decodeEntities(raw.replace(/<[^>]+>/g, " ")));
  return text || null;
}

/**
 * Atom links are attributes, and a feed usually has several — alternate, self,
 * replies. The alternate is the article; taking the first link found gives you the
 * feed's own URL for every item, which is the classic way to ingest one item forty
 * times.
 *
 * @param {string} xml
 */
function atomLink(xml) {
  const rx = /<link\b([^>]*)\/?>/gi;
  let fallback = null;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const attrs = m[1] ?? "";
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase();
    if (rel === undefined || rel === "alternate") return href;
    if (fallback === null && rel !== "self") fallback = href;
  }
  return fallback;
}

/** @param {string | null} raw @returns {string | null} */
function isoDate(raw) {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  // A feed date far in the future is a broken clock, not news.
  if (date.getTime() > Date.now() + 86_400_000 * 2) return null;
  return date.toISOString();
}

/**
 * Parse an RSS 2.0 or Atom feed.
 *
 * @param {string} xml
 * @param {string} feedUrl  base for resolving relative links
 * @returns {FeedItem[]}
 */
export function parseFeed(xml, feedUrl) {
  if (typeof xml !== "string" || !xml.trim()) return [];

  /** @type {FeedItem[]} */
  const items = [];
  const seen = new Set();

  /**
   * @param {string | null} rawUrl
   * @param {string | null} title
   * @param {string | null} published
   * @param {string | null} summary
   */
  const push = (rawUrl, title, published, summary) => {
    const url = canonicaliseUrl(String(rawUrl ?? ""), feedUrl);
    // No usable link, no item. Everything downstream is keyed on the canonical URL.
    if (!url || seen.has(url)) return;
    seen.add(url);
    items.push({
      url,
      title: title ?? null,
      publishedAt: published ?? null,
      summary: summary ? summary.slice(0, 1000) : null,
    });
  };

  for (const item of blocks(xml, "item")) {
    push(
      value(item, "link") ?? value(item, "guid"),
      value(item, "title"),
      isoDate(value(item, "pubDate") ?? value(item, "dc:date")),
      value(item, "description"),
    );
  }

  for (const entry of blocks(xml, "entry")) {
    push(
      atomLink(entry) ?? value(entry, "id"),
      value(entry, "title"),
      isoDate(value(entry, "updated") ?? value(entry, "published")),
      value(entry, "summary") ?? value(entry, "content"),
    );
  }

  return items;
}

/**
 * Parse a sitemap or sitemap index. §2 tier 3 — "published for machines".
 *
 * @param {string} xml
 * @param {string} baseUrl
 * @returns {Array<{ url: string, lastmod: string | null }>}
 */
export function parseSitemap(xml, baseUrl) {
  if (typeof xml !== "string") return [];
  /** @type {Array<{ url: string, lastmod: string | null }>} */
  const out = [];
  const seen = new Set();

  for (const entry of [...blocks(xml, "url"), ...blocks(xml, "sitemap")]) {
    const url = canonicaliseUrl(value(entry, "loc") ?? "", baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, lastmod: isoDate(value(entry, "lastmod")) });
  }
  return out;
}

/**
 * Items new enough to be worth fetching. §4.1: "Filter by lastmod/pubDate where
 * available."
 *
 * An item with NO date is kept: a feed that omits pubDate is common, and dropping
 * those would silently ignore whole sources. The dedupe-by-content-hash step
 * downstream is what makes re-seeing an old item cheap.
 *
 * @param {FeedItem[]} items
 * @param {Date | null} since
 */
export function itemsSince(items, since) {
  if (!since) return items;
  return items.filter((item) => item.publishedAt === null || new Date(item.publishedAt) >= since);
}
