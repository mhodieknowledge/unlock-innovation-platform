/**
 * Hybrid retrieval, against a real database. SYSTEM_ARCHITECTURE.md §6.
 *
 * The first test in here exists because of a bug that was invisible from every angle
 * except this one. 0005's trigger built `search_vector` with the `simple` text-search
 * configuration (no stemming, so "climate" stayed 'climate'); the search function queried
 * with `english` (which stems, so "climate" became 'climat'). The two never matched on any
 * word English stems, which is most words. Full-text search returned nothing for almost
 * every query — and nothing looked broken: the vectors were populated, the GIN index
 * existed, the query ran without error, the result was empty.
 *
 * A unit test could not have caught it. Only asking the real database for a word that is
 * definitely in the corpus could.
 */

import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyDiversity, urgencyBoost, ELIGIBILITY_BOOST } from "@mbele/config";

const CONN = process.env["DATABASE_URL"] ?? process.env["SUPABASE_DB_URL"];

let client: pg.Client;
const orgA = randomUUID();
const orgB = randomUUID();
const ids: Record<string, string> = {};

beforeAll(async () => {
  if (!CONN) {
    throw new Error("Set DATABASE_URL for this command only (invariant 11). This check cannot skip.");
  }
  client = new pg.Client({ connectionString: CONN });
  await client.connect();

  await client.query(
    `INSERT INTO organisations (id, name, slug, website_domain) VALUES
       ($1, 'Search Fixture Foundation', $3, 'searchfixture.example'),
       ($2, 'Second Fixture Collective', $4, 'second.example')`,
    [orgA, orgB, `search-fixture-${orgA.slice(0, 8)}`, `second-fixture-${orgB.slice(0, 8)}`],
  );

  const insert = async (
    key: string,
    title: string,
    summary: string,
    category: string,
    org: string,
    days: number,
    scope: string,
    countries: string[],
    verification = "verified",
  ) => {
    const id = randomUUID();
    ids[key] = id;
    await client.query(
      `INSERT INTO opportunities
         (id, slug, title, summary, category_id, organisation_id, status, verification,
          last_verified_at, cost, source_url, deadline_at, deadline_precision, published_at,
          eligibility_scope, eligible_countries, link_ok, participation_mode)
       VALUES ($1,$2,$3,$4,(SELECT id FROM categories WHERE code=$5),$6,'published',$7::opp_verification,
               now(),'free',$8, now() + make_interval(days => $9), 'date_only', now(),
               $10::eligibility_scope, $11::char(2)[], true, 'online')`,
      [
        id,
        `search-fx-${id.slice(0, 12)}`,
        title,
        summary,
        category,
        org,
        verification,
        `https://searchfixture.example/${id.slice(0, 8)}`,
        days,
        scope,
        countries,
      ],
    );
    return id;
  };

  await insert(
    "climate",
    "Climate Innovation Grant for Southern Africa",
    "Funding for early-stage climate ventures led by young people.",
    "grant",
    orgA,
    9,
    "country_list",
    ["ZW", "ZM"],
  );
  await insert(
    "hackathon",
    "Pan-African AI Hackathons and Coding Sprints",
    "A weekend build sprint for machine-learning engineers.",
    "hackathon",
    orgB,
    5,
    "africa_wide",
    [],
  );
  await insert(
    "scholarship",
    "Engineering Scholarship for Ghanaian Students",
    "Full tuition for undergraduate engineering study in Ghana.",
    "scholarship",
    orgB,
    40,
    "country_list",
    ["GH"],
  );
  await insert(
    "stale",
    "Cote d'Ivoire Entrepreneurship Fund",
    "Grants for small businesses.",
    "grant",
    orgA,
    20,
    "country_list",
    ["CI"],
    "stale",
  );
  await insert(
    "expired",
    "Climate Fund That Has Already Closed",
    "This one is in the past.",
    "grant",
    orgA,
    -10,
    "country_list",
    ["ZW"],
  );
}, 60_000);

afterAll(async () => {
  if (!client) return;
  await client.query("DELETE FROM opportunities WHERE organisation_id IN ($1,$2)", [orgA, orgB]);
  await client.query("DELETE FROM organisations WHERE id IN ($1,$2)", [orgA, orgB]);
  await client.end();
});

const search = async (query: string | null, ...rest: unknown[]) => {
  const { rows } = await client.query(
    "SELECT * FROM search_candidates($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [query, null, null, rest[0] ?? null, rest[1] ?? null, null, null, null, null, 120],
  );
  return rows as Array<Record<string, any>>;
};

