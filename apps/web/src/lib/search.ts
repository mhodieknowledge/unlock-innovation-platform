/**
 * Search, at request time. SYSTEM_ARCHITECTURE.md §6.
 *
 * The retrieval happens in Postgres (`search_candidates`, migration 0014) and the
 * ranking happens here, from the weights in `@mbele/config`'s ranking module — §6.1
 * `[TD]` requires those to live in exactly one file, and splitting the work this way is
 * what keeps that true.
 *
 * Everything degrades. §6.2 `[PR]`: "If the embedding provider is unavailable: FTS-only
 * with a quiet indicator in the admin dashboard. Users see no error." So a missing
 * Workers AI binding, a missing KV namespace and an unreachable database each produce a
 * worse result rather than a broken page — and the caller is told WHICH, so the admin
 * dashboard can show it without the user ever seeing it.
 */

import {
  CANDIDATES_PER_RETRIEVER,
  ELIGIBILITY_BOOST,
  FRESHNESS_PENALTY,
  QUERY_CACHE_TTL_SECONDS,
  applyDiversity,
  compileQueryHeuristically,
  mergeModelChips,
  queryCacheKey,
  urgencyBoost,
  type CompiledQuery,
  type QueryVocabulary,
} from "@mbele/config";

import { getClient, type Env } from "./db";

/** What a ranked result carries into the view. */
export interface SearchResultRow {
  id: string;
  slug: string;
  score: number;
  verdict: string | null;
  verification: string;
  deadline_at: string | null;
  is_rolling: boolean;
  organisation_slug: string | null;
  category_code: string | null;
}

export interface SearchOutcome {
  ok: boolean;
  rows: SearchResultRow[];
  compiled: CompiledQuery | null;
  /**
   * What the retrieval actually managed. Shown on the admin dashboard, never to a user
   * (§6.2), and useful in a test that would otherwise not be able to tell a degraded
   * result from a good one.
   */
  retrieval: {
    fts: boolean;
    vector: boolean;
    compiler: "heuristic" | "model" | "cached";
  };
}

interface Runtime extends Env {
  /** Workers AI, for the query embedding. Absent in dev and in a degraded deploy. */
  AI?: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };
  /** KV, for the 7-day query-compilation cache (§7) and the query-embedding cache (§3.3). */
  QUERY_CACHE?: {
    get: (key: string, type?: "text" | "json") => Promise<unknown>;
    put: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>;
  };
  /** The one LLM call permitted in a request handler (§7), and only because it is cached. */
  GROQ_API_KEY?: string;
  QUERY_EMBEDDING_MODEL?: string;
  /** AI_SYSTEM.md §2 guardrail 6: model names are configuration, never code. */
  QUERY_COMPILER_MODEL?: string;
}

/**
 * The live filter vocabulary, from our own tables.
 *
 * §7's guardrail: "Output validated against the live filter vocabulary; unknown values
 * discarded." Reading it from the database rather than from a constant is what makes the
 * validation real — a category removed from the taxonomy stops being a filter on the
 * next request rather than at the next deploy.
 */
export async function getQueryVocabulary(env: Env = {}): Promise<QueryVocabulary> {
  const client = getClient(env);
  if (!client) return { countries: [], categories: [] };

  const [countries, categories] = await Promise.all([
    client.from("countries").select("iso2, name, common_names"),
    client.from("categories").select("code, name"),
  ]);

  return {
    countries: ((countries.data ?? []) as { iso2: string; name: string; common_names: string[] | null }[]).map(
      (row) => ({
        iso2: String(row.iso2).trim(),
        name: row.name,
        commonNames: row.common_names ?? [],
      }),
    ),
    categories: ((categories.data ?? []) as { code: string; name: string }[]).map((row) => ({
      code: row.code,
      name: row.name,
    })),
  };
}

/**
 * A query embedding, from Workers AI, KV-cached by normalised query.
 *
 * AI_SYSTEM.md §3.3: "Only QUERY embeddings use Workers AI at request time, KV-cached by
 * normalised query." Document embeddings are generated locally in the batch tier — the
 * decision that keeps the whole AI budget viable — and this is the small half that has to
 * happen live.
 *
 * Returns null rather than throwing on every failure path. §6.2 makes that the degraded
 * mode, and a null embedding is exactly what `search_candidates` treats as FTS-only.
 */
