import type { APIRoute } from "astro";

import { createAuthClient, safeReturnTo } from "~/lib/auth";
import { runtimeEnv } from "~/lib/runtime";

/**
 * Sign out. SECURITY.md §1 requires session invalidation to be available, and
 * "sign out everywhere" alongside it.
 *
 * POST only. A GET would let any page on the internet sign a user out by
 * embedding an image, which is a petty but real CSRF.
 */
export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, redirect, locals }) => {
  const env = runtimeEnv();
  const client = createAuthClient(cookies, env);

  if (client) {
    const form = await request.formData().catch(() => null);
    // "Everywhere" revokes refresh tokens on every device, which is what someone
    // reaching for this after losing a phone actually needs.
    const scope = form?.get("scope") === "global" ? "global" : "local";
    await client.auth.signOut({ scope });
  }

  return redirect(safeReturnTo(new URL(request.url).searchParams.get("returnTo")), 302);
};
