import type { APIRoute } from "astro";

import { INDEXING, SITEMAP_MAX_URLS } from "@mbele/config";
import { getSitemapOpportunities } from "~/lib/db";
import { sitemapXml, xmlResponse } from "~/lib/seo";
import { runtimeEnv } from "~/lib/runtime";

/**
 * Every published, unexpired opportunity. SEO.md §1 gives them priority 0.9 and `daily`, and §5
 * says "Expired opportunities are removed from sitemaps on expiry" — which is done by the query,
 * not by a sweep, so it cannot lag.
 */
export const prerender = false;

const RULE = INDEXING.find((rule) => rule.pattern === "/opportunities/*");

export const GET: APIRoute = async ({ url, locals }) => {
  const env = runtimeEnv();
  const rows = await getSitemapOpportunities(env, SITEMAP_MAX_URLS);

  return xmlResponse(
    sitemapXml(
      rows.map((row) => ({
        path: `/opportunities/${row.slug}`,
        lastmod: row.lastmod,
        changefreq: RULE?.changefreq ?? null,
        priority: RULE?.priority ?? null,
      })),
      url,
    ),
  );
};
