/**
 * The Content-Security-Policy must stay enforceable. SECURITY.md §5.
 *
 * public/_headers sets `script-src 'self'` with no `unsafe-inline` and no nonce, because a
 * statically generated page cannot carry a per-response nonce. That policy is only worth
 * anything if nothing the build produces needs to be inlined — and Astro's DEFAULT is to
 * inline a small, import-free page `<script>` straight into the HTML.
 *
 * That combination fails in exactly one place: production. The script runs in dev, renders
 * in review, and is blocked for every real user with no error anyone sees. The character
 * counter on the request composer and the poller on a thread are both such scripts, so this
 * test reads the BUILD OUTPUT rather than the config: the manifest's inlinedScripts list
 * must be empty and every page script must exist as its own file.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "dist");
const HEADERS = resolve(HERE, "..", "public", "_headers");

/** Every file in the server build, concatenated — the manifest lives in one of them. */
function serverBundleText(): string {
  const chunks = join(DIST, "server", "chunks");
  if (!existsSync(chunks)) return "";
  return readdirSync(chunks)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => readFileSync(join(chunks, f), "utf8"))
    .join("\n");
}

describe("CSP stays enforceable", () => {
  const headers = readFileSync(HEADERS, "utf8");

  it("the policy allows no inline script and no third-party origin", () => {
    const csp = headers
      .split("\n")
      .find((l) => l.includes("Content-Security-Policy"))!;
    expect(csp).toBeDefined();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    // Invariant 12: no third-party script origin is permitted, so there is nothing to
    // allowlist beyond 'self'.
    expect(csp).not.toMatch(/script-src[^;]*https?:\/\//);
  });

  it("the build inlines no script into the HTML", () => {
    const text = serverBundleText();
    expect(text.length, "no server build found — run the build before this test").toBeGreaterThan(
      1000,
    );

    // Astro serialises the map into the manifest. Non-empty means at least one page's
    // <script> was inlined, and the CSP above would block it.
    const matches = [...text.matchAll(/inlinedScripts"\s*:\s*\[(.*?)\]/gs)];
    expect(matches.length, "manifest has no inlinedScripts field — the shape changed").toBeGreaterThan(
      0,
    );
    for (const [, body] of matches) {
      expect(body!.trim(), `a page script was inlined: ${body!.slice(0, 200)}`).toBe("");
    }
  });

  it("every page script is built as its own file instead", () => {
    // The other half of the same claim: not inlined AND not silently dropped.
    const assetDir = join(DIST, "client", "_a");
    expect(existsSync(assetDir), "no client asset directory in the build").toBe(true);
    const scripts = readdirSync(assetDir).filter((f) => /astro_type_script.*\.js$/.test(f));
    expect(
      scripts.length,
      "no page-script chunks in the build: the request composer's counter and the thread poller should each be one",
    ).toBeGreaterThanOrEqual(2);
  });

  it("no built page carries an inline script tag with a body", () => {
    // Prerendered pages are the ones whose HTML exists at build time, so they can be
    // checked directly rather than through the manifest.
    const clientDir = join(DIST, "client");
    if (!existsSync(clientDir)) return;
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".html") ? [join(dir, e.name)] : [],
      );
    const pages = walk(clientDir);
    expect(pages.length, "no prerendered pages found to check").toBeGreaterThan(0);
    for (const page of pages) {
      const html = readFileSync(page, "utf8");
      const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter(
        ([, body]) => body!.trim() !== "",
      );
      expect(inline.map((m) => m[1]!.slice(0, 120)), `${page} carries an inline script`).toEqual([]);
    }
  });
});
