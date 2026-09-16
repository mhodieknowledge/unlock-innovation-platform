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

## 9. Turning team rooms on, and off again

Rooms ship dark. `feature_flags` has `team_room_entry` and `intent_count_visible` seeded
`false`, and every room surface checks the flag AND the density condition — so with the
flags off, `/opportunities/<slug>/room` is a 404 and the opportunity page shows no CTA and
no count. That is the intended launch state (`PRODUCT_SPEC.md` §24, invariant 4).

To turn them on, once there is enough real catalogue for a room to have anyone in it:

```sql
UPDATE feature_flags SET enabled = true WHERE key = 'team_room_entry';
UPDATE feature_flags SET enabled = true WHERE key = 'intent_count_visible';
```

Check what it will look like before flipping anything — the counts come back even while the
flag is off, which is what makes this a dry run rather than a guess:

```sql
SELECT o.slug, r.state, r.intent_count, r.team_count
  FROM opportunities o, room_state(o.id) r
 WHERE o.status = 'published'
 ORDER BY r.intent_count DESC
 LIMIT 20;
```

`state` reads `disabled` for every row until the flag is on; `intent_count` and
`team_count` are live. A room opens at 3 intents or 1 team, so rows at 2 are the ones worth
watching.

To turn it off: set the flag back to `false`. Nothing is deleted — intents, teams, requests
and threads stay exactly where they are, the routes 404 again, and flipping it back on
restores the rooms as they were. `TEAM_FORMATION.md` §8's kill criterion (under 15% of
enabled rooms reaching 3+ intents after three months) is a decision to make with this
switch, not a code change.

The hourly `collaboration` job (`npm run notify -- collaboration`, in the Notifications
workflow) expires requests and marks dead teams stale. If it stops, requests keep sitting
in people's five pending slots after they should have lapsed:

```
DATABASE_URL=... npm run notify -- collaboration
```

It prints what it changed, and it is safe to run by hand at any time.

---

## 10. Projects: matching, and the two flags

Projects work with the flags OFF and with nobody else on the platform — that is
`COLLABORATION_SYSTEM.md` §1.1 `[PR]`, and it is why `/projects/new` and
`/projects/<slug>` are always live while `/projects` (browse) is a 404 until its floor is
met. Two separate flags, both seeded `false`:

| Flag | Surface | Floor |
|---|---|---|
| `public_project_browse` | `/projects` | 40 public projects |
| `related_projects_on_opportunity` | "Projects aiming at this" on an opportunity | 3 matching public projects |

Check before flipping either:

```sql
SELECT * FROM project_browse_state();     -- state, public_projects, floor
```

Matching runs in two places and must agree: the request tier on save (§1.2's `[PR]`
immediacy) and the nightly batch. Both call `project_match_candidates` in the database and
score with `packages/config/src/project-matching.mjs`, so a change to the weights is a
deploy, not a migration.

```
DATABASE_URL=... npm run match:projects            # all live projects
DATABASE_URL=... npm run match:projects -- --project <uuid> --dry-run
DATABASE_URL=... npm run projects:sweep            # §1.3 inactivity: prompt at 120d, pause at 180d
DATABASE_URL=... npm run embed                     # gives new projects a vector
```

If a project's matches look thin, the usual cause is not the ranking. The gate is the
OWNER'S eligibility verdict, and an opportunity whose rules we could not extract evaluates
to `unclear`, which is deliberately not matched — a match says "this is for you", so it has
to be true. Check with:

```sql
SELECT count(*) FILTER (WHERE v.verdict = 'eligible')      AS eligible,
       count(*) FILTER (WHERE v.verdict = 'likely_eligible') AS likely,
       count(*) FILTER (WHERE v.verdict = 'unclear')       AS unclear,
       count(*) FILTER (WHERE v.verdict = 'not_eligible')  AS not_eligible
  FROM opportunities o
  CROSS JOIN LATERAL user_verdicts(
    (SELECT owner_user_id FROM projects WHERE slug = 'the-project-slug'), ARRAY[o.id]) v
 WHERE o.status = 'published';
```

A high `unclear` count is an extraction-quality problem, not a matching one.

Projects are never auto-deleted. §1.3's sweep prompts once at 120 days and pauses at 180,
and a paused project keeps receiving matches — so "my project disappeared" always means
someone deleted it, and the `deleted_at` column says when.

---

## 11. Organisation claims

A claim from an address at the organisation's own domain needs no operator at all: the
confirmation email is issued by the dispatcher on its next run, and following the link
verifies the organisation. Everything else lands in the `org_claim` review queue at
priority 3, with a 48-hour SLA (`MODERATION_AND_TRUST.md` §7).

```sql
-- What is waiting, and what evidence came with it.
SELECT c.id, o.name, o.slug, c.claim_email, c.email_domain, o.website_domain,
       c.evidence_url, c.created_at
  FROM organisation_claims c
  JOIN organisations o ON o.id = c.organisation_id
 WHERE c.status = 'awaiting_review'
 ORDER BY c.created_at;
```

Decide as an admin (the function checks `is_admin()` and writes the audit row):

```sql
SELECT review_org_claim('<claim-id>', true,  'Checked the staff page.');
SELECT review_org_claim('<claim-id>', false, 'No public evidence of the affiliation.');
```

Approving runs the same code path a domain-matched confirmation does, so there is one
implementation of "this organisation is now verified". Rejecting returns the organisation to
`unclaimed` — not `rejected` — so somebody with a work address can still claim it later; one
person's bad claim must not mark the organisation permanently.

What to check before approving a non-matching claim, in order of how often it matters:

1. Does the evidence page name this person AND this organisation? A staff listing is the
   usual proof; a LinkedIn profile is not, because anybody can write one.
2. Does the organisation's website actually belong to the organisation? A claim on a page we
   created from a directory listing may be a claim on the wrong entity entirely.
