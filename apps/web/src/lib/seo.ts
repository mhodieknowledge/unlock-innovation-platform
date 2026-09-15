/**
 * Metadata and structured data. SEO.md §3–§4.
 *
 * Two rules shape everything here, and both are stated in §3:
 *
 *   "`description` is OUR summary, never copied source prose." So every description is built
 *   from typed fields — a deadline, a prize, a team size — and never from the source document.
 *   That is a copyright control as much as an SEO one (OPPORTUNITY_INGESTION.md §2.1).
 *
 *   "Never mark up a fact we have not verified. If `deadline_precision` is `month_only`, no
 *   exact `endDate` is emitted." So every builder below omits rather than approximates. A
 *   property missing from our markup costs a rich-result warning; a property invented costs the
 *   reader a date that was never true.
 *
 * Absolute URLs are built from the REQUEST origin, not from a configured domain: the same code
 * then produces correct markup on the production host, a preview deployment and a local run,
 * and there is no environment variable to forget.
 */

import {
  SCHEMA_TYPE_BY_CATEGORY,
  TITLE_MAX,
  DESCRIPTION_MAX,
  demonymPlural,
  BRAND,
} from "@mbele/config";

import type { OpportunityRow } from "./db";

export type JsonLd = Record<string, unknown>;

/** Absolute, from the origin actually serving the page. */
export const absolute = (path: string, site: URL): string => new URL(path, site).href;

/**
 * Truncate on a word boundary, with a real ellipsis.
 *
 * §4 caps titles at 60 characters and descriptions at 155 — the lengths Google shows before
 * cutting. A title cut mid-word by the search engine looks like a broken page, so the cut
 * happens here where it can be made deliberately.
 */
export function clamp(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

const longDate = (iso: string | null): string | null =>
  iso
    ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : null;

const shortDate = (iso: string | null): string | null =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : null;

/** SEO.md §4: `{title} — {organisation} | Closes {date}`. */
export function opportunityTitle(opportunity: OpportunityRow): string {
  const org = opportunity.organisations?.name;
  const closes = opportunity.is_rolling
    ? "Rolling"
    : shortDate(opportunity.deadline_at)
      ? `Closes ${shortDate(opportunity.deadline_at)}`
      : null;

  // The title is the part that must survive: it is what a reader recognises. So the suffixes are
  // dropped from the right, one at a time, before the title itself is cut.
  const full = [opportunity.title, org].filter(Boolean).join(" — ");
  const withCloses = closes ? `${full} | ${closes}` : full;
  if (withCloses.length <= TITLE_MAX) return withCloses;
  if (full.length <= TITLE_MAX) return full;
  return clamp(opportunity.title, TITLE_MAX);
}

/**
 * §4's example, from real fields only: "Open to builders in Zimbabwe. Teams of 2–5. $10,000
 * prize. Applications close 30 September 2026. Free to enter."
 *
 * Sentences are added in the order a reader needs them and dropped from the end when the cap
 * binds, so the deadline never falls off before the prize does.
 */
export function opportunityDescription(
  opportunity: OpportunityRow,
  countryNames: string[] = [],
): string {
  const parts: string[] = [];

  if (opportunity.eligibility_scope === "global") parts.push("Open worldwide.");
  else if (opportunity.eligibility_scope === "africa_wide") parts.push("Open across Africa.");
  else if (countryNames.length > 0) {
    parts.push(
      `Open to builders in ${countryNames.slice(0, 3).join(", ")}${
        countryNames.length > 3 ? ` and ${countryNames.length - 3} more` : ""
      }.`,
    );
  }

  if (opportunity.is_rolling) parts.push("Applications are open on a rolling basis.");
  else if (opportunity.deadline_at) {
    // §3's precision rule applies to prose as much as to markup: a month-only deadline is
    // described as a month.
    parts.push(
      opportunity.deadline_precision === "month_only" ||
        opportunity.deadline_precision === "quarter" ||
        opportunity.deadline_precision === "unknown"
        ? `Closing date: ${opportunity.deadline_raw ?? longDate(opportunity.deadline_at)}.`
        : `Applications close ${longDate(opportunity.deadline_at)}.`,
    );
  }

  if (opportunity.team_size_min && opportunity.team_size_max) {
    parts.push(`Teams of ${opportunity.team_size_min}–${opportunity.team_size_max}.`);
  } else if (opportunity.team_required === false) {
    parts.push("Enter as an individual.");
  }

  if (opportunity.prize_amount && opportunity.prize_currency) {
    parts.push(
      `${opportunity.prize_currency} ${Number(opportunity.prize_amount).toLocaleString("en")} prize.`,
    );
  }

  if (opportunity.cost === "free") parts.push("Free to enter.");

  const built = parts.join(" ");
  return clamp(built || (opportunity.summary ?? opportunity.title), DESCRIPTION_MAX);
}

/** §4: `Opportunities open to {country} ({n} open now)`. */
export const countryTitle = (country: string, open: number): string =>
  clamp(`Opportunities open to ${country} (${open} open now)`, TITLE_MAX);

/** §4: `{Category} for {demonym} — {n} open now`. */
export function matrixTitle(category: string, iso2: string, countryName: string, open: number): string {
  const people = demonymPlural(iso2);
  const who = people ?? countryName;
  return clamp(`${category} for ${who} — ${open} open now`, TITLE_MAX);
}

export const categoryTitle = (category: string, open: number): string =>
  clamp(`${category} open to African builders (${open} open now)`, TITLE_MAX);

/** BreadcrumbList, on every page. §3. */
export function breadcrumb(items: { name: string; path: string }[], site: URL): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absolute(item.path, site),
    })),
  };
}

