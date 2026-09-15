import type { APIRoute } from "astro";

import { SITEMAP_MAX_URLS } from "@mbele/config";
import { getSitemapProfiles } from "~/lib/db";
import { sitemapXml, xmlResponse } from "~/lib/seo";

/**
 * Public profiles that asked to be indexed, and only those.
 *
 * SEO.md §1: "Profiles and projects are never indexed without an explicit per-object opt-in. A
 * user who fills in a profile has not consented to being findable on Google." Both flags are
 * checked in the query (`visibility = 'public'` AND `indexable = true`), because this file is
 * the one place where getting it wrong would be invisible on every page.
 *
 * Empty until somebody opts in, which is the correct output and not a bug. An empty sitemap is
 * valid, and Search Console reporting zero indexed profiles is exactly the truth.
 */
export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, string> } }).runtime?.env ?? {};
  const rows = await getSitemapProfiles(env, SITEMAP_MAX_URLS);

  return xmlResponse(
    sitemapXml(
      rows.map((row) => ({
        path: `/b/${row.slug}`,
        lastmod: row.lastmod,
        changefreq: "weekly",
        priority: 0.3,
      })),
      url,
    ),
  );
};
