#!/usr/bin/env node
/**
 * Nightly recommendation precomputation. SYSTEM_ARCHITECTURE.md §8.
 *
 * "Stored in a `user_recommendations` table... Read is a single indexed query. ZERO
 * COMPUTE AT REQUEST TIME."
 *
 * That last sentence is the design. A per-request recommendation engine on a free tier is
 * a per-request eligibility evaluation plus a per-request vector search, and the byte and
 * latency budgets in PRODUCT_SPEC.md §25 leave no room for either. So the work happens
 * here, once, for everyone active.
 *
 * §8's steps 1–3 are the database's (recommendation_candidates, migration 0014); steps 4
 * and 5 — the weighted score and the diversity cap — are here, from the weights in
 * @mbele/config's ranking module. §6.1 `[TD]` requires those to live in one file, and this
 * is one of the two callers that keeps that true.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/recommend.mjs
 *   ... --user <uuid>    one user, for debugging
 *   ... --limit 100      how many active users to process
 *   ... --dry-run
 */

import pg from "pg";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const userIndex = args.indexOf("--user");
const ONE_USER = userIndex === -1 ? null : (args[userIndex + 1] ?? null);
const limitIndex = args.indexOf("--limit");
const USER_LIMIT = limitIndex === -1 ? 500 : Number(args[limitIndex + 1] ?? 500);

const CONN = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
if (!CONN) {
  console.error("Set DATABASE_URL for this command only (invariant 11).");
  process.exit(1);
}

// The weights come from the ONE file that holds them (§6.1 [TD]). It is .mjs precisely so
// this script and the web app can both read it — see the note at the top of that file.
import {
  RECOMMENDATIONS_STORED,
  RECOMMENDATION_WEIGHTS,
  VERIFICATION_QUALITY,
  applyDiversity,
  urgencyBoost,
} from "../packages/config/src/ranking.mjs";

const client = new pg.Client({
  connectionString: CONN,
  ssl: /supabase\.(co|com)/.test(CONN) ? { rejectUnauthorized: false } : false,
});

/**
 * §8 step 6: "Reasons: templated from matched rules + overlapping tag names."
 *
 * TEMPLATED, never generated. PRODUCT_SPEC.md §14.3 marks that `[PR]`: "Never
 * free-generated." A reason a model wrote is a reason nobody can check, and the whole
 * value of a reason is that the reader can.
 *
 * @param {Record<string, any>} candidate
 * @param {string | null} country
 */
function reasonsFor(candidate, country) {
  const reasons = [];

  if (candidate.verdict === "eligible" && country) {
    reasons.push(`${country} eligible`);
  } else if (candidate.verdict === "likely_eligible") {
    reasons.push("Likely eligible — one requirement we could not confirm");
  }

  const ruleTypes = new Set(candidate.matched_rule_types ?? []);
  if (ruleTypes.has("age_between")) reasons.push("within the age range");
  if (ruleTypes.has("student_status_in")) reasons.push("matches your student status");
  if (ruleTypes.has("nationality_in")) reasons.push("matches your nationality");
  if (ruleTypes.has("individual_only")) reasons.push("no team needed");
  if (ruleTypes.has("team_size_between") || ruleTypes.has("team_only")) reasons.push("team entry");

  const tags = (candidate.shared_tags ?? []).slice(0, 2);
  if (tags.length > 0) reasons.push(`${tags.join(" and ")} match your interests`);

  if (candidate.deadline_at) {
    const days = Math.max(
      0,
      Math.floor((new Date(candidate.deadline_at).getTime() - Date.now()) / 86_400_000),
    );
    reasons.push(days <= 1 ? "closes tomorrow" : `closes in ${days} days`);
  }

  return reasons.slice(0, 4);
}

await client.connect();
/** @type {Error | null} */
let failure = null;

