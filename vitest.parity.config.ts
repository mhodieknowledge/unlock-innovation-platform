import { defineConfig } from "vitest/config";

/**
 * Engine parity has its own config so it is NOT part of `npm test`.
 *
 * It needs a live database. Folding it into the main suite would mean skipping it
 * when one is absent, and a check that skips itself is a vacuous pass — the exact
 * failure mode that has already bitten this repository twice. Separate config,
 * separate CI step, and a hard failure when DATABASE_URL is missing.
 */
export default defineConfig({
  test: {
    name: "parity",
    include: ["test/engine-parity.test.ts"],
    // One connection, one transaction, sixty round trips.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
