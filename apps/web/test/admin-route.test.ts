/**
 * The admin surfaces, as route behaviour. ADMIN_SYSTEM.md §12 and Phase 8's criteria.
 *
 * Two of Phase 8's five acceptance criteria are route claims:
 *
 *   "All queues clearable one-handed on a phone."   `[PR]`
 *   "Admin routes stay within the 200 KB budget."   `[PR]`
 *
 * The second is measured in byte-budget-ssr.test.ts. The first cannot be asserted directly —
 * no test holds a phone — so what is asserted here are the properties that make it true and
 * whose loss would make it false: every action is a plain form button reachable without
 * JavaScript, every touch target carries the 44px minimum height the design system sets, and
 * nothing on the page needs a horizontal scroll.
 *
 * Also asserted: the role ladder, at the route level. §1 keeps accounts away from reviewers
 * and the audit log away from everyone but a superadmin, and a 404 — never a 403 — is what a
 * caller without the role sees, because a 403 confirms the page exists.
 */

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import svelteRenderer from "@astrojs/svelte/server.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  isAdmin: true,
  role: "superadmin" as string | null,
};

const SESSION = () => ({
  id: "eeee5555-5555-5555-5555-555555555555",
  email: "operator@example.invalid",
  handle: null,
  display_name: "An Operator",
  is_admin: state.isAdmin,
  admin_role: state.role,
  account_state: "active",
  age_confirmed_18: true,
  timezone: "Africa/Harare",
  low_data_mode: false,
});

const QUEUE_ITEMS = [
  {
    queue_id: "q1",
    subject_type: "opportunity",
    subject_id: "opp-1",
    priority: 3,
    state: "open",
    claimed_by_name: null,
    claimed_by_me: false,
    age_hours: 80,
    breached: true,
    title: "A record waiting for review",
    detail: "Kumasi Hive · auto · confidence 0.71",
  },
];

const REVIEW_CARD = {
  opportunity: {
    id: "opp-1",
    slug: "a-record",
    title: "A record waiting for review",
    status: "in_review",
    verification: "auto",
    confidence: 0.71,
    summary: "A summary.",
    deadline_at: "2026-09-30T23:59:59Z",
    deadline_precision: "date_only",
    deadline_raw: "Applications close September 30",
    cost: "free",
    cost_description: null,
    eligibility_scope: "africa_wide",
    eligible_countries: [],
    team_required: true,
    team_size_min: 2,
    team_size_max: 5,
    source_url: "https://example.invalid/source",
    official_url: null,
    apply_url: null,
    organisation: "Kumasi Hive",
    organisation_slug: "kumasi-hive",
    category: "Hackathon",
    source_name: "A source",
    source_trust: 0.6,
    submitted_by: null,
    tracked_by: 3,
  },
  rules: [
    {
      id: "r1",
      rule_type: "age_between",
      params: { min: 18, max: 35 },
      source_quote: "Applicants must be between 18 and 35.",
      confidence: 0.62,
      high_stakes: true,
      reviewed_at: null,
    },
    {
      id: "r2",
      rule_type: "country_in",
      params: { countries: ["ZW"] },
      source_quote: "Open to residents of Zimbabwe.",
      confidence: 0.88,
      high_stakes: true,
      reviewed_at: null,
    },
  ],
  reports: [],
  duplicates: [],
};

