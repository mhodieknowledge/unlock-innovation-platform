/**
 * Error reporting. SYSTEM_ARCHITECTURE.md §16: Sentry, PII scrubbing on,
 * alert on new issue types only.
 *
 * This is a hand-rolled envelope sender rather than the Sentry SDK, for two
 * reasons: the SDK is a large dependency for what amounts to one POST, and it
 * must never reach the client — invariant 12 forbids third-party scripts on
 * public pages, and the byte budgets would not survive one anyway. Everything
 * here runs server-side only.
 *
 * No-ops without SENTRY_DSN, so local and preview environments stay quiet.
 */

interface ReportContext {
  route?: string;
  tags?: Record<string, string>;
}

/**
 * SECURITY.md §9: logs scrub emails, tokens and IPs; Sentry runs with
 * sendDefaultPii false. Scrubbing happens here, before anything leaves the
 * process, rather than relying on a provider-side setting we cannot verify.
 */
const SCRUB: readonly [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]"],
  [/\b(?:sk|gsk|csk|xkeysib|cfut)[-_][A-Za-z0-9-]{8,}/gi, "[key]"],
  [/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip]"],
  [/postgres(?:ql)?:\/\/[^\s"']+/gi, "[dsn]"],
];

export function scrub(text: string): string {
  return SCRUB.reduce((acc, [rx, replacement]) => acc.replace(rx, replacement), text);
}

function parseDsn(dsn: string) {
  // https://<key>@<host>/<projectId>
  const m = /^https:\/\/([^@]+)@([^/]+)\/(.+)$/.exec(dsn);
  if (!m) return null;
  const [, key, host, projectId] = m;
  return { key, host, projectId, url: `https://${host}/api/${projectId}/envelope/` };
}

export async function reportError(
  error: unknown,
  context: ReportContext = {},
  /**
   * The two keys this function reads, rather than `Record<string, string | undefined>`.
   * The wide record looked harmless and was the one thing standing between callers and
   * passing the app's real environment (lib/runtime.ts), which also carries bindings and so
   * is not a record of strings. A parameter should ask for what it uses.
   */
  env: { SENTRY_DSN?: string; ENVIRONMENT?: string } = {},
): Promise<void> {
  const dsn = env["SENTRY_DSN"] ?? process.env["SENTRY_DSN"];
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  // Always log locally, scrubbed, whether or not Sentry is configured.
  console.error(scrub(message), context.route ? `(${context.route})` : "");

  const parsed = dsn ? parseDsn(dsn) : null;
  if (!parsed) return;

  const event = {
    event_id: crypto.randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "error",
    environment: env["ENVIRONMENT"] ?? "production",
    transaction: context.route,
    tags: context.tags,
    exception: {
      values: [
        {
          type: error instanceof Error ? error.name : "Error",
          value: scrub(message),
          stacktrace: stack ? { frames: [{ filename: scrub(stack).slice(0, 2000) }] } : undefined,
        },
      ],
    },
  };

  const body =
    JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() }) +
    "\n" +
    JSON.stringify({ type: "event" }) +
    "\n" +
    JSON.stringify(event);

  try {
    await fetch(parsed.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${parsed.key}, sentry_client=mbele/1.0`,
      },
      body,
    });
  } catch {
    // Error reporting must never itself become an error path.
  }
}
