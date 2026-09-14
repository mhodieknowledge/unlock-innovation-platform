/**
 * Every weight in search and recommendation ranking, in one file.
 *
 * SYSTEM_ARCHITECTURE.md §6.1 `[TD]` requires exactly this: "All weights live in a
 * single `ranking.ts` constants file with a comment explaining each."
 *
 * The reason is not tidiness. Ranking weights are the part of a product that gets
 * tuned under pressure — a stakeholder asks why something is not first, someone nudges
 * a multiplier, and six months later nobody can say what the ranking optimises for.
 * Keeping them together with the reasoning attached makes a change a decision rather
 * than an adjustment.
 *
 * WHY .mjs AND NOT .ts: two callers need these weights and they cannot share a module
 * otherwise — the web app imports them at request time, and scripts/recommend.mjs is
 * plain Node running before any build step. §6.1 asks for "a single ranking.ts constants
 * file"; the extension differs and the requirement it exists for does not, because the
 * alternative was a second copy of the numbers in the batch tier. JSDoc plus checkJs
 * keeps it typechecked. The same trade is made in packages/ingest and for the brand
 * config, and for the same reason.
 */

/**
 * Reciprocal Rank Fusion. §6.1: `score = RRF(rank_fts, rank_vec, k=60)`.
 *
 * k=60 is the value from the original RRF paper and the one every implementation uses.
 * It controls how quickly a result's contribution decays with rank: at k=60 the first
 * result contributes 1/61 and the tenth 1/70, so a result that both retrievers rank
 * highly beats one that only one of them loves. That is the property being bought —
 * agreement between lexical and semantic retrieval is a stronger signal than either
 * alone.
 */
export const RRF_K = 60;

/**
 * How many candidates each retriever contributes before fusion.
 *
 * Deliberately more than a page: fusion can only reorder what it is given, and a
 * result ranked 30th by FTS and 2nd by vectors should still be able to reach the first
 * page. Deliberately not unbounded: the ANN scan and the eligibility evaluation are
 * both per-candidate costs, and §25's search budget is 300ms at p95.
 */
export const CANDIDATES_PER_RETRIEVER = 120;

/**
 * Eligibility. §6.1, and the values matter more than they look.
 *
 * `not_eligible` is DOWN-RANKED, NEVER HIDDEN — 0.25, not 0. The reason is in the
 * spec: "the user may be checking for someone else". A parent looking for a
 * scholarship for their child, a community leader forwarding something to a WhatsApp
 * group, someone checking whether they would qualify next year. Hiding it would make
 * the catalogue lie about what exists.
 *
 * `unclear` sits at 1.0 rather than below it. An opportunity whose rules we could not
 * confirm is not a worse opportunity; it is one we know less about, and penalising it
 * would quietly bury everything our extraction found hard.
 */
export const ELIGIBILITY_BOOST = /** @type {const} */ ({
  eligible: 1.35,
  likely_eligible: 1.15,
  unclear: 1.0,
  not_eligible: 0.25,
});

/**
 * Urgency. §6.1: "peaks at 7 days out, decays to 0 after the deadline."
 *
 * Peaking at seven days rather than at one is a product decision about what is useful.
 * Something closing tomorrow is nearly useless to surface — most applications cannot be
 * assembled overnight — while something closing in a week is the most actionable thing
 * a deadline product can show. Past the deadline the boost is zero, not negative:
 * expired records are excluded from search entirely (§5.4), so this never applies to
 * them and does not need to fight that exclusion.
 */
export const URGENCY = /** @type {const} */ ({
  /** Days to deadline at which the boost is highest. */
  peakDays: 7,
  /** The multiplier at the peak. */
  peak: 1.3,
  /** The multiplier for something with no deadline at all (rolling, or unknown). */
  noDeadline: 0.9,
  /** How far out the boost has faded back to neutral. */
  neutralDays: 60,
});

/**
 * Freshness. §6.1: "×0.8 when `verification='stale'`, ×0.5 when `disputed`."
 *
 * A disputed record is one somebody reported as a scam or as charging a fee. It is
 * halved rather than removed because the report is unconfirmed — removing on an
 * unverified report would make the report button a censorship tool. It is halved
 * rather than nudged because the cost of being wrong runs the other way.
 */
export const FRESHNESS_PENALTY = /** @type {const} */ ({
  stale: 0.8,
  disputed: 0.5,
  community_flagged: 0.7,
  /** Everything else — official, verified, auto, expired — is unpenalised here. */
  default: 1.0,
});

/**
 * Diversity. §6.1: "max 2 per organisation, 3 per category in the first 20 results."
 *
 * Without this, one organisation running twelve regional rounds of the same programme
 * takes the entire first page, and the page stops being a view of the catalogue. The
 * cap applies to the first 20 only: beyond that a user is deliberately looking for more
 * of something, and capping a deep scroll would hide what they came for.
 */
export const DIVERSITY = /** @type {const} */ ({
  maxPerOrganisation: 2,
  maxPerCategory: 3,
  withinFirst: 20,
});