3. Is the address a personal one at a shared provider? That is not disqualifying — plenty of
   real programme officers use one — but it is the case where evidence has to carry the whole
   weight.

The confirmation email carries the only copy of the token a claimant can reach. If somebody
loses it, they start a new claim; there is no way to resend, deliberately — resending would
be a way to re-issue a token to whoever asks.

**Turnstile.** `ADR 0002` records why no Turnstile widget is in any page: invariant 12
forbids a third-party script on a public page, and the invariant wins. If automated
submissions or claims ever become a problem, turn on a Cloudflare **managed challenge** for
`/submit` and `/report` at the edge (Security → WAF → custom rule, action *Managed
Challenge*). That issues the same token, the code already checks it once
`TURNSTILE_SECRET_KEY` is set, and no page changes.

---

## 12. Working the queues

`/admin` answers one question — is anything wrong — and everything on it is either work or a
bound on work. The queues are at `/admin/queues/<queue>`, one review card at a time, and
every action is a plain form: no JavaScript, so it works on a phone with a bad connection,
which is when queue-clearing actually happens.

What the SLA numbers mean (`MODERATION_AND_TRUST.md` §7): scam and safety 12 hours, entry
fees 24, claims and duplicates and submissions 48, extraction 72. A priority-1 item past its
SLA fires a Telegram alert on the next dispatcher run — if `OPERATOR_TELEGRAM_CHAT_ID` is
unset the alert is logged instead, and `operator_alerts` keeps it until it can be sent.

```
DATABASE_URL=... npm run notify -- dispatch            # sends queued messages AND alerts
DATABASE_URL=... npm run notify -- dispatch --dry-run  # lists what would be sent
```

```sql
-- Everything waiting, and what has breached.
SELECT queue, count(*), round(max(extract(epoch FROM now() - created_at)/3600.0)) AS oldest_h,
       queue_sla_hours(queue) AS sla_h
  FROM review_queue WHERE state <> 'done' GROUP BY queue ORDER BY 3 DESC;

-- What would alert right now, without recording anything.
SELECT * FROM operator_alerts_due();
```

Roles are a ladder and they are enforced in the database, not the page: a `reviewer` works
queues and rules, a `moderator` adds account actions, a `superadmin` adds sources, flags and
the audit log. Granting one:

```sql
UPDATE users SET is_admin = true, admin_role = 'reviewer'   -- or moderator, superadmin
 WHERE email = 'person@example.org';
```

Nobody at any role can read an eligibility profile, a tracker or an unflagged message. That
is RLS, asserted structurally in `supabase/tests/invariants.sql` and again in
`supabase/tests/admin.sql` against the admin user view's own result type. If you need
eligibility data to debug something, aggregate it — `supabase/tests/` has examples of
non-identifying queries.

**Two things the queue will not let you do,** both deliberate:

- Publish a listing with an entry fee. Invariant 13, enforced in
  `admin_publish_opportunity`. If the fee turns out not to exist, correct `cost` first.
- Save an eligibility rule without quoting the sentence it came from. The editor refuses, the
  table refuses, and the publish gate refuses. Quote the page rather than your reading of it:
  the whole value of the quote is that the next person can check it.

**Extraction quality** is the number to watch on the dashboard. Approve-without-edit under
60% over 50 reviews means the pipeline is making work rather than saving it — the fix is a
prompt change measured against the golden set, not more reviewing.

---

## 13. The service worker, the install prompt and low-data mode

### Deploying a change to the worker

`public/sw.js` bumps `VERSION` for any change that affects what is cached. On activation the
worker deletes every cache whose name is not in the current set, so a bumped version is also
the cache purge. Forgetting to bump it means readers keep the old shell until their browser
happens to re-fetch the script.

`public/_headers` serves `sw.js`, `sw-routes.js` and `sw-register.js` with `Cache-Control:
no-cache`. That is deliberate and must stay: a cached service-worker script outlives the
deploy that replaced it, and a reader can sit on a shell that is weeks old with no way to
know. Revalidation costs a conditional request and usually returns 304.

### Turning offline support off

There is no flag, because a service worker cannot be switched off by configuration — it lives
on the reader's device. To stop it:

1. Replace `public/sw.js` with a worker that calls `caches.keys()`, deletes all of them, and
   then `self.registration.unregister()`. Deploy that.
2. Leave it deployed for at least a week. Every returning reader picks it up on their next
   navigation and removes themselves.
3. Only then remove the file. Deleting `sw.js` first leaves every installed worker in place
   permanently, because the browser only replaces a worker it can still fetch.

### What is cached, and what must never be

`public/sw-routes.js` is the whole answer, and `apps/web/test/service-worker.test.ts` asserts
it path by path. The shape of it: the shell and the hashed assets cache-first; opportunity
pages stale-while-revalidate with an LRU of 50; the tracker network-first; and everything
else — every other personal surface, every thread, every request, every admin view, every
API call — untouched, exactly as if no worker were installed.

If you are tempted to add a personal surface to the cached set, the question to answer first
is not "would this be nice offline" but "is a copy of this acceptable on a phone somebody else
picks up". SYSTEM_ARCHITECTURE.md §3.4 names the tracker and saved items. That list is the
warrant, and it is short on purpose.

### The write queue

Only tracker writes are queued (`write-queue` in the routing table). A queued POST is answered
with a 303 back to `/tracker?queued=1`, which renders the pending line server-side — the
redirect lands on a page served from the cache, so a state that existed only in script would
be invisible to a reader with no JavaScript.

Replay happens on `online`, on a Background Sync event, and on the message the page sends at
registration. A write the server refuses with a 4xx is DROPPED, not retried: migration 0007
refuses an invalid tracker transition, and a queue that retries a refusal never empties. The
reader is told, in one line, however many writes went out.

To inspect a stuck queue on a reader's device you cannot — it is IndexedDB `mbele-outbox`,
store `writes`, on their phone. What you can check is whether the endpoint returns a 4xx for
the write in question, which is the only thing that makes the queue drop something silently.

