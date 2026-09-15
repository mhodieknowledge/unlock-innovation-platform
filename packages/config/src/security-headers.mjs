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
 *
 * `form-action 'self'` is right for every page except one, and `signInFormAction` below is that
 * exception.
 */
/**
 * The policy itself, named rather than reached for by key.
 *
 * `signInFormAction` below needs to rewrite one directive of it, and indexing the record to get
 * it back gives `string | undefined` under this repository's `noUncheckedIndexedAccess` — which
 * would mean either a non-null assertion or a fallback string that could silently become the real
 * policy. A value two things need is a value with a name.
 */
const CONTENT_SECURITY_POLICY = [
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
].join("; ");

/**
 * `.mjs`, like brand.mjs and ranking.mjs beside it, because this is read by plain Node as well
 * as by the app: scripts/verify-deployment.mjs asserts a live deployment carries exactly these
 * headers, and a `.ts` import there needs a type-stripping flag and fails `tsc -p
 * tsconfig.scripts.json`. A shared constant should not need a loader.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const SECURITY_HEADERS = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,

  // Two years, subdomains included, preload-eligible. SECURITY.md §5.
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",

  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/**
 * The origins the sign-in form is allowed to reach, and why there is an exception at all.
 *
 * `form-action` governs the WHOLE redirect chain of a form submission, not just its action URL.
 * Signing in posts to `/signin`, which 302s to Supabase's `/auth/v1/authorize`, which 302s to
 * GitHub or Google. Under `form-action 'self'` Chrome refuses the submission outright — and
 * refuses it silently. The page does not navigate, no error is shown, and the only trace is a
 * console line:
 *
 *   Refused to send form data to 'https://…/signin' because it violates the following
 *   Content Security Policy directive: "form-action 'self'".
 *
 * Which is to say: the button does nothing. That is how it was found, and it is worth knowing
 * that the symptom of this directive being wrong is indistinguishable from a dead button.
 *
 * Measured rather than assumed: allowing only the Supabase hop is NOT enough. Each origin in the
 * chain has to be listed, the provider's included. apps/web/test/security-headers.test.ts records
 * the experiment.
 *
 * WHAT THIS COSTS. `form-action` exists to stop injected markup posting a form to an attacker's
 * server. These three origins are not an attacker's server, cannot be reached by an attacker who
 * does not already control GitHub or Google, and give a posted form back to nobody — the
 * exfiltration this directive prevents needs an origin the attacker can READ, and that stays
 * blocked. Nothing else in the policy moves: not script-src, not connect-src, not default-src.
 *
 * AND IT IS SCOPED TO ONE ROUTE. apps/web/src/middleware.ts applies this on `/signin` alone;
 * every other response in the product keeps `form-action 'self'` exactly as above.
 */
export const SIGNIN_FORM_TARGETS = ["https://github.com", "https://accounts.google.com"];

/**
 * The header set for the sign-in page: the set above, with `form-action` widened to the auth
 * origins and nothing else touched.
 *
 * @param {string | undefined} supabaseUrl The project URL. Absent means sign-in is unavailable
 *   anyway, so the strict set is returned unchanged rather than guessed at.
 * @returns {Readonly<Record<string, string>>}
 */
export function signInFormAction(supabaseUrl) {
  let authOrigin = "";
  try {
    if (supabaseUrl) authOrigin = new URL(supabaseUrl).origin;
  } catch {
    // A malformed URL is not a reason to emit a malformed policy.
    authOrigin = "";
  }
  if (!authOrigin) return SECURITY_HEADERS;

  const targets = [authOrigin, ...SIGNIN_FORM_TARGETS].join(" ");
  return {
    ...SECURITY_HEADERS,
    "Content-Security-Policy": CONTENT_SECURITY_POLICY.replace(
      "form-action 'self'",
      `form-action 'self' ${targets}`,
    ),
  };
}
