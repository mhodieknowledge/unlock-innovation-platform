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
import { readFileSync } from "node:fs";

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

/**
 * "Checked today", relative to whenever this runs.
 *
 * A fixed date here made two assertions pass on the day they were written and fail the next
 * morning, when `freshnessLabel` started saying "Checked yesterday" — the same shape as the
 * notifications suite that passed all afternoon and broke at 22:05. A fixture about "today" has to
 * be computed from today.
 */
const VERIFIED_TODAY = new Date().toISOString();

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
    last_verified_at: VERIFIED_TODAY,
    source_url: "https://example.invalid/source",
    official_url: null,
    apply_url: null,
    status: "published",
    duplicate_of: null,
    // The `og:image` the source published (migration 0038). Set here so the low-data
    // assertions below are about suppression rather than about an absent fixture.
    image_url: "https://cdn.example.invalid/banner.jpg",
    organisations: { slug: "example-org", name: "Example Organisation", verification: "verified" },
    categories: { code: "ai_challenge", name: "AI challenge", slug: "ai-challenges" },
  };
}

const state = {
  board: [...BOARD] as ReturnType<typeof row>[],
  boardOk: true,
  published: 312 as number | null,
  lastVerifiedAt: VERIFIED_TODAY as string | null,
  signedIn: false,
  residence: null as string | null,
  /** What listOpportunities was asked for, so the country filter can be asserted. */
  asked: null as { limit?: number; countryIso2?: string } | null,
};

