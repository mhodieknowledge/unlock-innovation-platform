#!/usr/bin/env node
/**
 * Duplicate resolution. AI_SYSTEM.md §9, steps 1, 4 and 5.
 *
 * WHY THIS FILE EXISTS. The live board carried the same opportunity two and three times —
 * "AI Builders Hackathon" twice, "Gates Cambridge Scholarship" twice, the AfricaLics PhD
 * Visiting Fellowship three times. §9 defines five steps to stop that. The schema had all of
 * it: `dedupe_candidates` has held `model_verdict`, `model_reason` and a `state` since
 * migration 0013, and `merge_opportunities` has been complete and order-independent the whole
 * time. What was missing was anything that CALLED them.
 *
 *   1. canonical URL match → certain duplicate, auto-merge     recorded, never merged — here
 *   2. trigram title ≥ 0.62, same organisation, ±3 days        already in the database
 *   3. embedding cosine ≥ 0.90, deadline within ±7 days        migration 0036
 *   4. only survivors of 2 or 3 go to the model                here
 *   5. `same` at confidence ≥ 0.85 → auto-merge                here
 *
 * The order is what keeps it honest and cheap. Nothing is asked of a model until two
 * deterministic checks have already agreed a pair is worth asking about, and the model is
 * asked ONE question with three permitted answers, of which two mean "do not merge".
 *
 * WHAT IT WILL NOT DO. It never merges on a model's `unsure`, never on `different`, and never
 * on a `same` below 0.85 — those stay `open` for a person, which is the outcome §9 asks for
 * and the cheap kind of mistake. A wrong merge is the expensive kind: it sets `status =
 * 'merged'` on a record someone could have applied for, and while the URL still answers 410
 * with `merged_into` rather than vanishing, nobody browsing the board will ever see it again.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/dedupe.mjs [--limit n] [--dry-run] [--no-ai]
 */

import pg from "pg";

import { Breakers, runTask } from "../packages/ingest/src/index.mjs";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const NO_AI = args.includes("--no-ai");
const limitIndex = args.indexOf("--limit");
const LIMIT = limitIndex === -1 ? 60 : Number(args[limitIndex + 1] ?? 60);

/** §9 step 5's threshold, written once. */
const AUTO_MERGE_CONFIDENCE = 0.85;

const CONN = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
if (!CONN) {
  console.error("Set DATABASE_URL for this command only (invariant 11).");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: CONN,
  ssl: /supabase\.(co|com)/.test(CONN) ? { rejectUnauthorized: false } : false,
});
const breakers = new Breakers();
const env = process.env;

/** The `## System` section of a prompt file. Identical rule to scripts/ingest.mjs. */
function prompt(name) {
  const text = readFileSync(join(ROOT, "prompts", `${name}.md`), "utf8");
  const match = /##\s*System\s*\n([\s\S]*?)(?=\n##\s|\s*$)/.exec(text);
  if (!match || !match[1]) throw new Error(`prompts/${name}.md has no "## System" section`);
  return { version: name, system: match[1].trim() };
}

