import type { APIRoute } from "astro";

import { createAuthClient, safeReturnTo } from "~/lib/auth";
import { reportError } from "~/lib/errors";
import { runtimeEnv } from "~/lib/runtime";

/**
 * OAuth and OTP landing. SYSTEM_ARCHITECTURE.md §11.1.
 *
 * Exchanges the code for a session, provisions the product's own `users` row on
 * first sign-in, then returns the user to exactly where they were
 * (UX_FLOWS.md §17).
 *
 * The 18+ acknowledgement is carried across the OAuth round trip in a
 * short-lived, HTTP-only cookie. It cannot travel in the redirect URL: a query
 * parameter is trivially forged, and PRODUCT_SPEC.md §22.1 makes this a gate
 * rather than a formality. Without the cookie the account is created with
 * age_confirmed_18 = false, which leaves it read-only for every social surface
 * until confirmed — failing closed rather than assuming consent.
 */
export const prerender = false;

const AGE_COOKIE = "mb_age_ack";

export const GET: APIRoute = async ({ url, cookies, redirect, locals }) => {
  const env = runtimeEnv();
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error_description") ?? url.searchParams.get("error");

  if (oauthError) {
    return redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}&failed=1`, 302);
  }
  if (!code) {
    return redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`, 302);
  }

  const client = createAuthClient(cookies, env);
  if (!client) return redirect("/signin", 302);

  try {
    const { data, error } = await client.auth.exchangeCodeForSession(code);
    if (error || !data.user) throw new Error(error?.message ?? "no user in session");

    const ageAcknowledged = cookies.get(AGE_COOKIE)?.value === "1";
    cookies.delete(AGE_COOKIE, { path: "/" });

    const authUser = data.user;

    const { data: existing } = await client
      .from("users")
      .select("id, age_confirmed_18")
      .eq("id", authUser.id)
      .maybeSingle();

    if (!existing) {
      // First sign-in. Only the fields we actually need: no avatar URL, no
      // provider profile blob, no name we were not given
      // (PRIVACY_AND_COMPLIANCE.md §1 — minimisation is the primary control).
      const provider = authUser.app_metadata?.provider ?? "email_otp";
      const displayName =
        (authUser.user_metadata?.["name"] as string | undefined) ??
        (authUser.user_metadata?.["user_name"] as string | undefined) ??
        null;

      const { error: insertError } = await client.from("users").insert({
        id: authUser.id,
        email: authUser.email ?? null,
        email_verified_at: authUser.email_confirmed_at ?? null,
        auth_provider: provider,
        display_name: displayName?.slice(0, 80) ?? null,
        age_confirmed_18: ageAcknowledged,
      });
      if (insertError) throw new Error(insertError.message);

      // Both owned side tables, created empty. The eligibility profile exists
      // from the start so the "what this unlocks" prompts have somewhere to
      // write, and every field in it is optional by design
      // (PRODUCT_SPEC.md §12.1).
      await client.from("profiles").insert({ user_id: authUser.id });
      await client.from("eligibility_profiles").insert({ user_id: authUser.id });
      await client.from("user_notification_settings").insert({ user_id: authUser.id });
    } else if (ageAcknowledged && !(existing as { age_confirmed_18: boolean }).age_confirmed_18) {
      // Confirmed on a later sign-in. Only ever set true from an explicit
      // acknowledgement; never inferred, and never cleared here.
      await client.from("users").update({ age_confirmed_18: true }).eq("id", authUser.id);
    }

    await client.from("users").update({ last_seen_at: new Date().toISOString() }).eq("id", authUser.id);

    return redirect(returnTo, 302);
  } catch (err) {
    await reportError(err, { route: "/auth/callback" }, env);
    return redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}&failed=1`, 302);
  }
};
