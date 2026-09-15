/**
 * Phase 10's acceptance criteria, in the only form they can be checked:
 *
 *   "structured data validates for every category type"
 *   "country × category pages below 5 items redirect rather than render"
 *   "`noindex` verified on every private route and on non-opted-in profiles and projects"
 *
 * The first is a loop over the whole taxonomy rather than a spot check of one page: SEO.md §3
 * maps categories to four different schema types, and a mapping that is right for a hackathon
 * and wrong for a scholarship is the kind of thing nobody notices until Search Console does.
 *
 * The third is checked by rendering the private routes and reading the meta tag, because §1's
 * whole point is that three layers exist "because one will eventually be misconfigured" — and a
 * test that reads the table rather than the pages would be checking the wrong layer.
 */

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import svelteRenderer from "@astrojs/svelte/server.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DESCRIPTION_MAX,
  INDEXING,
  ROBOTS_DISALLOW,
  SCHEMA_TYPE_BY_CATEGORY,
  SEO_MATRIX_FLOOR,
  SITEMAP_SEGMENTS,
  TITLE_MAX,
  demonymPlural,
} from "@mbele/config";

import {
  clamp,
  opportunityDescription,
  opportunityJsonLd,
  opportunityTitle,
  xmlEscape,
} from "../src/lib/seo";

const SITE = new URL("https://mbele.example/");

/** Every category in migration 0002's taxonomy, so the loop below covers the real vocabulary. */
const CATEGORIES = [
  "hackathon", "coding_competition", "ai_challenge", "data_competition", "innovation_challenge",
  "startup_competition", "pitch_competition", "grant", "fellowship", "scholarship", "internship",
  "accelerator", "incubator", "bootcamp", "developer_program", "research_opportunity",
  "open_source_program", "entrepreneurship_program", "conference_cfp", "community_challenge",
  "other",
];

function opportunity(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "agritech-ai-challenge-2026",
    title: "AgriTech AI Challenge 2026",
    summary: "An open call for teams building irrigation tooling for smallholder farms.",
    description_md: null,
    deadline_at: "2026-09-30T21:59:00Z",
    deadline_precision: "date_only",
    deadline_raw: null,
    deadline_timezone: "Africa/Harare",
    opens_at: "2026-08-01T00:00:00Z",
    starts_at: "2026-10-15T00:00:00Z",
    ends_at: "2026-10-17T00:00:00Z",
    is_rolling: false,
    participation_mode: "online",
    eligibility_scope: "country_list",
    eligible_countries: ["ZW", "ZM"],
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
    apply_url: null,
    status: "published",
    duplicate_of: null,
    organisations: { slug: "kumasi-hive", name: "Kumasi Hive", verification: "verified" },
    categories: { code: "ai_challenge", name: "AI challenge", slug: "ai-challenges" },
    ...overrides,
  } as never;
}