/**
 * Recommendation scoring. SYSTEM_ARCHITECTURE.md §8:
 * `0.45·similarity + 0.35·urgency + 0.20·quality`.
 *
 * Similarity leads, but not by much. A recommendation engine that only optimises
 * similarity recommends more of what someone already looked at; the urgency term is
 * what makes it a deadline product rather than a recommender, and the quality term is
 * what stops an unverified listing from an unproven source outranking a confirmed one
 * on a slightly better embedding match.
 */
export const RECOMMENDATION_WEIGHTS = /** @type {const} */ ({
  similarity: 0.45,
  urgency: 0.35,
  quality: 0.2,
});

/**
 * Quality, for the recommendation score: verification × source trust × completeness.
 *
 * `official` means the organisation itself posted it, which is the best provenance
 * available, so it tops the scale. `auto` at 0.75 is a deliberate discount on
 * something no person has checked.
 */
export const VERIFICATION_QUALITY = /** @type {const} */ ({
  official: 1.0,
  verified: 0.95,
  auto: 0.75,
  community_flagged: 0.5,
  stale: 0.6,
  disputed: 0.2,
  expired: 0.0,
});

/** SYSTEM_ARCHITECTURE.md §8: "top 20 stored". */
export const RECOMMENDATIONS_STORED = 20;

/**
 * Surface caps. PRODUCT_SPEC.md §14 and IMPLEMENTATION_PLAN.md §6's acceptance
 * criteria: "Your window is capped at 8 and dated; next actions at 5, each with a
 * reason."
 *
 * A cap is a promise about attention. Eight things closing soon is a list someone reads;
 * thirty is a list someone closes.
 */
export const SURFACE_CAPS = /** @type {const} */ ({
  yourWindow: 8,
  nextActions: 5,
  /** Cold start, when there is nothing personal to show yet. */
  countryBoard: 10,
});

/** SYSTEM_ARCHITECTURE.md §8: "per active user (seen in the last 30 days)". */
export const ACTIVE_USER_DAYS = 30;

/** §8's pre-filter: "deadline within 60 days". */
export const RECOMMENDATION_HORIZON_DAYS = 60;

/**
 * The urgency curve, shared by search and recommendations so the two cannot disagree
 * about what "closing soon" means.
 *
 * @param {Date | string | null} deadlineAt when it closes, or null for rolling and unknown
 * @param {Date} [now] the moment to measure from
 * @returns {number} a multiplier
 */
export function urgencyBoost(deadlineAt, now = new Date()) {
  if (deadlineAt === null) return URGENCY.noDeadline;

  const deadline = deadlineAt instanceof Date ? deadlineAt : new Date(deadlineAt);
  if (Number.isNaN(deadline.getTime())) return URGENCY.noDeadline;

  const days = (deadline.getTime() - now.getTime()) / 86_400_000;

  // Past the deadline: no boost. Expired records are excluded from search anyway, so
  // this is a guard rather than a ranking decision.
  if (days <= 0) return 0;

  if (days <= URGENCY.peakDays) {
    // Rising towards the peak. Something closing in hours is still useful to see, just
    // less so than something closing in a week, so this floors at 1.0 rather than 0.
    const ratio = days / URGENCY.peakDays;
    return 1 + (URGENCY.peak - 1) * ratio;
  }

  if (days >= URGENCY.neutralDays) return 1.0;

  // Decaying from the peak back to neutral.
  const ratio = (days - URGENCY.peakDays) / (URGENCY.neutralDays - URGENCY.peakDays);
  return URGENCY.peak - (URGENCY.peak - 1) * ratio;
}

/**
 * RRF's contribution from one retriever's rank.
 * @param {number} rank 1-based
 * @returns {number}
 */
export function rrfScore(rank) {
  return rank <= 0 ? 0 : 1 / (RRF_K + rank);
}

/**
 * Apply the diversity cap to an ordered list.
 *
 * Capped items are MOVED DOWN, not removed: the catalogue should not pretend an
 * organisation's fourth programme does not exist. §6.1 caps the first 20, so anything
 * displaced lands after them in its original relative order.
 *
 * @template T
 * @param {readonly T[]} items ordered best first
 * @param {(item: T) => { organisation: string | null, category: string | null }} keyOf
 *   where to read the organisation and category from
 * @returns {T[]}
 */
export function applyDiversity(items, keyOf) {
  /** @type {T[]} */
  const kept = [];
  /** @type {T[]} */
  const displaced = [];
  /** @type {Map<string, number>} */
  const perOrganisation = new Map();
  /** @type {Map<string, number>} */
  const perCategory = new Map();

  for (const item of items) {
    if (kept.length >= DIVERSITY.withinFirst) {
      // Past the capped window: everything else keeps its order.
      displaced.push(item);
      continue;
    }

    const { organisation, category } = keyOf(item);
    const orgCount = organisation ? (perOrganisation.get(organisation) ?? 0) : 0;
    const catCount = category ? (perCategory.get(category) ?? 0) : 0;

    if (orgCount >= DIVERSITY.maxPerOrganisation || catCount >= DIVERSITY.maxPerCategory) {
      displaced.push(item);
      continue;
    }

    if (organisation) perOrganisation.set(organisation, orgCount + 1);
    if (category) perCategory.set(category, catCount + 1);
    kept.push(item);
  }

  return [...kept, ...displaced];
}