/** ItemList, on country and category pages. §3. */
export function itemList(
  name: string,
  items: { name: string; path: string }[],
  site: URL,
): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    numberOfItems: items.length,
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      url: absolute(item.path, site),
    })),
  };
}

/** WebSite + SearchAction, on the homepage only. §3. */
export function website(site: URL): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: BRAND.name,
    url: absolute("/", site),
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: absolute("/opportunities?q={search_term_string}", site),
      },
      "query-input": "required name=search_term_string",
    },
  };
}

/** Organization, on organisation pages. §3. */
export function organization(
  org: { name: string; slug: string; website_url?: string | null; description?: string | null },
  site: URL,
): JsonLd {
  const ld: JsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: org.name,
    url: absolute(`/organisations/${org.slug}`, site),
  };
  // `sameAs` is the organisation's own site, which is a verified fact: it is how the claim was
  // matched (migration 0021). A description we wrote is ours to publish; one we did not have is
  // omitted rather than filled with the name again.
  if (org.website_url) ld["sameAs"] = org.website_url;
  if (org.description) ld["description"] = clamp(org.description, 500);
  return ld;
}

/** FAQPage. §3 — and only where the page itself shows the same questions and answers. */
export function faqPage(entries: { question: string; answer: string }[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: entries.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: entry.answer },
    })),
  };
}

/** True when a date may be published as an exact date. §3's precision rule. */
const precise = (precision: string): boolean =>
  precision === "exact_time" || precision === "date_only";

/**
 * The opportunity's own structured data, typed by category. §3's table.
 *
 * Returns null for a category the table maps to nothing — `other`, the uncategorised bucket.
 * Emitting a type for it would be a claim about what the thing IS, made by a default value.
 */
export function opportunityJsonLd(
  opportunity: OpportunityRow,
  site: URL,
  countryNames: string[] = [],
): JsonLd | null {
  const code = opportunity.categories?.code ?? "other";
  const type = SCHEMA_TYPE_BY_CATEGORY[code] ?? null;
  if (!type) return null;

  const url = absolute(`/opportunities/${opportunity.slug}`, site);
  const expired = opportunity.status === "expired";
  const description = opportunity.summary ?? opportunityDescription(opportunity, countryNames);
  const organiser = opportunity.organisations?.name
    ? {
        "@type": "Organization",
        name: opportunity.organisations.name,
        url: absolute(`/organisations/${opportunity.organisations.slug}`, site),
      }
    : null;

  // §3: eligibleRegion / applicantLocationRequirements carry the countries we actually recorded.
  // An africa_wide record names no countries, so it names none here either — "Africa" as a
  // single origin is forbidden outright by PRODUCT_SPEC.md §28.
  const regions = countryNames.map((name) => ({ "@type": "Country", name }));

  const base: JsonLd = {
    "@context": "https://schema.org",
    "@type": type,
    name: opportunity.title,
    url,
    inLanguage: "en",
  };
  if (description) base["description"] = description;

  if (type === "Event") {
    // §3: "Expired opportunities set eventStatus: EventCancelled or are dropped from structured
    // data entirely rather than misrepresented as open."
    base["eventStatus"] = expired
      ? "https://schema.org/EventCancelled"
      : "https://schema.org/EventScheduled";
    base["eventAttendanceMode"] =
      opportunity.participation_mode === "online"
        ? "https://schema.org/OnlineEventAttendanceMode"
        : opportunity.participation_mode === "hybrid"
          ? "https://schema.org/MixedEventAttendanceMode"
          : opportunity.participation_mode === "in_person"
            ? "https://schema.org/OfflineEventAttendanceMode"
            : undefined;

    // The event's own dates, never the application deadline dressed up as one. A record with no
    // start date on file emits none: Google warns, and a warning is the correct outcome for a
    // fact nobody has.
    if (opportunity.starts_at) base["startDate"] = opportunity.starts_at;
    if (opportunity.ends_at) base["endDate"] = opportunity.ends_at;

    base["location"] =
      opportunity.participation_mode === "online"
        ? { "@type": "VirtualLocation", url: opportunity.official_url ?? url }
        : { "@type": "Place", name: "See the official listing" };

    if (organiser) base["organizer"] = organiser;
    base["isAccessibleForFree"] = opportunity.cost === "free";
    if (regions.length > 0) base["eligibleRegion"] = regions;
  }

  if (type === "EducationalOccupationalProgram") {
    if (organiser) base["provider"] = organiser;
    if (opportunity.deadline_at && precise(opportunity.deadline_precision)) {
      base["applicationDeadline"] = opportunity.deadline_at.slice(0, 10);
    }
    if (opportunity.starts_at) base["startDate"] = opportunity.starts_at;
    if (opportunity.ends_at) base["endDate"] = opportunity.ends_at;
    if (opportunity.participation_mode === "online") base["educationalProgramMode"] = "online";
    if (opportunity.cost === "free") {
      base["offers"] = { "@type": "Offer", price: 0, priceCurrency: "USD" };
    }
    if (regions.length > 0) base["eligibleRegion"] = regions;
  }

  if (type === "JobPosting") {
    base["title"] = opportunity.title;
    base["employmentType"] = "INTERN";
    if (organiser) base["hiringOrganization"] = organiser;
    if (opportunity.deadline_at && precise(opportunity.deadline_precision)) {
      base["validThrough"] = opportunity.deadline_at;
    }
    if (opportunity.participation_mode === "online") base["jobLocationType"] = "TELECOMMUTE";
    if (regions.length > 0) base["applicantLocationRequirements"] = regions;
    // datePosted is when WE published it, which is the only posting date we can stand behind.
    base["datePosted"] = opportunity.last_verified_at ?? undefined;
  }

  // Undefined values would serialise as absent anyway; dropping them keeps the output readable
  // and the tests honest about what is actually emitted.
  return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined));
}

