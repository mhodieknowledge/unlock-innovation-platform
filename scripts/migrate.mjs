#!/usr/bin/env node
/**
 * Migration runner. SYSTEM_ARCHITECTURE.md §19: versioned SQL, applied in CI
 * before deploy.
 *
 * Production is forward-only. Down migrations exist because Phase 0's acceptance
 * criterion is "migrations run forward and backward", and because a tested
 * rollback path is the difference between a bad deploy being an inconvenience
 * and being an outage. They are for local and preview use.
 *
 * Usage:
 *   node scripts/migrate.mjs up                apply all pending
 *   node scripts/migrate.mjs down              roll back the most recent
 *   node scripts/migrate.mjs down --all        roll back everything, newest first
 *   node scripts/migrate.mjs status            show applied vs pending
 *   node scripts/migrate.mjs seed              run supabase/seed/*.sql in order
 *
 * Connection comes from DATABASE_URL, or SUPABASE_DB_URL. Never hard-coded, and
 * never written to a file — this repository is public (invariant 11).
 */

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const SEEDS = join(ROOT, "supabase", "seed");

const CONN = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
if (!CONN) {
  console.error(
    "No DATABASE_URL or SUPABASE_DB_URL in the environment.\n" +
      "Set it for this command only; do not add it to a file (invariant 11).",
  );
  process.exit(1);
}

/**
 * Supabase's direct database endpoint (db.<ref>.supabase.co) resolves to IPv6
 * only. GitHub Actions runners have no IPv6 route, so a migration from CI fails
 * with a bare `ENETUNREACH` against an AAAA address and no hint as to why.
 *
 * The fix is the connection pooler, which is IPv4-reachable. Detected here so
 * the error explains itself instead of looking like an outage.
 */
function warnIfDirectSupabaseHost(conn) {
  if (!/@db\.[a-z0-9]+\.supabase\.co/.test(conn)) return;
  const inCi = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  const message = [
    "",
    "This looks like Supabase's DIRECT database endpoint (db.<ref>.supabase.co).",
    "That hostname is IPv6-only, and GitHub Actions runners have no IPv6 route,",
    "so connecting from CI fails with ENETUNREACH.",
    "",
    "Use the connection POOLER string instead. In the Supabase dashboard:",
    "  Connect -> Connection pooling -> Session mode",
    "It looks like:",
    "  postgresql://postgres.<project-ref>:<password>@<region>.pooler.supabase.com:5432/postgres",
    "Note the username carries the project ref, and the host is pooler.supabase.com.",
    "",
    "Session mode (5432) is the right choice for migrations; transaction mode",
    "(6543) does not support every DDL statement.",
    "",
  ].join("\n");

  if (inCi) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
}

warnIfDirectSupabaseHost(CONN);

const client = new pg.Client({
  connectionString: CONN,
  // Supabase requires TLS; local sockets do not offer it.
  ssl: /supabase\.(co|com)/.test(CONN) ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15000,
});

async function ensureTable() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      checksum    text
    )`);
  // SECURITY.md §2: RLS on every table, default deny. This one carries no
  // sensitive data, but "every table" has no exceptions — an exception is how a
  // table that should have had a policy ends up without one. No policy is
  // created, so only the service role (which bypasses RLS) can read it.
  await client.query("ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY");
}

async function listMigrations() {
  const files = await readdir(MIGRATIONS);
  const versions = new Map();
  for (const f of files.sort()) {
    const m = /^(\d+)_(.+)\.(up|down)\.sql$/.exec(f);
    if (!m) continue;
    const [, num, name, dir] = m;
    const version = `${num}_${name}`;
    if (!versions.has(version)) versions.set(version, { version, num, name });
    versions.get(version)[dir] = join(MIGRATIONS, f);
  }
  return [...versions.values()].sort((a, b) => a.num.localeCompare(b.num));
}

const appliedVersions = async () =>
  new Set(
    (await client.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map(
      (r) => r.version,
    ),
  );

/** Each migration runs in its own transaction: a failure leaves no partial state. */
async function apply(migration, direction) {
  const file = migration[direction];
  if (!file) {
    console.error(`  ${migration.version}: no ${direction} migration on disk`);
    return false;
  }
  const sql = readFileSync(file, "utf8");
  try {
    await client.query("BEGIN");
    await client.query(sql);
    if (direction === "up") {
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
        migration.version,
      ]);
    } else {
      await client.query("DELETE FROM schema_migrations WHERE version = $1", [migration.version]);
    }
    await client.query("COMMIT");
    console.log(`  ${direction === "up" ? "▲" : "▼"} ${migration.version}`);
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`  ✗ ${migration.version} (${direction}) failed: ${err.message}`);
    return false;
  }
}

async function up() {
  const all = await listMigrations();
  const done = await appliedVersions();
  const pending = all.filter((m) => !done.has(m.version));
  if (pending.length === 0) {
    console.log("Up to date — no pending migrations.");
    return true;
  }
  console.log(`Applying ${pending.length} migration(s):`);
  for (const m of pending) if (!(await apply(m, "up"))) return false;
  return true;
}

async function down(all = false) {
  const migrations = await listMigrations();
  const done = await appliedVersions();
  const target = migrations.filter((m) => done.has(m.version)).reverse();
  if (target.length === 0) {
    console.log("Nothing to roll back.");
    return true;
  }
  const slice = all ? target : target.slice(0, 1);
  console.log(`Rolling back ${slice.length} migration(s):`);
  for (const m of slice) if (!(await apply(m, "down"))) return false;
  return true;
}

async function status() {
  const all = await listMigrations();
  const done = await appliedVersions();
  console.log("\nMigrations:");
  for (const m of all) {
    console.log(`  ${done.has(m.version) ? "applied " : "pending "} ${m.version}`);
  }
  console.log("");
  return true;
}

async function seed() {
  const files = (await readdir(SEEDS)).filter((f) => f.endsWith(".sql")).sort();
  console.log(`Seeding ${files.length} file(s):`);
  for (const f of files) {
    const sql = readFileSync(join(SEEDS, f), "utf8");
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
      console.log(`  ✓ ${f}`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`  ✗ ${f}: ${err.message}`);
      return false;
    }
  }
  return true;
}

const cmd = process.argv[2] ?? "up";
const flags = process.argv.slice(3);

await client.connect();
try {
  await ensureTable();
  let ok;
  switch (cmd) {
    case "up":
      ok = await up();
      break;
    case "down":
      ok = await down(flags.includes("--all"));
      break;
    case "status":
      ok = await status();
      break;
    case "seed":
      ok = await seed();
      break;
    default:
      console.error(`Unknown command: ${cmd}. Use up | down | status | seed.`);
      ok = false;
  }
  process.exitCode = ok ? 0 : 1;
} finally {
  await client.end();
}
