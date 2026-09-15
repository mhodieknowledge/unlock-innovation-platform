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
 *
 * ESCALATION TO A BROWSER. A plain HTTP GET from a CI runner is now refused by a good
 * part of §3's registry: a production run had three sources answer 403 outright and
 * another fifty documents come back as interstitials — a 2xx, a proof-of-work script,
 * and no page. Every one of those was logged as an extraction failure, which is where
 * an operator would have spent the week. So when a response is a wall rather than a
 * document, this module renders the URL in a real browser and returns what the browser
 * got (see lib/browser-fetch.mjs).
 *
 * The escalation changes the transport and nothing else. It happens AFTER the robots
 * check and AFTER the per-host wait, using the same gate as the plain path, so rules 1
 * and 4 hold across both. Rule 2 holds because there is no credential anywhere in
 * either path and because 401 and 407 are excluded from escalation by name: a wall may
 * be rendered past, authentication may not.
 */

import { CRAWLER_USER_AGENT } from "../../packages/config/src/brand.mjs";
import { detectChallenge, looksUnrendered } from "../../packages/ingest/src/challenge.mjs";
import { extractJsonLd } from "../../packages/ingest/src/jsonld.mjs";
import { htmlToText } from "../../packages/ingest/src/text.mjs";
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

/**
 * The escape hatch. Rendering is the expensive path and an operator needs to be able to
 * turn it off without editing code — to reproduce a plain-HTTP run, to check whether a
 * source has stopped blocking us, or to keep a constrained runner inside its minutes.
 */
const BROWSER_ENABLED = process.env.INGEST_BROWSER !== "0";

/**
 * A ceiling on renders per run. §9 budgets the batch tier at about eight Actions
 * minutes a day and a render costs seconds where a fetch costs milliseconds, so the day
 * a large source goes behind a wall is the day the pipeline would quietly spend an hour
 * on it. Past the ceiling the fetcher reports `challenged` and stops — a run that reads
 * most of the catalogue and says which sources it could not reach beats a run that is
 * still rendering when the runner is killed.
 */
const RENDER_BUDGET = Number(process.env.INGEST_BROWSER_BUDGET ?? 40);
let rendersUsed = 0;

/**
 * Hosts whose wall we tried and could not pass, and how many times.
 *
 * A wall is a property of the host, not of the URL. Scholarship Region contributed ten
 * documents to the 2026-09-15 run, and an interactive captcha in front of one of them
 * is in front of all ten — so without this, a source we definitely cannot read costs
 * ten full challenge timeouts, which at 45 seconds each is more than the batch tier's
 * whole daily budget spent on nothing. After the second failure the host is taken as
 * settled for the rest of the run and reported without another attempt.
 *
 * Two rather than one, because the first failure can be a slow page or a transient
 * navigation error, and giving up on a readable source for that would be worse.
 */
const HOST_ATTEMPTS_BEFORE_GIVING_UP = 2;
/** @type {Map<string, { failures: number, reason: string }>} */
const wallsThatStood = new Map();

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

  let robots = null;

  // ASK MORE THAN ONCE BEFORE CONCLUDING WE CANNOT ASK.
  //
  // Failing closed on an unreadable robots.txt is right and stays. What was wrong is
  // how little it took to be "unreadable": one request, one 10-second timeout, and the
  // null cached for the rest of the run. A single blip retired the host.
  //
  // It was not hypothetical. On 2026-09-15 18:38 the run reported Scholarship Region and
  // Opportunities For Youth as "could not read robots.txt, so not fetching" — and
  // fetched by hand minutes later, opportunitiesforyouth.org/robots.txt answered 200
  // with 321 bytes and hackerearth.com/robots.txt answered 200 in 1.3 seconds with
  // `Allow: /`. Nobody had refused us anything. RUNBOOK.md §18 warned about exactly this
  // — "a timeout looks exactly like a disallow ... re-run the check before concluding
  // anything" — and told a person to re-run it by hand, which is a thing the code can do
  // for itself.
  //
  // Three attempts, backing off, and only then a refusal. A host that is genuinely down
  // still costs three cheap requests and still fails closed.
  for (let attempt = 0; attempt < ROBOTS_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));

    const result = await rawFetch(`${origin}/robots.txt`, { timeoutMs: 10_000 });
    if (!result.ok || !result.response) continue; // transport failure: worth asking again

    const { response } = result;

    if (response.status === 404 || response.status === 410) {
      // No robots.txt at all is a positive answer: the site has not restricted
      // anything. That is different from not being able to ask.
      robots = parseRobots("", AGENT_TOKEN);
      break;
    }
    if (response.ok) {
      const text = await response.text().catch(() => "");
      robots = parseRobots(text, AGENT_TOKEN);
      break;
    }
    // 401 and 403 are an answer, and the answer is no. Asking again will not change it,
    // so stop here and fail closed rather than spending the remaining attempts.
    if (response.status === 401 || response.status === 403) break;
    // 5xx and the rest: the server is having a moment. Ask again.
  }

  robotsCache.set(origin, { robots, fetchedAt: Date.now() });
  return robots;
}

