/**
 * The polite fetcher. OPPORTUNITY_INGESTION.md §2.1 and §4.2.
 *
 * Every rule in §2.1 that concerns a single request is enforced here, in one place,
 * because "non-negotiable" is the word the spec uses and a rule spread across call
 * sites is a rule that gets skipped once:
 *
 *   1. robots.txt honoured on every fetch, fetched once per host and cached
 *   2. no authentication, ever — there is no code path here that sends a cookie,
 *      a credential or an Authorization header
 *   3. honest identification, with a URL explaining the crawler
 *   4. at most one request per ten seconds per host; Retry-After honoured; 429 and
 *      503 backed off exponentially
 *   5. conditional requests with ETag / If-Modified-Since
 *
 * Plus §4.2: 15-second timeout, at most 2 retries, a content-type allowlist, and a
 * 2 MB body cap.
 *
 * FAILS CLOSED on robots: a robots.txt we cannot read means we do not fetch. Most
 * crawlers treat an unreachable robots.txt as permission; §2 rates the legal posture
 * above coverage, and the higher source tiers exist so that losing a page is cheap.
 */

import { CRAWLER_USER_AGENT } from "../../packages/config/src/brand.mjs";
import { delayFor, isAllowed, parseRobots } from "../../packages/ingest/src/robots.mjs";

export const TIMEOUT_MS = 15_000;
export const MAX_RETRIES = 2;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** §4.2's allowlist. Anything else is not a document we can read. */
export const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/json",
  "application/ld+json",
  "application/pdf",
  "text/plain",
];

const AGENT_TOKEN = CRAWLER_USER_AGENT.split("/")[0] ?? "MbeleBot";

/** @type {Map<string, { robots: import("../../packages/ingest/src/robots.mjs").RobotsRules | null, fetchedAt: number }>} */
const robotsCache = new Map();
/** @type {Map<string, number>} */
const lastRequestAt = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait out the per-host rate limit. §2.1 rule 4.
 *
 * Keyed by host, not globally: ten seconds between requests to one site is courtesy;
 * ten seconds between requests to forty different sites would make a full run take
 * seven minutes of sleeping for no benefit to anyone.
 *
 * @param {string} host
 * @param {number} delayMs
 */
async function waitForTurn(host, delayMs) {
  const previous = lastRequestAt.get(host);
  if (previous !== undefined) {
    const elapsed = Date.now() - previous;
    if (elapsed < delayMs) await sleep(delayMs - elapsed);
  }
  lastRequestAt.set(host, Date.now());
}

/**
 * One raw request, with no robots check and no rate limiting. Internal: the only
 * caller that should reach this is the robots fetch itself.
 *
 * @param {string} url
 * @param {{ etag?: string | null, lastModified?: string | null, timeoutMs?: number }} [options]
 */
async function rawFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    /** @type {Record<string, string>} */
    const headers = {
      // §2.1 rule 3: identify honestly, with a page explaining the crawler.
      "user-agent": CRAWLER_USER_AGENT,
      accept: ALLOWED_CONTENT_TYPES.join(", "),
      "accept-encoding": "gzip, deflate",
    };
    // §2.1 rule 5: conditional requests. Courtesy and bandwidth — and on a source
    // that rarely changes, a 304 costs the publisher almost nothing.
    if (options.etag) headers["if-none-match"] = options.etag;
    if (options.lastModified) headers["if-modified-since"] = options.lastModified;

    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    return { ok: true, response };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted ? "timed out" : String(err instanceof Error ? err.message : err),
      timedOut: aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * robots.txt for a host, fetched once per process.
 *
 * @param {string} origin
 * @returns {Promise<import("../../packages/ingest/src/robots.mjs").RobotsRules | null>}
 */
export async function robotsFor(origin) {
  const cached = robotsCache.get(origin);
  if (cached) return cached.robots;

  const attempt = await rawFetch(`${origin}/robots.txt`, { timeoutMs: 10_000 });
  let robots = null;

  if (attempt.ok && attempt.response) {
    if (attempt.response.status === 404 || attempt.response.status === 410) {
      // No robots.txt at all is a positive answer: the site has not restricted
      // anything. That is different from not being able to ask.
      robots = parseRobots("", AGENT_TOKEN);
    } else if (attempt.response.ok) {
      const text = await attempt.response.text().catch(() => "");
      robots = parseRobots(text, AGENT_TOKEN);
    }
    // 401, 403, 5xx: we could not learn the rules, so `robots` stays null and the
    // caller refuses. Fails closed.
  }

  robotsCache.set(origin, { robots, fetchedAt: Date.now() });
  return robots;
}

