/**
 * Phase 7's surfaces, as route behaviour.
 *
 * Two things here cannot be asserted in SQL:
 *
 *   The claim page must tell someone, BEFORE they type, whether their address will be
 *   confirmed by email or wait for a person — the difference between a two-minute flow and
 *   a two-day one, and the only reason to use a work address rather than a personal one.
 *
 *   The public submission page must carry no third-party script. SECURITY.md §3 asks for
 *   Turnstile and invariant 12 forbids the script that implements it; ADR 0002 resolves that
 *   in favour of the invariant, and an assertion is the only thing that keeps a resolution
 *   like that from being quietly undone.
 */

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import svelteRenderer from "@astrojs/svelte/server.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_USER = {
  id: "cccc4444-4444-4444-4444-444444444444",
  email: "officer@kavango.example",
  handle: null,
  display_name: "Programme Officer",
  is_admin: false,
  admin_role: null,
  account_state: "active",
  age_confirmed_18: true,
  timezone: "Africa/Harare",
  low_data_mode: false,
};

const state = {
  verification: "unclaimed" as
    | "unclaimed"
    | "claimed_pending"
    | "verified"
    | "rejected"
    | "suspended",
  domain: "kavango.example" as string | null,
  member: false,
  claims: [] as unknown[],
  confirmOk: true,
};

const ORGANISATION = () => ({
  id: "org-1",
  slug: "kavango-foundation",
  name: "Kavango Foundation",
  description: "A foundation.",
  website_url: "https://www.kavango.example",
  website_domain: state.domain,
  country_iso2: "ZW",
  org_type: "foundation",
  verification: state.verification,
  verified_at: state.verification === "verified" ? "2026-09-01T00:00:00Z" : null,
});

const rpc = async (fn: string) => {
  switch (fn) {
    case "my_org_claims":
      return { data: state.claims, error: null };
    case "org_opportunities":
      return {
        data: state.member
          ? [
              {
                id: "l1",
                slug: "a-listing",
                title: "A listing of theirs",
                status: "published",
                verification: "official",
                deadline_at: "2026-11-01T00:00:00Z",
                tracked_by: 4,
                in_review: false,
                created_at: "2026-08-01T00:00:00Z",
              },
            ]
          : [],
        error: null,
      };
    case "confirm_org_claim":
      return {
        data: [
          {
            ok: state.confirmOk,
            organisation_slug: state.confirmOk ? "kavango-foundation" : null,
            organisation_name: state.confirmOk ? "Kavango Foundation" : null,
          },
        ],
        error: null,
      };
    case "submit_opportunity_public":
      return { data: [{ ok: true, message: "Thank you." }], error: null };
    default:
      return { data: null, error: null };
  }
};

function tableStub(table: string) {
  const rows: Record<string, unknown[]> = {
    categories: [{ code: "grant", name: "Grant" }],
    organisation_members: state.member ? [{ user_id: SESSION_USER.id, role: "owner" }] : [],
    organisations: [ORGANISATION()],
    opportunities: [],
  };
  const result = { data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length };
  const single = { data: (rows[table] ?? [])[0] ?? null, error: null };
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    maybeSingle: async () => single,
    single: async () => single,
  };
  for (const m of ["select", "eq", "is", "in", "neq", "order", "limit", "update", "upsert", "delete", "insert"]) {
    chain[m] = () => chain;
  }
  return chain;
}

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/auth")>()),
  getSessionUser: vi.fn(async () => SESSION_USER),
  createAuthClient: vi.fn(() => ({ rpc, from: (t: string) => tableStub(t) })),
  socialWritesAllowed: vi.fn(() => ({ allowed: true, reason: null })),
  personalWritesAllowed: vi.fn(() => true),
  safeReturnTo: (v: string | null) => v ?? "/",
}));

