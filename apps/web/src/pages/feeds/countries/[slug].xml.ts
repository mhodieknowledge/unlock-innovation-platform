import type { APIRoute } from "astro";

import { BRAND } from "@mbele/config";
import { getCountryBySlug, listOpportunities } from "~/lib/db";
import { opportunityDescription, rssXml, xmlResponse } from "~/lib/seo";

/**
 * One country's feed. SEO.md §7: "RSS feeds per country, category, organisation and
 * closing-soon. Free, zero-JS, machine-readable, and directly consumable by Telegram channel
 * bots — which means our feed can propagate through the ecosystem's existing distribution rather
 * than competing with it."
 *
 * Same predicate as the country page, so a community leader who subscribes a channel to this
 * feed sees what the page they forwarded shows.
 */
export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, string> } }).runtime?.env ?? {};
  const country = await getCountryBySlug(params["slug"], env);

  if (!country) {
    return new Response("No such country feed.\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, s-maxage=300" },
    });
  }

  const result = await listOpportunities({ countryIso2: country.iso2, limit: 50 }, env);
  const rows = result.ok ? result.data : [];

  return xmlResponse(
    rssXml(
      {
        title: `${BRAND.name} — open to ${country.name}`,
        path: `/feeds/countries/${country.slug}.xml`,
        description: `Opportunities open to builders in ${country.name}, soonest deadline first.`,
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
