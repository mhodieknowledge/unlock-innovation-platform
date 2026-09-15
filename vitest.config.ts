import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Two projects with different needs: the packages are framework-free and run
    // on plain esbuild, while apps/web needs Astro's Vite pipeline so .astro
    // pages can be rendered through the container API.
    projects: [
      {
        /**
         * Repo-level audits: the structural half of README.md §5's invariants, and the check that
         * README.md §4's removed features have not come back. They read sources across every
         * workspace, so they belong to none of them — and they are named `.audit.test.ts` so this
         * project can pick them up without dragging in the database-backed suites that share the
         * same directory and need a DATABASE_URL.
         */
        test: {
          name: "audit",
          include: ["test/*.audit.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
      },
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
