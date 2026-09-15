import type { APIRoute } from "astro";

import { INDEXING } from "@mbele/config";
import { sitemapXml, xmlResponse } from "~/lib/seo";

/**
 * The pages that do not come from the database: the board and the policy pages.
 *
 * Built from SEO.md §1's own table rather than a hand-kept list — `INDEXING` holds the indexing
 * decision, the priority and the changefreq for every route, so a page that is `noindex` cannot
 * accidentally appear here and a new policy page appears the moment it is added there.
 *
 * `lastmod` is omitted rather than set to now(): §5 wants a real modification time, and for a
 * page whose content is in a template the real answer is "when it was last deployed", which this
 * route does not know.
 */
export const prerender = false;

const STATIC_ROUTES = INDEXING.filter(
  (rule) => rule.indexed && rule.priority !== null && !rule.pattern.includes("*") &&
    rule.pattern !== "/countries" && rule.pattern !== "/categories",
);

export const GET: APIRoute = ({ url }) =>
  xmlResponse(
    sitemapXml(
      STATIC_ROUTES.map((rule) => ({
        path: rule.pattern,
        lastmod: null,
        changefreq: rule.changefreq,
        priority: rule.priority,
      })),
      url,
    ),
  );