/** How many times we ask for robots.txt before treating it as unreadable. */
const ROBOTS_ATTEMPTS = 3;

/**
 * @typedef {object} FetchResult
 * @property {"ok"|"not_modified"|"fetch_error"|"blocked"|"challenged"|"rate_limited"|"parse_error"} status
 * @property {number} [httpStatus]
 * @property {string} [body]
 * @property {string} [contentType]
 * @property {string} [finalUrl]
 * @property {string | null} [etag]
 * @property {string | null} [lastModified]
 * @property {string} [error]
 * @property {boolean} [robotsAllowed]
 * @property {"http"|"browser"} [via]      which transport produced the body
 * @property {string | null} [wall]        the vendor whose wall we met, where known
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
        // Some walls answer 429 to everything from a datacentre range regardless of
        // pace, so backing off further never clears it. One render, then give up.
        const rendered = await escalate(url, parsed, delayMs, {
          httpStatus: response.status,
          vendor: null,
          signal: `HTTP ${response.status} after ${attempt} backoffs`,
        });
        if (rendered.status === "ok") return rendered;
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
      // A refusal may be a wall rather than an answer. detectChallenge decides, and
      // excludes 401 and 407 — authentication is never something we render past.
      const verdict = detectChallenge({ status: response.status, headers: response.headers });
      if (verdict.renderable) {
        return await escalate(url, parsed, delayMs, {
          httpStatus: response.status,
          vendor: verdict.vendor,
          signal: verdict.signal ?? `HTTP ${response.status}`,
        });
      }
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

    // The expensive case: a 2xx carrying a wall instead of a document. Left unchecked
    // this reaches extraction as a page with no text, and the run reports a failure to
    // extract rather than a failure to fetch — which is what fifty-three of the lines
    // in the September 15 log actually were.
    //
    // Text length is measured with the same htmlToText the pipeline extracts with, so
    // "too thin to be a document" means the same thing here as it does downstream.
    // Only HTML is measured: a feed is XML, its text is all in attributes and CDATA,
    // and running a page heuristic over it would send every RSS source to a browser.
    const isMarkup = /html/.test(contentType);
    const textLength = isMarkup ? htmlToText(read.text).text.length : Number.POSITIVE_INFINITY;

    const verdict = detectChallenge({
      status: response.status,
      body: read.text,
      headers: response.headers,
      contentType,
      textLength,
    });
    if (verdict.challenged && verdict.renderable) {
      return await escalate(url, parsed, delayMs, {
        httpStatus: response.status,
        vendor: verdict.vendor,
        signal: verdict.signal ?? "interstitial",
      });
    }

    // No wall, but no page either: markup that assembles itself in a browser. Render it
    // rather than hand the model an empty shell and record the failure as the model's.
    if (
      isMarkup &&
      looksUnrendered({
        status: response.status,
        body: read.text,
        textLength,
        contentType,
        jsonLdCount: extractJsonLd(read.text).length,
      })
    ) {
      const rendered = await escalate(url, parsed, delayMs, {
        httpStatus: response.status,
        vendor: null,
        signal: `${textLength} characters of text in ${read.text.length} bytes of markup`,
      });
      // A render that fails here is not a block: we DID get a document, it is simply
      // thin. Hand back what HTTP gave us and let extraction judge it.
      if (rendered.status === "ok") return rendered;
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
      via: "http",
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

/**
 * Render a URL that plain HTTP could not read.
 *
 * Called only from politeFetch, only after the robots check has passed and only after
 * a turn has been taken on this host. It takes ANOTHER turn before rendering, because
 * the render is a second request to the same host and §2.1 rule 4 counts requests, not
 * fetch strategies.
 *
 * A render that fails returns the original HTTP failure as `challenged`, not as a
 * generic fetch error. That distinction is the point of the whole change: the log
 * should say "this source is behind a wall we could not pass", because that is a fact
 * about the source that an operator can act on, and "extraction failed" is not.
 *
 * @param {string} url
 * @param {URL} parsed
 * @param {number} delayMs
 * @param {{ httpStatus: number, vendor: string | null, signal: string }} met
 * @returns {Promise<FetchResult>}
 */
