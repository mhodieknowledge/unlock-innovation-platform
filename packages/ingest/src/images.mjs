/**
 * The picture a source publishes about itself.
 *
 * WHY THIS IS NOT A STOCK PHOTOGRAPH. The board carried category-level marketing images for
 * a while and they were removed, for a reason that still holds: a photograph chosen by us to
 * represent someone else's hackathon is a claim we cannot check, on a product whose entire
 * position is that it quotes the organiser rather than paraphrasing them.
 *
 * An `og:image` is a different object. It is the picture the ORGANISER attached to their own
 * page, for the express purpose of being shown when that page is linked. Rendering it beside
 * a link to that page is the use it was published for. Nothing is invented and nothing is
 * chosen on the organiser's behalf.
 *
 * WHAT THIS MODULE IS CAREFUL ABOUT. The URL comes off a page a crawler fetched, so it is
 * hostile input twice over: it is chosen by a third party, and it is later handed to a
 * server-side fetch. Anything this function returns will be requested by our own
 * infrastructure, which makes it an SSRF vector if it is wrong. So it is strict in a way a
 * "just parse a meta tag" helper would not be — https only, public hosts only, no
 * credentials, no ports — and it returns null far more readily than it returns a URL.
 *
 * MODERATION_AND_TRUST.md §2.2 is the reason the CALLER still has work to do: a picture makes
 * a listing look endorsed, and a scam listing has the glossiest banner of all. The card
 * renders this behind the same verification label as everything else, and never in place of
 * it.
 */

/** Longest URL we will store. Real `og:image` URLs are far below this; a 4KB one is a bug. */
export const MAX_IMAGE_URL_LENGTH = 1024;

/**
 * Hosts that must never be fetched by our own server.
 *
 * Workers cannot reach a private network, so in production this is a second lock on a door
 * that is already shut. It matters anyway: the same column is read by scripts running in CI
 * and on a laptop, where `localhost` resolves to something, and a rule that only holds in one
 * deployment is a rule nobody can rely on.
 */
const BLOCKED_HOST = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local, and the cloud metadata endpoint that lives on it
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i, // unique-local IPv6
  /\.local$/i,
  /\.internal$/i,
];

/**
 * `<meta>` in source order, as { key, value } pairs — `property` or `name`, either quoting.
 *
 * @param {string} html
 * @returns {{ key: string, value: string }[]}
 */
function metaTags(html) {
  /** @type {{ key: string, value: string }[]} */
  const out = [];
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const text = tag[0];
    const key = /(?:property|name)\s*=\s*["']?\s*([^"'\s>]+)/i.exec(text);
    const value = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(text);
    if (!key || !value) continue;
    out.push({ key: (key[1] ?? "").toLowerCase(), value: (value[1] ?? value[2] ?? "").trim() });
  }
  return out;
}

/**
 * Whatever a JSON-LD node calls an image: a string, an object with `url`, or a list of either.
 *
 * @param {unknown[]} blocks
 * @returns {string | null}
 */
function fromJsonLd(blocks) {
  /** @type {(node: unknown, depth?: number) => string | null} */
  const walk = (node, depth = 0) => {
    if (depth > 6 || node === null || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const record = /** @type {Record<string, unknown>} */ (node);
    const image = record["image"] ?? record["thumbnailUrl"] ?? record["logo"];
    if (typeof image === "string" && image.trim()) return image.trim();
    if (Array.isArray(image)) {
      for (const item of image) {
        if (typeof item === "string" && item.trim()) return item.trim();
        if (item && typeof item === "object") {
          const url = /** @type {Record<string, unknown>} */ (item)["url"];
          if (typeof url === "string" && url.trim()) return url.trim();
        }
      }
    }
    if (image && typeof image === "object" && !Array.isArray(image)) {
      const url = /** @type {Record<string, unknown>} */ (image)["url"];
      if (typeof url === "string" && url.trim()) return url.trim();
    }
    for (const value of Object.values(record)) {
      const found = walk(value, depth + 1);
      if (found) return found;
    }
    return null;
  };
  for (const block of blocks ?? []) {
    const found = walk(block);
    if (found) return found;
  }
  return null;
}

/**
 * Turn a candidate into a URL we are willing to have our own server request, or null.
 *
 * Exported because the serving route re-checks the stored value rather than trusting it. The
 * column was written by a pipeline that ran some other day, against rules that may since have
 * changed; re-validating at the moment of use costs one URL parse and removes a whole class
 * of "it was fine when we stored it".
 *
 * @param {string | null | undefined} candidate
 * @param {string | null | undefined} pageUrl Base for a relative URL — the page it came from.
 * @returns {string | null}
 */
export function safeImageUrl(candidate, pageUrl) {
  if (typeof candidate !== "string") return null;
  const raw = candidate.trim();
  if (!raw || raw.length > MAX_IMAGE_URL_LENGTH) return null;
  // A data: or blob: URL is not something to fetch, and inlining a stranger's bytes into our
  // own HTML is a different decision from linking to their picture.
  if (/^(data|blob|javascript|file):/i.test(raw)) return null;

  let url;
  try {
    url = pageUrl ? new URL(raw, pageUrl) : new URL(raw);
  } catch {
    return null;
  }

  // https only. An http image on an https page is blocked by the browser as mixed content
  // anyway, so storing one would mean storing a URL that can never render.
  if (url.protocol !== "https:") return null;
  // Credentials in a URL our server will fetch are never something we want to replay.
  if (url.username || url.password) return null;
  // A non-default port is not how a public CDN serves an image, and is how an internal
  // service gets reached.
  if (url.port && url.port !== "443") return null;

  const host = url.hostname;
  if (!host || !host.includes(".") || BLOCKED_HOST.some((re) => re.test(host))) return null;

  url.hash = "";
  const out = url.toString();
  return out.length <= MAX_IMAGE_URL_LENGTH ? out : null;
}

/**
 * The image a page publishes about itself, in the order the standards expect.
 *
 * `og:image` first because it is the one an organiser sets deliberately for link previews.
 * `og:image:secure_url` is preferred where both exist — it is the https one by definition.
 * Twitter's tag next, then JSON-LD, which is last because schema.org's `image` is often the
 * organisation's logo rather than the thing on offer, and a logo stretched across a card is
 * worse than no picture.
 *
 * @param {string} html
 * @param {string | null | undefined} pageUrl
 * @param {unknown[]} [jsonld] Blocks already parsed by extractJsonLd, to avoid parsing twice.
 * @returns {string | null}
 */
export function extractImageUrl(html, pageUrl, jsonld = []) {
  const metas = metaTags(typeof html === "string" ? html : "");
  /** @type {(wanted: string) => string | null} */
  const byKey = (wanted) => metas.find((m) => m.key === wanted)?.value ?? null;

  const ordered = [
    byKey("og:image:secure_url"),
    byKey("og:image"),
    byKey("twitter:image"),
    byKey("twitter:image:src"),
    fromJsonLd(jsonld),
  ];

  for (const candidate of ordered) {
    const safe = safeImageUrl(candidate, pageUrl);
    if (safe) return safe;
  }
  return null;
}
