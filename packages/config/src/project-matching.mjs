/**
 * Project → opportunity match scoring. COLLABORATION_SYSTEM.md §1.5.
 *
 * TWO CALLERS, ONE FUNCTION, and that is the whole reason this file exists as `.mjs`:
 *
 *   - the request tier, for §1.2's `[PR]` synchronous first pass ("the user sees matched
 *     open calls within seconds of creating the project... This immediacy is the feature's
 *     hook"), and
 *   - scripts/match-projects.mjs, the nightly batch, which runs on plain Node with no
 *     build step.
 *
 * If they scored differently, a project's matches would change the moment the nightly run
 * touched it — the same list, reordered, with no explanation. So the weights, the
 * normalisation, the cap and the reason templates all live here, and both callers pass raw
 * signals in and get finished rows out.
 *
 * The signals come from Postgres (project_match_candidates in migration 0018). This is the
 * same division Phase 4 settled on for search: retrieval and gating in the database,
 * weighting in one TypeScript-readable module.
 */

import {
  PROJECT_MATCHES_STORED,
  PROJECT_MATCH_WEIGHTS,
  capPerOrganisation,
  tagOverlapScore,
  urgencyBoost,
} from "./ranking.mjs";

/**
 * @typedef {object} MatchCandidate
 * @property {string} id
 * @property {string} slug
 * @property {string} title
 * @property {number | string} similarity  cosine, or 0.5 when either side has no embedding
 * @property {number} shared_tag_count
 * @property {string[]} shared_tags
 * @property {string} verdict              'eligible' | 'likely_eligible'
 * @property {string | null} deadline_at
 * @property {boolean} is_rolling
 * @property {string | null} organisation_slug
 * @property {string | null} organisation_name
 * @property {string | null} category_name
 * @property {string | null} cost
 * @property {boolean | null} team_required
 */

/**
 * @typedef {object} ScoredMatch
 * @property {string} opportunity_id
 * @property {number} score
 * @property {number} rank
 * @property {string} verdict
 * @property {string[]} reasons
 */

/**
 * The urgency term, normalised to 0..1.
 *
 * urgencyBoost is a MULTIPLIER centred on 1 (it is used to scale a search score), so it
 * cannot go into a weighted sum unchanged — a term that ranges 0.5..1.3 would swamp two
 * terms that range 0..1. Mapped through the same window the recommendation scorer uses, so
 * "closes in a week" means the same thing on both surfaces.
 *
 * @param {string | null} deadlineAt
 * @param {boolean} isRolling
 */
function urgencyTerm(deadlineAt, isRolling) {
  // A rolling call has no deadline to be urgent about. Neutral rather than zero: it is not
  // less relevant, it just cannot compete on time pressure.
  if (!deadlineAt) return isRolling ? 0.4 : 0.3;
  return Math.min(1, Math.max(0, (urgencyBoost(deadlineAt) - 0.5) / 0.8));
}

/**
 * §1.5's displayed reasons: "AgriTech · AI · open to Zambia · closes in 12 days."
 *
 * TEMPLATED, never generated — PRODUCT_SPEC.md §14.3 `[PR]`. The value of a reason is that
 * the reader can check it, and a sentence a model wrote is a sentence nobody can check.
 *
 * @param {MatchCandidate} candidate
 * @param {number} nowMs
 * @returns {string[]}
 */
export function projectMatchReasons(candidate, nowMs = Date.now()) {
  const reasons = [];

  for (const tag of (candidate.shared_tags ?? []).slice(0, 2)) reasons.push(tag);

  if (candidate.verdict === "eligible") {
    reasons.push("you're eligible");
  } else if (candidate.verdict === "likely_eligible") {
    reasons.push("likely eligible — one requirement we couldn't confirm");
  }

  // The deadline comes BEFORE the extras, and that ordering is not cosmetic: the list is
  // truncated to four, and the first version of this function pushed "team entry" and
  // "free to enter" first — so the top match read "Agriculture · you're eligible · team
  // entry · free to enter" and the closing date, the most decision-relevant fact in the
  // whole product, was the one thing cut.
  if (candidate.deadline_at) {
    const days = Math.floor((new Date(candidate.deadline_at).getTime() - nowMs) / 86_400_000);
    if (days <= 0) reasons.push("closes today");
    else if (days === 1) reasons.push("closes tomorrow");
    else reasons.push(`closes in ${days} days`);
  } else if (candidate.is_rolling) {
    reasons.push("rolling — no deadline");
  }

  if (candidate.team_required === true) reasons.push("team entry");
  if (candidate.cost === "free") reasons.push("free to enter");

  return reasons.slice(0, 4);
}

/**
 * Score, cap and rank a project's candidates.
 *
 * @param {MatchCandidate[]} candidates
 * @param {{ now?: number, limit?: number }} [options]
 * @returns {ScoredMatch[]}
 */
export function scoreProjectMatches(candidates, options = {}) {
  const nowMs = options.now ?? Date.now();
  const limit = options.limit ?? PROJECT_MATCHES_STORED;

  const scored = candidates
    .map((candidate) => ({
      opportunity_id: candidate.id,
      organisation: candidate.organisation_slug ?? null,
      verdict: candidate.verdict,
      score:
        PROJECT_MATCH_WEIGHTS.similarity * Number(candidate.similarity ?? 0.5) +
        PROJECT_MATCH_WEIGHTS.urgency * urgencyTerm(candidate.deadline_at, candidate.is_rolling) +
        PROJECT_MATCH_WEIGHTS.tagOverlap * tagOverlapScore(Number(candidate.shared_tag_count ?? 0)),
      reasons: projectMatchReasons(candidate, nowMs),
    }))
    .sort((a, b) => b.score - a.score);

  // §1.5's cap is a hard one — see capPerOrganisation's note on why this differs from the
  // recommendation surface's displacement.
  return capPerOrganisation(scored, (row) => row.organisation)
    .slice(0, limit)
    .map((row, index) => ({
      opportunity_id: row.opportunity_id,
      score: Number(row.score.toFixed(4)),
      rank: index + 1,
      verdict: row.verdict,
      reasons: row.reasons,
    }));
}
