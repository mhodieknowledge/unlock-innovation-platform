/**
 * The axe audit. DESIGN_SYSTEM.md §8: "Target: WCAG 2.1 AA, verified in CI with axe on every
 * public route." IMPLEMENTATION_PLAN.md §13 makes it Phase 11's first line.
 *
 * Every public route is rendered through the container API and run through axe-core in jsdom.
 * What that catches is the machine-checkable half of §8 — an unlabelled control, an image with no
 * alt text, a heading level skipped, an aria attribute that does not apply, a duplicate id, a
 * link with no accessible name — on every route rather than on the ones somebody remembered.
 *
 * WHAT IT CANNOT CATCH, stated so the pass is not read as more than it is:
 *
 *   Colour contrast. axe measures it by rendering to a canvas, which jsdom has no implementation
 *   of, and the stylesheet is external to the container's output anyway. So contrast is checked
 *   directly against the tokens instead — see apps/web/test/contrast.test.ts, which computes the
 *   WCAG ratio for every pair the design system actually uses. That is a stronger check than
 *   axe's, because it covers pairs no rendered page happened to contain.
 *
 *   Focus order, focus visibility, screen-reader announcement order, and whether a verdict
 *   actually reads as a sentence. Those need a keyboard and a screen reader, and RUNBOOK §15
 *   says plainly that no human has done that pass.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import svelteRenderer from "@astrojs/svelte/server.js";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require_.resolve("axe-core"), "utf8");

const SESSION_USER = {
  id: "aaaa1111-1111-1111-1111-111111111111",
  email: "reader@example.invalid",
  handle: "reader",
  display_name: "A Reader",
  is_admin: false,
  admin_role: null,
  account_state: "active",
  age_confirmed_18: true,
  timezone: "Africa/Harare",
  low_data_mode: false,
};

const ROW = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "agritech-ai-challenge-2026",
  title: "AgriTech AI Challenge 2026",
  summary: "An open call for teams building irrigation tooling for smallholder farms.",
  description_md: "## What it is\n\nA challenge.\n\n- one\n- two\n",
  deadline_at: "2026-09-30T21:59:00Z",
  deadline_precision: "date_only",
  deadline_raw: "Applications close 30 September",
  deadline_timezone: "Africa/Harare",
  opens_at: "2026-08-01T00:00:00Z",
  starts_at: "2026-10-15T00:00:00Z",
  ends_at: "2026-10-17T00:00:00Z",
  is_rolling: false,
  participation_mode: "online",
  eligibility_scope: "africa_wide",
  eligible_countries: ["ZW"],
  team_required: true,
  team_size_min: 2,
  team_size_max: 5,
  prize_amount: "10000.00",
  prize_currency: "USD",
  cost: "free",
  cost_description: null,
  verification: "verified",
  last_verified_at: "2026-09-14T06:00:00Z",
  source_url: "https://example.invalid/source",
  official_url: "https://example.invalid/official",
  apply_url: "https://example.invalid/apply",
  status: "published",
  duplicate_of: null,
  organisations: { slug: "kumasi-hive", name: "Kumasi Hive", verification: "verified" },
  categories: { code: "ai_challenge", name: "AI challenge", slug: "ai-challenges" },
};

const RULES = [
  {
    id: "rule-1",
    rule_type: "country_in",
    params: { countries: ["ZW", "ZM"] },
    source_quote: "Open to residents of Zimbabwe and Zambia at the time of application.",
    confidence: 0.92,
  },
  {
    id: "rule-2",
    rule_type: "age_between",
    params: { min: 18, max: 35 },
    source_quote: "Applicants must be between 18 and 35.",
    confidence: 0.81,
  },
];

const COUNTRY = { iso2: "ZW", name: "Zimbabwe", slug: "zimbabwe" };

const PROFILE_ROW = [
  {
    user_id: "bbbb2222-2222-2222-2222-222222222222",
    handle: "tadiwa-m",
    display_name: "Tadiwa Moyo",
    visibility: "public",
    indexable: true,
    headline: "Backend developer, mostly Go",
    bio: "Two hackathons this year.",
    country_iso2: "ZW",
    country_name: "Zimbabwe",
    country_slug: "zimbabwe",
    city: "Bulawayo",
    github_url: "https://github.example/tadiwa",
    portfolio_url: null,
    other_url: null,
    open_to: ["hackathon_teams"],
    availability_hours_per_week: 6,
    shared_context: false,
    shared_opportunity_slug: null,
    updated_at: "2026-09-01T00:00:00Z",
  },
];

/**
 * Two of the routes below need a session to render anything at all: the claim and manage pages
 * redirect to sign-in without one. They are still surfaces a reader reaches from a public page,
 * so they are audited signed IN rather than dropped — this flag is what the loop flips.
 */
