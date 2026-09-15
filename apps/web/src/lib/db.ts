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

/**
 * The same field list, with an embedded relation switched to an inner join.
 *
 * PostgREST only filters on an embedded resource when the embed is `!inner` — with the
 * default left join, `categories.code=eq.x` is accepted and silently matches everything.
 * That is exactly how the category and organisation filters came to render a chip and
 * change nothing, so the join hint is applied by the same code that adds the filter.
 */
function fieldsWithInner(relations: ("organisations" | "categories")[]): string {
  let fields = OPPORTUNITY_FIELDS;
  for (const relation of relations) {
    fields = fields.replace(`${relation} (`, `${relation}!inner (`);
  }
  return fields;
}

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
 * The most a single category may take of one board page, once there is enough else.
 *
 * A quarter, not a fixed count: on a board of twenty that is five, and on a catalogue
 * that genuinely holds only hackathons it relaxes rather than leaving the page half
 * empty. Balance is a courtesy to the reader, not a claim about the collection.
 */
const BOARD_CATEGORY_SHARE = 0.25;

/**
 * Let no one category drown the board, without hiding anything or reordering within it.
 *
 * PRODUCT_SPEC.md §13.4 makes urgency the default sort and that stays: every row below
 * is still in deadline order, and a row is only ever MOVED LATER, never earlier. Nothing
 * urgent is pushed down past something less urgent in the same category.
 *
 * The problem this solves is a supply artefact rather than a ranking one. Devpost gives
 * 183 free, dated, global hackathons with windows measured in weeks; a scholarship
 * usually closes months out. Sorted purely by deadline, the soonest hundred rows are all
 * hackathons and a Zimbabwean sees a page with no scholarship on it — while the
 * catalogue holds several. The category pages remain strictly by deadline, because
 * someone who clicked "Hackathons" wants all of them.
 *
 * Deliberately NOT applied to the closing-soon feed: that one is an urgency promise, and
 * a deadline three days out must not be displaced to make a page look varied.
 */
export function spreadByCategory<T extends { categories?: { code?: string | null } | null }>(
  rows: T[],
  limit: number,
): T[] {
  const ceiling = Math.max(1, Math.ceil(limit * BOARD_CATEGORY_SHARE));
  const taken = new Map<string, number>();
  const spread: T[] = [];
  const held: T[] = [];

  for (const row of rows) {
    const code = row.categories?.code ?? "other";
    const used = taken.get(code) ?? 0;
    if (used < ceiling) {
      taken.set(code, used + 1);
      spread.push(row);
    } else {
      held.push(row);
    }
  }

  // Everything held back still appears, in its original order, after the spread. A
  // catalogue of nothing but hackathons therefore renders exactly as it did before.
  return [...spread, ...held].slice(0, limit);
}

/**
 * Published opportunities by deadline urgency. PRODUCT_SPEC.md §13.4: the
 * default sort is urgency, never relevance alone — this is a deadline product.
 */
