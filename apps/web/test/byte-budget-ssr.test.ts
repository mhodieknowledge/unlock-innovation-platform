/**
 * Byte budgets for ON-DEMAND (SSR) routes. Invariant 5.
 *
 * scripts/byte-budget.mjs measures prerendered HTML in dist. Every interesting
 * route in this product renders on demand, including the opportunity detail page
 * — which has the tightest budget and is the route ADR 0001 was decided on — so
 * without this test invariant 5 is unenforced exactly where it matters most.
 *
 * Each route renders through Astro's container API with the data layer mocked,
 * against DELIBERATELY WORST-CASE data: long titles, maximum-length summaries,
 * ten eligibility rules each carrying a long verbatim quote, and a full page of
 * result rows. A thin fixture would flatter the budget and prove nothing.
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

/** PRODUCT_SPEC.md §25.1, for the routes that render on demand. */
const BUDGETS = {
  detail: { label: "Opportunity detail", total: 120 * KB, js: 30 * KB },
  list: { label: "Opportunity list / search", total: 150 * KB, js: 40 * KB },
  organisation: { label: "Organisation page", total: 120 * KB, js: 25 * KB },
  tracker: { label: "Authenticated dashboard", total: 200 * KB, js: 70 * KB },
} as const;

const LONG_QUOTE =
  "Applications are open to individuals who are resident in any African country at the time of submission, who are currently enrolled in or have recently completed a programme of study at a recognised institution, and who have not previously received funding under this scheme.";

const RULE_TYPES = [
  "country_in", "country_not_in", "nationality_in", "residency_required",
  "age_between", "student_status_in", "year_of_study_in", "institution_type_in",
  "experience_between", "language_required",
] as const;

const SUBJECTS = [
  "AgriTech", "Climate Resilience", "Health Data", "Fintech Inclusion",
  "Renewable Energy", "Open Transport", "Water Sanitation", "Civic Technology",
  "Creative Industries", "Youth Employment",
];
const KINDS = ["Innovation Challenge", "Fellowship", "Grant", "Accelerator", "Research Call"];
const PLACES = ["Southern Africa", "East Africa", "West Africa", "Pan-African", "Continental"];

/**
 * Distinct per row. Thirty near-identical titles gzip down to almost nothing,
 * which would flatter the budget with a compression artefact rather than measure
 * a realistic page.
 */
function worstCaseOpportunity(i: number) {
  const subject = SUBJECTS[i % SUBJECTS.length]!;
  const kind = KINDS[i % KINDS.length]!;
  const place = PLACES[i % PLACES.length]!;
  // Deadlines spread across the window so some rows land in "closing soon".
  const day = 15 + (i % 14);
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    slug: `worst-case-${i}`,
    title: `${place} ${subject} ${kind} for Early-Career Builders 2026, cohort ${i} (${subject} track)`,
    summary: "x".repeat(400),
    description_md: "y".repeat(4000),
    deadline_at: `2026-09-${String(day).padStart(2, "0")}T21:59:00Z`,
    deadline_precision: "date_only",
    deadline_raw: `Applications close ${day} September`,
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
  };
}

const DETAIL = {
  opportunity: worstCaseOpportunity(1),
  rules: RULE_TYPES.map((rule_type, i) => ({
    id: `rule-${i}`,
    rule_type,
    params: { countries: ["ZW", "ZM"], min: 18, max: 30 },
    source_quote: LONG_QUOTE,
    confidence: 0.9,
  })),
};

// A full page of rows, which is what the list budget has to survive.
const PAGE_OF_ROWS = Array.from({ length: 20 }, (_, i) => worstCaseOpportunity(i + 1));

// A busy tracker: 30 entries is well past what a real user accumulates, so the
// dashboard budget is measured against a worse case than it will meet.
const TRACKER_ROWS = Array.from({ length: 30 }, (_, i) => ({
  id: `entry-${i}`,
  state: ["saved", "planning_to_apply", "applied", "submitted", "participating"][i % 5]!,
  note: "n".repeat(200),
  applied_at: null,
  remind_at: null,
  updated_at: "2026-09-13T00:00:00Z",
  opportunities: worstCaseOpportunity(i + 1),
}));

const ORGANISATION = {
  organisation: {
    id: "org-1",
    slug: "example-org",
    name: "Example Foundation for African Innovation",
    description: "z".repeat(2000),
    website_url: "https://example.org",
    country_iso2: "GH",
    org_type: "foundation",
    verification: "verified",
    verified_at: "2026-05-01T00:00:00Z",
  },
  open: PAGE_OF_ROWS.slice(0, 10),
  past: PAGE_OF_ROWS.slice(10),
};

