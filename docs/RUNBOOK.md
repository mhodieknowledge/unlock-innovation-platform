# RUNBOOK

Operational procedures. Written for the person on their own at 2am, which is the only
audience a runbook has.

Everything here has been run. Where something has NOT been run, it says so.

---

## 1. Restore the database

Tested on every push (`.github/workflows/ci.yml`, "Dump and prove the dump restores")
and nightly against the production dump (`.github/workflows/backup.yml`).

**What you need:** the dump file, a Postgres server you can create a database on, and
`pg_restore` at the same major version or newer than the dump.

```bash
# 1. Get the most recent dump out of R2. Keys are postgres/YYYY-MM-DD/mbele-<stamp>.dump
#    (any S3 client; rclone and the Cloudflare dashboard both work)

# 2. Restore it into an empty database
createdb mbele_restored
pg_restore --no-owner --no-acl --dbname "$RESTORE_URL" mbele-<stamp>.dump

# 3. Prove it came back, rather than assuming
BACKUP_FILE=mbele-<stamp>.dump DATABASE_URL="$RESTORE_URL" npm run backup -- restore-test
```

`pg_restore` **exits non-zero on warnings alone** — it cannot set extension ownership
or comments as a non-superuser. That is expected. The restore test is what decides
whether the restore worked, and it checks the things a size check misses:

| Check | Why it is there |
|---|---|
| ≥ 25 public tables | extensions can restore with no tables at all |
| 54 African countries | the schema can restore with no reference data |
| 21 categories | same |
| RLS on every table | **a restore that loses policies restores the data and drops the protection** |
| ≥ 20 policies | the policies themselves, not just the flag |
| ≥ 25 functions | the product's rules live in functions, not only in tables |
| invariant 13's CHECK constraint | the constraint that makes "never charges to apply" structural |
| every feature flag disabled | PRODUCT_SPEC.md §24 — density-gated surfaces must restore off |
| accepts a write | readable is not the same as usable |

**Retention:** 14 days (PRIVACY_AND_COMPLIANCE.md §8). There is no long-term archive,
deliberately — a backup nobody can restore from is storage, and one nobody has tested
in a year is worse.

---

## 2. A provider disappeared

Symptom: extraction stops, `ai_usage` fills with `error` or `schema_invalid` for one
provider, and the review queue stops growing.

Free catalogues change without notice (AI_SYSTEM.md §2 guardrail 6 names Cerebras
dropping models silently and Gemini removing Pro from the free tier). The fix is a
row, not a deploy:

```sql
-- What the chain currently is, per task
SELECT task, priority, provider, model, enabled FROM ai_providers ORDER BY task, priority;

-- Point it at a model that exists
UPDATE ai_providers SET model = '<the new name>', updated_at = now()
 WHERE provider = 'cerebras' AND task = 'rules';

-- Or take it out of the chain entirely
UPDATE ai_providers SET enabled = false WHERE provider = 'cerebras';
```

Nothing needs restarting. The next batch run reads the table.

**If every provider is gone:** nothing breaks. The site serves, search works, and
ingestion falls back to publisher-authored JSON-LD with no eligibility rules derived —
so verdicts read "unclear", honestly. Prove it any time with
`npm run ingest -- --no-ai`. What you lose is new listings, not the product.

---

## 3. Sources are failing

`npm run reverify -- health` lists every degraded source and alerts the operator when
three or more have been failing for over twelve hours (OPPORTUNITY_INGESTION.md §3).

```bash
npm run sources:check                        # re-check robots for every source
npm run sources:check -- --id <uuid>         # one source
npm run ingest -- --source <uuid> --dry-run  # see what it would produce, write nothing
```

A silently dead source is the most likely cause of catalogue rot, which is why it is
alarmed like an outage rather than logged.

**A source whose robots.txt now disallows us** is not a bug to work around. Set
`is_active = false` and record why in `legal_note`. This has already happened once:
After School Africa's robots.txt disallows `*/feed`, so a source §7 lists as tier-2
RSS is not usable by crawl at all.

