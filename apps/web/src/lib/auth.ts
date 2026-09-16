/**
 * Session handling. SYSTEM_ARCHITECTURE.md §11, SECURITY.md §1.
 *
 * No passwords are stored by this product at all — OAuth or one-time codes only,
 * which removes credential stuffing, password reuse and reset flows as attack
 * surfaces entirely (SECURITY.md §1).
 *
 * Provider order is GitHub -> Google -> email OTP, and that order is a product
 * decision with an infrastructure cause: email OTP consumes the same ~300/day
 * Brevo budget as the digests that drive retention (FREE_INFRASTRUCTURE.md §3.3).
 * UX_FLOWS.md §17 says plainly it "should not be reshuffled for aesthetic
 * reasons".
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AstroCookies } from "astro";

export interface SessionUser {
  id: string;
  email: string | null;
  handle: string | null;
  display_name: string | null;
  is_admin: boolean;
  admin_role: string | null;
  account_state: string;
  age_confirmed_18: boolean;
  timezone: string;
  low_data_mode: boolean;
}

interface Env {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
}

/**
 * A request-scoped client that reads and writes the session cookies.
 *
 * Cookies are HTTP-only, Secure, SameSite=Lax with a 30-day sliding refresh
 * (SYSTEM_ARCHITECTURE.md §11.1). HTTP-only matters more than usual here: the
 * whole design keeps personal data out of reach of page scripts, and a token a
 * script can read is a token an injected script can exfiltrate.
 */
export function createAuthClient(
  cookies: AstroCookies,
  env: Env = {},
): SupabaseClient | null {
  const url = env.SUPABASE_URL ?? import.meta.env["SUPABASE_URL"];
  const key = env.SUPABASE_ANON_KEY ?? import.meta.env["SUPABASE_ANON_KEY"];
  if (!url || !key) return null;

  return createServerClient(url, key, {
    cookies: {
      get: (name: string) => cookies.get(name)?.value,
      set: (name: string, value: string, options: CookieOptions) =>
        cookies.set(name, value, {
          ...options,
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
        }),
      remove: (name: string, options: CookieOptions) =>
        cookies.delete(name, { ...options, path: "/" }),
    },
  });
}

/**
 * The signed-in user, or null.
 *
 * Validates server-side on every authenticated request
 * (SYSTEM_ARCHITECTURE.md §11.1) rather than trusting a decoded cookie: a
 * client-decodable claim is a claim a client can forge.
 */
export async function getSessionUser(
  cookies: AstroCookies,
  env: Env = {},
): Promise<SessionUser | null> {
  const client = createAuthClient(cookies, env);
  if (!client) return null;

  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user) return null;

  const { data: row } = await client
    .from("users")
    .select(
      "id, email, handle, display_name, is_admin, admin_role, account_state, age_confirmed_18, timezone, low_data_mode",
    )
    .eq("id", user.id)
    .maybeSingle();

  if (!row) return null;
  return row as unknown as SessionUser;
}

/**
 * The cache policy for a page that is shared until it is personalised.
 *
 * READING THE SESSION AND SETTING THE CACHE HEADER ARE ONE DECISION, so they are one call.
 * Ten SSR pages — every opportunity, category, country and organisation page — rendered the
 * signed-out header at a signed-in reader, and the reason was sound: they set
 * `public, s-maxage=900`, and a page carrying somebody's name must never land in a shared
 * cache. The detail page said so in a comment and left the session unread.
 *
 * But the board has always done both, and correctly: personalise, and go private in the same
 * breath. The failure was that it took two separate statements to do it, so ten pages did the
 * safe half and skipped the useful one. Here it takes one, and the unsafe combination —
 * a user in the markup and `public` on the response — cannot be written.
 *
 * An anonymous reader still gets the shared policy unchanged, which is where edge caching
 * actually earns its keep: crawlers, shared links, the first visit from a search result.
 *
 * `Vary: Cookie` is appended by the pages themselves and is deliberately NOT relied on here.
 * Cloudflare honours `Vary` for very little, which is exactly why the private response is
 * marked private rather than trusted to vary.
 */