const SESSION_USER = {
  id: "aaaa1111-1111-1111-1111-111111111111",
  email: "t@example.invalid",
  handle: null,
  display_name: "Test",
  is_admin: false,
  admin_role: null,
  account_state: "active",
  age_confirmed_18: true,
  timezone: "Africa/Harare",
  low_data_mode: false,
};

// The tracker redirects without a session, so the budget could never be measured
// on the real page. Mocking auth is what lets the authenticated route be measured
// at all -- an unmeasured route is an unenforced budget.
vi.mock("../src/lib/auth", () => ({
  getSessionUser: vi.fn(async () => SESSION_USER),
  createAuthClient: vi.fn(() => ({
    from: () => ({
      select: () => ({
        order: () => ({ data: TRACKER_ROWS, error: null }),
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
  })),
  personalWritesAllowed: vi.fn(() => true),
  socialWritesAllowed: vi.fn(() => ({ allowed: true, reason: null })),
  safeReturnTo: (v: string | null) => v ?? "/",
}));

vi.mock("../src/lib/db", () => ({
  getOpportunity: vi.fn(async () => ({ ok: true, data: DETAIL })),
  searchOpportunities: vi.fn(async () => ({
    ok: true,
    data: { rows: PAGE_OF_ROWS, total: 137 },
  })),
  listOpportunities: vi.fn(async () => ({ ok: true, data: PAGE_OF_ROWS })),
  getOrganisation: vi.fn(async () => ({ ok: true, data: ORGANISATION })),
  getTracker: vi.fn(async () => ({ ok: true, data: TRACKER_ROWS })),
  getRuleTypeCounts: vi.fn(async () => ({ country_in: 42, age_between: 17 })),
  allowedTrackerTransitions: vi.fn(async () => ["applied"]),
  getPublishedCount: vi.fn(async () => 312),
  isFlagEnabled: vi.fn(async () => false),
  getClient: vi.fn(() => null),
}));

const gz = (s: string | Buffer) => gzipSync(Buffer.from(s), { level: 9 }).length;
const fmt = (n: number) => `${(n / KB).toFixed(1)} KB`;

/**
 * Client-side asset weight, measured from the REAL build output.
 *
 * Why not from the rendered HTML: the container API renders a page but does not
 * resolve island hydration assets, so the HTML it returns carries no script or
 * link tags. An earlier version of this test scanned the HTML, found 0 modules,
 * measured 0 KB of JS and PASSED — a false pass of exactly the kind this test
 * exists to prevent.
 *
 * So the whole built client bundle is charged to every route, as a deliberate
 * UPPER BOUND. Islands share the Svelte runtime, so this can only over-estimate,
 * and a new island that pushes the shared bundle over a budget fails the build
 * rather than slipping through unattributed.
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

interface Measured {
  html: string;
  htmlBytes: number;
  total: number;
  js: number;
  css: number;
  modules: number;
  hydrates: boolean;
}

const measured: Record<string, Measured> = {};

async function render(
  key: keyof typeof BUDGETS,
  importer: () => Promise<{ default: unknown }>,
  params: Record<string, string>,
  url: string,
) {
  const container = await AstroContainer.create();
  container.addServerRenderer({ name: "@astrojs/svelte", renderer: svelteRenderer });
  container.addClientRenderer({
    name: "@astrojs/svelte",
    entrypoint: "@astrojs/svelte/client.js",
  });

  const { default: Page } = await importer();
  const response = await container.renderToResponse(Page as never, {
    params,
    locals: { runtime: { env: {} } },
    request: new Request(url),
  });

  const html = await response.text();
  const assets = measureBuiltAssets();
  const htmlBytes = gz(html);

  // A route with no island ships no JS at all, so charging it the shared bundle
  // would be conservative past the point of usefulness — the organisation page
  // would sit at 76% of a budget it does not spend, and a later island would
  // fail it spuriously. Routes WITH an island are still charged the whole bundle
  // as an upper bound, since islands share the Svelte runtime.
  const hydrates = html.includes("astro-island");
  const js = hydrates ? assets.js : 0;
  const modules = hydrates ? assets.modules : 0;

  measured[key] = {
    html,
    htmlBytes,
    js,
    css: assets.css,
    modules,
    total: htmlBytes + assets.css + js,
    hydrates,
  };
}

beforeAll(async () => {
  // The JS half reads the built client output, so a build must have run. Failing
  // loudly beats silently measuring 0 KB and calling it a pass.
  expect(
    existsSync(CLIENT_DIR),
    `No build output at ${CLIENT_DIR}. Run the build before this test.`,
  ).toBe(true);

  await render(
    "detail",
    () => import("../src/pages/opportunities/[slug].astro"),
    { slug: "worst-case-1" },
    "https://example.invalid/opportunities/worst-case-1",
  );
  await render(
    "list",
    () => import("../src/pages/opportunities/index.astro"),
    {},
    "https://example.invalid/opportunities?country=ZW&mode=online&cost=free",
  );
  await render(
    "tracker",
    () => import("../src/pages/tracker.astro"),
    {},
    "https://example.invalid/tracker",
  );
  await render(
    "organisation",
    () => import("../src/pages/organisations/[slug].astro"),
    { slug: "example-org" },
    "https://example.invalid/organisations/example-org",
  );

  const pct = (n: number, of: number) => `${Math.round((n / of) * 100)}%`;
  const lines = Object.entries(BUDGETS).map(([key, budget]) => {
    const m = measured[key]!;
    return (
      `  ${budget.label.padEnd(28)} total ${fmt(m.total).padStart(9)} / ${fmt(budget.total)} (${pct(m.total, budget.total)})` +
      `   js ${fmt(m.js).padStart(8)} / ${fmt(budget.js)} (${pct(m.js, budget.js)})` +
      `   html ${fmt(m.htmlBytes)}${m.hydrates ? "" : "   (no island)"}`
    );
  });
  console.log("\n" + lines.join("\n") + "\n");
});

describe("byte budgets — on-demand routes (invariant 5)", () => {
  it("actually measured something (guards against a vacuous pass)", () => {
    // Zero must fail loudly. This is the specific bug that made an earlier
    // version of this test pass while measuring nothing at all.
    for (const [key, m] of Object.entries(measured)) {
      expect(m.css, `${key}: measured 0 bytes of CSS`).toBeGreaterThan(0);
      expect(m.htmlBytes, `${key}: rendered HTML is suspiciously small`).toBeGreaterThan(1024);
      if (m.hydrates) {
        expect(m.modules, `${key}: hydrates but found no JS modules`).toBeGreaterThan(0);
        expect(m.js, `${key}: hydrates but measured 0 bytes of JS`).toBeGreaterThan(0);
      }
    }

    // At least one route must hydrate, otherwise the JS measurement is vacuous
    // across the board and the whole check proves nothing.
    expect(
      Object.values(measured).some((m) => m.hydrates),
      "no route hydrates — the JS budget is not being exercised at all",
    ).toBe(true);
  });

  for (const [key, budget] of Object.entries(BUDGETS)) {
    it(`${budget.label} stays within its JS budget`, () => {
      const m = measured[key]!;
      expect(m.js, `JS ${fmt(m.js)} of ${fmt(budget.js)} across ${m.modules} modules`).toBeLessThanOrEqual(
        budget.js,
      );
    });

    it(`${budget.label} stays within its total transfer budget`, () => {
      const m = measured[key]!;
      expect(
        m.total,
        `total ${fmt(m.total)} of ${fmt(budget.total)} (html ${fmt(m.htmlBytes)}, css ${fmt(m.css)}, js ${fmt(m.js)})`,
      ).toBeLessThanOrEqual(budget.total);
    });

    it(`${budget.label} ships no third-party script (invariant 12)`, () => {
      const external = [
        ...measured[key]!.html.matchAll(/<script[^>]+src=["'](https?:\/\/[^"']+)["']/g),
      ];
      expect(external.map((m) => m[1])).toEqual([]);
    });
  }

  it("mounts the eligibility island on the detail page", () => {
    // If the island stops rendering, the JS budget passes trivially while the
    // product loses its core interaction.
    expect(measured.detail!.html).toContain("astro-island");
    expect(measured.detail!.html).toContain("Check if you can apply");
  });

  it("shows the quoted source sentence and the raw deadline string", () => {
    // PRODUCT_SPEC.md §12.4 and §11.3.
    expect(measured.detail!.html).toContain(LONG_QUOTE.slice(0, 60));
    expect(measured.detail!.html).toMatch(/Applications close \d+ September/);
  });

  it("offers an explicit 'show more' rather than infinite scroll", () => {
    // UX_FLOWS.md §3 marks this `[PR]`: infinite scroll on metered data spends
    // the user's money without asking.
    expect(measured.list!.html).toContain("Show 20 more");
  });

  it("renders a populated tracker, not the empty state", () => {
    // 2.6 KB of HTML for 30 entries would mean the empty state rendered and the
    // dashboard budget was measured against nothing. Assert the rows are really
    // there, the same discipline as the vacuous-pass guard.
    expect(measured.tracker!.html).not.toContain("Nothing saved yet");
    expect(measured.tracker!.html).toContain("Closing soon");
    const rowCount = [...measured.tracker!.html.matchAll(/Early-Career Builders 2026/g)].length;
    expect(rowCount, `expected 30 tracker rows, found ${rowCount}`).toBeGreaterThanOrEqual(30);
  });

  it("keeps past opportunities on the organisation page", () => {
    // OPPORTUNITY_INGESTION.md §5.4 — expired records are never deleted.
    expect(measured.organisation!.html).toContain("Past opportunities");
  });
});
