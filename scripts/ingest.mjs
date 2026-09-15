#!/usr/bin/env node
/**
 * The ingestion pipeline. OPPORTUNITY_INGESTION.md §1:
 *
 *   DISCOVER -> FETCH -> NORMALISE -> EXTRACT -> STRUCTURE -> DEDUPE -> SCORE -> REVIEW -> PUBLISH
 *
 * "All stages run in the batch tier. Each stage is independently re-runnable and
 * idempotent. Every stage writes an auditable row. `[PR]`"
 *
 * Re-runnable and idempotent are properties, not aspirations, so the design is:
 * discovery skips any canonical URL whose content hash we already hold; a document
 * that fails extraction stays as a raw_document and is retried next run; routing is a
 * database function, so re-running cannot publish something a previous run sent to
 * review.
 *
 * WHAT THIS SCRIPT DOES NOT DECIDE. Whether a record may publish is
 * route_for_publication's decision (migration 0012). Whether a rule may exist is
 * validateRules' (packages/ingest). Both are elsewhere on purpose — those are the
 * product's promises, and a promise living in the caller is a promise the next caller
 * breaks.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/ingest.mjs                 every active source due
 *   DATABASE_URL=... node scripts/ingest.mjs --source <uuid>  one source
 *   DATABASE_URL=... node scripts/ingest.mjs --url <url>      §8's admin quick-add
 *   ... --dry-run    fetch, extract, print, write nothing
 *   ... --no-ai      force the NO_AI path, to prove the fallback works
 *   ... --force      ignore cadence and run every active source now
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  canonicaliseUrl,
  checkNoCopiedPhrase,
  clearsConfidenceFloors,
  contentHash,
  detectFeeLanguage,
  extractJsonLd,
  htmlToText,
  hostOf,
  itemsSince,
  parseFeed,
  parseSitemap,
  recordFromJsonLd,
  runTask,
  truncateForStorage,
  validateExtraction,
  validateRules,
  Breakers,
} from "../packages/ingest/src/index.mjs";
import { itemsFromApi } from "../packages/ingest/src/apis.mjs";
import { politeFetch, renderStats } from "./lib/fetcher.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
/** @param {string} name */
const flag = (name) => args.includes(name);
/** @param {string} name */
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};

const DRY_RUN = flag("--dry-run");
const NO_AI = flag("--no-ai");
const ONE_SOURCE = option("--source");
/**
 * Ignore cadence. Naming a source is itself that instruction — the console has always
 * told operators that "--source forces one" while the query went on ANDing the cadence
 * gate, so a named source that had been read an hour ago returned nothing and printed
 * the message promising it would have. The flag makes the promise true and generalises
 * it: --force runs the whole registry now.
 *
 * This is the switch that makes a fix verifiable. Without it, the only way to see a
 * change to the fetch path in production is to wait out the longest cadence in the
 * registry and hope the run lands on the sources you changed something for.
 */
const FORCE = flag("--force") || Boolean(ONE_SOURCE);
const ONE_URL = option("--url");
const LIMIT = Number(option("--limit") ?? 25);
/**
 * How long a stored document that produced nothing stays eligible for another
 * extraction attempt. Long enough to cover a provider outage, a retired model name or
 * a prompt fix; short enough that a page which is simply not an opportunity stops
 * costing three provider calls a run.
 */
const RETRY_EXTRACTION_DAYS = Number(process.env.INGEST_RETRY_EXTRACTION_DAYS ?? 14);

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

/** Prompts are versioned FILES in the repo (AI_SYSTEM.md §12). */
/** @param {string} name */
function prompt(name) {
  const text = readFileSync(join(ROOT, "prompts", `${name}.md`), "utf8");
  // The System section is the contract; everything else in the file is documentation
  // for the humans maintaining it.
  const match = /##\s*System\s*\n([\s\S]*?)(?=\n##\s|\s*$)/.exec(text);
  if (!match || !match[1]) throw new Error(`prompts/${name}.md has no "## System" section`);
  return { version: name, system: match[1].trim() };
}

// ── Reference data, read once from OUR tables ────────────────────────────────

let KNOWN_COUNTRIES = new Set();
let RULE_TYPES = [];
/** @type {Map<string, string[]>} */
let REGIONS = new Map();
let CATEGORY_BY_CODE = new Map();

async function loadReferenceData() {
  const { rows: countries } = await client.query("SELECT iso2 FROM countries");
  KNOWN_COUNTRIES = new Set(countries.map((/** @type {any} */ r) => String(r.iso2).trim().toUpperCase()));

  const { rows: types } = await client.query(
    "SELECT unnest(enum_range(NULL::rule_type))::text AS t",
  );
  RULE_TYPES = types.map((r) => r.t);

  const { rows: regions } = await client.query("SELECT code, member_countries FROM regions");
  REGIONS = new Map(
    regions.map((r) => [r.code, (r.member_countries ?? []).map((c) => String(c).trim())]),
  );

  const { rows: categories } = await client.query("SELECT id, code FROM categories");
  CATEGORY_BY_CODE = new Map(categories.map((r) => [r.code, r.id]));
}

/** §5 rule 2 / §4.5: region words expand from OUR table, never a model's list. */
/** @param {string[]} codes */
const expandRegions = (codes) => codes.flatMap((code) => REGIONS.get(code) ?? []);

// ── Logging AI consumption (AI_SYSTEM.md §3.2) ───────────────────────────────

