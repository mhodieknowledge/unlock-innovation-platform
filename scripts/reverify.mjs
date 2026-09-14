#!/usr/bin/env node
/**
 * Freshness. OPPORTUNITY_INGESTION.md §5 — "the promise".
 *
 * Four jobs, each independently runnable:
 *
 *   links      §5.2  HEAD the apply and official URLs of published records
 *   reverify   §5.3  re-fetch, re-extract, diff, notify trackers of real changes
 *   sweep      §5.4  staleness, expiry, closure, and the cadence recomputation
 *   health     §3    alert the operator when sources are quietly dying
 *
 * The reason this is separate from ingest.mjs: ingestion adds, freshness corrects,
 * and the product's central claim is the second one. IMPLEMENTATION_PLAN.md §5 calls
 * Phase 3 "where the product's promise becomes structural rather than manual", and
 * NOTIFICATIONS.md §11 puts "deadline reminders sent before an expiry >= 95%" among
 * the two metrics that matter. A stale catalogue fails that quietly.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/reverify.mjs links
 *   DATABASE_URL=... node scripts/reverify.mjs reverify [--limit 20]
 *   DATABASE_URL=... node scripts/reverify.mjs sweep
 *   DATABASE_URL=... node scripts/reverify.mjs health
 *   ... --dry-run
 */

import pg from "pg";

import {
  canonicaliseUrl,
  contentHash,
  extractJsonLd,
  htmlToText,
  recordFromJsonLd,
  sameHost,
  truncateForStorage,
} from "../packages/ingest/src/index.mjs";
import { politeFetch, robotsFor } from "./lib/fetcher.mjs";

const MODES = ["links", "reverify", "sweep", "health"];
const mode = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg === -1 ? 40 : Number(process.argv[limitArg + 1] ?? 40);

if (!MODES.includes(mode ?? "")) {
  console.error(`Usage: node scripts/reverify.mjs <${MODES.join("|")}> [--limit n] [--dry-run]`);
  process.exit(1);
}

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
 * A link check. §5.2: "HEAD (falling back to a ranged GET)".
 *
 * The fallback matters more than it sounds: a surprising number of sites answer 405
 * or 403 to HEAD while serving the page perfectly to a GET, and treating that as a
 * dead link would close live opportunities.
 *
 * @param {string} url
 * @returns {Promise<{ state: "ok" | "moved" | "dead" | "transient", detail: string, finalUrl?: string }>}
 */
async function checkLink(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { state: "dead", detail: "not a URL" };
  }

  const robots = await robotsFor(parsed.origin);
  if (robots === null) {
    // We cannot even ask whether we may look. Not the link's fault, and not a
    // reason to close an opportunity.
    return { state: "transient", detail: "robots.txt unreadable" };
  }

  for (const method of ["HEAD", "GET"]) {
    let response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      response = await fetch(url, {
        method,
        redirect: "manual",
        headers: {
          "user-agent": (await import("../packages/config/src/brand.mjs")).CRAWLER_USER_AGENT,
          // A ranged GET reads the first byte and stops: enough to know the page is
          // there without spending the publisher's bandwidth on the whole document.
          ...(method === "GET" ? { range: "bytes=0-0" } : {}),
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
    } catch (/** @type {any} */ err) {
      // §5.2: "5xx/timeout -> no state change (transient), counted separately."
      return { state: "transient", detail: String(err?.message ?? err).slice(0, 200) };
    }

    if (response.status === 405 || response.status === 501) continue; // try GET

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const target = location ? canonicaliseUrl(location, url) : null;
      if (target && !sameHost(target, url)) {
        // §5.2: a redirect to a different host is flagged. A programme that moved
        // and a domain that was sold look identical from here, and the second is a
        // known scam vector.
        return { state: "moved", detail: `redirects to ${target}`, finalUrl: target };
      }
      return { state: "ok", detail: `${response.status} within the same host` };
    }

    if (response.status === 404 || response.status === 410) {
      return { state: "dead", detail: `HTTP ${response.status}` };
    }
    if (response.status >= 500) {
      return { state: "transient", detail: `HTTP ${response.status}` };
    }
    if (response.status === 403 || response.status === 401) {
      // Not dead — we are being refused. §2.1 rule 2 forbids working around that.
      return { state: "transient", detail: `HTTP ${response.status} (refused, not missing)` };
    }
    if (response.ok || response.status === 206) {
      return { state: "ok", detail: `HTTP ${response.status}` };
    }
    return { state: "transient", detail: `HTTP ${response.status}` };
  }

  return { state: "transient", detail: "neither HEAD nor GET answered usefully" };
}

