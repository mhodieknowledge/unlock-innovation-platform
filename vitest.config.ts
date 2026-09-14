import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // Without this, a stray `tsc` build output under packages/*/dist gets
    // collected alongside the sources and every test runs twice — which inflates
    // the count and would quietly mask a source/build divergence.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.astro/**", "**/.wrangler/**"],
    reporters: ["default"],
  },
});