const rpc = async (fn: string) => {
  const answers: Record<string, unknown> = {
    admin_dashboard: {
      generated_at: "2026-09-15T08:00:00Z",
      queues: [
        { queue: "report_scam", open: 2, claimed: 0, sla_hours: 12, oldest_hours: 19, breached: true },
      ],
      sources: { total: 3, active: 1, degraded: 0, awaiting_tos: 2 },
      ingestion: { last_success_at: null, minutes_ago: null, silent: true },
      ai: [],
      email: { used: 10, cap: 280, exhausted_at: null },
      database_mb: 12.5,
      database_near_limit: false,
      catalogue: { published: 3, in_review: 1, draft: 0, stale: 0, disputed: 0, expired: 0 },
      today: { published: 1, expired: 0, reports: 2, reports_resolved: 0, signups: 4 },
      extraction_quality: { reviews: 50, approved_unedited_pct: 58 },
      unnotified_alerts: 1,
    },
    admin_queue: QUEUE_ITEMS,
    admin_review_card: REVIEW_CARD,
    admin_report_inbox: [],
    admin_user_search: [],
    admin_sources: [],
    admin_audit_search: [],
    admin_density_status: [],
  };
  return { data: answers[fn] ?? null, error: null };
};

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/auth")>()),
  getSessionUser: vi.fn(async () => SESSION()),
  createAuthClient: vi.fn(() => ({
    rpc,
    from: () => {
      const chain: Record<string, unknown> = {
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null, count: 0 }).then(resolve),
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
      };
      for (const m of ["select", "eq", "is", "in", "order", "limit", "update", "upsert", "delete", "insert"]) {
        chain[m] = () => chain;
      }
      return chain;
    },
  })),
  socialWritesAllowed: vi.fn(() => ({ allowed: true, reason: null })),
  personalWritesAllowed: vi.fn(() => true),
  safeReturnTo: (v: string | null) => v ?? "/",
}));

vi.mock("../src/lib/db", () => ({
  getClient: vi.fn(() => ({ rpc })),
  isFlagEnabled: vi.fn(async () => false),
}));

async function render(
  importer: () => Promise<{ default: unknown }>,
  params: Record<string, string>,
  url: string,
): Promise<Response> {
  const container = await AstroContainer.create();
  container.addServerRenderer({ name: "@astrojs/svelte", renderer: svelteRenderer });
  container.addClientRenderer({ name: "@astrojs/svelte", entrypoint: "@astrojs/svelte/client.js" });
  const { default: Page } = await importer();
  return container.renderToResponse(Page as never, {
    params,
    locals: { runtime: { env: {} } },
    request: new Request(url),
  });
}

const plain = (html: string) =>
  html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const dashboard = () =>
  render(() => import("../src/pages/admin/index.astro"), {}, "https://example.invalid/admin");

const queuePage = () =>
  render(
    () => import("../src/pages/admin/queues/[queue].astro"),
    { queue: "low_confidence" },
    "https://example.invalid/admin/queues/low_confidence",
  );

const usersPage = () =>
  render(() => import("../src/pages/admin/users.astro"), {}, "https://example.invalid/admin/users");

const auditPage = () =>
  render(() => import("../src/pages/admin/audit.astro"), {}, "https://example.invalid/admin/audit");

beforeEach(() => {
  state.isAdmin = true;
  state.role = "superadmin";
});

describe("§2 the dashboard answers 'is anything wrong'", () => {
  it("leads with what needs a person, and marks what is past its SLA", async () => {
    const html = plain(await (await dashboard()).text());
    expect(html).toContain("Needs you");
    expect(html).toContain("2 scam reports");
    expect(html).toContain("past SLA");
  });

  it("says when ingestion has gone quiet, rather than showing a healthy-looking blank", async () => {
    const html = plain(await (await dashboard()).text());
    expect(html).toContain("silent for over 8 hours");
  });

  it("flags the extraction-quality number when it drops below 60%", async () => {
    const html = plain(await (await dashboard()).text());
    expect(html).toContain("58% of the last 50 reviews");
    expect(html).toContain("creating work rather than saving it");
  });

  it("carries no vanity metric and no chart (§2 [PR])", async () => {
    const html = plain(await (await dashboard()).text()).toLowerCase();
    for (const word of ["impressions", "page views", "followers", "engagement", "<canvas"]) {
      expect(html, `dashboard contains ${word}`).not.toContain(word);
    }

    // `<svg` used to be banned outright as a proxy for "no chart". It stopped being one
    // when the shell grew an icon set: ADMIN_SYSTEM.md §12 has the admin wrap the public
    // layout on purpose — "same design system as the public product" — so the header and
    // footer icons arrive here too. The rule is still no chart, so it is now stated as
    // what a chart actually is: every svg on this page must be one of the 24-box icons
    // from components/Icon.astro. A plotted chart would not be.
    for (const tag of html.match(/<svg\b[^>]*>/g) ?? []) {
      expect(tag, `non-icon svg on the dashboard: ${tag}`).toContain('viewbox="0 0 24 24"');
    }
  });
});

