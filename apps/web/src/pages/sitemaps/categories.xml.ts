import type { APIRoute } from "astro";

import { INDEXING } from "@mbele/config";
import { getCategoryCounts } from "~/lib/db";
import { sitemapXml, xmlResponse } from "~/lib/seo";
import { runtimeEnv } from "~/lib/runtime";

/** Category pages. SEO.md §1: priority 0.7, daily. */
export const prerender = false;

const RULE = INDEXING.find((rule) => rule.pattern === "/categories/*");
const INDEX = INDEXING.find((rule) => rule.pattern === "/categories");

export const GET: APIRoute = async ({ url, locals }) => {
  const env = runtimeEnv();
  const categories = await getCategoryCounts(env);

  return xmlResponse(
    sitemapXml(
      [
        {
          path: "/categories",
          lastmod: null,
          changefreq: INDEX?.changefreq ?? null,
          priority: INDEX?.priority ?? null,
        },
        ...categories.map((row) => ({
          path: `/categories/${row.slug}`,
          lastmod: null,
          changefreq: RULE?.changefreq ?? null,
          priority: RULE?.priority ?? null,
        })),
      ],
      url,
    ),
  );
};
