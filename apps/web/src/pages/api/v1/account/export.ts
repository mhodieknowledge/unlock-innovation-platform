import type { APIRoute } from "astro";

import { createAuthClient, getSessionUser } from "~/lib/auth";
import { reportError } from "~/lib/errors";
import { runtimeEnv } from "~/lib/runtime";

/**
 * GET /api/v1/account/export — PRIVACY_AND_COMPLIANCE.md §5, `[PR]`.
 *
 * "JSON of everything held", self-serve, no support ticket. The assembly happens
 * in export_my_account(), which reads auth.uid() and therefore cannot be pointed
 * at another account — there is no user id in this request to get wrong.
 *
 * A download rather than an email: §5 allows either, and a download needs no
 * budget from the 280/day and no trust that the mail arrives.
 */
export const prerender = false;

export const GET: APIRoute = async ({ cookies, locals, redirect }) => {
  const env = runtimeEnv();
  const user = await getSessionUser(cookies, env);
  if (!user) return redirect(`/signin?returnTo=${encodeURIComponent("/you/account")}`, 302);

  const client = createAuthClient(cookies, env);
  if (!client) {
    return new Response(
      JSON.stringify({ error: "unavailable", message: "Export is briefly unavailable. Nothing is lost — try again shortly." }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  try {
    const { data, error } = await client.rpc("export_my_account");
    if (error) throw new Error(error.message);

    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="account-export-${stamp}.json"`,
        // Never cached anywhere: this is the most complete personal record the
        // product can produce.
        "cache-control": "no-store, private",
      },
    });
  } catch (err) {
    await reportError(err, { route: "/api/v1/account/export" }, env);
    return new Response(
      JSON.stringify({ error: "failed", message: "We couldn't build your export. Nothing was changed." }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
};
