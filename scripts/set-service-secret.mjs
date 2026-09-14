#!/usr/bin/env node
/**
 * Install or rotate a service secret's digest in the database.
 *
 * The Telegram webhook runs at the edge and therefore holds no database-wide key
 * (SECURITY.md §2). Instead it presents TELEGRAM_BOT_SECRET to five SECURITY
 * DEFINER functions, each of which verifies it against a sha256 digest stored in
 * `service_secrets`. This script is how that digest gets there.
 *
 * Only the digest is stored, so this file — and the database — never hold anything
 * that can be replayed elsewhere.
 *
 * Usage:
 *   TELEGRAM_BOT_SECRET=... DATABASE_URL=... node scripts/set-service-secret.mjs telegram_bot
 *
 * To rotate: generate a new value, run this, then update the Cloudflare secret.
 * In that order — the functions fail closed, so a window where the digest is new
 * and the Worker still holds the old value degrades the bot to public reads rather
 * than opening anything up.
 */

import pg from "pg";

const NAMES = {
  telegram_bot: "TELEGRAM_BOT_SECRET",
};

const name = process.argv[2];
if (!name || !(name in NAMES)) {
  console.error(`Usage: node scripts/set-service-secret.mjs <${Object.keys(NAMES).join("|")}>`);
  process.exit(1);
}

const envVar = NAMES[name];
const secret = process.env[envVar];
const conn = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;

if (!conn) {
  console.error("Set DATABASE_URL for this command only (invariant 11).");
  process.exit(1);
}
if (!secret) {
  console.error(`${envVar} is not set. Generate one: openssl rand -hex 32`);
  process.exit(1);
}
// verify_service_secret rejects anything shorter, and it is better to say so here
// than to install a digest that can never authenticate.
if (secret.length < 16) {
  console.error(`${envVar} must be at least 16 characters. verify_service_secret rejects shorter ones.`);
  process.exit(1);
}

const client = new pg.Client({
  connectionString: conn,
  ssl: /supabase\.(co|com)/.test(conn) ? { rejectUnauthorized: false } : false,
});

await client.connect();
try {
  const { rows } = await client.query(
    `INSERT INTO service_secrets (name, secret_hash)
     VALUES ($1, encode(digest($2,'sha256'),'hex'))
     ON CONFLICT (name) DO UPDATE
       SET secret_hash = EXCLUDED.secret_hash, rotated_at = now()
     RETURNING rotated_at`,
    [name, secret],
  );
  console.log(`Installed digest for '${name}' (rotated_at ${rows[0].rotated_at.toISOString()}).`);
  console.log("The plaintext is not stored. Keep it only in the Worker's secrets.");
} finally {
  await client.end();
}
