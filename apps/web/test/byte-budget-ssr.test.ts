/**
 * Byte budgets for ON-DEMAND (SSR) routes. Invariant 5.
 *
 * scripts/byte-budget.mjs measures prerendered HTML in dist. The opportunity
 * detail page renders on demand, and it is both the route with the tightest
 * budget (120 KB total, 30 KB JS) and the one ADR 0001 was decided on — so
 * without this test invariant 5 is unenforced exactly where it matters most.
 *
 * Renders the real page through Astro's container API with the data layer
 * mocked, against a DELIBERATELY WORST-CASE record: maximum-length summary, a
 * long title, ten eligibility rules each carrying a long verbatim quote. A thin
 * fixture would flatter the budget and prove nothing.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import svelteRenderer from "@astrojs/svelte/server.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "dist", "client");
const KB = 1024;

const OPPORTUNITY_DETAIL_BUDGET = { total: 120 * KB, js: 30 * KB };

const LONG_QUOTE =
  "Applications are open to individuals who are resident in any African country at the time of submission, who are currently enrolled in or have recently completed a programme of study at a recognised institution, and who have not previously received funding under this scheme.";

const RULE_TYPES = [
  "country_in", "country_not_in", "nationality_in", "residency_required",
  "age_between", "student_status_in", "year_of_study_in", "institution_type_in",
  "experience_between", "language_required",
] as const;

const WORST_CASE = {
  opportunity: {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "worst-case-measurement",
    title:
      "Pan-African AgriTech and Climate Resilience Innovation Challenge for Early-Career Builders 2026",
    summary: "x".repeat(400),
    description_md: "y".repeat(4000),
    deadline_at: "2026-12-30T21:59:00Z",
    deadline_precision: "date_only",
    deadline_raw: "Applications close 30 December",
    deadline_timezone: "Africa/Harare",
    opens_at: "2026-08-01T00:00:00Z",
    starts_at: "2027-01-15T00:00:00Z",
    ends_at: "2027-01-17T00:00:00Z",
    is_rolling: false,
    participation_mode: "online",
    eligibility_scope: "africa_wide",
    eligible_countries: ["ZW", "ZM", "BW", "NA", "MW", "MZ", "KE", "NG", "GH", "ZA"],
    team_required: true,
    team_size_min: 2,
    team_size_max: 5,
    prize_amount: 10000,
    prize_currency: "USD",
    cost: "free",
    cost_description: null,
    verification: "verified",
    last_verified_at: "2026-09-13T06:00:00Z",
    source_url: "https://example.org/source",
    official_url: "https://example.org/official",
    apply_url: "https://example.org/apply",
    status: "published",
    duplicate_of: null,
    organisations: {
      slug: "example-org",
      name: "Example Foundation for African Innovation",
      verification: "verified",
    },
    categories: { code: "ai_challenge", name: "AI challenge", slug: "ai-challenges" },
  },
  rules: RULE_TYPES.map((rule_type, i) => ({
    id: `rule-${i}`,
    rule_type,
    params: { countries: ["ZW", "ZM"], min: 18, max: 30 },
    source_quote: LONG_QUOTE,
    confidence: 0.9,
  })),
};

vi.mock("../src/lib/db", () => ({
  getOpportunity: vi.fn(async () => ({ ok: true, data: WORST_CASE })),
  listOpportunities: vi.fn(async () => ({ ok: true, data: [WORST_CASE.opportunity] })),
  getPublishedCount: vi.fn(async () => 312),
  isFlagEnabled: vi.fn(async () => false),
  getClient: vi.fn(() => null),
}));

const gz = (s: string | Buffer) => gzipSync(Buffer.from(s), { level: 9 }).length;
const fmt = (n: number) => `${(n / KB).toFixed(1)} KB`;

/**
 * Client-side asset weight, measured from the REAL build output.
 *
 * Why not from the rendered HTML: the container API renders the page but does
 * not resolve island hydration assets the way a real build does, so the HTML it
 * returns carries no <script src> or <link href>. Scanning it found 0 modules
 * and reported a pass — a false pass of exactly the kind this test exists to
 * prevent.
 *
 * So the whole built client bundle is measured instead, as a deliberate UPPER
 * BOUND. Every island shares the Svelte runtime, and this route has the tightest
 * JS budget in the product, so charging it the entire bundle can only
 * over-estimate. If it passes here it passes everywhere, and a new island that
 * pushes the shared bundle over the line fails the build rather than slipping
 * through unattributed.
 */
