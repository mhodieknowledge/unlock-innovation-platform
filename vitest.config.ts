import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Two projects with different needs: the packages are framework-free and run
    // on plain esbuild, while apps/web needs Astro's Vite pipeline so .astro
    // pages can be rendered through the container API.
    projects: [
      {
        test: {
          name: "packages",
          include: ["packages/*/test/**/*.test.ts"],
          // Without this, a stray `tsc` build output under packages/*/dist gets
          // collected alongside the sources and every test runs twice — which
          // inflates the count and masks a source/build divergence.
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
      },
      "./apps/web/vitest.config.ts",
    ],
  },
});
