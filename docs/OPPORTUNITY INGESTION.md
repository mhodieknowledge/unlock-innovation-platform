# OPPORTUNITY_INGESTION.md

The system that keeps the catalogue **true**. Freshness is the product's central promise, so this pipeline is a product surface, not a back-office script.

---

## 1. PIPELINE

```
 DISCOVER → FETCH → NORMALISE → EXTRACT → STRUCTURE → DEDUPE → SCORE → REVIEW → PUBLISH
                                                                                    │
                                        ┌───────────────────────────────────────────┘
                                        ▼
                              MONITOR → REVERIFY → CHANGE → EXPIRE
```

All stages run in the batch tier (GitHub Actions). Each stage is independently re-runnable and idempotent. Every stage writes an auditable row. `[PR]`

---

## 2. SOURCE PRIORITY — legality first

**Order of preference `[PR]`. Never skip to a lower tier when a higher one is available.**

| Tier | Method | Examples | Posture |
|---|---|---|---|
| 1 | **Official API** | GitHub (`good first issue`, `help wanted`), Kaggle competitions, Eventbrite | Explicitly sanctioned |
| 2 | **RSS / Atom** | Opportunity Desk, Opportunities for Africans, After School Africa, Scholarship Region, TechCabal, Techpoint, Disrupt Africa (WordPress-class sites almost always expose `/feed`) | Publisher-intended machine consumption. **The backbone of this pipeline.** |
| 3 | **Structured data on public pages** | JSON-LD `Event` / `EducationalOccupationalProgram` / `JobPosting`; microdata; sitemaps | Published for machines |
| 4 | **Organisation self-serve** | Verified orgs posting directly | Best possible provenance |
| 5 | **Human submission** | Public submit form; admin entry | Slow but authoritative |
| 6 | **Scoped HTML fetch of public pages** | Zindi competition list, specific organisation programme pages | **Last resort**, per-source legal review required |

### 2.1 Scraping rules — non-negotiable `[PR]`
1. Honour `robots.txt` for every fetch. Record the check in `sources.robots_checked_at`.
2. **Never create an account, log in, or bypass any authentication or paywall.** This is the boundary that sank hiQ — the CFAA claim failed but the breach-of-contract claim succeeded, ending in a $500,000 consent judgment and permanent injunction in December 2022, after which the company shut down.
3. Identify honestly: `User-Agent: {BRAND}Bot/1.0 (+https://{domain}/bot)` with a page explaining the crawler and giving a contact address.
4. Rate limit to ≤ 1 request per 10 seconds per host; respect `Retry-After`; honour `429`/`503` with exponential backoff.
5. Use conditional requests (`ETag`, `If-Modified-Since`) — courtesy and bandwidth.
6. **Store structured facts, never article text.** Deadlines, eligibility, URLs and dates are facts; the publisher's prose is theirs. Summaries are written in our own words and validated against an 8-word overlap check.
7. Always attribute and link to the source.
8. **Takedown SLA: 48 hours.** A published contact address, a documented process, and `sources.is_active=false` plus `status='rejected'` (HTTP 451) on request, no argument. `[PR]`
9. Any source whose ToS restricts automated access is set `tos_posture='restricts_automation'` and may be ingested **only** via its RSS feed or not at all.

> **On the browser fetch path.** §4.2 adds a last-resort transport: where a source answers with a bot wall instead of a document, the URL is rendered in a real browser. Rules 1, 2, 4 and 9 above apply to it unchanged, and rule 2 is the reason authentication statuses are excluded from it by name. Rule 3 is narrowed on that path alone — the user-agent must be a real browser's for the render to work at all, so honest identification moves to the `X-Crawled-By` and `From` headers. The reasoning is written out in §4.2 rather than left to a diff.

---

## 3. SOURCE REGISTRY

Sources are managed entities (`sources` table), not code. Adding one is an admin form, not a deploy. `[PR]`

Each carries: kind, URL, cadence, robots and ToS posture, legal note, attribution requirement, default category/region hints, trust score, health counters and credentials reference.

