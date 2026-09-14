/**
 * URL canonicalisation. OPPORTUNITY_INGESTION.md §4.3.
 *
 * "Canonicalise the URL: strip utm_*, fbclid, gclid, session params; lowercase
 * host; remove trailing slash; resolve redirects and store the final URL."
 *
 * Resolving redirects needs the network and lives in the fetcher. Everything else
 * is a pure function, which matters more than it looks: the canonical URL is the
 * dedupe key for the whole catalogue (§4.6 rule 1 makes a canonical-URL match a
 * CERTAIN duplicate and auto-merges on it). A canonicaliser that is inconsistent
 * across runs creates duplicates; one that is too aggressive merges two genuinely
 * different opportunities into one. Both are visible to users, so this is tested
 * rather than assumed.
 */

/**
 * Query parameters carrying no meaning about WHICH page this is.
 *
 * Kept conservative on purpose. A parameter that might select content — `id`,
 * `page`, `year`, `lang` — is left alone, because stripping it would merge two
 * different opportunities. Tracking parameters are the only safe class to remove.
 */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "twclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "referrer",
  "source",
  "_hsenc",
  "_hsmi",
  "vero_id",
  "vero_conv",
  "yclid",
  "s_cid",
  "ck_subscriber_id",
  "sessionid",
  "session_id",
  "phpsessid",
  "jsessionid",
  "aspsessionid",
]);

const TRACKING_PREFIXES = ["utm_", "pk_", "piwik_", "matomo_", "hsa_", "at_"];

/**
 * True for a parameter that identifies the visitor rather than the page.
 * @param {string} name
 */
function isTrackingParam(name) {
  const lower = name.toLowerCase();
  return (
    TRACKING_PARAMS.has(lower) || TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

/**
 * @param {string} raw
 * @param {string} [base] resolve a relative URL against this
 * @returns {string | null} the canonical form, or null if it is not a usable http(s) URL
 */
export function canonicaliseUrl(raw, base) {
  if (typeof raw !== "string" || raw.trim() === "") return null;

  let url;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }

  // Anything that is not http(s) is not a web page we can fetch or cite. Notably
  // this drops javascript:, data: and mailto: before they can reach the database.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hostname = url.hostname.toLowerCase();
  url.hash = "";

  // Credentials in a URL are a security problem and never part of an identity.
  url.username = "";
  url.password = "";

  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }

  /** @type {Array<[string, string]>} */
  const keep = [];
  for (const [key, value] of url.searchParams) {
    if (!isTrackingParam(key)) keep.push([key, value]);
  }
  // Sorted, so two links to the same page with the parameters in a different order
  // produce one canonical URL and therefore one catalogue entry.
  keep.sort((x, y) => {
    const a = x[0] ?? "";
    const b = y[0] ?? "";
    return a < b ? -1 : a > b ? 1 : 0;
  });
  url.search = "";
  for (const [key, value] of keep) url.searchParams.append(key, value);

  // A trailing slash on a path is not a different page. On the root it is
  // conventional, so "https://x.example/" keeps its slash rather than becoming a
  // URL that some clients reject.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}

/**
 * The registrable-ish host, for organisation resolution by domain (§4.5).
 *
 * `www.` is dropped because nobody means it. Deeper subdomains are KEPT: the
 * difference between `grants.example.org` and `careers.example.org` is often the
 * difference between two departments, and collapsing them would attach an
 * opportunity to the wrong organisation.
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function hostOf(raw) {
  const canonical = canonicaliseUrl(raw);
  if (!canonical) return null;
  return new URL(canonical).hostname.replace(/^www\./, "");
}

/**
 * Same host, ignoring `www.`? Used by the link-health check: §5.2 flags a 3xx
 * redirect "to a different host" for review, because a programme that moved domain
 * and a domain that was sold to someone else look identical from the outside, and
 * the second is a known scam vector.
 *
 * @param {string} a
 * @param {string} b
 */
export function sameHost(a, b) {
  const ha = hostOf(a);
  const hb = hostOf(b);
  return ha !== null && ha === hb;
}