const state = { signedIn: false };

const rpc = async (fn: string) => {
  switch (fn) {
    case "public_profile":
      return { data: PROFILE_ROW, error: null };
    case "my_org_claims":
      return { data: [], error: null };
    case "org_opportunities":
      return {
        data: [
          {
            id: "l1",
            slug: "agritech-ai-challenge-2026",
            title: "AgriTech AI Challenge 2026",
            status: "published",
            verification: "official",
            deadline_at: "2026-09-30T21:59:00Z",
            tracked_by: 4,
            in_review: false,
            created_at: "2026-08-01T00:00:00Z",
          },
        ],
        error: null,
      };
    case "confirm_org_claim":
      return {
        data: [{ ok: true, organisation_slug: "kumasi-hive", organisation_name: "Kumasi Hive" }],
        error: null,
      };
    case "room_state":
      return { data: [{ state: "disabled", intent_count: 0, team_count: 0, reason: "flag off" }], error: null };
    case "describe_unsubscribe_token":
      return { data: [{ type: "digest", already_used: false, digest_frequency: "daily" }], error: null };
    default:
      return { data: null, error: null };
  }
};

function tableStub(table: string) {
  const rows: Record<string, unknown[]> = {
    opportunities: [ROW],
    categories: [{ code: "ai_challenge", name: "AI challenge", slug: "ai-challenges" }],
    countries: [COUNTRY],
    projects: [],
    organisation_members: state.signedIn ? [{ user_id: SESSION_USER.id, role: "owner" }] : [],
  };
  const data = rows[table] ?? [];
  const result = { data, error: null, count: data.length };
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
    single: async () => ({ data: data[0] ?? null, error: null }),
  };
  for (const method of [
    "select", "eq", "neq", "is", "in", "not", "or", "gt", "gte", "lt", "lte", "like", "ilike",
    "contains", "overlaps", "textSearch", "range", "order", "limit", "update", "upsert", "delete",
    "insert",
  ]) {
    chain[method] = () => chain;
  }
  return chain;
}

const client = () => ({ from: (t: string) => tableStub(t), rpc });

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/auth")>()),
  getSessionUser: vi.fn(async () => (state.signedIn ? SESSION_USER : null)),
  getResidenceCountry: vi.fn(async () => null),
  createAuthClient: vi.fn(() => (state.signedIn ? client() : null)),
  socialWritesAllowed: vi.fn(() =>
    state.signedIn
      ? { allowed: true, reason: null }
      : { allowed: false, reason: "You need to be signed in to do that." },
  ),
  personalWritesAllowed: vi.fn(() => state.signedIn),
  safeReturnTo: (v: string | null) => v ?? "/",
}));

vi.mock("../src/lib/db", () => ({
  getClient: vi.fn(() => client()),
  getOpportunity: vi.fn(async () => ({ ok: true as const, data: { opportunity: ROW, rules: RULES } })),
  listOpportunities: vi.fn(async () => ({ ok: true as const, data: [ROW] })),
  searchOpportunities: vi.fn(async () => ({ ok: true as const, data: { rows: [ROW], total: 1 } })),
  getOpportunitiesByIds: vi.fn(async () => [ROW]),
  getOrganisation: vi.fn(async () => ({
    ok: true as const,
    data: {
      organisation: {
        id: "org-1",
        slug: "kumasi-hive",
        name: "Kumasi Hive",
        description: "A maker space in Kumasi.",
        website_url: "https://kumasihive.example",
        country_iso2: "GH",
        org_type: "community",
        verification: "verified",
        verified_at: "2026-05-01T00:00:00Z",
      },
      open: [ROW],
      past: [],
    },
  })),
  getCountryBySlug: vi.fn(async (slug: string | undefined) => (slug === "zimbabwe" ? COUNTRY : null)),
  getCountry: vi.fn(async () => COUNTRY),
  getCountryNames: vi.fn(async () => ["Zimbabwe"]),
  getCountryCounts: vi.fn(async () => [
    { ...COUNTRY, region: "eastern_africa", open_count: 12, specific_count: 3, soonest_deadline: null },
  ]),
  getMatrixCells: vi.fn(async () => [
    {
      iso2: "ZW",
      country_name: "Zimbabwe",
      country_slug: "zimbabwe",
      category_code: "ai_challenge",
      category_name: "AI challenge",
      category_slug: "ai-challenges",
      open_count: 12,
    },
  ]),
  getCategoryCounts: vi.fn(async () => [
    { code: "ai_challenge", name: "AI challenge", slug: "ai-challenges", open_count: 12, soonest_deadline: null },
  ]),
  getCountryOrganisations: vi.fn(async () => [
    { slug: "kumasi-hive", name: "Kumasi Hive", verification: "verified", open_count: 3 },
  ]),
  getEntryPoints: vi.fn(async () => ({
    countries: [COUNTRY],
    categories: [{ code: "ai_challenge", name: "AI challenge", slug: "ai-challenges" }],
  })),
  getPublishedCount: vi.fn(async () => 312),
  getLastVerifiedAt: vi.fn(async () => "2026-09-14T06:00:00Z"),
  getRuleTypeCounts: vi.fn(async () => ({ country_in: 42, age_between: 17 })),
  isFlagEnabled: vi.fn(async () => false),
}));