async function queryEmbedding(query: string, runtime: Runtime): Promise<number[] | null> {
  // No hard-coded model name, anywhere. AI_SYSTEM.md §2 guardrail 6 `[PR]`: "No model
  // name in application code. Models are configuration rows." A default here would be a
  // name in code that outlives the model it refers to — Workers AI has renamed models —
  // and the failure would be a silent 400 rather than a configuration error. Absent
  // configuration means this capability is off, which §6.2 already makes a supported
  // state.
  const model = runtime.QUERY_EMBEDDING_MODEL;
  if (!query.trim() || !runtime.AI || !model) return null;

  const key = `qemb:${queryCacheKey(query)}`;

  if (runtime.QUERY_CACHE) {
    try {
      const cached = await runtime.QUERY_CACHE.get(key, "json");
      if (Array.isArray(cached) && cached.length === 384) return cached as number[];
    } catch {
      // A cache miss and a cache outage are the same thing to this function.
    }
  }

  try {
    const result = (await runtime.AI.run(model, { text: [query] })) as {
      data?: number[][];
    };
    const vector = result?.data?.[0];
    if (!Array.isArray(vector) || vector.length !== 384) return null;

    if (runtime.QUERY_CACHE) {
      await runtime.QUERY_CACHE.put(key, JSON.stringify(vector), {
        expirationTtl: QUERY_CACHE_TTL_SECONDS,
      }).catch(() => {});
    }
    return vector;
  } catch {
    return null;
  }
}

/**
 * Compile the query into chips. Heuristic first, always.
 *
 * The model is asked only when the heuristic left words it could not map, and its answer
 * is cached for 7 days (§7). A query the heuristic fully explains never reaches a model
 * at all, which is both faster and free.
 */
async function compile(
  query: string,
  vocabulary: QueryVocabulary,
  runtime: Runtime,
): Promise<{ compiled: CompiledQuery; source: "heuristic" | "model" | "cached" }> {
  const heuristic = compileQueryHeuristically(query, vocabulary);

  // Nothing left over: the heuristic did the whole job. No key or no configured model:
  // the heuristic is the whole compiler, which §7's fallback `[PR]` makes a supported
  // state rather than a broken one.
  if (heuristic.unmapped.length === 0 || !runtime.GROQ_API_KEY || !runtime.QUERY_COMPILER_MODEL) {
    return { compiled: heuristic, source: "heuristic" };
  }

  const key = `qc:${queryCacheKey(query)}`;
  if (runtime.QUERY_CACHE) {
    try {
      const cached = await runtime.QUERY_CACHE.get(key, "json");
      if (Array.isArray(cached)) {
        return { compiled: mergeModelChips(heuristic, cached, vocabulary), source: "cached" };
      }
    } catch {
      /* a cache outage is a cache miss */
    }
  }

  try {
    // Deliberately tight: this runs in a request, and §7's output is chips only.
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.GROQ_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: runtime.QUERY_COMPILER_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "Map a search query onto filter chips. Return JSON only, of the form",
              '{"chips":[{"kind":"country|category|mode|cost|team|deadline","value":"..."}]}.',
              "Use only these values:",
              `country: ISO 3166-1 alpha-2 from ${vocabulary.countries.map((c) => c.iso2).join(",")}`,
              `category: ${vocabulary.categories.map((c) => c.code).join(",")}`,
              "mode: online, in_person, hybrid",
              "cost: free",
              "team: team, individual",
              "deadline: 7, 30, 90",
              "Omit anything you cannot map. Never invent a value. Return no prose.",
            ].join("\n"),
          },
          { role: "user", content: query },
        ],
      }),
      signal: AbortSignal.timeout(2500),
    });

    if (!response.ok) return { compiled: heuristic, source: "heuristic" };

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { compiled: heuristic, source: "heuristic" };

    const parsed = JSON.parse(content) as { chips?: unknown };
    const chips = Array.isArray(parsed.chips) ? parsed.chips : [];

    if (runtime.QUERY_CACHE) {
      await runtime.QUERY_CACHE.put(key, JSON.stringify(chips), {
        expirationTtl: QUERY_CACHE_TTL_SECONDS,
      }).catch(() => {});
    }

    return { compiled: mergeModelChips(heuristic, chips, vocabulary), source: "model" };
  } catch {
    // §13's failure matrix: "Query compiler down -> Chips come from heuristics."
    return { compiled: heuristic, source: "heuristic" };
  }
}

/**
 * Rank retrieved candidates. Every weight comes from the config package.
 *
 * §6.1: `final = score × eligibility_boost × urgency_boost × freshness_penalty × diversity`
 */
