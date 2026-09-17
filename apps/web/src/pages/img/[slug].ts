import type { APIRoute } from "astro";

import { getClient } from "~/lib/db";
import { runtimeEnv } from "~/lib/runtime";
import { safeImageUrl } from "@mbele/ingest/images";

/**
 * The picture a source published, served from our own origin.
 *
 * WHY THIS ROUTE EXISTS AT ALL. The CSP is `img-src 'self' data:` and stays that way:
 * pointing a reader's browser at each source's CDN would hand every one of those hosts a
 * request carrying that reader's IP and user-agent, on every page view. ANALYTICS.md §3
 * forbids capturing an IP ourselves; handing it to forty ad-tech-adjacent CDNs instead is
 * not a loophole. So the bytes come through here, and no reader ever contacts a source.
 *
 * THE URL IS NEVER TAKEN FROM THE REQUEST. This is the whole security design, and it is worth
 * stating plainly because the obvious version of this endpoint — `/img?url=…` — is a
 * server-side request forgery primitive with a cache in front of it. The only input here is a
 * SLUG. The URL is read from the row, written by the ingest pipeline, constrained by the
 * column's CHECK, and re-validated below by the same function that accepted it. A reader can
 * ask for any listing's picture and no other thing.
 *
 * The remaining defences are about the RESPONSE, which is still a stranger's bytes:
 *   - a content-type allowlist, so an HTML error page cannot be served as an image;
 *   - a byte cap, so a slow-loris or a 40 MB TIFF cannot be relayed to a reader who is
 *     paying by the megabyte;
 *   - a timeout, so a dead CDN cannot hold a Worker open;
 *   - `redirect: "follow"` left to the platform's own limit, but re-validated by the
 *     content-type check on whatever finally answers.
 *
 * EVERY FAILURE IS A 404, not a 500 and not a placeholder image. The card is built to render
 * without a picture, so the honest outcome of "we could not get this" is the state the card
 * already knows how to be. A 500 here would also make every broken third-party CDN look like
 * our outage.
 */
export const prerender = false;

/** What we are willing to relay. No SVG: it is a script vector, not a photograph. */
const ALLOWED_TYPE = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
]);

/**
 * The most we will relay for one card.
 *
 * PRODUCT_SPEC.md §25.1 budgets a route at 120 KB total and an organisation logo at 12 KB.
 * A typical `og:image` is 1200×630 and lands between 50 and 150 KB, so this cap is NOT
 * generous — it is the line past which a picture costs more than the listing it decorates,
 * on the connections this product exists for. A source above it renders as no picture, which
 * is a card the design already accounts for.
 */
const MAX_BYTES = 120 * 1024;

const FETCH_TIMEOUT_MS = 4000;

const missing = () =>
  new Response(null, {
    status: 404,
    // Cached briefly even when absent: most listings have no picture, and without this every
    // card without one costs a Worker invocation on every render.
    headers: { "cache-control": "public, max-age=300, s-maxage=3600" },
  });

export const GET: APIRoute = async ({ params, request }) => {
  const slug = (params.slug ?? "").trim();
  if (!slug || slug.length > 200) return missing();

  const client = getClient(runtimeEnv());
  if (!client) return missing();

  const { data, error } = await client
    .from("opportunities")
    .select("image_url")
    .eq("slug", slug)
    // A picture belongs to a listing a reader can actually see. Without this, the endpoint
    // would serve images for rows that are in review, expired or soft-deleted — a listing
    // nobody is allowed to read, leaking by way of its banner.
    .eq("status", "published")
    .is("deleted_at", null)
    .maybeSingle();

  if (error || !data) return missing();

  // Re-validated rather than trusted: the row was written by a pipeline that ran some other
  // day, under rules that may since have changed.
  const target = safeImageUrl((data as { image_url: string | null }).image_url, null);
  if (!target) return missing();

  const abort = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      signal: abort,
      redirect: "follow",
      headers: {
        accept: "image/avif,image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.5",
        // Identify the fetcher. /bot documents this crawler, and a source that wants to
        // refuse us should be able to recognise us in order to do it.
        "user-agent": request.headers.get("user-agent")?.includes("Mbele")
          ? "MbeleImageFetch/1.0 (+https://mbele.africa/bot)"
          : "MbeleImageFetch/1.0 (+https://mbele.africa/bot)",
      },
    });
  } catch {
    return missing();
  }

  if (!upstream.ok || !upstream.body) return missing();

  const type = (upstream.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!ALLOWED_TYPE.has(type)) return missing();

  // A declared length over the cap is refused without reading a byte. A missing or lying
  // header is caught by the counter below, which is why both exist.
  const declared = Number(upstream.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES) return missing();

  const buffer = await readCapped(upstream, MAX_BYTES);
  if (!buffer) return missing();

  return new Response(buffer, {
    status: 200,
    headers: {
      "content-type": type,
      "content-length": String(buffer.byteLength),
      // A listing's picture changes about as often as the listing does. A long edge cache is
      // what keeps this from being a Worker invocation per card per reader; the shorter
      // browser max-age keeps a replaced image from being stuck on a device for a week.
      "cache-control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      // Relayed bytes from a third party. Neither of these should ever be interpreted as
      // markup, whatever the content-type said.
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
};

/**
 * Read at most `limit` bytes, and fail rather than truncate.
 *
 * Truncating would produce a half-decoded image, which is worse than none: a reader sees a
 * broken picture and cannot tell whether the listing is broken too. Reading the stream by
 * hand rather than calling `arrayBuffer()` is the point — `arrayBuffer()` buffers whatever
 * arrives before it checks anything, so a lying `content-length` is a memory limit away from
 * taking the Worker down.
 */
async function readCapped(response: Response, limit: number): Promise<ArrayBuffer | null> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  // An exact-size ArrayBuffer rather than a Uint8Array view: `Response` takes the buffer
  // directly, and handing it a view leaves the reader to reason about offsets that are always
  // zero here.
  const out = new ArrayBuffer(total);
  const view = new Uint8Array(out);
  let at = 0;
  for (const chunk of chunks) {
    view.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
