#!/usr/bin/env node
/**
 * The batch tier's notification jobs. NOTIFICATIONS.md throughout.
 *
 * Four modes, each a separate scheduled run:
 *
 *   reminders   schedule_deadline_reminders()  — §6, driven by tracker state
 *   digest      assemble and enqueue digests   — §5, per timezone bucket
 *   dispatch    send what the budget allows    — §4, every 15 minutes
 *   retention   purge_expired_data()           — PRIVACY_AND_COMPLIANCE.md §8
 *
 * WHY SO LITTLE LOGIC IS HERE. The caps, the priorities, the quiet hours, the
 * budget rules and the send-time cancellation all live in Postgres functions
 * (migrations 0010 and 0011). This script decides nothing: it asks the database
 * what to send, performs the outbound call, and reports what happened. That is
 * deliberate — the rules are product promises, and a promise enforced in the
 * caller is a promise the next caller breaks.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/notify.mjs dispatch
 *   node scripts/notify.mjs dispatch --dry-run   (renders, sends nothing, rolls back)
 */

import pg from "pg";

const MODES = ["reminders", "digest", "dispatch", "retention"];

const mode = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!MODES.includes(mode)) {
  console.error(`Usage: node scripts/notify.mjs <${MODES.join("|")}> [--dry-run]`);
  process.exit(1);
}

const CONN = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
if (!CONN) {
  console.error("Set DATABASE_URL for this command only (invariant 11).");
  process.exit(1);
}

const BRAND = process.env.BRAND_NAME || "Mbele";
const DOMAIN = process.env.BRAND_DOMAIN || "example.invalid";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BREVO_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER = process.env.BREVO_SENDER_EMAIL || `notifications@${DOMAIN}`;
const OPERATOR_CHAT = process.env.OPERATOR_TELEGRAM_CHAT_ID;

const client = new pg.Client({
  connectionString: CONN,
  ssl: /supabase\.(co|com)/.test(CONN) ? { rejectUnauthorized: false } : false,
});

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * A deadline in words, stated no more precisely than it is known.
 *
 * PRODUCT_SPEC.md §11: a date-only deadline is displayed conservatively — treated
 * as the start of that day — because telling someone they have until the end of a
 * day the organiser may close at 09:00 is the expensive direction to be wrong in.
 */
function countdown(at, precision) {
  if (!at) return null;
  const when = new Date(at);
  if (precision === "date_only" || precision === "month_only") {
    when.setUTCHours(0, 0, 0, 0);
  }
  const hours = (when.getTime() - Date.now()) / 3_600_000;
  if (hours <= 0) return "closed";
  // FLOOR, not round. Rounding 35.9 hours up to "2 days" tells someone they have
  // more time than they do, and PRODUCT_SPEC.md §11 is explicit about which
  // direction to be wrong in.
  if (hours < 24) return `closing in ${Math.max(1, Math.floor(hours))} hours`;
  const days = Math.floor(hours / 24);
  return `closing in ${days} day${days === 1 ? "" : "s"}`;
}

const VERDICT_WORDS = {
  eligible: "You're eligible",
  likely_eligible: "Likely eligible",
  not_eligible: "Not eligible",
  unclear: "Eligibility unclear",
};

const sentenceCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The headline a message leads with, and the email subject. Factual, no urgency tricks. */
function headlineFor(row) {
  const p = row.payload ?? {};
  if (row.type === "digest") return digestSubject(p);
  if (row.type !== "deadline_reminder") return row.reason;

  const head =
    p.kind === "start"
      ? "Starts soon"
      : p.kind === "submission"
        ? "Submission due"
        : sentenceCase(countdown(p.at, p.precision) ?? "");
  const title = p.title ?? "An opportunity you saved";
  return head ? `${head}: ${title}` : title;
}

/**
 * The body, WITHOUT a footer. §7's shape: what it is, why it matters, the link.
 * The reason and the exit are added per channel, because "/pause /stop" means
 * nothing in an email and an unsubscribe URL is noise in a chat.
 *
 * Plain text — no parse_mode, so nothing in an organiser's title can break a
 * message or be misread as markup.
 */