function measureBuiltAssets(): { js: number; css: number; modules: number } {
  const assetDir = join(CLIENT_DIR, "_a");
  if (!existsSync(assetDir)) return { js: 0, css: 0, modules: 0 };

  let js = 0;
  let css = 0;
  let modules = 0;

  for (const entry of readdirSync(assetDir)) {
    const file = join(assetDir, entry);
    if (entry.endsWith(".js")) {
      js += gz(readFileSync(file));
      modules += 1;
    } else if (entry.endsWith(".css")) {
      css += gz(readFileSync(file));
    }
  }
  return { js, css, modules };
}

describe("byte budgets — on-demand routes (invariant 5)", () => {
  let html: string;
  let assets: { js: number; css: number; modules: number };

  beforeAll(async () => {
    // The JS half of the measurement reads the built client output, so a build
    // must have run. Failing loudly beats silently measuring 0 KB of JS and
    // calling it a pass.
    expect(
      existsSync(CLIENT_DIR),
      `No build output at ${CLIENT_DIR}. Run the build before this test.`,
    ).toBe(true);

    const container = await AstroContainer.create();
    container.addServerRenderer({ name: "@astrojs/svelte", renderer: svelteRenderer });
    container.addClientRenderer({
      name: "@astrojs/svelte",
      entrypoint: "@astrojs/svelte/client.js",
    });

    const { default: Page } = await import("../src/pages/opportunities/[slug].astro");
    const response = await container.renderToResponse(Page, {
      params: { slug: "worst-case-measurement" },
      locals: { runtime: { env: {} } },
      request: new Request("https://example.invalid/opportunities/worst-case-measurement"),
    });

    html = await response.text();
    assets = measureBuiltAssets();

    // Printed so the headroom is visible in CI output, not only on failure.
    // A budget you only see when it breaks is a budget nobody is managing.
    const htmlBytes = gz(html);
    const total = htmlBytes + assets.css + assets.js;
    const pct = (n: number, of: number) => `${Math.round((n / of) * 100)}%`;
    console.log(
      `\n  opportunity detail (worst case): total ${fmt(total)} / ${fmt(OPPORTUNITY_DETAIL_BUDGET.total)} (${pct(total, OPPORTUNITY_DETAIL_BUDGET.total)})` +
        `\n    html ${fmt(htmlBytes)}  css ${fmt(assets.css)}  js ${fmt(assets.js)} / ${fmt(OPPORTUNITY_DETAIL_BUDGET.js)} (${pct(assets.js, OPPORTUNITY_DETAIL_BUDGET.js)}, ${assets.modules} modules)\n`,
    );
  });

  it("actually measured something (guards against a vacuous pass)", () => {
    // A measurement of zero must fail loudly. This is the specific bug that made
    // an earlier version of this test pass while measuring nothing at all.
    expect(assets.modules, "no JS modules found in the build output").toBeGreaterThan(0);
    expect(assets.js, "measured 0 bytes of JS").toBeGreaterThan(0);
    expect(assets.css, "measured 0 bytes of CSS").toBeGreaterThan(0);
    expect(gz(html), "rendered HTML is suspiciously small").toBeGreaterThan(1024);
  });

  it("mounts the eligibility island on the page", () => {
    // If the island stops rendering, the JS budget would trivially pass while the
    // product lost its core interaction.
    expect(html).toContain("astro-island");
    expect(html).toContain("Check if you can apply");
  });

  it("renders the worst-case record with its verdict scaffolding", () => {
    expect(html).toContain("Pan-African AgriTech");
    // PRODUCT_SPEC.md §12.4 — the quoted source sentence is always present.
    expect(html).toContain(LONG_QUOTE.slice(0, 60));
    // §11.3 — the raw source string is shown when precision is coarse.
    expect(html).toContain("Applications close 30 December");
  });

  it("stays within the opportunity detail JS budget", () => {
    const detail = `JS ${fmt(assets.js)} of ${fmt(OPPORTUNITY_DETAIL_BUDGET.js)} across ${assets.modules} modules`;
    expect(assets.js, detail).toBeLessThanOrEqual(OPPORTUNITY_DETAIL_BUDGET.js);
  });

  it("stays within the opportunity detail total transfer budget", () => {
    const htmlBytes = gz(html);
    const total = htmlBytes + assets.css + assets.js;
    const detail = `total ${fmt(total)} of ${fmt(OPPORTUNITY_DETAIL_BUDGET.total)} (html ${fmt(htmlBytes)}, css ${fmt(assets.css)}, js ${fmt(assets.js)})`;
    expect(total, detail).toBeLessThanOrEqual(OPPORTUNITY_DETAIL_BUDGET.total);
  });

  it("ships no third-party script (invariant 12)", () => {
    const external = [...html.matchAll(/<script[^>]+src=["'](https?:\/\/[^"']+)["']/g)];
    expect(external.map((m) => m[1])).toEqual([]);
  });
});
