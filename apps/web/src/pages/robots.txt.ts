import type { APIRoute } from "astro";

import { ROBOTS_DISALLOW } from "@mbele/config";

/**
 * robots.txt. SEO.md §5.
 *
 * A ROUTE and not a static file, for two reasons. The `Sitemap:` line has to carry an absolute
 * URL, and the only thing that knows the host is the request. And the `Disallow` list is §1's
 * second layer of three — "Private surfaces are `noindex, nofollow` AND blocked in robots.txt
 * AND unreachable without a session ... because one will eventually be misconfigured" — so it is
 * generated from the same `INDEXING` table the pages and the sitemap read. A private route added
 * there is disallowed here without anybody remembering to do it.
 *
 * `Disallow: /*?` blocks filtered views. It is a wildcard Google and Bing both honour, and it is
 * the difference between one indexable list page and a combinatorial explosion of thin ones.
 */
export const prerender = false;

export const GET: APIRoute = ({ url }) => {
  const lines = [
    "User-agent: *",
    "Allow: /",
    ...ROBOTS_DISALLOW.map((path) => `Disallow: ${path}`),
    // Filtered and paginated views: user tools, not content (SEO.md §1).
    "Disallow: /*?",
    "",
    `Sitemap: ${new URL("/sitemap.xml", url).href}`,
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, s-maxage=86400",
    },
  });
};
