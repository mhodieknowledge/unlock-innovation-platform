import demonymData from "./demonyms.json" with { type: "json" };

/**
 * SEO constants. SEO.md §1–§4.
 *
 * Here rather than in the pages because every one of these numbers is read by at least two
 * things that have to agree: the matrix floor by the matrix route and the sitemap that lists
 * matrix URLs; the schema-type map by the opportunity page and the test that validates every
 * category; the indexing table by the sitemap and the `noindex` audit.
 *
 * The lesson this codebase keeps relearning: a number in two files is a number that will
 * differ, and the first symptom is a page that says one thing and a sitemap that says another.
 */

/**
 * SEO.md §2 `[PR]`: "a `/countries/[slug]/[category]` page is generated and indexed only when
 * it holds >= 5 currently-open opportunities. Below that, the route 301-redirects to
 * `/countries/[slug]`."
 *
 * Applied in the request tier rather than in SQL, deliberately: `country_category_counts()`
 * returns the truth and this decides what to do with it, so the count on a page and the
 * decision to render that page come from the same number.
 */
export const SEO_MATRIX_FLOOR = 5;

/**
 * UX_FLOWS.md §13's "thin" state: "fewer than 10 open: honest note plus a 'suggest a source'
 * action, and a link to Africa-wide opportunities".
 *
 * A country page is never withheld for being thin — SEO.md §2 generates all 54 — so this only
 * changes what the page SAYS, which is the honest way round.
 */
export const THIN_COUNTRY_FLOOR = 10;

/** SEO.md §3's table, keyed by the category codes in migration 0002's taxonomy. */
export type SchemaType = "Event" | "EducationalOccupationalProgram" | "JobPosting" | null;

/**
 * Category code to schema.org type.
 *
 * `other` maps to NOTHING, and that is the point of the map being explicit rather than a
 * default-carrying lookup. SEO.md §3's rule is "never mark up a fact we have not verified", and
 * a type IS a fact: calling an uncategorised record an `Event` because that is the commonest
 * case would be a claim about it that nobody checked. It gets `BreadcrumbList` and no more.
 *
 * `conference_cfp` is an `Event`: a call for papers is the entry route to a conference, has a
 * deadline, and Google reads it as one. `open_source_program` is a programme rather than a
 * `JobPosting`, because most are unpaid and `JobPosting` implies employment — §3 lists only
 * internships and developer programmes there, and a stipend is not something we can verify.
 */
export const SCHEMA_TYPE_BY_CATEGORY: Readonly<Record<string, SchemaType>> = {
  hackathon: "Event",
  coding_competition: "Event",
  ai_challenge: "Event",
  data_competition: "Event",
  innovation_challenge: "Event",
  startup_competition: "Event",
  pitch_competition: "Event",
  community_challenge: "Event",
  conference_cfp: "Event",

  grant: "EducationalOccupationalProgram",
  fellowship: "EducationalOccupationalProgram",
  scholarship: "EducationalOccupationalProgram",
  research_opportunity: "EducationalOccupationalProgram",
  accelerator: "EducationalOccupationalProgram",
  incubator: "EducationalOccupationalProgram",
  bootcamp: "EducationalOccupationalProgram",
  entrepreneurship_program: "EducationalOccupationalProgram",
  open_source_program: "EducationalOccupationalProgram",

  internship: "JobPosting",
  developer_program: "JobPosting",

  other: null,
};

export interface IndexingRule {
  /** Route pattern, in the same shape as route-budgets.json: `*` is one path segment. */
  pattern: string;
  /** Whether a crawler may index it. `false` means `noindex` on the page itself. */
  indexed: boolean;
  /** Sitemap priority, per SEO.md §1. Null when the route is not in a sitemap. */
  priority: number | null;
  changefreq: "hourly" | "daily" | "weekly" | "monthly" | null;
  /** True when the route must also be disallowed in robots.txt — §1's three layers. */
  disallow?: boolean;
}

/**
 * SEO.md §1's table, as data.
 *
 * Three layers protect a private surface: `noindex, nofollow` on the page, a `Disallow` in
 * robots.txt, and no session means no page. §1 says why there are three: "one will eventually
 * be misconfigured". This table drives the first two and the audit that checks them.
 */