describe("§3 the queue is clearable one-handed", () => {
  it("shows the review card with every rule beside its quote, worst confidence first", async () => {
    const html = plain(await (await queuePage()).text());
    expect(html).toContain("A record waiting for review");
    expect(html).toContain("Applicants must be between 18 and 35.");
    expect(html).toContain("Open to residents of Zimbabwe.");
    // §3.1: low confidence first. The 0.62 rule must appear before the 0.88 one.
    expect(html.indexOf("18 and 35")).toBeLessThan(html.indexOf("residents of Zimbabwe"));
  });

  it("puts every action in a plain form, so it works with no JavaScript at all", async () => {
    const html = await (await queuePage()).text();
    // Three decisions and a claim, all POSTs.
    expect(html).toContain('name="publish"');
    expect(html).toContain('name="reject"');
    expect(html).toContain('name="claim"');
    expect(html).toMatch(/<form method="post"/);
    // And nothing that needs a bundle: no island on any admin route.
    expect(html).not.toContain("astro-island");
  });

  it("gives every control the 44px touch target the design system sets", async () => {
    const html = await (await queuePage()).text();
    const buttons = [...html.matchAll(/<button[^>]*class="([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(buttons.length).toBeGreaterThan(3);
    for (const cls of buttons) {
      expect(cls, `a button without a minimum height: ${cls}`).toContain("min-h-11");
    }
  });

  it("needs no horizontal scrolling — nothing is laid out side by side at phone width", async () => {
    const html = await (await queuePage()).text();
    expect(html).not.toContain("overflow-x");
    // A fixed or minimum width in the hundreds of pixels is what forces a sideways scroll.
    // `max-w-[1160px]` is the opposite — it caps the line length — so the pattern has to
    // exclude it rather than match any `w-[...]`, which an earlier version of this
    // assertion did and failed on the layout's own measure.
    expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d{3,}px\]/);
  });

  it("requires a source quote in the rule editor, in the markup as well as the database", async () => {
    const html = await (await queuePage()).text();
    const quoteField = html.match(/<textarea[^>]*name="source_quote"[^>]*>/)?.[0] ?? "";
    expect(quoteField, "the rule editor has no source_quote field").not.toBe("");
    expect(quoteField).toContain("required");
    expect(quoteField).toContain('minlength="10"');
  });

  it("asks for a reason before a rejection, in the form", async () => {
    const html = await (await queuePage()).text();
    const reject = html.match(/<form method="post"[^>]*>(?:(?!<\/form>)[\s\S])*name="reject"[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(reject).not.toBe("");
    expect(reject).toMatch(/name="reason"[^>]*required|required[^>]*name="reason"/);
  });
});

describe("§1 the role ladder, at the route level", () => {
  it("shows a non-admin a 404, never a 403", async () => {
    state.isAdmin = false;
    state.role = null;
    const res = await dashboard();
    expect(res.status).toBe(404);
    const html = plain(await res.text());
    expect(html).toContain("Nothing here");
    // Nothing about the admin area exists as far as this reader is concerned.
    expect(html).not.toContain("Needs you");
    expect(html.toLowerCase()).not.toContain("permission");
  });

  it("keeps accounts away from a reviewer entirely (§1)", async () => {
    state.role = "reviewer";
    const res = await usersPage();
    expect(res.status).toBe(404);
    expect(plain(await res.text())).not.toContain("reporter weight");
  });

  it("keeps the audit log to a superadmin (§11)", async () => {
    state.role = "moderator";
    const res = await auditPage();
    expect(res.status).toBe(404);
  });

  it("shows a reviewer only the sections they can use", async () => {
    state.role = "reviewer";
    const html = plain(await (await queuePage()).text());
    expect(html).toContain("Queues");
    expect(html).not.toContain(">People<");
    expect(html).not.toContain(">Audit<");
  });

  it("shows a superadmin everything", async () => {
    state.role = "superadmin";
    const html = plain(await (await queuePage()).text());
    expect(html).toContain(">People<");
    expect(html).toContain(">Audit<");
  });
});
