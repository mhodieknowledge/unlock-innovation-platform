/**
 * SECURITY.md §5's headers, on the responses that actually carry them.
 *
 * The bug this file exists for: `public/_headers` had the whole set, csp.test.ts read that file and
 * passed, and every server-rendered page shipped without a single one of them. Cloudflare's asset
 * handler applies `_headers` to the files it serves; a response the Worker builds never passes
 * through it. The board, every opportunity page, every country page and the whole authenticated
 * surface are Worker responses.
 *
 * So there are three assertions here, and each covers a different failure:
 *
 *   The middleware exists and sets them — proved by rendering a route and reading the response.
 *   `_headers` still sets them, for the assets the middleware never sees.
 *   The two say the SAME thing, which is what keeps one definition from becoming two.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SECURITY_HEADERS, SIGNIN_FORM_TARGETS, signInFormAction } from "@mbele/config";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HEADERS_FILE = readFileSync(resolve(HERE, "..", "public", "_headers"), "utf8");

/** The `/*` block of a Cloudflare `_headers` file, as a map. */
function parseGlobalBlock(file: string): Record<string, string> {
  const lines = file.split("\n");
  const start = lines.findIndex((line) => line.trim() === "/*");
  expect(start, "no /* block in public/_headers").toBeGreaterThan(-1);

  const out: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break; // the block ends at the first unindented line
    const [name, ...rest] = line.trim().split(":");
    out[name!.trim()] = rest.join(":").trim();
  }
  return out;
}

describe("the header set is defined once", () => {
  it("covers everything SECURITY.md §5 names", () => {
    for (const name of [
      "Content-Security-Policy",
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Cross-Origin-Opener-Policy",
    ]) {
      expect(SECURITY_HEADERS[name], `${name} is missing from the shared set`).toBeTruthy();
    }
  });

  it("carries no unsafe-inline and no third-party origin", () => {
    const csp = SECURITY_HEADERS["Content-Security-Policy"]!;
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(csp).not.toMatch(/https?:\/\//);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("and public/_headers says exactly the same thing", () => {
    // Drift here would mean a static asset and a rendered page enforcing different policies, with
    // nothing to say which was intended.
    const fromFile = parseGlobalBlock(HEADERS_FILE);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(fromFile[name], `public/_headers is missing ${name}`).toBeDefined();
      expect(fromFile[name], `${name} differs between _headers and @mbele/config`).toBe(value);
    }
  });
});

describe("the middleware applies them to server-rendered responses", () => {
  it("sets every header on a response it did not already carry", async () => {
    const { onRequest } = await import("../src/middleware");

    const response = await (onRequest as (c: unknown, n: () => Promise<Response>) => Promise<Response>)(
      {
        url: new URL("https://example.invalid/opportunities"),
        request: new Request("https://example.invalid/opportunities"),
      },
      async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    );

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name), `${name} missing from an SSR response`).toBe(value);
    }
  });

  it("leaves a header a route set deliberately", async () => {
    const { onRequest } = await import("../src/middleware");

    // The opportunity page sets its own Cache-Control and Vary. Middleware that overwrote those
    // would silently un-cache the most-visited page in the product.
    const response = await (onRequest as (c: unknown, n: () => Promise<Response>) => Promise<Response>)(
      {
        url: new URL("https://example.invalid/"),
        request: new Request("https://example.invalid/"),
      },
      async () =>
        new Response("<html></html>", {
          headers: {
            "cache-control": "public, s-maxage=900",
            "content-security-policy": "default-src 'none'",
          },
        }),
    );

    expect(response.headers.get("cache-control")).toBe("public, s-maxage=900");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
    // The others are still applied.
    expect(response.headers.get("Referrer-Policy")).toBe(SECURITY_HEADERS["Referrer-Policy"]);
  });
});

