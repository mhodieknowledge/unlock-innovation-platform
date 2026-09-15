/**
 * The homepage. UX_FLOWS.md §2, "the board".
 *
 * The three things asserted here are the three the page exists for, and none of them can be
 * checked in SQL:
 *
 *   The board is the hero. Eight rows, soonest deadline first, in the HTML — not fetched by a
 *   script after arrival, which on the connections this product is built for is the
 *   difference between a list and a spinner.
 *
 *   No number the product cannot stand behind. CONTENT_AND_LAUNCH.md §1: with nothing
 *   published, the honest output is no number at all — not "0 opportunities".
 *
 *   The country a reader sees was decided by something this request carried, so the response
 *   must not be handed to the next reader. That is a caching header, and a caching header is
 *   only ever right or wrong — never approximately right.
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

/** Deliberately out of order, so an assertion on the rendered order proves the ORDER BY. */
const BOARD = [
  row(0, "Harare Climate Data Challenge", "2026-09-20T21:59:00Z"),
  row(1, "Continental AgriTech Fellowship", "2026-09-28T21:59:00Z"),
  row(2, "Open Transport Grant", "2026-10-05T21:59:00Z"),
];

function row(i: number, title: string, deadline: string) {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    slug: `board-${i}`,
    title,
    summary: "A summary.",
    description_md: null,
    deadline_at: deadline,
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
    prize_amount: "5000.00",
    prize_currency: "USD",
    cost: "free",
    cost_description: null,
    verification: "verified",
    last_verified_at: "2026-09-14T06:00:00Z",
    source_url: "https://example.invalid/source",
    official_url: null,
    apply_url: null,
    status: "published",
    duplicate_of: null,
    organisations: { slug: "example-org", name: "Example Organisation", verification: "verified" },
    categories: { code: "ai_challenge", name: "AI challenge", slug: "ai-challenges" },
  };
}

const state = {
  board: [...BOARD] as ReturnType<typeof row>[],
  boardOk: true,
  published: 312 as number | null,
  lastVerifiedAt: "2026-09-14T06:00:00Z" as string | null,
  signedIn: false,
  residence: null as string | null,
  /** What listOpportunities was asked for, so the country filter can be asserted. */
  asked: null as { limit?: number; countryIso2?: string } | null,
};

vi.mock("../src/lib/db", () => ({
  listOpportunities: vi.fn(async (options: { limit?: number; countryIso2?: string }) => {
    state.asked = options;
    return state.boardOk
      ? { ok: true as const, data: state.board }
      : { ok: false as const, reason: "unavailable" as const };
  }),
  getCountry: vi.fn(async (iso2: string | null) =>
    iso2 === "ZW"
      ? { iso2: "ZW", name: "Zimbabwe", slug: "zimbabwe" }
      : iso2 === "KE"
        ? { iso2: "KE", name: "Kenya", slug: "kenya" }
        : null,
  ),
  getEntryPoints: vi.fn(async () => ({
    countries: [
      { iso2: "KE", name: "Kenya", slug: "kenya" },
      { iso2: "ZW", name: "Zimbabwe", slug: "zimbabwe" },
    ],
    categories: [{ code: "ai_challenge", name: "AI challenge", slug: "ai-challenges" }],
  })),
  getPublishedCount: vi.fn(async () => state.published),
  getLastVerifiedAt: vi.fn(async () => state.lastVerifiedAt),
}));

vi.mock("../src/lib/auth", () => ({
  getSessionUser: vi.fn(async () => (state.signedIn ? SESSION_USER : null)),
  getResidenceCountry: vi.fn(async () => state.residence),
}));

async function home(
  url = "https://example.invalid/",
  headers: Record<string, string> = {},
): Promise<Response> {
  const container = await AstroContainer.create();
  container.addServerRenderer({ name: "@astrojs/svelte", renderer: svelteRenderer });
  container.addClientRenderer({ name: "@astrojs/svelte", entrypoint: "@astrojs/svelte/client.js" });
  const { default: Page } = await import("../src/pages/index.astro");
  return container.renderToResponse(Page as never, {
    params: {},
    locals: { runtime: { env: {} } },
    request: new Request(url, { headers }),
  });
}

const plain = (html: string) =>
  html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#8212;/g, "—");

