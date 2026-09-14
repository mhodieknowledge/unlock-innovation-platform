/**
 * The natural-language query compiler's deterministic half. AI_SYSTEM.md §7.
 *
 * "**Output:** filter chips only. Never results, never prose. `[PR]`"
 *
 * §7's `NO_AI` fallback `[PR]` is a "deterministic heuristic matcher — country names and
 * demonyms → ISO codes, category synonyms → category codes, 'remote'/'online' → mode,
 * 'closing soon'/'this month' → deadline state, remaining words → FTS. This covers a
 * large share of real queries without any model."
 *
 * This file IS that matcher, and it runs FIRST on every query — not only when the model
 * is unavailable. Three reasons:
 *
 *   1. It costs nothing. §11 lists KV caching and deterministic pre-filters as the cost
 *      controls that keep the AI budget viable, and a query the heuristic fully explains
 *      never needs a model at all.
 *   2. It is instant. The compiler runs in a request handler, and a 400ms model call to
 *      parse "grants in zimbabwe" is 400ms nobody should spend.
 *   3. It is predictable. A user who types the same thing twice gets the same chips.
 *
 * The model's job is only what the heuristic could not map — and §7's guardrail says its
 * output is validated against the live vocabulary and unknown values discarded, so the
 * model can widen the parse but never invent a filter.
 */

import demonymData from "./demonyms.json" with { type: "json" };

const DEMONYMS = (demonymData as { demonyms: Record<string, string[]> }).demonyms;

/** One filter the user can see and remove. §7: "The user always sees and can edit the chips". */
export interface QueryChip {
  /** Which filter this sets. */
  kind: "country" | "category" | "mode" | "cost" | "team" | "deadline" | "prize" | "keyword";
  /** The value the filter takes. */
  value: string;
  /** What the chip says on screen. */
  label: string;
  /** The words in the query this came from, so a user can see WHY it is there. */
  from: string;
  /** How it was derived. §7 wants the model's contribution distinguishable. */
  source: "heuristic" | "model";
}

export interface CompiledQuery {
  chips: QueryChip[];
  /** Words no filter claimed. These go to full-text search. */
  keywords: string;
  /** §7: "Anything unmappable is returned in unmapped_terms". */
  unmapped: string[];
}

/** The live filter vocabulary, read from our own tables — never from the model. */
export interface QueryVocabulary {
  countries: Array<{ iso2: string; name: string; commonNames?: string[] }>;
  categories: Array<{ code: string; name: string }>;
}

/**
 * Category synonyms — the words people actually type.
 *
 * Mapped onto category CODES, which are validated against the live list, so a synonym
 * pointing at a category that no longer exists simply stops matching.
 *
 * "bursary", "funding" and "money" all mean a scholarship or grant to the person typing
 * them, and none of them is the category's name.
 */
const CATEGORY_SYNONYMS: Record<string, string[]> = {
  grant: ["grant", "grants", "funding", "money", "finance", "financing", "seed funding"],
  scholarship: ["scholarship", "scholarships", "bursary", "bursaries", "study funding", "tuition"],
  fellowship: ["fellowship", "fellowships", "fellow"],
  hackathon: ["hackathon", "hackathons", "hack", "build sprint", "codefest"],
  coding_competition: ["coding competition", "code competition", "programming contest", "ctf"],
  ai_challenge: ["ai challenge", "ml challenge", "machine learning challenge", "ai competition"],
  data_competition: ["data competition", "data science competition", "kaggle"],
  innovation_challenge: ["innovation challenge", "innovation prize", "challenge fund"],
  startup_competition: ["startup competition", "pitch competition", "pitch contest", "demo day"],
  accelerator: ["accelerator", "accelerators", "acceleration programme", "acceleration program"],
  incubator: ["incubator", "incubators", "incubation"],
  internship: ["internship", "internships", "intern", "placement"],
  bootcamp: ["bootcamp", "boot camp", "bootcamps", "intensive course"],
  training: ["training", "course", "courses", "workshop", "workshops", "short course"],
  conference: ["conference", "conferences", "summit", "symposium", "convening"],
  residency: ["residency", "residencies", "artist residency"],
  award: ["award", "awards", "prize", "prizes", "recognition"],
  call_for_proposals: ["call for proposals", "cfp", "request for proposals", "rfp", "open call"],
  exchange: ["exchange", "exchange programme", "exchange program", "study abroad"],
  mentorship: ["mentorship", "mentoring", "mentor programme", "mentor program"],
  volunteering: ["volunteering", "volunteer", "voluntary"],
  job: ["job", "jobs", "vacancy", "vacancies", "role", "position", "graduate scheme"],
};