/**
 * The sign-in exception.
 *
 * `form-action` governs the whole redirect chain of a form submission, not just its action URL.
 * Signing in posts to `/signin`, which redirects to Supabase, which redirects to GitHub or
 * Google — so under `form-action 'self'` Chrome refuses the submission, silently: no navigation,
 * no error page, nothing for the person to see. The button simply does nothing, which is exactly
 * how this reached production and exactly how it was reported.
 *
 * Driven in a real Chromium against three local origins standing in for the site, Supabase and
 * the provider, the result was unambiguous and is the reason the list has three entries rather
 * than one:
 *
 *   form-action 'self'                    -> refused, never left the page
 *   form-action 'self' <supabase>         -> refused, never left the page
 *   form-action 'self' <supabase> <gh>    -> reached the provider
 */
describe("the sign-in page's form-action", () => {
  const SUPABASE = "https://qipbiwosljldvvaloolf.supabase.co";
  const csp = (headers: Record<string, string>) => headers["Content-Security-Policy"]!;
  const directive = (headers: Record<string, string>) =>
    csp(headers)
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("form-action"))!;

  it("allows every origin in the chain, because one is not enough", () => {
    const relaxed = signInFormAction(`${SUPABASE}/`);
    expect(directive(relaxed)).toBe(
      `form-action 'self' ${SUPABASE} https://github.com https://accounts.google.com`,
    );
  });

  it("changes nothing else about the policy", () => {
    const relaxed = signInFormAction(SUPABASE);
    const strictParts = csp(SECURITY_HEADERS).split(";").map((p) => p.trim());
    const relaxedParts = csp(relaxed).split(";").map((p) => p.trim());
    expect(relaxedParts.length).toBe(strictParts.length);
    for (let i = 0; i < strictParts.length; i += 1) {
      if (strictParts[i]!.startsWith("form-action")) continue;
      expect(relaxedParts[i]).toBe(strictParts[i]);
    }
    // And every other header — HSTS, nosniff, Referrer-Policy, Permissions-Policy, COOP — is the
    // same object it always was.
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (name === "Content-Security-Policy") continue;
      expect(relaxed[name]).toBe(value);
    }
  });

  it("widens the policy for the auth origins only, never for an arbitrary one", () => {
    const relaxed = signInFormAction(SUPABASE);
    expect(SIGNIN_FORM_TARGETS).toEqual(["https://github.com", "https://accounts.google.com"]);
    // The wildcard that would make the directive pointless, and the scheme-only source that is
    // the same thing spelled differently. Both have to be matched as whole SOURCES: `https:` as a
    // substring also matches every legitimate origin in the list, which would make this pass while
    // checking nothing.
    const sources = directive(relaxed).split(/\s+/).slice(1);
    expect(sources).not.toContain("*");
    expect(sources).not.toContain("https:");
    expect(sources).not.toContain("http:");
    expect(sources.some((source) => source.startsWith("*."))).toBe(false);
    expect(sources).toContain(SUPABASE);
  });

  it("returns the strict set unchanged when there is no project URL to trust", () => {
    // Nothing configured means sign-in cannot work anyway, and a policy should not be widened on
    // the strength of a value that is absent.
    expect(signInFormAction(undefined)).toEqual(SECURITY_HEADERS);
    expect(signInFormAction("")).toEqual(SECURITY_HEADERS);
    expect(signInFormAction("not a url")).toEqual(SECURITY_HEADERS);
  });

  it("is the sign-in page's alone — every other route keeps form-action 'self'", async () => {
    const { onRequest } = await import("../src/middleware");

    const run = async (path: string) => {
      const response = await (onRequest as (c: unknown, n: () => Promise<Response>) => Promise<Response>)(
        { url: new URL(`https://example.invalid${path}`) },
        async () => new Response("ok"),
      );
      return response.headers.get("content-security-policy") ?? "";
    };

    // `/signin` itself resolves its origin from the runtime env, which is empty in a test, so the
    // assertion that matters here is the one about every OTHER route.
    expect(await run("/")).toContain("form-action 'self';");
    expect(await run("/opportunities")).toContain("form-action 'self';");
    expect(await run("/you/account")).toContain("form-action 'self';");
    // A near-miss must not inherit the exception.
    expect(await run("/signin-else")).toContain("form-action 'self';");
  });
});