beforeEach(() => {
  state.board = [...BOARD];
  state.boardOk = true;
  state.published = 312;
  state.lastVerifiedAt = "2026-09-14T06:00:00Z";
  state.signedIn = false;
  state.residence = null;
  state.asked = null;
});

describe("the board is the hero (UX_FLOWS.md §2)", () => {
  it("server-renders the rows, soonest deadline first, with no island and no script", async () => {
    const html = plain(await (await home()).text());

    for (const r of BOARD) expect(html).toContain(r.title);

    const positions = BOARD.map((r) => html.indexOf(r.title));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // Nothing hydrates: the board is HTML, and the page needs no JavaScript to show it.
    expect(html).not.toContain("astro-island");
  });

  it("asks for exactly eight rows", async () => {
    await home();
    expect(state.asked?.limit).toBe(8);
  });

  it("carries none of what §2 lists as deliberately absent", async () => {
    const html = await (await home()).text();
    // No hero image, illustration or gradient — and the only image this product ships is the
    // installed app's icon, which is referenced from the manifest, never from a page.
    expect(html).not.toMatch(/<img\b/);
    expect(html).not.toMatch(/<picture\b/);
    expect(html).not.toMatch(/background-image/i);
    expect(html).not.toMatch(/gradient/i);
    expect(html).not.toMatch(/testimonial/i);
    // No community numbers: the only counts on the page are the two live ones below.
    expect(html).not.toMatch(/\d[\d,]*\+/);
  });

  it("offers search as a plain GET form with one example query", async () => {
    const html = await (await home()).text();
    expect(html).toContain('action="/opportunities"');
    expect(html).toContain('method="get"');
    expect(html).toContain('placeholder="remote AI hackathons open to Zimbabwe"');
  });

  it("links to countries and categories as plain links", async () => {
    const html = await (await home()).text();
    expect(html).toContain('href="/opportunities?country=ZW"');
    expect(html).toContain('href="/opportunities?category=ai_challenge"');
    // Plain links, not a control that needs JavaScript to navigate.
    expect(html).not.toMatch(/<select[^>]*name="country"/);
  });

  it("carries the 'Last updated' line §2's offline state needs", async () => {
    // The page is served back from the cache unchanged, so the only timestamp that is still
    // true offline is one written at render time.
    const html = await (await home()).text();
    expect(html).toMatch(/Board as of .*UTC/);
  });
});

describe("counts are true or absent (CONTENT_AND_LAUNCH.md §1)", () => {
  it("shows the live published count and the last verification", async () => {
    const html = plain(await (await home()).text());
    expect(html).toContain("312 opportunities published");
    expect(html).toContain("Checked today against the source.");
  });

  it("shows no number at all when nothing is published", async () => {
    state.board = [];
    state.published = 0;
    state.lastVerifiedAt = null;

    const html = plain(await (await home()).text());
    expect(html).toContain("Nothing is published yet.");
    // Not "0 opportunities", and not a placeholder.
    expect(html).not.toMatch(/\b0 opportunit/);
    expect(html).not.toContain("published.");
  });

  it("says what is wrong, without an error page, when the board cannot load", async () => {
    state.boardOk = false;
    const response = await home();
    const html = plain(await response.text());

    expect(response.status).toBe(200);
    expect(html).toContain("We can't load the board right now.");
    expect(html).toContain('href="/opportunities"');
    // A degraded board is cached briefly, never for the usual five minutes.
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=30");
  });
});

