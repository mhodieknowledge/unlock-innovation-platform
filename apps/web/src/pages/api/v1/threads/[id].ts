import type { APIRoute } from "astro";

import { createAuthClient, getSessionUser } from "~/lib/auth";
import { reportError } from "~/lib/errors";
import { getThreadHeader, getThreadMessages } from "~/lib/rooms";

/**
 * GET /api/v1/threads/:id — the messages in one thread, for polling.
 *
 * COLLABORATION_SYSTEM.md §3.2: "No realtime. Polling with If-Modified-Since on thread
 * open and every 30 seconds while the thread is focused." So this endpoint's most
 * important behaviour is the 304: a focused thread with nothing new must cost a few
 * hundred bytes of headers, not a JSON body. On a metered connection an open tab that
 * re-downloads a conversation every 30 seconds is a real cost to a real person.
 *
 * Authorisation is RLS plus thread_view()'s participant check — this route holds no
 * database-wide key, and a non-participant gets 404 rather than 403, because "this thread
 * exists but is not yours" is itself information.
 */
export const prerender = false;

export const GET: APIRoute = async ({ params, request, cookies, locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, string> } }).runtime?.env ?? {};
  const threadId = params["id"];

  const headers = {
    "content-type": "application/json; charset=utf-8",
    // API_SPEC.md §1.4: authenticated endpoints are never cached by anything shared.
    "cache-control": "private, no-store",
  };

  if (!threadId) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers });

  const user = await getSessionUser(cookies, env);
  if (!user) return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401, headers });

  const client = createAuthClient(cookies, env);
  if (!client) {
    return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers });
  }

  try {
    const header = await getThreadHeader(client, threadId);
    if (!header) {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers });
    }

    const messages = await getThreadMessages(client, threadId);
    const newest = messages.length > 0 ? messages[messages.length - 1]!.created_at : null;
    // Second precision, because that is all an HTTP date carries — rounding UP would make
    // a message written in the same second invisible until the next one arrives.
    const lastModified = newest ? new Date(newest) : null;

    if (lastModified) {
      const since = request.headers.get("if-modified-since");
      if (since) {
        const sinceMs = Date.parse(since);
        if (!Number.isNaN(sinceMs) && Math.floor(lastModified.getTime() / 1000) * 1000 <= sinceMs) {
          return new Response(null, {
            status: 304,
            headers: { ...headers, "last-modified": lastModified.toUTCString() },
          });
        }
      }
    }

    return new Response(
      JSON.stringify({
        state: header.state,
        handoff_state: header.handoff_state,
        messages: messages.map((m) => ({
          id: m.id,
          mine: m.sender_user_id === user.id,
          body: m.body,
          created_at: m.created_at,
        })),
      }),
      {
        status: 200,
        headers: lastModified
          ? { ...headers, "last-modified": lastModified.toUTCString() }
          : headers,
      },
    );
  } catch (err) {
    await reportError(err, { route: "/api/v1/threads/[id]" }, env);
    return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers });
  }
};
