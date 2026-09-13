# ANALYTICS.md

**Purpose:** answer questions that change decisions. Nothing else is measured.

**Constraints:** no third-party analytics script on any public page (byte budget and privacy), no cross-site tracking, no advertising identifiers, no per-user behavioural profiles, and a 500 MB database that events must not consume.

---

## 1. NORTH STAR

> **Weekly builders who reach an eligible opportunity they did not previously know about.**

Measured as: distinct users per ISO week who view an opportunity detail page, receive an `eligible` or `likely_eligible` verdict, and have not previously viewed that opportunity.

Chosen because it is the only metric that moves when the product does its actual job. It cannot be inflated by more listings, more sessions, more notifications, or more time on site — all of which can rise while the product gets worse.

---

## 2. GUARDRAILS

Metrics that must not degrade while the north star grows. Each has an owner action if breached. `[PR]`

| Guardrail | Threshold | Action if breached |
|---|---|---|
| **Stale share** — published opportunities past their re-verification window | < 5% | Stop feature work; fix ingestion |
| **False-eligibility reports** per 1,000 verdicts | < 1 | **Severity 1.** Halt auto-publish; re-tune extraction |
| **Expired-at-click rate** — clicks to an opportunity that had closed | < 2% | Tighten re-verification cadence |
| **Median transferred bytes**, opportunity detail, p75 mobile | < 120 KB | Fail the build; revert |
| **Digest unsubscribe rate** | < 2%/month | Reduce frequency; review content |
| **Priority-1 queue age** | < 12h | The operator is the bottleneck; reduce intake |
| **Scam listings published** | **0** | Full review of the anti-scam gate |
| **Request acceptance rate** | > 35% | The room pool is mismatched; narrow the catalogue |

The stale share and the false-eligibility rate are the two that define whether the product is still telling the truth. They are reviewed weekly regardless of anything else.

---

## 3. EVENT MODEL

First-party events written to `events` (see `DATA_MODEL.md` §12). Non-identifying by construction.

**Captured:** `name`, `ts`, `user_id` (null when logged out), `anon_id` (rotating, 24h, non-identifying), `country_iso2` (from profile or coarse edge geolocation), and a small `props` object.

**Never captured `[PR]`:** IP addresses in the events table, user agent strings, referrer URLs from outside the site, precise location, eligibility-profile values, search queries containing free text of any personal nature, tracker note contents, message contents.

**Search queries are stored hashed**, with only the *extracted filters* kept in the clear. We learn that people search for "AI hackathons in Zimbabwe" as a filter combination, not as a personal text record.

### 3.1 Event inventory

| Event | Props | Answers |
|---|---|---|
| `opportunity_viewed` | `opportunity_id`, `category`, `source` (search/digest/telegram/direct/country) | Which surfaces produce reach |
| `eligibility_checked` | `verdict`, `logged_in`, `missing_field_count` | Is the core feature used, and does it resolve |
| `eligibility_resolved` | `from_verdict`, `to_verdict`, `field_added` | Does the missing-field prompt work |
| `opportunity_tracked` | `state`, `from_state` | Pipeline progression |
| `apply_clicked` | `opportunity_id`, `verdict` | **The closest proxy for real value delivered** |
| `search_performed` | `filter_keys[]`, `result_count`, `used_nl`, `zero_results` | What people look for and where we fail |
| `filter_applied` | `key`, `value_type` | Which filters earn their space |
| `intent_declared` | `opportunity_id`, `stance` | Liquidity signal |
| `room_viewed` | `intent_count`, `team_count` | Density-floor tuning |
| `request_sent` / `request_decided` | `context`, `decision` | Collaboration health |
| `project_created` | `has_tags` | — |
| `project_match_viewed` | `match_count` | Does the project hook land |
| `digest_sent` / `digest_opened` / `digest_clicked` | `channel`, `item_count` | Notification health |
| `telegram_linked` | `trigger_surface` | Which prompt converts |
| `report_submitted` | `subject_type`, `reason` | Trust signal quality |
| `page_performance` | `route`, `ttfb_ms`, `lcp_ms`, `bytes` | Byte-budget compliance in the field, sampled 5% |
| `degraded_mode` | `feature` | How often users meet a degraded path |

Roughly 20 events. **Every one maps to a decision in the table in §5.** An event nobody has committed to act on is not added. `[PR]`

---

## 4. FUNNELS

