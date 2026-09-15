/**
 * Official APIs. OPPORTUNITY_INGESTION.md §2, tier 1 — "explicitly sanctioned".
 *
 * §2 ranks an official API above every other way of getting data and the pipeline had
 * no way to read one: discover() implemented rss, atom, sitemap, jsonld and html_page,
 * so the three `*_api` rows in the registry fell through to "no discovery implemented"
 * and the top tier of the source priority table was decorative.
 *
 * WHY THIS MATTERS MORE THAN TIER ORDER. An adapter here returns schema.org nodes, and
 * §4.4 already gives publisher-authored structured data priority over the model. So an
 * API source costs NO MODEL CALLS AT ALL — it goes straight to recordFromJsonLd. On the
 * free tiers this project runs on, where a single 8,000-token-per-minute ceiling decides
 * how much of the catalogue gets read in a day, a source that needs no tokens is worth
 * more than one that produces better prose.
 *
 * Every adapter is a pure function from a parsed JSON body to items. No fetching, no
 * dates of its own, no network — so each one is unit-testable against a captured
 * response, which is the only way to notice that a publisher has changed a field name
 * before it silently empties the catalogue.
 */

import { canonicaliseUrl } from "./urls.mjs";

/** Months as the APIs spell them. */
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Devpost. https://devpost.com/api/hackathons
 *
 * No key, no quota published, and robots.txt allows every agent but BLEXBot — which
 * makes it tier 1 rather than tier 6, and the best hackathon source there is.
 *
 * The response is a listing, not a document per hackathon, so each entry becomes an
 * item whose `jsonld` is an Event built from the fields Devpost states. Nothing is
 * inferred: `cost` is deliberately absent because Devpost does not say whether entry is
 * free, and AI_SYSTEM.md's fee rule plus invariant 13 both turn on that field — a
 * guessed `free` could publish something that charges.
 *
 * @param {unknown} payload  the parsed JSON body
 * @param {string} sourceUrl
 * @returns {Array<{url: string, title: string | null, publishedAt: string | null,
 *                  summary: string | null, jsonld: unknown[]}>}
 */
export function devpostHackathons(payload, sourceUrl) {
  const list = readArray(payload, "hackathons");
  const items = [];

  for (const entry of list) {
    const row = asObject(entry);
    if (!row) continue;

    const url = canonicaliseUrl(text(row["url"]) ?? "", sourceUrl);
    const title = text(row["title"]);
    if (!url || !title) continue;

    // "Aug 21 - Sep 30, 2026", and occasionally a range that crosses a year.
    const period = parseDateRange(text(row["submission_period_dates"]));

    /** @type {Record<string, unknown>} */
    const event = {
      "@context": "https://schema.org",
      "@type": "Event",
      name: title,
      url,
    };

    if (period.start) event["startDate"] = period.start;
    if (period.end) {
      event["endDate"] = period.end;
      // Devpost's "submission period" ends when submissions close, which is the date a
      // reader has to act on. recordFromJsonLd reads applicationDeadline first and
      // never endDate, so saying it twice is how the deadline survives.
      event["applicationDeadline"] = period.end;
    }

    const organiser = text(row["organization_name"]);
    if (organiser) event["organizer"] = { "@type": "Organization", name: organiser };

    const location = text(asObject(row["displayed_location"])?.["location"]);
    if (location) {
      event["eventAttendanceMode"] =
        location.toLowerCase() === "online"
          ? "https://schema.org/OnlineEventAttendanceMode"
          : "https://schema.org/OfflineEventAttendanceMode";
      if (location.toLowerCase() !== "online") event["location"] = { "@type": "Place", name: location };
    }

    const themes = readArray(row, "themes")
      .map((t) => text(asObject(t)?.["name"]))
      .filter((t) => typeof t === "string");
    if (themes.length > 0) event["keywords"] = themes.join(", ");

    items.push({
      url,
      title,
      // Devpost publishes no created-at, and inventing one would let itemsSince filter
      // on a date we made up.
      publishedAt: null,
      summary: null,
      jsonld: [event],
      // The category, stated rather than inferred. recordFromJsonLd does not derive one
      // — schema.org has no field for it — so every record built from structured data
      // was reaching the writer with category_code undefined and falling through to
      // `other`. All 183 of these are hackathons filed under Other, which is why the
      // hackathon page was empty while the catalogue was not.
      //
      // The endpoint settles the base category: this is /api/hackathons. Devpost's own
      // themes then narrow it where they are unambiguous, and where they are not the
      // base stands — a hackathon tagged "Design" is still a hackathon.
      categoryCode: categoryFromThemes(themes),
    });
  }

  return items;
}

/**
 * Devpost themes into one of the catalogue's category codes.
 *
 * Only the themes that mean something specific move the answer. "Machine Learning/AI"
 * on a hackathon makes it an AI challenge; "Design" does not make it a design contest.
 * Everything else stays a hackathon, which is what the endpoint said it was.
 *
 * @param {string[]} themes
 * @returns {string}
 */
function categoryFromThemes(themes) {
  const joined = themes.join(" ").toLowerCase();
  if (/machine learning|\bai\b|artificial intelligence/.test(joined)) return "ai_challenge";
  if (/data science|analytics|\bdata\b/.test(joined)) return "data_competition";
  return "hackathon";
}

