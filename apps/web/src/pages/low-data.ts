import type { APIRoute } from "astro";

import { safeReturnTo } from "~/lib/auth";
import { setLowDataCookie } from "~/lib/lowdata";
import { runtimeEnv } from "~/lib/runtime";

/**
 * The low-data toggle. DESIGN_SYSTEM.md §10, SYSTEM_ARCHITECTURE.md §3.4.
 *
 * A POST from a plain form in the footer, because the people this mode is for are exactly
 * the people who cannot afford the script a JavaScript toggle would need. It sets the cookie
 * and redirects back to where they were, so the very next paint is the light one.
 *
 * Signed in? The account preference is updated too, so the choice follows them to another
 * device. Not signed in? The cookie is the whole mechanism, and it lasts a year.
 */
export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, redirect, locals }) => {
  const env = runtimeEnv();

  const form = await request.formData().catch(() => null);
  const on = String(form?.get("on") ?? "1") === "1";
  const back = safeReturnTo(String(form?.get("returnTo") ?? "/"));

  setLowDataCookie(cookies, on);

  // Best effort, and deliberately not awaited for its result: the cookie is what makes the
  // next paint light, and a database hiccup must not cost the reader the thing they asked
  // for. The import is dynamic so a signed-out toggle does no auth work at all.
  try {
    const { createAuthClient, getSessionUser } = await import("~/lib/auth");
    const user = await getSessionUser(cookies, env);
    if (user) {
      const client = createAuthClient(cookies, env);
      await client?.from("users").update({ low_data_mode: on }).eq("id", user.id);
    }
  } catch {
    // The cookie is set either way.
  }

  return redirect(back, 303);
};
