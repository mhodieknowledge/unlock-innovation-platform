#!/usr/bin/env node
/**
 * Nightly project → opportunity matching. COLLABORATION_SYSTEM.md §1.5.
 *
 * "Nightly, plus on edit." The on-edit half runs in the request tier, so that a user sees
 * matches within seconds of creating a project (§1.2 `[PR]`); this is the half that keeps
 * them true afterwards, as opportunities open, close and get re-verified.
 *
 * It matches EVERY live project regardless of visibility, because §1.1 `[PR]` says a
 * private project still receives matches and that is the point of the feature. A filter on
 * visibility here would quietly turn projects into a social feature that only works once
 * other people show up.
 *
 * The scoring is not in this file. It is in packages/config/src/project-matching.mjs,
 * shared verbatim with the request tier — see the note at the top of that file for why.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/match-projects.mjs
 *   ... --project <uuid>   one project
 *   ... --limit 500        how many projects to process
 *   ... --sweep            §1.3's inactivity handling instead of matching
 *   ... --dry-run
 */

import pg from "pg";

import { scoreProjectMatches } from "../packages/config/src/project-matching.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SWEEP = args.includes("--sweep");
const projectIndex = args.indexOf("--project");
const ONE_PROJECT = projectIndex === -1 ? null : (args[projectIndex + 1] ?? null);
const limitIndex = args.indexOf("--limit");
const PROJECT_LIMIT = limitIndex === -1 ? 500 : Number(args[limitIndex + 1] ?? 500);

const CONN = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
if (!CONN) {
  console.error("Set DATABASE_URL for this command only (invariant 11).");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: CONN,
  ssl: /supabase\.(co|com)/.test(CONN) ? { rejectUnauthorized: false } : false,
});

await client.connect();
/** @type {Error | null} */
let failure = null;

try {
  if (SWEEP) {
    // §1.3: prompt at 120 days, auto-pause at 180, NEVER auto-delete. The rule lives in
    // the database function; this is the scheduler calling it.
    if (DRY_RUN) {
      const { rows } = await client.query(
        `SELECT count(*) FILTER (WHERE last_activity_at < now() - interval '120 days'
                                   AND last_activity_at >= now() - interval '180 days'
                                   AND inactivity_prompted_at IS NULL)::int AS to_prompt,
                count(*) FILTER (WHERE last_activity_at < now() - interval '180 days')::int AS to_pause
           FROM projects
          WHERE deleted_at IS NULL AND state NOT IN ('paused','archived','completed','launched')`,
      );
      console.log(
        `Inactivity sweep (dry run): ${rows[0].to_prompt} would be prompted, ${rows[0].to_pause} would be paused, 0 would be deleted.`,
      );
    } else {
      const { rows } = await client.query("SELECT project_inactivity_sweep() AS report");
      console.log("Inactivity sweep (COLLABORATION_SYSTEM.md §1.3):");
      for (const [k, v] of Object.entries(rows[0].report)) console.log(`  ${k}: ${v}`);
    }
    await client.end();
    process.exit(0);
  }

  const { rows: projects } = ONE_PROJECT
    ? await client.query(
        `SELECT id, title, owner_user_id, embedding IS NOT NULL AS has_embedding
           FROM projects WHERE id = $1 AND deleted_at IS NULL`,
        [ONE_PROJECT],
      )
    : await client.query(
        // Archived projects are done; everything else — including paused ones — keeps
        // getting matches, per §1.3: "A paused project is hidden from public browse but
        // keeps receiving matches for its owner."
        `SELECT id, title, owner_user_id, embedding IS NOT NULL AS has_embedding
           FROM projects
          WHERE deleted_at IS NULL
            AND state <> 'archived'
          ORDER BY coalesce(matched_at, to_timestamp(0)) ASC
          LIMIT $1`,
        [PROJECT_LIMIT],
      );

  if (projects.length === 0) {
    console.log("No project to match.");
    process.exit(0);
  }

  let matched = 0;
  let empty = 0;
  let coldStart = 0;
  let written = 0;

  for (const project of projects) {
    const { rows: candidates } = await client.query(
      "SELECT * FROM project_match_candidates($1,$2)",
      [project.id, 200],
    );

    if (!project.has_embedding) coldStart += 1;

    if (candidates.length === 0) {
      // An honest outcome, not a failure: the owner may be eligible for nothing currently
      // open, or their eligibility profile may be too thin for any verdict to be better
      // than `unclear`. The page says which.
      empty += 1;
      if (!DRY_RUN) await client.query("SELECT replace_project_matches($1,$2)", [project.id, "[]"]);
      continue;
    }

    const rows = scoreProjectMatches(candidates);

    if (DRY_RUN) {
      console.log(`\n  ${project.title}${project.has_embedding ? "" : " (no embedding yet)"}`);
      for (const row of rows.slice(0, 5)) {
        console.log(`    ${row.rank}. ${row.score} — ${row.reasons.join(" · ")}`);
      }
      matched += 1;
      continue;
    }

    const { rows: result } = await client.query(
      "SELECT replace_project_matches($1,$2) AS n",
      [project.id, JSON.stringify(rows)],
    );
    written += result[0].n;
    matched += 1;
  }

  console.log(
    `\n${matched} project(s) matched, ${written} match rows written, ${empty} with nothing open they can enter, ${coldStart} without an embedding yet.`,
  );
  if (coldStart > 0) {
    // Not an error. Worth saying, because it changes what the numbers mean: without an
    // embedding the similarity term is a constant and the ranking is urgency plus tags.
    console.log("Run `npm run embed` to give those projects a vector.");
  }
} catch (err) {
  failure = err instanceof Error ? err : new Error(String(err));
} finally {
  await client.end();
}

if (failure) {
  console.error(`\nFailed: ${failure.message}`);
  process.exit(1);
}
