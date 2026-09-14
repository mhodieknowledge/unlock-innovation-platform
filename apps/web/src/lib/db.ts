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