vi.mock("../src/lib/db", () => ({
  listOpportunities: vi.fn(
    async (options: { limit?: number; countryIso2?: string; categoryCode?: string }) => {
      // The homepage also queries per-category examples for its featured category block;
      // `state.asked` exists to assert what the MAIN board query was asked, so only that
      // call (no categoryCode) is recorded here.
      if (!options.categoryCode) state.asked = options;
      return state.boardOk
        ? { ok: true as const, data: state.board }
        : { ok: false as const, reason: "unavailable" as const };
    },
  ),
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
    categories: [
      { code: "ai_challenge", name: "AI challenge", slug: "ai-challenges" },
      { code: "hackathon", name: "Hackathon", slug: "hackathons" },
    ],
  })),
  getPublishedCount: vi.fn(async () => state.published),
  // The homepage features the top category by open count as an editorial block, so the
  // fixture needs one with a representative photo (index.astro's CATEGORY_IMAGES) and a
  // real count to exercise that.
  getCategoryCounts: vi.fn(async () => [
    { code: "ai_challenge", name: "AI challenge", slug: "ai-challenges", open_count: 17, soonest_deadline: null },
    { code: "hackathon", name: "Hackathon", slug: "hackathons", open_count: 9, soonest_deadline: null },
  ]),
  getLastVerifiedAt: vi.fn(async () => state.lastVerifiedAt),
}));

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/auth")>()),
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
  state.lastVerifiedAt = VERIFIED_TODAY;
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

  it("asks for eight rows, because every row is now vertical space everyone pays for", async () => {
    // This number has been wrong in both directions. Eight was too few for a CAROUSEL that
    // showed one at a time. Twelve was right for a RAIL, where the eleven cards a reader
    // does not want are off-screen sideways and cost them no scrolling at all.
    //
    // The board is a vertical list now, and there every row is ~120px of page on the way to
    // the category sections and the trust panel below. Eight is §2 item 3's own number
    // ("enough to prove the board is alive, above the fold"), and with two category sections
    // under it the page still carries eighteen real listings.
    await home();
    expect(state.asked?.limit).toBe(8);
  });

  it("renders every row it asked for, as a list and not one at a time", async () => {
    // THE REGRESSION THIS EXISTS FOR. The rows were all in the DOM before too — inside a
    // carousel, where seven of eight were off-screen and the controls for reaching them were
    // 8×8px dots. Being in the HTML was never the question; being scannable was.
    const html = await (await home()).text();
    expect(html).not.toContain("data-carousel");
    expect(html).not.toContain("data-slide");
    for (const row of state.board) expect(html).toContain(row.title);
  });

  it("carries none of the fabricated content §2 always ruled out", async () => {
    const html = await (await home()).text();
    // The 2026-09-17 redesign reverses §2's "no hero image" stance deliberately: a real,
    // category-general photographic hero and per-category banners are now part of the
    // product (never attached to a specific listing, so no unverifiable claim is made).
    // What §2 always ruled out on different grounds — fabricated social proof — still holds.
    expect(html).not.toMatch(/testimonial/i);
    // No community numbers: the only counts on the page are the two live ones below.
    expect(html).not.toMatch(/\d[\d,]*\+/);
  });

  it("offers search as a plain GET form with one example query", async () => {
    const html = await (await home()).text();
    expect(html).toContain('action="/opportunities"');
    expect(html).toContain('method="get"');
    expect(html).toContain('placeholder="Search scholarships, hackathons, grants…"');
  });

  it("links to countries and categories as plain links", async () => {
    const html = await (await home()).text();
    // The country and category PAGES, not filtered lists: a filtered view is noindex (SEO.md §1)
    // and the homepage's main entry points must not be links to pages we ask not to be indexed.
    expect(html).toContain('href="/countries/zimbabwe"');
    // The category feature block links to the category's own page, not a filtered list —
    // which one is featured is data-driven (the highest open count among the categories
    // with a representative photo), so the fixture's hackathon entry is what earns it here.
    expect(html).toContain('href="/categories/hackathons"');
    expect(html).toContain('href="/countries"');
    expect(html).toContain('href="/categories"');
    // Plain links, not a control that needs JavaScript to navigate.
    expect(html).not.toMatch(/<select[^>]*name="country"/);
  });

  it("never lowercases a category name by hand", () => {
    /*
     * "48 ai challenge open now" shipped in the hero. I fixed it there, and the next
     * composition wrote `band.category.name.toLowerCase()` twenty lines away, which put
     * "All 48 ai challenges →" on the page — the same mistake, a second time, because the
     * rule lived in one call site instead of in a function.
     *
     * Category names are seeded in sentence case and some begin with an acronym ("AI
     * challenge"), so lowering the first letter is only correct when the first two are not
     * both capitals. That test is `categoryPhrase`, and this asserts nothing bypasses it.
     */
    const page = readFileSync(
      new URL("../src/pages/index.astro", import.meta.url).pathname,
      "utf8",
    );
    expect(page, "use categoryPhrase — it knows an acronym from a capitalised word").not.toMatch(
      /\.name\.toLowerCase\(\)/,
    );
  });

  it("gives every standalone link a 44px target, per DESIGN_SYSTEM.md §329", () => {
    /*
     * WHAT THIS MEASURES, AND WHAT IT DOES NOT. It reads the source for the class that sets
     * the height; it cannot compute layout, so it cannot prove the rendered pixel height.
     * That was measured once in a real Chromium at 390×664 on 2026-09-17 — before the fix,
     * this page's "see all" links rendered at 18px and the old page's at 16-20px — and this
     * assertion is what stops the class being removed again.
     *
     * The card links are deliberately not in scope: an OpportunityRow's title link stretches
     * its hit area over the whole card (`after:absolute after:inset-0`), so its target is the
     * card, not the text.
     */
    const page = readFileSync(
      new URL("../src/pages/index.astro", import.meta.url).pathname,
      "utf8",
    );
    const linkTags = page.match(/<a\b[^>]*class="[^"]*"[^>]*>/g) ?? [];
    const standalone = linkTags.filter((tag) => /text-brand/.test(tag) && !/after:absolute/.test(tag));
    expect(standalone.length, "the page should have standalone links to check").toBeGreaterThan(2);
    for (const tag of standalone) {
      expect(tag, `this link sets no minimum height: ${tag.slice(0, 90)}`).toMatch(/min-h-1[12]/);
    }
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
    // The count appears twice by design and is the same live number both times: once as the
    // destination of the way out of the feed, once in the numbers band. Neither is rounded.
    expect(html).toContain("View all 312");
    expect(html).toContain("312");
    expect(html).toContain("opportunities tracked");
    expect(html).toContain("Checked today against the source.");
    expect(html).not.toMatch(/\b300\+|\b310\+/);
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
    expect(html).toContain("Open to <strong class=\"font-semibold text-ink\">Kenya</strong>");
    expect(html).toContain("Show all");
    expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(response.headers.get("vary")).toContain("Cookie");
  });

  it("prefers the URL over the hint, and that response IS shareable", async () => {
    const response = await home("https://example.invalid/?country=ZW", { "cf-ipcountry": "KE" });
    const html = plain(await response.text());

    expect(state.asked?.countryIso2).toBe("ZW");
    expect(html).toContain("Open to <strong class=\"font-semibold text-ink\">Zimbabwe</strong>");
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
    expect(html).toContain("Open to <strong class=\"font-semibold text-ink\">Zimbabwe</strong>");
    expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
  });

  it("shows everything on ?country=all, hint or no hint", async () => {
    const response = await home("https://example.invalid/?country=all", { "cf-ipcountry": "KE" });
    const html = plain(await response.text());

    expect(state.asked?.countryIso2).toBeUndefined();
    expect(html).not.toContain("Opportunities for Kenya");
    expect(html).toContain("Use my location");
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
    // The deadline is still the first thing on the row, but it is no longer a cell
    // labelled "Closes": it is the countdown line above the grid, black and weighted by
    // urgency, which is where §1.2 wants "the single most typographically prominent
    // thing on any card". It used to be in both places, four millimetres apart.
    expect(html).toContain("text-countdown-sm");
    expect(html).not.toContain(">Closes<");
    // One fact cell, not four. Cost is the only one a decision turns on — invariant 13
    // turns on that field — and format and team size are context a reader paying by the
    // kilobyte is choosing not to buy.
    expect(html).toContain(">Cost<");
    expect(html).not.toContain(">Prize<");
    expect(html).not.toContain(">Format<");
    // The redesign moves the per-card freshness line off the card entirely (in both low-data
    // and normal mode) — it now lives once, in full, on the opportunity detail page's "Source
    // & verification" section, rather than being repeated on every card on the board.
    expect(html).not.toContain("Checked today</span>");

    /*
     * §25.2: low-data mode "suppresses all images including logos". A listing's picture is
     * the newest thing that has to obey it, and the most tempting to exempt — it is the one
     * that makes the board look good. It goes, and so does the tinted panel that stands in
     * for it, because a header is a third of a phone screen to scroll past whether or not
     * it costs a request.
     */
    expect(html, "a listing picture must not be requested in low-data mode").not.toContain("/img/");
    expect(html, "no card header at all in low-data mode").not.toContain("aspect-[5/2]");
  });

  it("reserves the space a picture will occupy, so the card cannot jump", async () => {
    // A lazily-loaded image with no dimensions is a layout shift on a slow connection —
    // the exact connection this product is built for, and the one where the reader has
    // already started reading when the picture lands. The ratio is on the container and
    // width/height are on the <img>, so the box exists before a byte of it arrives.
    const html = await (await home()).text();
    expect(html).toContain('src="/img/board-0"');
    expect(html).toContain('loading="lazy"');
    expect(html).toMatch(/<img[^>]+width="480"[^>]+height="270"/);
    // Someone else's promotional artwork, which we have not read. §8 would require a
    // description if it carried meaning; inventing one is the thing this product does not do.
    expect(html).toMatch(/<img[^>]+alt=""/);
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
