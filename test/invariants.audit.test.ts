/**
 * The thirteen invariants, audited structurally. README.md §5, IMPLEMENTATION_PLAN.md §16.
 *
 * "Violating any of these is a defect, not a trade-off."
 *
 * Most of them already have a home: the database refuses 1, 2 and 13 (supabase/tests/invariants.sql
 * proves it refuses them rather than merely that the constraints exist); 3 has its own suite in
 * packages/eligibility; 4 is asserted per surface in the SQL suites; 5 is the byte-budget gate; 11
 * is scripts/secret-scan.sh; 12 is asserted per route from rendered HTML.
 *
 * FOUR had no home at all — 6, 7, 8 and 9 — because each is a statement about what the code must
 * NOT do, and nothing had ever gone looking. This file is that search. It reads the sources, so it
 * catches the violation on the commit that introduces it rather than in production.
 *
 * Where an exception exists it is named here with its reason, and the test asserts there is exactly
 * one of it. A blanket allowance would make the audit decorative.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const walk = (dir: string): string[] => {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
};

/** Everything that ships or runs. Tests and docs are not code under audit. */
const CODE = [
  ...walk(join(ROOT, "apps", "web", "src")),
  ...walk(join(ROOT, "packages", "config", "src")),
  ...walk(join(ROOT, "packages", "eligibility", "src")),
  ...walk(join(ROOT, "packages", "ingest", "src")),
  ...walk(join(ROOT, "scripts")),
].filter((file) => /\.(ts|mjs|js|astro|svelte)$/.test(file));

const REQUEST_HANDLERS = walk(join(ROOT, "apps", "web", "src", "pages")).filter((file) =>
  /\.(ts|astro)$/.test(file),
);

const read = (file: string) => readFileSync(file, "utf8");
const rel = (file: string) => relative(ROOT, file);

/** Source with comments removed, so an audit never fails on its own explanation. */
const withoutComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/<!--[\s\S]*?-->/g, " ");

describe("the audit has something to audit", () => {
  it("found the code (guards against a vacuous pass)", () => {
    expect(CODE.length).toBeGreaterThan(60);
    expect(REQUEST_HANDLERS.length).toBeGreaterThan(20);
  });
});

