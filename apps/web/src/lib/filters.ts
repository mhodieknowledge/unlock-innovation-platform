/**
 * Filter state. PRODUCT_SPEC.md §13.1: "Filters are URL state (shareable,
 * back-button-correct, server-renderable)."
 *
 * All three of those properties follow from keeping the filters in the query
 * string and nowhere else — no client store, no hidden state. The server renders
 * from the URL, so a shared link reproduces exactly what the sender saw, and the
 * back button works because the browser is doing the work.
 */

export const DEADLINE_STATES = [
  "closing_today",
  "closing_2_days",
  "closing_this_week",
  "closing_this_month",
  "open",
  "opens_soon",
  "rolling",
] as const;

export const SORTS = ["urgency", "relevance", "newest", "prize"] as const;

export type SortKey = (typeof SORTS)[number];

export interface Filters {
  q: string | null;
  country: string | null;
  /** PRODUCT_SPEC.md §13.1 — the differentiator, and it works logged out. */
  eligibleForMe: boolean;
  region: string | null;
  category: string | null;
  tag: string | null;
  mode: string | null;
  team: "individual" | "team" | null;
  student: boolean;
  cost: "free" | "paid" | null;
  hasPrize: boolean;
  organisation: string | null;
  verification: string | null;
  deadlineState: string | null;
  sort: SortKey;
  limit: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const str = (v: string | null): string | null => {
  const t = v?.trim();
  return t ? t.slice(0, 80) : null;
};

const bool = (v: string | null): boolean => v === "1" || v === "true";

const oneOf = <T extends string>(v: string | null, allowed: readonly T[]): T | null => {
  const t = str(v);
  return t && (allowed as readonly string[]).includes(t) ? (t as T) : null;
};

export function parseFilters(url: URL): Filters {
  const p = url.searchParams;
  const limit = Number(p.get("limit") ?? DEFAULT_LIMIT);

  return {
    q: str(p.get("q")),
    country: str(p.get("country"))?.toUpperCase().slice(0, 2) ?? null,
    eligibleForMe: bool(p.get("eligible_for_me")),
    region: str(p.get("region")),
    category: str(p.get("category")),
    tag: str(p.get("tag")),
    mode: oneOf(p.get("mode"), ["online", "in_person", "hybrid"] as const),
    team: oneOf(p.get("team"), ["individual", "team"] as const),
    student: bool(p.get("student")),
    cost: oneOf(p.get("cost"), ["free", "paid"] as const),
    hasPrize: bool(p.get("has_prize")),
    organisation: str(p.get("organisation")),
    verification: oneOf(p.get("verification"), [
      "official",
      "verified",
      "auto",
    ] as const),
    deadlineState: oneOf(p.get("deadline_state"), DEADLINE_STATES),
    sort: oneOf(p.get("sort"), SORTS) ?? "urgency",
    limit: Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT)
      : DEFAULT_LIMIT,
  };
}

/** Rebuilds a query string, omitting defaults so shared URLs stay short. */
export function toSearchParams(filters: Partial<Filters>): URLSearchParams {
  const p = new URLSearchParams();
  const set = (key: string, value: unknown) => {
    if (value === null || value === undefined || value === false || value === "") return;
    p.set(key, value === true ? "1" : String(value));
  };

  set("q", filters.q);
  set("country", filters.country);
  set("eligible_for_me", filters.eligibleForMe);
  set("region", filters.region);
  set("category", filters.category);
  set("tag", filters.tag);
  set("mode", filters.mode);
  set("team", filters.team);
  set("student", filters.student);
  set("cost", filters.cost);
  set("has_prize", filters.hasPrize);
  set("organisation", filters.organisation);
  set("verification", filters.verification);
  set("deadline_state", filters.deadlineState);
  if (filters.sort && filters.sort !== "urgency") set("sort", filters.sort);
  if (filters.limit && filters.limit !== DEFAULT_LIMIT) set("limit", filters.limit);

  return p;
}

export interface Chip {
  label: string;
  /** URL with this one filter removed, so every chip is independently dismissible. */
  removeHref: string;
}

const CHIP_LABELS: Partial<Record<keyof Filters, (v: unknown) => string>> = {
  q: (v) => `“${v}”`,
  country: (v) => `Open to ${v}`,
  eligibleForMe: () => "Eligible for me",
  region: (v) => String(v).replace(/_/g, " "),
  category: (v) => String(v).replace(/_/g, " "),
  tag: (v) => String(v),
  mode: (v) => (v === "online" ? "Remote" : String(v).replace(/_/g, " ")),
  team: (v) => (v === "team" ? "Team entry" : "Individual entry"),
  student: () => "Student-eligible",
  cost: (v) => (v === "free" ? "Free to enter" : "Has a cost"),
  hasPrize: () => "Has a prize",
  organisation: (v) => String(v),
  verification: (v) => `${v} only`,
  deadlineState: (v) => String(v).replace(/_/g, " "),
};

/**
 * Active filters as dismissible chips. UX_FLOWS.md §3: the user always sees the
 * interpretation and can correct any single part of it — which is also how the NL
 * query compiler's output is rendered, deliberately identically, so a compiled
 * filter is never mistaken for something the user cannot edit.
 */
export function activeChips(filters: Filters, basePath = "/opportunities"): Chip[] {
  const chips: Chip[] = [];

  for (const [key, format] of Object.entries(CHIP_LABELS) as [
    keyof Filters,
    (v: unknown) => string,
  ][]) {
    const value = filters[key];
    if (value === null || value === undefined || value === false || value === "") continue;

    const without = { ...filters, [key]: typeof value === "boolean" ? false : null };
    const params = toSearchParams(without);
    chips.push({
      label: format(value),
      removeHref: params.size > 0 ? `${basePath}?${params}` : basePath,
    });
  }

  return chips;
}

export const hasAnyFilter = (filters: Filters): boolean => activeChips(filters).length > 0;

/**
 * Turn a compiled natural-language query into URL state.
 *
 * AI_SYSTEM.md §7: "The user always sees and can edit the chips before or after results
 * render." Editing has to work without JavaScript, so a chip's remove link is just a URL
 * with the OTHER chips pinned as explicit filters — after which they behave like any
 * other filter chip, because they are.
 *
 * @param compiled what the compiler produced
 * @param without a chip to leave out, for its own remove link
 */
export function compiledToParams(
  compiled: { chips: Array<{ kind: string; value: string }>; keywords: string },
  without?: { kind: string; value: string },
): URLSearchParams {
  const params = new URLSearchParams();

  for (const chip of compiled.chips) {
    if (without && chip.kind === without.kind && chip.value === without.value) continue;
    switch (chip.kind) {
      case "country":
        params.set("country", chip.value);
        break;
      case "category":
        params.set("category", chip.value);
        break;
      case "mode":
        params.set("mode", chip.value);
        break;
      case "cost":
        params.set("cost", chip.value);
        break;
      case "team":
        params.set("team", chip.value);
        break;
      case "prize":
        params.set("prize", "1");
        break;
      default:
        // `deadline` and `keyword` have no URL filter of their own yet. Dropping a chip
        // here would silently widen the search, so the keywords carry through instead.
        break;
    }
  }

  if (compiled.keywords) params.set("q", compiled.keywords);
  return params;
}