vi.mock("../src/lib/search", () => ({
  // The degraded shape the real function returns: not ok, and an empty `rows` array rather than
  // no array at all (lib/search.ts). The list page is audited in that state deliberately — §6.5
  // makes degraded search a quiet note over working results, so it is a state with markup.
  search: vi.fn(async () => ({
    ok: false as const,
    rows: [],
    compiled: null,
    retrieval: { fts: false, vector: false, compiler: "heuristic" },
  })),
  getQueryVocabulary: vi.fn(async () => ({ countries: [], categories: [] })),
  rank: vi.fn((rows: unknown[]) => rows),
}));

vi.mock("../src/lib/errors", () => ({ reportError: vi.fn(async () => undefined) }));

/** Every public route. §8's "every public route" is this list, and it is checked for drift below. */
const ROUTES: {
  name: string;
  load: () => Promise<{ default: unknown }>;
  params?: Record<string, string>;
  url: string;
  /** Render with a session: the page redirects to sign-in without one. */
  signedIn?: boolean;
}[] = [
  { name: "/", load: () => import("../src/pages/index.astro"), url: "https://example.invalid/" },
  {
    name: "/opportunities",
    load: () => import("../src/pages/opportunities/index.astro"),
    url: "https://example.invalid/opportunities?q=ai+hackathons",
  },
  {
    name: "/opportunities/[slug]",
    load: () => import("../src/pages/opportunities/[slug].astro"),
    params: { slug: "agritech-ai-challenge-2026" },
    url: "https://example.invalid/opportunities/agritech-ai-challenge-2026",
  },
  {
    name: "/organisations/[slug]",
    load: () => import("../src/pages/organisations/[slug].astro"),
    params: { slug: "kumasi-hive" },
    url: "https://example.invalid/organisations/kumasi-hive",
  },
  { name: "/countries", load: () => import("../src/pages/countries/index.astro"), url: "https://example.invalid/countries" },
  {
    name: "/countries/[slug]",
    load: () => import("../src/pages/countries/[slug].astro"),
    params: { slug: "zimbabwe" },
    url: "https://example.invalid/countries/zimbabwe",
  },
  {
    name: "/countries/[slug]/[category]",
    load: () => import("../src/pages/countries/[slug]/[category].astro"),
    params: { slug: "zimbabwe", category: "ai-challenges" },
    url: "https://example.invalid/countries/zimbabwe/ai-challenges",
  },
  { name: "/categories", load: () => import("../src/pages/categories/index.astro"), url: "https://example.invalid/categories" },
  {
    name: "/categories/[slug]",
    load: () => import("../src/pages/categories/[slug].astro"),
    params: { slug: "ai-challenges" },
    url: "https://example.invalid/categories/ai-challenges",
  },
  {
    name: "/b/[handle]",
    load: () => import("../src/pages/b/[handle].astro"),
    params: { handle: "tadiwa-m" },
    url: "https://example.invalid/b/tadiwa-m",
  },
  {
    name: "/organisations/[slug]/claim",
    load: () => import("../src/pages/organisations/[slug]/claim.astro"),
    params: { slug: "kumasi-hive" },
    url: "https://example.invalid/organisations/kumasi-hive/claim",
    signedIn: true,
  },
  {
    name: "/organisations/[slug]/manage",
    load: () => import("../src/pages/organisations/[slug]/manage.astro"),
    params: { slug: "kumasi-hive" },
    url: "https://example.invalid/organisations/kumasi-hive/manage",
    signedIn: true,
  },
  {
    name: "/organisations/claims/confirm",
    load: () => import("../src/pages/organisations/claims/confirm.astro"),
    url: "https://example.invalid/organisations/claims/confirm?token=fixture-token",
  },
  { name: "/submit", load: () => import("../src/pages/submit.astro"), url: "https://example.invalid/submit" },
  { name: "/report", load: () => import("../src/pages/report.astro"), url: "https://example.invalid/report?subject=agritech-ai-challenge-2026" },
  { name: "/signin", load: () => import("../src/pages/signin.astro"), url: "https://example.invalid/signin" },
  { name: "/unsubscribe", load: () => import("../src/pages/unsubscribe.astro"), url: "https://example.invalid/unsubscribe?t=token-fixture" },
  { name: "/privacy", load: () => import("../src/pages/privacy.astro"), url: "https://example.invalid/privacy" },
  { name: "/terms", load: () => import("../src/pages/terms.astro"), url: "https://example.invalid/terms" },
  { name: "/content-policy", load: () => import("../src/pages/content-policy.astro"), url: "https://example.invalid/content-policy" },
  { name: "/anti-scam", load: () => import("../src/pages/anti-scam.astro"), url: "https://example.invalid/anti-scam" },
  { name: "/verification", load: () => import("../src/pages/verification.astro"), url: "https://example.invalid/verification" },
  { name: "/bot", load: () => import("../src/pages/bot.astro"), url: "https://example.invalid/bot" },
  { name: "/changelog", load: () => import("../src/pages/changelog.astro"), url: "https://example.invalid/changelog" },
  { name: "/offline", load: () => import("../src/pages/offline.astro"), url: "https://example.invalid/offline" },
  { name: "/404", load: () => import("../src/pages/404.astro"), url: "https://example.invalid/404" },
];

