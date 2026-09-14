/**
 * PRODUCT_SPEC.md §25.1 — hard byte budgets, enforced in CI.
 *
 * Invariant 5: never exceed a byte budget. IMPLEMENTATION_PLAN.md §16 rule 5
 * adds "CI enforces it; do not add an override."
 *
 * Values are gzipped bytes transferred on a first visit.
 */
import budgets from "./route-budgets.json" with { type: "json" };

export interface RouteBudget {
  /** Glob matched against the built route path. `*` matches one path segment. */
  pattern: string;
  label: string;
  /** HTML + CSS + JS transferred, gzipped, first visit. */
  totalBytes: number;
  /** JS executed, gzipped. */
  jsBytes: number;
}

const KB = 1024;

/**
 * Read from route-budgets.json, which is THE source of truth.
 *
 * scripts/byte-budget.mjs reads the same file. It used to carry a hand-copied
 * duplicate of this table with a comment claiming a drift test kept the two
 * honest — there was no such test, and the first time routes were added here and
 * not there, the gate silently fell back to the absolute ceiling and reported a
 * pass. One file, two readers, no drift possible.
 */
const table = budgets as {
  absolute: { totalKb: number; jsKb: number };
  routes: { pattern: string; label: string; totalKb: number; jsKb: number }[];
};

export const ROUTE_BUDGETS: readonly RouteBudget[] = table.routes.map((r) => ({
  pattern: r.pattern,
  label: r.label,
  totalBytes: r.totalKb * KB,
  jsBytes: r.jsKb * KB,
}));

/** PRODUCT_SPEC.md §25.1 — the ceiling no route may cross, whatever its own budget. */
export const ABSOLUTE_BUDGET = {
  totalBytes: table.absolute.totalKb * KB,
  jsBytes: table.absolute.jsKb * KB,
} as const;

/** DESIGN_SYSTEM.md §10 / IMPLEMENTATION_PLAN.md §11 — low-data list page. */
export const LOW_DATA_LIST_BUDGET = 40 * KB;

/** PRODUCT_SPEC.md §25.1 — one variable family, subset, woff2. */
export const FONT_BUDGET = 60 * KB;

/** PRODUCT_SPEC.md §25.1 — organisation logos, served at exact display size. */
export const LOGO_BUDGET = 12 * KB;

/** DESIGN_SYSTEM.md §12 — inline SVG sprite, only icons actually used. */
export const ICON_SPRITE_BUDGET = 4 * KB;