---

## 4. Activating a source

Two halves, and only one of them is a machine's to decide.

```bash
npm run sources:check -- --id <uuid>      # robots.txt: objective, recorded automatically
# then read the source's terms yourself and record the judgement:
psql "$DATABASE_URL" -c "UPDATE sources SET tos_posture = 'permits_feeds' WHERE id = '<uuid>'"
npm run sources:check -- --activate <uuid>
```

The activate step refuses until both halves are done. `restricts_automation` still
permits an RSS feed and nothing else (§2.1 rule 9).

Its first five records are reviewed regardless (§4.7).

---

## 5. The email budget ran out

`send_budget` caps email at 280/day — 300 Brevo minus 20 reserved for auth OTP. When
it binds, priority 1–2 still sends, priority 3 needs 40 left, priority 4–5 need 120,
and everything else defers 24 hours twice before downgrading to in-app with a visible
notice (NOTIFICATIONS.md §4).

```sql
SELECT day, channel, sent, cap, exhausted_at FROM send_budget ORDER BY day DESC LIMIT 7;
SELECT * FROM operator_alerts ORDER BY day DESC LIMIT 10;
```

**The fix is not a bigger cap.** 280 emails/day supports roughly 280 daily digest
recipients; Telegram is unmetered and is the scaling plan. If this alert is firing,
the answer is Telegram adoption, and the in-app downgrade notice ("link Telegram to
get it delivered") is the nudge that does it.

---

## 6. Notifications stopped

```bash
npm run notify -- dispatch --dry-run   # renders what would send, writes nothing
```

```sql
-- Anything stuck?
SELECT state, count(*) FROM notification_deliveries GROUP BY state;
-- Claims a crashed dispatcher left behind (the next run requeues them after 20 min)
SELECT count(*) FROM notification_deliveries WHERE state = 'claimed';
```

A notification is always written in-app first, so nothing is lost while a push channel
is broken — only delayed (NOTIFICATIONS.md §2, §10).

---

## 7. A scam got through

```sql
-- Disputed and de-ranked immediately by trigger on the first report; this is the queue
SELECT * FROM review_queue WHERE queue = 'report_scam' AND state = 'open' ORDER BY created_at;
```

Then, per MODERATION_AND_TRUST.md: `status='rejected'` on the opportunity, lower the
source's `trust_score`, and `resolve_report(<id>, true, '<what you found>')` so the
reporter is told and their weight rises.

A confirmed scam should also lower the source: `UPDATE sources SET trust_score =
trust_score - 0.2 WHERE id = ...`. Below 0.4 nothing from that source auto-publishes
again.

---

## 8. Rotating the Telegram bot secret

The webhook holds no database key. It presents `TELEGRAM_BOT_SECRET` to five
SECURITY DEFINER functions which verify it against a digest.

```bash
NEW=$(openssl rand -hex 32)
TELEGRAM_BOT_SECRET=$NEW npm run secret:set telegram_bot   # install the digest first
# then set the Worker secret to $NEW
```

That order on purpose: the functions fail closed, so the window between the two steps
degrades the bot to public catalogue reads rather than opening anything up.

---

## 9. What has NOT been exercised

Stated because a runbook that implies more coverage than it has is worse than a short
one.

| Procedure | State |
|---|---|
| R2 upload | **Never run.** The signing code is written and the request shape is per the S3 spec, but no R2 bucket or token has existed to send it to. First run will either work or produce a 403 from R2 naming the problem. |
| Restore from an R2 object | Never run end to end. Restoring from a local dump file is tested on every push; the missing step is the download. |
| Production deploy | Blocked: the Cloudflare account has no `workers.dev` subdomain registered. One click at the Workers onboarding page. |
| Telegram webhook against the real API | Never run. No bot token has been configured. |
| Brevo send | Never run. No sending domain verified. |
| An LLM provider call against a live API | Never run in this environment — no key present. The provider layer is unit-tested against the OpenAI and Gemini response shapes with an injected fetch, and the NO_AI path is tested end to end. |
