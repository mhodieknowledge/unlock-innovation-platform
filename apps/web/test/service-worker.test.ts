/**
 * The service worker's routing rules, and the manifest that makes the product installable.
 * SYSTEM_ARCHITECTURE.md §3.4, PRODUCT_SPEC.md §25.3.
 *
 * Why this test exists: a service worker is the one piece of this product that cannot be
 * checked by reading a page. It runs in a different global, only over HTTPS, only after an
 * install, and when it is wrong it is wrong invisibly — a rule that catches an authenticated
 * page caches somebody's tracker onto a shared phone, and a rule that misses opportunity
 * pages means nothing works offline while everything looks fine.
 *
 * So public/sw-routes.js holds the rules as a plain script with no service-worker globals in
 * it, and this test loads that file and asserts the classification of three dozen real paths.
 * The worker itself imports the same file, so what is asserted here is what ships.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, "..", "public");
const ORIGIN = "https://mbele.example";

type Kind = "skip" | "shell" | "asset" | "page" | "user" | "navigate" | "write-queue";

/** Loads sw-routes.js into a bare object scope, the way importScripts does in the worker. */
function loadRoutes(): {
  classify: (href: string, origin: string, method?: string) => Kind;
  LIMITS: { pages: number };
} {
  const source = readFileSync(join(PUBLIC, "sw-routes.js"), "utf8");
  const scope: Record<string, unknown> = {};
  // The file is an IIFE taking `self`; `new Function` gives it one that is not this test's
  // global, so a stray assignment cannot leak into the runner.
  new Function("self", source)(scope);
  const routes = scope["MbeleRoutes"] as ReturnType<typeof loadRoutes> | undefined;
  if (!routes) throw new Error("sw-routes.js did not define self.MbeleRoutes");
  return routes;
}

const { classify, LIMITS } = loadRoutes();
const kindOf = (path: string, method = "GET"): Kind => classify(`${ORIGIN}${path}`, ORIGIN, method);

describe("service worker routing (SYSTEM_ARCHITECTURE.md §3.4)", () => {
  it("caches the shell and the content-hashed assets", () => {
    expect(kindOf("/offline")).toBe("shell");
    expect(kindOf("/manifest.webmanifest")).toBe("shell");
    expect(kindOf("/_a/index.DEADBEEF.css")).toBe("asset");
    expect(kindOf("/_a/page.12345678.js")).toBe("asset");
  });

  it("treats opportunity pages as the stale-while-revalidate set, LRU 50", () => {
    expect(kindOf("/opportunities/nairobi-climate-hack-2026")).toBe("page");
    expect(kindOf("/opportunities/some-slug?merged=1")).toBe("page");
    // §3.4: "the last 50 viewed opportunities".
    expect(LIMITS.pages).toBe(50);
  });

  it("never caches another person's words, a write surface, or an admin view", () => {
    const mustSkip = [
      "/opportunities/nairobi-climate-hack-2026/room",
      "/opportunities/nairobi-climate-hack-2026/intent",
      "/opportunities/nairobi-climate-hack-2026/teams/new",
      "/threads",
      "/threads/8f2c",
      "/requests",
      "/requests/new",
      "/admin",
      "/admin/queues/low_confidence",
      "/api/v1/threads/8f2c",
      "/auth/callback",
      "/organisations/claims/confirm",
      "/low-data",
    ];
    for (const path of mustSkip) {
      expect(kindOf(path), `${path} must not be cached`).toBe("skip");
    }
  });

  it("caches the tracker network-first, and no other personal surface at all", () => {
    // §3.4 names "the user's tracker and their saved items". Everything else personal is
    // network-only: the eligibility profile has one read principal (DATA_MODEL.md §15) and the
    // inbox carries other people's names.
    expect(kindOf("/tracker")).toBe("user");
    expect(kindOf("/you")).toBe("skip");
    expect(kindOf("/you/inbox")).toBe("skip");
    expect(kindOf("/you/eligibility")).toBe("skip");
    expect(kindOf("/you/account")).toBe("skip");
    expect(kindOf("/you/projects")).toBe("skip");
  });

  it("leaves the rest of the site to network-first navigation", () => {
    expect(kindOf("/")).toBe("navigate");
    expect(kindOf("/opportunities")).toBe("navigate");
    expect(kindOf("/opportunities?country=ZW")).toBe("navigate");
    expect(kindOf("/organisations/kumasi-hive")).toBe("navigate");
    expect(kindOf("/privacy")).toBe("navigate");
    expect(kindOf("/anti-scam")).toBe("navigate");
  });

  it("queues only tracker writes, and never a write to anything else", () => {
    expect(kindOf("/tracker", "POST")).toBe("write-queue");
    expect(kindOf("/api/v1/tracker/entries", "POST")).toBe("write-queue");
    // A request or a message replayed into a conversation that has moved on would be worse
    // than a failure the sender can see.
    for (const path of ["/requests/new", "/threads/8f2c", "/low-data", "/projects/new"]) {
      expect(kindOf(path, "POST"), `${path} POST must not be queued`).toBe("skip");
    }
  });

  it("ignores every other origin", () => {
    expect(classify("https://elsewhere.example/opportunities/x", ORIGIN)).toBe("skip");
    // A different scheme on the same host is a different origin too, and the CDN's own host
    // is not ours however similar the path looks.
    expect(classify("http://mbele.example/opportunities/x", ORIGIN)).toBe("skip");
    expect(classify("https://cdn.mbele.example/_a/index.css", ORIGIN)).toBe("skip");
    // Unparseable, which a request URL never is — the guard is there so one malformed entry
    // cannot throw inside a fetch handler and break every request the worker sees.
    expect(classify("http://", ORIGIN)).toBe("skip");
  });
});

