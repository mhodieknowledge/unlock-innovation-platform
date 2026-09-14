/**
 * Data access. SYSTEM_ARCHITECTURE.md §5: "Access goes through a thin repository
 * layer so the swap is a config change plus a migration, not a rewrite."
 *
 * Uses supabase-js over HTTPS rather than a Postgres driver, because the request
 * tier runs on Cloudflare Workers where raw TCP is not available. The batch tier
 * (GitHub Actions) uses `pg` directly for the same database — see
 * scripts/migrate.mjs.
 *
 * Every read here goes through the anon key, so RLS is the enforcement boundary
 * exactly as SECURITY.md §2 intends. The service-role key is never imported into
 * this app — it exists only in GitHub Actions secrets.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
}

/**
 * Resolves config from the Worker's env binding first, then import.meta.env for
 * build-time and dev. Returns null rather than throwing when unconfigured, so a
 * missing binding degrades to an honest empty state instead of a 500 —
 * invariant 10's spirit applied to the data layer.
 */
export function getClient(env: Env = {}): SupabaseClient | null {
  const url = env.SUPABASE_URL ?? import.meta.env["SUPABASE_URL"];
  const key = env.SUPABASE_ANON_KEY ?? import.meta.env["SUPABASE_ANON_KEY"];
  if (!url || !key) return null;

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application-name": "mbele-web" } },
  });
}

// ── Row shapes ──────────────────────────────────────────────────────────────
// Hand-written rather than generated, so the field list stays a deliberate
// decision. Notably absent from every public read: view_count, which
// PRODUCT_SPEC.md §27 forbids showing users as social proof.

export interface OrganisationRef {
  slug: string;
  name: string;
  verification: string;
}

export interface EligibilityRuleRow {
  id: string;
  rule_type: string;
  params: Record<string, unknown>;
  source_quote: string;
  confidence: number;
}

export interface OpportunityRow {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  description_md: string | null;
  deadline_at: string | null;
  deadline_precision: string;
  deadline_raw: string | null;
  deadline_timezone: string | null;
  opens_at: string | null;
  starts_at: string | null;
  ends_at: string | null;
  is_rolling: boolean;
  participation_mode: string;
  eligibility_scope: string;
  eligible_countries: string[];
  team_required: boolean | null;
  team_size_min: number | null;
  team_size_max: number | null;
  prize_amount: string | number | null;
  prize_currency: string | null;
  cost: string;
  cost_description: string | null;
  verification: string;
  last_verified_at: string | null;
  source_url: string | null;
  official_url: string | null;
  apply_url: string | null;
  status: string;
  duplicate_of: string | null;
  organisations: OrganisationRef | null;
  categories: { code: string; name: string; slug: string } | null;
}

const OPPORTUNITY_FIELDS = `
  id, slug, title, summary, description_md,
  deadline_at, deadline_precision, deadline_raw, deadline_timezone,
  opens_at, starts_at, ends_at, is_rolling,
  participation_mode, eligibility_scope, eligible_countries,
  team_required, team_size_min, team_size_max,
  prize_amount, prize_currency, cost, cost_description,
  verification, last_verified_at, source_url, official_url, apply_url,
  status, duplicate_of,
  organisations ( slug, name, verification ),
  categories ( code, name, slug )
`;

export interface OpportunityDetail {
  opportunity: OpportunityRow;
  rules: EligibilityRuleRow[];
}

/**
 * One opportunity plus its eligibility rules.
 *
 * Returns `{ gone: true }` for a merged record so the route can answer 410 with
 * a link to the canonical one. API_SPEC.md §2 and SEO.md §5 both insist on this
 * rather than a silent 301: a merged record is not the same content, and a
 * shared link should stay honest about what happened.
 */
export async function getOpportunity(
  slug: string,
  env: Env = {},
): Promise<
  | { ok: true; data: OpportunityDetail }
  | { ok: false; reason: "not_found" | "unavailable" }
  | { ok: false; reason: "gone"; mergedInto: string | null }
