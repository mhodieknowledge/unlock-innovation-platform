import { defineConfig } from "vitest/config";

/**
 * Tests that need a live database, kept OUT of `npm test`.
 *
 * Folding them into the main suite would mean skipping them when no database is
 * present, and a check that skips itself is a vacuous pass — the exact failure mode
 * that has already bitten this repository twice. Separate config, separate CI step,
 * and a hard failure when DATABASE_URL is missing.
 *
 * These run serially: they share one database, and several of them assert on what is
 * in it.
 */
export default defineConfig({
  test: {
    name: "db",
    include: ["test/**/*.test.ts"],
    // The repo-level audits live in the same directory and need no database. They run in
    // `npm test` under the "audit" project; running them here as well would double them and
    // make this suite's count say something it does not mean.
    exclude: ["test/**/*.audit.test.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
