/// <reference types="vitest" />
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import { getViteConfig } from "astro/config";

// Astro's own Vite config, so .astro files transform and the container API can
// render real pages in-process. The Svelte plugin has to be added by hand:
// getViteConfig does not pull in an integration's Vite plugins, so without it
// vitest hands .svelte source straight to esbuild and fails on the template.
export default getViteConfig({
  plugins: [svelte()],

  resolve: {
    alias: {
      // The two resolutions the real build has and getViteConfig does not.
      //
      // `~/*` is a tsconfig path Astro's build honours and vitest's Vite config does not, so
      // a page importing `~/lib/...` resolved in production and failed here — the sort of
      // difference that makes a test suite an unreliable witness.
      //
      // `cloudflare:workers` is built into workerd and cannot be resolved by Node at all.
      // The stub says there are no bindings, which is true in a test.
      "~": fileURLToPath(new URL("./src", import.meta.url)),
      "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },

  test: {
    name: "web",
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.astro/**"],
  },
});
