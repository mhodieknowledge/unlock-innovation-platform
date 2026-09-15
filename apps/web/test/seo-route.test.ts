/**
 * The SEO routes, as behaviour. Phase 10's acceptance criteria, the two that are about responses
 * rather than about markup:
 *
 *   "country × category pages below 5 items redirect rather than render"
 *   "`noindex` verified on every private route and on non-opted-in profiles and projects"
 *
 * The redirect is asserted from both sides of the floor, because a rule that redirects
 * everything passes a test that only checks the thin case — and a matrix that never renders is
 * the growth engine switched off.
 *
 * The noindex audit reads every page file under a private prefix rather than rendering a chosen
 * few. SEO.md §1 has three layers "because one will eventually be misconfigured", and the layer
 * that fails silently is the page's own meta tag: a new private route with no `noindex` is
 * indexable the day it ships and nothing else in the system notices.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import svelteRenderer from "@astrojs/svelte/server.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SEO_MATRIX_FLOOR, SITEMAP_SEGMENTS } from "@mbele/config";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = resolve(HERE, "..", "src", "pages");

const COUNTRY = { iso2: "ZW", name: "Zimbabwe", slug: "zimbabwe" };

const state = {
  /** What the matrix cell holds, so both sides of the floor can be exercised. */
  cellCount: SEO_MATRIX_FLOOR,
  indexableProfiles: 0,
};

const ROW = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "agritech-ai-challenge-2026",
  title: "AgriTech AI Challenge 2026",
  summary: "An open call.",
  description_md: null,
  deadline_at: "2026-09-30T21:59:00Z",
  deadline_precision: "date_only",
  deadline_raw: null,
  deadline_timezone: "Africa/Harare",
  opens_at: null,
  starts_at: null,
  ends_at: null,
  is_rolling: false,
  participation_mode: "online",
  eligibility_scope: "africa_wide",
  eligible_countries: [],
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
  organisations: { slug: "kumasi-hive", name: "Kumasi Hive", verification: "verified" },
  categories: { code: "ai_challenge", name: "AI challenge", slug: "ai-challenges" },
};

