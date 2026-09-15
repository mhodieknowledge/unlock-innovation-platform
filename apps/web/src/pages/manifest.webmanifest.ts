import type { APIRoute } from "astro";

import { BRAND } from "@mbele/config";

/**
 * The web app manifest. PRODUCT_SPEC.md §25.3: "PWA, installable."
 *
 * A ROUTE rather than a file in public/, for one reason: PRODUCT_SPEC.md §1 makes the brand
 * name a configuration token, and a static manifest would be a second copy of it — the exact
 * drift this codebase has already been bitten by five times. Prerendered, so it costs a
 * build step and no request-time work, and lands in dist as a plain file.
 *
 * `theme_color` and `background_color` are the two token values an operating system needs
 * before any CSS has loaded; they match --brand and --surface in styles/tokens.css. There is
 * no third: everything else the installed app draws comes from the stylesheet.
 */
export const prerender = true;

const MANIFEST = {
  id: "/",
  name: `${BRAND.name} — open opportunities across Africa`,
  short_name: BRAND.name,
  description:
    "Open opportunities across Africa, with a straight answer on whether you can apply.",
  // ANALYTICS.md §3: a launch from the installed app is distinguishable from a browser visit
  // without a cookie, a fingerprint or a redirect.
  start_url: "/?src=pwa",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#fbfbf9",
  theme_color: "#1c3f94",
  lang: "en",
  categories: ["education", "productivity"],
  icons: [
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
  ],
  shortcuts: [
    { name: "Your tracker", url: "/tracker" },
    // `deadline_state` is the parameter parseFilters reads. An earlier draft of this file
    // used `?deadline=7`, which is not a filter this product has: the shortcut opened an
    // unfiltered list, and nothing anywhere would have said so.
    { name: "Closing this week", url: "/opportunities?deadline_state=closing_this_week" },
  ],
} as const;

export const GET: APIRoute = () =>
  new Response(JSON.stringify(MANIFEST, null, 2), {
    headers: { "content-type": "application/manifest+json; charset=utf-8" },
  });