export const INDEXING: readonly IndexingRule[] = [
  { pattern: "/", indexed: true, priority: 1.0, changefreq: "hourly" },
  { pattern: "/opportunities/*", indexed: true, priority: 0.9, changefreq: "daily" },
  { pattern: "/countries", indexed: true, priority: 0.8, changefreq: "daily" },
  { pattern: "/countries/*", indexed: true, priority: 0.9, changefreq: "daily" },
  { pattern: "/countries/*/*", indexed: true, priority: 0.8, changefreq: "daily" },
  { pattern: "/categories", indexed: true, priority: 0.7, changefreq: "daily" },
  { pattern: "/categories/*", indexed: true, priority: 0.7, changefreq: "daily" },
  { pattern: "/organisations/*", indexed: true, priority: 0.7, changefreq: "weekly" },
  { pattern: "/b/*", indexed: false, priority: 0.3, changefreq: "weekly" },
  { pattern: "/projects/*", indexed: false, priority: 0.4, changefreq: "weekly" },
  { pattern: "/anti-scam", indexed: true, priority: 0.3, changefreq: "monthly" },
  { pattern: "/verification", indexed: true, priority: 0.3, changefreq: "monthly" },
  { pattern: "/privacy", indexed: true, priority: 0.3, changefreq: "monthly" },
  { pattern: "/terms", indexed: true, priority: 0.3, changefreq: "monthly" },
  { pattern: "/content-policy", indexed: true, priority: 0.3, changefreq: "monthly" },
  { pattern: "/bot", indexed: true, priority: 0.3, changefreq: "monthly" },
  { pattern: "/changelog", indexed: true, priority: 0.3, changefreq: "monthly" },
  { pattern: "/opportunities", indexed: false, priority: null, changefreq: null },
  { pattern: "/tracker", indexed: false, priority: null, changefreq: null, disallow: true },
  { pattern: "/you", indexed: false, priority: null, changefreq: null, disallow: true },
  { pattern: "/you/*", indexed: false, priority: null, changefreq: null, disallow: true },
  { pattern: "/threads", indexed: false, priority: null, changefreq: null, disallow: true },
  { pattern: "/threads/*", indexed: false, priority: null, changefreq: null, disallow: true },
  { pattern: "/requests", indexed: false, priority: null, changefreq: null, disallow: true },
  { pattern: "/requests/*", indexed: false, priority: null, changefreq: null, disallow: true },
  { pattern: "/admin", indexed: false, priority: null, changefreq: null, disallow: true },
  { pattern: "/admin/*", indexed: false, priority: null, changefreq: null, disallow: true },
  { pattern: "/api/*", indexed: false, priority: null, changefreq: null, disallow: true },
];

/** The private prefixes robots.txt disallows. §1's second layer, from the table above. */
export const ROBOTS_DISALLOW: readonly string[] = INDEXING.filter((rule) => rule.disallow)
  .map((rule) => rule.pattern.replace(/\/\*$/, ""))
  .filter((path, index, all) => all.indexOf(path) === index);

/** The sitemap segments. §5: "segmented so each stays under 50,000 URLs". */
export const SITEMAP_SEGMENTS = [
  "opportunities",
  "countries",
  "categories",
  "organisations",
  "public-profiles",
  "static",
] as const;

export type SitemapSegment = (typeof SITEMAP_SEGMENTS)[number];

/** §5: a sitemap file must stay under 50,000 URLs. Ours cap well below it. */
export const SITEMAP_MAX_URLS = 50_000;

/** Title lengths from §4. Enforced by a test, because a truncated title is a lost click. */
export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 155;

const DEMONYMS = (demonymData as { demonyms: Record<string, string[]> }).demonyms;

/**
 * Suffixes that do not take an -s. Several African demonyms are invariant in the plural, and
 * "Congoleses" in a page title is the kind of mistake that tells a reader this page was
 * generated by somebody who has never met them.
 *
 * Covers: -ese (Beninese, Congolese, Gabonese, Senegalese, Sudanese, South Sudanese, Togolese),
 * -ois (Seychellois), Malagasy, Basotho, Burkinabe.
 */
const INVARIANT_PLURAL = ["ese", "ois", "asy", "otho", "abe"];

const titleCase = (value: string): string =>
  value.replace(/(^|[\s-])([a-z])/g, (_, boundary: string, letter: string) => boundary + letter.toUpperCase());

/**
 * "Zimbabwean", "South African", "Congolese" — the adjective form, title-cased.
 *
 * SEO.md §4's country × category title is "{Category} for {demonym} — {n} open now", and §
 * "The target query shape" is "grants for Zambian students". The demonym is the whole point of
 * that page: it is what people type, and it is what the incumbents' generic pages do not carry.
 *
 * Null for a country with no demonym on file rather than a guess, so a caller falls back to the
 * country name instead of inventing a word for a nationality.
 */
export function demonymAdjective(iso2: string): string | null {
  const entry = DEMONYMS[iso2.trim().toUpperCase()];
  return entry && entry[0] ? titleCase(entry[0]) : null;
}

/** The plural noun: "Zimbabweans", "Congolese", "Basotho". */
export function demonymPlural(iso2: string): string | null {
  const adjective = demonymAdjective(iso2);
  if (!adjective) return null;
  const lower = adjective.toLowerCase();
  return INVARIANT_PLURAL.some((suffix) => lower.endsWith(suffix)) ? adjective : `${adjective}s`;
}
