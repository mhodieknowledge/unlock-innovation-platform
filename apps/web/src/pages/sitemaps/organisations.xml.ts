import type { APIRoute } from "astro";

import { INDEXING, SITEMAP_MAX_URLS } from "@mbele/config";
import { getSitemapOrganisations } from "~/lib/db";
import { sitemapXml, xmlResponse } from "~/lib/seo";

/** Organisation pages. SEO.md §1: priority 0.7, weekly. */
export const prerender = false;

const RULE = INDEXING.find((rule) => rule.pattern === "/organisations/*");

export const GET: APIRoute = async ({ url, locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, string> } }).runtime?.env ?? {};
  const rows = await getSitemapOrganisations(env, SITEMAP_MAX_URLS);

  return xmlResponse(
    sitemapXml(
      rows.map((row) => ({
        path: `/organisations/${row.slug}`,
        lastmod: row.lastmod,
        changefreq: RULE?.changefreq ?? null,
        priority: RULE?.priority ?? null,
      })),
      url,
    ),
  );
};