const MODE_WORDS: Record<string, string[]> = {
  online: ["online", "remote", "remotely", "virtual", "from home", "anywhere"],
  in_person: ["in person", "in-person", "onsite", "on-site", "physical", "residential"],
  hybrid: ["hybrid", "blended"],
};

const COST_WORDS: Record<string, string[]> = {
  free: ["free", "free to enter", "no fee", "no cost", "fully funded"],
};

const TEAM_WORDS: Record<string, string[]> = {
  team: ["team", "teams", "group", "in a team", "team-based"],
  individual: ["individual", "solo", "alone", "by myself", "on my own"],
};

/**
 * Deadline phrases. These set a WINDOW rather than a sort: "closing soon" is a filter a
 * user can see and remove, and PRODUCT_SPEC.md §13.4 already makes urgency the default
 * ordering — so treating it as a sort would be a chip that appears to do nothing.
 */
const DEADLINE_WORDS: Record<string, string[]> = {
  "7": ["closing soon", "closing this week", "this week", "urgent", "last chance", "closing now"],
  "30": ["this month", "next month", "within a month", "in 30 days"],
  "90": ["next three months", "this quarter", "in 90 days"],
};

const PRIZE_WORDS = ["with a prize", "prize money", "cash prize", "paid", "funded", "stipend"];

/** Words that carry no filter and no search value. */
const STOP_PHRASES = [
  "i want",
  "i am looking for",
  "im looking for",
  "looking for",
  "show me",
  "find me",
  "are there any",
  "is there any",
  "what are the",
  "anything for",
  "open to",
  "available for",
  "for me",
  "please",
];

/**
 * Connectives. Removed from the leftover keywords only — never from a phrase being
 * matched, where "in person" and "call for proposals" need their middle words.
 */
const CONNECTIVES = new Set([
  "in", "for", "and", "or", "the", "a", "an", "of", "to", "on", "at", "with", "any",
  "some", "that", "this", "my", "me", "i", "is", "are", "be", "by", "from", "about",
]);

const normalise = (s: string) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}'\- ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Match a phrase on WORD boundaries, tolerating a plural.
 *
 * Word boundaries, because substring matching would map "programme" onto "gram" and —
 * the one that matters — "Niger" onto "Nigeria". Those are two different countries, and
 * confusing them makes a country filter WRONG rather than merely unhelpful.
 *
 * A trailing "s" is optional because natural queries pluralise everything: "grants for
 * Zimbabweans", "ai challenges", "remote internships". The tolerance is one-directional
 * — a listed phrase can match a pluralised query, never the reverse — so it cannot make
 * "nigeria" match "niger" (that would need "nigerias") and cannot introduce a
 * cross-country match.
 *
 * Not solved by listing plurals in the data: several demonyms have no -s plural at all
 * (Basotho, Batswana, Malagasy, Somali), so the rule has to be in the matcher.
 */
function phraseRegex(needle: string, forRemoval: boolean): RegExp {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = forRemoval ? "(?=$|\\s)" : "(?:$|\\s)";
  return new RegExp(`(?:^|\\s)${escaped}s?${suffix}`, forRemoval ? "gu" : "u");
}

/** Returns the text actually matched, so a chip can show the user their own words. */
function findPhrase(haystack: string, needle: string): string | null {
  const match = phraseRegex(needle, false).exec(haystack);
  return match === null ? null : match[0].trim();
}

function removePhrase(haystack: string, needle: string): string {
  return haystack.replace(phraseRegex(needle, true), " ").replace(/\s+/g, " ").trim();
}

/**
 * Compile a natural-language query into filter chips, deterministically.
 *
 * @param query what the user typed
 * @param vocabulary the LIVE filter vocabulary, from our own tables
 */
