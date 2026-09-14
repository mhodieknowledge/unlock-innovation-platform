/**
 * Engine parity: the TypeScript engine against its SQL mirror.
 *
 * SYSTEM_ARCHITECTURE.md §7 specifies the eligibility engine as "a pure function,
 * implemented once in TypeScript and mirrored as a Postgres function for batch
 * use". Two implementations of the product's spine is a correctness risk that only
 * a test can hold down: a divergence means a different verdict on the web than in
 * Telegram or a nightly digest, which is exactly the inconsistency that destroys
 * trust in a verdict.
 *
 * So the whole golden corpus runs through BOTH, case for case.
 *
 * Not part of `npm test`: it needs a database, and a test that silently skips
 * itself is a vacuous pass waiting to happen. It has its own config and its own
 * CI step, and it FAILS rather than skips when DATABASE_URL is absent.
 *
 *   DATABASE_URL=... npm run parity
 */

import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { evaluate } from "../packages/eligibility/src/index.js";
import type { EligibilityInput, EligibilityRule } from "../packages/eligibility/src/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface GoldenCase {
  id: string;
  name: string;
  covers: string[];
  input: EligibilityInput;
  rules: EligibilityRule[];
}

const CORPUS = JSON.parse(
  readFileSync(join(ROOT, "packages/eligibility/test/golden/golden-corpus.json"), "utf8"),
) as { as_of_default: string; cases: GoldenCase[] };

const CONN = process.env["DATABASE_URL"] ?? process.env["SUPABASE_DB_URL"];

// A random secret per run, so a parity run can never leave a predictable bot
// secret installed in a database that outlives it. It is rolled back anyway.
const BOT_SECRET = createHash("sha256").update(randomUUID()).digest("hex");
const CHAT_ID = `parity-${randomUUID().slice(0, 8)}`;

interface Mismatch {
  id: string;
  name: string;
  ts: string;
  sql: string;
  covers: string;
}

let client: pg.Client;
const mismatches: Mismatch[] = [];
let compared = 0;
let skipped = 0;

