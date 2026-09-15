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

import { SECURITY_HEADERS } from "@mbele/config";
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
      { request: new Request("https://example.invalid/opportunities") },
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
      { request: new Request("https://example.invalid/") },
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