describe("invariant 6 — never send user personal data to an LLM provider", () => {
  /**
   * The private layer's table name, which is the only place personal data lives
   * (DATA_MODEL.md §15, PRIVACY_AND_COMPLIANCE.md §2), and the words a provider call uses.
   *
   * The test is structural: no file may both read the eligibility profile and call a provider. It
   * cannot prove a payload's contents, but it makes the one shape that could leak — profile in,
   * provider out, same function — impossible to write without a failing test.
   */
  const PROVIDER_CALL = /callProvider|ai_providers|GROQ_API_KEY|CEREBRAS|GEMINI_API_KEY|AI\.run\(|env\.AI\b/;
  const PRIVATE_LAYER = /eligibility_profiles|country_of_residence|birth_year|student_status\b/;

  it("no file both reads the private layer and calls a provider", () => {
    const offenders = CODE.filter((file) => {
      const source = withoutComments(read(file));
      return PROVIDER_CALL.test(source) && PRIVATE_LAYER.test(source);
    }).map(rel);
    expect(offenders, `these files touch both the private layer and a provider:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the profile table carries no embedding column, by construction", () => {
    // AI_SYSTEM.md §8: "never embed eligibility profile fields." The schema is the enforcement —
    // there is nowhere to put a vector — and this asserts nobody has added one.
    const migrations = walk(join(ROOT, "supabase", "migrations")).filter((f) => f.endsWith(".up.sql"));
    const creates = migrations.map(read).join("\n");
    const profileTable = (/CREATE TABLE eligibility_profiles[\s\S]*?\n\);/.exec(creates)?.[0] ?? "")
      // Without the comments: the table's own body says "Deliberately NO embedding column", which
      // is the note explaining the absence and not a column.
      .replace(/--[^\n]*/g, " ");
    expect(profileTable, "eligibility_profiles is not defined in any migration").toBeTruthy();
    expect(profileTable).not.toMatch(/embedding/);
    // And no later migration added one.
    expect(creates).not.toMatch(/ALTER TABLE eligibility_profiles[^;]*embedding/);
  });
});

describe("invariant 7 — never hard-code a model name", () => {
  /**
   * What a model name looks like across the catalogues this product uses: Groq, Cerebras, Gemini,
   * Workers AI and the local transformers pipeline.
   */
  const MODEL_NAME =
    /(?:Xenova\/|@cf\/|\bbge-small\b|\ball-MiniLM\b|\bllama-?3\b|\bgemini-[0-9]|\bgpt-[0-9]|\bclaude-[0-9]|\bmixtral\b|\bqwen[0-9-]|\bdeepseek\b|\bgemma-?[0-9])/i;

  /**
   * The single documented exception, and the reason .env.example gives for it: the batch embedder
   * runs a LOCAL model inside GitHub Actions with no API and no quota (AI_SYSTEM.md §3.3), so the
   * failure mode this invariant exists to prevent — a hosted catalogue renaming a model without
   * notice — does not apply to it. It is still read from the environment; the literal is only the
   * fallback, and the dimension it implies is pinned by the halfvec(384) column.
   */
  const ALLOWED = new Map([["scripts/embed.mjs", 1]]);

  it("holds no model name outside the one documented fallback", () => {
    const offenders: string[] = [];
    for (const file of CODE) {
      const source = withoutComments(read(file));
      /*
       * Quoted STRINGS containing a model name, not raw pattern hits: "Xenova/bge-small-en-v1.5"
       * matches two of the alternatives above and is one literal. Counting matches instead of
       * literals made the single documented fallback look like two violations.
       */
      const hits = [...source.matchAll(/["'`]([^"'`\n]{3,80})["'`]/g)].filter((m) =>
        MODEL_NAME.test(m[1]!),
      );
      const budget = ALLOWED.get(rel(file)) ?? 0;
      if (hits.length > budget) {
        offenders.push(`${rel(file)}: ${hits.length} model name(s), ${budget} allowed — ${hits[0]![0]}`);
      }
    }
    expect(offenders, `model names belong in ai_providers or the environment:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("and the exception is still there, so the allowance is not stale", () => {
    // If the fallback is ever removed, this test fails and the allowance above must go with it.
    expect(read(join(ROOT, "scripts", "embed.mjs"))).toMatch(/process\.env\.EMBEDDING_MODEL/);
  });

  it("every provider is configured in a table, not in a module", () => {
    const seed = read(join(ROOT, "supabase", "seed", "005_ai_providers.sql"));
    expect(seed).toMatch(/INSERT INTO ai_providers/);
    // The chain is rows, so a model rename is an UPDATE rather than a deploy.
    expect(seed).toMatch(/priority/);
  });
});

describe("invariant 8 — never call an LLM in a request handler, except the cached query compiler", () => {
  const AI_CALL = /callProvider|GROQ_API_KEY|CEREBRAS_API_KEY|GEMINI_API_KEY|\bai\.run\(|AI\.run\(/;

  it("no page or endpoint calls a provider directly", () => {
    const offenders = REQUEST_HANDLERS.filter((file) => AI_CALL.test(withoutComments(read(file)))).map(rel);
    expect(offenders, `a request handler calling an LLM:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the one permitted call lives in the search library and is cached", () => {
    // AI_SYSTEM.md §7: the compiler's output is cached in KV for 7 days, which is what makes the
    // exception affordable. The cache is the reason it is allowed, so its absence is a violation.
    const search = read(join(ROOT, "apps", "web", "src", "lib", "search.ts"));
    expect(search).toMatch(/QUERY_CACHE_TTL_SECONDS|queryCacheKey/);
    expect(search).toMatch(/KV|kv\.(get|put)/i);
    // And it degrades rather than failing: invariant 10.
    expect(search).toMatch(/compileQueryHeuristically/);
  });

  it("the batch tier is where the rest of the AI lives", () => {
    // The scripts reach the providers through `runTask`, which is the provider layer's entry point
    // (packages/ingest/src/providers.mjs). If no batch script calls it, the AI has moved somewhere
    // it should not be — which is the failure this invariant is about, in the other direction.
    const batch = walk(join(ROOT, "scripts")).filter((file) => /\brunTask\b/.test(withoutComments(read(file))));
    expect(
      batch.map(rel),
      "no batch script calls the provider layer — the AI moved somewhere it should not be",
    ).not.toEqual([]);
  });
});

describe("invariant 9 — never create fake users, teams, projects or counts", () => {
  it("the seed contains reference data and nothing that pretends to be a person", () => {
    const seeds = walk(join(ROOT, "supabase", "seed")).filter((f) => f.endsWith(".sql"));
    expect(seeds.length).toBeGreaterThan(3);

    const FORBIDDEN = /INSERT INTO (?:users|profiles|teams|team_members|projects|intents|tracker_entries|threads|thread_messages)\b/i;
    const offenders = seeds.filter((file) => FORBIDDEN.test(read(file))).map(rel);
    expect(offenders, `seed data inventing people or their work:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no migration seeds a person either", () => {
    const migrations = walk(join(ROOT, "supabase", "migrations")).filter((f) => f.endsWith(".up.sql"));
    const offenders = migrations
      .filter((file) => /INSERT INTO (?:users|profiles|teams|projects|intents)\b/i.test(read(file)))
      .map(rel);
    expect(offenders, `a migration inserting a person:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("shows no vanity count anywhere in the interface", () => {
    // PRODUCT_SPEC.md §27 and ANALYTICS.md §9: no vanity metrics shown to users. `view_count` is an
    // aggregate the database keeps and no page may render.
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "apps", "web", "src")).filter((f) => /\.(astro|svelte)$/.test(f))) {
      const source = withoutComments(read(file));
      /*
       * Identifiers, not prose. /content-policy explains that this product counts no likes and has
       * no followers, which is the policy stating its own absence — and a test that could not tell
       * the difference would forbid the product from saying what it does not do.
       */
      if (/\b(?:view_count|follower_count|like_count|star_count|likes_count)\b/.test(source)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders, `a vanity metric in the interface:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("invariant 12 — never add a third-party script to a public page", () => {
  it("no page source loads a script from another origin", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "apps", "web", "src")).filter((f) => /\.(astro|svelte)$/.test(f))) {
      const source = read(file);
      for (const match of source.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
        if (/^https?:\/\//.test(match[1]!)) offenders.push(`${rel(file)}: ${match[1]}`);
      }
    }
    expect(offenders, `a third-party script:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("and the CSP would refuse one anyway", () => {
    // Comment lines stripped: the file's own header explains that the CSP "carries no
    // `unsafe-inline`", and an audit that failed on its own explanation would be a bad audit.
    const headers = read(join(ROOT, "apps", "web", "public", "_headers"))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(headers).toMatch(/script-src 'self'/);
    expect(headers).not.toMatch(/unsafe-inline/);
    expect(headers).not.toMatch(/script-src[^;]*https?:\/\//);
  });
});

describe("invariant 10 — never let an AI failure produce a user-facing error", () => {
  it("every provider call path has a degraded answer", () => {
    // The provider layer returns a result rather than throwing, and the ingest pipeline has a
    // NO_AI path asserted end to end in test/ingestion-pipeline.test.ts. What is asserted here is
    // that the request tier's one AI call has a non-AI fallback in the same file.
    const search = read(join(ROOT, "apps", "web", "src", "lib", "search.ts"));
    expect(search).toMatch(/compileQueryHeuristically/);
    expect(search).toMatch(/ok:\s*false/);

    const providers = read(join(ROOT, "packages", "ingest", "src", "providers.mjs"));
    expect(providers).toMatch(/NO_AI|no_ai|noAi/i);
  });
});

describe("what was removed stays removed (README.md §4)", () => {
  /**
   * Eight features were removed from the brief with a reason, and README.md §4 says plainly that
   * "a coding agent should not re-add these". This is the test that notices if one comes back.
   *
   * Matched against the code, not the docs: the docs discuss these by name, which is the point of
   * them.
   */
  const REMOVED: [string, RegExp][] = [
    ["AI judging simulator", /judging[_ -]?simulator|simulateJudging|judge_score/i],
    ["AI hackathon copilot", /copilot|chat_?assistant|assistantMessage/i],
    ["generic AI idea generation", /generateIdea|idea_?generator|brainstorm/i],
    ["a global browsable builder directory", /browse_?builders|builder_?directory|\/builders\b/i],
    ["open DMs", /\bdirect_?messages?\b|\bdm_?thread|openDm/i],
    ["achievements and gamification", /achievements?\b|badges_?earned|\bxp\b|leaderboard/i],
    ["an interactive Africa map", /mapbox|leaflet|maplibre|map_?tiles/i],
  ];

  for (const [feature, pattern] of REMOVED) {
    it(`${feature} has not come back`, () => {
      const offenders = CODE.filter((file) => pattern.test(withoutComments(read(file)))).map(rel);
      expect(offenders, `${feature} appears in:\n${offenders.join("\n")}`).toEqual([]);
    });
  }

  it("natural-language search is still a compiler with editable chips, not an answering layer", () => {
    // §4's first reframing: "never an answering layer". The compiler's output is chips the user can
    // remove, and the test for that behaviour is in packages/config; this asserts the shape is
    // still chips rather than prose.
    const compiler = read(join(ROOT, "packages", "config", "src", "query-compiler.ts"));
    expect(compiler).toMatch(/chips/);
    expect(compiler).not.toMatch(/\banswer\b\s*[:=]/i);
  });

  it("team matching still displays role complementarity and scores no humans", () => {
    // §4's second reframing: "we do not score humans against each other."
    const offenders = CODE.filter((file) =>
      /compatibility_?score|match_?score.*user|score_?builder|rank_?builders/i.test(withoutComments(read(file))),
    ).map(rel);
    expect(offenders, `something is scoring people:\n${offenders.join("\n")}`).toEqual([]);
  });
});