export function rank(
  candidates: Array<{
    id: string;
    slug: string;
    rrf: string | number;
    verdict: string | null;
    verification: string;
    deadline_at: string | null;
    is_rolling: boolean;
    organisation_slug: string | null;
    category_code: string | null;
  }>,
  now: Date = new Date(),
): SearchResultRow[] {
  const scored = candidates
    .map((row) => {
      const verdict = (row.verdict ?? "unclear") as keyof typeof ELIGIBILITY_BOOST;
      const freshness =
        FRESHNESS_PENALTY[row.verification as keyof typeof FRESHNESS_PENALTY] ??
        FRESHNESS_PENALTY.default;

      return {
        id: row.id,
        slug: row.slug,
        verdict: row.verdict,
        verification: row.verification,
        deadline_at: row.deadline_at,
        is_rolling: row.is_rolling,
        organisation_slug: row.organisation_slug,
        category_code: row.category_code,
        score:
          Number(row.rrf) *
          (ELIGIBILITY_BOOST[verdict] ?? ELIGIBILITY_BOOST.unclear) *
          urgencyBoost(row.is_rolling ? null : row.deadline_at, now) *
          freshness,
      };
    })
    .sort((a, b) => b.score - a.score);

  return applyDiversity(scored, (row) => ({
    organisation: row.organisation_slug,
    category: row.category_code,
  }));
}

export interface SearchInput {
  /** The raw query, as typed. */
  q?: string | null;
  /** Filters already set as URL state, which always win over anything compiled. */
  country?: string | null;
  category?: string | null;
  mode?: string | null;
  cost?: string | null;
  team?: string | null;
  hasPrize?: boolean;
  limit?: number;
  /** The viewer, for the eligibility boost. Their profile never leaves the database. */
  userId?: string | null;
}

/**
 * Search. Compiles, retrieves, ranks.
 *
 * Explicit URL filters take precedence over compiled chips: the chips are a starting
 * point the user can edit (§7), and once they have edited one, the compiler must not
 * quietly put it back.
 */
export async function search(input: SearchInput, env: Record<string, string> = {}): Promise<SearchOutcome> {
  const runtime = env as unknown as Runtime;
  const client = getClient(env);

  if (!client) {
    return {
      ok: false,
      rows: [],
      compiled: null,
      retrieval: { fts: false, vector: false, compiler: "heuristic" },
    };
  }

  const query = (input.q ?? "").trim();
  let compiled: CompiledQuery | null = null;
  let compilerSource: "heuristic" | "model" | "cached" = "heuristic";

  if (query) {
    const vocabulary = await getQueryVocabulary(env);
    const result = await compile(query, vocabulary, runtime);
    compiled = result.compiled;
    compilerSource = result.source;
  }

  const fromChips = (kind: string) =>
    compiled?.chips.find((chip) => chip.kind === kind)?.value ?? null;

  const country = input.country ?? fromChips("country");
  const category = input.category ?? fromChips("category");
  const mode = input.mode ?? fromChips("mode");
  const cost = input.cost ?? fromChips("cost");
  const team = input.team ?? fromChips("team");
  const hasPrize = input.hasPrize || fromChips("prize") === "true";

  // The keyword text, not the raw query: the words the chips claimed are already
  // expressed as filters, and searching for them again narrows the result for no reason.
  const text = compiled ? compiled.keywords : query;

  const embedding = await queryEmbedding(text || query, runtime);

  const { data, error } = await client.rpc("search_candidates", {
    p_query: text || null,
    p_embedding: embedding ? `[${embedding.join(",")}]` : null,
    p_user_id: input.userId ?? null,
    p_country: country,
    p_category_code: category,
    p_mode: mode,
    p_cost: cost,
    p_team: team,
    p_has_prize: hasPrize ? true : null,
    p_limit: CANDIDATES_PER_RETRIEVER,
  });

  if (error) {
    return {
      ok: false,
      rows: [],
      compiled,
      retrieval: { fts: false, vector: false, compiler: compilerSource },
    };
  }

  const candidates = (data ?? []) as Parameters<typeof rank>[0];
  const ranked = rank(candidates);

  return {
    ok: true,
    rows: ranked.slice(0, Math.min(input.limit ?? 20, 100)),
    compiled,
    retrieval: {
      fts: candidates.some((row) => (row as { rank_fts?: number | null }).rank_fts !== null),
      vector: embedding !== null,
      compiler: compilerSource,
    },
  };
}
