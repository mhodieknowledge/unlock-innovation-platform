/**
 * The room route's behaviour at and below its density floor.
 *
 * IMPLEMENTATION_PLAN.md §7, acceptance criterion 1 `[PR]`: "A room below its floor is
 * NEVER RENDERED — the route returns the opportunity page with a single CTA." And
 * PRODUCT_SPEC.md §24 adds a second, different absence: with the feature flag off the
 * surface does not exist at all.
 *
 * Both are route behaviour, not database behaviour, so neither is covered by
 * supabase/tests/collaboration.sql. A page that rendered an empty room would pass every
 * SQL assertion in the repository.
 */

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import svelteRenderer from "@astrojs/svelte/server.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_USER = {
  id: "bbbb2222-2222-2222-2222-222222222222",
  email: "room@example.invalid",
  handle: null,
  display_name: "Room Reader",
  is_admin: false,
  admin_role: null,
  account_state: "active",
  age_confirmed_18: true,
  timezone: "Africa/Harare",
  low_data_mode: false,
};

/** Mutable, so one file can drive the route through all four room states. */
const state = {
  room: "open" as "open" | "below_floor" | "archived" | "disabled",
  intents: 7,
  teams: 2,
  signedIn: true,
};

const BUILDER = {
  user_id: "cccc3333-3333-3333-3333-333333333333",
  display_name: "Another Builder",
  country_iso2: "NG",
  headline: "Front-end for low-end Android",
  roles_offered: ["frontend"],
  note: "Happy to take the interface.",
  stance: "looking_for_team",
  leads_a_team: false,
  request_state: null,
};

const TEAM = {
  team_id: "dddd4444-4444-4444-4444-444444444444",
  name: "Irrigation Crew",
  pitch: "Soil moisture on a budget.",
  roles_needed: ["data"],
  member_count: 2,
  max_size: 4,
  countries: ["ZW", "KE"],
  state: "open_for_roles",
  owner_user_id: "eeee5555-5555-5555-5555-555555555555",
  owner_display_name: "Crew Owner",
  owner_stale: false,
  i_am_member: false,
  i_own_it: false,
  my_request_state: null,
};

const rpc = async (fn: string) => {
  switch (fn) {
    case "room_state":
      return {
        data: [
          {
            state: state.room,
            intent_count: state.intents,
            team_count: state.teams,
            reason: state.room === "below_floor" ? "Be the first to say you're going for this" : "ok",
          },
        ],
        error: null,
      };
    case "intent_count_public":
      // §2.3 `[PR]`: NULL below five. The database decides; this mirrors it.
      return { data: state.intents >= 5 ? state.intents : null, error: null };
    case "room_builders":
      return { data: [BUILDER], error: null };
    case "room_teams":
      return { data: [TEAM], error: null };
    case "my_room_status":
      return {
        data: [
          {
            stance: "looking_for_team",
            roles_offered: ["backend"],
            note: null,
            intent_expires_at: "2026-12-01T00:00:00Z",
            my_team_id: null,
            my_team_name: null,
            i_own_my_team: null,
            requests_in: 0,
            requests_out: 0,
          },
        ],
        error: null,
      };
    case "request_allowance":
      return {
        data: [
          {
            day_used: 0,
            day_limit: 10,
            hour_used: 0,
            hour_limit: 3,
            pending_used: 0,
            pending_limit: 5,
            next_slot_at: null,
            blocked_reason: null,
          },
        ],
        error: null,
      };
    default:
      return { data: null, error: null };
  }
};

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/auth")>()),
  getSessionUser: vi.fn(async () => (state.signedIn ? SESSION_USER : null)),
  createAuthClient: vi.fn(() => ({ rpc, from: () => ({}) })),
  socialWritesAllowed: vi.fn(() => ({ allowed: true, reason: null })),
  personalWritesAllowed: vi.fn(() => true),
  safeReturnTo: (v: string | null) => v ?? "/",
}));

const OPPORTUNITY = {
  id: "ffff6666-6666-6666-6666-666666666666",
  slug: "room-fixture",
  title: "A hackathon with team rules",
  summary: "Short summary.",
  description_md: null,
  deadline_at: "2026-12-01T00:00:00Z",
  deadline_precision: "date_only",
  deadline_raw: null,
  deadline_timezone: null,
  opens_at: null,
  starts_at: null,
  ends_at: null,
  is_rolling: false,
  participation_mode: "online",
  eligibility_scope: "africa_wide",
  eligible_countries: [],
  team_required: true,
  team_size_min: 2,
  team_size_max: 4,
  prize_amount: null,
  prize_currency: null,
  cost: "free",
  status: "published",
  verification: "verified",
  last_verified_at: "2026-09-13T00:00:00Z",
  source_url: "https://example.invalid/hack",
  official_url: "https://example.invalid/hack",
  apply_url: "https://example.invalid/apply",
  organisations: { slug: "example-org", name: "Example Org", verification: "verified" },
  categories: { code: "hackathon", name: "Hackathon" },
};