/* ── XML ──────────────────────────────────────────────────────────────────────
 *
 * Hand-written, for the same reason the service worker is: a sitemap is five elements and an
 * RSS item is seven, and every library that generates them is a dependency to audit, update and
 * ship. What matters is the escaping, which is one function and is tested.
 */

/** The five characters XML cannot carry raw. A title with an ampersand in it is common. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface SitemapEntry {
  path: string;
  lastmod?: string | null;
  changefreq?: string | null;
  priority?: number | null;
}

/**
 * A urlset. SEO.md §5: "`lastmod` reflects real modification time."
 *
 * So `lastmod` is omitted when we do not have one, rather than filled with today's date. A
 * sitemap that claims every page changed today is a sitemap a crawler learns to ignore.
 */
export function sitemapXml(entries: SitemapEntry[], site: URL): string {
  const urls = entries
    .map((entry) => {
      const parts = [`    <loc>${xmlEscape(absolute(entry.path, site))}</loc>`];
      if (entry.lastmod) parts.push(`    <lastmod>${entry.lastmod.slice(0, 10)}</lastmod>`);
      if (entry.changefreq) parts.push(`    <changefreq>${entry.changefreq}</changefreq>`);
      if (entry.priority !== null && entry.priority !== undefined) {
        parts.push(`    <priority>${entry.priority.toFixed(1)}</priority>`);
      }
      return `  <url>\n${parts.join("\n")}\n  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** A sitemap index, pointing at the segments. §5. */
export function sitemapIndexXml(paths: string[], site: URL): string {
  const maps = paths
    .map((path) => `  <sitemap>\n    <loc>${xmlEscape(absolute(path, site))}</loc>\n  </sitemap>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${maps}\n</sitemapindex>\n`;
}

export interface FeedItem {
  title: string;
  path: string;
  description: string;
  /** RFC 822, per RSS 2.0. Absent when we have no publication date to stand behind. */
  published: string | null;
  guid: string;
}

/**
 * RSS 2.0. SEO.md §7 `[PR]`: "RSS feeds per country, category, organisation and closing-soon.
 * Free, zero-JS, machine-readable, and directly consumable by Telegram channel bots — which
 * means our feed can propagate through the ecosystem's existing distribution rather than
 * competing with it."
 *
 * That last clause is why this is not an afterthought: the audience already reads opportunities
 * in Telegram channels, and a feed a channel bot can consume reaches them where they are.
 */
export function rssXml(
  channel: { title: string; path: string; description: string },
  items: FeedItem[],
  site: URL,
): string {
  const body = items
    .map((item) => {
      const parts = [
        `      <title>${xmlEscape(item.title)}</title>`,
        `      <link>${xmlEscape(absolute(item.path, site))}</link>`,
        `      <guid isPermaLink="true">${xmlEscape(absolute(item.guid, site))}</guid>`,
        `      <description>${xmlEscape(item.description)}</description>`,
      ];
      if (item.published) {
        parts.push(`      <pubDate>${new Date(item.published).toUTCString()}</pubDate>`);
      }
      return `    <item>\n${parts.join("\n")}\n    </item>`;
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${xmlEscape(channel.title)}</title>`,
    `    <link>${xmlEscape(absolute(channel.path, site))}</link>`,
    `    <description>${xmlEscape(channel.description)}</description>`,
    "    <language>en</language>",
    `    <atom:link href="${xmlEscape(absolute(channel.path, site))}" rel="self" type="application/rss+xml" />`,
    body,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

/** One response shape for every XML route: the type, and a cache window a crawler respects. */
export const xmlResponse = (body: string, maxAge = 3600): Response =>
  new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 2}`,
    },
  });