function renderCore(row) {
  const p = row.payload ?? {};
  if (row.type === "digest") return renderDigestText(p);

  const lines = [headlineFor(row)];
  const facts = [p.organisation, p.verdict ? VERDICT_WORDS[p.verdict] : null].filter(Boolean);
  if (facts.length > 0) lines.push(facts.join(". ") + ".");
  if (p.slug) lines.push(`→ https://${DOMAIN}/opportunities/${p.slug}`);
  return lines.join("\n");
}

/** §1.1: every message states why it was sent. §7: and carries an exit. */
function renderTelegram(row) {
  return `${renderCore(row)}\n\n${row.reason}  /pause  /stop`;
}

function renderEmail(row, unsubscribeUrl) {
  return `${renderCore(row)}\n\n${row.reason}\nStop these: ${unsubscribeUrl}`;
}

/**
 * §5.2's plain-text digest. "It must be fully legible as plain text because many
 * recipients read mail on constrained clients" — so the text version is the real
 * one and the HTML is a rendering of it, not the other way round.
 */
function renderDigestText(payload) {
  const sections = payload.sections ?? [];
  const out = [];
  const today = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  out.push(`${BRAND} — ${today}`);

  for (const section of sections) {
    if (!section.items || section.items.length === 0) continue;
    out.push("");
    out.push(section.heading.toUpperCase());
    for (const item of section.items) {
      const bits = [countdown(item.deadline_at, item.deadline_precision)];
      if (item.verdict) bits.push(VERDICT_WORDS[item.verdict].toLowerCase());
      out.push(`• ${item.title} — ${bits.filter(Boolean).join(" — ")}`);
      out.push(`  https://${DOMAIN}/opportunities/${item.slug}`);
    }
  }

  return out.join("\n");
}

/** §5.2: "Subject is factual" — a count, not urgency. */
function digestSubject(payload) {
  const counts = (payload.sections ?? []).map((s) => (s.items ?? []).length);
  const [closing = 0, fresh = 0] = counts;
  const parts = [];
  if (closing > 0) parts.push(`${closing} closing this week`);
  if (fresh > 0) parts.push(`${fresh} new`);
  return parts.length > 0 ? parts.join(", ") : `${BRAND} update`;
}

/**
 * §5.2: HTML is <= 15 KB, no images, no tracking pixel, no web fonts, one link
 * colour. It is built from the plain text so the two cannot disagree.
 */
function textToHtml(text, unsubscribeUrl) {
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return "<br>";
      if (/^https?:\/\//.test(trimmed)) {
        return `<a href="${esc(trimmed)}">${esc(trimmed)}</a><br>`;
      }
      if (trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
        return `<strong>${esc(trimmed)}</strong><br>`;
      }
      return `${esc(line)}<br>`;
    })
    .join("\n");

  return [
    '<div style="font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;max-width:38em">',
    body,
    `<p style="font-size:12px;color:#555">`,
    `<a href="${esc(unsubscribeUrl)}" style="color:#0b5cff">Stop these</a>`,
    `</p>`,
    "</div>",
  ].join("\n");
}

// ── Channels ────────────────────────────────────────────────────────────────

async function sendTelegram(chatId, text) {
  if (!TELEGRAM_TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN not set", permanent: true };

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      // No link previews: they cost the recipient bytes on a metered connection
      // for a thumbnail nobody asked for.
      link_preview_options: { is_disabled: true },
      disable_notification: false,
    }),
  });

  if (res.ok) return { ok: true };
  const body = await res.text().catch(() => "");
  // 403 is "the user blocked the bot" and 400 "chat not found": retrying either
  // only burns quota, and §10 wants those counted towards deactivation.
  return { ok: false, error: `${res.status} ${body.slice(0, 200)}`, permanent: res.status === 403 || res.status === 400 };
}

async function sendEmail({ to, subject, text, html, unsubscribeUrl }) {
  if (!BREVO_KEY) return { ok: false, error: "BREVO_API_KEY not set", permanent: true };

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": BREVO_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: BRAND, email: BREVO_SENDER },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html,
      // §9: one-click unsubscribe in the mail client itself, not only in the body.
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });

  if (res.ok) return { ok: true };
  const body = await res.text().catch(() => "");
  // 400 from Brevo is a rejected address; retrying will not fix it.
  return { ok: false, error: `${res.status} ${body.slice(0, 200)}`, permanent: res.status === 400 };
}