vi.mock("../src/lib/db", () => ({
  getCountryNames: vi.fn(async (codes: readonly string[]) =>
    codes.map((code) => ({ ZW: "Zimbabwe", ZM: "Zambia", KE: "Kenya", NG: "Nigeria" })[code] ?? code),
  ),
  getOpportunity: vi.fn(async () => ({
    ok: true,
    data: { opportunity: OPPORTUNITY, rules: [] },
  })),
  getClient: vi.fn(() => ({ rpc })),
  isFlagEnabled: vi.fn(async () => false),
}));

async function renderRoom(): Promise<Response> {
  const container = await AstroContainer.create();
  container.addServerRenderer({ name: "@astrojs/svelte", renderer: svelteRenderer });
  container.addClientRenderer({ name: "@astrojs/svelte", entrypoint: "@astrojs/svelte/client.js" });
  const { default: Page } = await import("../src/pages/opportunities/[slug]/room.astro");
  return container.renderToResponse(Page as never, {
    params: { slug: OPPORTUNITY.slug },
    locals: { runtime: { env: {} } },
    request: new Request(`https://example.invalid/opportunities/${OPPORTUNITY.slug}/room`),
  });
}

async function renderDetail(): Promise<string> {
  const container = await AstroContainer.create();
  container.addServerRenderer({ name: "@astrojs/svelte", renderer: svelteRenderer });
  container.addClientRenderer({ name: "@astrojs/svelte", entrypoint: "@astrojs/svelte/client.js" });
  const { default: Page } = await import("../src/pages/opportunities/[slug].astro");
  const res = await container.renderToResponse(Page as never, {
    params: { slug: OPPORTUNITY.slug },
    locals: { runtime: { env: {} } },
    request: new Request(`https://example.invalid/opportunities/${OPPORTUNITY.slug}`),
  });
  return res.text();
}

beforeEach(() => {
  state.room = "open";
  state.intents = 7;
  state.teams = 2;
  state.signedIn = true;
});

describe("the room route", () => {
  it("renders the room when it is open", async () => {
    const html = await (await renderRoom()).text();
    expect(html).toContain("Builders looking for a team");
    expect(html).toContain("Another Builder");
    expect(html).toContain("Irrigation Crew");
    // §3.2 `[PR]`: none of the surfaces the room forbids.
    expect(html.toLowerCase()).not.toContain("followers");
    expect(html.toLowerCase()).not.toContain("online now");
    expect(html).not.toContain("viewed your profile");
  });

  it("shows what is left to send before any composer is opened (criterion 5)", async () => {
    const html = await (await renderRoom()).text();
    expect(html).toMatch(/requests? left right now/);
  });

  it("renders nothing of the room below its floor, and sends the reader to the opportunity page (criterion 1)", async () => {
    state.room = "below_floor";
    state.intents = 1;
    state.teams = 0;
    const res = await renderRoom();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/opportunities/${OPPORTUNITY.slug}`);
    // 301 would be cached past the moment the room opens.
    expect(res.status).not.toBe(301);
    // And nothing of the room came back with it — not a thinner room, not an empty list.
    const html = await res.text();
    expect(html).not.toContain("Builders looking for a team");
    expect(html).not.toContain("Another Builder");
  });

  it("does not exist at all when the flag is off (§24, invariant 4)", async () => {
    state.room = "disabled";
    const res = await renderRoom();
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).not.toContain("Builders looking for a team");
  });

  it("renders the room read-only once the opportunity has closed (§3.3)", async () => {
    state.room = "archived";
    const html = await (await renderRoom()).text();
    expect(html).toContain("read-only");
    expect(html).not.toContain("Request to join");
    expect(html).not.toContain("Start a team");
  });

  it("asks a signed-out reader to sign in rather than showing other people", async () => {
    state.signedIn = false;
    const res = await renderRoom();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/signin");
  });
});

describe("the opportunity page carries the CTA the room route falls back to", () => {
  it("offers a single CTA below the floor, and no count", async () => {
    state.room = "below_floor";
    state.intents = 2;
    const html = await renderDetail();
    expect(html).toContain("Say you're going");
    // §2.3 `[PR]`: no number below five — not "2", not "0".
    expect(html).not.toContain("2 builders have said");
    expect(html).not.toContain("builders have said they're going");
    // And no entry point to a room that would render nothing.
    expect(html).not.toContain("see who else is going");
  });

  it("offers the room entry point when the room is open, with the count at five or more", async () => {
    state.room = "open";
    state.intents = 14;
    const html = await renderDetail();
    expect(html).toContain("see who else is going");
    expect(html).toContain("14 builders have said they're going for this");
  });

  it("offers neither when the feature is switched off", async () => {
    state.room = "disabled";
    state.intents = 30;
    const html = await renderDetail();
    expect(html).not.toContain("see who else is going");
    expect(html).not.toContain("Say you're going");
    expect(html).not.toContain("builders have said");
  });
});
