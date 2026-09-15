/**
 * What the data layer actually asks PostgREST for.
 *
 * Every other test of this layer mocks `db.ts` wholesale, so the queries themselves
 * have never been exercised by anything but production. That matters more here than it
 * would elsewhere, because the failure mode of a PostgREST query is not an error — it
 * is a request that succeeds and quietly returns the wrong rows.
 *
 * The one this repo has already met: a filter on an embedded resource is ACCEPTED with
 * the default left join and silently matches everything, so `categories.code=eq.x`
 * rendered a chip and changed nothing until `!inner` was added. A unit test on the
 * returned data cannot see that — only the URL can — so these assert the URL.
 */

import { describe, expect, it, vi } from "vitest";

import { getEntryPoints, listOpportunities } from "../src/lib/db";

const ENV = { SUPABASE_URL: "https://db.invalid", SUPABASE_ANON_KEY: "anon" };

/** Every request URL the client would send, decoded so the assertions stay readable. */
async function urlsFor(run: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = (input as { url?: string })?.url ?? String(input);
      seen.push(decodeURIComponent(url));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  try {
    await run();
  } finally {
    vi.unstubAllGlobals();
  }
  return seen;
}

const opportunityQuery = (urls: string[]) => urls.find((u) => u.includes("/opportunities?")) ?? "";
const categoryQuery = (urls: string[]) => urls.find((u) => u.includes("/categories?")) ?? "";

describe("listOpportunities query", () => {
  it("inner-joins categories when filtering by one, or the filter matches everything", async () => {
    const url = opportunityQuery(
      await urlsFor(() => listOpportunities({ categoryCode: "hackathon" }, ENV)),
    );

    expect(url).toContain("categories!inner");
    expect(url).toContain("categories.code=eq.hackathon");
  });

  it("does not inner-join categories when it is not filtering by one", async () => {
    // An opportunity whose category could not be resolved has a null category_id, and
    // an unconditional inner join would drop it from the board entirely.
    const url = opportunityQuery(await urlsFor(() => listOpportunities({}, ENV)));

    expect(url).not.toContain("categories!inner");
    expect(url).toContain("categories(");
  });

  it("over-fetches when it is going to spread, because rebalancing can only remove rows", async () => {
    const url = opportunityQuery(await urlsFor(() => listOpportunities({ limit: 20 }, ENV)));
    expect(url).toContain("limit=60");
  });

  it("fetches exactly what was asked for when the order is the promise", async () => {
    // A category page is already one category, and a feed is strictly by deadline.
    // Neither spreads, so neither pays for the larger query.
    const strict = opportunityQuery(
      await urlsFor(() => listOpportunities({ limit: 20, strictUrgency: true }, ENV)),
    );
    expect(strict).toContain("limit=20");

    const category = opportunityQuery(
      await urlsFor(() => listOpportunities({ limit: 20, categoryCode: "grant" }, ENV)),
    );
    expect(category).toContain("limit=20");
  });

  it("keeps the deadline order PRODUCT_SPEC.md §13.4 requires, nulls last", async () => {
    const url = opportunityQuery(await urlsFor(() => listOpportunities({ limit: 20 }, ENV)));
    expect(url).toContain("order=deadline_at.asc.nullslast");
  });
});

describe("getEntryPoints query", () => {
  it("inner-joins so a category with nothing published is left out", async () => {
    const url = categoryQuery(await urlsFor(() => getEntryPoints(ENV)));

    expect(url).toContain("opportunities!inner");
    // Without these the join would count drafts and deleted rows as records, and the
    // nav would advertise a category whose page renders nothing.
    expect(url).toContain("opportunities.status=eq.published");
    expect(url).toContain("opportunities.deleted_at=is.null");
    expect(url).toContain("opportunities.duplicate_of=is.null");
  });

  it("asks for one embedded row, not every published id in the category", async () => {
    // This query runs on every page that renders the nav. One row proves the category
    // is not empty; the rest would be payload nobody reads.
    const url = categoryQuery(await urlsFor(() => getEntryPoints(ENV)));
    expect(url).toContain("opportunities.limit=1");
  });
});