/** @param {any[]} calls @param {string} task @param {string} promptVersion */
async function logCalls(calls, task, promptVersion) {
  for (const call of calls) {
    if (DRY_RUN) continue;
    await client.query(
      `INSERT INTO ai_usage (provider, task, model, prompt_version, tokens_in, tokens_out,
                             latency_ms, outcome, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [call.provider, task, call.model, promptVersion, call.tokens_in, call.tokens_out,
       call.latency_ms, call.outcome, call.detail ?? null],
    );
  }
}

/**
 * Is this record still its own record?
 *
 * A three-way duplicate produces three pairs — (A,B), (A,C), (B,C) — and merging the first
 * one changes the answer to the third. The queries below select their pairs once, so without
 * this a loop would merge C into B after B had already been merged into A, leaving a record
 * whose `duplicate_of` points at something that is itself a duplicate: a 410 that leads to a
 * 410. merge_opportunities cannot refuse that on its own, because from inside one call the
 * pair looks fine.
 *
 * @param {string} id
 */
async function stillLive(id) {
  const { rows } = await client.query(
    `SELECT 1 FROM opportunities
      WHERE id = $1 AND deleted_at IS NULL AND duplicate_of IS NULL AND status <> 'merged'`,
    [id],
  );
  return rows.length > 0;
}

/**
 * Step 3's sweep: run the deterministic checks over the catalogue, not just over records as
 * they arrive.
 *
 * Writing a record and then asking for its duplicates is the right thing to do at ingest time
 * and it cannot find an embedding match, because embeddings are computed later by the daily
 * local-model job. A record written on Monday is only comparable by embedding on Tuesday. So
 * the pairs have to be looked for again, here, after `npm run embed` has run.
 *
 * @returns {Promise<number>} candidate pairs recorded
 */
async function findCandidates() {
  const { rows } = await client.query(
    `SELECT id, title FROM opportunities
      WHERE deleted_at IS NULL
        AND duplicate_of IS NULL
        AND status IN ('published','in_review')
      ORDER BY created_at DESC
      LIMIT $1`,
    [LIMIT * 10],
  );
  console.log(`Checking ${rows.length} live record(s) for duplicate candidates.`);

  let recorded = 0;
  for (const row of rows) {
    const { rows: candidates } = await client.query("SELECT * FROM dedupe_candidates_for($1)", [
      row.id,
    ]);
    for (const dupe of candidates) {
      if (DRY_RUN) {
        recorded += 1;
        continue;
      }
      const { rows: written } = await client.query(
        "SELECT record_dedupe_candidate($1,$2,$3,$4) AS id",
        [row.id, dupe.candidate_id, dupe.method, dupe.similarity],
      );
      if (written[0]?.id) recorded += 1;
    }
  }
  console.log(`${recorded} candidate pair(s) recorded or refreshed.\n`);
  return recorded;
}

/**
 * §9 step 1: a canonical URL match is CERTAIN, so it does not wait for a model or a person.
 *
 * "Certain" is doing real work here. The two records share a source_url or an official_url,
 * which means one page. There is no interpretation left to make, and a pair sitting in a
 * review queue for a week is a duplicate on the board for a week.
 *
 * @returns {Promise<number>} merges performed
 */
async function mergeCertainPairs() {
  const { rows } = await client.query(
    `SELECT c.id, c.left_id, c.right_id, l.title AS left_title, r.title AS right_title
       FROM dedupe_candidates c
       JOIN opportunities l ON l.id = c.left_id
       JOIN opportunities r ON r.id = c.right_id
      WHERE c.state = 'open'
        AND c.method = 'canonical_url'
        AND l.deleted_at IS NULL AND r.deleted_at IS NULL
        AND l.duplicate_of IS NULL AND r.duplicate_of IS NULL
      ORDER BY c.created_at`,
  );
  if (rows.length === 0) return 0;

  console.log(`${rows.length} pair(s) share a URL — certain duplicates (§9 step 1).`);
  let merged = 0;
  for (const pair of rows) {
    if (!DRY_RUN && !(await stillLive(pair.left_id) && await stillLive(pair.right_id))) {
      console.log(`  skipped ${String(pair.left_title).slice(0, 56)} — already merged`);
      continue;
    }
    // merge_opportunities decides which side survives, by verification rank, whatever order
    // it is given — so passing left first is not a choice about which record wins.
    if (!DRY_RUN) {
      const { rows: result } = await client.query("SELECT merge_opportunities($1,$2) AS kept", [
        pair.left_id,
        pair.right_id,
      ]);
      if (!result[0]?.kept) {
        console.warn(`  ! ${String(pair.left_title).slice(0, 48)}: merge returned nothing`);
        continue;
      }
    }
    merged += 1;
    console.log(`  merged  ${String(pair.left_title).slice(0, 60)}`);
  }
  console.log(`${merged} merged on a URL match.\n`);
  return merged;
}

/** One side of a pair, as the model is shown it. */
function describe(row, label) {
  return [
    `${label}:`,
    `  title: ${row.title}`,
    `  organisation: ${row.organisation_name ?? "unknown"}`,
    `  deadline: ${row.deadline_at ? new Date(row.deadline_at).toISOString().slice(0, 10) : "unknown"}`,
    `  url: ${row.official_url ?? row.source_url ?? "unknown"}`,
    `  summary: ${row.summary ?? "none"}`,
  ].join("\n");
}

/**
 * §9 steps 4 and 5: the model sees only what survived a deterministic check.
 *
 * @returns {Promise<{ merged: number, kept: number }>}
 */
async function adjudicate() {
  const { rows } = await client.query(
    `SELECT c.id, c.method, c.score,
            l.id AS l_id, l.title AS l_title, l.summary AS l_summary,
            l.deadline_at AS l_deadline, l.source_url AS l_source_url,
            l.official_url AS l_official_url, lo.name AS l_organisation_name,
            r.id AS r_id, r.title AS r_title, r.summary AS r_summary,
            r.deadline_at AS r_deadline, r.source_url AS r_source_url,
            r.official_url AS r_official_url, ro.name AS r_organisation_name
       FROM dedupe_candidates c
       JOIN opportunities l ON l.id = c.left_id
       JOIN opportunities r ON r.id = c.right_id
       LEFT JOIN organisations lo ON lo.id = l.organisation_id
       LEFT JOIN organisations ro ON ro.id = r.organisation_id
      WHERE c.state = 'open'
        AND c.method IN ('trigram_title','embedding')
        AND c.model_verdict IS NULL
        AND l.deleted_at IS NULL AND r.deleted_at IS NULL
        AND l.duplicate_of IS NULL AND r.duplicate_of IS NULL
      ORDER BY c.score DESC NULLS LAST
      LIMIT $1`,
    [LIMIT],
  );

  if (rows.length === 0) {
    console.log("No pair is waiting on a verdict.");
    return { merged: 0, kept: 0 };
  }
  console.log(`${rows.length} pair(s) for the model (§9 step 4).\n`);

  if (NO_AI) {
    // §13's fallback, stated exactly: "steps 1-3 only; everything ambiguous queues." The pairs
    // stay open and a person resolves them, which is what the queue is for.
    console.log("NO_AI mode: every pair stays open for review. That is §9's stated fallback.");
    for (const pair of rows.slice(0, 20)) {
      console.log(`  · ${String(pair.l_title).slice(0, 40)} ≈ ${String(pair.r_title).slice(0, 40)}`);
    }
    return { merged: 0, kept: rows.length };
  }

  const { rows: chain } = await client.query("SELECT * FROM ai_chain_for($1,$2)", ["dedupe", true]);
  if (chain.length === 0) {
    console.log("No provider configured for `dedupe`. Every pair stays open for review.");
    return { merged: 0, kept: rows.length };
  }

  const p = prompt("dedupe.v1");
  let merged = 0;
  let kept = 0;

  for (const pair of rows) {
    const left = {
      title: pair.l_title, summary: pair.l_summary, deadline_at: pair.l_deadline,
      source_url: pair.l_source_url, official_url: pair.l_official_url,
      organisation_name: pair.l_organisation_name,
    };
    const right = {
      title: pair.r_title, summary: pair.r_summary, deadline_at: pair.r_deadline,
      source_url: pair.r_source_url, official_url: pair.r_official_url,
      organisation_name: pair.r_organisation_name,
    };

    const result = await runTask({
      chain,
      system: p.system,
      user: [describe(left, "RECORD A"), "", describe(right, "RECORD B")].join("\n"),
      env,
      fetch: globalThis.fetch,
      breakers,
      accept: (data) => typeof data === "object" && data !== null && "verdict" in data,
      shapeHint: 'an object with "verdict", "confidence" and "reason"',
    });
    await logCalls(result.calls, "dedupe", p.version);

    const answer = result.ok ? /** @type {any} */ (result.data) : null;
    const verdict = typeof answer?.verdict === "string" ? answer.verdict.trim() : "";
    const confidence = typeof answer?.confidence === "number" ? answer.confidence : 0;
    const reason = typeof answer?.reason === "string" ? answer.reason.slice(0, 500) : null;

    // Anything that is not one of the three permitted answers is treated as `unsure`: the
    // pair stays open. A verdict the prompt did not authorise is not a verdict.
    const known = ["same", "different", "unsure"].includes(verdict);
    if (!known && verdict) {
      console.warn(`  ! model answered "${verdict}", which is not one of same/different/unsure`);
    }

    if (!DRY_RUN) {
      await client.query(
        `UPDATE dedupe_candidates
            SET model_verdict = $2, model_reason = $3
          WHERE id = $1`,
        [pair.id, known ? verdict : "unsure", reason],
      );
    }

    const label = `${String(pair.l_title).slice(0, 36)} ≈ ${String(pair.r_title).slice(0, 36)}`;

    if (known && verdict === "same" && confidence >= AUTO_MERGE_CONFIDENCE) {
      if (!DRY_RUN && !(await stillLive(pair.l_id) && await stillLive(pair.r_id))) {
        console.log(`  skipped ${label} — already merged`);
        continue;
      }
      if (!DRY_RUN) {
        await client.query("SELECT merge_opportunities($1,$2)", [pair.l_id, pair.r_id]);
      }
      merged += 1;
      console.log(`  merged  ${label}  (${confidence.toFixed(2)})`);
      continue;
    }

    // `different` closes the pair so it is not asked again every night. Everything else stays
    // open, because "unsure" is a request for a person and not a conclusion.
    if (known && verdict === "different" && !DRY_RUN) {
      await client.query(
        "UPDATE dedupe_candidates SET state = 'distinct', resolved_at = now() WHERE id = $1",
        [pair.id],
      );
    }
    kept += 1;
    const why = known ? verdict : "no usable answer";
    console.log(`  ${why.padEnd(10)} ${label}${confidence ? `  (${confidence.toFixed(2)})` : ""}`);
  }

  console.log(`\n${merged} merged by the model, ${kept} left for a person or closed as distinct.`);
  return { merged, kept };
}

await client.connect();
/** @type {Error | null} */
let failure = null;

try {
  await findCandidates();
  const certain = await mergeCertainPairs();
  const { merged } = await adjudicate();
  console.log(`\n${certain + merged} duplicate(s) merged in total.`);
  if (DRY_RUN) console.log("(dry run — nothing was written)");
} catch (error) {
  failure = /** @type {Error} */ (error);
} finally {
  await client.end();
}

if (failure) {
  console.error(failure);
  process.exit(1);
}