**Acquisition → value:**
```
Landing (any page)
  → opportunity_viewed
    → eligibility_checked
      → verdict eligible / likely_eligible
        → apply_clicked   or   opportunity_tracked
```
Measured separately for each entry source (search, Telegram, digest, country page, direct), because a country page shared into WhatsApp behaves nothing like a Google entry and averaging them hides both.

**Retention:**
```
First session → returns within 7 days → tracks something
  → links Telegram → returns within 30 days
```
Telegram linking is hypothesised to be the strongest retention predictor available at $0. That hypothesis is explicitly tested by comparing 30-day return rates between linked and unlinked cohorts, and the product changes if it is wrong. `[PR]`

**Collaboration:**
```
intent_declared → room_viewed → request_sent → request_accepted → team full
```
Drop-off at each step names its own fix: low intent means the catalogue is too wide; low room views means the density floor is set wrong; low acceptance means the pool is mismatched.

---

## 5. THE DECISION TABLE

Every metric is bound to an action in advance, so measurement cannot become an end in itself.

| If we see | We do |
|---|---|
| High views, low eligibility checks | The verdict block is not prominent enough — move it up |
| Many `unclear` verdicts | Extraction quality problem, not a UI problem — re-tune rules |
| High `zero_results` on country searches | Sourcing gap — add sources for that country |
| Tracked but never `apply_clicked` | Reminders are failing, or listings are not credible |
| Low digest opens | Content is thin — raise the suppression threshold |
| Low Telegram adoption | Move the prompt earlier; email budget will bind |
| Rooms viewed but no requests | Request friction, or the pool is wrong |
| Rising `degraded_mode` | Provider health — fix before users notice |
| Rising `expired-at-click` | Re-verification cadence is too slow |
| Byte budget breached in the field | Revert the offending change |

---

## 6. CATALOGUE HEALTH (admin dashboard)

Not user behaviour — **content truth**, and arguably more important:

- Published by country, by category, by verification state.
- Stale share, expired-this-week, disputed count.
- Extraction approve-without-edit rate (whether the pipeline saves or creates work).
- Source health: records produced, published, rejected, and reports attributable to each source.
- **Coverage gaps** — countries with fewer than 10 open opportunities. This directly drives sourcing work and is checked weekly.
- Density-floor status per surface, so the operator can see what is about to unlock.

---

## 7. STORAGE AND RETENTION `[PR]`

Events are a real threat to a 500 MB database (projected ~120 MB at 30 days). Therefore:
- Raw events retained **30 days**.
- Nightly rollup to `event_rollups_daily` (day × name × country × count), then raw rows deleted.
- Rollups retained indefinitely — they are tiny and give long-range trends.
- Anything needing per-user longitudinal analysis is computed into a small cohort table at rollup time, not kept as raw events.

If the events table exceeds 150 MB at any point, retention drops to 14 days automatically. Content storage takes priority over telemetry, always.

---

## 8. TOOLING

- **Cloudflare Web Analytics** — page-level traffic, no client JS beyond a tiny beacon, privacy-preserving.
- **First-party events** — one lightweight `sendBeacon` call, no library, ~1 KB.
- **Sentry** — errors only, with PII scrubbing, 10% trace sampling.
- **Google Search Console** — search performance.
- **Admin dashboard** — everything above, queried directly from Postgres.

**Rejected:** PostHog, Plausible Cloud, GA4, Mixpanel — all require a client bundle that would consume a large share of the page budget. A third-party analytics script on a page served to someone paying $43.75/GB is not a neutral choice; it is spending their money to satisfy our curiosity. `[PR]`

---

## 9. WHAT WE DELIBERATELY DO NOT MEASURE

- **Time on site, scroll depth, session length.** This product succeeds when someone leaves quickly with an answer. Optimising for attention would corrupt it.
- **Per-user behavioural profiles.** Aggregates only.
- **Anything shown to users as social proof**, except the intent count above its density floor. No view counts, no "trending", no follower numbers, no leaderboards.
- **A/B tests on eligibility presentation.** Correctness is not a variable to optimise against engagement. `[PR]`
- **Individual search text.** Hashed; filters kept, free text discarded.

---

## 10. REPORTING CADENCE

- **Weekly (15 min):** north star, guardrails, coverage gaps, queue age.
- **Monthly:** funnels by source, retention cohorts, Telegram adoption, digest health, catalogue growth by country.
- **Quarterly:** are the density floors right, is the Tier-1 market focus working, which specified-but-unbuilt features the data now justifies, and which built features the data says to remove.

The quarterly review explicitly includes **removal**. A feature that is not earning its moderation cost or its bytes is a candidate for deletion, not iteration.