async function runLinks() {
  const { rows } = await client.query(
    `SELECT id, slug, apply_url, official_url, source_url, link_ok, link_checked_at, verification::text
       FROM opportunities
      WHERE status = 'published'
        AND deleted_at IS NULL
        AND (link_checked_at IS NULL OR link_checked_at < now() - interval '6 hours')
      ORDER BY link_checked_at NULLS FIRST
      LIMIT $1`,
    [LIMIT],
  );

  let ok = 0;
  let dead = 0;
  let moved = 0;
  let transient = 0;

  for (const row of rows) {
    // The apply URL is the one that costs a user their time, so it is checked first
    // and its result decides.
    const target = row.apply_url ?? row.official_url ?? row.source_url;
    if (!target) continue;

    const result = await checkLink(target);
    console.log(`  ${row.slug}: ${result.state} — ${result.detail}`);
    if (dryRun) continue;

    if (result.state === "ok") {
      ok += 1;
      await client.query(
        "UPDATE opportunities SET link_ok = true, link_checked_at = now() WHERE id = $1",
        [row.id],
      );
    } else if (result.state === "dead") {
      dead += 1;
      // §5.4: two consecutive failures close it. The first failure only records
      // itself — one 404 is often a site reorganising mid-deploy.
      const secondStrike = row.link_ok === false;
      await client.query(
        `UPDATE opportunities
            SET link_ok = false,
                link_checked_at = now(),
                verification = CASE WHEN $2 THEN 'community_flagged'::opp_verification ELSE verification END
          WHERE id = $1`,
        [row.id, secondStrike],
      );
      if (secondStrike) {
        await client.query(
          `INSERT INTO review_queue (queue, subject_type, subject_id, priority)
           VALUES ('low_confidence','opportunity',$1,2)`,
          [row.id],
        );
      }
    } else if (result.state === "moved") {
      moved += 1;
      await client.query(
        `UPDATE opportunities SET link_checked_at = now(), verification = 'community_flagged'
          WHERE id = $1`,
        [row.id],
      );
      await client.query(
        `INSERT INTO review_queue (queue, subject_type, subject_id, priority)
         VALUES ('report_scam','opportunity',$1,1)`,
        [row.id],
      );
    } else {
      transient += 1;
      // Deliberately no state change, but the check is timestamped so the next run
      // does not hammer the same failing host.
      await client.query("UPDATE opportunities SET link_checked_at = now() WHERE id = $1", [row.id]);
    }
  }

  console.log("");
  console.log(
    `Link health: ${rows.length} checked — ${ok} fine, ${dead} missing, ${moved} moved host, ${transient} transient.`,
  );
  if (moved > 0) {
    console.log("A redirect to a different host is queued at priority 1: a sold domain looks");
    console.log("exactly like a moved programme from the outside.");
  }
}

/**
 * §5.3 change detection. "On re-verification the source is re-fetched and
 * re-extracted. Differences write opportunity_changes."
 *
 * Only fields the publisher's own structured data supplies are compared here. That is
 * a deliberate limit: a diff computed from a model's re-extraction would fire on the
 * model's variance rather than on the publisher's change, and every tracker would be
 * notified about nothing. JSON-LD is publisher-authored and stable, so a difference
 * in it is a real difference.
 */
async function runReverify() {
  const { rows } = await client.query("SELECT * FROM due_for_verification($1)", [LIMIT]);
  let checked = 0;
  let changed = 0;
  let unreachable = 0;

  for (const row of rows) {
    const url = row.source_url ?? row.official_url;
    if (!url) continue;

    const fetched = await politeFetch(url);
    if (fetched.status === "not_modified") {
      checked += 1;
      if (!dryRun) {
        await client.query(
          `UPDATE opportunities
              SET last_verified_at = now(),
                  next_verify_at = now() + next_verify_interval(deadline_at, is_rolling)
            WHERE id = $1`,
          [row.id],
        );
      }
      continue;
    }
    if (fetched.status !== "ok" || !fetched.body) {
      unreachable += 1;
      console.log(`  ${row.slug}: could not re-fetch — ${fetched.error ?? fetched.status}`);
      continue;
    }

    checked += 1;
    const { text } = htmlToText(fetched.body);
    const stored = truncateForStorage(text);
    const hash = await contentHash(stored);

    const { rows: previous } = await client.query(
      `SELECT content_hash FROM raw_documents
        WHERE canonical_url = $1 ORDER BY fetched_at DESC LIMIT 1`,
      [canonicaliseUrl(url) ?? url],
    );

    if (previous[0]?.content_hash === hash) {
      // §4.3: unchanged hash -> stop. This is the common case and the cheap one.
      if (!dryRun) {
        await client.query(
          `UPDATE opportunities
              SET last_verified_at = now(),
                  next_verify_at = now() + next_verify_interval(deadline_at, is_rolling)
            WHERE id = $1`,
          [row.id],
        );
      }
      continue;
    }

    const fromJsonLd = recordFromJsonLd(extractJsonLd(fetched.body), url);
    const { rows: current } = await client.query(
      `SELECT deadline_at, deadline_precision::text, cost::text, apply_url,
              eligibility_scope::text, eligible_countries
         FROM opportunities WHERE id = $1`,
      [row.id],
    );
    const now = current[0];

    /** @type {Array<[string, unknown, unknown]>} */
    const diffs = [];
    if (fromJsonLd?.record["deadline_at"] && now) {
      const before = now.deadline_at ? new Date(now.deadline_at).toISOString() : null;
      const after = String(fromJsonLd.record["deadline_at"]);
      if (before !== after) diffs.push(["deadline_at", before, after]);
    }
    if (fromJsonLd?.record["cost"] && now && fromJsonLd.record["cost"] !== now.cost) {
      diffs.push(["cost", now.cost, fromJsonLd.record["cost"]]);
    }

    for (const [field, before, after] of diffs) {
      changed += 1;
      console.log(`  ${row.slug}: ${field} ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      if (dryRun) continue;

      // One notification per tracker per change, enforced in the database.
      await client.query("SELECT record_opportunity_change($1,$2,$3,$4,'reverify')", [
        row.id,
        field,
        JSON.stringify(before),
        JSON.stringify(after),
      ]);

      // Invariant 13: a source that started charging a fee cannot stay published.
      if (field === "cost" && after === "paid") {
        await client.query(
          `UPDATE opportunities SET status = 'in_review', cost = 'paid' WHERE id = $1`,
          [row.id],
        );
        await client.query(
          `INSERT INTO review_queue (queue, subject_type, subject_id, priority)
           VALUES ('paid_cost','opportunity',$1,1)`,
          [row.id],
        );
      } else if (field === "deadline_at") {
        await client.query("UPDATE opportunities SET deadline_at = $2 WHERE id = $1", [row.id, after]);
      }
    }

    if (!dryRun) {
      await client.query(
        `INSERT INTO raw_documents (source_id, url, canonical_url, content_hash, text_raw, jsonld)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          row.source_id,
          url,
          canonicaliseUrl(url) ?? url,
          hash,
          stored,
          JSON.stringify(extractJsonLd(fetched.body)),
        ],
      );
      await client.query(
        `UPDATE opportunities
            SET last_verified_at = now(),
                next_verify_at = now() + next_verify_interval(deadline_at, is_rolling)
          WHERE id = $1`,
        [row.id],
      );
    }
  }

  console.log("");
  console.log(
    `Re-verification: ${checked} re-checked, ${changed} field change(s) recorded, ${unreachable} unreachable.`,
  );
}

