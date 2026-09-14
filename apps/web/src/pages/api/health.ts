import type { APIRoute } from "astro";

/**
 * Liveness endpoint. SYSTEM_ARCHITECTURE.md §16 has UptimeRobot polling `/` and
 * `/api/health` every 5 minutes.
 *
 * Deliberately says almost nothing. The rich operational view — source health,
 * quota consumption, queue depth, database size — is `/api/v1/admin/health`
 * behind a role gate (API_SPEC.md §12). Exposing any of it here would hand an
 * attacker a free reconnaissance endpoint.
 */
export const prerender = false;

export const GET: APIRoute = () =>
  new Response(
    JSON.stringify({
      data: { status: "ok", time: new Date().toISOString() },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        // API_SPEC.md §1.4: never cached.
        "cache-control": "private, no-store",
      },
    },
  );
