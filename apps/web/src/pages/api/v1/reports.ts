import type { APIRoute } from "astro";
import { z } from "zod";

import { getClient } from "~/lib/db";
import { reportError } from "~/lib/errors";

/**
 * POST /api/v1/reports — API_SPEC.md §3 (eligibility/flag) and §15, plus
 * MODERATION_AND_TRUST.md §5.
 *
 * Logged-out reporting is deliberately allowed on opportunities: most people who
 * spot a dead link or a scam will not have an account, and we want that signal.
 * Rate-limited at 5/day per fingerprint, with Turnstile above that.
 *
 * The auto-dispute behaviour lives in a database trigger, not here, so a scam
 * report de-ranks the listing before any human sees it and no future write path
 * can forget to do it (MODERATION_AND_TRUST.md §2.2).
 */
export const prerender = false;

const REASONS = [
  "expired", "wrong_deadline", "wrong_eligibility", "broken_link",
  "possible_scam", "requires_payment", "duplicate", "incorrect_info",
  "spam", "harassment", "impersonation", "inappropriate", "other",
] as const;

const BodySchema = z
  .object({
    subject_type: z.enum([
      "opportunity", "project", "profile", "team", "message", "organisation",
    ]),
    subject_id: z.string().uuid(),
    reason: z.enum(REASONS),
    detail: z.string().max(1000).optional(),
    turnstile_token: z.string().max(2048).optional(),
  })
  .strict();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
  });

const fail = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

/**
 * A coarse, rotating identifier for rate limiting a logged-out reporter.
 *
 * NOT an IP. SECURITY.md §9 and PRIVACY_AND_COMPLIANCE.md §1 keep IPs hashed and
 * short-lived where they are needed at all; ANALYTICS.md §3 forbids storing them
 * outright in analytics. Hashing the IP with a daily salt gives us a per-day
 * bucket that cannot be reversed to an address and expires on its own.
 */
async function dailyFingerprint(request: Request): Promise<string> {
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${ip}|${day}|reports`),
  );
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cloudflare Turnstile. Verified only when configured; absence degrades, never blocks. */
async function turnstileOk(token: string | undefined, secret: string | undefined, ip: string) {
  if (!secret) return true;
  if (!token) return false;
  try {
    const body = new FormData();
    body.append("secret", secret);
    body.append("response", token);
    if (ip !== "unknown") body.append("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const out = (await res.json()) as { success?: boolean };
    return out.success === true;
  } catch {
    // Fail OPEN for availability here. A report is a signal we want; losing one
    // to a Turnstile outage is worse than accepting one unverified, and the
    // rate limit still applies. Contrast SECURITY.md §4, where link checking
    // fails CLOSED because the cost of being wrong is someone's money.
    return true;
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, string> } }).runtime?.env ?? {};

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail(400, "VALIDATION_FAILED", "Body must be valid JSON.");
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail(400, "VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Invalid report.");
  }

  const client = getClient(env);
  if (!client) {
    return fail(503, "DEGRADED", "We can't record reports right now. Please try again shortly.");
  }

  const fingerprint = await dailyFingerprint(request);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";

  try {
    // API_SPEC.md §15: 5/day/IP anonymous.
    const { data: allowed, error: rateError } = await client.rpc("check_rate_limit", {
      p_key: `report:${fingerprint}`,
      p_limit: 5,
      p_window: "24 hours",
    });

    if (!rateError && allowed === false) {
      return new Response(
        JSON.stringify({
          error: {
            code: "RATE_LIMITED",
            message: "You've sent a lot of reports today. Try again tomorrow.",
          },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "3600" },
        },
      );
    }

    if (!(await turnstileOk(parsed.data.turnstile_token, env["TURNSTILE_SECRET_KEY"], ip))) {
      return fail(400, "VALIDATION_FAILED", "We couldn't verify that you're human. Please retry.");
    }

    const { error } = await client.from("reports").insert({
      subject_type: parsed.data.subject_type,
      subject_id: parsed.data.subject_id,
      reason: parsed.data.reason,
      detail: parsed.data.detail ?? null,
      reporter_fingerprint: fingerprint,
    });

    if (error) throw new Error(error.message);

    // MODERATION_AND_TRUST.md §5: "Reporters are always told the outcome. A
    // report that vanishes teaches people not to report." Phase 1 can only
    // acknowledge receipt; the outcome notification arrives with notifications
    // in Phase 2.
    return json({
      data: {
        received: true,
        message:
          "Thank you — this is now in our review queue. Scam and payment reports are looked at within 12 hours.",
      },
    });
  } catch (err) {
    await reportError(err, { route: "/api/v1/reports" }, env);
    return fail(503, "DEGRADED", "We couldn't record that report. Please try again shortly.");
  }
};
