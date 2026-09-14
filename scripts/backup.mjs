#!/usr/bin/env node
/**
 * Backup and — the part that matters — restore.
 *
 * IMPLEMENTATION_PLAN.md §5 lists "nightly backup to R2 with a TESTED RESTORE" in
 * Phase 3's build, and its acceptance criteria say "Backup restore tested and
 * documented". Those are two different claims and only the second one is worth
 * anything: an untested backup is a file, not a recovery plan.
 *
 * So this script has three modes and the middle one is the point:
 *
 *   dump          pg_dump to a local file, compressed
 *   restore-test  restore that dump into a scratch database, assert it came back
 *                 whole, then drop the scratch database
 *   upload        put the dump in R2 (S3-compatible), and prune old ones
 *
 * PRIVACY_AND_COMPLIANCE.md §8 keeps backups 14 days. §9 lists Cloudflare as a
 * processor. FREE_INFRASTRUCTURE.md puts R2 at zero egress cost, which is what makes
 * a nightly full dump affordable.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/backup.mjs dump
 *   DATABASE_URL=... node scripts/backup.mjs restore-test
 *   DATABASE_URL=... R2_* ... node scripts/backup.mjs upload
 *   DATABASE_URL=... node scripts/backup.mjs nightly     all three, in order
 */