> {
  const client = getClient(env);
  if (!client) return { ok: false, reason: "unavailable" };

  const { data, error } = await client
    .from("opportunities")
    .select(OPPORTUNITY_FIELDS)
    .eq("slug", slug)
    .maybeSingle();

  if (error) return { ok: false, reason: "unavailable" };
  if (!data) return { ok: false, reason: "not_found" };

  const opportunity = data as unknown as OpportunityRow;

  if (opportunity.status === "merged" || opportunity.duplicate_of) {
    let mergedInto: string | null = null;
    if (opportunity.duplicate_of) {
      const { data: canonical } = await client
        .from("opportunities")
        .select("slug")
        .eq("id", opportunity.duplicate_of)
        .maybeSingle();
      mergedInto = (canonical as { slug?: string } | null)?.slug ?? null;
    }
    return { ok: false, reason: "gone", mergedInto };
  }

  const { data: ruleRows } = await client
    .from("eligibility_rules")
    .select("id, rule_type, params, source_quote, confidence")
    .eq("opportunity_id", opportunity.id)
    .order("is_high_stakes", { ascending: false })
    .order("confidence", { ascending: false });

  return {
    ok: true,
    data: { opportunity, rules: (ruleRows ?? []) as unknown as EligibilityRuleRow[] },
  };
}

/**
 * Published opportunities by deadline urgency. PRODUCT_SPEC.md §13.4: the
 * default sort is urgency, never relevance alone — this is a deadline product.
 */
export async function listOpportunities(
  options: { limit?: number; countryIso2?: string } = {},
  env: Env = {},
): Promise<{ ok: true; data: OpportunityRow[] } | { ok: false; reason: "unavailable" }> {
  const client = getClient(env);
  if (!client) return { ok: false, reason: "unavailable" };

  let query = client
    .from("opportunities")
    .select(OPPORTUNITY_FIELDS)
    .eq("status", "published")
    .order("deadline_at", { ascending: true, nullsFirst: false })
    .limit(Math.min(options.limit ?? 20, 50));

  if (options.countryIso2) {
    // Africa-wide and global scopes are open to everyone, so a country filter
    // must include them rather than only matching the explicit array.
    query = query.or(
      `eligible_countries.cs.{${options.countryIso2}},eligibility_scope.in.(africa_wide,global)`,
    );
  }

  const { data, error } = await query;
  if (error) return { ok: false, reason: "unavailable" };
  return { ok: true, data: (data ?? []) as unknown as OpportunityRow[] };
}

export interface SearchResult {
  rows: OpportunityRow[];
  /** Total matching, so the UI can say whether more exist without fetching them. */
  total: number | null;
}

/**
 * Filtered search. PRODUCT_SPEC.md §13.1–13.4.
 *
 * Deliberately NOT implemented here: the `eligible_for_me` filter. Eligibility
 * is per-viewer, and applying it in this query would make the response
 * uncacheable and leak the viewer's profile into a cache key. It is applied
 * client-side by the list island against locally-stored inputs, which is what
 * lets it work logged out (UX_FLOWS.md §3).
 *
 * `not_eligible` items are down-ranked but never hidden (SYSTEM_ARCHITECTURE.md
 * §6.1) — the reader may be checking on someone else's behalf.
 */
