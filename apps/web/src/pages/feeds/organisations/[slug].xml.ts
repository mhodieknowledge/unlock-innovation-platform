import type { APIRoute } from "astro";

import { BRAND } from "@mbele/config";
import { getOrganisation } from "~/lib/db";
import { opportunityDescription, rssXml, xmlResponse } from "~/lib/seo";

/**
 * One organisation's open calls. SEO.md §7.
 *
 * Also the partnership surface §7 describes: an organisation that claimed its page has a feed it
 * can put on its own site, which is a reason to link to us that costs them nothing.
 */
export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, string> } }).runtime?.env ?? {};
  const found = await getOrganisation(String(params["slug"] ?? ""), env);

  if (!found.ok) {
    return new Response("No such organisation feed.\n", {
      status: found.reason === "not_found" ? 404 : 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, s-maxage=300" },
    });
  }

  const { organisation, open } = found.data;

  return xmlResponse(
    rssXml(
      {
        title: `${BRAND.name} — ${organisation.name}`,
        path: `/feeds/organisations/${organisation.slug}.xml`,
        description: `Open opportunities and programmes from ${organisation.name}.`,
      },
      open.map((row) => ({
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