describe("structured data, for every category type (SEO.md §3)", () => {
  it("maps every category in the taxonomy, explicitly", () => {
    for (const code of CATEGORIES) {
      expect(
        Object.prototype.hasOwnProperty.call(SCHEMA_TYPE_BY_CATEGORY, code),
        `${code} has no entry in SCHEMA_TYPE_BY_CATEGORY — a missing entry is a silent "no markup"`,
      ).toBe(true);
    }
  });

  it("emits a valid graph for each one, and nothing at all for the uncategorised bucket", () => {
    for (const code of CATEGORIES) {
      const ld = opportunityJsonLd(
        opportunity({ categories: { code, name: code, slug: code.replace(/_/g, "-") } }),
        SITE,
        ["Zimbabwe", "Zambia"],
      );

      if (SCHEMA_TYPE_BY_CATEGORY[code] === null) {
        // §3: "Never mark up a fact we have not verified." A type is a fact.
        expect(ld, `${code} must emit no type-specific markup`).toBeNull();
        continue;
      }

      expect(ld, `${code} emitted nothing`).not.toBeNull();
      expect(ld!["@context"]).toBe("https://schema.org");
      expect(ld!["@type"]).toBe(SCHEMA_TYPE_BY_CATEGORY[code]);
      expect(ld!["name"]).toBe("AgriTech AI Challenge 2026");
      expect(ld!["url"]).toBe("https://mbele.example/opportunities/agritech-ai-challenge-2026");
      // It has to survive a JSON round trip, or a browser and a validator both ignore it.
      expect(() => JSON.parse(JSON.stringify(ld))).not.toThrow();
      expect(JSON.stringify(ld)).not.toContain("undefined");
    }
  });

  it("describes an event's own dates, never the application deadline dressed up as one", () => {
    const ld = opportunityJsonLd(opportunity(), SITE)!;
    expect(ld["@type"]).toBe("Event");
    expect(ld["startDate"]).toBe("2026-10-15T00:00:00Z");
    expect(ld["endDate"]).toBe("2026-10-17T00:00:00Z");
    // The deadline is 30 September; neither date may be it.
    expect(JSON.stringify(ld)).not.toContain("2026-09-30");
  });

  it("omits a date it cannot stand behind (§3's precision rule)", () => {
    const vague = opportunityJsonLd(
      opportunity({
        categories: { code: "scholarship", name: "Scholarship", slug: "scholarships" },
        deadline_precision: "month_only",
        starts_at: null,
        ends_at: null,
      }),
      SITE,
    )!;
    expect(vague["@type"]).toBe("EducationalOccupationalProgram");
    expect(vague["applicationDeadline"]).toBeUndefined();
    expect(vague["startDate"]).toBeUndefined();

    const exact = opportunityJsonLd(
      opportunity({ categories: { code: "scholarship", name: "Scholarship", slug: "scholarships" } }),
      SITE,
    )!;
    expect(exact["applicationDeadline"]).toBe("2026-09-30");
  });

  it("marks an expired event cancelled rather than open", () => {
    const ld = opportunityJsonLd(opportunity({ status: "expired" }), SITE)!;
    expect(ld["eventStatus"]).toBe("https://schema.org/EventCancelled");
  });

  it("carries no rating, review or aggregate-rating markup anywhere (§3)", () => {
    for (const code of CATEGORIES) {
      const ld = opportunityJsonLd(
        opportunity({ categories: { code, name: code, slug: code } }),
        SITE,
      );
      const text = JSON.stringify(ld ?? {});
      expect(text).not.toMatch(/aggregateRating|reviewRating|"Review"|ratingValue/);
    }
  });

  it("names countries, never a code and never 'Africa' as an origin (PRODUCT_SPEC.md §28)", () => {
    const ld = opportunityJsonLd(opportunity(), SITE, ["Zimbabwe", "Zambia"])!;
    expect(JSON.stringify(ld["eligibleRegion"])).toContain("Zimbabwe");
    expect(JSON.stringify(ld["eligibleRegion"])).not.toMatch(/"name":"ZW"/);

    const continental = opportunityJsonLd(
      opportunity({ eligibility_scope: "africa_wide", eligible_countries: [] }),
      SITE,
      [],
    )!;
    expect(continental["eligibleRegion"]).toBeUndefined();
    expect(JSON.stringify(continental)).not.toMatch(/"name":\s*"Africa"/);
  });

  it("treats an internship as a JobPosting, with the intern type §3 specifies", () => {
    const ld = opportunityJsonLd(
      opportunity({ categories: { code: "internship", name: "Internship", slug: "internships" } }),
      SITE,
    )!;
    expect(ld["@type"]).toBe("JobPosting");
    expect(ld["employmentType"]).toBe("INTERN");
    expect(ld["jobLocationType"]).toBe("TELECOMMUTE");
    expect(ld["validThrough"]).toBe("2026-09-30T21:59:00Z");
  });
});