### The install prompt

It appears in one place: the tracker, once the reader has at least one saved entry, and only
if the browser fires `beforeinstallprompt`. Dismissal is remembered in `localStorage`
(`mbele-install-dismissed`) and never argued again. There is no timer, no modal and no second
ask. If someone asks why they never see it, the answer is usually that Chromium has its own
engagement heuristics, or the app is already installed.

### Low-data mode

Three inputs, in this order: the `ld` cookie, a `Save-Data: on` request header, then the
signed-in account preference. Resolved server-side before the first byte of HTML — a mode
applied by a script after the page arrives has already cost the reader the bytes it exists to
save.

The mode may only change the WEIGHT of a page, never its content. That rule is what makes the
`Vary: Save-Data, Cookie` on the edge-cached pages survivable: Cloudflare honours `Vary` for
very little, so a shared cache may hand a reader the other variant, and the worst that can
happen is a page with two fact cells instead of four.

`apps/web/test/byte-budget-ssr.test.ts` measures the low-data list page against
DESIGN_SYSTEM.md §10's 40 KB target on every push, and asserts that the lighter page is still
the same page — same heading, same rows — because a 2 KB error page would pass a byte budget
and mean nothing.

---

## 14. SEO surfaces: the matrix, the sitemaps and the feeds

### The five-item floor

`/countries/<country>/<category>` exists only when that cell holds at least five currently-open
opportunities. Below that it answers **301** to the country page. The number lives in exactly one
place — `SEO_MATRIX_FLOOR` in `packages/config/src/seo.ts` — and is read by the route that
redirects and the sitemap that lists these URLs. Change it there and both move together; there is
nowhere else to change it.

To see the whole matrix as the database sees it:

```sql
SELECT iso2, category_code, open_count
  FROM country_category_counts()
 WHERE open_count >= 5
 ORDER BY open_count DESC;
```

If a page you expect is redirecting, that query is the answer: the cell is below five. That is the
rule working, not a bug. The country page still lists the category and links it to the filtered
list instead.

### When a count looks wrong

Every count on a country page comes from `country_open_counts()`, and every list on it comes from
the same predicate — `open_to_country(scope, eligible_countries, iso2)`. If a count and a list
disagree, one of them is not using that function, and the fix is to make it use it rather than to
adjust a number.

The predicate is coarse on purpose: it ignores `excluded_countries`. An opportunity open to Africa
except Egypt is still open to Africa, and an Egyptian reader gets `not_eligible` from the rules
engine with the sentence that says so. Filtering it out of discovery would hide the record from
the one person who most needs to see why it is not for them.

### Region-scoped records

A record extracted as `eligibility_scope = 'region'` is expanded to countries **on write**, by the
trigger in migration 0024, using `regions.member_countries` and nothing else. So `region_codes` is
provenance and `eligible_countries` is what every filter reads.

The region taxonomy in the seed follows the UN M49 subregions. That means `southern_africa` is
Botswana, Lesotho, Namibia, Eswatini and South Africa — **Zimbabwe, Zambia, Malawi and Mozambique
are `eastern_africa`**. It surprises people, including native speakers of the phrase. It is also
why AI_SYSTEM.md §5 insists region words are expanded from our own table rather than by a model: a
model asked to list Southern Africa would include Zimbabwe, and the answer has to match the table
the filters read. If the taxonomy is ever changed, re-run the backfill:

```sql
UPDATE opportunities SET region_codes = region_codes
 WHERE eligibility_scope IN ('region','country_list')
   AND array_length(region_codes, 1) IS NOT NULL;
```

That is a no-op write whose only purpose is to fire the trigger, which is the intended way to
re-expand every record.

### Sitemaps

`/sitemap.xml` is an index over six segments: opportunities, countries, categories, organisations,
public-profiles, static. All six are rendered on demand with an hour of edge cache rather than
regenerated nightly — a crawler that arrives an hour after we publish should find the new URL, and
an hour of cache is the whole cost of that.

Segmented because ANALYTICS-style measurement needs it: Search Console reports indexed-page counts
per sitemap, so "indexed pages by type" (SEO.md §8) is a number you can read rather than infer,
and the thin-content redirect rule misfiring shows up as one segment collapsing.

`public-profiles.xml` is empty until somebody sets both `visibility = 'public'` and
`indexable = true`. That is correct output, not a fault: two opt-ins, and the second one defaults
off.

### robots.txt

Generated from the same `INDEXING` table the pages and the sitemaps read, so a private route added
there is disallowed without anybody remembering to do it. Three layers protect a private surface —
`noindex` on the page, `Disallow` here, and no session means no page — because, as SEO.md §1 puts
it, "one will eventually be misconfigured".

`apps/web/test/seo-route.test.ts` audits the first layer by reading every page file under a private
prefix, which is how a new private route with no `noindex` gets caught on the day it is written
rather than after it is indexed.

### Feeds

Four: `/feeds/closing-soon.xml`, and one per country, category and organisation. RSS 2.0, no
dependency, and deliberately **no `pubDate`** — readers sort and de-duplicate on it, and the honest
publication date of an opportunity is when the organiser opened it, which we usually do not know.
Using our own ingestion time would make a six-month-old call look new every time we re-verified it.
The `guid` is the opportunity URL, which is stable and is what a reader wants de-duplicated on.

SEO.md §7's reason for caring: "our feed can propagate through the ecosystem's existing
distribution rather than competing with it." The audience already reads opportunities in Telegram
channels, and a channel bot can consume these directly.

### The social card

