/**
 * Phase 6's acceptance criteria, as route behaviour.
 *
 *   "Matched opportunities render within seconds of project creation, BEFORE ANY OTHER
 *    PROMPT."                                           (IMPLEMENTATION_PLAN.md §8, §9.1 `[PR]`)
 *   "A private project still receives matches."          (COLLABORATION_SYSTEM.md §1.1 `[PR]`)
 *   "Public project browse does not exist below 40 public projects — the route is absent,
 *    not empty."                                         (UX_FLOWS.md §9.3 `[PR]`)
 *
 * The first is an ORDERING claim about one page, which no database assertion can make: the
 * matches and the progressive prompts both exist, and the criterion is about which comes
 * first. So it is asserted on the rendered HTML, by position.
 */

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import svelteRenderer from "@astrojs/svelte/server.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_USER = {
  id: "bbbb2222-2222-2222-2222-222222222222",
  email: "owner@example.invalid",
  handle: null,
  display_name: "Project Owner",
  is_admin: false,
  admin_role: null,
  account_state: "active",
  age_confirmed_18: true,
  timezone: "Africa/Harare",
  low_data_mode: false,
};

const state = {
  visibility: "private" as "private" | "unlisted" | "public",
  indexable: false,
  matches: 3,
  matchedAt: "2026-09-13T00:00:00Z" as string | null,
  browse: "open" as "open" | "below_floor" | "disabled",
  publicProjects: 47,
  owner: SESSION_USER.id,
  // A project with a title and pitch only, which is what §1.2's two-field creation leaves.
  pitch: null as string | null,
};

const PROJECT = () => ({
  id: "project-1",
  slug: "irrigation-monitor-7f3a91",
  owner_user_id: state.owner,
  title: "Irrigation monitor",
  pitch: state.pitch,
  problem: null,
  solution: null,
  target_users: null,
  state: "idea",
  visibility: state.visibility,
  indexable: state.indexable,
  category_ids: [],
  industry_ids: [],
  skill_ids: [],
  technology_ids: [],
  roles_needed: [],
  repo_url: null,
  demo_url: null,
  docs_url: null,
  country_iso2: null,
  state_changed_at: "2026-09-13T00:00:00Z",
  last_activity_at: "2026-09-13T00:00:00Z",
  matched_at: state.matchedAt,
  created_at: "2026-09-13T00:00:00Z",
  deleted_at: null,
});

const MATCHES = () =>
  Array.from({ length: state.matches }, (_, i) => ({
    opportunity_id: `opp-${i}`,
    slug: `call-${i}`,
    title: `An open call number ${i + 1}`,
    organisation_name: "Example Foundation",
    deadline_at: "2026-10-01T00:00:00Z",
    deadline_precision: "date_only",
    is_rolling: false,
    cost: "free",
    verdict: i === 0 ? "eligible" : "likely_eligible",
    score: 0.8 - i / 100,
    rank: i + 1,
    reasons: ["AgriTech", "you're eligible", "closes in 17 days"],
    tracked: false,
  }));

const rpc = async (fn: string) => {
  switch (fn) {
    case "project_matches":
      return { data: MATCHES(), error: null };
    case "project_browse_state":
      return {
        data: [{ state: state.browse, public_projects: state.publicProjects, floor: 40 }],
        error: null,
      };
    case "project_match_candidates":
      return { data: [], error: null };
    case "replace_project_matches":
      return { data: state.matches, error: null };
    case "room_state":
      return { data: [{ state: "disabled", intent_count: 0, team_count: 0, reason: "off" }], error: null };
    default:
      return { data: null, error: null };
  }
};

/** A chain that resolves to whatever table it started from. */
function tableStub(table: string) {
  const rows: Record<string, unknown[]> = {
    projects: [PROJECT()],
    project_members: [
      {
        user_id: state.owner,
        is_owner: true,
        joined_at: "2026-09-13T00:00:00Z",
        users: { display_name: "Project Owner" },
        tags: null,
      },
    ],
    project_submissions: [],
    tags: [],
    countries: [],
  };
  const result = { data: rows[table] ?? [], error: null };
  const single = { data: (rows[table] ?? [])[0] ?? null, error: null };
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    maybeSingle: async () => single,
    single: async () => single,
  };
  for (const method of ["select", "eq", "is", "neq", "in", "order", "limit", "update", "upsert", "delete", "insert"]) {
    chain[method] = () => chain;
  }
  return chain;
}

vi.mock("../src/lib/auth", () => ({
  getSessionUser: vi.fn(async () => SESSION_USER),
  createAuthClient: vi.fn(() => ({ rpc, from: (t: string) => tableStub(t) })),
  socialWritesAllowed: vi.fn(() => ({ allowed: true, reason: null })),
  personalWritesAllowed: vi.fn(() => true),
  safeReturnTo: (v: string | null) => v ?? "/",
}));

vi.mock("../src/lib/db", () => ({
  getClient: vi.fn(() => ({ rpc, from: (t: string) => tableStub(t) })),
  getOpportunity: vi.fn(async () => ({ ok: false, reason: "not_found" })),
  isFlagEnabled: vi.fn(async () => false),
}));