export function cachePolicyFor(
  response: { headers: Headers },
  user: unknown | null,
  sharedPolicy: string,
  /**
   * Any OTHER reason this particular response is not shareable.
   *
   * The board needs it: a page at `/` shaped by the reader's profile country or by the edge's
   * country hint is not the `/` the next reader should be handed, even when nobody is signed
   * in. Passing the reason here keeps that judgement in the same call as the header rather
   * than in a separate `shareable` variable a later edit can forget to consult.
   */
  alsoPrivateWhen = false,
): void {
  const personal = alsoPrivateWhen || (user !== null && user !== undefined);
  response.headers.set(
    "cache-control",
    personal ? "private, max-age=0, must-revalidate" : sharedPolicy,
  );
}

/**
 * PRODUCT_SPEC.md §22.1 and SYSTEM_ARCHITECTURE.md §11.3.
 *
 * An account that is restricted, or has not confirmed 18+, is read-only: no
 * intents, no teams, no requests, no messages, no public profile. This is the one
 * gate every social write path must pass through, so it lives in one function
 * rather than being re-derived at each call site.
 *
 * MODERATION_AND_TRUST.md §8 frames the restriction as protection, not
 * punishment, which is why the copy says what it says.
 */
export function socialWritesAllowed(user: SessionUser | null): {
  allowed: boolean;
  reason: string | null;
} {
  if (!user) return { allowed: false, reason: "You need to be signed in to do that." };

  if (!user.age_confirmed_18) {
    return {
      allowed: false,
      reason:
        "Accounts here are 18+. You can read and check eligibility on everything, but connecting with other people is turned off.",
    };
  }

  if (user.account_state === "restricted") {
    return {
      allowed: false,
      reason:
        "Your account is read-only at the moment. You can still browse, check eligibility and track opportunities.",
    };
  }

  if (user.account_state === "suspended" || user.account_state === "deleted") {
    return { allowed: false, reason: "This account is no longer active." };
  }

  return { allowed: true, reason: null };
}

/** Tracker and eligibility work for any active account, including a restricted one. */
export function personalWritesAllowed(user: SessionUser | null): boolean {
  return (
    user !== null && user.account_state !== "suspended" && user.account_state !== "deleted"
  );
}

/**
 * The signed-in reader's country of residence, and nothing else from their profile.
 *
 * UX_FLOWS.md §2 item 4 lets the homepage board follow the reader's country. The only way to
 * know it is the eligibility profile, which DATA_MODEL.md §15 gives exactly one read
 * principal: the owning user. This reads it through their own session client, so RLS is the
 * thing enforcing that — not this function's good intentions — and it selects ONE column,
 * because the rest of that table has no business in a page render.
 *
 * Null when there is no session, no profile, or no country in it. The board then falls back
 * to the edge hint and finally to showing everything, which is the honest default.
 */
export async function getResidenceCountry(
  cookies: AstroCookies,
  env: Env = {},
): Promise<string | null> {
  const client = createAuthClient(cookies, env);
  if (!client) return null;

  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user) return null;

  const { data } = await client
    .from("eligibility_profiles")
    .select("country_of_residence")
    .eq("user_id", user.id)
    .maybeSingle();

  const iso2 = (data as { country_of_residence?: string | null } | null)?.country_of_residence;
  return iso2 ? iso2.trim().toUpperCase() : null;
}

/**
 * Where to send someone after signing in. UX_FLOWS.md §17: sign-in returns the
 * user "to exactly where they were, action completed".
 *
 * Only same-origin relative paths are honoured, so the parameter cannot be used
 * as an open redirect.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.includes("://")) return "/";
  return raw.slice(0, 500);
}
