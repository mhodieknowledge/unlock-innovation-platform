/**
 * PRODUCT_SPEC.md §25.1 — hard byte budgets, enforced in CI.
 *
 * Invariant 5: never exceed a byte budget. IMPLEMENTATION_PLAN.md §16 rule 5
 * adds "CI enforces it; do not add an override."
 *
 * Values are gzipped bytes transferred on a first visit.
 */
export interface RouteBudget {
  /** Glob matched against the built route path. */
  pattern: string;
  label: string;
  /** HTML + CSS + JS transferred, gzipped, first visit. */
  totalBytes: number;
  /** JS executed, gzipped. */
  jsBytes: number;
}

const KB = 1024;

export const ROUTE_BUDGETS: readonly RouteBudget[] = [
  { pattern: "/", label: "Homepage", totalBytes: 120 * KB, jsBytes: 25 * KB },
  { pattern: "/opportunities", label: "Opportunity list / search", totalBytes: 150 * KB, jsBytes: 40 * KB },
  { pattern: "/opportunities/*", label: "Opportunity detail", totalBytes: 120 * KB, jsBytes: 30 * KB },
  { pattern: "/countries", label: "Country index", totalBytes: 100 * KB, jsBytes: 15 * KB },
  { pattern: "/countries/*", label: "Country index", totalBytes: 100 * KB, jsBytes: 15 * KB },
  { pattern: "/categories", label: "Category index", totalBytes: 100 * KB, jsBytes: 15 * KB },
  { pattern: "/categories/*", label: "Category index", totalBytes: 100 * KB, jsBytes: 15 * KB },
  { pattern: "/organisations/*", label: "Organisation page", totalBytes: 120 * KB, jsBytes: 25 * KB },
  { pattern: "/dashboard", label: "Authenticated dashboard", totalBytes: 200 * KB, jsBytes: 70 * KB },
  { pattern: "/tracker", label: "Authenticated dashboard", totalBytes: 200 * KB, jsBytes: 70 * KB },
  { pattern: "/admin/*", label: "Admin", totalBytes: 200 * KB, jsBytes: 70 * KB },
];

/** PRODUCT_SPEC.md §25.1 — the ceiling no route may cross, whatever its own budget. */
export const ABSOLUTE_BUDGET = { totalBytes: 250 * KB, jsBytes: 90 * KB } as const;

/** DESIGN_SYSTEM.md §10 / IMPLEMENTATION_PLAN.md §11 — low-data list page. */
export const LOW_DATA_LIST_BUDGET = 40 * KB;

/** PRODUCT_SPEC.md §25.1 — one variable family, subset, woff2. */
export const FONT_BUDGET = 60 * KB;

/** PRODUCT_SPEC.md §25.1 — organisation logos, served at exact display size. */
export const LOGO_BUDGET = 12 * KB;

/** DESIGN_SYSTEM.md §12 — inline SVG sprite, only icons actually used. */
export const ICON_SPRITE_BUDGET = 4 * KB;