export function compileQueryHeuristically(query: string, vocabulary: QueryVocabulary): CompiledQuery {
  let rest = normalise(query);
  const chips: QueryChip[] = [];
  const taken = new Set<string>();

  /** Longest phrases first, so "south africa" wins over "africa". */
  const claim = (phrases: Array<{ phrase: string; chip: Omit<QueryChip, "from" | "source"> }>) => {
    const ordered = [...phrases].sort((a, b) => b.phrase.length - a.phrase.length);
    for (const { phrase, chip } of ordered) {
      if (!phrase || phrase.length < 2) continue;
      const matched = findPhrase(rest, phrase);
      if (matched === null) continue;
      const key = `${chip.kind}:${chip.value}`;
      if (taken.has(key)) {
        rest = removePhrase(rest, phrase);
        continue;
      }
      taken.add(key);
      // `from` is what the USER typed, not the phrase we listed: the chip is editable,
      // so it has to be explicable in their own words.
      chips.push({ ...chip, from: matched, source: "heuristic" });
      rest = removePhrase(rest, phrase);
    }
  };

  for (const phrase of STOP_PHRASES) {
    if (findPhrase(rest, phrase) !== null) rest = removePhrase(rest, phrase);
  }

  // Countries, by name, common name, or demonym.
  claim(
    vocabulary.countries.flatMap((country) => {
      const labels = [country.name, ...(country.commonNames ?? [])];
      const demonyms = DEMONYMS[country.iso2] ?? [];
      return [...labels, ...demonyms].map((phrase) => ({
        phrase: normalise(phrase),
        chip: {
          kind: "country" as const,
          value: country.iso2,
          label: `Open to ${country.name}`,
        },
      }));
    }),
  );

  // Categories, by name or synonym — but only codes the live list actually has.
  const liveCodes = new Set(vocabulary.categories.map((c) => c.code));
  const nameOf = new Map(vocabulary.categories.map((c) => [c.code, c.name]));
  claim(
    Object.entries(CATEGORY_SYNONYMS)
      .filter(([code]) => liveCodes.has(code))
      .flatMap(([code, synonyms]) =>
        [...synonyms, nameOf.get(code) ?? ""].map((phrase) => ({
          phrase: normalise(phrase),
          chip: { kind: "category" as const, value: code, label: nameOf.get(code) ?? code },
        })),
      ),
  );

  claim(
    Object.entries(MODE_WORDS).flatMap(([mode, words]) =>
      words.map((phrase) => ({
        phrase: normalise(phrase),
        chip: {
          kind: "mode" as const,
          value: mode,
          label: mode === "online" ? "Online" : mode === "in_person" ? "In person" : "Hybrid",
        },
      })),
    ),
  );

  claim(
    Object.entries(COST_WORDS).flatMap(([cost, words]) =>
      words.map((phrase) => ({
        phrase: normalise(phrase),
        chip: { kind: "cost" as const, value: cost, label: "Free to enter" },
      })),
    ),
  );

  claim(
    Object.entries(TEAM_WORDS).flatMap(([team, words]) =>
      words.map((phrase) => ({
        phrase: normalise(phrase),
        chip: {
          kind: "team" as const,
          value: team,
          label: team === "team" ? "Teams" : "Individuals",
        },
      })),
    ),
  );

  claim(
    Object.entries(DEADLINE_WORDS).flatMap(([days, words]) =>
      words.map((phrase) => ({
        phrase: normalise(phrase),
        chip: {
          kind: "deadline" as const,
          value: days,
          label: days === "7" ? "Closing within a week" : `Closing within ${days} days`,
        },
      })),
    ),
  );

  claim(
    PRIZE_WORDS.map((phrase) => ({
      phrase: normalise(phrase),
      chip: { kind: "prize" as const, value: "true", label: "Has a prize" },
    })),
  );

  // Whatever is left is search text. Dropped from it: single letters and bare numbers
  // (they match everything and mean nothing), and the connectives left behind once the
  // filters have taken their words — "grants in zimbabwe" should not leave "in" showing
  // in the keyword chip as though the user had searched for it.
  const keywords = rest
    .split(" ")
    .filter(
      (word) => word.length > 1 && !/^\d+$/.test(word) && !CONNECTIVES.has(word),
    )
    .join(" ");

  return {
    chips,
    keywords,
    unmapped: keywords === "" ? [] : keywords.split(" "),
  };
}