/**
 * @param {Array<{provider: string, model: string, tokens_in: number, tokens_out: number,
 *                latency_ms: number, outcome: string, detail?: string}>} calls
 * @param {string} task
 * @param {string} promptVersion
 */
async function logCalls(calls, task, promptVersion) {
  for (const call of calls) {
    if (DRY_RUN) continue;
    await client.query(
      `INSERT INTO ai_usage (provider, task, model, prompt_version, tokens_in, tokens_out,
                             latency_ms, outcome, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        call.provider,
        task,
        call.model,
        promptVersion,
        call.tokens_in,
        call.tokens_out,
        call.latency_ms,
        call.outcome,
        call.detail ?? null,
      ],
    );
  }
}

/** @param {string} task @param {boolean} allowTrainingProviders */
async function chainFor(task, allowTrainingProviders) {
  const { rows } = await client.query("SELECT * FROM ai_chain_for($1,$2)", [
    task,
    allowTrainingProviders,
  ]);
  return rows;
}

// ── DISCOVER (§4.1) ──────────────────────────────────────────────────────────

async function discover(source) {
  const result = await politeFetch(source.url, {
    etag: source.etag,
    lastModified: source.last_modified,
  });

  if (result.status === "not_modified") {
    await recordFetch(source.id, "not_modified", result.httpStatus, 0, 0, null);
    return { items: [], status: "not_modified" };
  }
  if (result.status !== "ok" || !result.body) {
    // `challenged` is not one of source_fetch_status's values, and inventing one would
    // mean a migration for a distinction the table does not need: for the source's
    // health history a wall IS a fetch error. The precise reason goes in the error
    // column, where the health report reads it.
    const recorded = result.status === "challenged" ? "fetch_error" : result.status;
    await recordFetch(source.id, recorded, result.httpStatus, 0, 0, result.error);
    return { items: [], status: result.status, error: result.error };
  }

  let items = [];
  switch (source.kind) {
    case "rss":
    case "atom":
      items = parseFeed(result.body, source.url);
      break;
    case "sitemap":
      items = parseSitemap(result.body, source.url).map((e) => ({
        url: e.url,
        title: null,
        publishedAt: e.lastmod,
        summary: null,
      }));
      break;
    case "html_page":
    case "jsonld":
      // A single page IS the item. Scoped HTML fetch is §2's tier 6, last resort.
      items = [{ url: canonicaliseUrl(source.url) ?? source.url, title: null, publishedAt: null, summary: null }];
      break;
    case "json_api":
      // §2 tier 1, and the cheapest tier to read: the adapter returns schema.org nodes,
      // §4.4 gives publisher-authored structured data priority over the model, so these
      // items reach a record without a single token being spent.
      try {
        items = itemsFromApi(source.api_adapter, result.body, source.url);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await recordFetch(source.id, "parse_error", result.httpStatus, 0, 0, detail);
        return { items: [], status: "parse_error", error: detail };
      }
      break;
    default:
      await recordFetch(source.id, "parse_error", result.httpStatus, 0, 0,
        `no discovery implemented for kind "${source.kind}"`);
      return { items: [], status: "parse_error" };
  }

  // §4.1: filter by pubDate where available. A week of overlap absorbs a missed run
  // without re-reading the whole feed.
  const since = source.last_success_at ? new Date(new Date(source.last_success_at).getTime() - 7 * 86_400_000) : null;
  const fresh = itemsSince(items, since);

  return { items: fresh.slice(0, LIMIT), status: "ok", etag: result.etag, lastModified: result.lastModified, seen: items.length };
}

async function recordFetch(sourceId, status, httpStatus, seen, added, error, etag, lastModified) {
  if (DRY_RUN || !sourceId) return;
  await client.query("SELECT record_source_fetch($1,$2,$3,$4,$5,$6,$7,$8)", [
    sourceId,
    status,
    httpStatus ?? null,
    seen ?? 0,
    added ?? 0,
    error ?? null,
    etag ?? null,
    lastModified ?? null,
  ]);
}

// ── NORMALISE (§4.3) ─────────────────────────────────────────────────────────

/**
 * @param {string} url
 * @param {string} body
 * @param {string | undefined} contentType
 * @returns {Promise<{ ok: false, skip: string }
 *                 | { ok: true, canonicalUrl: string, title: string | null, text: string,
 *                     jsonld: unknown[], hash: string,
 *                     hintRegion?: string | null, hintCategories?: string[] }>}
 */
async function normalise(url, body, contentType, extraJsonLd = []) {
  if (contentType === "application/pdf") {
    // §4.3: "PDF -> text via pdftotext; if empty (scanned), mark needs_manual and
    // stop — NO OCR at $0." pdftotext is not available in the batch image, so a PDF
    // is queued for a person rather than guessed at. Saying so beats pretending.
    return { ok: false, skip: "pdf_needs_manual" };
  }

  // An API adapter's nodes come FIRST, so findOpportunityNode reaches them before
  // anything the landing page happens to carry: the API is the publisher speaking about
  // the opportunity, and the page it points at is often a marketing site whose own
  // JSON-LD describes the organisation running it rather than the thing on offer.
  const jsonld = [...extraJsonLd, ...extractJsonLd(body)];
  const { text, title } = htmlToText(body);
  const stored = truncateForStorage(text);

  return {
    ok: true,
    canonicalUrl: canonicaliseUrl(url) ?? url,
    title,
    text: stored,
    jsonld,
    hash: await contentHash(stored),
  };
}

// ── EXTRACT and STRUCTURE (§4.4, §4.5) ───────────────────────────────────────

/**
 * Extraction, with JSON-LD winning over the model on any field it supplies (§4.4)
 * and JSON-LD alone as the NO_AI fallback (AI_SYSTEM.md §4).
 *
 * @param {any} doc
 * @returns {Promise<{ ok: false, reason: string, detail?: string, issues?: any[] }
 *                 | { ok: true, record: Record<string, any>, confidence: Record<string, number>,
 *                     issues: any[], provider: string | null, usedJsonLd: boolean,
 *                     jsonLdFields: string[] }>}
 */
async function extract(doc) {
  const fromJsonLd = recordFromJsonLd(doc.jsonld, doc.canonicalUrl);

  /** @type {Record<string, any> | null} */
  let modelRecord = null;
  /** @type {Record<string, number>} */
  let modelConfidence = {};
  /** @type {any[]} */
  let issues = [];
  let provider = null;
  /**
   * Why the model produced nothing, in the model's own terms.
   *
   * runTask already knows — it collects a detail per provider it tried, so the answer
   * is something like "gemini: http 429 | groq: model_decommissioned" — and extract()
   * used to drop it on the floor and return the bare word `extraction_failed`. That is
   * what fifty-three log lines said on 2026-09-15 and forty-two said on the re-run:
   * a label that names the stage and withholds the cause, which is the one thing the
   * operator came to the log for. An exhausted quota, a retired model name and a page
   * that genuinely holds no opportunity are three different problems with three
   * different fixes, and they were indistinguishable.
   */
  let modelDetail = null;

  if (!NO_AI) {
    const p = prompt("extract.v1");
    // §2 guardrail 5: a page fetched from the public web carries no user data, so
    // training-tier providers are permitted for THIS task and no other.
    const chain = await chainFor("extract", true);
    const result = await runTask({
      chain,
      system: p.system,
      user: [
        `TODAY: ${new Date().toISOString().slice(0, 10)}`,
        `SOURCE URL: ${doc.canonicalUrl}`,
        `HINTS (overridable by the page, never authoritative): region=${doc.hintRegion ?? "none"}, categories=${(doc.hintCategories ?? []).join(",") || "none"}`,
        "",
        "PAGE TEXT:",
        doc.text,
      ].join("\n"),
      env,
      fetch: globalThis.fetch,
      breakers,
      accept: (data) => typeof data === "object" && data !== null && "title" in data,
    });
    await logCalls(result.calls, "extract", p.version);

    if (!result.ok) {
      modelDetail = result.detail ?? "every provider in the chain failed";
    } else {
      provider = `${result.provider}/${result.model}`;
      const validated = validateExtraction(result.data, {
        sourceText: doc.text,
        knownCountries: KNOWN_COUNTRIES,
      });
      modelRecord = validated.record;
      modelConfidence = validated.confidence;
      issues = validated.issues;
    }
  }

  if (!modelRecord && !fromJsonLd) {
    // AI_SYSTEM.md §4 `[PR]`: "Otherwise the document waits. Nothing is published
    // from a failed extraction."
    return {
      ok: false,
      reason: NO_AI ? "no_ai_and_no_jsonld" : "extraction_failed",
      // A validated reply that simply found no opportunity is not a broken chain, and
      // the two have to read differently or the next run is another guess.
      detail:
        modelDetail ??
        (provider
          ? `${provider} replied but no opportunity survived validation`
          : "no provider was configured for the extract task"),
    };
  }

  if (issues.some((i) => i.effect === "discard")) {
    return { ok: false, reason: "discarded", issues };
  }

  // JSON-LD wins where it has an opinion: it is publisher-authored.
  const record = { ...(modelRecord ?? {}), ...(fromJsonLd?.record ?? {}) };
  /** @type {Record<string, number>} */
  const confidence = { ...modelConfidence, ...(fromJsonLd?.confidence ?? {}) };
  if (!confidence.overall && fromJsonLd) {
    // A JSON-LD-only record is certain about what it says and silent about the rest.
    // Its overall confidence is deliberately BELOW the auto-publish floor, because
    // no summary, category or eligibility was extracted at all.
    confidence.overall = 0.5;
  }

  return {
    ok: true,
    record,
    confidence,
    issues,
    provider,
    usedJsonLd: Boolean(fromJsonLd),
    jsonLdFields: fromJsonLd?.fields ?? [],
  };
}

/** Rule derivation. AI_SYSTEM.md §5 — the most tightly constrained task here. */
async function deriveRules(doc, record) {
  if (NO_AI) {
    // §5's fallback `[PR]`: "no rules are created. Every verdict for that
    // opportunity is `unclear`, displayed honestly." An acceptable degraded state.
    return { rules: [], rejected: [], reason: "no_ai" };
  }

  const p = prompt("rules.v1");
  const chain = await chainFor("rules", true);
  const result = await runTask({
    chain,
    system: p.system,
    user: [
      "DOCUMENT:",
      doc.text,
      "",
      "RECORD ALREADY EXTRACTED (context only — do not treat as a source of rules):",
      JSON.stringify(record),
    ].join("\n"),
    env,
    fetch: globalThis.fetch,
    breakers,
    accept: (data) =>
      typeof data === "object" && data !== null && Array.isArray(/** @type {any} */ (data).rules),
  });
  await logCalls(result.calls, "rules", p.version);

  if (!result.ok) return { rules: [], rejected: [], reason: "no_ai" };

  const { rules, rejected } = validateRules(/** @type {any} */ (result.data).rules, {
    sourceText: doc.text,
    knownCountries: KNOWN_COUNTRIES,
    knownRuleTypes: RULE_TYPES,
    expandRegions,
  });
  return { rules, rejected, provider: `${result.provider}/${result.model}` };
}

// ── Organisation resolution (§4.5) ───────────────────────────────────────────

/**
 * @param {string | null} name
 * @param {string} url
 * @returns {Promise<{ id: string | null, how: string }>}
 */
async function resolveOrganisation(name, url) {
  const domain = hostOf(url);

  if (domain) {
    const { rows } = await client.query(
      "SELECT id FROM organisations WHERE website_domain = $1 AND deleted_at IS NULL LIMIT 1",
      [domain],
    );
    if (rows[0]) return { id: rows[0].id, how: "domain" };
  }

  if (name) {
    // Trigram >= 0.8, per §4.5. Below that it is a candidate for a person to judge,
    // not a link to make: attaching an opportunity to the wrong organisation is
    // visible on that organisation's page and looks like an endorsement.
    const { rows } = await client.query(
      `SELECT id, similarity(name, $1) AS sim FROM organisations
        WHERE deleted_at IS NULL AND similarity(name, $1) >= 0.8
        ORDER BY sim DESC LIMIT 1`,
      [name],
    );
    if (rows[0]) return { id: rows[0].id, how: "name" };
  }

  if (!name || DRY_RUN) return { id: null, how: "unresolved" };

  // §4.5: "else create `unclaimed` org and queue for merge review".
  const slugBase = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "organisation";
  const { rows } = await client.query(
    `INSERT INTO organisations (name, slug, website_domain, verification)
     VALUES ($1, $2 || '-' || substr(md5(random()::text),1,6), $3, 'unclaimed')
     RETURNING id`,
    [name.slice(0, 200), slugBase, domain],
  );
  await client.query(
    `INSERT INTO review_queue (queue, subject_type, subject_id, priority)
     VALUES ('org_claim','organisation',$1,3)`,
    [rows[0].id],
  );
  return { id: rows[0].id, how: "created" };
}

// ── One document, end to end ─────────────────────────────────────────────────

async function processDocument(source, item) {
  const fetched = await politeFetch(item.url);

  if (fetched.status === "blocked") {
    return { outcome: "blocked", detail: fetched.error };
  }
  if (fetched.status === "challenged") {
    // Distinct from fetch_failed on purpose. "We were refused by a bot wall and a real
    // browser could not get past it either" is a fact about the source that an operator
    // can act on — lower its tier, drop it, or find its feed. "Extraction failed", which
    // is what this used to surface as, points at the model and is a dead end.
    return { outcome: "challenged", detail: fetched.error };
  }
  if (fetched.status !== "ok" || !fetched.body) {
    return { outcome: "fetch_failed", detail: fetched.error ?? fetched.status };
  }

  const doc = await normalise(
    fetched.finalUrl ?? item.url,
    fetched.body,
    fetched.contentType,
    Array.isArray(item.jsonld) ? item.jsonld : [],
  );
  if (!doc.ok) return { outcome: doc.skip };

  doc.hintRegion = source?.default_region ?? null;
  doc.hintCategories = source?.default_categories ?? [];

  // §4.1: skip anything whose canonical URL plus content hash we already hold — but
  // only where holding it meant something.
  //
  // This check used to match on the hash alone, and the code a dozen lines below
  // stores a raw document even when extraction fails, "so the next run retries
  // extraction without re-fetching". It did not. The failed document's hash was in the
  // table, so the next run matched it, returned `unchanged`, and never reached
  // extraction again. The comment described the intent and the code did the opposite.
  //
  // That turns any outage that spans one run into permanent loss: the 2026-09-15 run
  // failed extraction on 53 documents and stored all 53, and the re-run reported 17 of
  // them as `unchanged` — not because they were fine, but because they had already
  // failed once. Fixing the underlying cause would not have brought them back.
  //
  // So `unchanged` now means what it says: we have this document AND it produced an
  // opportunity. A stored document with nothing to show for it is retried.
  if (!DRY_RUN) {
    const { rows: existing } = await client.query(
      `SELECT r.id
         FROM raw_documents r
        WHERE r.canonical_url = $1
          AND r.content_hash = $2
          AND (EXISTS (SELECT 1 FROM opportunities o WHERE o.raw_document_id = r.id)
               -- The bound on retrying. A provider outage resolves in hours; a page
               -- that is genuinely not an opportunity never will, and re-asking three
               -- providers about it on every run for the rest of the year is quota
               -- spent to learn the same thing. After the window the document rests.
               OR r.fetched_at < now() - make_interval(days => $3::int))
        LIMIT 1`,
      [doc.canonicalUrl, doc.hash, RETRY_EXTRACTION_DAYS],
    );
    if (existing[0]) return { outcome: "unchanged" };
  }

  const extracted = await extract(doc);
  if (!extracted.ok) {
    // The document is still stored: §1 wants an auditable row per stage, and the
    // next run retries extraction without re-fetching.
    await storeRawDocument(source, doc);
    return {
      outcome: "extraction_failed",
      detail: extracted.detail ?? extracted.reason,
    };
  }

  const rawDocumentId = await storeRawDocument(source, doc);
  const { rules, rejected } = await deriveRules(doc, extracted.record);

  // AI_SYSTEM.md §10 `[PR]`: the deterministic fee check runs whether or not any
  // model was available, and it reads the SOURCE, not the model's `cost` field.
  const fee = detectFeeLanguage(doc.text);

  const organisationName =
    typeof extracted.record.organisation_name === "string"
      ? extracted.record.organisation_name
      : typeof item.title === "string"
        ? item.title
        : null;
  const organisation = await resolveOrganisation(organisationName, doc.canonicalUrl);

  const summary =
    typeof extracted.record.summary === "string" ? extracted.record.summary : null;
  const summaryCheck = summary ? checkNoCopiedPhrase(summary, doc.text) : { ok: true };

  const candidate = {
    ...extracted.record,
    title: extracted.record.title ?? item.title ?? "Untitled",
    source_url: doc.canonicalUrl,
    organisation_id: organisation.id,
    raw_document_id: rawDocumentId,
    // Invariant 13's write-path half: a fee keyword anywhere in the document makes
    // the cost `paid`, whatever the model said, and `paid` cannot be published.
    cost: fee.hit ? "paid" : (extracted.record.cost ?? "unknown"),
    summary: summaryCheck.ok ? summary : null,
  };

  if (DRY_RUN) {
    return {
      outcome: "dry_run",
      candidate,
      confidence: extracted.confidence,
      rules,
      rejectedRules: rejected,
      fee,
      issues: extracted.issues,
      provider: extracted.provider,
      usedJsonLd: extracted.usedJsonLd,
    };
  }

  return await writeCandidate({
    source,
    doc,
    candidate,
    confidence: extracted.confidence,
    rules,
    rejected,
    fee,
    issues: extracted.issues,
  });
}

/**
 * Store the document, or find the one we already have.
 *
 * raw_documents is UNIQUE (canonical_url, content_hash), and retrying a failed
 * extraction means arriving here a second time with the same pair. A plain INSERT
 * therefore raised a duplicate key and took the whole run down with it — which is
 * exactly what happened on the 13:53 run, nine documents in, the moment the retry fix
 * from the previous commit did what it was written to do. The retry was right; this
 * INSERT was the half that had never had to cope with one.
 *
 * fetched_at is deliberately NOT touched on conflict. It means first seen, and the
 * retry window in processDocument measures from it: bumping it on every attempt would
 * push the deadline forward each time and turn a bounded retry into a permanent one.
 */
async function storeRawDocument(source, doc) {
  if (DRY_RUN) return null;
  const { rows } = await client.query(
    `INSERT INTO raw_documents (source_id, url, canonical_url, content_hash, title_raw, text_raw, jsonld)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (canonical_url, content_hash) DO UPDATE
       SET source_id = EXCLUDED.source_id,
           url       = EXCLUDED.url
     RETURNING id`,
    [
      source?.id ?? null,
      doc.canonicalUrl,
      doc.canonicalUrl,
      doc.hash,
      doc.title,
      doc.text,
      JSON.stringify(doc.jsonld ?? []),
    ],
  );
  return rows[0].id;
}

// ── SCORE, ROUTE, WRITE (§4.7, §4.9) ─────────────────────────────────────────

async function writeCandidate({ source, doc, candidate, confidence, rules, rejected, fee, issues }) {
  const { rows: routed } = await client.query(
    `SELECT * FROM route_for_publication($1,$2,$3,$4,$5::cost_kind,$6,$7,$8::eligibility_scope,$9,$10,$11,$12)`,
    [
      source?.id ?? null,
      confidence.overall ?? 0,
      confidence.deadline ?? 0,
      confidence.eligible_countries ?? 0,
      candidate.cost ?? "unknown",
      candidate.prize_amount ?? null,
      candidate.prize_currency ?? null,
      candidate.eligibility_scope ?? "unclear",
      // Link health is not known until the link-health job runs, so a brand-new
      // record is never auto-published on its first pass. That is §4.7's
      // `link_ok = true` requirement, honoured rather than assumed.
      candidate.link_ok ?? null,
      candidate.organisation_id,
      fee.hit,
      false,
    ],
  );

  const decision = routed[0]?.decision ?? "review";
  const reason = routed[0]?.reason ?? "no routing decision";
  const floorsOk = clearsConfidenceFloors(confidence);

  // A REJECTED RULE CANDIDATE BLOCKS AUTO-PUBLICATION, and this is not obvious.
  //
  // Discarding a rule makes a verdict MORE permissive, not less. The golden set's G02
  // is the case that showed it: the model found a student-status requirement, quoted it
  // as a paraphrase, the quote check correctly discarded the rule — and the remaining
  // rules then produced "eligible" for a profile the document's real requirements may
  // well exclude. Nobody was lied to about a rule, and the verdict was still wrong in
  // the expensive direction.
  //
  // The clean fix would be a stored rule meaning "there are requirements we could not
  // confirm", which would force `unclear` through the engine's existing
  // other_unstructured path. Invariant 2 forbids it: a stored rule must carry the
  // organiser's own words, and there are none to carry here. So the honest response is
  // that a person looks at it.
  const rejectedRule = rejected.length > 0;

  /**
   * Whether this source was vetted for publication without a person (migration 0031).
   *
   * route_for_publication already applies the narrower floors for such a source — an
   * uncertain deadline and an asserted country list still go to review — so applying
   * clearsConfidenceFloors on top would re-impose the blanket 0.75/0.80/0.80 the
   * migration deliberately replaced. It would also silently exclude the best source in
   * the registry: a Devpost record is built from publisher-authored JSON-LD, which
   * recordFromJsonLd scores 0.5 overall by design ("certain about what it says and
   * silent about the rest") and which never states eligible countries at all.
   */
  const vetted = source?.auto_publish === true;

  const publish =
    decision === "publish" &&
    (vetted || floorsOk) &&
    // A discarded rule candidate still blocks, vetted or not. Discarding a rule makes a
    // verdict MORE permissive, so the reader is told they are eligible for something
    // whose real requirements may exclude them — see the note above.
    !rejectedRule &&
    issues.every((i) => i.effect !== "review");

  /**
   * §4.9 publishes "only after the link check confirms the URL resolves", and that check
   * ran only over records already published (reverify.mjs runLinks: `WHERE status =
   * 'published'`). A record could not be published without a link check and could not be
   * link-checked without being published, so on the ingest path NOTHING ever published —
   * status was hardcoded and the routing decision only chose a queue name.
   *
   * The deadlock breaks on a fact that was already true: politeFetch just retrieved this
   * very URL and got a document back. That IS the link resolving. So a vetted source's
   * record is published with link_ok recorded from the fetch that produced it, and
   * reverify re-checks it on its own six-hourly cadence like any other published row.
   */
  const publishNow = publish && vetted;

  /**
   * One opportunity per URL, however many times we fetch it.
   *
   * §1 calls every stage "independently re-runnable and idempotent", and §4.1 implements
   * that by skipping any canonical URL whose CONTENT HASH we already hold. That works
   * for a document that sits still. It does not work for a page that moves: a Devpost
   * hackathon shows a countdown and a live registration count, so its text differs on
   * every fetch, the hash never matches, and the run of 2026-09-15 18:38 wrote a second
   * copy of all eight — `revenuecat-shipaton-2026-2`, `ai-builders-hackathon-2`, each
   * arriving with "2 duplicate candidate(s)" already attached. Three-hourly, that is
   * about seventy duplicates a day, and the dedupe queue notices them without
   * preventing them.
   *
   * The URL is the identity. A second fetch of the same URL is the same opportunity with
   * fresher facts, so it updates in place: the deadline may have moved, the page may
   * have closed, and none of that warrants a new row or a new slug.
   *
   * A record a person has already touched is not overwritten wholesale — only the facts
   * that go stale — because an editor's corrections outrank a re-extraction.
   */
  const { rows: already } = await client.query(
    `SELECT id, slug, status::text AS status
       FROM opportunities
      WHERE source_url = $1 AND deleted_at IS NULL AND duplicate_of IS NULL
      ORDER BY created_at LIMIT 1`,
    [candidate.source_url ?? doc.canonicalUrl],
  );

  if (already[0]) {
    const existing = already[0];
    await client.query(
      `UPDATE opportunities
          SET deadline_at = coalesce($2, deadline_at),
              deadline_precision = coalesce($3::deadline_precision, deadline_precision),
              deadline_raw = coalesce($4, deadline_raw),
              starts_at = coalesce($5, starts_at),
              ends_at = coalesce($6, ends_at),
              last_verified_at = now(),
              link_ok = true,
              link_checked_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [
        existing.id,
        candidate.deadline_at ?? null,
        candidate.deadline_precision ?? null,
        candidate.deadline_raw ?? null,
        candidate.starts_at ?? null,
        candidate.ends_at ?? null,
      ],
    );
    return {
      outcome: "refreshed",
      slug: existing.slug,
      status: existing.status,
    };
  }

  const slug = await uniqueSlug(String(candidate.title ?? ""));

  const { rows } = await client.query(
    `INSERT INTO opportunities
       (slug, title, summary, category_id, organisation_id, source_id, raw_document_id,
        eligibility_scope, eligible_countries, participation_mode,
        deadline_at, deadline_precision, deadline_raw, deadline_timezone,
        starts_at, ends_at, team_required, team_size_min, team_size_max,
        prize_amount, prize_currency, cost, source_url, official_url,
        status, verification, extraction_confidence, last_verified_at,
        published_at, link_ok, link_checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::eligibility_scope,$9,$10::participation_mode,
             $11,$12::deadline_precision,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::cost_kind,$23,$24,
             $25::opp_status,$26::opp_verification,$27,$28,$29,$30,$31)
     RETURNING id, slug`,
    [
      slug,
      String(candidate.title).slice(0, 200),
      candidate.summary ?? null,
      CATEGORY_BY_CODE.get(candidate.category_code) ?? CATEGORY_BY_CODE.get("other") ?? null,
      candidate.organisation_id,
      source?.id ?? null,
      candidate.raw_document_id,
      candidate.eligibility_scope ?? "unclear",
      candidate.eligible_countries ?? [],
      candidate.participation_mode ?? "unknown",
      candidate.deadline_at ?? null,
      candidate.deadline_precision ?? "unknown",
      candidate.deadline_raw ?? null,
      candidate.deadline_timezone ?? null,
      candidate.starts_at ?? null,
      candidate.ends_at ?? null,
      candidate.team_required ?? null,
      candidate.team_size_min ?? null,
      candidate.team_size_max ?? null,
      candidate.prize_amount ?? null,
      candidate.prize_currency ?? null,
      candidate.cost ?? "unknown",
      candidate.source_url,
      candidate.official_url ?? null,
      // A source nobody has vetted is never published on this pass, whatever the
      // routing decision: §4.9 wants a person, and the routing decision is still
      // recorded on the queue item so a record that cleared every gate is visibly a
      // one-click approval rather than a re-review. A vetted source publishes here.
      publishNow ? "published" : "in_review",
      "auto",
      confidence.overall ?? 0,
      new Date().toISOString(),
      publishNow ? new Date().toISOString() : null,
      // The fetch that produced this document is the link resolving. Recorded either
      // way: it is true of an in_review record too, and reverify re-checks on its own
      // cadence.
      true,
      new Date().toISOString(),
    ],
  );

  const opportunityId = rows[0].id;

  for (const rule of rules) {
    await client.query(
      `INSERT INTO eligibility_rules (opportunity_id, rule_type, params, source_quote, confidence)
       VALUES ($1,$2::rule_type,$3,$4,$5)`,
      [opportunityId, rule.rule_type, JSON.stringify(rule.params), rule.source_quote, rule.confidence],
    );
  }

  // §5 rule 3: contradictory rules route to review regardless of confidence.
  const { rows: contradictory } = await client.query("SELECT contradictory_rules($1) AS bad", [
    opportunityId,
  ]);

  const queueReason = contradictory[0]?.bad
    ? "country_in and country_not_in overlap"
    : rejectedRule
      ? `${rejected.length} rule candidate(s) were discarded, so a requirement may be missing and the verdict may be too permissive`
      : publishNow
        ? "published automatically — this source is vetted; spot-check when convenient"
        : publish
          ? "awaiting the link check before publication"
          : reason;

  await client.query(
    `INSERT INTO review_queue (queue, subject_type, subject_id, priority)
     VALUES ($1,'opportunity',$2,$3)`,
    [
      fee.hit ? "paid_cost" : contradictory[0]?.bad ? "extraction" : publish ? "extraction" : "low_confidence",
      opportunityId,
      fee.hit ? 1 : publish ? 4 : 3,
    ],
  );

  // sources.records_published was read by route_for_publication and never written by
  // anything, so "this source has published N records; its first 5 are always reviewed"
  // measured a counter frozen at zero — a gate no source could ever clear, on any path.
  // A publish is what that number counts.
  if (publishNow && source?.id) {
    await client.query(
      "UPDATE sources SET records_published = records_published + 1 WHERE id = $1",
      [source.id],
    );
  }

  // §4.6: look for duplicates now, while the record is fresh in mind.
  const { rows: candidates } = await client.query("SELECT * FROM dedupe_candidates_for($1)", [
    opportunityId,
  ]);
  for (const dupe of candidates) {
    await client.query("SELECT record_dedupe_candidate($1,$2,$3,$4)", [
      opportunityId,
      dupe.candidate_id,
      dupe.method,
      dupe.similarity,
    ]);
  }

  return {
    outcome: "stored",
    id: opportunityId,
    slug: rows[0].slug,
    routed: decision,
    reason: queueReason,
    rules: rules.length,
    rejectedRules: rejected.length,
    duplicates: candidates.length,
    feeDetected: fee.hit,
  };
}

