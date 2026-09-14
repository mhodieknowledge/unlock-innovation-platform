#!/usr/bin/env node
/**
 * Operator entry tool. IMPLEMENTATION_PLAN.md §15 step 5 — "the admin quick-add
 * tool, so real data can enter immediately", and §3's "manual publishing".
 *
 * Runs in the BATCH TIER, not the request tier. It needs to write opportunities
 * and eligibility rules, which RLS restricts to admins; the service role lives
 * only in GitHub Actions secrets (SECURITY.md §2), and this is the tool that may
 * legitimately use it. A browser-based quick-add arrives with authenticated admin
 * accounts in Phase 2 — the RLS policies for it already exist (migration 0006).
 *
 * Usage:
 *   node scripts/add-opportunity.mjs path/to/record.json [--publish]
 *   node scripts/add-opportunity.mjs --template > record.json
 *
 * The record must include `source_text`: the readable text of the source page.
 * Every eligibility rule's quote is checked against it character-for-character,
 * because invariant 2 is only meaningful if the quote is actually verbatim —
 * AI_SYSTEM.md §5 makes the same check on the extraction path, "verified by
 * substring match after whitespace normalisation, not by trusting the model".
 * The same standard applies to a human.
 */

import { readFileSync } from "node:fs";
import pg from "pg";

const TEMPLATE = {
  $comment:
    "Every field marked REQUIRED is enforced. source_text is the readable text of the source page; rule quotes are verified against it verbatim and the summary is checked for copied phrasing.",
  title: "REQUIRED — the official name, as the source gives it",
  slug: "optional — derived from the title when omitted",
  organisation_name: "REQUIRED — matched to an existing org, or created as unclaimed",
  organisation_website: "optional — used to match or create the organisation",
  category_code: "REQUIRED — one of the codes in the categories table, e.g. grant",
  summary: "REQUIRED — YOUR OWN WORDS, <=400 chars. Never copied from the source.",
  description_md: "optional — normalised into our structure, never a copy",
  source_url: "REQUIRED — where we found it",
  official_url: "optional but strongly preferred",
  apply_url: "optional",
  deadline_at: "optional ISO 8601, e.g. 2026-12-30T21:59:00Z",
  deadline_precision: "exact_time | date_only | month_only | rolling | unknown",
  deadline_raw: "REQUIRED when precision is coarser than exact_time — the source's own words",
  deadline_timezone: "optional, e.g. Africa/Harare",
  opens_at: null,
  participation_mode: "online | in_person | hybrid | unknown",
  eligibility_scope: "country_list | region | africa_wide | global | unclear",
  eligible_countries: ["ZW", "ZM"],
  team_required: null,
  team_size_min: null,
  team_size_max: null,
  prize_amount: null,
  prize_currency: null,
  cost: "free | paid | unknown",
  source_text: "REQUIRED — the readable text of the source page",
  rules: [
    {
      rule_type: "country_in",
      params: { countries: ["ZW", "ZM"] },
      source_quote: "REQUIRED — a sentence copied verbatim from source_text",
      confidence: 0.95,
    },
  ],
};

const args = process.argv.slice(2);

if (args.includes("--template")) {
  console.log(JSON.stringify(TEMPLATE, null, 2));
  process.exit(0);
}

const file = args.find((a) => !a.startsWith("--"));
const shouldPublish = args.includes("--publish");

if (!file) {
  console.error("Usage: node scripts/add-opportunity.mjs record.json [--publish]");
  console.error("       node scripts/add-opportunity.mjs --template > record.json");
  process.exit(1);
}

const CONN = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
if (!CONN) {
  console.error("Set DATABASE_URL or SUPABASE_DB_URL for this command only (invariant 11).");
  process.exit(1);
}

const record = JSON.parse(readFileSync(file, "utf8"));
const problems = [];

const norm = (s) => String(s).replace(/\s+/g, " ").trim().toLowerCase();