vi.mock("../src/lib/db", () => ({
  getCountryBySlug: vi.fn(async (slug: string | undefined) =>
    slug === "zimbabwe" ? COUNTRY : null,
  ),
  getCountryCounts: vi.fn(async () => [
    { ...COUNTRY, region: "southern_africa", open_count: 12, specific_count: 3, soonest_deadline: null },
    {
      iso2: "ZM",
      name: "Zambia",
      slug: "zambia",
      region: "southern_africa",
      open_count: 9,
      specific_count: 0,
      soonest_deadline: null,
    },
  ]),
  getMatrixCells: vi.fn(async () => [
    {
      iso2: "ZW",
      country_name: "Zimbabwe",
      country_slug: "zimbabwe",
      category_code: "ai_challenge",
      category_name: "AI challenge",
      category_slug: "ai-challenges",
      open_count: state.cellCount,
    },
  ]),
  getCategoryCounts: vi.fn(async () => [
    { code: "ai_challenge", name: "AI challenge", slug: "ai-challenges", open_count: 12, soonest_deadline: null },
    { code: "grant", name: "Grant", slug: "grants", open_count: 0, soonest_deadline: null },
  ]),
  getCountryOrganisations: vi.fn(async () => [
    { slug: "kumasi-hive", name: "Kumasi Hive", verification: "verified", open_count: 3 },
  ]),
  listOpportunities: vi.fn(async () => ({ ok: true as const, data: [ROW] })),
  searchOpportunities: vi.fn(async () => ({ ok: true as const, data: { rows: [ROW], total: 1 } })),
  getSitemapOpportunities: vi.fn(async () => [
    { slug: "agritech-ai-challenge-2026", lastmod: "2026-09-14T06:00:00Z" },
  ]),
  getSitemapOrganisations: vi.fn(async () => [{ slug: "kumasi-hive", lastmod: null }]),
  getSitemapProfiles: vi.fn(async () =>
    state.indexableProfiles > 0 ? [{ slug: "tadiwa-m", lastmod: "2026-09-01T00:00:00Z" }] : [],
  ),
  getOrganisation: vi.fn(async () => ({
    ok: true as const,
    data: {
      organisation: {
        id: "org-1",
        slug: "kumasi-hive",
        name: "Kumasi Hive",
        description: null,
        website_url: "https://kumasihive.example",
        country_iso2: "GH",
        org_type: "community",
        verification: "verified",
        verified_at: null,
      },
      open: [ROW],
      past: [],
    },
  })),
  getClient: vi.fn(() => null),
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

async function endpoint(
  importer: () => Promise<{ GET: (context: never) => Response | Promise<Response> }>,
  url: string,
  params: Record<string, string> = {},
): Promise<Response> {
  const { GET } = await importer();
  return GET({
    url: new URL(url),
    params,
    locals: { runtime: { env: {} } },
    request: new Request(url),
  } as never);
}

const plain = (html: string) =>
  html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

beforeEach(() => {
  state.cellCount = SEO_MATRIX_FLOOR;
  state.indexableProfiles = 0;
});

describe("the country × category matrix (SEO.md §2)", () => {
  const cell = (country = "zimbabwe", category = "ai-challenges") =>
    render(
      () => import("../src/pages/countries/[slug]/[category].astro"),
      { slug: country, category },
      `https://example.invalid/countries/${country}/${category}`,
    );

  it("renders at the floor, with the count in the title", async () => {
    state.cellCount = SEO_MATRIX_FLOOR;
    const response = await cell();
    const html = plain(await response.text());

    expect(response.status).toBe(200);
    expect(html).toContain("AI challenge for Zimbabweans");
    expect(html).toContain("AgriTech AI Challenge 2026");
    // Self-canonicalising, and indexable: this is the long tail §2 exists to create.
    expect(html).toContain('rel="canonical"');
    expect(html).not.toContain("noindex");
  });

  it("301-redirects one below the floor, rather than rendering a thin page", async () => {
    state.cellCount = SEO_MATRIX_FLOOR - 1;
    const response = await cell();

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/countries/zimbabwe");
  });

  it("redirects an empty cell too, and an unknown category", async () => {
    state.cellCount = 0;
    expect((await cell()).status).toBe(301);

    state.cellCount = SEO_MATRIX_FLOOR;
    const unknown = await cell("zimbabwe", "not-a-category");
    expect(unknown.status).toBe(301);
    expect(unknown.headers.get("location")).toBe("/countries/zimbabwe");
  });

  it("404s an unknown country rather than redirecting somewhere plausible", async () => {
    const response = await cell("atlantis", "ai-challenges");
    expect(response.status).toBe(404);
    expect(plain(await response.text())).toContain("nothing at this address");
  });
});

describe("country pages (UX_FLOWS.md §13)", () => {
  const country = (slug = "zimbabwe", query = "") =>
    render(
      () => import("../src/pages/countries/[slug].astro"),
      { slug },
      `https://example.invalid/countries/${slug}${query}`,
    );

  it("leads with the count, and says how much of it is continental", async () => {
    const html = plain(await (await country()).text());
    expect(html).toContain("Open to Zimbabwe");
    expect(html).toContain("12 open now");
    expect(html).toContain("3 named for Zimbabwe");
    expect(html).toContain("9 open across Africa or worldwide");
  });

  it("offers the feed, the neighbours and the organisations active there", async () => {
    const html = plain(await (await country()).text());
    expect(html).toContain("/feeds/countries/zimbabwe.xml");
    expect(html).toContain("/countries/zambia");
    expect(html).toContain("Kumasi Hive");
  });

  it("links a below-floor category to the filtered list, never to a page that redirects", async () => {
    state.cellCount = 2;
    const html = await (await country()).text();
    expect(html).toContain("/opportunities?country=ZW&amp;category=ai_challenge");
    expect(html).not.toContain("/countries/zimbabwe/ai-challenges");
  });

  it("links an above-floor category to its own page", async () => {
    state.cellCount = SEO_MATRIX_FLOOR + 3;
    const html = await (await country()).text();
    expect(html).toContain("/countries/zimbabwe/ai-challenges");
  });

  it("is noindex past page one, and canonicalises to the base (SEO.md §1, §5)", async () => {
    const html = await (await country("zimbabwe", "?page=2")).text();
    expect(html).toContain("noindex");
    expect(html).toContain('href="/countries/zimbabwe"');
  });

  it("404s an unknown country", async () => {
    const response = await country("atlantis");
    expect(response.status).toBe(404);
  });
});

describe("sitemaps (SEO.md §5)", () => {
  it("indexes exactly the six segments", async () => {
    const xml = await (await endpoint(() => import("../src/pages/sitemap.xml"), "https://example.invalid/sitemap.xml")).text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    for (const segment of SITEMAP_SEGMENTS) {
      expect(xml).toContain(`https://example.invalid/sitemaps/${segment}.xml`);
    }
  });

  it("lists opportunities with an absolute URL and a real lastmod", async () => {
    const xml = await (
      await endpoint(
        () => import("../src/pages/sitemaps/opportunities.xml"),
        "https://example.invalid/sitemaps/opportunities.xml",
      )
    ).text();
    expect(xml).toContain("<loc>https://example.invalid/opportunities/agritech-ai-challenge-2026</loc>");
    expect(xml).toContain("<lastmod>2026-09-14</lastmod>");
    expect(xml).toContain("<priority>0.9</priority>");
  });

  it("lists every country page, and only the matrix cells that are not redirects", async () => {
    state.cellCount = SEO_MATRIX_FLOOR;
    const withCell = await (
      await endpoint(
        () => import("../src/pages/sitemaps/countries.xml"),
        "https://example.invalid/sitemaps/countries.xml",
      )
    ).text();
    expect(withCell).toContain("/countries/zimbabwe</loc>");
    expect(withCell).toContain("/countries/zambia</loc>");
    expect(withCell).toContain("/countries/zimbabwe/ai-challenges</loc>");

    // One below the floor the route 301s, so advertising it would send crawlers to a redirect.
    state.cellCount = SEO_MATRIX_FLOOR - 1;
    const withoutCell = await (
      await endpoint(
        () => import("../src/pages/sitemaps/countries.xml"),
        "https://example.invalid/sitemaps/countries.xml",
      )
    ).text();
    expect(withoutCell).toContain("/countries/zimbabwe</loc>");
    expect(withoutCell).not.toContain("/countries/zimbabwe/ai-challenges</loc>");
  });

  it("lists no profile until somebody opts in, then exactly that one", async () => {
    const empty = await (
      await endpoint(
        () => import("../src/pages/sitemaps/public-profiles.xml"),
        "https://example.invalid/sitemaps/public-profiles.xml",
      )
    ).text();
    expect(empty).toContain("<urlset");
    expect(empty).not.toContain("<loc>");

    state.indexableProfiles = 1;
    const one = await (
      await endpoint(
        () => import("../src/pages/sitemaps/public-profiles.xml"),
        "https://example.invalid/sitemaps/public-profiles.xml",
      )
    ).text();
    expect(one).toContain("https://example.invalid/b/tadiwa-m");
  });

  it("lists the static pages from the indexing table, and no private one", async () => {
    const xml = await (
      await endpoint(() => import("../src/pages/sitemaps/static.xml"), "https://example.invalid/sitemaps/static.xml")
    ).text();
    expect(xml).toContain("<loc>https://example.invalid/</loc>");
    expect(xml).toContain("/privacy</loc>");
    expect(xml).toContain("/anti-scam</loc>");
    for (const forbidden of ["/tracker", "/you", "/admin", "/threads", "/requests"]) {
      expect(xml, `${forbidden} must never appear in a sitemap`).not.toContain(`${forbidden}</loc>`);
    }
  });

  it("serves XML with a cache window a crawler will respect", async () => {
    const response = await endpoint(
      () => import("../src/pages/sitemap.xml"),
      "https://example.invalid/sitemap.xml",
    );
    expect(response.headers.get("content-type")).toContain("application/xml");
    expect(response.headers.get("cache-control")).toContain("s-maxage=3600");
  });
});

describe("robots.txt (SEO.md §5)", () => {
  it("disallows every private prefix, the filtered views, and names the sitemap", async () => {
    const body = await (
      await endpoint(() => import("../src/pages/robots.txt"), "https://example.invalid/robots.txt")
    ).text();

    expect(body).toContain("User-agent: *");
    expect(body).toContain("Allow: /");
    for (const path of ["/tracker", "/you", "/threads", "/requests", "/admin", "/api"]) {
      expect(body, `${path} must be disallowed`).toContain(`Disallow: ${path}`);
    }
    expect(body).toContain("Disallow: /*?");
    expect(body).toContain("Sitemap: https://example.invalid/sitemap.xml");
  });

  it("does not disallow the surfaces the whole strategy depends on", async () => {
    const body = await (
      await endpoint(() => import("../src/pages/robots.txt"), "https://example.invalid/robots.txt")
    ).text();
    expect(body).not.toMatch(/Disallow: \/countries/);
    expect(body).not.toMatch(/Disallow: \/opportunities\b/);
    expect(body).not.toMatch(/Disallow: \/$/m);
  });
});

describe("feeds (SEO.md §7)", () => {
  it("serves closing-soon as RSS a channel bot can consume", async () => {
    const response = await endpoint(
      () => import("../src/pages/feeds/closing-soon.xml"),
      "https://example.invalid/feeds/closing-soon.xml",
    );
    const xml = await response.text();

    expect(response.headers.get("content-type")).toContain("application/xml");
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain("<channel>");
    expect(xml).toContain("<title>");
    expect(xml).toContain("AgriTech AI Challenge 2026");
    expect(xml).toContain("<guid isPermaLink=\"true\">https://example.invalid/opportunities/agritech-ai-challenge-2026</guid>");
    // A description built from fields, never from source prose.
    expect(xml).toContain("Free to enter");
  });

  it("serves a country feed, and 404s one that does not exist", async () => {
    const ok = await endpoint(
      () => import("../src/pages/feeds/countries/[slug].xml"),
      "https://example.invalid/feeds/countries/zimbabwe.xml",
      { slug: "zimbabwe" },
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("open to Zimbabwe");

    const missing = await endpoint(
      () => import("../src/pages/feeds/countries/[slug].xml"),
      "https://example.invalid/feeds/countries/atlantis.xml",
      { slug: "atlantis" },
    );
    expect(missing.status).toBe(404);
  });

  it("serves a category feed and an organisation feed", async () => {
    const category = await endpoint(
      () => import("../src/pages/feeds/categories/[slug].xml"),
      "https://example.invalid/feeds/categories/ai-challenges.xml",
      { slug: "ai-challenges" },
    );
    expect(category.status).toBe(200);
    expect(await category.text()).toContain("AI challenge");

    const organisation = await endpoint(
      () => import("../src/pages/feeds/organisations/[slug].xml"),
      "https://example.invalid/feeds/organisations/kumasi-hive.xml",
      { slug: "kumasi-hive" },
    );
    expect(organisation.status).toBe(200);
    expect(await organisation.text()).toContain("Kumasi Hive");
  });
});

/**
 * The noindex audit. Every page file under a private prefix, read from disk.
 *
 * Deliberately a source audit rather than a render: rendering proves it for the pages somebody
 * remembered to test, and this proves it for the ones nobody did — including the next one added.
 */
describe("noindex on every private route (SEO.md §1)", () => {
  const PRIVATE_PREFIXES = ["admin", "you", "threads", "requests", "tracker", "signin", "report", "unsubscribe", "b"];

  function pageFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...pageFiles(full));
      else if (entry.endsWith(".astro")) out.push(full);
    }
    return out;
  }

  const files = pageFiles(PAGES);

  it("found the pages at all (guard against an empty audit)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    const route = relative(PAGES, file).split(/[\\/]/).join("/");
    const first = route.split("/")[0]!.replace(/\.astro$/, "");
    if (!PRIVATE_PREFIXES.includes(first)) continue;

    it(`${route} is noindex`, () => {
      const source = readFileSync(file, "utf8");

      /*
       * Either the page passes `noindex` to Base itself, or it renders inside the Admin layout,
       * which passes it for every admin route in one place (layouts/Admin.astro). Both are
       * checked rather than assumed: the layout is asserted to still carry it, so an edit there
       * cannot silently un-index eight pages at once.
       */
      const invocations = source.match(/<Base[^>]*>/gs) ?? [];

      if (invocations.length === 0) {
        expect(source, `${route} renders neither Base nor Admin`).toMatch(/<Admin[^>]*>/s);
        const layout = readFileSync(resolve(PAGES, "..", "layouts", "Admin.astro"), "utf8");
        const layoutBase = layout.match(/<Base[^>]*>/s)?.[0] ?? "";
        expect(layoutBase, "layouts/Admin.astro must pass noindex to Base").toMatch(/noindex/);
        return;
      }

      // Every Base invocation in the file has to carry it: a page with a found state and a
      // not-found state has two, and the one nobody thought about is the one that leaks.
      for (const invocation of invocations) {
        expect(invocation, `${route}: a <Base> without noindex`).toMatch(/noindex/);
      }
    });
  }
});
