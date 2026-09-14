/**
 * JSON-LD and microdata extraction. OPPORTUNITY_INGESTION.md §4.3 and §4.4.
 *
 * "JSON-LD wins over the model on any field it supplies, because it is
 * publisher-authored." That sentence is why this module matters more than its size
 * suggests: it is also the entire NO_AI fallback (AI_SYSTEM.md §4), the path that
 * keeps the pipeline producing records when every LLM quota is gone.
 */

import { canonicaliseUrl } from "./urls.mjs";

/** Types worth reading. Anything else on the page is not an opportunity. */
const INTERESTING_TYPES = new Set([
  "Event",
  "EducationalOccupationalProgram",
  "JobPosting",
  "Course",
  "Grant",
  "MonetaryGrant",
  "FundingScheme",
  "BusinessEvent",
  "EducationEvent",
  "Hackathon",
]);

/**
 * Pull every JSON-LD block out of a page.
 *
 * Tolerant by design: publishers ship trailing commas, HTML comments wrapping the
 * JSON, and several blocks where one would do. A parse failure on one block must not
 * lose the others, so each is attempted alone.
 *
 * @param {string} html
 * @returns {unknown[]}
 */
export function extractJsonLd(html) {
  /** @type {unknown[]} */
  const out = [];
  if (typeof html !== "string") return out;

  const pattern = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const body = (match[1] ?? "")
      // Some CMSs wrap the JSON in an HTML comment to keep old parsers quiet.
      .replace(/^\s*<!--/, "")
      .replace(/-->\s*$/, "")
      .trim();
    if (!body) continue;
    try {
      out.push(JSON.parse(body));
    } catch {
      // A malformed block is the publisher's bug and not worth failing the fetch
      // over. The model path still has the page text.
    }
  }
  return out;
}

/** @param {unknown} node @returns {unknown[]} */
function flatten(node) {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (typeof node !== "object" || node === null) return [];
  const obj = /** @type {Record<string, unknown>} */ (node);
  const nested = Array.isArray(obj["@graph"]) ? obj["@graph"].flatMap(flatten) : [];
  return [obj, ...nested];
}

