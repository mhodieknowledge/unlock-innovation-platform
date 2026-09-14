import cloudflare from "@astrojs/cloudflare";
import svelte from "@astrojs/svelte";
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// ADR 0001: Astro + Svelte islands, not Next.js/OpenNext. Cloudflare Workers is
// unchanged as the request tier (SYSTEM_ARCHITECTURE.md §2, §4.1).
export default defineConfig({
  output: "static",
  adapter: cloudflare({ imageService: "passthrough" }),
  integrations: [svelte()],
  vite: {
    plugins: [tailwind()],
    // Nothing is inlined into the HTML — not a stylesheet (below), not a page script,
    // not a data URI. Astro inlines a small, import-free page script into an inline
    // <script type="module"> by default, and the CSP in public/_headers carries no
    // 'unsafe-inline': the script would be BLOCKED IN PRODUCTION AND NOWHERE ELSE, which
    // is the worst possible failure mode — a feature that works in dev, passes review and
    // is silently inert for every real user. apps/web/test/csp.test.ts asserts this
    // setting stays put, because the default is to inline and the default is wrong here.
    build: { assetsInlineLimit: 0 },
  },

  // Stylesheets are served externally, NOT inlined. SECURITY.md §5 forbids
  // `unsafe-inline` outright and specifies a nonce-based CSP; a statically
  // generated page cannot carry a per-response nonce, so an inline <style> would
  // force us to weaken style-src. One extra request buys a strict CSP, and the
  // file is immutable-cached and shared across every route, so a browse session
  // pays for it once.
  build: { inlineStylesheets: "never", assets: "_a" },
  compressHTML: true,

  // No third-party scripts on public pages, ever (invariant 12). Astro ships no
  // client JS unless an island asks for it.
  prefetch: false,
  devToolbar: { enabled: false },
});