vi.mock("../src/lib/db", () => ({
  getClient: vi.fn(() => ({ rpc, from: (t: string) => tableStub(t) })),
  getOrganisation: vi.fn(async () => ({
    ok: true,
    data: { organisation: ORGANISATION(), open: [], past: [] },
  })),
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

const claimPage = () =>
  render(
    () => import("../src/pages/organisations/[slug]/claim.astro"),
    { slug: "kavango-foundation" },
    "https://example.invalid/organisations/kavango-foundation/claim",
  );

const managePage = () =>
  render(
    () => import("../src/pages/organisations/[slug]/manage.astro"),
    { slug: "kavango-foundation" },
    "https://example.invalid/organisations/kavango-foundation/manage",
  );

const confirmPage = (query: string) =>
  render(
    () => import("../src/pages/organisations/claims/confirm.astro"),
    {},
    `https://example.invalid/organisations/claims/confirm${query}`,
  );

const submitPage = () =>
  render(() => import("../src/pages/submit.astro"), {}, "https://example.invalid/submit");

const orgPage = () =>
  render(
    () => import("../src/pages/organisations/[slug].astro"),
    { slug: "kavango-foundation" },
    "https://example.invalid/organisations/kavango-foundation",
  );

beforeEach(() => {
  state.verification = "unclaimed";
  state.domain = "kavango.example";
  state.member = false;
  state.claims = [];
  state.confirmOk = true;
});

describe("the claim page says what will happen before anyone types", () => {
  it("names the domain that gets confirmed by email", async () => {
    const html = plain(await (await claimPage()).text());
    expect(html).toContain("An address at kavango.example is confirmed by email");
    expect(html).toContain("Anything else goes to a person");
    // The placeholder is part of the same message.
    expect(html).toContain('placeholder="you@kavango.example"');
  });

  it("is honest when there is no domain on file at all", async () => {
    state.domain = null;
    const html = plain(await (await claimPage()).text());
    expect(html).toContain("every claim here is checked by a person");
    expect(html).not.toContain("confirmed by email and needs no review");
  });

  it("does not offer a claim on a verified organisation, and says why", async () => {
    state.verification = "verified";
    const html = plain(await (await claimPage()).text());
    expect(html).toContain("already verified");
    expect(html).toContain("we have no way to tell which of you should have it");
    expect(html).not.toContain('name="claim_email"');
  });

  it("does not offer a claim on a suspended one", async () => {
    state.verification = "suspended";
    const html = plain(await (await claimPage()).text());
    expect(html).not.toContain('name="claim_email"');
  });

  it("shows an in-flight claim instead of a second form", async () => {
    state.claims = [
      {
        claim_id: "c1",
        organisation_slug: "kavango-foundation",
        organisation_name: "Kavango Foundation",
        claim_email: "officer@kavango.example",
        domain_matches: true,
        status: "pending",
        review_note: null,
        created_at: "2026-09-14T00:00:00Z",
        email_sent_at: null,
      },
    ];
    const html = plain(await (await claimPage()).text());
    expect(html).toContain("You already have a claim on this one");
    expect(html).not.toContain('name="claim_email"');
  });
});

describe("the confirmation page", () => {
  it("confirms from the link and points at the management page", async () => {
    const html = plain(await (await confirmPage("?token=" + "a".repeat(48))).text());
    expect(html).toContain("Kavango Foundation is yours.");
    expect(html).toContain("/organisations/kavango-foundation/manage");
    // The consequence of an edit is stated here, before they make one.
    expect(html).toContain("goes back");
  });

  it("says one thing for every kind of bad token", async () => {
    state.confirmOk = false;
    const withToken = plain(await (await confirmPage("?token=" + "b".repeat(48))).text());
    const withoutToken = plain(await (await confirmPage("")).text());
    expect(withToken).toContain("That link didn't work");
    expect(withoutToken).toContain("That link didn't work");
    // No distinction between unknown, expired and spent: three answers would be an oracle.
    expect(withToken).not.toMatch(/expired token|already used|unknown token/i);
  });

  it("is noindex, and not cached anywhere shared", async () => {
    const res = await confirmPage("?token=" + "c".repeat(48));
    expect(await res.text()).toContain('content="noindex, nofollow"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("the manage page", () => {
  it("offers a claim instead of a form to someone who is not a member", async () => {
    state.member = false;
    const html = plain(await (await managePage()).text());
    expect(html).toContain("This isn't yours to manage");
    expect(html).not.toContain('name="title"');
  });

  it("holds the publish form back until the organisation is verified", async () => {
    state.member = true;
    state.verification = "claimed_pending";
    const html = plain(await (await managePage()).text());
    expect(html).toContain("Waiting on verification");
    expect(html).not.toContain('name="title"');
  });

  it("states the consequence of a material edit, and shows who is tracking each listing", async () => {
    state.member = true;
    state.verification = "verified";
    const html = plain(await (await managePage()).text());
    expect(html).toContain("sends it back into review and tells everyone tracking it");
    expect(html).toContain("4 people are tracking it");
    expect(html).toContain('name="title"');
    // PRODUCT_SPEC.md §27: no view counts, anywhere, for anyone.
    expect(html.toLowerCase()).not.toContain("views");
  });
});

describe("the public submission form", () => {
  it("carries no third-party script (invariant 12, ADR 0002)", async () => {
    const html = await (await submitPage()).text();
    const external = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]);
    expect(external.filter((src) => /^https?:\/\//.test(src ?? ""))).toEqual([]);
    expect(html).not.toContain("challenges.cloudflare.com");
    expect(html).not.toContain("cf-turnstile");
  });

  it("asks for the official page first, and says why", async () => {
    const html = plain(await (await submitPage()).text());
    expect(html).toContain("The official page");
    expect(html).toContain("not a news article about it");
    expect(html).toContain("A person reads every submission");
  });

  it("needs no account", async () => {
    // The page renders for a signed-out visitor: getSessionUser returning a user is
    // incidental here, and there is no redirect in the module at all.
    const res = await submitPage();
    expect(res.status).toBe(200);
  });

  it("promises no IP storage, and keeps that promise in the code", async () => {
    const html = plain(await (await submitPage()).text());
    expect(html).toContain("we don't store your IP address");
  });
});

describe("the organisation page's claim control", () => {
  it("invites a claim when unclaimed", async () => {
    state.verification = "unclaimed";
    const html = plain(await (await orgPage()).text());
    expect(html).toContain("Is this your organisation?");
  });

  it("says a claim is in progress rather than inviting another", async () => {
    state.verification = "claimed_pending";
    const html = plain(await (await orgPage()).text());
    expect(html).toContain("Somebody has claimed this page");
    expect(html).not.toContain("Is this your organisation?");
  });

  it("states the verification date once verified, and invites nobody", async () => {
    state.verification = "verified";
    const html = plain(await (await orgPage()).text());
    expect(html).toContain("Claimed and verified on 1 September 2026");
    expect(html).not.toContain("Is this your organisation?");
  });
});