// ── Modes ───────────────────────────────────────────────────────────────────

async function runReminders() {
  const { rows } = await client.query("SELECT schedule_deadline_reminders() AS n");
  console.log(`Deadline reminders: ${rows[0].n} scheduled.`);
}

async function runRetention() {
  const { rows } = await client.query("SELECT purge_expired_data() AS report");
  console.log("Retention job (PRIVACY_AND_COMPLIANCE.md §8):");
  for (const [k, v] of Object.entries(rows[0].report)) {
    if (Array.isArray(v)) {
      console.log(`  ${k}:`);
      for (const line of v) console.log(`    - ${line}`);
    } else {
      console.log(`  ${k}: ${v}`);
    }
  }
}

/**
 * §5: assembled nightly, "delivered per timezone bucket at 06:00 local".
 *
 * The bucket is computed from each user's own timezone rather than a fixed hour in
 * UTC, so this job can run hourly and only ever enqueues for the users for whom it
 * is currently the digest hour. Enqueueing early would mean the quiet-hours logic
 * silently holding it until 07:00 and the "06:00 local" promise quietly becoming
 * something else.
 */
async function runDigest() {
  const { rows: candidates } = await client.query(`
    SELECT u.id, u.email, u.timezone,
           coalesce(s.digest_frequency, 'weekly') AS frequency,
           u.last_seen_at,
           (SELECT max(created_at) FROM notifications n
             WHERE n.user_id = u.id AND n.type = 'digest') AS last_digest_at
      FROM users u
      LEFT JOIN user_notification_settings s ON s.user_id = u.id
     WHERE u.account_state = 'active'
       AND u.deleted_at IS NULL
       AND coalesce(s.digest_frequency, 'weekly') <> 'off'
       AND (s.paused_until IS NULL OR s.paused_until <= now())
       -- 06:00 local, with an hour of tolerance so an hourly job never misses it.
       AND extract(hour FROM now() AT TIME ZONE u.timezone) = 6
  `);

  let sent = 0;
  let suppressed = 0;

  for (const user of candidates) {
    const { rows: items } = await client.query(
      "SELECT * FROM digest_items($1)",
      [user.id],
    );

    const { rows: gate } = await client.query(
      "SELECT digest_should_send($1,$2,$3,$4) AS ok",
      [items.length, user.last_digest_at, user.last_seen_at, user.frequency],
    );

    if (!gate[0].ok) {
      // §5.1 and §1.6: silence is an acceptable outcome, not a failure.
      suppressed += 1;
      continue;
    }

    const sections = [
      { heading: "Closing soon (from your tracker)", items: items.filter((i) => i.section === 1) },
      { heading: "New and open to you", items: items.filter((i) => i.section === 2) },
    ];

    const reason =
      `You're getting this because you saved ${items.filter((i) => i.section === 1).length} ` +
      `opportunit${items.filter((i) => i.section === 1).length === 1 ? "y" : "ies"} and asked for ` +
      `${user.frequency} updates.`;

    if (dryRun) {
      console.log(`\n--- digest for ${user.id} (${user.timezone}) ---`);
      console.log(renderDigestText({ sections, reason }));
      continue;
    }

    await client.query(
      "SELECT enqueue_notification($1,'digest',$2,$3)",
      [user.id, reason, JSON.stringify({ sections, reason })],
    );
    sent += 1;
  }

  console.log(
    `Digest: ${candidates.length} in the 06:00 bucket, ${sent} enqueued, ${suppressed} deliberately silent.`,
  );
}