/**
 * Astro escapes interpolated text, so an apostrophe arrives as `&#39;`. Asserting against
 * the escaped form works but reads like a trap for the next person, so the comparisons below
 * are made against decoded text instead.
 */
const plain = (html: string) =>
  html
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

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

const detail = (query = "") =>
  render(
    () => import("../src/pages/projects/[slug].astro"),
    { slug: "irrigation-monitor-7f3a91" },
    `https://example.invalid/projects/irrigation-monitor-7f3a91${query}`,
  );

const browse = () =>
  render(() => import("../src/pages/projects/index.astro"), {}, "https://example.invalid/projects");

beforeEach(() => {
  state.visibility = "private";
  state.indexable = false;
  state.matches = 3;
  state.matchedAt = "2026-09-13T00:00:00Z";
  state.browse = "open";
  state.publicProjects = 47;
  state.owner = SESSION_USER.id;
  state.pitch = null;
});

describe("§9.1 the matches come first", () => {
  it("renders matched calls before any progressive prompt, right after creation", async () => {
    const html = await (await detail("?created=1")).text();

    const matchesAt = html.indexOf("Open calls this matches");
    const promptAt = html.indexOf("Add a one-line pitch");

    expect(matchesAt, "the match list is missing from the page after creation").toBeGreaterThan(-1);
    expect(promptAt, "the progressive prompt is missing, so the ordering is untested").toBeGreaterThan(
      -1,
    );
    // The whole criterion, in one comparison.
    expect(matchesAt).toBeLessThan(promptAt);
  });

  it("names how many matched and how many the owner is eligible for", async () => {
    const html = await (await detail("?created=1")).text();
    expect(html).toContain("3 open calls match this project");
    expect(html).toContain("eligible for 1 of");
  });

  it("carries a verdict and a one-tap track action on each match (§1.5)", async () => {
    const html = await (await detail()).text();
    expect(html).toContain("Eligible");
    expect(html).toContain("/tracker?add=call-0");
  });

  it("shows the templated reasons rather than a generated sentence", async () => {
    const html = plain(await (await detail()).text());
    expect(html).toContain("AgriTech · you're eligible · closes in 17 days");
  });
});

describe("§1.1 a private project still receives matches", () => {
  it("renders the match list for a project nobody else can see", async () => {
    state.visibility = "private";
    const html = await (await detail()).text();
    expect(html).toContain("Private to you");
    expect(html).toContain("Matched open calls");
    expect(html).toContain("An open call number 1");
  });

  it("says so honestly when there is nothing open the owner can enter", async () => {
    state.matches = 0;
    const html = plain(await (await detail()).text());
    expect(html).toContain("Nothing open matches this that you're eligible for");
    // Not an error state, and not padded with things they cannot enter.
    expect(html).not.toContain("An open call number");
  });

  it("distinguishes 'not matched yet' from 'nothing matched'", async () => {
    state.matches = 0;
    state.matchedAt = null;
    const html = plain(await (await detail()).text());
    expect(html).toContain("We haven't matched this yet");
  });
});

describe("visibility and indexing", () => {
  it("is noindex while private", async () => {
    const html = await (await detail()).text();
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });

  it("is noindex when public but not opted in to indexing (§1.4 [PR])", async () => {
    state.visibility = "public";
    state.indexable = false;
    const html = await (await detail()).text();
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });

  it("is indexable only when public AND indexable", async () => {
    state.visibility = "public";
    state.indexable = true;
    const html = await (await detail()).text();
    expect(html).not.toContain('content="noindex, nofollow"');
  });

  it("shows another person's project without its matches", async () => {
    // The matches are derived from the OWNER's eligibility profile, which is theirs alone.
    state.owner = "cccc3333-3333-3333-3333-333333333333";
    state.visibility = "public";
    const html = await (await detail()).text();
    expect(html).not.toContain("Matched open calls");
    expect(html).not.toContain("An open call number 1");
    expect(html).toContain("Express interest");
  });
});

describe("§9.3 project browse is absent below its floor", () => {
  it("renders the browse list when the floor is met", async () => {
    state.browse = "open";
    const res = await browse();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("projects people have chosen to show");
  });

  it("404s below the floor, with no 'coming soon'", async () => {
    state.browse = "below_floor";
    state.publicProjects = 12;
    const res = await browse();
    expect(res.status).toBe(404);
    const html = plain(await res.text());
    expect(html).not.toMatch(/coming soon/i);
    // And it must not leak how close the floor is — that is an operator's number, and
    // "12 of the 40 we need" tells a visitor the place is empty.
    expect(html).not.toMatch(/\d+ projects?/);
    expect(html).not.toMatch(/\d+ public projects/);
    // The floor itself must not appear. Checked against the page's TEXT rather than its
    // markup: a bare "40" also occurs inside Tailwind class names like `z-40`, so the
    // markup form of this assertion failed the moment the shell grew a fixed nav bar —
    // it was measuring the stylesheet, not what the visitor reads.
    expect(html.replace(/<[^>]*>/g, " ")).not.toMatch(/\b40\b/);
  });

  it("404s when the flag is off, whatever the count says", async () => {
    state.browse = "disabled";
    state.publicProjects = 900;
    const res = await browse();
    expect(res.status).toBe(404);
  });
});