try {
  const { rows: users } = ONE_USER
    ? await client.query(
        `SELECT id AS user_id,
                (SELECT p.embedding IS NOT NULL FROM profiles p WHERE p.user_id = users.id) AS has_embedding,
                (SELECT e.country_of_residence FROM eligibility_profiles e WHERE e.user_id = users.id) AS country
           FROM users WHERE id = $1`,
        [ONE_USER],
      )
    : await client.query("SELECT * FROM active_users_for_recommendations($1)", [USER_LIMIT]);

  if (users.length === 0) {
    console.log("No active user to compute recommendations for.");
    process.exit(0);
  }

  let stored = 0;
  let coldStart = 0;
  let empty = 0;
  let gateExcluded = 0;

  // How many published opportunities are even in §8's 60-day window. Reported against
  // what the eligibility gate admitted, because the difference is the number an operator
  // needs when recommendations look thin — and the usual cause is not the ranking but
  // §8 step 2: an opportunity whose rules we could not extract has verdict `unclear`, and
  // `unclear` is not recommended. That is the spec's choice (a recommendation says "this
  // is for you", so it has to be true), but it means extraction quality shows up here as
  // an empty surface rather than as an error.
  const { rows: windowCount } = await client.query(
    `SELECT count(*)::int AS n FROM opportunities
      WHERE status = 'published' AND deleted_at IS NULL AND duplicate_of IS NULL
        AND deadline_at IS NOT NULL AND deadline_at > now()
        AND deadline_at <= now() + interval '60 days'`,
  );

  for (const user of users) {
    const { rows: candidates } = await client.query(
      "SELECT * FROM recommendation_candidates($1,$2)",
      [user.user_id, 200],
    );

    if (candidates.length === 0) {
      // Not an error, and not something to paper over: §8 `[PR]` says the SURFACE must
      // never be empty, and your_window() handles that with the country board. An empty
      // recommendation SET is an honest outcome for a user whose country has nothing open.
      empty += 1;
      if (!DRY_RUN) await client.query("SELECT replace_user_recommendations($1,$2)", [user.user_id, "[]"]);
      continue;
    }

    if (!user.has_embedding) coldStart += 1;
    gateExcluded += Math.max(0, windowCount[0].n - candidates.length);

    const scored = candidates
      .map((candidate) => {
        const quality =
          (VERIFICATION_QUALITY[candidate.verification] ?? 0.5) * Number(candidate.source_trust ?? 0.5);

        // §8 step 4: 0.45·similarity + 0.35·urgency + 0.20·quality.
        //
        // urgencyBoost returns a multiplier centred on 1, so it is normalised to 0..1
        // here before being weighted — mixing a multiplier into a weighted sum would let
        // urgency dominate the whole score.
        const urgency = Math.min(1, Math.max(0, (urgencyBoost(candidate.deadline_at) - 0.5) / 0.8));

        return {
          opportunity_id: candidate.id,
          organisation: candidate.organisation_slug,
          category: candidate.category_code,
          score:
            RECOMMENDATION_WEIGHTS.similarity * Number(candidate.similarity ?? 0.5) +
            RECOMMENDATION_WEIGHTS.urgency * urgency +
            RECOMMENDATION_WEIGHTS.quality * quality,
          reasons: reasonsFor(candidate, user.country),
        };
      })
      .sort((a, b) => b.score - a.score);

    // §8 step 5: diversity cap, then top 20.
    const diverse = applyDiversity(scored, (row) => ({
      organisation: row.organisation,
      category: row.category,
    })).slice(0, RECOMMENDATIONS_STORED);

    const payload = diverse.map((row, index) => ({
      opportunity_id: row.opportunity_id,
      score: Number(row.score.toFixed(4)),
      rank: index + 1,
      reasons: row.reasons,
    }));

    if (DRY_RUN) {
      console.log(`\n  ${user.user_id}${user.has_embedding ? "" : " (cold start)"}`);
      for (const row of payload.slice(0, 5)) {
        console.log(`    ${row.rank}. score ${row.score} — ${row.reasons.join(" · ")}`);
      }
      continue;
    }

    const { rows: written } = await client.query("SELECT replace_user_recommendations($1,$2) AS n", [
      user.user_id,
      JSON.stringify(payload),
    ]);
    stored += written[0].n;
  }

  console.log("");
  console.log(
    `Recommendations: ${users.length} active user(s), ${stored} row(s) stored, ` +
      `${coldStart} without a profile embedding, ${empty} with nothing open to them.`,
  );
  console.log(
    `  ${windowCount[0].n} opportunit${windowCount[0].n === 1 ? "y" : "ies"} in the 60-day window; ` +
      `${gateExcluded} candidate slot(s) across all users were excluded by the eligibility gate ` +
      "or the country filter.",
  );
  if (windowCount[0].n > 0 && stored === 0) {
    console.log("");
    console.log("  Nothing was recommended to anyone. The usual cause is not ranking: §8 step 2");
    console.log("  admits only `eligible` and `likely_eligible`, and an opportunity whose rules");
    console.log("  could not be extracted is `unclear`. Check how many published records have any");
    console.log("  eligibility_rules at all before touching the weights.");
  }
  console.log("Read at request time is one indexed query. Zero compute (§8).");
  if (DRY_RUN) console.log("\n(dry run — nothing was written)");
} catch (/** @type {any} */ err) {
  failure = err instanceof Error ? err : new Error(String(err));
} finally {
  await client.end();
}

if (failure) {
  console.error(`\nRecommendation pass failed: ${failure.message}`);
  process.exit(1);
}