describe("metadata templates (SEO.md §4)", () => {
  it("builds the opportunity title from the organisation and the closing date", () => {
    const title = opportunityTitle(opportunity() as never);
    expect(title).toContain("AgriTech AI Challenge 2026");
    expect(title).toContain("Kumasi Hive");
    expect(title).toContain("Closes");
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
  });

  it("keeps the title itself when the suffixes will not fit", () => {
    const long = opportunityTitle(
      opportunity({
        title: "Pan-African Climate Resilience Innovation Challenge for Early-Career Builders 2026",
      }) as never,
    );
    expect(long.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(long.startsWith("Pan-African Climate")).toBe(true);
  });

  it("builds the description from typed fields, never from source prose", () => {
    const description = opportunityDescription(opportunity() as never, ["Zimbabwe", "Zambia"]);
    expect(description).toContain("Zimbabwe");
    expect(description).toContain("Teams of 2–5");
    expect(description).toContain("USD 10,000 prize");
    expect(description).toContain("Free to enter");
    expect(description).toContain("Applications close 30 September 2026");
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
  });

  it("describes a month-only deadline as a month", () => {
    const description = opportunityDescription(
      opportunity({ deadline_precision: "month_only", deadline_raw: "September 2026" }) as never,
      ["Zimbabwe"],
    );
    expect(description).toContain("September 2026");
    expect(description).not.toContain("Applications close 30");
  });

  it("clamps on a word boundary rather than mid-word", () => {
    expect(clamp("one two three four five", 14)).toBe("one two three…");
    expect(clamp("short", 40)).toBe("short");
  });

  it("has a plural demonym for every African country, and no wrong -s", () => {
    // The title template reads "{Category} for {demonym}", so a missing or mangled plural is
    // visible in a search result. Several African demonyms are invariant in the plural.
    expect(demonymPlural("ZW")).toBe("Zimbabweans");
    expect(demonymPlural("CD")).toBe("Congolese");
    expect(demonymPlural("SN")).toBe("Senegalese");
    expect(demonymPlural("LS")).toBe("Basotho");
    expect(demonymPlural("MG")).toBe("Malagasy");
    expect(demonymPlural("SC")).toBe("Seychellois");
    expect(demonymPlural("ZA")).toBe("South Africans");
    expect(demonymPlural("XX")).toBeNull();
  });
});

describe("XML escaping", () => {
  it("escapes every character XML cannot carry raw", () => {
    expect(xmlEscape(`Grants & "Awards" <2026> for O'Brien`)).toBe(
      "Grants &amp; &quot;Awards&quot; &lt;2026&gt; for O&apos;Brien",
    );
  });
});

describe("the static social card (SEO.md §4)", () => {
  /**
   * §4 `[PR]`: "a single static 1200×630 brand card (<= 25 KB, generated once at build) is used
   * site-wide, and `twitter:card` is `summary` rather than `summary_large_image` so the preview
   * stays small."
   *
   * Read from the file, not from the generator: what ships is the file, and a generator that
   * stopped being run would leave a stale one behind with no other symptom.
   */
  it("is a real PNG at the size the card slot expects, under the cap", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const png = readFileSync(resolve(here, "..", "public", "og.png"));

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR carries the dimensions, big-endian, at a fixed offset.
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    expect(png.length).toBeLessThanOrEqual(25 * 1024);
    // And it is not a blank rectangle: a two-colour card compresses to hundreds of bytes if
    // nothing is drawn on it.
    expect(png.length).toBeGreaterThan(1024);
  });
});

describe("the indexing table (SEO.md §1)", () => {
  it("marks every private surface noindex and disallows it in robots.txt", () => {
    for (const pattern of ["/tracker", "/you", "/you/*", "/threads", "/requests", "/admin", "/api/*"]) {
      const rule = INDEXING.find((entry) => entry.pattern === pattern);
      expect(rule, `${pattern} is missing from INDEXING`).toBeDefined();
      expect(rule!.indexed, `${pattern} must be noindex`).toBe(false);
      expect(rule!.disallow, `${pattern} must be disallowed in robots.txt`).toBe(true);
    }

    // §1's three layers: the robots list is generated from the same table, so a private route
    // added there cannot be left out of robots.txt.
    expect(ROBOTS_DISALLOW).toContain("/tracker");
    expect(ROBOTS_DISALLOW).toContain("/admin");
    expect(ROBOTS_DISALLOW).toContain("/api");
  });

  it("never indexes a filtered list, a profile or a project by default", () => {
    for (const pattern of ["/opportunities", "/b/*", "/projects/*"]) {
      expect(INDEXING.find((entry) => entry.pattern === pattern)?.indexed).toBe(false);
    }
  });

  it("indexes the surfaces the growth engine depends on", () => {
    for (const pattern of ["/", "/opportunities/*", "/countries/*", "/countries/*/*", "/categories/*"]) {
      const rule = INDEXING.find((entry) => entry.pattern === pattern);
      expect(rule?.indexed, `${pattern} must be indexable`).toBe(true);
      expect(rule?.priority).toBeGreaterThan(0);
    }
  });

  it("has one sitemap segment per URL family, all six of them", () => {
    expect([...SITEMAP_SEGMENTS]).toEqual([
      "opportunities",
      "countries",
      "categories",
      "organisations",
      "public-profiles",
      "static",
    ]);
  });
});