/** Adapters by the `kind` recorded against the source. */
const ADAPTERS = {
  /** @type {(payload: unknown, sourceUrl: string) => any[]} */
  devpost_hackathons: devpostHackathons,
};

/**
 * Turn an API response into items, or throw with a reason the log can carry.
 *
 * @param {string} adapter  which adapter, from sources.api_adapter
 * @param {string} body     the raw response
 * @param {string} sourceUrl
 */
export function itemsFromApi(adapter, body, sourceUrl) {
  const fn = ADAPTERS[/** @type {keyof typeof ADAPTERS} */ (adapter)];
  if (!fn) throw new Error(`no API adapter called "${adapter}"`);

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`${adapter}: response was not JSON`);
  }
  return fn(payload, sourceUrl);
}

/** Every adapter name, for the migration and the source check to validate against. */
export const API_ADAPTERS = Object.keys(ADAPTERS);

/**
 * "Aug 21 - Sep 30, 2026" and "Dec 01, 2026 - Jan 15, 2027" into ISO dates.
 *
 * Returns nulls rather than guesses. A wrong deadline is worse than no deadline: the
 * record would either expire early and vanish, or sit published past its close telling
 * people to apply for something that has shut.
 *
 * @param {string | null} range
 * @returns {{ start: string | null, end: string | null }}
 */
export function parseDateRange(range) {
  const empty = { start: null, end: null };
  if (!range) return empty;

  const halves = range.split(/\s+[-–—]\s+/);
  if (halves.length !== 2) return empty;

  // The year usually appears once, at the end, and belongs to both halves.
  const trailingYear = /(\d{4})\s*$/.exec(halves[1] ?? "");
  const fallbackYear = trailingYear?.[1] ? Number(trailingYear[1]) : null;

  const start = parseDayMonth(halves[0] ?? "", fallbackYear);
  // A range inside one month states the month once: "Sep 06 - 20, 2026". The second half
  // is then a bare day, and reading it as unparseable threw away the whole range —
  // including the deadline, which is the field this exists for. 137 of Devpost's 183 open
  // hackathons came back without a deadline before this branch existed.
  const end =
    parseDayMonth(halves[1] ?? "", fallbackYear) ??
    (start ? parseBareDay(halves[1] ?? "", start) : null);
  if (!start || !end) return empty;

  // A range that ends before it starts is a year boundary the string did not spell out,
  // and the year it does state belongs to the END: "Dec 20 - Jan 10, 2026" closes in
  // January 2026, so it opened in December 2025. Moving the start back is the reading
  // that keeps the stated date — the deadline — exactly as the publisher wrote it.
  if (end < start) {
    const pulled = parseDayMonth(halves[0] ?? "", (fallbackYear ?? 0) - 1);
    return { start: pulled ? iso(pulled) : null, end: iso(end) };
  }
  return { start: iso(start), end: iso(end) };
}

/**
 * The second half of a same-month range: "20, 2026", or just "20". Takes its month and
 * year from the half that stated them.
 *
 * @param {string} part
 * @param {Date} start
 * @returns {Date | null}
 */
function parseBareDay(part, start) {
  const match = /^\s*(\d{1,2})(?:\s*,\s*(\d{4}))?\s*$/.exec(part);
  if (!match) return null;
  const day = Number(match[1]);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  const year = match[2] ? Number(match[2]) : start.getUTCFullYear();

  // "Sep 30 - 02, 2026" states one month and crosses out of it: the second day is
  // earlier in the month than the first, so it belongs to the NEXT month. Read as the
  // same month it would fall before its own start, and the year-boundary rule above
  // would then drag the start back a year — turning a fortnight into 2025-09-30 ..
  // 2026-09-02. A deadline that wrong is worse than no deadline.
  const month = day < start.getUTCDate() ? start.getUTCMonth() + 1 : start.getUTCMonth();
  const date = new Date(Date.UTC(year, month, day));

  // Date.UTC rolls an impossible day into the next month; reject rather than accept the
  // rollover, and normalise the month for a December-to-January crossing.
  const expected = ((month % 12) + 12) % 12;
  return date.getUTCMonth() === expected && date.getUTCDate() === day ? date : null;
}

/**
 * @param {string} part
 * @param {number | null} fallbackYear
 * @returns {Date | null}
 */
function parseDayMonth(part, fallbackYear) {
  const match = /([A-Za-z]{3,})\s+(\d{1,2})(?:,\s*(\d{4}))?/.exec(part.trim());
  if (!match) return null;
  const month = MONTHS[/** @type {keyof typeof MONTHS} */ (String(match[1]).slice(0, 3).toLowerCase())];
  if (month === undefined) return null;
  const day = Number(match[2]);
  const year = match[3] ? Number(match[3]) : fallbackYear;
  if (!Number.isFinite(day) || day < 1 || day > 31 || !year) return null;
  const date = new Date(Date.UTC(year, month, day));
  // Reject a rolled-over date: "Feb 31" must not silently become 2 March.
  return date.getUTCMonth() === month && date.getUTCDate() === day ? date : null;
}

/** @param {Date} d */
const iso = (d) => d.toISOString();

/** @param {unknown} v */
function asObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? /** @type {Record<string, unknown>} */ (v)
    : null;
}

/** @param {unknown} container @param {string} key */
function readArray(container, key) {
  const object = asObject(container);
  const value = object ? object[key] : null;
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} v @returns {string | null} */
function text(v) {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}