beforeAll(async () => {
  if (!CONN) {
    throw new Error(
      "Set DATABASE_URL for this command only (invariant 11). This check is not allowed to skip.",
    );
  }

  client = new pg.Client({
    connectionString: CONN,
    ssl: /supabase\.(co|com)/.test(CONN) ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  await client.query("BEGIN");

  // The SQL side uses now() for age arithmetic and takes no asOf, so only cases
  // pinned to the corpus default are comparable. Freezing the clock would be
  // better; pg has no supported way to do that inside a transaction.
  const asOfDefault = new Date(CORPUS.as_of_default);
  const { rows: yearRows } = await client.query<{ y: number }>(
    "SELECT extract(year FROM now())::int AS y",
  );
  if (yearRows[0]!.y !== asOfDefault.getUTCFullYear()) {
    throw new Error(
      `Corpus as_of year (${asOfDefault.getUTCFullYear()}) differs from the database's current year (${yearRows[0]!.y}). ` +
        "Age cases cannot be compared. Update as_of_default, or run this when they agree.",
    );
  }

  await client.query(
    `INSERT INTO service_secrets (name, secret_hash)
     VALUES ('telegram_bot', encode(digest($1,'sha256'),'hex'))
     ON CONFLICT (name) DO UPDATE SET secret_hash = EXCLUDED.secret_hash`,
    [BOT_SECRET],
  );

  const userId = randomUUID();
  await client.query("INSERT INTO users (id, email, age_confirmed_18) VALUES ($1, $2, true)", [
    userId,
    `parity-${userId}@example.invalid`,
  ]);
  await client.query(
    `INSERT INTO notification_channels (user_id, channel, address, verified_at)
     VALUES ($1,'telegram',$2,now())`,
    [userId, CHAT_ID],
  );

  const orgId = randomUUID();
  await client.query("INSERT INTO organisations (id, name, slug) VALUES ($1,$2,$3)", [
    orgId,
    "Parity Org",
    `parity-org-${orgId.slice(0, 8)}`,
  ]);
  const { rows: cat } = await client.query<{ id: string }>(
    "SELECT id FROM categories WHERE code='grant'",
  );

  for (const testCase of CORPUS.cases) {
    // The mirror reads ONE profile per chat, so each case rewrites the profile
    // before it runs. That is also a fair test of the real path.
    const p = testCase.input as Record<string, unknown>;
    await client.query(
      `INSERT INTO eligibility_profiles (
         user_id, country_of_residence, nationalities, birth_year, student_status,
         year_of_study, institution_type, years_experience, languages, gender,
         can_travel, remote_only
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (user_id) DO UPDATE SET
         country_of_residence = EXCLUDED.country_of_residence,
         nationalities        = EXCLUDED.nationalities,
         birth_year           = EXCLUDED.birth_year,
         student_status       = EXCLUDED.student_status,
         year_of_study        = EXCLUDED.year_of_study,
         institution_type     = EXCLUDED.institution_type,
         years_experience     = EXCLUDED.years_experience,
         languages            = EXCLUDED.languages,
         gender               = EXCLUDED.gender,
         can_travel           = EXCLUDED.can_travel,
         remote_only          = EXCLUDED.remote_only`,
      [
        userId,
        p["country_of_residence"] ?? null,
        p["nationalities"] ?? [],
        p["birth_year"] ?? null,
        p["student_status"] ?? null,
        p["year_of_study"] ?? null,
        p["institution_type"] ?? null,
        p["years_experience"] ?? null,
        p["languages"] ?? [],
        p["gender"] ?? null,
        p["can_travel"] ?? null,
        p["remote_only"] ?? null,
      ],
    );

    const oppId = randomUUID();
    await client.query(
      `INSERT INTO opportunities
         (id, slug, title, category_id, organisation_id, status, last_verified_at, cost, source_url)
       VALUES ($1,$2,$3,$4,$5,'published',now(),'free','https://example.invalid/x')`,
      [oppId, `parity-${oppId.slice(0, 12)}`, testCase.name.slice(0, 200), cat[0]!.id, orgId],
    );

    // A rule with a blank quote cannot be stored: invariant 2 is a CHECK
    // constraint. Those cases test the engine's own defence against a bad write
    // path, which has no SQL counterpart to compare against.
    const storable = testCase.rules.filter((r) => String(r.source_quote ?? "").trim() !== "");
    if (storable.length !== testCase.rules.length) {
      skipped += 1;
      continue;
    }

    for (const rule of storable) {
      await client.query(
        `INSERT INTO eligibility_rules (opportunity_id, rule_type, params, source_quote, confidence)
         VALUES ($1,$2,$3,$4,$5)`,
        [oppId, rule.rule_type, rule.params ?? {}, rule.source_quote, rule.confidence],
      );
    }

    const tsVerdict = evaluate(testCase.rules, testCase.input, { asOf: asOfDefault }).verdict;

    const { rows } = await client.query<{ verdict: string }>(
      "SELECT verdict FROM bot_verdicts($1,$2,$3::uuid[])",
      [BOT_SECRET, CHAT_ID, [oppId]],
    );
    const sqlVerdict = rows[0]?.verdict ?? "(none)";

    compared += 1;
    if (tsVerdict !== sqlVerdict) {
      mismatches.push({
        id: testCase.id,
        name: testCase.name,
        ts: tsVerdict,
        sql: sqlVerdict,
        covers: testCase.covers.join(", "),
      });
    }
  }
}, 180_000);

afterAll(async () => {
  if (client) {
    // Nothing this test wrote survives it.
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
});

it("compares the whole corpus, so a pass cannot be vacuous", () => {
  expect(compared + skipped).toBe(CORPUS.cases.length);
  // A guard against the failure mode this file exists to prevent: a run that
  // measured almost nothing and reported success.
  expect(compared).toBeGreaterThanOrEqual(50);
});

it("the Postgres mirror agrees with the TypeScript engine on every comparable case", () => {
  const detail = mismatches
    .map((m) => `  ${m.id} ${m.name}\n    TypeScript: ${m.ts}  SQL: ${m.sql}  covers: ${m.covers}`)
    .join("\n");
  expect(
    mismatches,
    mismatches.length === 0
      ? ""
      : `A user must not see one verdict on the web and another in Telegram.\n${detail}`,
  ).toEqual([]);
});

it("reports what it measured", () => {
  console.log(
    `  compared ${compared} case(s), skipped ${skipped} (unstorable by invariant 2)`,
  );
  expect(skipped).toBeLessThanOrEqual(2);
});