async function runSweep() {
  if (dryRun) {
    const { rows } = await client.query(
      `SELECT count(*) FILTER (WHERE next_verify_at < now() - interval '7 days') AS would_stale,
              count(*) FILTER (WHERE deadline_at < now() - interval '1 day') AS would_expire
         FROM opportunities WHERE status = 'published' AND deleted_at IS NULL`,
    );
    console.log(`Would mark stale: ${rows[0].would_stale}, would expire: ${rows[0].would_expire}`);
    return;
  }

  const { rows: sweep } = await client.query("SELECT apply_staleness_and_expiry() AS report");
  const { rows: cadence } = await client.query("SELECT apply_verification_cadence() AS n");

  console.log("Sweep (OPPORTUNITY_INGESTION.md §5.4):");
  for (const [key, value] of Object.entries(sweep[0].report)) {
    console.log(`  ${key}: ${value}`);
  }
  console.log(`  cadence recomputed for ${cadence[0].n} record(s)`);
  console.log("");
  console.log("Expired records keep their URL, their expired banner and their place on the");
  console.log("organisation page. §5.4 marks that [PR]: it keeps inbound links honest and is");
  console.log("the historical record that later makes \"this runs annually\" possible.");
}

async function runHealth() {
  const { rows: degraded } = await client.query("SELECT * FROM degraded_sources()");
  if (degraded.length === 0) {
    console.log("Every active source is answering.");
  } else {
    console.log(`${degraded.length} degraded source(s):`);
    for (const source of degraded) {
      console.log(
        `  ${source.name}: ${source.consecutive_failures} consecutive failures, last success ${source.last_success_at ?? "never"}`,
      );
    }
  }

  const { rows: alert } = await client.query("SELECT source_health_alert_due() AS msg");
  if (!alert[0].msg) return;

  console.log("");
  console.log(`OPERATOR ALERT: ${alert[0].msg}`);

  if (dryRun) return;
  const { rowCount } = await client.query(
    `INSERT INTO operator_alerts (kind, detail) VALUES ('source_health', $1)
     ON CONFLICT (kind, day) DO NOTHING`,
    [alert[0].msg],
  );
  if ((rowCount ?? 0) === 0) {
    console.log("(already alerted today)");
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.OPERATOR_TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.log("(no operator Telegram configured, so this alert is log-only)");
    return;
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: `Source health\n\n${alert[0].msg}` }),
  });
  if (response.ok) {
    await client.query(
      "UPDATE operator_alerts SET notified_at = now() WHERE kind='source_health' AND day=current_date",
    );
  }
}

await client.connect();
/** @type {Error | null} */
let failure = null;
try {
  switch (mode) {
    case "links":
      await runLinks();
      break;
    case "reverify":
      await runReverify();
      break;
    case "sweep":
      await runSweep();
      break;
    case "health":
      await runHealth();
      break;
  }
  if (dryRun) console.log("\n(dry run — nothing was written)");
} catch (/** @type {any} */ err) {
  failure = err instanceof Error ? err : new Error(String(err));
} finally {
  await client.end();
}

if (failure) {
  console.error(`\n${mode} failed: ${failure.message}`);
  process.exit(1);
}
