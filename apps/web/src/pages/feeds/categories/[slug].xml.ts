import type { APIRoute } from "astro";

import { BRAND } from "@mbele/config";
import { getCategoryCounts, listOpportunities } from "~/lib/db";
import { opportunityDescription, rssXml, xmlResponse } from "~/lib/seo";

/** One kind of opportunity, across the continent. SEO.md §7. */
export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, string> } }).runtime?.env ?? {};
  const categories = await getCategoryCounts(env);
  const category = categories.find((row) => row.slug === params["slug"]) ?? null;

  if (!category) {
    return new Response("No such category feed.\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, s-maxage=300" },
    });
  }

  const result = await listOpportunities({ categoryCode: category.code, limit: 50 }, env);
  const rows = result.ok ? result.data : [];

  return xmlResponse(
    rssXml(
      {
        title: `${BRAND.name} — ${category.name}`,
        path: `/feeds/categories/${category.slug}.xml`,
        description: `${category.name} opportunities open to builders across Africa, soonest deadline first.`,
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
  );
};
