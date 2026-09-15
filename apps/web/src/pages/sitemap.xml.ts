import type { APIRoute } from "astro";

import { SITEMAP_SEGMENTS } from "@mbele/config";
import { sitemapIndexXml, xmlResponse } from "~/lib/seo";

/**
 * The sitemap index. SEO.md §5: "Sitemaps, regenerated nightly, segmented so each stays under
 * 50,000 URLs."
 *
 * Segmented for the reason §8 gives: "Indexed pages by type" is a metric, and a single sitemap
 * cannot tell you which type stopped being indexed. Six files means Search Console reports six
 * numbers, and the thin-content redirect rule misfiring shows up as one of them collapsing.
 *
 * Rendered on demand rather than nightly: a crawler that arrives an hour after we publish should
 * find the new URL, and an hour of edge cache is the whole cost of that.
 */
export const prerender = false;

export const GET: APIRoute = ({ url }) =>
  xmlResponse(
    sitemapIndexXml(
      SITEMAP_SEGMENTS.map((segment) => `/sitemaps/${segment}.xml`),
      url,
    ),
  );
