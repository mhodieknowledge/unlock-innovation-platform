/**
 * Phase 9's half of the tracker: what a reader sees when the network was not there.
 *
 * SYSTEM_ARCHITECTURE.md §3.4 requires "a visible pending sync state", and the queued write
 * arrives as a redirect from the service worker — a redirect that lands on a page served out
 * of the cache. So the state has to be in the HTML, not painted by a script: if it were only
 * painted, a reader whose queued change arrived on a cached page with no JavaScript would
 * watch their action disappear, which is the exact moment this product cannot afford to look
 * unreliable.
 *
 * The install prompt is here for the opposite reason: it must NOT appear until the reader has
 * saved something, and it must never be a modal (UX_FLOWS.md §1).
 */

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import svelteRenderer from "@astrojs/svelte/server.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_USER = {
  id: "aaaa1111-1111-1111-1111-111111111111",
  email: "builder@example.invalid",
  handle: "builder",
  display_name: "A Builder",
  is_admin: false,
  admin_role: null,
  account_state: "active",
  age_confirmed_18: true,
  timezone: "Africa/Harare",
  low_data_mode: false,
};

const OPPORTUNITY = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "harare-climate-data-challenge",
  title: "Harare Climate Data Challenge",
  summary: "A summary.",
  description_md: null,
  deadline_at: "2026-09-20T21:59:00Z",
  deadline_precision: "date_only",
  deadline_raw: null,
  deadline_timezone: "Africa/Harare",
  opens_at: null,
  starts_at: null,
  ends_at: null,
  is_rolling: false,
  participation_mode: "online",
  eligibility_scope: "africa_wide",
  eligible_countries: ["ZW"],
  team_required: false,
  team_size_min: null,
  team_size_max: null,
  prize_amount: null,
  prize_currency: null,
  cost: "free",
  cost_description: null,
  verification: "verified",
  last_verified_at: "2026-09-14T06:00:00Z",
  source_url: "https://example.invalid/s",
  official_url: null,
  apply_url: null,
  status: "published",
  duplicate_of: null,
  organisations: { slug: "example-org", name: "Example Organisation", verification: "verified" },
  categories: { code: "ai_challenge", name: "AI challenge", slug: "ai-challenges" },
};

const state = { entries: [] as unknown[], lowDataAccount: false };

vi.mock("../src/lib/auth", () => ({
  getSessionUser: vi.fn(async () => ({
    ...SESSION_USER,
    low_data_mode: state.lowDataAccount,
  })),
  createAuthClient: vi.fn(() => ({ from: () => ({}) })),
  personalWritesAllowed: vi.fn(() => true),
}));

vi.mock("../src/lib/db", () => ({
  getTracker: vi.fn(async () => ({ ok: true as const, data: state.entries })),
}));

vi.mock("../src/lib/errors", () => ({ reportError: vi.fn(async () => undefined) }));

async function tracker(
  url = "https://example.invalid/tracker",
  headers: Record<string, string> = {},
): Promise<Response> {
  const container = await AstroContainer.create();
  container.addServerRenderer({ name: "@astrojs/svelte", renderer: svelteRenderer });
  container.addClientRenderer({ name: "@astrojs/svelte", entrypoint: "@astrojs/svelte/client.js" });
  const { default: Page } = await import("../src/pages/tracker.astro");
  return container.renderToResponse(Page as never, {
    params: {},
    locals: { runtime: { env: {} } },
    request: new Request(url, { headers }),
  });
}

const plain = (html: string) =>
  html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

beforeEach(() => {
  state.entries = [
    {
      id: "entry-1",
      state: "saved",
      note: null,
      applied_at: null,
      remind_at: null,
      updated_at: "2026-09-13T00:00:00Z",
      opportunities: OPPORTUNITY,
    },
  ];
  state.lowDataAccount = false;
});

describe("a change made offline (SYSTEM_ARCHITECTURE.md §3.4)", () => {
  it("is visible in the HTML, without waiting for a script", async () => {
    const html = plain(await (await tracker("https://example.invalid/tracker?queued=1")).text());
    expect(html).toContain("saved on this device and waiting to sync");
    expect(html).toContain("you can close the page");
    expect(html).not.toContain("astro-island");
  });

  it("says nothing about syncing on an ordinary visit", async () => {
    const html = plain(await (await tracker()).text());
    expect(html).not.toContain("waiting to sync");
    // The worker's own persistent counter ships hidden, ready for its message.
    expect(html).toMatch(/data-pending-sync[^>]*hidden/);
  });

  it("registers the worker and the manifest on this page, because it has to work offline", async () => {
    const html = await (await tracker()).text();
    expect(html).toContain('src="/sw-register.js"');
    expect(html).toContain('rel="manifest"');
  });
});

describe("the install prompt (IMPLEMENTATION_PLAN.md §11)", () => {
  it("is not in the page at all until the reader has saved something", async () => {
    state.entries = [];
    const html = await (await tracker()).text();
    expect(html).not.toContain("data-install-prompt");
    expect(html).toContain("Nothing saved yet.");
  });

  it("ships hidden, inline, and dismissible once they have", async () => {
    const html = plain(await (await tracker()).text());
    expect(html).toMatch(/data-install-prompt[^>]*hidden/);
    expect(html).toContain("Add to home screen");
    expect(html).toContain("No thanks");
    // Not a modal and not an interstitial: no dialog, no overlay, no fixed positioning.
    expect(html).not.toMatch(/role="dialog"/);
    expect(html).not.toMatch(/class="[^"]*\bfixed\b/);
  });

  it("is revealed only by the browser's own offer, never on a timer", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const register = readFileSync(resolve(here, "..", "public", "sw-register.js"), "utf8");

    expect(register).toContain('addEventListener("beforeinstallprompt"');
    // preventDefault, or Chromium shows its own infobar — the interstitial §1 rules out.
    expect(register).toContain("event.preventDefault()");
    // A dismissal is remembered, so the row never argues twice.
    expect(register).toContain("mbele-install-dismissed");
    expect(register).not.toMatch(/setTimeout\([^)]*prompt/);
  });
});

describe("low-data mode on a signed-in page (DESIGN_SYSTEM.md §10)", () => {
  it("follows the account preference when there is no cookie and no header", async () => {
    state.lowDataAccount = true;
    const html = plain(await (await tracker()).text());
    expect(html).toContain('data-low-data="1"');
    expect(html).toContain("Low-data mode is on");
  });

  it("lets the device's own choice win over the account", async () => {
    state.lowDataAccount = true;
    const html = await (await tracker("https://example.invalid/tracker", { cookie: "ld=0" })).text();
    expect(html).not.toContain('data-low-data="1"');
  });
});
