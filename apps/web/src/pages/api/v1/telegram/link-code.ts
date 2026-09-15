import type { APIRoute } from "astro";

import { createAuthClient, getSessionUser } from "~/lib/auth";
import { reportError } from "~/lib/errors";
import { runtimeEnv } from "~/lib/runtime";

/**
 * POST /api/v1/telegram/link-code — issues a short-lived code for `/link`.
 *
 * Written with the caller's own session, through the owner-only policy on
 * telegram_link_codes: a user may create and read their OWN codes and nothing
 * else. Redemption is the bot's SECURITY DEFINER path, so possessing a code grants
 * exactly one thing — attaching a chat to the account that generated it.
 *
 * 15 minutes, single use. A long-lived code is a standing account-takeover
 * primitive: anyone who sees it in a screenshot can attach their own chat.
 */
export const prerender = false;

/** Crockford-ish: no I, O, 0 or 1, because this gets read off a screen and retyped. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export const POST: APIRoute = async ({ cookies, locals, redirect }) => {
  const env = runtimeEnv();
  const user = await getSessionUser(cookies, env);
  if (!user) return redirect(`/signin?returnTo=${encodeURIComponent("/you/notifications")}`, 302);

  const client = createAuthClient(cookies, env);
  if (!client) return redirect("/you/notifications?link=unavailable", 302);

  try {
    // Any earlier unused code is dropped first: two live codes means two ways in,
    // for no benefit to the person holding either.
    await client.from("telegram_link_codes").delete().is("used_at", null);

    const code = newCode();
    const { error } = await client.from("telegram_link_codes").insert({
      user_id: user.id,
      code,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    if (error) throw new Error(error.message);

    // Back to the page with the code in the query string rather than a JSON
    // response: this is a form post from a page with no island, and the page has
    // to render the code either way.
    return redirect(`/you/notifications?code=${code}`, 303);
  } catch (err) {
    await reportError(err, { route: "/api/v1/telegram/link-code" }, env);
    return redirect("/you/notifications?link=failed", 303);
  }
};
