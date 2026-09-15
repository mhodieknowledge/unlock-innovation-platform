/**
 * Bot-wall detection. OPPORTUNITY_INGESTION.md §4.2.
 *
 * A block used to be easy to see: the server said 403 and we recorded a fetch error.
 * The walls in front of the sources in §3 no longer do that. Three of them answered a
 * production run with a 2xx and a body that contained no opportunity, no article and
 * no JSON-LD — an interstitial whose whole job is to run a proof-of-work in a browser
 * and redirect. The pipeline read those as documents, found nothing in them, and
 * logged `extraction_failed` fifty-three times: a true statement about the text we
 * held and a false one about what had happened, which is the expensive kind of wrong.
 * An operator reading that log tunes the extraction prompt for a week and never finds
 * the bug, because the bug is that we never had the page.
 *
 * So the wall is named here, before extraction, and named as what it is.
 *
 * Everything in this file is a pure function over a status line, headers and a body.
 * That is deliberate: this is the decision that routes a fetch to a browser, browsers
 * are the expensive path, and a heuristic that cannot be unit-tested is a heuristic
 * that drifts. The cost of a false positive is one slow render; the cost of a false
 * negative is the silent failure above. The thresholds lean accordingly.
 */

/**
 * Vendor fingerprints in the body, in two strengths.
 *
 * STRONG means the document IS the wall: the marker cannot appear on a page that has
 * already been served. WEAK means the site sits behind that vendor, which is true of a
 * large share of the open web and says nothing on its own — Cloudflare leaves its
 * challenge-platform script on ordinary pages it has already let through. A weak marker
 * only counts when the document is also too thin to be a document.
 *
 * The distinction is not pedantry. Treating every weak marker as a wall sent a fully
 * rendered Disrupt Africa article through a fifteen-second browser render to arrive at
 * the same 3,485 characters the plain fetch had already returned in three. At §9's
 * budget that trade is the difference between a run that fits in its Actions minutes
 * and one that does not.
 */
