/**
 * The public profile, as route behaviour. UX_FLOWS.md §8.1–8.2, COLLABORATION_SYSTEM.md §5.
 *
 * `supabase/tests/profiles.sql` asserts who the database will show a profile to. What it
 * cannot assert is what the PAGE does with the answer, and three of those things are the whole
 * point of the feature:
 *
 *   A profile the function declines to return must be a 404 that says nothing — not "this is
 *   private", which tells a stranger somebody is there.
 *   A page must carry `noindex` unless its owner opted in SEPARATELY from making it public.
 *   No contact detail may appear on it, at any visibility, ever.
 */

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import svelteRenderer from "@astrojs/svelte/server.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const VIEWER = {
  id: "aaaa1111-1111-1111-1111-111111111111",
  email: "viewer@example.invalid",
  handle: "viewer",
  display_name: "A Viewer",
  is_admin: false,
  admin_role: null,
  account_state: "active",
  age_confirmed_18: true,
  timezone: "Africa/Harare",
  low_data_mode: false,
};

const PROFILE = () => ({
  user_id: "bbbb2222-2222-2222-2222-222222222222",
  handle: "tadiwa-m",
  display_name: "Tadiwa M",
  visibility: state.visibility,
  indexable: state.indexable,
  headline: "Backend developer, mostly Go",
  bio: "Two hackathons this year.\nStill learning Rust.",
  country_iso2: "ZW",
  country_name: "Zimbabwe",
  country_slug: "zimbabwe",
  city: "Bulawayo",
  github_url: "https://github.example/tadiwa",
  portfolio_url: null,
  other_url: null,
  open_to: ["hackathon_teams", "mentoring"],
  availability_hours_per_week: 6,
  shared_context: state.sharedContext,
  shared_opportunity_slug: state.sharedContext ? "harare-climate-data-challenge" : null,
  updated_at: "2026-09-01T00:00:00Z",
});

const state = {
  found: true,
  visibility: "public" as "public" | "discoverable_in_rooms" | "private",
  indexable: false,
  sharedContext: false,
  signedIn: false,
  projects: [] as unknown[],
};

const tableStub = (table: string) => {
  const rows = table === "projects" ? state.projects : [];
  const result = { data: rows, error: null };
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    single: async () => ({ data: rows[0] ?? null, error: null }),
  };
  for (const method of ["select", "eq", "is", "in", "not", "order", "limit", "insert", "update", "upsert", "delete"]) {
    chain[method] = () => chain;
  }
  return chain;
};

const client = () => ({
  from: (table: string) => tableStub(table),
  rpc: async (fn: string) =>
    fn === "public_profile"
      ? { data: state.found ? [PROFILE()] : [], error: null }
      : { data: null, error: null },
});

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/auth")>()),
  getSessionUser: vi.fn(async () => (state.signedIn ? VIEWER : null)),
  createAuthClient: vi.fn(() => (state.signedIn ? client() : null)),
  socialWritesAllowed: vi.fn(() => ({ allowed: true, reason: null })),
  personalWritesAllowed: vi.fn(() => true),
}));

vi.mock("../src/lib/db", () => ({
  getClient: vi.fn(() => client()),
  getEntryPoints: vi.fn(async () => ({
    countries: [{ iso2: "ZW", name: "Zimbabwe", slug: "zimbabwe" }],
    categories: [],
  })),
}));

vi.mock("../src/lib/errors", () => ({ reportError: vi.fn(async () => undefined) }));

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

const profilePage = (handle = "tadiwa-m") =>
  render(() => import("../src/pages/b/[handle].astro"), { handle }, `https://example.invalid/b/${handle}`);

const editorPage = () =>
  render(() => import("../src/pages/you/profile.astro"), {}, "https://example.invalid/you/profile");

const plain = (html: string) =>
  html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

beforeEach(() => {
  state.found = true;
  state.visibility = "public";
  state.indexable = false;
  state.sharedContext = false;
  state.signedIn = false;
  state.projects = [];
});

describe("a profile nobody may see (UX_FLOWS.md §8.2)", () => {
  it("is a 404 that gives nothing away", async () => {
    state.found = false;
    const response = await profilePage("quietbuilder");
    const html = plain(await response.text());

    expect(response.status).toBe(404);
    expect(html).toContain("There's nothing at this address");
    // Not "private", not "hidden", not "this user has restricted their profile". Matched
    // against the page's own text only: the footer links to /privacy on every page, and an
    // assertion that reads the whole document would be asserting something about the footer.
    const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
    expect(main).not.toMatch(/private|restricted|hidden|suspended/i);
    // The handle itself is fine to echo — it is what the visitor typed, and the sign-in link
    // carries the path back. What must not appear is any statement about WHY there is nothing
    // here, which is the only thing that would distinguish a private profile from a typo.
    expect(main).not.toMatch(/exists|taken down|deactivated|not public/i);
  });
});