export async function searchOpportunities(
  filters: {
    q?: string | null;
    country?: string | null;
    category?: string | null;
    mode?: string | null;
    team?: "individual" | "team" | null;
    cost?: "free" | "paid" | null;
    hasPrize?: boolean;
    organisation?: string | null;
    verification?: string | null;
    sort?: "urgency" | "relevance" | "newest" | "prize";
    limit?: number;
  },
  env: Env = {},
): Promise<{ ok: true; data: SearchResult } | { ok: false; reason: "unavailable" }> {
  const client = getClient(env);
  if (!client) return { ok: false, reason: "unavailable" };

  let query = client
    .from("opportunities")
    .select(OPPORTUNITY_FIELDS, { count: "estimated" })
    .eq("status", "published")
    .is("deleted_at", null);

  if (filters.country) {
    query = query.or(
      `eligible_countries.cs.{${filters.country}},eligibility_scope.in.(africa_wide,global)`,
    );
  }
  if (filters.mode) query = query.eq("participation_mode", filters.mode);
  if (filters.cost) query = query.eq("cost", filters.cost);
  if (filters.verification) query = query.eq("verification", filters.verification);
  if (filters.hasPrize) query = query.not("prize_amount", "is", null);
  if (filters.team === "team") query = query.eq("team_required", true);
  if (filters.team === "individual") query = query.eq("team_required", false);

  // Full-text search over the weighted tsvector maintained by a trigger
  // (SYSTEM_ARCHITECTURE.md §6.1). Hybrid retrieval with embeddings lands in
  // Phase 4; until then this is FTS alone, which degrades honestly rather than
  // pretending to be semantic.
  if (filters.q) query = query.textSearch("search_vector", filters.q, { type: "websearch" });

  switch (filters.sort) {
    case "newest":
      query = query.order("published_at", { ascending: false, nullsFirst: false });
      break;
    case "prize":
      query = query.order("prize_amount", { ascending: false, nullsFirst: false });
      break;
    case "urgency":
    case "relevance":
    default:
      query = query.order("deadline_at", { ascending: true, nullsFirst: false });
      break;
  }

  const { data, error, count } = await query.limit(Math.min(filters.limit ?? 20, 100));
  if (error) return { ok: false, reason: "unavailable" };

  return {
    ok: true,
    data: { rows: (data ?? []) as unknown as OpportunityRow[], total: count ?? null },
  };
}

/**
 * PRODUCT_SPEC.md §15 — the personal pipeline "nobody else provides".
 *
 * Read through the caller's own authenticated client, so RLS is what scopes the
 * rows to their owner. There is no user_id filter in the query on purpose: if the
 * policy were ever wrong, an application-level filter would mask the bug rather
 * than expose it, and this table has no admin read path to fall back on.
 */
export interface TrackerRow {
  id: string;
  state: string;
  note: string | null;
  applied_at: string | null;
  remind_at: string | null;
  updated_at: string;
  opportunities: OpportunityRow | null;
}

export async function getTracker(
  client: SupabaseClient,
): Promise<{ ok: true; data: TrackerRow[] } | { ok: false; reason: "unavailable" }> {
  const { data, error } = await client
    .from("tracker_entries")
    .select(
      `id, state, note, applied_at, remind_at, updated_at,
       opportunities ( ${OPPORTUNITY_FIELDS} )`,
    )
    .order("updated_at", { ascending: false });

  if (error) return { ok: false, reason: "unavailable" };
  return { ok: true, data: (data ?? []) as unknown as TrackerRow[] };
}

/** API_SPEC.md §5 — the allowed set comes from the database, not a duplicate list. */
export async function allowedTrackerTransitions(
  client: SupabaseClient,
  fromState: string,
): Promise<string[]> {
  const { data, error } = await client.rpc("tracker_allowed_transitions", {
    from_state: fromState,
  });
  if (error || !Array.isArray(data)) return [];
  return data as string[];
}

export interface OrganisationDetail {
  slug: string;
  name: string;
  description: string | null;
  website_url: string | null;
  /**
   * The normalised domain, which the claim flow compares an email address against
   * (PRODUCT_SPEC.md §19, migration 0021). Shown on the claim page so a person knows
   * before typing whether their address will be confirmed automatically or wait for a
   * human — which is the difference between a two-minute flow and a two-day one.
   */
  website_domain: string | null;
  country_iso2: string | null;
  org_type: string | null;
  verification: string;
  verified_at: string | null;
}

export async function getOrganisation(
  slug: string,
  env: Env = {},
): Promise<
  | { ok: true; data: { organisation: OrganisationDetail; open: OpportunityRow[]; past: OpportunityRow[] } }
  | { ok: false; reason: "not_found" | "unavailable" }