describe("the country strip and who may cache it (UX_FLOWS.md §2 item 4)", () => {
  it("follows the edge hint, and never lets that response be shared", async () => {
    const response = await home("https://example.invalid/", { "cf-ipcountry": "KE" });
    const html = plain(await response.text());

    expect(state.asked?.countryIso2).toBe("KE");
    expect(html).toContain("Open to Kenya");
    expect(html).toContain("Not your country? Show everything");
    expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(response.headers.get("vary")).toContain("Cookie");
  });

  it("prefers the URL over the hint, and that response IS shareable", async () => {
    const response = await home("https://example.invalid/?country=ZW", { "cf-ipcountry": "KE" });
    const html = plain(await response.text());

    expect(state.asked?.countryIso2).toBe("ZW");
    expect(html).toContain("Open to Zimbabwe");
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=600",
    );
  });

  it("prefers the signed-in profile over the hint, and stays private", async () => {
    state.signedIn = true;
    state.residence = "ZW";

    const response = await home("https://example.invalid/", { "cf-ipcountry": "KE" });
    const html = plain(await response.text());

    expect(state.asked?.countryIso2).toBe("ZW");
    expect(html).toContain("Open to Zimbabwe");
    expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
  });

  it("shows everything on ?country=all, hint or no hint", async () => {
    const response = await home("https://example.invalid/?country=all", { "cf-ipcountry": "KE" });
    const html = plain(await response.text());

    expect(state.asked?.countryIso2).toBeUndefined();
    expect(html).not.toContain("Open to Kenya");
    expect(html).toContain("Use my country again");
    // An explicit choice in the URL is shareable: it is the same page for everyone who
    // follows the link.
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=600",
    );
  });

  it("ignores a country code that is not one, rather than inventing a strip", async () => {
    const response = await home("https://example.invalid/?country=ZZ");
    const html = plain(await response.text());
    expect(html).not.toContain("Open to ZZ");
    expect(html).not.toMatch(/Open to \w\w\b/);
  });

  it("does not treat Cloudflare's unknown-country answers as countries", async () => {
    for (const code of ["XX", "T1"]) {
      const response = await home("https://example.invalid/", { "cf-ipcountry": code });
      await response.text();
      expect(state.asked?.countryIso2, code).toBeUndefined();
      // Nothing about the request shaped the page, so it is shareable again.
      expect(response.headers.get("cache-control")).toBe(
        "public, s-maxage=300, stale-while-revalidate=600",
      );
    }
  });

  it("offers the escape hatch even when the country filter finds nothing", async () => {
    state.board = [];
    const html = plain(await (await home("https://example.invalid/?country=KE")).text());
    expect(html).toContain("Nothing open to Kenya is closing yet.");
    expect(html).toContain('href="/?country=all"');
  });
});

describe("low-data and offline (DESIGN_SYSTEM.md §10, SYSTEM_ARCHITECTURE.md §3.4)", () => {
  const lowDataHome = () => home("https://example.invalid/", { cookie: "ld=1" });

  it("is light from the first paint, not after a script runs", async () => {
    const html = await (await lowDataHome()).text();

    // The flag is on the root element, which is what a stylesheet and a future font link can
    // key off without any JavaScript at all.
    expect(html).toContain('data-low-data="1"');
    // Two fact cells, not four: the countdown and the cost.
    expect(html).toContain(">Closes<");
    expect(html).toContain(">Cost<");
    expect(html).not.toContain(">Prize<");
    expect(html).not.toContain(">Format<");
    // The freshness line goes; the detail page still carries it in full. Asserted against the
    // normal page in the same breath, because "does not contain" proves nothing on its own —
    // if the string were never rendered anywhere, this test would pass while measuring
    // nothing, which is the failure mode this suite keeps finding.
    expect(html).not.toContain("Checked today</span>");
    expect(await (await home()).text()).toContain("Checked today</span>");
  });

  it("honours Save-Data with no cookie at all", async () => {
    const html = await (await home("https://example.invalid/", { "save-data": "on" })).text();
    expect(html).toContain('data-low-data="1"');
  });

  it("lets an explicit cookie override the header in both directions", async () => {
    const html = await (
      await home("https://example.invalid/", { "save-data": "on", cookie: "ld=0" })
    ).text();
    expect(html).not.toContain('data-low-data="1"');
  });

  it("says low-data mode is on, with a toggle that needs no script", async () => {
    const html = plain(await (await lowDataHome()).text());
    expect(html).toContain("Low-data mode is on");
    expect(html).toContain('action="/low-data"');
    expect(html).toContain("Turn it off");
  });

  it("is installable and offline-capable, and says nothing about it until there is news", async () => {
    const html = await (await home()).text();
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('src="/sw-register.js"');
    // Both indicators ship hidden: a reader with no queue has nothing to be told.
    expect(html).toMatch(/data-pending-sync[^>]*hidden/);
    expect(html).toMatch(/data-toast[^>]*hidden/);
  });
});
