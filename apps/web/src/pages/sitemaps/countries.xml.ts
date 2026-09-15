import type { APIRoute } from "astro";

import { INDEXING, SEO_MATRIX_FLOOR } from "@mbele/config";
import { getCountryCounts, getMatrixCells } from "~/lib/db";
import { sitemapXml, xmlResponse } from "~/lib/seo";
import { runtimeEnv } from "~/lib/runtime";

/**
 * Country pages, and the matrix cells that have enough in them to be pages.
 *
 * `SEO_MATRIX_FLOOR` is the same constant the matrix route applies. That is the whole point of
 * it living in @mbele/config: a sitemap that advertises a URL which 301-redirects is the exact
 * misfire SEO.md §8 asks to be measured, and the only way to be sure it cannot happen is for
 * both sides to read one number.
 *
 * All 54 country pages are listed regardless of their counts (§2: they are generated for all 54,
 * because Africa-wide and global opportunities give every country real content).
 */
export const prerender = false;

const COUNTRY = INDEXING.find((rule) => rule.pattern === "/countries/*");
const CELL = INDEXING.find((rule) => rule.pattern === "/countries/*/*");
const INDEX = INDEXING.find((rule) => rule.pattern === "/countries");

export const GET: APIRoute = async ({ url, locals }) => {
  const env = runtimeEnv();
  const [countries, cells] = await Promise.all([getCountryCounts(env), getMatrixCells(null, env)]);

  return xmlResponse(
    sitemapXml(
      [
        {
          path: "/countries",
          lastmod: null,
          changefreq: INDEX?.changefreq ?? null,
          priority: INDEX?.priority ?? null,
        },
        ...countries.map((row) => ({
          path: `/countries/${row.slug}`,
          lastmod: null,
          changefreq: COUNTRY?.changefreq ?? null,
          priority: COUNTRY?.priority ?? null,
        })),
        ...cells
          .filter((cell) => cell.open_count >= SEO_MATRIX_FLOOR)
          .map((cell) => ({
            path: `/countries/${cell.country_slug}/${cell.category_slug}`,
            lastmod: null,
            changefreq: CELL?.changefreq ?? null,
            priority: CELL?.priority ?? null,
          })),
      ],
      url,
    ),
  );
};