describe("the service worker itself", () => {
  const sw = readFileSync(join(PUBLIC, "sw.js"), "utf8");
  const register = readFileSync(join(PUBLIC, "sw-register.js"), "utf8");

  it("imports the rules rather than carrying a second copy of them", () => {
    expect(sw).toContain('importScripts("/sw-routes.js")');
    // A second copy of the routing table is the drift this file exists to prevent.
    expect(sw).not.toMatch(/function classify\s*\(/);
  });

  it("ships no third-party code and imports nothing cross-origin (invariant 12)", () => {
    // Every importScripts argument, not the word "workbox" — this file's own comments argue
    // against Workbox by name, and an assertion that a comment cannot mention a library is an
    // assertion about prose rather than about what ships.
    const imports = [...sw.matchAll(/importScripts\(\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(imports).toEqual(["/sw-routes.js"]);

    for (const source of [sw, register]) {
      // No absolute URL of any kind: every fetch the worker makes is same-origin by
      // construction, and a request to somewhere else is what a third-party script is.
      expect(source.match(/["'`]https?:\/\/[^"'`]+["'`]/g) ?? []).toEqual([]);
    }
  });

  it("sends exactly one message when a queue is replayed", () => {
    // Phase 9's acceptance criterion is "one confirmation toast", not one per write.
    const messages = sw.match(/kind: "replayed"/g) ?? [];
    expect(messages).toHaveLength(1);
  });

  it("drops a write the server refuses rather than retrying it forever", () => {
    expect(sw).toMatch(/status >= 400 && response\.status < 500/);
  });

  it("registers from a file, never from an inline script the CSP would block", () => {
    expect(register).toContain('register("/sw.js"');
  });
});

describe("web app manifest (PRODUCT_SPEC.md §25.3)", () => {
  /**
   * Read from the ROUTE, not from a copy in public/: the brand name is a configuration token
   * (PRODUCT_SPEC.md §1) and the manifest is generated from it. Parsing the response is what
   * proves the route emits valid JSON — a manifest with a syntax error is ignored by the
   * browser silently, and the product is simply not installable.
   */
  async function manifest(): Promise<Record<string, unknown>> {
    const route = await import("../src/pages/manifest.webmanifest");
    const response = await route.GET({} as never);
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
    return JSON.parse(await response.text()) as Record<string, unknown>;
  }

  it("carries everything a browser needs to offer installation", async () => {
    const m = await manifest();
    expect(m["name"]).toBeTruthy();
    expect(m["short_name"]).toBeTruthy();
    expect(m["start_url"]).toBe("/?src=pwa");
    expect(m["scope"]).toBe("/");
    expect(m["display"]).toBe("standalone");

    const icons = m["icons"] as { src: string; purpose?: string }[];
    expect(icons.length).toBeGreaterThan(0);
    // An OS will not install anything without an icon, and a maskable one is what keeps the
    // launcher from cropping it into a square on Android.
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of icons) {
      expect(icon.src.startsWith("/")).toBe(true);
    }
  });

  it("takes its name from the brand token rather than a second copy of it", async () => {
    const { BRAND } = await import("@mbele/config");
    const m = await manifest();
    expect(m["short_name"]).toBe(BRAND.name);
    expect(String(m["name"])).toContain(BRAND.name);
  });

  it("only links to URLs this product actually routes", async () => {
    const m = await manifest();
    const { parseFilters } = await import("../src/lib/filters");
    const shortcuts = m["shortcuts"] as { name: string; url: string }[];

    for (const shortcut of shortcuts) {
      const url = new URL(shortcut.url, ORIGIN);
      // A shortcut with a filter the parser does not read opens an unfiltered page and says
      // nothing about it — which is what `?deadline=7` did before this assertion existed.
      for (const [key] of url.searchParams) {
        const filters = parseFilters(url) as unknown as Record<string, unknown>;
        const applied = Object.values(filters).some(
          (value) => value !== null && value !== false && value !== "urgency" && value !== 20,
        );
        expect(applied, `${shortcut.url}: ${key} is not a filter parseFilters reads`).toBe(true);
      }
    }
  });

  it("is referenced by the pages that can work offline, and only those", () => {
    const base = readFileSync(resolve(HERE, "..", "src", "layouts", "Base.astro"), "utf8");
    expect(base).toContain('rel="manifest"');
    // Both the manifest link and the registration script hang off offlineCapable, so a page
    // that does not ask for offline support requests neither.
    expect(base).toMatch(/offlineCapable && <link rel="manifest"/);
    expect(base).toMatch(/offlineCapable && <script src="\/sw-register\.js"/);
  });
});