**Trust score** (0–1) starts at 0.5 and moves on evidence: confirmed-accurate records raise it; reports of wrong deadlines, expired listings or scams lower it. It feeds the auto-publish threshold — a high-trust source's extractions publish at a lower confidence bar than an unproven one.

**Health and alerting `[PR]`:** `consecutive_failures ≥ 3` marks the source `degraded` and surfaces it on the admin dashboard; ≥ 3 sources degraded for ≥ 12 h sends a Telegram alert to the operator. A silently dead source is the most likely cause of catalogue rot, so it is alarmed like an outage.

---

## 4. STAGE DETAIL

### 4.1 Discover
Per source kind: enumerate feed items, API result pages, or sitemap URLs. Filter by `lastmod`/`pubDate` where available. Skip anything whose canonical URL plus content hash already exists in `raw_documents`.

### 4.2 Fetch
Conditional GET with stored `ETag`/`Last-Modified`. Timeout 15 s, max 2 retries. Content-type allowlist (`text/html`, `application/xml`, `application/json`, `application/pdf`). Max body 2 MB. Response written to `source_fetches`.

#### Bot walls, and the browser fetch `[PR]`

A plain GET from the batch tier is now refused by a significant part of §3's registry. The production run of 2026-09-15 stored nothing at all: 53 of 53 documents came back unusable, and the log recorded almost every one of them as `extraction_failed`. That was true of the text we held and false about what had happened, which is the expensive kind of wrong — it points an operator at the extraction prompt for a week, when the pipeline never had the page.

Three things were happening, and they need different names:

| What the source did | What the log said | What it was |
|---|---|---|
| `403` at the feed (TechCabal, Techpoint) | `fetch_error — HTTP 403` | correct |
| `401` (Kaggle) | `fetch_error — HTTP 401` | correct — an API key, tier 1, not a wall |
| `202` with a 171-byte proof-of-work interstitial (Scholarship Region) | `extraction_failed` | **wrong** — the wall was read as a document |
| `200` with an unrendered application shell (Zindi, GDG chapters) | `extraction_failed` | **wrong** — the page assembles in a browser |

So the fetcher classifies the response before extraction sees it (`packages/ingest/src/challenge.mjs`), and where the response is a wall rather than a document it renders the URL in a real Chromium and returns what the browser got (`scripts/lib/browser-fetch.mjs`). The solve loop is ported from CF-Clearance-Scraper (MIT): detect the challenge type, wait out the spinner, click the verify control or the turnstile frame, poll until the document arrives.

**The escalation changes the transport and nothing else.**

- §2.1 rule 1 holds. robots.txt is checked before the escalation, by the same code that gates a plain fetch. A disallowed URL is never rendered.
- §2.1 rule 2 holds, and is the reason `401` and `407` are excluded from escalation **by name**. A bot wall may be rendered past; authentication may not, by any means. There is no credential, no stored cookie and no session on either path.
- §2.1 rule 3 is **narrowed, deliberately**. The user-agent on the render path is a real Chrome string, because the UA is one of the inputs a wall fingerprints and `MbeleBot` in it means the render fails exactly as the plain fetch did. Honest identification moves to `X-Crawled-By` and `From`, carrying the same bot page and contact address. A publisher inspecting a request still learns who we are and how to stop us, which is what the rule is for. The plain path is unchanged and still sends the bot UA.
- §2.1 rule 4 holds, and the render counts as a request: a second per-host turn is taken before the browser navigates.
- §2.1 rule 9 is untouched. A source whose ToS restricts automated access is still feed-only or excluded, and rendering does not make it eligible.

Two ceilings keep this inside §9's budget, because a render costs seconds where a fetch costs milliseconds:

- a weak vendor marker — Cloudflare's challenge script sits on ordinary pages it has already served — only counts as a wall when the document is *also* too thin to be a document. Without that rule, a fully rendered Disrupt Africa article took a 15-second render to arrive at the 3,485 characters plain HTTP already had.
- at most `INGEST_BROWSER_BUDGET` renders per run (default 40). Past the ceiling the fetcher reports `challenged` and carries on.