One static 1200×630 PNG for the whole site, at `apps/web/public/og.png`, regenerated with
`npm run og:card`. `scripts/og-card.mjs` writes the PNG itself — zlib and a CRC, about a hundred
lines — because every library that could draw a flat brand card is tens of megabytes of native
build for one 5 KB file that changes when the brand does. `twitter:card` is `summary`, so the
preview stays small on a metered connection (§4's `[PR]` trade).

If the brand name or colour changes: `styles/tokens.css` first, then `scripts/og-card.mjs` and
`public/icon.svg`, then re-run the generator. A test asserts the file is a real PNG at the right
size and under 25 KB, so a forgotten regeneration fails the build rather than shipping a stale
card.

---

## 15. The accessibility, contrast and copy audits

Three suites run on every push, and between them they are Phase 11's automatable half. What each
one proves, and what it does not, matters when somebody asks whether this product is accessible.

### `apps/web/test/a11y.test.ts` — axe on every public route

Renders all 24 public routes through Astro's container API and runs axe-core over each in jsdom,
with the WCAG 2.0/2.1 A and AA tags plus best-practice. It catches the machine-checkable half of
DESIGN_SYSTEM.md §8: an unlabelled control, an image with no alt text, a heading level skipped, an
aria attribute that does not apply, a duplicate id, a link with no accessible name.

It also asserts the things that defeat reflow at 200% zoom — a viewport that blocks pinch, a fixed
pixel width wider than a phone, a horizontal scroller on anything that is not a code block — and
that every `<time>` carries a `datetime`.

A route added and not listed fails the suite: the last test walks `src/pages` and compares.

**It does not check colour contrast.** axe samples rendered pixels through a canvas jsdom has no
implementation of. That is what the next suite is for.

### `apps/web/test/contrast.test.ts` — every token pair, computed

Parses `tokens.css` and computes the WCAG ratio for every pair the design system permits — 4.5:1
for text, 3:1 for a focus ring and for the boundary of a form control (SC 1.4.11). Stronger than
axe's check, because it covers pairs no page has used yet, which are the ones a future page will
get wrong.

Two token values changed in Phase 11 because this suite said so:

- `--color-ink-3` was `#787f87`, which measured **4.05:1** on white — under AA for text at every
  size this product uses it at. Now `#686e74` (5.16 / 4.98 / 4.56 on surface / paper / sunken).
- `--color-line-strong` was `#c7c8c2`, which measured **1.68:1** — and it draws the boundary of
  every input, select, textarea and bordered button. A field a sighted reader could see and a
  low-vision reader could not. Now `#858b91` (3.44 / 3.32 / 3.04).

`--color-line` stays below 3:1 deliberately: it is the hairline between rows, SC 1.4.11 exempts
pure decoration, and a list of forty rows separated by a 3:1 line is a cage rather than a list. A
test asserts no form control is ever drawn with it, which is what keeps that exemption honest.

If you add a colour token, add it to `TEXT_TOKENS` or to the non-text block in that file. A token
nothing asserts is a token nobody has checked.

### `apps/web/test/copy.test.ts` — the voice rules

Reads every page source with the code and comments stripped, and fails on: "Oops", an apology, a
blame, "Nothing here yet", an exclamation mark, a pictographic emoji, "click here", "simply",
"easy", "please wait", and the marketing adjectives CONTENT_AND_LAUNCH.md §4 names. It also
asserts every listing surface has an empty-state branch with something to do in it, that no page
animates a spinner (§6.3), and that every `<button>` is at least 44px tall (§8).

It checks WORDS, not tone. Tone is a human's job and always will be.

The typographic glyphs are deliberately allowed: `● ◐ ○ ✓ ✕ ？ ⚠` are the vocabulary §6.2 and §8
require, because "every colour-coded state has a glyph and a label". A letterform doing a job is
not an emoji doing a mood.

### What none of them replace

A keyboard pass, a screen-reader pass, and a real phone on a real network. Those are named in §16
as not done, and no amount of this is a substitute for them.

---

## 16. Putting it online

The pipeline is `.github/workflows/deploy.yml`, on every push to `main`. It stops early with a
notice when the Cloudflare credentials are absent, so a fork never fails confusingly.

**The address** the Worker publishes to is decided in precedence order, and the last step means
nothing has to be configured for a deploy to work at all:

| # | Source | Result |
|---|---|---|
| 1 | `CUSTOM_DOMAIN` variable | Published at that domain; workers.dev is never involved |
| 2 | `BRAND_DOMAIN` variable | Same, when it is a real domain rather than a placeholder |
| 3 | `WORKERS_DEV_SUBDOMAIN` variable | Published at `mbele-web.<name>.workers.dev` |
| 4 | **the brand name**, lower-cased | The default. `mbele` → `mbele-web.mbele.workers.dev` |

Steps 1–3 are repository *variables* (Settings → Secrets and variables → Actions → Variables), not
secrets; none is sensitive.

Step 4 is the reason this deploys out of the box, and it is not the workflow inventing a name: it
reads `BRAND.name` from `packages/config/src/brand.mjs`, the one module PRODUCT_SPEC.md §1 allows
the brand to live in. A rebrand moves the address with it instead of leaving a stale word in a
workflow file.

A workers.dev subdomain is account-wide and **permanent once registered** — Cloudflare keeps it.
The workflow registers it through the API on the first run and does nothing on every run after.
A name already taken by another account fails loudly, and the fix is the `WORKERS_DEV_SUBDOMAIN`
variable.

**Moving to a real domain later** costs one variable and one push. Nothing in the code carries the
address.

**The Worker's environment is not the build's environment**, and this is the one thing about this
pipeline worth reading twice, because the first live deployment got it wrong.

`npm run build` runs with `SUPABASE_URL` and `SUPABASE_ANON_KEY` in its environment, which is
correct for anything inlined at build time and does nothing whatsoever for a Worker serving a
request an hour later. What the Worker has at runtime is what `wrangler deploy` binds, and
`wrangler.jsonc` bound `BRAND_NAME` and `ENVIRONMENT`. So the first deployment served an
unconfigured database client on every page — an empty state on the board, on every country, in
every sitemap — and its smoke test, which asked only `/api/health`, called it green.

The deploy now binds them, in a step of its own:

| Where | Which keys | Why there |
|---|---|---|
| `--var` on `wrangler deploy`, from repository **variables** | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TELEGRAM_BOT_HANDLE`, the three model names | A Cloudflare **var is stored and displayed in plaintext** — in the dashboard, and to anything reading the account through the API. A key is only here if it is publishable. The anon key is: it ships to browsers by design and RLS is the boundary (SECURITY.md §2). |
| `wrangler.jsonc` | `BRAND_NAME`, `ENVIRONMENT` | Committed, non-secret, the same in every deploy. `wrangler deploy` prints the value of a var that comes from this file in full, and masks a `--var` as `("(hidden)")` — which is the other reason nothing sensitive belongs in a committed config. |
| Nowhere in the request tier | the service-role key | SECURITY.md §2. It exists only in GitHub Actions secrets, for the batch tier. |

`SUPABASE_URL` and `SUPABASE_ANON_KEY` missing now **fails the deploy** rather than publishing a
site that answers 200 to everything and shows an error state on every page. The remaining keys are
optional in the code — `apps/web/src/lib/runtime.ts` declares every one the request tier reads, and
each unconfigured key degrades its own feature instead of failing a page. An unset key is skipped
rather than bound empty, because `--var SENTRY_DSN:` would make `if (!dsn)` false and send
envelopes nowhere.

Secrets — `GROQ_API_KEY`, `IP_HASH_SALT`, `TURNSTILE_SECRET_KEY`, the Telegram tokens, `SENTRY_DSN`
— are **not yet bound to the Worker at all**; the features that need them are off in production,
which is a state each of them supports. They need `wrangler secret bulk`, not `--var`, for the
reason in the table.

**What happens on a successful run**, in order: migrations, reference seed, build, byte budgets,
decide the address, register the workers.dev subdomain if needed, bind the environment, publish,
then a smoke test against the URL the deploy itself reported — no extra variable needed. The live
URL is printed as a notice and in the run summary.

**The smoke test asks a real page for real HTML**: `/api/health`, then the board's status, the
board's own copy (and the *absence* of its error copy), a `content-security-policy` header on an
SSR response, and `/privacy` answering 200 rather than a redirect. It used to ask `/api/health`
alone — the one route in the app that reads no configuration and touches no database, which is to
say the one route that could not fail when everything else had. A liveness check that cannot fail
when the site is broken is not a check. For the itemised version, `npm run verify:deployment -- <url>`
runs 39 of them from outside.

**After the first successful deploy**, three things need doing by hand:

1. **Supabase → Authentication → URL Configuration.** Add the deployed origin to the redirect
   allowlist, or sign-in completes and bounces to nowhere.
2. **Set the `BRAND_DOMAIN` variable.** With it unset, `packages/config/src/brand.mjs` falls back
   to `example.invalid` — a TLD that cannot resolve, by RFC 2606 — and seven live pages publish an
   address that will bounce: the privacy contact PRIVACY_AND_COMPLIANCE.md §7 item 4 requires to be
   "published and monitored", the takedown address OPPORTUNITY_INGESTION.md §2.1 rule 8 gives a
   48-hour SLA, `security.txt`, and the crawler's own `+https://…/bot` URL, which rule 3 requires to
   point at a page that explains it. One variable fixes all seven and the crawler's User-Agent with
   them; `npm run verify:deployment` fails each one by name until it is set. The value is a
   decision, not a default — README.md §6 item 1 has the domain outstanding along with trademark
   clearance.
3. **Nothing else.** The catalogue is empty and every density flag is off, so what publishes is an
   honest empty product: the board says nothing is published yet, the country pages say what they
   have, and no social surface exists. §9–§12 are how each one comes on.

---

## 17. What has NOT been exercised

Stated because a runbook that implies more coverage than it has is worse than a short
one.

| Procedure | State |
|---|---|
| R2 upload | **Never run.** The signing code is written and the request shape is per the S3 spec, but no R2 bucket or token has existed to send it to. First run will either work or produce a 403 from R2 naming the problem. |
| Restore from an R2 object | Never run end to end. Restoring from a local dump file is tested on every push; the missing step is the download. |
| Production deploy | **Done and verified from outside.** `npm run verify:deployment -- https://mbele-web.mbele.workers.dev` passes all 43 checks: the board 200 with server-rendered copy and all six security headers, 55 countries and 22 categories in the sitemaps from the live database, every public route, the auth gate, the PWA assets, and an honest 404. Before that: Migrations and the reference seed have run against the production Supabase on every deploy since the Cloudflare credentials were added. The publish step failed on the first 22 of them — no `workers.dev` subdomain and no route, and `wrangler`'s answer to that is an interactive prompt, which in CI is an exit code — and has succeeded since the address became configuration with a default (§16). The first Worker to go up served 500 on every database-backed page, because the deploy bound no Supabase configuration to it and nothing in the pipeline asked a real page whether it worked; both are fixed, and §16 says how. |
| A published address that can receive | **None can.** Seven live pages carry an `@example.invalid` address and the crawler's User-Agent points at `https://example.invalid/bot`, because no `BRAND_DOMAIN` is configured. Nothing has been sent to any of them and no crawl has left the machine, so nothing has bounced yet — but the privacy policy currently states a contact route that does not exist, which is a compliance claim that is not true. §16 step 2. |
| A real browser on the live site | **Never.** Everything asserted about the deployment is asserted over HTTP by `scripts/verify-deployment.mjs` — status codes, headers, copy, XML. Nobody has opened it in a browser, so nothing visual, nothing about focus order and nothing about the install prompt has been seen on the real origin. |
| Secrets bound to the Worker | **Never.** `GROQ_API_KEY`, `IP_HASH_SALT`, `TURNSTILE_SECRET_KEY`, the Telegram tokens and `SENTRY_DSN` are in GitHub Actions for the batch tier and are not bound to the Worker, so in production: the query compiler is heuristic-only, rate-limit keys use the coarse fallback, Turnstile verification is skipped exactly as ADR 0002 describes, no Telegram message can be sent from a request, and errors are logged rather than reported. Each is a state the code supports; none has been exercised with a real value in the request tier. |
| Workers AI and the KV query cache in production | **Never bound.** `wrangler.jsonc` declares no `ai` binding and no `QUERY_CACHE` namespace, so hybrid search runs its FTS half and the embedding half returns null. The degraded path is asserted in `apps/web/test/search.test.ts`; what has not happened is the undegraded one on the live origin. |
| Telegram webhook against the real API | Never run. No bot token has been configured. |
| Brevo send | Never run. No sending domain verified. |
| An LLM provider call against a live API | Never run in this environment — no key present. The provider layer is unit-tested against the OpenAI and Gemini response shapes with an injected fetch, and the NO_AI path is tested end to end. |
| Team rooms with real people in them | Never. Every rule is asserted in `supabase/tests/collaboration.sql` (109 assertions) and the route behaviour in `apps/web/test/room-route.test.ts`, but no two humans have used a room to form a team, and the flags are off. The first real room will teach us something the tests cannot. |
| The thread poller against a real browser | The endpoint's 304 path is not covered by a test that drives a browser; the handler is straightforward and the page degrades to "reload to see replies" if the script never runs. |
| Project matching against a real catalogue | The scorer is unit-tested and the whole path was run end to end against fixture rows in a local Postgres (two opportunities, one project, embeddings from the local model). What has never happened is a match over a real catalogue with real eligibility rules, which is the only thing that will show whether the weights in §1.5 are right. |
| An organisation claim by a real organisation | The whole flow was exercised against real rows in a local Postgres — claim, dispatcher render, confirm, publish as `official`, edit a deadline, re-review — but no real organisation has ever claimed a page, and the confirmation email has never left the machine (no Brevo sending domain). |
| The admin queues with real volume | Every function and page is tested, and the whole review path was exercised against fixture rows (claim, review card, rule editor, publish, reject, merge, report resolution, user action, source activation, flag change, audit read). What has never happened is a reviewer clearing a real queue on a real phone, which is the only way to find out whether one-handed operation actually works. |
| A Telegram operator alert | The alert fires, records and re-sends correctly against a real breached queue item; the send itself has never left the machine because no bot token is configured. The first live run will either work or return a Telegram error naming the problem. |
| A Turnstile token | Never seen one. `verifyTurnstile()` is written and called; no key is configured and no widget is in any page (ADR 0002). |
| A keyboard-only pass | **Never.** Focus order, focus visibility, focus restoration after a form submit and whether a bottom sheet traps focus are all §8 requirements that need a keyboard and a person. axe checks that controls have names and roles; it cannot check the order they come in. |
| A screen reader | **Never.** §8 specifies what a verdict and a countdown should SAY ("Likely eligible. Three of four requirements met. One needs your birth year."), and the strings exist and are announced through an `aria-live` region — but nobody has heard them. The first NVDA or TalkBack pass will find phrasing that reads badly out of context. |
| Search latency against a real deployment | The p95 is asserted on every push (`test/search.test.ts`), against a real Postgres with the real indexes — which is what catches a missing index. It is NOT a production number: no network in the path, a dozen rows in the corpus, and a machine that is not the free tier. The first real measurement has not happened. |
| Field performance on a real device | **Never.** Every byte budget is measured from real rendered HTML and the real built CSS, gzipped, on every push. What has not happened is a mid-tier Android on a throttled 3G connection, which is what IMPLEMENTATION_PLAN.md §13 actually asks for and the only thing that produces a true LCP number. |
| Zoom to 200% in a browser | Never, as a human check. The things that defeat reflow — a locked viewport, a fixed width wider than a phone, a stray horizontal scroller — are asserted on every public route; the visual result at 200% has not been looked at. |
| Google or Bing actually crawling any of this | **Never.** No domain has been registered and nothing has been deployed, so no crawler has seen a sitemap, a `noindex`, a 301 from a thin matrix cell or a JSON-LD graph. The markup is asserted field by field against SEO.md §3 in `apps/web/test/seo.test.ts`, and the redirect from both sides of the floor in `seo-route.test.ts`, but the Rich Results Test has never been run against a live URL. The first deploy is where a schema property Google requires and we omit will show up as a warning. |
| An RSS reader or a Telegram channel bot consuming a feed | Never. The XML is asserted to be well-formed RSS 2.0 with absolute links and a stable guid; no reader has subscribed. |
| The country × category matrix at real scale | The floor, the counts and the redirect are tested against fixtures. What has never happened is 54 × 21 cells over a real catalogue, which is the only thing that will show whether five is the right floor. |
| The service worker in a real browser | **Never.** The routing rules are asserted path by path in `apps/web/test/service-worker.test.ts`, and the four strategies are 150 lines of hand-written code with no framework in them — but no browser has installed this worker, read a cached opportunity page with the network off, or replayed a queued tracker write. The first real test of it is somebody on a load-shedding schedule, and what it will most likely find is a wrong assumption about `Response.redirect` inside a fetch handler. |
| The install prompt | Never seen. `beforeinstallprompt` only fires on a served origin over HTTPS with a valid manifest and an icon, and this has never been served. The manifest and the icon are asserted in the same test file; the browser's own engagement heuristics are not something a test can stand in for. |
| Low-data mode on a metered connection | The 40 KB target is measured on every push, from real rendered HTML and the real built CSS. What has never happened is somebody browsing on a Zimbabwean prepaid bundle and telling us whether the two-fact row is still usable — which is the only question that matters about it. |
| Workers AI embedding in the request tier | Never called. `PROJECT_EMBEDDING_MODEL` is unset, so project creation stores no vector and the first-pass match ranks on tags and urgency — a supported degraded state, and the batch embedder fills the vector in overnight. |

## 18. From an empty catalogue to a public launch

§16 gets a Worker serving. This section is the rest of the distance, in order, and it is written
because the two are easy to confuse: the deployment is correct and the board is empty, and those
are not the same problem. Nothing below is a bug.

**Where it stands.** The site serves at `https://mbele-web.mbele.workers.dev`. The reference data
is live — 55 countries, 22 categories, the region graph — which is why every country and category
page renders. `opportunities` has zero rows, `sources` has 24 rows and **every one of them is
inactive by design**, and no account has admin rights. So the board shows "Nothing open to
Zimbabwe is closing yet", which is CONTENT_AND_LAUNCH.md §1 working: with nothing published, the
honest output is no number at all.

The chain from here to a row on the board is: **sign-in works → you are an admin → a source is
active → ingestion runs → you review what it found → it publishes.** Every link is required and
the order matters.

### Step 1 — Make sign-in work `(Supabase dashboard, 2 minutes)`

Authentication → URL Configuration:

* **Site URL**: `https://mbele-web.mbele.workers.dev`
* **Redirect URLs**: add `https://mbele-web.mbele.workers.dev/auth/callback`

Without this the magic link completes and lands nowhere, and every step below needs an account.

### Step 2 — Give yourself the admin role `(SQL editor, 1 minute)`

Sign in once at `/signin` first, so the `users` row exists. Then:

```sql
UPDATE users SET is_admin = true, admin_role = 'superadmin' WHERE email = '<your email>';
```

`/admin` returns a sign-in redirect for everyone else and will keep doing so — ADMIN_SYSTEM.md's
role gate is an RLS policy, not a page check, so there is no way to grant this from the UI. The
three roles are `reviewer`, `moderator` and `superadmin`; take `superadmin` for the first account
and hand out narrower ones later.

### Step 3 — Set `BRAND_DOMAIN` `(repository variable, 1 minute — a decision, not a default)`

Settings → Secrets and variables → Actions → **Variables** → `BRAND_DOMAIN`.

Until it is set, seven live pages publish `@example.invalid` addresses and the crawler introduces
itself with a URL that does not exist — see §16 step 2. `npm run verify:deployment` fails each of
the seven by name, so this cannot be quietly forgotten.

If the domain is also a zone in the same Cloudflare account, set `CUSTOM_DOMAIN` to it as well and
the next deploy publishes there instead of workers.dev, with no code change (§16's table).

### Step 4 — Activate at least one source `(the real gate on content)`

`supabase/seed/006_source_registry.sql` seeds 24 researched sources — 7 RSS, 13 HTML pages, a
GitHub API source, a Kaggle API source, a JSON-LD source — and every one is `is_active = false`.
That is OPPORTUNITY_INGESTION.md §7 being honoured: *"this table is a research starting point, not
an approval list."*

Activation has two halves and only one is a machine's.

**The objective half has been run.** `Actions → Ingestion → Run workflow → job: check-sources`
fetched and recorded robots.txt for every source on 15 September 2026:

    24 source(s) checked: 20 allowed by robots, 1 disallowed, 3 unreadable.

Those findings are on the rows now, so the activate step will accept the twenty.

**A refusal here is not always the site's answer.** An unreadable robots.txt is recorded as a
refusal rather than as permission, which is the right default and also means a timeout looks
exactly like a disallow. Two runs an hour apart returned 21/1/2 and then 20/1/3 — one host simply
did not answer the second time. So if a source you expect to be usable reads `robots_allowed =
false`, re-run the check before concluding anything; it is safe, it writes nothing but the
finding, and it costs one request per host.

That first run is also what surfaced the duplicate-sources bug fixed in migration 0025: it
reported "432 source(s) checked" against a registry of 24, because the seed had been re-inserting
itself on every deploy. Worth knowing if you see an older log.

```bash
# The objective half, again, later:
#   Actions → Ingestion → Run workflow → job: check-sources
#   (or locally: DATABASE_URL=... npm run sources:check)

# The half that is a judgement about someone else's legal document. Read the terms, decide,
# record the decision — the activate step refuses until you have:
psql "$DATABASE_URL" -c "UPDATE sources SET tos_posture = 'permits_feeds' WHERE id = '<uuid>'"

# Then, and only then:
DATABASE_URL=... npm run sources:check -- --activate <uuid>
```

`tos_posture` is one of `permits_feeds`, `silent`, `restricts_automation`, `requires_permission`.
`restricts_automation` still permits an RSS feed and nothing else (§2.1 rule 9) — a feed is
published for machines by definition. `requires_permission` means exactly that: obtain it, then
record it.

Start with the RSS tier. CONTENT_AND_LAUNCH.md §3 puts the high-yield feeds in weeks 1–2 for a
reason — they are high volume, legally the cleanest, and immediate. The HTML sources are tier 6,
last resort, per-source legal review.

To see what you are deciding about:

```sql
SELECT id, name, kind, url, tos_posture, robots_allowed, robots_checked_at
  FROM sources WHERE NOT is_active ORDER BY kind, name;
```

### Step 5 — Run ingestion

Actions → **Ingestion** → Run workflow → job `ingest`. It also runs every three hours on its own;
with no active source it fetches nothing and says so, which is why the schedule has been harmless
so far.

Run it once with **dry_run: true** first. It renders what it would write without writing, which is
the cheapest possible look at whether a source yields anything usable.

### Step 6 — Review what it found `(this is not optional)`

**Nothing auto-publishes on its first pass.** `route_for_publication` requires a link-health check
that has not run yet for a brand-new record, and §4.7 sends an unproven source's first five
records to a person regardless. So after ingestion the rows are in `review_queue`, not on the
board.

`/admin` → the queues. §12 of this runbook is how to work them. Publishing from there is what puts
the first row on the board.

### Step 7 — Add an LLM key, or accept a much thinner catalogue `(optional, large effect)`

With no provider key configured, ingestion runs the **NO_AI path**: JSON-LD only, no extraction
from prose, and **no eligibility rules derived at all**. The pipeline is built to survive that
(AI_SYSTEM.md §13) and a run that produces only JSON-LD records is degraded, not broken — but
eligibility rules are the product's central claim, and without a provider almost nothing arrives
with them.

Add any of these as Actions **secrets** and the chain in `ai_providers` starts using it:
`GEMINI_API_KEY` (first for extraction — largest free context), `GROQ_API_KEY` (first for rule
derivation and the query compiler), `CEREBRAS_API_KEY` (third). All three have free tiers, and
§3.1's quotas are already seeded a little under the published ceilings.

### Step 8 — Do not announce it yet

CONTENT_AND_LAUNCH.md §2 sets the seed target before public launch, and it is deliberately high:
**≥ 300 published, ≥ 180 currently open, ≥ 85% with complete eligibility rules, ≥ 120
human-verified, ≥ 40 open to each Tier-1 country** (Zimbabwe, Zambia, Botswana, Namibia, Malawi,
Mozambique), **≥ 80 organisations, ≥ 8 categories with 10+ open**.

The 40-per-country figure is the one to respect: below roughly 40 a country page reads as
abandoned. A launch announcement against an empty board spends the only first impression there is.

Check progress against it with:

```sql
SELECT count(*) FILTER (WHERE status = 'published')                                AS published,
       count(*) FILTER (WHERE status = 'published' AND deadline_at > now())        AS open_now,
       count(*) FILTER (WHERE status = 'published' AND verification <> 'auto')     AS human_verified
  FROM opportunities WHERE deleted_at IS NULL;
```

§5 of that document puts a four-week hand-curated digest to 30–50 real builders *before* any of
this is public, with explicit stop thresholds. That is the cheapest kill point in the plan and it
is worth more than the code.

### What is not needed for any of the above

Telegram (`TELEGRAM_BOT_TOKEN`), email (`BREVO_API_KEY`), Turnstile, Sentry and the Workers AI
binding are all absent, and every feature that uses one degrades rather than fails — §17 lists
exactly how each behaves right now. None of them stands between the site and its first published
opportunity.

---

## 19. Repairing the catalogue: four jobs that read what is already there

Every one of these was written to fix something visible on the live board, and every one is
re-runnable, does no fetching, and can be dry-run. `Actions → Ingestion → Run workflow` with
**dry_run** ticked prints what it would do and writes nothing — do that first, always: run 43
printed four wrong category moves and that is the only reason they never happened.

They also all run on the daily schedule, so a record ingested today is categorised, described
and de-duplicated tomorrow without anyone remembering to ask.

| Job | What it reads | What it changes | Cost |
|---|---|---|---|
| `recategorise` | titles of everything in `other`, then pages | `category_id`, out of `other` only | free, then ~1 tiny call per leftover |
| `fill-summaries` | pages of records with no `summary` | `summary`, where it was NULL | 1 tiny call per record |
| `recheck-relevance` | titles of published records | `status` → `in_review` only | free |
| `dedupe` | URLs, titles, embeddings | merges duplicates | 1 tiny call per candidate pair |

```
DATABASE_URL=... npm run ingest -- --recategorise --dry-run
DATABASE_URL=... npm run ingest -- --fill-summaries --dry-run
DATABASE_URL=... npm run ingest -- --recheck-relevance --dry-run
DATABASE_URL=... npm run dedupe -- --dry-run
```

**`recategorise`** is two passes and the order matters. `packages/ingest/src/categorise.mjs`
reads titles, deterministically and free — it placed 41 of 58 on its first live run with no
mistakes. What is left goes to `prompts/classify.v1.md`, which must QUOTE the phrase in the
page that names the kind; the quote is checked against the page and then read by the same
title reader, and an answer failing either check leaves the record in `other` and says why.
That double check exists because the first version, which just returned a code, filed the
Japan Exchange and Teaching Programme as a `scholarship`.

Nothing here ever moves a record BETWEEN two real categories, so a category you set by hand
is never overruled. If a listing is in the wrong category, fix it in the admin queue; if a
whole KIND of listing has nowhere to go, the taxonomy is missing a word — the job's output
names every record it could not place, which is the list to read before adding one
(`PRODUCT_SPEC.md` §11.1: "Adding a category must require no code change").

**`fill-summaries`** exists because an API source costs no model calls by design, and
schema.org has no field for "what is this, in our words" — eleven of twelve listings on the
live board had no description. A summary that copies eight consecutive words from the source
is discarded rather than stored (§2.1 rule 6), and the record keeps its NULL, which the page
renders as nothing rather than as filler. Run it BEFORE `recategorise` if you are running both
by hand: the daily job does.

**`recheck-relevance`** demotes published records whose titles are articles rather than
opportunities — an MCAT study guide, a page of visa requirements, a listicle of countries.
The aggregator feeds publish advice posts through the same RSS as their listings. It only ever
moves records OUT of `published` into `in_review`, so publishing one back from the queue
overrides it permanently, and it never deletes anything.

**`dedupe`** is `AI_SYSTEM.md` §9. Records sharing a URL are merged outright; pairs found by
title similarity or by embedding go to a model that answers same / different / unsure, and only
`same` above 0.85 merges. Everything else waits in the duplicates queue for a person. It needs
embeddings, so it runs after `npm run embed` — a record written today is comparable tomorrow.

```sql
-- After a run: what is still unplaced, and what is waiting on a person.
SELECT c.code, count(*) FROM opportunities o JOIN categories c ON c.id = o.category_id
 WHERE o.status = 'published' AND o.deleted_at IS NULL GROUP BY c.code ORDER BY 2 DESC;

SELECT count(*) FILTER (WHERE summary IS NULL) AS no_summary, count(*) AS published
  FROM opportunities WHERE status = 'published' AND deleted_at IS NULL;

SELECT method, state, model_verdict, count(*) FROM dedupe_candidates
 GROUP BY 1,2,3 ORDER BY 4 DESC;
```

---