import { createHash, createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import pg from "pg";

const exec = promisify(execFile);

const MODES = ["dump", "restore-test", "upload", "nightly"];
const mode = process.argv[2] ?? "nightly";
if (!MODES.includes(mode)) {
  console.error(`Usage: node scripts/backup.mjs <${MODES.join("|")}>`);
  process.exit(1);
}

const CONN_OR_NULL = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
if (!CONN_OR_NULL) {
  console.error("Set DATABASE_URL for this command only (invariant 11).");
  process.exit(1);
}
const CONN = CONN_OR_NULL;

const OUT_DIR = process.env.BACKUP_DIR ?? join(tmpdir(), "mbele-backups");
mkdirSync(OUT_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dumpPath = join(OUT_DIR, `mbele-${stamp}.dump`);

/**
 * pg_dump in custom format.
 *
 * Custom format rather than plain SQL because pg_restore can then rebuild selectively
 * and in parallel, and because a restore test that only checks "the SQL file parses"
 * tests nothing. --no-owner and --no-acl so the dump restores into a scratch database
 * owned by whoever is testing it, which is what makes the test runnable at all.
 */
async function dump() {
  const started = Date.now();
  await exec("pg_dump", [
    "--format=custom",
    "--compress=9",
    "--no-owner",
    "--no-acl",
    "--file",
    dumpPath,
    CONN,
  ]);

  const bytes = statSync(dumpPath).size;
  const sha = createHash("sha256").update(readFileSync(dumpPath)).digest("hex");

  console.log(`Dump: ${dumpPath}`);
  console.log(`  ${(bytes / 1024 / 1024).toFixed(2)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  sha256 ${sha}`);

  if (bytes < 4096) {
    // A dump this small means the connection succeeded and the schema did not come
    // with it. Silently uploading it would leave a backup that restores to nothing.
    throw new Error(`the dump is only ${bytes} bytes — that is not a database`);
  }

  return { path: dumpPath, bytes, sha };
}

/**
 * Restore into a scratch database and check it came back.
 *
 * The assertions are chosen to fail if the dump is structurally complete but
 * semantically empty — which is the failure a size check misses: extensions present
 * but no tables, tables present but no reference data, rows present but the RLS
 * policies gone. That last one matters most here: a restore that loses policies
 * restores the data and drops the protection.
 */
async function restoreTest(path) {
  const admin = new pg.Client({
    connectionString: CONN,
    ssl: /supabase\.(co|com)/.test(CONN) ? { rejectUnauthorized: false } : false,
  });
  await admin.connect();

  const scratch = `mbele_restore_test_${Date.now().toString(36)}`;
  let scratchConn = "";
  try {
    try {
      await admin.query(`CREATE DATABASE ${scratch}`);
    } catch (/** @type {any} */ err) {
      // Managed Postgres often withholds CREATEDB from the application role. That is
      // not a backup failure and must not be reported as one — but it does mean the
      // restore is UNTESTED here, which is the thing §5's acceptance criterion is
      // actually about, so it is said plainly and the exit is non-zero.
      if (/permission denied|must be superuser|not permitted/i.test(String(err?.message))) {
        console.error("::error::This role cannot CREATE DATABASE, so the restore could not be tested.");
        console.error("The dump itself succeeded. Run the restore test against a database where");
        console.error("CREATEDB is available — CI's own Postgres service is the intended place, and");
        console.error("the nightly job should fail rather than upload an untested dump.");
        throw new Error("restore test could not run (no CREATEDB)");
      }
      throw err;
    }

    scratchConn = CONN.replace(/\/[^/?]*(\?|$)/, `/${scratch}$1`);
    if (!scratchConn.includes(scratch)) {
      throw new Error("could not derive a scratch connection string from DATABASE_URL");
    }

    console.log(`Restore test: into ${scratch}`);
    try {
      await exec("pg_restore", ["--no-owner", "--no-acl", "--dbname", scratchConn, path]);
    } catch (/** @type {any} */ err) {
      // pg_restore warns about extension ownership and comments it cannot set as a
      // non-superuser, and exits non-zero for warnings alone. The assertions below
      // are what decide whether the restore worked, not the exit code.
      const text = String(err?.stderr ?? err?.message ?? "");
      const realErrors = text
        .split("\n")
        .filter((line) => /error:/i.test(line) && !/must be owner|permission denied for schema|already exists/i.test(line));
      if (realErrors.length > 0) {
        console.error(realErrors.slice(0, 10).join("\n"));
        throw new Error(`pg_restore reported ${realErrors.length} error(s)`);
      }
      console.log(`  (pg_restore emitted warnings only — ${text.split("\n").length} line(s))`);
    }

    const restored = new pg.Client({ connectionString: scratchConn });
    await restored.connect();

    /** @type {Array<[string, string, (v: any) => boolean, string]>} */
    const checks = [
      [
        "tables",
        "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'",
        (n) => n >= 25,
        "at least 25 public tables",
      ],
      [
        "African countries",
        "SELECT count(*)::int AS n FROM countries WHERE is_african",
        (n) => n === 54,
        "all 54, or the reference data did not come back",
      ],
      [
        "categories",
        "SELECT count(*)::int AS n FROM categories",
        (n) => n === 21,
        "the full category set",
      ],
      [
        "RLS enabled",
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
            AND c.relname <> 'schema_migrations'`,
        (n) => n === 0,
        "no table restored without row-level security — a restore that loses policies restores the data and drops the protection",
      ],
      [
        "policies",
        "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'",
        (n) => n >= 20,
        "the RLS policies themselves",
      ],
      [
        "functions",
        `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
          WHERE ns.nspname = 'public'`,
        (n) => n >= 25,
        "the functions the product's rules live in",
      ],
      [
        "invariant 13 still enforced",
        `SELECT count(*)::int AS n FROM pg_constraint
          WHERE conname = 'opportunities_published_never_charges_to_apply'`,
        (n) => n === 1,
        "the constraint that makes invariant 13 structural",
      ],
      [
        "feature flags all off",
        "SELECT count(*)::int AS n FROM feature_flags WHERE enabled",
        (n) => n === 0,
        "density-gated flags restored disabled (PRODUCT_SPEC.md §24)",
      ],
    ];

    let failures = 0;
    for (const [label, sql, ok, why] of checks) {
      const { rows } = await restored.query(sql);
      const value = rows[0]?.n;
      if (ok(value)) {
        console.log(`  ✓ ${label}: ${value}`);
      } else {
        failures += 1;
        console.log(`  ✗ ${label}: ${value} — expected ${why}`);
      }
    }

    // A write, to prove the restored database is usable and not just readable.
    await restored.query(
      `INSERT INTO organisations (name, slug) VALUES ('Restore probe','restore-probe-${Date.now().toString(36)}')`,
    );
    console.log("  ✓ accepts a write");

    await restored.end();

    if (failures > 0) {
      throw new Error(`${failures} restore check(s) failed — this backup is not a recovery plan`);
    }
    console.log("Restore test passed: the dump rebuilds a working database.");
  } finally {
    if (scratchConn) {
      // Terminate any lingering session or the DROP blocks.
      await admin
        .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [scratch])
        .catch(() => {});
    }
    await admin.query(`DROP DATABASE IF EXISTS ${scratch}`).catch((err) => {
      console.error(`  (could not drop ${scratch}: ${err.message})`);
    });
    await admin.end();
  }
}

// ── R2 upload, S3-compatible, signed by hand ────────────────────────────────
//
// By hand rather than with an SDK: the AWS SDK is tens of megabytes of dependency
// for one PUT, and SECURITY.md §8 counts every batch-tier dependency as
// supply-chain surface. SigV4 is about sixty lines and is specified precisely.

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const sha256hex = (data) => createHash("sha256").update(data).digest("hex");

/**
 * @param {object} args
 * @param {string} args.accountId
 * @param {string} args.bucket
 * @param {string} args.accessKeyId
 * @param {string} args.secretAccessKey
 * @param {string} args.key
 * @param {Buffer} args.body
 */
async function putToR2(args) {
  const host = `${args.accountId}.r2.cloudflarestorage.com`;
  const url = `https://${host}/${args.bucket}/${args.key}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const payloadHash = sha256hex(args.body);

  const canonicalHeaders =
    `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT",
    `/${args.bucket}/${args.key}`,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${args.secretAccessKey}`, dateStamp), region), service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "content-type": "application/octet-stream",
      "content-length": String(args.body.byteLength),
    },
    body: args.body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`R2 PUT failed: ${response.status} ${detail.slice(0, 300)}`);
  }
  return url;
}