// ── Validation. Every check maps to a named rule. ───────────────────────────

if (!record.title) problems.push("title is required");
if (!record.organisation_name) problems.push("organisation_name is required");
if (!record.category_code) problems.push("category_code is required");
if (!record.summary) problems.push("summary is required");
if (!record.source_text) problems.push("source_text is required (rule quotes are verified against it)");

// Invariant 1 — never publish an opportunity without a source URL.
if (!record.source_url && !record.official_url) {
  problems.push("invariant 1: source_url or official_url is required");
}

// Invariant 13 — never publish an opportunity that charges a fee to apply.
if (shouldPublish && record.cost === "paid") {
  problems.push(
    "invariant 13: an opportunity that charges a fee to apply is REJECTED, not reviewed. " +
      "MODERATION_AND_TRUST.md §2.1 rule 1. Enter it without --publish if it needs a record.",
  );
}

if (record.summary && record.summary.length > 400) {
  problems.push(`summary is ${record.summary.length} chars; the cap is 400`);
}

// PRODUCT_SPEC.md §11.3 — the source's own wording must be shown whenever our
// parsed date is more precise than the source was.
if (
  record.deadline_at &&
  record.deadline_precision &&
  record.deadline_precision !== "exact_time" &&
  !record.deadline_raw
) {
  problems.push(
    `deadline_precision is "${record.deadline_precision}" so deadline_raw is required — ` +
      "the reader must see what the source actually said",
  );
}

// CONTENT_AND_LAUNCH.md §4 — summaries are ours. An 8-consecutive-word overlap
// with the source is both a copyright control and a quality one.
if (record.summary && record.source_text) {
  const summaryWords = norm(record.summary).split(" ");
  const sourceNorm = norm(record.source_text);
  for (let i = 0; i + 8 <= summaryWords.length; i++) {
    const phrase = summaryWords.slice(i, i + 8).join(" ");
    if (sourceNorm.includes(phrase)) {
      problems.push(
        `summary copies 8+ consecutive words from the source: "${phrase}". ` +
          "Write it in our own words (CONTENT_AND_LAUNCH.md §4).",
      );
      break;
    }
  }
}

// Invariant 2 — never store an eligibility rule without a verbatim source quote.
const rules = Array.isArray(record.rules) ? record.rules : [];
rules.forEach((rule, i) => {
  if (!rule.rule_type) problems.push(`rules[${i}]: rule_type is required`);
  if (!rule.source_quote || !String(rule.source_quote).trim()) {
    problems.push(`rules[${i}]: invariant 2 — source_quote is required`);
    return;
  }
  if (typeof rule.confidence !== "number" || rule.confidence < 0 || rule.confidence > 1) {
    problems.push(`rules[${i}]: confidence must be a number between 0 and 1`);
  }
  if (record.source_text && !norm(record.source_text).includes(norm(rule.source_quote))) {
    problems.push(
      `rules[${i}]: source_quote is NOT a verbatim substring of source_text. ` +
        "Invariant 2 means verbatim, checked, not asserted.",
    );
  }
});

if (shouldPublish && rules.length === 0) {
  console.warn(
    "\nNote: publishing with no eligibility rules. Every verdict will read `unclear`,\n" +
      "which is honest but unhelpful. AI_SYSTEM.md §5 treats that as an acceptable\n" +
      "degraded state, not a target.\n",
  );
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) with ${file}:\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("");
  process.exit(1);
}

// ── Insert ──────────────────────────────────────────────────────────────────

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);

const client = new pg.Client({
  connectionString: CONN,
  ssl: /supabase\.(co|com)/.test(CONN) ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15000,
});