const STRONG_SIGNATURES = [
  // Cloudflare's own marker for an interstitial it is currently serving. This is the
  // one CF-Clearance-Scraper keys on, and it is only present on a challenge document.
  { pattern: /cType:\s*'(?:non-interactive|managed|interactive)'/, vendor: "cloudflare" },
  { pattern: /window\._cf_chl_opt/, vendor: "cloudflare" },
  { pattern: /<title>\s*Just a moment/i, vendor: "cloudflare" },
  { pattern: /Checking your browser before accessing/i, vendor: "cloudflare" },

  // Sucuri / GoDaddy "sgcaptcha". This is the one that answered 202 on
  // scholarshipregion.com: a 171-byte document whose entire content is a meta refresh
  // to a proof-of-work endpoint.
  { pattern: /\/\.well-known\/sgcaptcha\//, vendor: "sucuri" },
  { pattern: /<title>\s*Robot Challenge Screen/i, vendor: "sucuri" },

  // The rest of the market. Named individually rather than by one loose regex so the
  // log says which wall, which is what an operator needs to decide whether a source
  // is worth keeping.
  { pattern: /<title>\s*Attention Required/i, vendor: "cloudflare" },
  { pattern: /_Incapsula_Resource\?/i, vendor: "imperva" },
  { pattern: /px-captcha|window\._pxAppId/i, vendor: "perimeterx" },
  { pattern: /<title>\s*Access denied/i, vendor: "generic" },
  { pattern: /(?:Pardon|Please verify) (?:the|you are) (?:interruption|human)/i, vendor: "generic" },
  { pattern: /Verify (?:I am|you are) (?:not a bot|(?:a )?human)/i, vendor: "generic" },
  { pattern: /Enable JavaScript and cookies to continue/i, vendor: "cloudflare" },
];

/** Present on protected pages whether or not a challenge is being served. */
const WEAK_SIGNATURES = [
  { pattern: /\/cdn-cgi\/challenge-platform\//, vendor: "cloudflare" },
  { pattern: /challenges\.cloudflare\.com\/turnstile/, vendor: "cloudflare" },
  { pattern: /sucuri_cloudproxy/i, vendor: "sucuri" },
  { pattern: /ddos-guard\.net|__ddg\d?_/i, vendor: "ddos-guard" },
  { pattern: /incap_ses_/i, vendor: "imperva" },
  { pattern: /var\s+dd\s*=\s*\{['"]?cid/i, vendor: "datadome" },
];

/** Both tiers, for the post-render check where thinness is measured separately. */
const ALL_SIGNATURES = [...STRONG_SIGNATURES, ...WEAK_SIGNATURES];

/** Headers a wall sets that a normal response does not. */
const HEADER_SIGNATURES = [
  { header: "cf-mitigated", vendor: "cloudflare" },
  { header: "x-sucuri-block", vendor: "sucuri" },
  { header: "x-datadome", vendor: "datadome" },
  { header: "x-iinfo", vendor: "imperva" },
];

/**
 * A body short enough that it cannot be a document, carrying a redirect. The sgcaptcha
 * 202 is the case: 171 bytes, one meta refresh, no vendor string on the first hop. The
 * length bound is what keeps this from firing on a real page that happens to redirect.
 */
const META_REFRESH = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/i;
const SHORT_BODY_BYTES = 2048;

/**
 * Statuses a wall uses. 401 and 407 are not here on purpose: those mean authentication,
 * and §2.1 rule 2 forbids us to go around authentication by any means, browser included.
 * A 401 must stay a fetch error so that it keeps being visible as one.
 */
const BLOCKING_STATUSES = new Set([403, 406, 429, 503]);

/**
 * @typedef {object} ChallengeVerdict
 * @property {boolean} challenged   true when this response is a wall rather than a document
 * @property {string | null} vendor which wall, where we can tell
 * @property {string | null} signal what gave it away — goes into the log verbatim
 * @property {boolean} renderable   whether a browser render is worth trying
 */

/** @type {ChallengeVerdict} */
const CLEAR = { challenged: false, vendor: null, signal: null, renderable: false };

/**
 * Below this many characters of extractable text, a document is not a document. Used
 * to promote a weak vendor marker into a verdict, and to spot a page whose content
 * never arrived because it is assembled by script.
 */
export const THIN_TEXT_CHARS = 500;

/**
 * Is this response a bot wall rather than the document we asked for?
 *
 * @param {object} input
 * @param {number} input.status              HTTP status
 * @param {string} [input.body]              the body, as text
 * @param {Record<string, string> | Headers} [input.headers]
 * @param {string} [input.contentType]
 * @param {number} [input.textLength]        extractable text, where the caller has it
 * @returns {ChallengeVerdict}
 */
export function detectChallenge({ status, body = "", headers, contentType = "", textLength }) {
  const get = headerReader(headers);

  for (const { header, vendor } of HEADER_SIGNATURES) {
    const value = get(header);
    if (value) {
      return { challenged: true, vendor, signal: `${header}: ${value}`.slice(0, 120), renderable: true };
    }
  }

  for (const { pattern, vendor } of STRONG_SIGNATURES) {
    const match = pattern.exec(body);
    if (match) {
      return { challenged: true, vendor, signal: match[0].slice(0, 120), renderable: true };
    }
  }

  // A weak marker plus a document with nothing in it. Either half alone is ordinary.
  if (textLength !== undefined && textLength < THIN_TEXT_CHARS) {
    for (const { pattern, vendor } of WEAK_SIGNATURES) {
      const match = pattern.exec(body);
      if (match) {
        return {
          challenged: true,
          vendor,
          signal: `${match[0].slice(0, 80)} on a ${textLength}-character document`,
          renderable: true,
        };
      }
    }
  }

  // The unsigned interstitial: a 2xx, an HTML content type, a body too small to be a
  // page, and a redirect out of it. Anything larger is treated as a real document even
  // if it is thin, because a thin real page is common and a false positive here sends
  // every one of them to a browser.
  const isHtml = contentType === "" || /html|xml/.test(contentType);
  if (isHtml && body.length > 0 && body.length < SHORT_BODY_BYTES && META_REFRESH.test(body)) {
    return {
      challenged: true,
      vendor: "generic",
      signal: `${body.length}-byte body with a meta refresh`,
      renderable: true,
    };
  }

  // A blocking status with nothing identifiable in it. Still a block — the pipeline
  // asked for a document and did not get one — and still worth a browser, because the
  // commonest reason a CI runner sees a bare 403 is the IP it was given that morning.
  if (BLOCKING_STATUSES.has(status)) {
    return { challenged: true, vendor: null, signal: `HTTP ${status}`, renderable: true };
  }

  return CLEAR;
}

/**
 * A page that arrived, parsed, and turned out to hold no text.
 *
 * This is the other half of the September 15 log and it is not a wall at all: Zindi's
 * competition list and the GDG chapter directory are assembled in the browser, so a
 * plain GET returns a shell. Four hundred characters of navigation went to the model,
 * which could not find an opportunity in them, and the run recorded `extraction_failed`
 * — again true of the text and false about the page.
 *
 * Rendering is the only way to read these, and rendering them is strictly better than
 * the alternative, because the alternative is a guaranteed extraction failure.
 *
 * The discriminator is script, not size. A first attempt used a markup floor — a real
 * short page has short markup — and it missed She Code Africa, whose entire document is
 * 1,316 bytes because the application it boots is in an external bundle. What an
 * unrendered shell always has, and what a static page that is merely short does not, is
 * a script tag standing where the text should be.
 *
 * @param {object} input
 * @param {number} input.status
 * @param {string} input.body
 * @param {number} input.textLength
 * @param {string} [input.contentType]
 * @param {number} [input.jsonLdCount]  structured data we already hold, if any
 * @returns {boolean}
 */
export function looksUnrendered({ status, body, textLength, contentType = "", jsonLdCount = 0 }) {
  if (status < 200 || status >= 300) return false;
  if (contentType && !/html/.test(contentType)) return false;
  // JSON-LD is publisher-authored and wins over the model anyway (§4.4), so a page that
  // carries it has already given us the facts and needs no browser.
  if (jsonLdCount > 0) return false;
  if (textLength >= THIN_TEXT_CHARS) return false;
  if (!HAS_SCRIPT.test(body)) return false;
  // A response too small to be even a shell is something else — an error stub, a
  // redirect body — and a browser will not find a page in it either.
  return body.length >= MIN_SHELL_BYTES;
}

/** A script where the text should be. The mark of a document that boots rather than renders. */
const HAS_SCRIPT = /<script[\s>]/i;

/** Below this there is no document to render, only a stub. */
const MIN_SHELL_BYTES = 512;

/**
 * Did a browser render land on a real page, or on the wall's own page?
 *
 * Called after the solve loop, against the rendered DOM. Kept separate from
 * detectChallenge because the evidence is different: after rendering there is a title
 * and a body text length to read, and those are the two things that distinguish "the
 * challenge is still up" from "the challenge is gone and the page is simply short".
 *
 * @param {object} input
 * @param {string} [input.title]
 * @param {number} [input.textLength]  document.body.innerText.length
 * @param {string} [input.html]
 * @returns {boolean} true while the wall is still up
 */
export function stillChallenged({ title = "", textLength = 0, html = "" }) {
  const trimmed = title.trim();

  if (CHALLENGE_TITLES.test(trimmed)) return true;

  // A challenge script still in the DOM with almost no text behind it. Both halves
  // matter: Cloudflare leaves its script tag on some pages it has already let through,
  // so the script alone is not evidence, and a genuinely short page is not either.
  if (textLength < 200) {
    for (const { pattern } of ALL_SIGNATURES) {
      if (pattern.test(html)) return true;
    }
  }

  return false;
}

/** Titles a wall serves. Anchored at the start: a real article may mention any of these. */
const CHALLENGE_TITLES =
  /^(?:just a moment|robot challenge screen|attention required|checking your browser|please wait|loading\b|ddos-guard|access denied|security check|verifying you are human|one more step|bot verification)/i;

/**
 * @param {Record<string, string> | Headers | undefined} headers
 * @returns {(name: string) => string | null}
 */
function headerReader(headers) {
  if (!headers) return () => null;
  if (typeof (/** @type {Headers} */ (headers).get) === "function") {
    return (name) => /** @type {Headers} */ (headers).get(name);
  }
  const lower = new Map(
    Object.entries(/** @type {Record<string, string>} */ (headers)).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );
  return (name) => lower.get(name.toLowerCase()) ?? null;
}
