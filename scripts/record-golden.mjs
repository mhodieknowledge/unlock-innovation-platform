#!/usr/bin/env node
/**
 * Refresh the golden set's recorded model replies. AI_SYSTEM.md §12.
 *
 * The quality gate (packages/ingest/test/golden-eval.test.ts) measures what the
 * deterministic validators do with a given model output, from RECORDED replies — which
 * is what makes it a gate: no key, no network, the same answer twice.
 *
 * This script is the other half. It calls the live providers with the CURRENT prompt
 * files and writes what they return back into the fixture file. That is how a prompt
 * change gets evaluated: change the prompt, re-record, run the gate, read the metrics.
 *
 * §12: "Prompts are versioned files in the repo. Changing one requires the golden set
 * to pass and writes a row to the admin audit log." CI enforces the first half by
 * refusing a prompt change that arrives without refreshed recordings — otherwise the
 * gate would keep measuring the old prompt's output and report a pass that means
 * nothing.
 *
 * Usage:
 *   DATABASE_URL=... GROQ_API_KEY=... node scripts/record-golden.mjs
 *   ... --case G03      just one
 *   ... --dry-run       call the providers, print, write nothing
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { Breakers, runTask } from "../packages/ingest/src/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "eval/golden/synthetic.json");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyIndex = args.indexOf("--case");
const ONLY = onlyIndex === -1 ? null : (args[onlyIndex + 1] ?? null);

const CONN = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
if (!CONN) {
  console.error("Set DATABASE_URL for this command only (invariant 11). The provider chain");
  console.error("lives in ai_providers, because model names are configuration and not code.");
  process.exit(1);
}

/** @param {string} name */
function promptSystem(name) {
  const text = readFileSync(join(ROOT, "prompts", `${name}.md`), "utf8");
  const match = /##\s*System\s*\n([\s\S]*?)(?=\n##\s|\s*$)/.exec(text);
  if (!match || !match[1]) throw new Error(`prompts/${name}.md has no "## System" section`);
  return match[1].trim();
}

const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8"));
const client = new pg.Client({
  connectionString: CONN,
  ssl: /supabase\.(co|com)/.test(CONN) ? { rejectUnauthorized: false } : false,
});

await client.connect();
const breakers = new Breakers();
let recorded = 0;
let failed = 0;

try {
  /** @param {string} task */
  const chainFor = async (task) =>
    (await client.query("SELECT * FROM ai_chain_for($1,true)", [task])).rows;

  const extractChain = await chainFor("extract");
  const rulesChain = await chainFor("rules");

  if (extractChain.length === 0) {
    console.error("No provider is configured or in quota for the extract task.");
    console.error("Check: SELECT * FROM ai_providers WHERE task = 'extract';");
    process.exit(1);
  }

  console.log(`extract chain: ${extractChain.map((r) => `${r.provider}/${r.model}`).join(" -> ")}`);
  console.log(`rules chain:   ${rulesChain.map((r) => `${r.provider}/${r.model}`).join(" -> ")}`);
  console.log("");

  for (const testCase of fixtures.cases) {
    if (ONLY && testCase.id !== ONLY) continue;

    // A case whose point is that the model refuses cannot be re-recorded from a
    // provider that complies. Its recording is a hand-written refusal and stays put.
    if ((testCase.traps ?? []).includes("model_refusal")) {
      console.log(`  ${testCase.id}: kept (a hand-written refusal cannot be re-recorded live)`);
      continue;
    }

    const extract = await runTask({
      chain: extractChain,
      system: promptSystem("extract.v1"),
      user: [
        `TODAY: ${new Date().toISOString().slice(0, 10)}`,
        `SOURCE URL: (golden fixture ${testCase.id})`,
        "HINTS (overridable by the page, never authoritative): region=none, categories=none",
        "",
        "PAGE TEXT:",
        testCase.document,
      ].join("\n"),
      env: process.env,
      fetch: globalThis.fetch,
      breakers,
    });

    const rules = await runTask({
      chain: rulesChain,
      system: promptSystem("rules.v1"),
      user: [
        "DOCUMENT:",
        testCase.document,
        "",
        "RECORD ALREADY EXTRACTED (context only — do not treat as a source of rules):",
        extract.ok ? JSON.stringify(extract.data) : "{}",
      ].join("\n"),
      env: process.env,
      fetch: globalThis.fetch,
      breakers,
    });

    if (!extract.ok && !rules.ok) {
      failed += 1;
      console.log(`  ${testCase.id}: NO_AI — ${extract.detail}`);
      continue;
    }

    const next = {
      prompt_version: "extract.v1",
      extract_reply: extract.ok ? JSON.stringify(extract.data) : "",
      rules_reply: rules.ok ? JSON.stringify(rules.data) : "",
      recorded_at: new Date().toISOString(),
      recorded_from: extract.ok ? `${extract.provider}/${extract.model}` : "NO_AI",
    };

    recorded += 1;
    console.log(`  ${testCase.id}: recorded from ${next.recorded_from}`);
    if (dryRun) {
      console.log(`      extract: ${next.extract_reply.slice(0, 160)}`);
      console.log(`      rules:   ${next.rules_reply.slice(0, 160)}`);
    } else {
      testCase.recorded = next;
      // Marking the fixture as no longer synthetic would be a lie: the DOCUMENT is
      // still made up. Only the reply is now real.
      testCase.recorded_reply_is_real = true;
    }
  }

  if (!dryRun && recorded > 0) {
    writeFileSync(FIXTURES, `${JSON.stringify(fixtures, null, 2)}\n`);
    console.log("");
    console.log(`Wrote ${recorded} recording(s) to eval/golden/synthetic.json.`);
    console.log("Now run the gate: npm test");
    console.log("If a metric dropped, §12's action column says what to do — and the honest");
    console.log("move is to roll the prompt back rather than to re-record until it passes.");
  }
  if (failed > 0) {
    console.log(`${failed} case(s) could not be recorded because no provider answered.`);
    process.exitCode = 1;
  }
} catch (/** @type {any} */ err) {
  console.error(`\nRecording failed: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