export async function listOpportunities(
  options: {
    limit?: number;
    offset?: number;
    countryIso2?: string;
    categoryCode?: string;
    /** Let one category dominate. The closing-soon feed sets this; the board does not. */
    strictUrgency?: boolean;
  } = {},
  env: Env = {},
): Promise<{ ok: true; data: OpportunityRow[] } | { ok: false; reason: "unavailable" }> {
  const client = getClient(env);
  if (!client) return { ok: false, reason: "unavailable" };

  const limit = Math.min(options.limit ?? 20, 50);
  const offset = Math.max(options.offset ?? 0, 0);
  // A category page is already one category; spreading it would do nothing but cost a
  // larger query. Strict urgency is for the feeds.
  const spreading = !options.categoryCode && options.strictUrgency !== true;

  let query = client
    .from("opportunities")
    .select(options.categoryCode ? fieldsWithInner(["categories"]) : OPPORTUNITY_FIELDS)
    .eq("status", "published")
    // The same three exclusions `search_candidates` applies (migration 0014): a deleted
    // record, a record merged into another, and a record whose deadline has passed are not
    // results. The expiry sweep flips `status` within the hour, but the board is the page
    // that would show the gap, so it filters on the date as well as the status.
    .is("deleted_at", null)
    .is("duplicate_of", null)
    .or(`deadline_at.is.null,deadline_at.gt.${new Date().toISOString()}`)
    .order("deadline_at", { ascending: true, nullsFirst: false })
    // Over-fetch when spreading, because the rows held back have to come from somewhere:
    // asking for exactly `limit` and then rebalancing can only ever return fewer.
    .range(offset, offset + (spreading ? limit * 3 : limit) - 1);

  if (options.categoryCode) query = query.eq("categories.code", options.categoryCode);

  if (options.countryIso2) {
    // Africa-wide and global scopes are open to everyone, so a country filter
    // must include them rather than only matching the explicit array.
    query = query.or(
      `eligible_countries.cs.{${options.countryIso2}},eligibility_scope.in.(africa_wide,global)`,
    );
  }

  const { data, error } = await query;
  if (error) return { ok: false, reason: "unavailable" };

  const rows = (data ?? []) as unknown as OpportunityRow[];
  return { ok: true, data: spreading ? spreadByCategory(rows, limit) : rows.slice(0, limit) };
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
    region?: string | null;
    category?: string | null;
    deadlineState?: string | null;
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

  const inner: ("organisations" | "categories")[] = [];
  if (filters.category) inner.push("categories");
  if (filters.organisation) inner.push("organisations");

  let query = client
    .from("opportunities")
    .select(fieldsWithInner(inner), { count: "estimated" })
    .eq("status", "published")
    .is("deleted_at", null)
    // A merged record is not a result — it is a redirect target. `search_candidates`
    // (migration 0014) excludes it and so does this fallback, or degraded search would
    // start showing duplicates of the same opportunity.
    .is("duplicate_of", null);

  if (filters.country) {
    query = query.or(
      `eligible_countries.cs.{${filters.country}},eligibility_scope.in.(africa_wide,global)`,
    );
  }
  if (filters.region) {
    // A continent-wide or global opportunity is open to every region in it, so a region
    // filter that matched only `region_codes` would hide most of what qualifies.
    query = query.or(
      `region_codes.cs.{${filters.region}},eligibility_scope.in.(africa_wide,global)`,
    );
  }
  if (filters.category) query = query.eq("categories.code", filters.category);
  if (filters.organisation) query = query.eq("organisations.slug", filters.organisation);
  if (filters.mode) query = query.eq("participation_mode", filters.mode);
  if (filters.cost) query = query.eq("cost", filters.cost);
  if (filters.verification) query = query.eq("verification", filters.verification);
  if (filters.hasPrize) query = query.not("prize_amount", "is", null);
  if (filters.team === "team") query = query.eq("team_required", true);
  if (filters.team === "individual") query = query.eq("team_required", false);

  /**
   * Deadline windows, measured from now. PRODUCT_SPEC.md §13.2's states are relative by
   * nature — "closing this week" means the next seven days, not the calendar week — and a
   * window measured in days needs no assumption about the reader's timezone.
   */
  if (filters.deadlineState) {
    const days: Record<string, number> = {
      closing_today: 1,
      closing_2_days: 2,
      closing_this_week: 7,
      closing_this_month: 30,
    };
    const window = days[filters.deadlineState];
    if (window !== undefined) {
      query = query
        .not("deadline_at", "is", null)
        .gt("deadline_at", new Date().toISOString())
        .lte("deadline_at", new Date(Date.now() + window * 86_400_000).toISOString());
    } else if (filters.deadlineState === "rolling") {
      query = query.eq("is_rolling", true);
    } else if (filters.deadlineState === "opens_soon") {
      query = query.gt("opens_at", new Date().toISOString());
    } else if (filters.deadlineState === "open") {
      query = query.or(`deadline_at.is.null,deadline_at.gt.${new Date().toISOString()}`);
    }
  }

  /*
   * NOT applied here, and deliberately: `tag`, `student` and `eligibleForMe`.
   *
   * `eligibleForMe` cannot be — a per-viewer verdict in this query would make the response
   * uncacheable and put the viewer's profile in a cache key (see the note above). `tag` and
   * `student` need a lookup (tag slug to uuid) and a rules join respectively; nothing in the
   * product links to either, and an approximation would be worse than their absence. They
   * are named here so the next person does not have to read the whole function to find out
   * what it does not do.
   */

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

export interface CountryRef {
  iso2: string;
  name: string;
  slug: string;
}

/**
 * One country, for the "Open to [country]" strip. UX_FLOWS.md §2 item 4.
 *
 * A single row rather than the whole vocabulary: the homepage needs one name, and
 * `getQueryVocabulary` fetches 54 countries with their alias arrays to build a matcher the
 * board does not use.
 */
export async function getCountry(
  iso2: string | null | undefined,
  env: Env = {},
): Promise<CountryRef | null> {
  const code = (iso2 ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;

  const client = getClient(env);
  if (!client) return null;

  const { data, error } = await client
    .from("countries")
    .select("iso2, name, slug")
    .eq("iso2", code)
    .maybeSingle();

  if (error || !data) return null;
  return data as unknown as CountryRef;
}

/** By slug, for the country pages: SEO.md §5 keeps URLs lowercase, hyphenated and stable. */
export async function getCountryBySlug(
  slug: string | undefined,
  env: Env = {},
): Promise<CountryRef | null> {
  const clean = (slug ?? "").trim().toLowerCase();
  if (!/^[a-z-]{2,60}$/.test(clean)) return null;

  const client = getClient(env);
  if (!client) return null;

  const { data, error } = await client
    .from("countries")
    .select("iso2, name, slug")
    .eq("slug", clean)
    .eq("is_african", true)
    .maybeSingle();

  if (error || !data) return null;
  return data as unknown as CountryRef;
}

export interface EntryPoints {
  countries: CountryRef[];
  categories: { code: string; name: string; slug: string }[];
}

/**
 * The country and category entry points. UX_FLOWS.md §2 item 5: "plain links".
 *
 * All 54, not a promoted subset. PRODUCT_SPEC.md §4.2 keeps `priority_tier` out of
 * eligibility, and §28 makes every country a first-class page; a homepage that linked to
 * six of them would be making a claim about the other 48 that this product does not make.
 * Gzipped, the whole list is under a kilobyte.
 *
 * No counts beside the links, deliberately. CONTENT_AND_LAUNCH.md §1: a count shown must be
 * true and computed live, and a per-country count means unnesting `eligible_countries`
 * across the catalogue on every homepage request. The country pages carry their own counts
 * where the query is already being run.
 */
export async function getEntryPoints(env: Env = {}): Promise<EntryPoints> {
  const client = getClient(env);
  if (!client) return { countries: [], categories: [] };

  const [countries, categories] = await Promise.all([
    client
      .from("countries")
      .select("iso2, name, slug")
      .eq("is_african", true)
      .order("name", { ascending: true }),
    // !inner on the join is what makes this a filter rather than a decoration: with the
    // default left join every category comes back whether or not anything is published in
    // it, which is how a nav full of dead links gets built. The same PostgREST trap the
    // category chip fell into.
    client
      .from("categories")
      .select("code, name, slug, opportunities!inner(id)")
      .is("parent_id", null)
      .eq("opportunities.status", "published")
      .is("opportunities.deleted_at", null)
      .is("opportunities.duplicate_of", null)
      // One row is the whole proof. Without this the nav query drags back every
      // published id in every category on every page that renders it.
      .limit(1, { referencedTable: "opportunities" })
      .order("sort_order", { ascending: true }),
  ]);

  // A category page that renders nothing reads as abandoned, and MODERATION_AND_TRUST.md
  // §1's refusal to "show a badge without a date" is the same instinct: do not publish a
  // shape the catalogue does not have. A category reappears on its own the moment
  // something lands in it, so this hides nothing permanently.
  //
  // The embedded rows are only there to make the join filter; one row per category is
  // enough to prove it is not empty, and they are dropped here rather than shipped to
  // every page that renders the nav.
  const withRecords = (categories.data ?? []) as unknown as Array<
    EntryPoints["categories"][number] & { opportunities?: unknown }
  >;

  return {
    countries: (countries.data ?? []) as unknown as CountryRef[],
    categories: withRecords.map(({ opportunities: _drop, ...category }) => category),
  };
}

/**
 * When the catalogue was last checked against its sources.
 *
 * UX_FLOWS.md §2 item 6 asks the homepage footer for "counts that are true (published, last
 * ingestion time)". The ingestion tables are admin-only under RLS and rightly so, so the
 * public number is the freshest `last_verified_at` on a published record — which is the same
 * fact stated from the reader's side: the last time anything here was confirmed to be real.
 */
export async function getLastVerifiedAt(env: Env = {}): Promise<string | null> {
  const client = getClient(env);
  if (!client) return null;

  const { data, error } = await client
    .from("opportunities")
    .select("last_verified_at")
    .eq("status", "published")
    .not("last_verified_at", "is", null)
    .order("last_verified_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return (data as { last_verified_at: string | null }).last_verified_at;
}

export interface CountryCount {
  iso2: string;
  name: string;
  slug: string;
  region: string;
  /** Everything a reader there can enter, including Africa-wide and global. */
  open_count: number;
  /** Only what names the country explicitly. UX_FLOWS.md §13 shows both numbers. */
  specific_count: number;
  soonest_deadline: string | null;
}

/** SEO.md §2. All 54, including the ones with nothing of their own. */
export async function getCountryCounts(env: Env = {}): Promise<CountryCount[]> {
  const client = getClient(env);
  if (!client) return [];
  const { data, error } = await client.rpc("country_open_counts");
  return error ? [] : ((data ?? []) as unknown as CountryCount[]);
}

export interface MatrixCell {
  iso2: string;
  country_name: string;
  country_slug: string;
  category_code: string;
  category_name: string;
  category_slug: string;
  open_count: number;
}

/**
 * The country × category matrix, as counts. SEO.md §2.
 *
 * The 5-item floor is NOT applied here or in the SQL: `SEO_MATRIX_FLOOR` in @mbele/config is the
 * single place it lives, and the route and the sitemap both read it. A floor applied in three
 * places is a floor that will differ in one of them, and the symptom would be a sitemap
 * advertising pages that redirect.
 */
export async function getMatrixCells(
  iso2: string | null,
  env: Env = {},
): Promise<MatrixCell[]> {
  const client = getClient(env);
  if (!client) return [];
  const { data, error } = await client.rpc("country_category_counts", {
    p_iso2: iso2 ? iso2.toUpperCase() : null,
  });
  return error ? [] : ((data ?? []) as unknown as MatrixCell[]);
}

export interface CategoryCount {
  code: string;
  name: string;
  slug: string;
  open_count: number;
  soonest_deadline: string | null;
}

export async function getCategoryCounts(env: Env = {}): Promise<CategoryCount[]> {
  const client = getClient(env);
  if (!client) return [];
  const { data, error } = await client.rpc("category_open_counts");
  return error ? [] : ((data ?? []) as unknown as CategoryCount[]);
}

export interface ActiveOrganisation {
  slug: string;
  name: string;
  verification: string;
  open_count: number;
}

/** UX_FLOWS.md §13's "organisations active there" — with something open, not merely recorded. */
export async function getCountryOrganisations(
  iso2: string,
  env: Env = {},
  limit = 12,
): Promise<ActiveOrganisation[]> {
  const client = getClient(env);
  if (!client) return [];
  const { data, error } = await client.rpc("country_organisations", {
    p_iso2: iso2.toUpperCase(),
    p_limit: limit,
  });
  return error ? [] : ((data ?? []) as unknown as ActiveOrganisation[]);
}

/**
 * Country names for a list of codes, in the order given.
 *
 * SEO.md §3's `eligibleRegion` needs names, not codes: `{"@type":"Country","name":"ZW"}` is not
 * a country name, and a validator that accepts it is doing the reader no favours.
 */
export async function getCountryNames(
  codes: readonly string[],
  env: Env = {},
): Promise<string[]> {
  if (codes.length === 0) return [];
  const client = getClient(env);
  if (!client) return [];
  const { data, error } = await client
    .from("countries")
    .select("iso2, name")
    .in("iso2", codes.map((code) => code.trim().toUpperCase()));
  if (error || !data) return [];
  const byCode = new Map((data as { iso2: string; name: string }[]).map((row) => [row.iso2, row.name]));
  return codes
    .map((code) => byCode.get(code.trim().toUpperCase()))
    .filter((name): name is string => name !== undefined);
}

export interface SitemapRow {
  slug: string;
  lastmod: string | null;
}

/**
 * Published, unexpired opportunities for the sitemap. SEO.md §5: "Expired opportunities are
 * removed from sitemaps on expiry."
 *
 * A separate query from `listOpportunities` because a sitemap needs two columns and no joins,
 * and fetching the whole record 5,000 times to write a URL would be a minute of Worker CPU.
 */
export async function getSitemapOpportunities(
  env: Env = {},
  limit = 5000,
): Promise<SitemapRow[]> {
  const client = getClient(env);
  if (!client) return [];
  const { data, error } = await client
    .from("opportunities")
    .select("slug, updated_at")
    .eq("status", "published")
    .is("deleted_at", null)
    .is("duplicate_of", null)
    .or(`deadline_at.is.null,deadline_at.gt.${new Date().toISOString()}`)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return (data as { slug: string; updated_at: string | null }[]).map((row) => ({
    slug: row.slug,
    lastmod: row.updated_at,
  }));
}

export async function getSitemapOrganisations(env: Env = {}, limit = 5000): Promise<SitemapRow[]> {
  const client = getClient(env);
  if (!client) return [];
  const { data, error } = await client
    .from("organisations")
    .select("slug, updated_at")
    .is("deleted_at", null)
    .is("duplicate_of", null)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return (data as { slug: string; updated_at: string | null }[]).map((row) => ({
    slug: row.slug,
    lastmod: row.updated_at,
  }));
}

/**
 * Public profiles that opted IN to being indexed. SEO.md §1 and COLLABORATION_SYSTEM.md §5.4.
 *
 * Both conditions, because they are two decisions: `public` is who may read the page and
 * `indexable` is whether a search engine may. A sitemap that listed every public profile would
 * make the second opt-in meaningless — and this file is the one place where forgetting it would
 * not be visible on any page.
 */
export async function getSitemapProfiles(env: Env = {}, limit = 5000): Promise<SitemapRow[]> {
  const client = getClient(env);
  if (!client) return [];
  const { data, error } = await client
    .from("profiles")
    .select("updated_at, indexable, visibility, users!inner(handle, account_state, deleted_at)")
    .eq("visibility", "public")
    .eq("indexable", true)
    .eq("users.account_state", "active")
    .is("users.deleted_at", null)
    .limit(limit);

  if (error || !data) return [];
  return (data as unknown as { updated_at: string | null; users: { handle: string | null } }[])
    .filter((row) => Boolean(row.users?.handle))
    .map((row) => ({ slug: row.users.handle as string, lastmod: row.updated_at }));
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