/** @param {unknown} type */
function typeNames(type) {
  const raw = Array.isArray(type) ? type : [type];
  return raw
    .filter((t) => typeof t === "string")
    .map((t) => String(t).replace(/^https?:\/\/schema\.org\//, ""));
}

/**
 * The first interesting schema.org node on the page, as a flat record.
 *
 * @param {unknown[]} blocks output of extractJsonLd
 * @returns {Record<string, unknown> | null}
 */
export function findOpportunityNode(blocks) {
  for (const node of blocks.flatMap(flatten)) {
    const obj = /** @type {Record<string, unknown>} */ (node);
    if (typeNames(obj["@type"]).some((t) => INTERESTING_TYPES.has(t))) return obj;
  }
  return null;
}

/** @param {unknown} v @returns {string | null} */
function str(v) {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return null;
}

/**
 * `offers` is specified as one Offer or an array of them, and publishers use both.
 * @param {unknown} offers
 * @returns {Record<string, unknown> | null}
 */
function firstOffer(offers) {
  const candidates = Array.isArray(offers) ? offers : [offers];
  for (const candidate of candidates) {
    if (typeof candidate === "object" && candidate !== null) {
      return /** @type {Record<string, unknown>} */ (candidate);
    }
  }
  return null;
}

/** @param {unknown} v @returns {string | null} */
function dateOf(v) {
  const s = str(v);
  if (!s) return null;
  // schema.org dates are ISO 8601 by specification, which is the only format worth
  // accepting — see the note in validate.mjs on locale-ambiguous dates.
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Build a partial record from publisher-authored structured data.
 *
 * This is AI_SYSTEM.md §4's `NO_AI` fallback in full: "JSON-LD and microdata parsing
 * only. If the page exposes schema.org/Event or EducationalOccupationalProgram,
 * build a partial record and queue it. Otherwise the document waits. Nothing is
 * published from a failed extraction."
 *
 * So every field here carries confidence 1.0 — not because the publisher is always
 * right, but because nothing was inferred: the value is exactly what the page
 * declared. Queuing, not publishing, is what the caller does with it.
 *
 * @param {unknown[]} blocks
 * @param {string} pageUrl
 * @returns {{ record: Record<string, unknown>, confidence: Record<string, number>, fields: string[] } | null}
 */
export function recordFromJsonLd(blocks, pageUrl) {
  const node = findOpportunityNode(blocks);
  if (!node) return null;

  /** @type {Record<string, unknown>} */
  const record = {};
  /** @type {Record<string, number>} */
  const confidence = {};
  const fields = [];

  const title = str(node["name"]) ?? str(node["title"]);
  if (title) {
    record["title"] = title.slice(0, 200);
    confidence["title"] = 1;
    fields.push("title");
  }

  // Deadline: applicationDeadline for a programme, else an offer's validThrough,
  // which is how event pages express "registration closes". Never endDate — a
  // deadline is when you must apply, and when an event finishes is not that.
  const offersNode = firstOffer(node["offers"]);
  const deadline =
    dateOf(node["applicationDeadline"]) ??
    (offersNode ? dateOf(offersNode["validThrough"]) : null);
  if (deadline) {
    record["deadline_at"] = deadline;
    // A schema.org date with no time component means the publisher stated a day.
    record["deadline_precision"] = /T00:00:00\.000Z$/.test(deadline) ? "date_only" : "exact_time";
    confidence["deadline"] = 1;
    fields.push("deadline");
  }

  const startDate = dateOf(node["startDate"]);
  if (startDate) {
    record["starts_at"] = startDate;
    fields.push("starts_at");
  }
  const endDate = dateOf(node["endDate"]);
  if (endDate) {
    record["ends_at"] = endDate;
    fields.push("ends_at");
  }

  const organiser =
    node["organizer"] ?? node["provider"] ?? node["hiringOrganization"] ?? node["funder"];
  const organiserName =
    typeof organiser === "object" && organiser !== null
      ? str(/** @type {Record<string, unknown>} */ (organiser)["name"])
      : str(organiser);
  if (organiserName) {
    record["organisation_name"] = organiserName.slice(0, 200);
    confidence["organisation_name"] = 1;
    fields.push("organisation_name");
  }

  const url = canonicaliseUrl(str(node["url"]) ?? "", pageUrl);
  if (url) {
    record["official_url"] = url;
    fields.push("official_url");
  }

  // eventAttendanceMode is the one schema.org field that maps cleanly onto our
  // participation_mode, and it is publisher-authored, so it beats any inference.
  const mode = str(node["eventAttendanceMode"]);
  if (mode) {
    const lower = mode.toLowerCase();
    record["participation_mode"] = lower.includes("online")
      ? "online"
      : lower.includes("mixed")
        ? "hybrid"
        : lower.includes("offline")
          ? "in_person"
          : "unknown";
    fields.push("participation_mode");
  }

  // Free or not. isAccessibleForFree is explicit; a zero price says the same thing.
  // Anything else is left unknown rather than guessed: invariant 13 turns on this
  // field, so an inference here could publish something that charges a fee.
  if (typeof node["isAccessibleForFree"] === "boolean") {
    record["cost"] = node["isAccessibleForFree"] ? "free" : "paid";
    confidence["cost"] = 1;
    fields.push("cost");
  } else if (offersNode) {
    const price = Number(offersNode["price"]);
    if (Number.isFinite(price)) {
      record["cost"] = price === 0 ? "free" : "paid";
      confidence["cost"] = 1;
      fields.push("cost");
    }
  }

  return fields.length > 0 ? { record, confidence, fields } : null;
}