async function upload(path) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const bucket = process.env.R2_BACKUP_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    // Loudly, not silently. A nightly job that quietly skips the upload leaves
    // someone believing they have backups.
    console.error("::error::R2 is not configured, so nothing was uploaded.");
    console.error("Needs: CLOUDFLARE_ACCOUNT_ID, R2_BACKUP_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY");
    console.error("Create the bucket and an API token scoped to it alone — a token that can");
    console.error("read every bucket is a token that can read the backups AND everything else.");
    return { uploaded: false };
  }

  const body = readFileSync(path);
  const key = `postgres/${stamp.slice(0, 10)}/${path.split("/").pop()}`;
  const url = await putToR2({ accountId, bucket, accessKeyId, secretAccessKey, key, body });
  console.log(`Uploaded to R2: ${key} (${(body.byteLength / 1024 / 1024).toFixed(2)} MB)`);
  return { uploaded: true, url };
}

/** PRIVACY_AND_COMPLIANCE.md §8: backups are kept 14 days. Local copies, at least. */
function pruneLocal(days = 14) {
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  for (const name of readdirSync(OUT_DIR)) {
    if (!name.endsWith(".dump")) continue;
    const full = join(OUT_DIR, name);
    if (statSync(full).mtimeMs < cutoff) {
      unlinkSync(full);
      removed += 1;
    }
  }
  if (removed > 0) console.log(`Pruned ${removed} local dump(s) older than ${days} days.`);
}

// ── Run ─────────────────────────────────────────────────────────────────────

try {
  if (mode === "dump") {
    await dump();
  } else if (mode === "restore-test") {
    const path = process.env.BACKUP_FILE ?? (await dump()).path;
    if (!existsSync(path)) throw new Error(`no such dump: ${path}`);
    await restoreTest(path);
  } else if (mode === "upload") {
    const path = process.env.BACKUP_FILE ?? (await dump()).path;
    await upload(path);
  } else {
    // nightly: dump, PROVE it restores, then upload. In that order — uploading an
    // untested dump is how a backup strategy becomes a belief.
    const result = await dump();
    await restoreTest(result.path);
    await upload(result.path);
    pruneLocal();
  }
} catch (/** @type {any} */ err) {
  console.error(`\nBackup ${mode} failed: ${err?.message ?? err}`);
  process.exit(1);
}
