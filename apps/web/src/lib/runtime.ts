/**
 * The Worker's environment — vars, secrets and bindings — read in exactly one place.
 *
 * WHY THIS MODULE EXISTS, because the reason is a production outage and not a preference:
 *
 * Until Astro 6 the way to reach a Cloudflare binding from a page was
 * `Astro.locals.runtime.env`, and sixty routes in this app did that. Astro 6 removed it and
 * left a getter behind that THROWS:
 *
 *     Error: Astro.locals.runtime.env has been removed in Astro v6.
 *     Use 'import { env } from "cloudflare:workers"' instead.
 *
 * Every one of those routes was written as `locals.runtime?.env ?? {}`, which reads as
 * defensive and is not: the optional chain guards `runtime` being absent, and `runtime` is
 * present in production. So the throw fired on every database-backed page of the first live
 * deployment — a 500 on the board, on every country, on every sitemap — while
 * `/api/health`, the one route that reads no env, answered 200 and the deploy called itself
 * green.
 *
 * Nothing in the test suite could have caught it. The container API renders pages in Node,
 * where `locals.runtime` is genuinely undefined, so the optional chain short-circuits before
 * it ever reaches the getter: the tests exercised a code path that does not exist in
 * production. The gate that catches this class of bug is the deploy's own smoke test asking
 * a real page for real HTML (.github/workflows/deploy.yml), and
 * apps/web/test/runtime-env.test.ts bans the removed accessor from returning.
 *
 * So: one import of `cloudflare:workers`, one exported accessor, one type naming every var,
 * secret and binding this app reads. A new key is declared here or it does not exist.
 */

import { env } from "cloudflare:workers";

/**
 * Every var, secret and binding the request tier reads.
 *
 * Each one is OPTIONAL, and that is a design rule rather than a convenience: SECURITY.md and
 * AI_SYSTEM.md both require the absent case to be a supported state, so an unconfigured key
 * degrades the feature that needs it instead of failing the page. `getClient` returning null
 * for a missing SUPABASE_URL is the same idea one layer down.
 */
export interface RuntimeEnv {
  // ── Data ──────────────────────────────────────────────────────────────────
  /** Supabase project URL. Without it every read degrades to an empty state. */
  SUPABASE_URL?: string;
  /**
   * The anon key. Not a secret: it ships to browsers by design and RLS is the boundary
   * (SECURITY.md §2). The service-role key is never here — it exists only in the batch tier.
   */
  SUPABASE_ANON_KEY?: string;

  // ── Deployment identity ───────────────────────────────────────────────────
  BRAND_NAME?: string;
  ENVIRONMENT?: string;

  // ── Operations ────────────────────────────────────────────────────────────
  /** Sentry. Absent means errors are logged, scrubbed, and not sent anywhere. */
  SENTRY_DSN?: string;
  /**
   * The pepper for rate-limit keys. SECURITY.md §9 forbids storing an IP, so the key is a
   * salted hash; without the salt the rate limiter falls back to a coarser key.
   */
  IP_HASH_SALT?: string;
  /** Cloudflare Turnstile server key, for the unauthenticated forms. */
  TURNSTILE_SECRET_KEY?: string;

  // ── Telegram bot ──────────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_HANDLE?: string;
  TELEGRAM_BOT_SECRET?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;

  // ── AI ────────────────────────────────────────────────────────────────────
  /** The one LLM call allowed in a request handler, and only because it is cached. */
  GROQ_API_KEY?: string;
  /** AI_SYSTEM.md §2 guardrail 6: model names are configuration, never code. */
  QUERY_COMPILER_MODEL?: string;
  QUERY_EMBEDDING_MODEL?: string;
  PROJECT_EMBEDDING_MODEL?: string;
  /** Workers AI, for query and project embeddings. */
  AI?: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };
  /** KV, for the query-compilation and query-embedding caches. */
  QUERY_CACHE?: {
    get: (key: string, type?: "text" | "json") => Promise<unknown>;
    put: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>;
  };
}

/**
 * The environment for this request.
 *
 * `env` from `cloudflare:workers` is a proxy over the Worker's bindings, so reading a key
 * that was never configured gives undefined rather than throwing — which is what every
 * `?? null` and `if (!key) return` downstream is written against.
 *
 * Outside the Workers runtime — vitest, `astro check`, a prerender pass — there are no
 * bindings to proxy and this is an empty object. That is the honest answer there: a test
 * that needs a value passes it in explicitly.
 */
export function runtimeEnv(): RuntimeEnv {
  return (env ?? {}) as unknown as RuntimeEnv;
}