/**
 * @typedef {object} FetchResult
 * @property {"ok"|"not_modified"|"fetch_error"|"blocked"|"rate_limited"|"parse_error"} status
 * @property {number} [httpStatus]
 * @property {string} [body]
 * @property {string} [contentType]
 * @property {string} [finalUrl]
 * @property {string | null} [etag]
 * @property {string | null} [lastModified]
 * @property {string} [error]
 * @property {boolean} [robotsAllowed]
 */

/**
 * Fetch a document, politely.
 *
 * @param {string} url
 * @param {{ etag?: string | null, lastModified?: string | null }} [conditional]
 * @returns {Promise<FetchResult>}
 */
export async function politeFetch(url, conditional = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { status: "fetch_error", error: `not a URL: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { status: "blocked", error: `refusing a non-http(s) URL: ${parsed.protocol}` };
  }

  const robots = await robotsFor(parsed.origin);
  if (robots === null) {
    // §2.1 rule 1 is non-negotiable, so an unreadable robots.txt is a refusal.
    return {
      status: "blocked",
      robotsAllowed: false,
      error: "could not read robots.txt, so not fetching (fail closed)",
    };
  }
  if (!isAllowed(robots, url)) {
    return { status: "blocked", robotsAllowed: false, error: "disallowed by robots.txt" };
  }

  const delayMs = delayFor(robots);
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    await waitForTurn(parsed.host, delayMs);
    const result = await rawFetch(url, conditional);

    if (!result.ok || !result.response) {
      attempt += 1;
      if (attempt > MAX_RETRIES) {
        return { status: "fetch_error", error: result.error, robotsAllowed: true };
      }
      // Exponential backoff on a transport failure, same as on a 503.
      await sleep(Math.min(30_000, 2 ** attempt * 1000));
      continue;
    }

    const response = result.response;

    if (response.status === 304) {
      // §4.3: unchanged means stop, and update last_fetch_at only.
      return { status: "not_modified", httpStatus: 304, robotsAllowed: true };
    }

    if (response.status === 429 || response.status === 503) {
      // §2.1 rule 4: honour Retry-After, then exponential backoff.
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(120_000, retryAfter * 1000)
        : Math.min(60_000, 2 ** (attempt + 1) * 1000);
      attempt += 1;
      if (attempt > MAX_RETRIES) {
        return {
          status: "rate_limited",
          httpStatus: response.status,
          error: `backed off ${attempt} times and still ${response.status}`,
          robotsAllowed: true,
        };
      }
      await sleep(waitMs);
      continue;
    }

    if (!response.ok) {
      return {
        status: "fetch_error",
        httpStatus: response.status,
        error: `HTTP ${response.status}`,
        robotsAllowed: true,
      };
    }

    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return {
        status: "parse_error",
        httpStatus: response.status,
        contentType,
        error: `content-type "${contentType}" is not in the allowlist`,
        robotsAllowed: true,
      };
    }

    // §4.2: max body 2 MB. Checked against the declared length first, then enforced
    // while reading — a missing or lying Content-Length must not let a 500 MB
    // response exhaust the runner.
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return {
        status: "parse_error",
        httpStatus: response.status,
        error: `body declared ${declared} bytes, over the ${MAX_BODY_BYTES} cap`,
        robotsAllowed: true,
      };
    }

    const read = await readCapped(response);
    if (!read.ok) {
      return { status: "parse_error", httpStatus: response.status, error: read.error, robotsAllowed: true };
    }

    return {
      status: "ok",
      httpStatus: response.status,
      body: read.text,
      contentType,
      finalUrl: response.url || url,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      robotsAllowed: true,
    };
  }

  return { status: "fetch_error", error: "retries exhausted", robotsAllowed: true };
}

/**
 * Read a response body, stopping at the cap.
 *
 * @param {Response} response
 * @returns {Promise<{ ok: true, text: string } | { ok: false, error: string }>}
 */
async function readCapped(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text().catch(() => "");
    return Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES
      ? { ok: false, error: "body over the 2 MB cap" }
      : { ok: true, text };
  }

  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, error: `body exceeded the ${MAX_BODY_BYTES} byte cap` };
      }
      chunks.push(Buffer.from(value));
    }
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

/** Reset the per-process caches. For tests and for a long-lived process. */
export function resetFetcherState() {
  robotsCache.clear();
  lastRequestAt.clear();
}