/**
 * Merge a model's chips into a heuristic parse. AI_SYSTEM.md §7's guardrails.
 *
 * "Output validated against the live filter vocabulary; unknown values discarded."
 *
 * The heuristic's chips WIN on conflict. The heuristic knows it saw the word "zimbabwe";
 * the model is guessing at intent, and when they disagree about a country the one that
 * read the text is right. The model's value is the chips the heuristic had no phrase for.
 *
 * @param heuristic what the deterministic pass produced
 * @param modelChips the model's proposal, unvalidated
 * @param vocabulary the live vocabulary
 */
export function mergeModelChips(
  heuristic: CompiledQuery,
  modelChips: unknown,
  vocabulary: QueryVocabulary,
): CompiledQuery {
  if (!Array.isArray(modelChips)) return heuristic;

  const liveCountries = new Set(vocabulary.countries.map((c) => c.iso2));
  const liveCategories = new Set(vocabulary.categories.map((c) => c.code));
  const nameOf = new Map(vocabulary.categories.map((c) => [c.code, c.name]));
  const countryName = new Map(vocabulary.countries.map((c) => [c.iso2, c.name]));

  const existing = new Set(heuristic.chips.map((c) => `${c.kind}:${c.value}`));
  const chips = [...heuristic.chips];

  for (const raw of modelChips) {
    if (typeof raw !== "object" || raw === null) continue;
    const candidate = raw as Record<string, unknown>;
    const kind = String(candidate["kind"] ?? "");
    const value = String(candidate["value"] ?? "").trim();
    if (!value) continue;

    let label: string | null = null;
    if (kind === "country") {
      const iso2 = value.toUpperCase();
      if (!liveCountries.has(iso2)) continue;   // discarded: not in the live vocabulary
      if (existing.has(`country:${iso2}`)) continue;
      chips.push({
        kind: "country",
        value: iso2,
        label: `Open to ${countryName.get(iso2) ?? iso2}`,
        from: "interpreted",
        source: "model",
      });
      existing.add(`country:${iso2}`);
      continue;
    }
    if (kind === "category") {
      if (!liveCategories.has(value)) continue;
      if (existing.has(`category:${value}`)) continue;
      label = nameOf.get(value) ?? value;
    } else if (kind === "mode") {
      if (!["online", "in_person", "hybrid"].includes(value)) continue;
      label = value === "online" ? "Online" : value === "in_person" ? "In person" : "Hybrid";
    } else if (kind === "cost") {
      if (value !== "free") continue;
      label = "Free to enter";
    } else if (kind === "team") {
      if (!["team", "individual"].includes(value)) continue;
      label = value === "team" ? "Teams" : "Individuals";
    } else if (kind === "deadline") {
      if (!["7", "30", "90"].includes(value)) continue;
      label = value === "7" ? "Closing within a week" : `Closing within ${value} days`;
    } else {
      // An unknown chip kind. Discarded rather than passed through: a chip the UI
      // cannot render and the search cannot apply would be a filter that silently
      // does nothing.
      continue;
    }

    const key = `${kind}:${value}`;
    if (existing.has(key)) continue;
    existing.add(key);
    chips.push({
      kind: kind as QueryChip["kind"],
      value,
      label,
      from: "interpreted",
      source: "model",
    });
  }

  return { ...heuristic, chips };
}

/**
 * The cache key. §7: "Cached in KV by normalised query string for 7 days — most queries
 * repeat."
 *
 * Sorted words, so "grants zimbabwe" and "zimbabwe grants" share one cache entry. That
 * is the right trade for a filter parse: the chips are the same either way, and the word
 * order only matters to full-text ranking, which happens after.
 */
export function queryCacheKey(query: string): string {
  return normalise(query).split(" ").filter(Boolean).sort().join(" ");
}

/** §7: cached for 7 days. */
export const QUERY_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
