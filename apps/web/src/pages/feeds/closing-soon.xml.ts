import type { APIRoute } from "astro";

import { BRAND } from "@mbele/config";
import { searchOpportunities } from "~/lib/db";
import { opportunityDescription, rssXml, xmlResponse } from "~/lib/seo";

/**
 * Everything closing within a week. SEO.md §7 `[PR]`.
 *
 * The most useful of the four feeds and the one a Telegram channel bot will actually poll: a
 * deadline product's feed should be about deadlines, not about what we added.
 *
 * `pubDate` is deliberately absent. RSS readers sort and de-duplicate on it, and the honest
 * publication date of an opportunity is when the ORGANISER opened it — which we usually do not
 * know. Using our own ingestion time would make a six-month-old call look new every time we
 * re-verified it. The guid is the opportunity URL, which is stable and is what a reader wants
 * de-duplicated on.
 */
export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, string> } }).runtime?.env ?? {};

  const result = await searchOpportunities(
    { deadlineState: "closing_this_week", sort: "urgency", limit: 50 },
    env,
  );
  const rows = result.ok ? result.data.rows : [];

  return xmlResponse(
    rssXml(
      {
        title: `${BRAND.name} — closing this week`,
        path: "/feeds/closing-soon.xml",
        description:
          "Opportunities open to builders across Africa whose deadline falls within the next seven days.",
      },
      rows.map((row) => ({
        title: row.title,
        path: `/opportunities/${row.slug}`,
        guid: `/opportunities/${row.slug}`,
        description: opportunityDescription(row),
        published: null,
      })),
      url,
    ),
    // Shorter than the sitemaps: a feed about deadlines is stale within the hour by definition.
    900,
  );
};
