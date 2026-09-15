import type { APIRoute } from "astro";

import { createAuthClient, getSessionUser } from "~/lib/auth";
import { getTracker } from "~/lib/db";
import { reportError } from "~/lib/errors";
import { runtimeEnv } from "~/lib/runtime";

/**
 * GET /api/v1/tracker/export?format=json|csv — API_SPEC.md §5, marked `[PR]`.
 *
 * PRODUCT_SPEC.md §22.5 and PRIVACY_AND_COMPLIANCE.md §5 make export a right,
 * self-serve, with no support ticket: portability covers the tracker, projects
 * and profile. This is the tracker half.
 *
 * Includes the private note. It is the user's own data and they are asking for
 * it — the rule that nobody else ever reads it (MODERATION_AND_TRUST.md §10) is
 * about other people, not about its owner.
 */
export const prerender = false;

function toCsv(rows: Record<string, string | number | null>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const escape = (v: string | number | null) => {
    const s = v === null || v === undefined ? "" : String(v);
    // Quote when the value could otherwise break the row, and double any quote.
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((h) => escape(row[h] ?? null)).join(",")),
  ].join("\r\n");
}

export const GET: APIRoute = async ({ url, cookies, locals, redirect }) => {
  const env = runtimeEnv();
  const user = await getSessionUser(cookies, env);
  if (!user) return redirect(`/signin?returnTo=${encodeURIComponent("/tracker")}`, 302);

  const client = createAuthClient(cookies, env);
  if (!client) {
    return new Response(
      JSON.stringify({ error: { code: "DEGRADED", message: "Export is unavailable right now." } }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  try {
    const result = await getTracker(client);
    if (!result.ok) throw new Error("tracker read failed");

    const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
    const stamp = new Date().toISOString().slice(0, 10);

    const flat = result.data.map((e) => ({
      state: e.state,
      title: e.opportunities?.title ?? "",
      slug: e.opportunities?.slug ?? "",
      organisation: e.opportunities?.organisations?.name ?? "",
      deadline: e.opportunities?.deadline_at ?? "",
      deadline_as_stated: e.opportunities?.deadline_raw ?? "",
      official_url: e.opportunities?.official_url ?? e.opportunities?.source_url ?? "",
      applied_at: e.applied_at ?? "",
      note: e.note ?? "",
      last_updated: e.updated_at,
    }));

    if (format === "csv") {
      return new Response(toCsv(flat), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="tracker-${stamp}.csv"`,
          "cache-control": "private, no-store",
        },
      });
    }

    return new Response(
      JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          // Stated in the export itself, so the file is self-explanatory a year
          // from now without needing the site.
          note: "Your tracker. Deadlines are UTC; deadline_as_stated is the source's own wording where it was less precise than a timestamp.",
          entries: flat,
        },
        null,
        2,
      ),
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="tracker-${stamp}.json"`,
          "cache-control": "private, no-store",
        },
      },
    );
  } catch (err) {
    await reportError(err, { route: "/api/v1/tracker/export" }, env);
    return new Response(
      JSON.stringify({ error: { code: "DEGRADED", message: "We couldn't build your export." } }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
};