> {
  const client = getClient(env);
  if (!client) return { ok: false, reason: "unavailable" };

  const { data: org, error } = await client
    .from("organisations")
    .select(
      "id, slug, name, description, website_url, website_domain, country_iso2, org_type, verification, verified_at",
    )
    .eq("slug", slug)
    .maybeSingle();

  if (error) return { ok: false, reason: "unavailable" };
  if (!org) return { ok: false, reason: "not_found" };

  // PRODUCT_SPEC.md §19: organisation pages carry all their opportunities, past
  // and present. Expired records are never deleted — they preserve inbound links
  // honestly and are the historical record (OPPORTUNITY_INGESTION.md §5.4).
  const { data: all } = await client
    .from("opportunities")
    .select(OPPORTUNITY_FIELDS)
    .eq("organisation_id", (org as { id?: string }).id ?? "")
    .in("status", ["published", "expired", "closed"])
    .order("deadline_at", { ascending: false, nullsFirst: false })
    .limit(100);

  const rows = (all ?? []) as unknown as OpportunityRow[];
  return {
    ok: true,
    data: {
      organisation: org as unknown as OrganisationDetail,
      open: rows.filter((r) => r.status === "published"),
      past: rows.filter((r) => r.status !== "published"),
    },
  };
}

/**
 * How many published opportunities carry a rule of each type.
 *
 * Powers the "what this unlocks" line on every eligibility field
 * (UX_FLOWS.md §8.1: "Your year of study resolves eligibility on 23
 * opportunities"). Computed live from real rules, because
 * CONTENT_AND_LAUNCH.md §1 requires every number shown to be true — a
 * plausible-looking constant here would be exactly the kind of fabricated
 * number the content principles forbid.
 */
export async function getRuleTypeCounts(
  env: Env = {},
): Promise<Record<string, number>> {
  const client = getClient(env);
  if (!client) return {};

  // Only rules attached to something a reader could actually act on.
  const { data, error } = await client
    .from("eligibility_rules")
    .select("rule_type, opportunities!inner(status)")
    .eq("opportunities.status", "published");

  if (error || !data) return {};

  return (data as unknown as { rule_type: string }[]).reduce<Record<string, number>>(
    (acc, row) => {
      acc[row.rule_type] = (acc[row.rule_type] ?? 0) + 1;
      return acc;
    },
    {},
  );
}

/** Live counts for the footer. CONTENT_AND_LAUNCH.md §1: every number shown is true. */
export async function getPublishedCount(env: Env = {}): Promise<number | null> {
  const client = getClient(env);
  if (!client) return null;
  const { count, error } = await client
    .from("opportunities")
    .select("id", { count: "exact", head: true })
    .eq("status", "published");
  return error ? null : (count ?? null);
}

/**
 * Density-floor evaluation. PRODUCT_SPEC.md §24 and invariant 4.
 *
 * A surface renders only when its flag is enabled AND its condition is met.
 * Defaults to FALSE on any error or missing flag, so a database hiccup hides a
 * social surface rather than exposing an empty one.
 */
export async function isFlagEnabled(key: string, env: Env = {}): Promise<boolean> {
  const client = getClient(env);
  if (!client) return false;
  const { data, error } = await client
    .from("feature_flags")
    .select("enabled")
    .eq("key", key)
    .maybeSingle();
  if (error || !data) return false;
  return (data as { enabled?: boolean }).enabled === true;
}

/**
 * Hydrate ranked search results into full rows, in the order given.
 *
 * Search returns ids and ranking signals (migration 0014 keeps retrieval in Postgres and
 * ranking in TypeScript); the view needs the whole record. A single `in` query plus a
 * client-side reorder beats one query per row, and beats asking the database to return
 * the full record for 120 candidates when only 20 are shown.
 */
export async function getOpportunitiesByIds(
  ids: readonly string[],
  env: Env = {},
): Promise<OpportunityRow[]> {
  if (ids.length === 0) return [];
  const client = getClient(env);
  if (!client) return [];

  const { data, error } = await client
    .from("opportunities")
    .select(OPPORTUNITY_FIELDS)
    .in("id", [...ids]);

  if (error || !data) return [];

  const byId = new Map(
    (data as unknown as OpportunityRow[]).map((row) => [row.id, row]),
  );
  // The ranking is the order. Anything the select did not return (deleted between the
  // two queries) is dropped rather than left as a hole.
  return ids.map((id) => byId.get(id)).filter((row): row is OpportunityRow => row !== undefined);
}
