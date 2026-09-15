/**
 * How the request tier reaches its configuration.
 *
 * This file exists because of a live deployment that answered 500 on every page that reads the
 * database while its own smoke test reported green. The cause was one expression, repeated in
 * sixty-four places:
 *
 *     const env = (Astro.locals as { runtime?: { env?: Record<string, string> } }).runtime?.env ?? {};
 *
 * Astro 6 removed `Astro.locals.runtime.env` and left a getter that throws. The optional chain
 * guards `runtime` being missing, which it never is in production, so the throw fired on every
 * request. And no test could see it: the container API renders pages in Node, where
 * `locals.runtime` genuinely is undefined and the chain short-circuits before reaching the
 * getter. Every assertion in the suite passed against a code path that does not exist in
 * production.
 *
 * So these are checks that do not need a Workers runtime to be true:
 *
 *   - the removed accessor is gone and stays gone, everywhere;
 *   - one module owns the answer, and every route asks it;
 *   - what that module declares matches what the app actually reads;
 *   - what the deploy binds includes what the app cannot work without.
 *
 * The check that the pages themselves render is the deploy's smoke test, which now asks the
 * board for its own copy rather than asking the one endpoint that reads no configuration.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runtimeEnv, type RuntimeEnv } from "../src/lib/runtime";

const SRC = new URL("../src/", import.meta.url).pathname;
const RUNTIME_MODULE = join(SRC, "lib/runtime.ts");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sources = walk(SRC).filter((f) => /\.(astro|ts|svelte)$/.test(f));
const read = (f: string) => readFileSync(f, "utf8");

describe("the accessor Astro removed", () => {
  it("is not read anywhere", () => {
    // Anything that reaches for `.runtime` on locals is reaching for the throwing getter, or
    // one property away from it. There is no safe form of this, which is why the ban is on the
    // shape rather than on the exact line the outage was written as.
    const offenders = sources
      // lib/runtime.ts is the one file allowed to name it: it is the replacement, and the test
      // below requires it to say what it replaced.
      .filter((f) => f !== RUNTIME_MODULE)
      .filter((f) => /locals\b[^\n]*\.?\bruntime\b/.test(read(f)));
    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([]);
  });

  it("is named in the module that replaced it, so the next reader learns why", () => {
    const text = read(RUNTIME_MODULE);
    expect(text).toContain("Astro.locals.runtime.env");
    expect(text).toContain("cloudflare:workers");
  });
});

describe("one module owns the environment", () => {
  const callers = sources.filter((f) => f !== RUNTIME_MODULE && /\bruntimeEnv\(/.test(read(f)));

  it("is asked by the routes that need configuration", () => {
    // A floor rather than an exact count: the point is that this is how the whole app reads its
    // environment, not that the number of routes is frozen.
    expect(callers.length).toBeGreaterThan(50);
  });

  it("is the only import path any of them uses", () => {
    const paths = new Set<string>();
    for (const file of callers) {
      const match = /import \{ runtimeEnv \} from "([^"]+)";/.exec(read(file));
      expect(match, `${file.slice(SRC.length)} calls runtimeEnv() without importing it`).toBeTruthy();
      paths.add(match![1]!);
    }
    expect([...paths]).toEqual(["~/lib/runtime"]);
  });

  it("answers with an object when there are no bindings, rather than throwing", () => {
    // Which is the case in this process, in `astro check`, and in a deploy with nothing
    // configured. Every consumer is written for it: SECURITY.md and AI_SYSTEM.md both require
    // the unconfigured case to degrade a feature rather than fail a page.
    expect(runtimeEnv()).toEqual({});
  });
});

describe("what the module declares and what the app reads", () => {
  /** `env.SOME_KEY` and `env["SOME_KEY"]`, across every route and library. */
  function keysReadFrom(text: string): string[] {
    const keys = new Set<string>();
    for (const m of text.matchAll(/\b(?:env|runtime)\.([A-Z][A-Z0-9_]{2,})\b/g)) keys.add(m[1]!);
    for (const m of text.matchAll(/\b(?:env|runtime)\["([A-Z][A-Z0-9_]{2,})"\]/g)) keys.add(m[1]!);
    return [...keys];
  }

  const declared = new Set(
    [...read(RUNTIME_MODULE).matchAll(/^  ([A-Z][A-Z0-9_]*)\?:/gm)].map((m) => m[1]!),
  );

  it("declares something", () => {
    // Guards the assertion below against a regex that quietly stops matching, which would make
    // the drift check pass by measuring nothing.
    expect(declared.size).toBeGreaterThan(10);
  });

  it("are the same set", () => {
    const undeclared = new Map<string, string>();
    for (const file of sources) {
      if (file === RUNTIME_MODULE) continue;
      for (const key of keysReadFrom(read(file))) {
        // `import.meta.env` keys are Vite's, not the Worker's.
        if (/import\.meta\.env\b[^\n]*\b/.test(read(file)) && key === "SITE") continue;
        if (!declared.has(key)) undeclared.set(key, file.slice(SRC.length));
      }
    }
    expect([...undeclared]).toEqual([]);
  });

  it("types the anon key as what it is, and never mentions the service key", () => {
    // SECURITY.md §2: the service-role key exists only in the batch tier. A declaration here
    // would be the first step towards it reaching a browser.
    const text = read(RUNTIME_MODULE);
    expect(text).toContain("SUPABASE_ANON_KEY");
    expect(text).not.toContain("SERVICE_ROLE");
    expect(text).not.toContain("SERVICE_KEY");
  });
});