async function escalate(url, parsed, delayMs, met) {
  const wall = met.vendor ? `${met.vendor} (${met.signal})` : met.signal;

  if (!BROWSER_ENABLED) {
    return {
      status: "challenged",
      httpStatus: met.httpStatus,
      error: `blocked by ${wall}; browser rendering is off (INGEST_BROWSER=0)`,
      robotsAllowed: true,
      wall: met.vendor,
    };
  }

  const settled = wallsThatStood.get(parsed.host);
  if (settled && settled.failures >= HOST_ATTEMPTS_BEFORE_GIVING_UP) {
    return {
      status: "challenged",
      httpStatus: met.httpStatus,
      error: `blocked by ${wall}; ${parsed.host} already turned the browser away this run (${settled.reason})`,
      robotsAllowed: true,
      wall: met.vendor,
    };
  }

  if (rendersUsed >= RENDER_BUDGET) {
    return {
      status: "challenged",
      httpStatus: met.httpStatus,
      error: `blocked by ${wall}; the run's render budget of ${RENDER_BUDGET} is spent`,
      robotsAllowed: true,
      wall: met.vendor,
    };
  }
  rendersUsed += 1;

  const { renderPage } = await import("./browser-fetch.mjs");

  // §2.1 rule 4 again: the render is a request too.
  await waitForTurn(parsed.host, delayMs);

  const rendered = await renderPage(url);

  if (!rendered.ok) {
    const previous = wallsThatStood.get(parsed.host)?.failures ?? 0;
    wallsThatStood.set(parsed.host, {
      failures: previous + 1,
      reason: rendered.reason ?? "render failed",
    });
    return {
      status: "challenged",
      httpStatus: rendered.httpStatus ?? met.httpStatus,
      error: `blocked by ${wall}; browser could not pass it: ${rendered.reason}`,
      robotsAllowed: true,
      wall: met.vendor,
      via: "browser",
    };
  }

  // A success clears the host: a wall that let us through once is not a wall that
  // stands, and one slow page earlier in the run should not condemn the rest.
  wallsThatStood.delete(parsed.host);

  if (Buffer.byteLength(rendered.html ?? "", "utf8") > MAX_BODY_BYTES) {
    // §4.2's cap binds on this path too. A rendered DOM is bigger than the source
    // HTML, so this fires more often here than it does on a plain fetch.
    return {
      status: "parse_error",
      httpStatus: rendered.httpStatus ?? met.httpStatus,
      error: `rendered body over the ${MAX_BODY_BYTES} byte cap`,
      robotsAllowed: true,
      via: "browser",
    };
  }

  return {
    status: "ok",
    httpStatus: rendered.httpStatus ?? 200,
    body: rendered.html,
    contentType: rendered.contentType ?? "text/html",
    finalUrl: rendered.finalUrl ?? url,
    // A rendered page has no meaningful validators: the DOM is ours, not the
    // publisher's, so an ETag from it would make the next conditional request lie.
    etag: null,
    lastModified: null,
    robotsAllowed: true,
    via: "browser",
    wall: met.vendor,
  };
}

/** Reset the per-process caches. For tests and for a long-lived process. */
export function resetFetcherState() {
  robotsCache.clear();
  lastRequestAt.clear();
  wallsThatStood.clear();
  rendersUsed = 0;
}

/** How much of the render budget this run has spent. For the end-of-run summary. */
export function renderStats() {
  return {
    used: rendersUsed,
    budget: RENDER_BUDGET,
    enabled: BROWSER_ENABLED,
    hostsGivenUpOn: [...wallsThatStood.entries()]
      .filter(([, v]) => v.failures >= HOST_ATTEMPTS_BEFORE_GIVING_UP)
      .map(([host]) => host),
  };
}
