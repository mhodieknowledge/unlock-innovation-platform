#!/usr/bin/env node
/**
 * The robots half of a source check. OPPORTUNITY_INGESTION.md §2.1 rule 1 and §7.
 *
 * §7 `[PR]`: "Each requires an individual robots/ToS check before activation — this
 * table is a research starting point, not an approval list."
 *
 * That check has two halves and they are not the same kind of thing:
 *
 *   * robots.txt is objective. It is fetched, parsed, recorded against the source,
 *     and reported here.
 *   * the terms of service is a judgement about someone else's legal document. This
 *     script will not make it, and will not activate a source whose tos_posture has
 *     not been set by a person. §2 puts the legal posture above coverage, and a
 *     coding agent guessing at a ToS is exactly the wrong way to honour that.
 *
 * So: this script records what it can verify, reports what it cannot, and activates
 * only when a person has already recorded the judgement it is not entitled to make.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/check-source.mjs                    check every inactive source
 *   DATABASE_URL=... node scripts/check-source.mjs --id <uuid>
 *   DATABASE_URL=... node scripts/check-source.mjs --activate <uuid>  after setting tos_posture
 */

import pg from "pg";

import { isAllowed } from "../packages/ingest/src/robots.mjs";
import { robotsFor } from "./lib/fetcher.mjs";

const args = process.argv.slice(2);
const idOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : (args[i + 1] ?? null);
};
const ONE = idOf("--id");
const ACTIVATE = idOf("--activate");

const CONN = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
if (!CONN) {
  console.error("Set DATABASE_URL for this command only (invariant 11).");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: CONN,
  ssl: /supabase\.(co|com)/.test(CONN) ? { rejectUnauthorized: false } : false,
});

/**
 * A ToS posture that permits what this source's kind needs.
 *
 * §2.1 rule 9: "Any source whose ToS restricts automated access is set
 * `tos_posture='restricts_automation'` and may be ingested ONLY via its RSS feed or
 * not at all." So a restricting source is still usable through a feed — the feed is
 * published for machines by definition — and is not usable by HTML fetch.
 *
 * @param {string | null} posture
 * @param {string} kind
 */
function posturePermits(posture, kind) {
  if (posture === null) return { ok: false, why: "tos_posture has not been recorded by anyone" };
  if (posture === "requires_permission") {
    return { ok: false, why: "the terms require permission, which has to be obtained and recorded first" };
  }
  if (posture === "restricts_automation") {
    return ["rss", "atom"].includes(kind)
      ? { ok: true, why: "the terms restrict automation, so only the feed is used (§2.1 rule 9)" }
      : { ok: false, why: `the terms restrict automation and "${kind}" is not a feed (§2.1 rule 9)` };
  }
  return { ok: true, why: `tos_posture is "${posture}"` };
}

await client.connect();
try {
  if (ACTIVATE) {
    const { rows } = await client.query("SELECT * FROM sources WHERE id = $1", [ACTIVATE]);
    const source = rows[0];
    if (!source) {
      console.error("No such source.");
      process.exit(1);
    }

    const posture = posturePermits(source.tos_posture, source.kind);
    if (!posture.ok) {
      console.error(`Refusing to activate "${source.name}": ${posture.why}.`);
      console.error("");
      console.error("Read the source's terms, decide, and record the decision:");
      console.error(
        `  UPDATE sources SET tos_posture = 'permits_feeds' | 'silent' | 'restricts_automation' | 'requires_permission' WHERE id = '${ACTIVATE}';`,
      );
      process.exit(1);
    }

    if (source.robots_allowed !== true || source.robots_checked_at === null) {
      console.error(`Refusing to activate "${source.name}": robots.txt has not been checked.`);
      console.error(`Run: node scripts/check-source.mjs --id ${ACTIVATE}`);
      process.exit(1);
    }

    await client.query("UPDATE sources SET is_active = true WHERE id = $1", [ACTIVATE]);
    console.log(`Activated "${source.name}".`);
    console.log(`  robots.txt: checked ${source.robots_checked_at.toISOString()}, allows our path`);
    console.log(`  terms: ${posture.why}`);
    console.log("");
    console.log("Its first five records will be reviewed regardless (§4.7).");
  } else {
    const { rows } = await client.query(
      `SELECT id, name, kind, url, tos_posture, robots_allowed, robots_checked_at, is_active
         FROM sources
        WHERE ($1::uuid IS NULL OR id = $1::uuid)
        ORDER BY is_active, name`,
      [ONE],
    );

    let allowed = 0;
    let disallowed = 0;
    let unreadable = 0;

    for (const source of rows) {
      let origin;
      try {
        origin = new URL(source.url).origin;
      } catch {
        console.log(`  ✗ ${source.name}: "${source.url}" is not a URL`);
        continue;
      }

      const robots = await robotsFor(origin);

      if (robots === null) {
        unreadable += 1;
        console.log(`  ? ${source.name}: robots.txt could not be read — treated as a refusal`);
        await client.query(
          "UPDATE sources SET robots_allowed = false, robots_checked_at = now() WHERE id = $1",
          [source.id],
        );
        continue;
      }

      const ok = isAllowed(robots, source.url);
      if (ok) allowed += 1;
      else disallowed += 1;

      await client.query(
        "UPDATE sources SET robots_allowed = $2, robots_checked_at = now() WHERE id = $1",
        [source.id, ok],
      );

      const posture = posturePermits(source.tos_posture, source.kind);
      console.log(
        `  ${ok ? "✓" : "✗"} ${source.name}: robots ${ok ? "allows" : "DISALLOWS"} ${source.url}`,
      );
      console.log(`      terms: ${posture.ok ? posture.why : `NOT CLEARED — ${posture.why}`}`);
      if (ok && posture.ok && !source.is_active) {
        console.log(`      ready to activate: node scripts/check-source.mjs --activate ${source.id}`);
      }
    }

    console.log("");
    console.log(
      `${rows.length} source(s) checked: ${allowed} allowed by robots, ${disallowed} disallowed, ${unreadable} unreadable.`,
    );
    console.log("");
    console.log("Nothing was activated. Activation needs a terms-of-service judgement, which is");
    console.log("a decision about someone else's legal document and not one this script makes.");
    console.log("§7 says it plainly: this registry is a research starting point, not an approval");
    console.log("list.");
  }
} catch (/** @type {any} */ err) {
  console.error(`\nSource check failed: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