const html: Record<string, string> = {};

beforeAll(async () => {
  for (const route of ROUTES) {
    state.signedIn = route.signedIn === true;
    const container = await AstroContainer.create();
    container.addServerRenderer({ name: "@astrojs/svelte", renderer: svelteRenderer });
    container.addClientRenderer({ name: "@astrojs/svelte", entrypoint: "@astrojs/svelte/client.js" });
    const { default: Page } = await route.load();
    const response = await container.renderToResponse(Page as never, {
      params: route.params ?? {},
      locals: { runtime: { env: {} } },
      request: new Request(route.url),
    });
    html[route.name] = await response.text();
  }
}, 120_000);

/**
 * axe, in jsdom, with the rules that need a real rendering engine turned off explicitly.
 *
 * `color-contrast` and `link-in-text-block` both sample rendered pixels through a canvas jsdom
 * does not implement — left on, they report "incomplete" for every element and say nothing.
 * Contrast is covered properly in contrast.test.ts.
 */
async function audit(markup: string): Promise<{ id: string; nodes: string[]; help: string }[]> {
  const dom = new JSDOM(markup, { runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(AXE_SOURCE);
  const results = await (
    dom.window as unknown as {
      axe: {
        run: (
          context: unknown,
          options: unknown,
        ) => Promise<{ violations: { id: string; help: string; nodes: { html: string }[] }[] }>;
      };
    }
  ).axe.run(dom.window.document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
    rules: {
      "color-contrast": { enabled: false },
      "link-in-text-block": { enabled: false },
    },
  });

  dom.window.close();
  return results.violations.map((violation) => ({
    id: violation.id,
    help: violation.help,
    nodes: violation.nodes.slice(0, 3).map((node) => node.html.slice(0, 200)),
  }));
}

describe("axe on every public route (DESIGN_SYSTEM.md §8)", () => {
  it("rendered every route, and none of them is an error page", () => {
    // A route that threw would render an error state and pass axe trivially.
    for (const route of ROUTES) {
      expect(html[route.name], `${route.name} rendered nothing`).toBeTruthy();
      expect(html[route.name]!.length, `${route.name} is suspiciously small`).toBeGreaterThan(500);
      expect(html[route.name], `${route.name} rendered a <main>`).toContain("<main");
    }
  });

  for (const route of ROUTES) {
    it(`${route.name} has no axe violations`, async () => {
      const violations = await audit(html[route.name]!);
      expect(
        violations,
        violations.map((v) => `${v.id}: ${v.help}\n    ${v.nodes.join("\n    ")}`).join("\n"),
      ).toEqual([]);
    }, 30_000);
  }

  /**
   * Zoom to 200% without horizontal scroll or clipping (§8), checked the only way it can be
   * without a browser: by the things that break it.
   *
   * A viewport meta that blocks zoom, a fixed pixel width wider than a phone, and a horizontally
   * scrolling container outside the two places §9 allows one. Reflow (WCAG 1.4.10) is what this
   * SC is really about, and those three are what defeat it.
   */
  it("does not prevent zoom, and has nothing fixed wider than a phone", () => {
    for (const route of ROUTES) {
      const markup = html[route.name]!;

      // 1.4.4 and 1.4.10: never disable the pinch.
      expect(markup, `${route.name} blocks zoom`).not.toMatch(/user-scalable\s*=\s*no/);
      expect(markup, `${route.name} caps the zoom`).not.toMatch(/maximum-scale\s*=\s*[01]/);
      expect(markup).toContain("width=device-width");

      /*
       * A fixed width of three digits or more, in pixels. `max-w-[1160px]` is allowed — a maximum
       * shrinks — and so is anything under 100px. A `w-[900px]` is what produces a horizontal
       * scrollbar at 200% zoom on a 360px phone.
       */
      const fixedWidths = [...markup.matchAll(/(?:^|[\s"])(?:min-)?w-\[(\d{3,})px\]/g)].map((m) => m[1]);
      expect(fixedWidths, `${route.name} has a fixed width wider than a phone`).toEqual([]);

      /*
       * A horizontal scroller is a reflow failure (WCAG 1.4.10) EXCEPT on content the SC itself
       * excepts: "content that requires two-dimensional layout for usage or meaning" — a code
       * block, a data table. §9 allows it for the admin tables; on a public page the only instance
       * is the crawler's User-Agent string on /bot, which must not wrap because somebody is going
       * to copy it into a robots.txt.
       *
       * So the rule is: a scroller is allowed only on an element that is also monospaced.
       */
      const scrollers = [...markup.matchAll(/class="([^"]*overflow-x-(?:auto|scroll)[^"]*)"/g)].map(
        (m) => m[1]!,
      );
      const layoutScrollers = scrollers.filter((classes) => !/font-mono/.test(classes));
      expect(
        layoutScrollers,
        `${route.name} scrolls horizontally on something that is not a code block`,
      ).toEqual([]);
    }
  });

  it("announces what it changes, and says what is happening while it happens", () => {
    // §8: aria-live polite on the results count and on toasts. §6.3: an inline pending state that
    // keeps the button's label rather than replacing the page with a spinner.
    expect(html["/opportunities"]).toMatch(/aria-live="polite"/);

    const island = readFileSync(
      new URL("../src/components/EligibilityCheck.svelte", import.meta.url),
      "utf8",
    );
    expect(island).toContain('aria-live="polite"');
    expect(island).toContain('status === "checking" ? "Checking…"');
    expect(island).toContain('disabled={status === "checking"}');
    expect(island).not.toMatch(/animate-spin|<Spinner/);
  });

  it("gives every date a machine-readable form (§8)", () => {
    // "<time datetime> on every date". Asserted on the detail page, which is the one with the most
    // dates on it — a deadline, an opening date, event dates and a verification date.
    const detail = html["/opportunities/[slug]"]!;
    const times = [...detail.matchAll(/<time\b[^>]*>/g)];
    expect(times.length, "no <time> element on the page with the most dates on it").toBeGreaterThan(0);
    for (const time of times) {
      expect(time[0], `a <time> with no datetime: ${time[0]}`).toMatch(/datetime="[^"]+"/);
    }
  });

  it("covers every public page in src/pages (guards against a route added and never audited)", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const { join, relative, resolve } = await import("node:path");
    const { dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const pagesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "pages");

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });

    // Private routes are not "public routes" and are audited by their own suites; endpoints have
    // no DOM to audit.
    const PRIVATE = ["admin", "you", "threads", "requests", "tracker", "projects", "auth", "api"];
    const publicPages = walk(pagesDir)
      .filter((file) => file.endsWith(".astro"))
      .map((file) => relative(pagesDir, file).split(/[\\/]/).join("/"))
      .filter((route) => !PRIVATE.includes(route.split("/")[0]!.replace(/\.astro$/, "")))
      // The room, intent and team forms live under /opportunities/<slug>/ and are social
      // surfaces behind a density flag, audited in room-route.test.ts.
      .filter((route) => !/^opportunities\/\[slug\]\//.test(route));

    const audited = new Set(
      ROUTES.map((route) =>
        route.name === "/"
          ? "index.astro"
          : `${route.name.replace(/^\//, "").replace(/\[(\w+)\]/g, "[$1]")}.astro`,
      ),
    );

    const missing = publicPages.filter((page) => {
      const normalised = page.replace(/\/index\.astro$/, ".astro");
      return !audited.has(page) && !audited.has(normalised) && !audited.has(page.replace(/\.astro$/, "/index.astro"));
    });

    expect(missing, `public routes with no axe audit: ${missing.join(", ")}`).toEqual([]);
  });
});