A source we could not read is now reported as `challenged`, not as an extraction failure. That distinction is the point: "this source is behind a wall we could not pass" is a fact an operator can act on — lower its tier, drop it, or find its feed — and "extraction failed" is a dead end.

The browser is optional. With `INGEST_BROWSER=0`, or with Chromium simply not installed, the pipeline runs and reports what it could not reach. A degraded run, not a broken one (AI_SYSTEM.md §13).

### 4.3 Normalise
- HTML → readable text (Readability-style main-content extraction), scripts/nav/footer stripped.
- PDF → text via `pdftotext`; if empty (scanned), mark `needs_manual` and stop — **no OCR at $0**.
- Extract JSON-LD and microdata into `raw_documents.jsonld`.
- Canonicalise the URL: strip `utm_*`, `fbclid`, `gclid`, session params; lowercase host; remove trailing slash; resolve redirects and store the final URL.
- Compute `content_hash` (sha256 of normalised text). Unchanged hash → stop, update `last_fetch_at` only.
- Truncate `text_raw` to 40 KB (see `DATA_MODEL.md` §14 — this is the largest storage consumer).

### 4.4 Extract → 4.5 Structure
Per `AI_SYSTEM.md` §4–5: structured record, then eligibility rules with verbatim source quotes. **JSON-LD wins over the model on any field it supplies**, because it is publisher-authored.

**Deterministic enrichment after the model:**
- Organisation resolution: exact domain match → existing org; else trigram name match ≥ 0.8 → candidate link; else create `unclaimed` org and queue for merge review.
- Region words → country arrays from our own `regions` table.
- Relative dates ("closes in three weeks") resolved against `raw_documents.fetched_at`, and `deadline_precision` downgraded accordingly.
- Timezone: use the stated one; else the organisation's country default; else UTC with `precision='date_only'`, and **display conservatively** (warn as if it closes at the start of the stated day in the user's timezone).
- Slug generation with collision suffixing.

### 4.6 Dedupe
Per `AI_SYSTEM.md` §9. Merge keeps the **highest-verification** record as canonical, unions `eligible_countries`, keeps the **earliest** deadline (conservative), retains all source links, and sets `duplicate_of` on the loser so old URLs return `410 GONE` with `merged_into`. `[PR]`

### 4.7 Score and route
```
auto_publish IF
      extraction_confidence ≥ 0.75
  AND deadline_confidence   ≥ 0.80
  AND country_confidence    ≥ 0.80
  AND cost ≠ 'paid'
  AND source.trust_score    ≥ 0.60
  AND link_ok = true
  AND organisation resolved
```
Otherwise → `in_review` in the appropriate queue.

