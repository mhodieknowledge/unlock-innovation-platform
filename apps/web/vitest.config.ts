/// <reference types="vitest" />
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { getViteConfig } from "astro/config";

// Astro's own Vite config, so .astro files transform and the container API can
// render real pages in-process. The Svelte plugin has to be added by hand:
// getViteConfig does not pull in an integration's Vite plugins, so without it
// vitest hands .svelte source straight to esbuild and fails on the template.
export default getViteConfig({
  plugins: [svelte()],
  test: {
    name: "web",
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.astro/**"],
  },
});