async function dispatchChannel(channel, limit) {
  const { rows } = await client.query("SELECT * FROM claim_deliveries($1,$2)", [channel, limit]);
  if (rows.length === 0) return { attempted: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    if (!row.address) {
      await client.query("SELECT record_delivery_result($1,false,$2,true)", [
        row.delivery_id,
        `no ${channel} address on file`,
      ]);
      failed += 1;
      continue;
    }

    let result;
    if (channel === "telegram") {
      const text = renderTelegram(row);
      if (dryRun) {
        console.log(`\n--- telegram to ${row.address} ---\n${text}`);
        continue;
      }
      result = await sendTelegram(row.address, text);
    } else {
      const { rows: tok } = await client.query("SELECT issue_unsubscribe_token($1,$2) AS t", [
        row.user_id,
        row.type,
      ]);
      const unsubscribeUrl = `https://${DOMAIN}/unsubscribe?t=${encodeURIComponent(tok[0].t)}`;

      const text = renderEmail(row, unsubscribeUrl);
      const subject = headlineFor(row);

      if (dryRun) {
        console.log(`\n--- email to ${row.address} — ${subject} ---\n${text}`);
        continue;
      }

      result = await sendEmail({
        to: row.address,
        subject,
        text,
        html: textToHtml(text, unsubscribeUrl),
        unsubscribeUrl,
      });
    }

    await client.query("SELECT record_delivery_result($1,$2,$3,$4)", [
      row.delivery_id,
      result.ok,
      result.error ?? null,
      result.permanent ?? false,
    ]);
    if (result.ok) sent += 1;
    else failed += 1;
  }

  return { attempted: rows.length, sent, failed };
}

async function runDispatch() {
  const { rows: requeued } = await client.query("SELECT requeue_stale_claims() AS n");
  if (requeued[0].n > 0) {
    console.log(`Requeued ${requeued[0].n} claim(s) left behind by an earlier run.`);
  }

  // Telegram first: it is free and unmetered, and anything it delivers is an email
  // the budget does not have to find.
  const tg = await dispatchChannel("telegram", 200);
  const em = await dispatchChannel("email", 100);

  console.log(
    `Dispatch — telegram: ${tg.sent}/${tg.attempted} sent, ${tg.failed} failed. ` +
      `email: ${em.sent}/${em.attempted} sent, ${em.failed} failed.`,
  );

  // §4 rule 5, and §10's "alert" rows. Told once a day, to the operator, on the
  // channel that costs nothing.
  const { rows: alert } = await client.query("SELECT budget_alert_due('email') AS msg");
  if (alert[0].msg) {
    const { rowCount } = await client.query(
      `INSERT INTO operator_alerts (kind, detail) VALUES ('email_budget', $1)
       ON CONFLICT (kind, day) DO NOTHING`,
      [alert[0].msg],
    );
    if (rowCount > 0) {
      console.log(`OPERATOR ALERT: ${alert[0].msg}`);
      if (OPERATOR_CHAT && !dryRun) {
        const res = await sendTelegram(OPERATOR_CHAT, `${BRAND} operator alert\n\n${alert[0].msg}`);
        if (res.ok) {
          await client.query(
            "UPDATE operator_alerts SET notified_at = now() WHERE kind='email_budget' AND day=current_date",
          );
        }
      } else {
        console.log("(no OPERATOR_TELEGRAM_CHAT_ID set, so this alert is log-only)");
      }
    }
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

await client.connect();
let failure = null;
try {
  // A dry run must be able to claim deliveries to render them, and must leave no
  // trace of having done so.
  if (dryRun) await client.query("BEGIN");

  switch (mode) {
    case "reminders":
      await runReminders();
      break;
    case "digest":
      await runDigest();
      break;
    case "dispatch":
      await runDispatch();
      break;
    case "retention":
      await runRetention();
      break;
  }

  if (dryRun) {
    await client.query("ROLLBACK");
    console.log("\n(dry run — nothing was sent and nothing was written)");
  }
} catch (err) {
  failure = err;
  if (dryRun) await client.query("ROLLBACK").catch(() => {});
} finally {
  await client.end();
}

if (failure) {
  console.error(`\n${mode} failed: ${failure.message}`);
  // §10: "Digest job fails -> No message sent; alert; never send a stale digest
  // the next day." A non-zero exit is what makes the scheduled run fail loudly
  // instead of quietly doing nothing.
  process.exit(1);
}