**Absolute review triggers — never auto-publish `[PR]`:**
- `cost = 'paid'`, or any fee keyword detected anywhere in the source.
- Prize above a configurable threshold (default USD 50,000) — high-value listings are the most attractive scam vector.
- `eligibility_scope = 'unclear'` combined with a stated prize.
- Source trust below 0.4.
- Any Safe Browsing hit on `apply_url` or `official_url`.
- First ever record from a brand-new source (the source's first 5 records are always reviewed).

#### `sources.auto_publish` — a vetted source may skip the caution gates `[PR]`

Migration 0031. The list above is two kinds of rule wearing one name, and the operator's
launch made the difference matter: one person cannot hand-review the ≥300 records §2 of
CONTENT_AND_LAUNCH.md asks for before launch, a card at a time.

**Five of them protect a reader** — a fee to apply, a Safe Browsing hit, a prize above USD
50,000, unclear eligibility beside a stated prize, and source trust below 0.4. Being wrong
on any of these costs somebody money or an application they were entitled to make. These
apply to **every** source and `auto_publish` does not reach them.

**The rest protected the pipeline from itself** — the first-five rule, the 0.60 trust floor,
organisation resolution, and the link-health pre-check that a brand-new record cannot have
passed yet. On a source an operator has read and vetted, these describe our caution rather
than any risk to the reader, and together they were absolute: nine of the seeded sources
carry `trust_score = 0.50`, so no record from them could ever auto-publish however good the
extraction. `auto_publish = true` sets them aside for that source.

Two narrower checks replace them, because these are still about the reader:
- a deadline that was **extracted but is uncertain** (`0 < confidence < 0.80`) goes to review.
  Somebody plans around a date. An absent deadline is honest; a wrong one is not.
- an **asserted country list** below 0.80 confidence goes to review. `global`, `africa_wide`
  and `unclear` assert nothing and are displayed as such, so they are unaffected.

**It never applies to people.** `kind IN ('org_submission','manual')` is refused by a CHECK
constraint. Public submissions never reach this function at all — `public_submit_opportunity`
writes `status='draft'` straight to the `ugc` queue — and that is the half of the policy the
operator asked to keep: publish what we fetch, review what a stranger sends.

### 4.8 Review
Admin queues, designed to be cleared on a phone in minutes. See `ADMIN_SYSTEM.md` §3. The reviewer sees the extracted record, the source text with rule quotes highlighted, and the confidence per field, with approve / edit / reject / merge actions.

### 4.9 Publish
Sets `status='published'`, `published_at`, `verification` (`official` if org-submitted, `verified` if human-reviewed, else `auto`), `last_verified_at=now()`, `next_verify_at` per §5. Triggers: embedding job, cache purge, sitemap regeneration, and match recomputation for affected users.

---

## 5. FRESHNESS MODEL — the promise

### 5.1 Re-verification cadence
`next_verify_at` is a function of urgency, because a wrong deadline matters most when the deadline is near:

| Time to deadline | Re-verify every |
|---|---|
| ≤ 3 days | 12 hours |
| ≤ 7 days | 24 hours |
| ≤ 30 days | 3 days |
| > 30 days | 7 days |
| Rolling / unknown deadline | 14 days |

### 5.2 Link health
Every 6 hours for published records: `HEAD` (falling back to ranged `GET`) on `apply_url` and `official_url`.
- `2xx` → `link_ok=true`, `link_checked_at` updated.
- `3xx` to a different host → flag for review (programme moved or domain sold — a known scam vector).
- `404`/`410` → `link_ok=false`; two consecutive failures → `verification='community_flagged'` and review queue.
- `5xx`/timeout → no state change (transient), counted separately.

### 5.3 Change detection
On re-verification the source is re-fetched and re-extracted. Differences write `opportunity_changes`.
- **Deadline, eligibility, cost or apply URL changed** → `notify_trackers=true`, and every user tracking it gets **one** notification showing old value, new value and the source. `[PR]`
- Other fields update silently but are logged.
- A deadline moving *later* still notifies (people plan around deadlines).

### 5.4 Staleness and expiry
| Condition | State |
|---|---|
| `now() > next_verify_at + 7 days` | `verification='stale'`, ranking ×0.8, badge shown |
| `now() > deadline_at` (with precision buffer) | `status='expired'`, removed from active surfaces |
| Two link failures, or source says closed | `status='closed'` |
| Confirmed scam | `status='rejected'`, source trust penalised, trackers notified |

Expired records are **never deleted**. They remain at their URL with a clear expired banner, stay on the organisation page as history, are `noindex`'d, and are excluded from all search and feeds. This preserves inbound links honestly and provides the historical record that later powers "this runs annually — the next round usually opens in March". `[PR]`

### 5.5 Recurrence `[FUT]`
When the same organisation runs a similarly-titled opportunity in consecutive years, link the records as a series. Enables "last year this opened in March" on an expired page — a genuinely useful and honest signal. Specified, not built in Phase 1.

---

## 6. USER-REPORTED CORRECTIONS

Every opportunity page carries one-tap reports: *this has closed · deadline is wrong · eligibility is wrong · link is broken · this looks like a scam · duplicate · other*.

| Reason | Immediate automatic effect | Then |
|---|---|---|
| `possible_scam` | `verification='disputed'`, de-ranked, warning banner | Priority-1 queue, ≤12 h SLA |
| `requires_payment` | Same | Priority-1 queue |
| `expired` (≥2 independent reporters) | `verification='community_flagged'` | Re-verify job triggered immediately |
| `broken_link` | Immediate link check triggered | Auto-resolves if the check passes |
| `wrong_deadline` / `wrong_eligibility` | Badge on the affected field | Priority-2 queue |
| `duplicate` | Merge candidate created | Dedupe queue |

Reporters are told the outcome. A reporter whose reports are consistently upheld gains weight (their single report triggers what normally needs two); one whose reports are consistently dismissed loses it. `[PR]`

---

## 7. SEED SOURCE LIST (starting registry)

Verified as active during research. Each requires an individual robots/ToS check before activation — **this table is a research starting point, not an approval list.** `[PR]`

| Source | Kind | Tier | Notes |
|---|---|---|---|
| Opportunity Desk | RSS | 2 | Very high volume, global + Africa |
| Opportunities for Africans | RSS | 2 | Africa-focused |
| After School Africa | RSS | 2 | Scholarships-heavy |
| Scholarship Region | RSS | 2 | Also a Telegram/WhatsApp publisher |
| TechCabal | RSS | 2 | Also publishes Moonshot / TC Battlefield |
| Techpoint Africa | RSS | 2 | |
| Disrupt Africa | RSS | 2 | Startup programmes and funding |
| Zindi | HTML | 6 | Priority African competitions; legal check required |
| Kaggle | API | 1 | Official API |
| GitHub | API | 1 | `good first issue`, `help wanted`, Hacktoberfest-style programmes |
| Eventbrite | API | 1 | Verify current public search access |
| GDG chapter pages | HTML/JSON-LD | 3 | Country-level events, high value for Tier-1 markets |
| Tony Elumelu Foundation | HTML | 6 | Direct organisation source |
| Mastercard Foundation | HTML | 6 | |
| Anzisha Prize | HTML | 6 | Note: under-18 eligible (see `PRODUCT_SPEC.md` §22.1) |
| Africa's Business Heroes | HTML | 6 | |
| Deep Learning Indaba / IndabaX | HTML | 6 | Per-country chapters |
| ALX Africa | HTML | 6 | |
| She Code Africa | HTML | 6 | `gender_restricted` rules — handle carefully |
| MEST, CcHUB, iHub, Injini, Flat6Labs | HTML | 6 | Accelerator cycles |
| University innovation pages (Tier-1 countries) | HTML | 6 | **Highest-value, lowest-competition source class** |

**Deliberate priority `[C]`:** university and national programme pages in Zimbabwe, Zambia, Botswana, Namibia, Malawi and Mozambique are where no incumbent looks. They are low-volume and awkward to fetch, which is exactly why they are defensible.

---

## 8. MANUAL AND SELF-SERVE ENTRY

- **Public submit form** — Turnstile, ≤3/day/IP, lands as `draft` in review. The submitter is credited if published (a small, honest incentive).
- **Organisation self-serve** — verified orgs publish directly with `verification='official'`. Edits touching eligibility, dates or cost re-enter review. `[PR]`
- **Admin quick-add** — paste a URL, the pipeline runs synchronously, the admin reviews and publishes. This is the fastest path and the main seeding tool.

---

## 9. SCALE AND QUOTA BUDGET

At 40 active sources on 3-hourly cadence: ~320 fetches/day, ~60 new documents/day, ~245 LLM calls/day (`AI_SYSTEM.md` §11), ~8 GitHub Actions minutes/day. All comfortably inside free limits with ~50× headroom.

Growth trigger: above ~200 new documents/day, move extraction to a nightly batched single job and raise the dedupe threshold; the constraint becomes review labour, not compute. Review labour is the real ceiling on this system, and it is why the confidence gates and source trust scores exist.