await client.connect();
try {
  await client.query("BEGIN");

  const { rows: catRows } = await client.query("SELECT id FROM categories WHERE code = $1", [
    record.category_code,
  ]);
  if (catRows.length === 0) throw new Error(`unknown category_code: ${record.category_code}`);

  // OPPORTUNITY_INGESTION.md §4.5: exact domain match, else create as
  // `unclaimed` and leave it for merge review. Never silently guess a match.
  const domain = record.organisation_website
    ? new URL(record.organisation_website).hostname.replace(/^www\./, "")
    : null;

  let orgId;
  if (domain) {
    const { rows } = await client.query("SELECT id FROM organisations WHERE website_domain = $1", [
      domain,
    ]);
    orgId = rows[0]?.id;
  }
  if (!orgId) {
    const { rows } = await client.query(
      "SELECT id FROM organisations WHERE lower(name) = lower($1)",
      [record.organisation_name],
    );
    orgId = rows[0]?.id;
  }
  if (!orgId) {
    const { rows } = await client.query(
      `INSERT INTO organisations (name, slug, website_url, website_domain, verification)
       VALUES ($1, $2, $3, $4, 'unclaimed') RETURNING id`,
      [
        record.organisation_name,
        slugify(record.organisation_name),
        record.organisation_website ?? null,
        domain,
      ],
    );
    orgId = rows[0].id;
    console.log(`  created organisation "${record.organisation_name}" as unclaimed`);
  }

  const slug = record.slug ? slugify(record.slug) : slugify(record.title);
  const status = shouldPublish ? "published" : "draft";

  const { rows: oppRows } = await client.query(
    `INSERT INTO opportunities (
       slug, title, organisation_id, summary, description_md, category_id,
       eligibility_scope, eligible_countries, participation_mode,
       opens_at, deadline_at, deadline_precision, deadline_raw, deadline_timezone,
       team_required, team_size_min, team_size_max,
       prize_amount, prize_currency, cost,
       source_url, official_url, apply_url,
       status, verification, last_verified_at, next_verify_at, published_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,
       $7,$8,$9,
       $10,$11,$12,$13,$14,
       $15,$16,$17,
       $18,$19,$20,
       $21,$22,$23,
       $24::opp_status,'verified', now(), now() + next_verify_interval($11::timestamptz),
       CASE WHEN $24::text = 'published' THEN now() ELSE NULL END
     ) RETURNING id, slug`,
    [
      slug,
      record.title,
      orgId,
      record.summary,
      record.description_md ?? null,
      catRows[0].id,
      record.eligibility_scope ?? "unclear",
      record.eligible_countries ?? [],
      record.participation_mode ?? "unknown",
      record.opens_at ?? null,
      record.deadline_at ?? null,
      record.deadline_precision ?? "unknown",
      record.deadline_raw ?? null,
      record.deadline_timezone ?? null,
      record.team_required ?? null,
      record.team_size_min ?? null,
      record.team_size_max ?? null,
      record.prize_amount ?? null,
      record.prize_currency ?? null,
      record.cost ?? "unknown",
      record.source_url ?? null,
      record.official_url ?? null,
      record.apply_url ?? null,
      status,
    ],
  );

  const opportunityId = oppRows[0].id;

  for (const rule of rules) {
    await client.query(
      `INSERT INTO eligibility_rules (opportunity_id, rule_type, params, source_quote, confidence)
       VALUES ($1, $2, $3, $4, $5)`,
      [opportunityId, rule.rule_type, rule.params ?? {}, rule.source_quote, rule.confidence],
    );
  }

  await client.query("COMMIT");

  console.log(`\n  ✓ ${status}: /opportunities/${oppRows[0].slug}`);
  console.log(`    ${rules.length} eligibility rule(s), each with a verified verbatim quote`);
  if (!shouldPublish) console.log("    Re-run with --publish when you are satisfied.\n");
  else console.log("");
} catch (/** @type {any} */ err) {
  await client.query("ROLLBACK");
  console.error(`\n  ✗ ${err.message}\n`);
  process.exitCode = 1;
} finally {
  await client.end();
}