describe("a profile that is public", () => {
  it("shows what §5.2 allows and nothing more", async () => {
    const html = plain(await (await profilePage()).text());

    expect(html).toContain("Tadiwa M");
    expect(html).toContain("Backend developer, mostly Go");
    expect(html).toContain("Bulawayo, Zimbabwe");
    expect(html).toContain("Hackathon teams");
    expect(html).toContain("About 6 hours a week");
    expect(html).toContain("https://github.example/tadiwa");
  });

  it("carries no contact detail of any kind, and says so", async () => {
    const html = plain(await (await profilePage()).text());

    expect(html).not.toMatch(/mailto:/);
    expect(html).not.toMatch(/@example\.invalid/);
    expect(html).not.toMatch(/\bt\.me\//);
    expect(html).not.toMatch(/whatsapp|telegram handle|phone/i);
    expect(html).toContain("There is no contact detail on this page");
  });

  it("is noindex until the owner opts in separately", async () => {
    const off = plain(await (await profilePage()).text());
    expect(off).toContain('name="robots"');
    expect(off).toContain("noindex");

    state.indexable = true;
    const on = plain(await (await profilePage()).text());
    expect(on).not.toContain('name="robots"');
    // And it self-canonicalises once it is indexable (SEO.md §5).
    expect(on).toContain('rel="canonical"');
    expect(on).toContain("/b/tadiwa-m");
  });

  it("is never stored by a shared cache, because the same URL answers differently per viewer", async () => {
    const response = await profilePage();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("links an outbound URL as untrusted user content", async () => {
    const html = await (await profilePage()).text();
    const link = html.match(/<a[^>]+href="https:\/\/github\.example[^"]*"[^>]*>/)?.[0] ?? "";
    expect(link).toContain("nofollow");
    expect(link).toContain("noopener");
    expect(link).toContain("ugc");
  });

  it("lists public projects only", async () => {
    state.projects = [
      { slug: "borehole-monitor-a1b2c3", title: "Borehole monitor", pitch: "Sensors on a well", state: "building" },
    ];
    const html = plain(await (await profilePage()).text());
    expect(html).toContain("Borehole monitor");
    expect(html).toContain("Building");
  });
});

describe("getting in touch happens from a shared context, or not at all", () => {
  it("offers nothing to a signed-out reader", async () => {
    const html = plain(await (await profilePage()).text());
    expect(html).not.toContain("Send a request");
    expect(html).not.toContain("Block this person");
  });

  it("offers block and report to a signed-in stranger, but no request", async () => {
    state.signedIn = true;
    const html = plain(await (await profilePage()).text());

    expect(html).not.toContain("Send a request");
    expect(html).toContain("Block this person");
    expect(html).toContain("/report?profile=tadiwa-m");
  });

  it("offers a request only when the database says a context is shared", async () => {
    state.signedIn = true;
    state.sharedContext = true;
    const html = plain(await (await profilePage()).text());

    expect(html).toContain("Send a request");
    // Carrying the opportunity as well as the person: the composer needs both.
    expect(html).toContain("builder=bbbb2222-2222-2222-2222-222222222222");
    expect(html).toContain("opportunity=harare-climate-data-challenge");
    expect(html).toContain("You are both interested in the same opportunity");
  });
});

describe("the editor (UX_FLOWS.md §8.1)", () => {
  it("explains all three visibility levels in words, not labels alone", async () => {
    state.signedIn = true;
    const html = plain(await (await editorPage()).text());

    expect(html).toContain("Nobody can open your page");
    expect(html).toContain("declared interest in the same opportunity");
    expect(html).toContain("Anyone with the link can open your page");
  });

  it("keeps the search-engine opt-in separate from the visibility choice", async () => {
    state.signedIn = true;
    const html = plain(await (await editorPage()).text());

    expect(html).toContain('name="indexable"');
    expect(html).toContain("Separate from the choice above, and off unless you turn it on");
  });

  it("asks for no contact detail, and says why", async () => {
    state.signedIn = true;
    const html = plain(await (await editorPage()).text());

    expect(html).not.toMatch(/name="(email|phone|telegram|whatsapp)[^"]*"/);
    expect(html).toContain("No email address, phone number or messaging handle");
  });

  it("collects nothing from the private layer", async () => {
    state.signedIn = true;
    const html = await (await editorPage()).text();
    for (const field of ["birth_year", "student_status", "nationalities", "gender", "institution"]) {
      expect(html, `${field} must not be on the public profile form`).not.toContain(`name="${field}`);
    }
  });

  it("needs no JavaScript: it is a form that posts to itself", async () => {
    state.signedIn = true;
    const html = await (await editorPage()).text();
    expect(html).toContain('method="post"');
    expect(html).not.toContain("astro-island");
  });
});