describe("the deploy binds what the app cannot work without", () => {
  const workflow = readFileSync(
    new URL("../../../.github/workflows/deploy.yml", import.meta.url).pathname,
    "utf8",
  );

  it("passes the database configuration to the Worker, not only to the build", () => {
    // The outage in one line: `env:` on the Build step is the build's environment. What the
    // Worker gets is what `wrangler deploy` binds.
    const step = workflow.slice(workflow.indexOf("Configure the Worker's environment"));
    expect(step).toContain("SUPABASE_URL");
    expect(step).toContain("SUPABASE_ANON_KEY");
    expect(workflow).toMatch(/npx wrangler deploy[^\n]*\$VARS/);
  });

  it("refuses to deploy without it, rather than shipping a site of error states", () => {
    expect(workflow).toMatch(/if \[ -z "\$SUPABASE_URL" \] \|\| \[ -z "\$SUPABASE_ANON_KEY" \]; then/);
  });

  it("never passes a secret as a --var, because a Cloudflare var is stored in plaintext", () => {
    // A var is readable in the dashboard and through the account API; a secret is encrypted and
    // write-only. (`wrangler deploy` does mask a `--var` value in its own log — it prints
    // `env.SUPABASE_URL ("(hidden)")` — but what makes this list the wrong home for a secret is
    // where the value ends up living, not what the log shows.)
    const step = workflow.slice(
      workflow.indexOf("Configure the Worker's environment"),
      workflow.indexOf("- name: Deploy"),
    );
    for (const secret of [
      "GROQ_API_KEY",
      "IP_HASH_SALT",
      "TURNSTILE_SECRET_KEY",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_BOT_SECRET",
      "TELEGRAM_WEBHOOK_SECRET",
      "SENTRY_DSN",
      "SUPABASE_DB_URL",
      "SERVICE_ROLE",
    ]) {
      expect(step, `${secret} must not be bound as a printable var`).not.toContain(secret);
    }
  });

  it("smoke-tests a page that reads the database, not only /api/health", () => {
    const smoke = workflow.slice(workflow.indexOf("Smoke-test the deployment"));
    expect(smoke).toContain("load the board right now");
    expect(smoke).toContain("content-security-policy");
  });
});

describe("RuntimeEnv, as a type", () => {
  it("is what the data layer, the search and the error reporter all take", () => {
    // A compile-time assertion with a runtime body, so a change that breaks the shape fails
    // `astro check` and this file names why it mattered.
    const env: RuntimeEnv = { SUPABASE_URL: "https://example.invalid", ENVIRONMENT: "test" };
    const asDbEnv: { SUPABASE_URL?: string; SUPABASE_ANON_KEY?: string } = env;
    const asReportEnv: { SENTRY_DSN?: string; ENVIRONMENT?: string } = env;
    expect(asDbEnv.SUPABASE_URL).toBe("https://example.invalid");
    expect(asReportEnv.ENVIRONMENT).toBe("test");
  });
});
