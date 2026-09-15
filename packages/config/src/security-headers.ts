/**
 * The response headers SECURITY.md §5 requires, as data.
 *
 * ONE definition, two appliers, because Cloudflare needs both and each covers what the other
 * cannot:
 *
 *   `apps/web/public/_headers` is read by Cloudflare's static-asset handler, which serves the
 *   stylesheet, the service worker and the prerendered pages BEFORE the Worker runs. Middleware
 *   never sees those requests.
 *
 *   `apps/web/src/middleware.ts` applies them to every SSR response, which the assets handler
 *   never sees. Without it the opportunity pages, the country pages and the whole authenticated
 *   surface ship with no CSP at all — which is how this was found: `_headers` looked right, the
 *   test read `_headers`, and the pages the product is actually made of carried nothing.
 *
 * A test asserts the `_headers` `/*` block and this module say the same thing, so the two cannot
 * drift. That is the sixth instance of the same lesson in this repository and the reason the
 * values live here rather than being typed twice.
 *
 * `connect-src 'self'` and nothing more: no browser code in this product talks to Supabase
 * directly. Sign-in is a form POST handled server-side, and the one island fetches
 * `/api/v1/eligibility/evaluate` on this origin. If that ever changes, this is the line to widen —
 * and SECURITY.md §5's note about widening it per environment describes a shape the app does not
 * have.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; "),

  // Two years, subdomains included, preload-eligible. SECURITY.md §5.
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",

  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
} as const;