describe("full-text search", () => {
  it("finds a word that is in the corpus — the regression that started this file", () => {
    // If this fails, the indexing and querying configurations have drifted apart again.
    return search("climate").then((rows) => {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((r) => r.id)).toContain(ids.climate);
    });
  });

  it("stems, so a plural query finds a singular title", async () => {
    // "scholarships" -> 'scholarship'. This is the specific behaviour the `simple`
    // configuration did not have, and the reason the bug was invisible.
    const rows = await search("scholarships");
    expect(rows.map((r) => r.id)).toContain(ids.scholarship);
  });

  it("stems the other direction too", async () => {
    const rows = await search("hackathon");
    expect(rows.map((r) => r.id)).toContain(ids.hackathon);
  });

  it("ignores accents in both directions", async () => {
    // "Côte d'Ivoire" and "Cote d'Ivoire" have to be the same token, on the indexing
    // side AND the querying side. unaccent in the configuration is what makes the second
    // half true.
    const withAccent = await search("Côte d'Ivoire");
    const withoutAccent = await search("Cote d'Ivoire");
    expect(withAccent.map((r) => r.id)).toContain(ids.stale);
    expect(withoutAccent.map((r) => r.id)).toContain(ids.stale);
  });

  it("searches the organisation name, at weight B", async () => {
    const rows = await search("Second Fixture Collective");
    expect(rows.map((r) => r.id)).toContain(ids.hackathon);
  });

  it("understands a quoted phrase", async () => {
    // websearch_to_tsquery, not plainto_: people type quotes and minus signs.
    const rows = await search('"climate ventures"');
    expect(rows.map((r) => r.id)).toContain(ids.climate);
  });

  it("never raises on punctuation a person might type", async () => {
    for (const query of ["", "   ", "!!!", "a & b | c", "'unterminated", "-- comment"]) {
      await expect(search(query)).resolves.toBeInstanceOf(Array);
    }
  });

  it("excludes expired records entirely (§5.4)", async () => {
    // "removed from active surfaces... excluded from all search and feeds". They keep
    // their URL; they are not results.
    const rows = await search("climate");
    expect(rows.map((r) => r.id)).not.toContain(ids.expired);
  });
});

describe("browse with no query", () => {
  it("orders by urgency, which PRODUCT_SPEC.md §13.4 makes the default", async () => {
    const rows = await search(null);
    const ours = rows.filter((r) => Object.values(ids).includes(r.id));
    const deadlines = ours.map((r) => new Date(r.deadline_at).getTime());
    expect(deadlines).toEqual([...deadlines].sort((a, b) => a - b));
  });

  it("filters by country, including africa_wide and global scopes", async () => {
    const rows = await search(null, "ZW");
    const returned = rows.map((r) => r.id);
    expect(returned).toContain(ids.climate);
    // Africa-wide is open to Zimbabwe even with an empty country list.
    expect(returned).toContain(ids.hackathon);
    // Ghana-only is not.
    expect(returned).not.toContain(ids.scholarship);
  });

  it("filters by category", async () => {
    const rows = await search(null, null, "hackathon");
    const ours = rows.filter((r) => Object.values(ids).includes(r.id));
    expect(ours.map((r) => r.id)).toEqual([ids.hackathon]);
  });
});

describe("degraded mode (§6.2)", () => {
  it("works with no embedding at all, and says nothing about it", async () => {
    // §6.2 `[PR]`: "If the embedding provider is unavailable: FTS-only... Users see no
    // error." A NULL embedding is the whole of that path, so it has to be ordinary.
    const rows = await search("climate");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.rank_vec).toBeNull();
    expect(rows[0]?.rank_fts).toBe(1);
  });

  it("returns signals rather than a final score", async () => {
    // The weights live in ranking.ts, which §6.1 [TD] requires to be one file. SQL
    // returning a finished score would put them in two places.
    const rows = await search("climate");
    const row = rows[0]!;
    expect(row).toHaveProperty("rrf");
    expect(row).toHaveProperty("verification");
    expect(row).toHaveProperty("deadline_at");
    expect(row).toHaveProperty("organisation_slug");
    expect(row).toHaveProperty("category_code");
    expect(row).not.toHaveProperty("score");
  });

  it("hands the caller everything the ranking formula needs", async () => {
    // Proving the division of labour actually works: take the signals, apply the
    // weights from the config package, get a ranking.
    const rows = await search(null);
    const ranked = rows
      .filter((r) => Object.values(ids).includes(r.id))
      .map((r) => ({
        id: r.id,
        organisation: r.organisation_slug as string | null,
        category: r.category_code as string | null,
        score:
          Number(r.rrf) *
          urgencyBoost(r.deadline_at) *
          (ELIGIBILITY_BOOST[(r.verdict ?? "unclear") as keyof typeof ELIGIBILITY_BOOST] ?? 1),
      }))
      .sort((a, b) => b.score - a.score);

    expect(ranked.length).toBeGreaterThan(0);
    expect(applyDiversity(ranked, (r) => ({ organisation: r.organisation, category: r.category })))
      .toHaveLength(ranked.length);
  });
});

describe("cold start (§8)", () => {
  it("closing_soon_for_country never returns an empty surface for a known country", async () => {
    // §8 `[PR]`: "Never show an empty recommendation surface — show the country's
    // closing-soon list with an honest label instead."
    const { rows } = await client.query("SELECT * FROM closing_soon_for_country($1,$2)", ["ZW", 10]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("works for an anonymous visitor with no country at all", async () => {
    const { rows } = await client.query("SELECT * FROM closing_soon_for_country(NULL, 5)");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  it("excludes expired records from the cold-start board too", async () => {
    const { rows } = await client.query("SELECT * FROM closing_soon_for_country($1,$2)", ["ZW", 50]);
    expect(rows.map((r) => r.id)).not.toContain(ids.expired);
  });
});