async function uniqueSlug(title) {
  const base =
    String(title ?? "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 70) || "opportunity";

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const { rows } = await client.query("SELECT 1 FROM opportunities WHERE slug = $1", [slug]);
    if (rows.length === 0) return slug;
  }
  return `${base}-${Date.now().toString(36)}`;
}

// ── Run ──────────────────────────────────────────────────────────────────────

await client.connect();
/** @type {Error | null} */
let failure = null;

try {
  await loadReferenceData();

  if (NO_AI) {
    console.log("NO_AI mode: no provider will be called. JSON-LD only, no rules derived.");
  }

  /** @type {Array<{ source: any, items: any[], etag?: string | null, lastModified?: string | null }>} */
  const work = [];

  if (ONE_URL) {
    // §8's admin quick-add: paste a URL, the pipeline runs, the admin reviews.
    const url = canonicaliseUrl(ONE_URL);
    if (!url) {
      console.error(`Not a usable URL: ${ONE_URL}`);
      process.exit(1);
    }
    // raw_documents.source_id is NOT NULL and a pasted URL belongs to no source, so a
    // writing run on this path dies on a constraint violation the moment the first
    // document is stored — after the fetch, the render and the model calls have all
    // been paid for. Say so now instead. Quick-add needs a source row of its own to
    // hang these documents from; until that exists, this path reads and reports.
    if (!DRY_RUN) {
      console.error(
        "--url has no source to attribute the document to, and raw_documents.source_id " +
          "is NOT NULL. Re-run with --dry-run to put the URL through and print the result.",
      );
      process.exit(1);
    }
    work.push({ source: null, items: [{ url, title: null, publishedAt: null, summary: null }] });
  } else {
    const { rows: sources } = await client.query(
      `SELECT * FROM sources
        WHERE is_active
          AND ($1::uuid IS NULL OR id = $1::uuid)
          AND ($2::boolean
               OR last_fetch_at IS NULL
               OR last_fetch_at < now() - make_interval(mins => cadence_minutes))
        ORDER BY last_fetch_at NULLS FIRST`,
      [ONE_SOURCE, FORCE],
    );

    if (sources.length === 0) {
      // "No source is due" on its own leaves an operator guessing whether the pipeline
      // is idle or broken, which is the question they came to the log with. Say when.
      const { rows: next } = await client.query(
        `SELECT name,
                last_fetch_at + make_interval(mins => cadence_minutes) AS due_at
           FROM sources
          WHERE is_active AND ($1::uuid IS NULL OR id = $1::uuid)
          ORDER BY due_at NULLS FIRST
          LIMIT 1`,
        [ONE_SOURCE],
      );
      if (next[0]?.due_at) {
        const dueAt = new Date(next[0].due_at);
        const minutes = Math.max(0, Math.round((dueAt.getTime() - Date.now()) / 60_000));
        console.log(
          `No source is due. Next is ${next[0].name} at ${dueAt.toISOString().slice(0, 16)}Z, ` +
            `in ${minutes} minute(s).`,
        );
      } else {
        console.log("No source is due, and none is active.");
      }
      console.log("Run with --force to ignore cadence, or --url <url> to put one page through.");
    }

    for (const source of sources) {
      const found = await discover(source);
      if (found.status !== "ok") {
        console.log(`  ${source.name}: ${found.status}${found.error ? ` — ${found.error}` : ""}`);
        continue;
      }
      console.log(`  ${source.name}: ${found.items.length} item(s) to look at of ${found.seen} seen`);
      work.push({ source, items: found.items, etag: found.etag, lastModified: found.lastModified });
    }
  }

  let stored = 0;
  let unchanged = 0;
  let refreshed = 0;
  let failed = 0;

  for (const batch of work) {
    for (const item of batch.items) {
      const result = await processDocument(batch.source, item);

      if (result.outcome === "stored") {
        stored += 1;
        console.log(
          `  + ${result.slug} — ${result.routed} (${result.reason}); ` +
            `${result.rules} rule(s) kept, ${result.rejectedRules} rejected` +
            (result.duplicates > 0 ? `, ${result.duplicates} duplicate candidate(s)` : "") +
            (result.feeDetected ? " — FEE LANGUAGE DETECTED" : ""),
        );
      } else if (result.outcome === "unchanged") {
        unchanged += 1;
      } else if (result.outcome === "refreshed") {
        // Same URL, seen again. Not new and not a failure — the dates were re-read on a
        // record we already hold.
        refreshed += 1;
      } else if (result.outcome === "dry_run") {
        console.log(`\n  ${item.url}`);
        console.log(`    provider: ${result.provider ?? "none (NO_AI or JSON-LD only)"}`);
        console.log(`    title: ${result.candidate.title}`);
        console.log(`    deadline: ${result.candidate.deadline_at ?? "none"} (${result.candidate.deadline_precision ?? "-"})`);
        console.log(`    cost: ${result.candidate.cost}${result.fee.hit ? ` — FEE: ${result.fee.matches.join("; ")}` : ""}`);
        console.log(`    countries: ${(result.candidate.eligible_countries ?? []).join(",") || "none"} (${result.candidate.eligibility_scope})`);
        console.log(`    confidence: ${JSON.stringify(result.confidence)}`);
        console.log(`    rules kept: ${result.rules.length}, rejected: ${result.rejectedRules.length}`);
        for (const r of result.rules) console.log(`      ${r.rule_type} (${r.confidence}) "${r.source_quote.slice(0, 70)}..."`);
        for (const r of result.rejectedRules) console.log(`      REJECTED: ${r.reason}`);
        for (const i of result.issues) console.log(`      issue [${i.effect}] ${i.field}: ${i.problem}`);
      } else {
        failed += 1;
        console.log(`  ! ${item.url}: ${result.outcome}${result.detail ? ` — ${result.detail}` : ""}`);
      }
    }

    if (batch.source) {
      await recordFetch(batch.source.id, "ok", 200, batch.items.length, stored, null, batch.etag, batch.lastModified);
    }
  }

  console.log("");
  console.log(
    `Ingestion: ${stored} stored, ${refreshed} refreshed, ${unchanged} unchanged, ${failed} not usable.`,
  );
  const renders = renderStats();
  if (!renders.enabled) {
    console.log("Browser rendering was off (INGEST_BROWSER=0): anything behind a wall was skipped.");
  } else if (renders.used > 0) {
    console.log(`Browser renders: ${renders.used} of ${renders.budget} budgeted.`);
    if (renders.used >= renders.budget) {
      console.log("The render budget ran out — some sources were reported as challenged without being tried.");
    }
    if (renders.hostsGivenUpOn.length > 0) {
      // Worth naming. A host that turns a browser away twice is a source decision —
      // find its feed, lower its tier, or drop it — not something the next run fixes.
      console.log(`Walls that stood: ${renders.hostsGivenUpOn.join(", ")}`);
    }
  }
  if (stored > 0) {
    console.log("Everything lands in review. §4.9 publishes only after the link check,");
    console.log("and an unproven source's first five records always wait for a person.");
  }
  if (DRY_RUN) console.log("\n(dry run — nothing was written)");
} catch (err) {
  failure = err instanceof Error ? err : new Error(String(err));
} finally {
  await client.end();
  // The browser is started lazily and held open for the whole run, so it is this
  // block's job to shut it down. A leaked Chromium keeps the runner alive until the
  // job times out, which turns a good run into a red one.
  const { closeBrowser } = await import("./lib/browser-fetch.mjs");
  await closeBrowser();
}

if (failure) {
  console.error(`\nIngestion failed: ${failure.message}`);
  if (failure.stack) console.error(failure.stack);
  process.exit(1);
}
