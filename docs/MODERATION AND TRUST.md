# MODERATION_AND_TRUST.md

**The stake:** this product's entire value is that people can believe it. A single scam listing published under a verification badge does more damage than six months of missing listings. Trust is the asset; moderation protects it.

**Operating constraint:** one operator, ~30 minutes/day. Every rule below is designed to be enforced mostly by the system, with humans handling only the irreducible.

---

## 1. THE TRUST MODEL

Three independent trust signals, never conflated:

| Signal | Question it answers | Where shown |
|---|---|---|
| **Verification state** | How do we know this is real? | Opportunity card and page |
| **Freshness** (`last_verified_at`) | When did we last check? | Card and page, always |
| **Source** | Who said so? | Page, with an outbound link |

All three are visible on every opportunity. We never show a badge without a date. `[PR]`

### 1.1 Verification states
| State | Meaning | Ranking effect |
|---|---|---|
| `official` | Submitted or claimed by a domain-verified organisation | ×1.1 |
| `verified` | Human-reviewed against the official source | ×1.05 |
| `auto` | Machine-extracted above confidence thresholds, not human-reviewed | ×1.0 |
| `community_flagged` | Users have reported a problem; under review | ×0.7, badge shown |
| `stale` | Past its re-verification window | ×0.8, badge shown |
| `disputed` | Scam or payment report open | ×0.2, warning banner |
| `expired` | Past deadline or confirmed closed | Excluded from active surfaces |

**`auto` is labelled honestly as machine-extracted, not dressed up as verified.** Users can see the difference and decide. `[PR]`

---

## 2. ANTI-SCAM — the highest-priority policy

The audience is young, motivated and financially constrained. Advance-fee scams dressed as scholarships and grants target exactly this group. This is the risk most likely to end the product.

### 2.1 Hard rules `[PR]`
1. **No opportunity requiring payment to apply is ever published.** Not reviewed-and-approved — rejected. Costs to *participate* (conference tickets, optional travel) may be listed with a prominent cost label, but a fee to *submit an application* is grounds for rejection and a source-trust penalty.
2. **Any listing with `cost = paid`, or any fee keyword anywhere in the source, cannot auto-publish.** Human review, always.
3. **A permanent, prominent statement** on every opportunity page and in the Telegram bot: *"We never ask you to pay to apply. If an opportunity asks for a fee, report it."*
4. **Every outbound URL is Safe-Browsing checked** before display. A hit blocks the link, which renders as plain text with a warning.
5. **Domain-change detection**: an `official_url` redirecting to a different registrable domain flags for review — expired programme domains get bought and repurposed, and this is a known vector.
6. **High-prize review**: any listing claiming a prize above USD 50,000 is human-reviewed regardless of confidence.
7. **New-source probation**: the first 5 records from any new source are human-reviewed.

### 2.2 Response to a scam report
`possible_scam` or `requires_payment` sets `verification='disputed'` **immediately and automatically**, before any human sees it: de-ranked to the bottom, warning banner shown, excluded from digests and the Telegram bot.

Human review SLA: **12 hours.** If confirmed: `status='rejected'`, source trust reduced by 0.3, every user who tracked it notified with a plain explanation, and the organisation flagged if it recurs.

**Bias `[PR]`:** false positives cost us one listing. False negatives cost someone money. Act first, review second.

---

## 3. REVIEW QUEUES

Seven named queues, each with a priority and an SLA. All must be clearable on a phone.

| Queue | Contents | Priority | SLA |
|---|---|---|---|
| `report_scam` | Scam and payment reports | 1 | 12 h |
| `report_safety` | Harassment, impersonation, abuse | 1 | 12 h |
| `paid_cost` | Listings with any cost signal | 2 | 24 h |
| `low_confidence` | Extractions below threshold | 3 | 72 h |
| `duplicate` | Merge candidates | 3 | 72 h |
| `org_claim` | Organisation claims | 3 | 48 h |
| `ugc` | Flagged projects, profiles, messages | 4 | 48 h |

**Queue age is an alarmed metric.** Any priority-1 item open past SLA sends a Telegram alert to the operator. A growing queue is the earliest visible symptom of operator abandonment, which is the product's most likely cause of death.

---

## 4. USER-GENERATED CONTENT MODERATION

### 4.1 Surface inventory
Free-text fields users can write: profile headline, bio, project fields, team name and pitch, request messages, thread messages, report detail, intent note, tracker note (private, never moderated).

Every one is **length-capped** (see `DATA_MODEL.md`) — a deliberate moderation measure, not a UI nicety. Short fields are cheap to scan and unattractive to spammers.

### 4.2 Pipeline
```
submit → deterministic checks (always) → model pre-screen (if available) → publish / hold / block
```

**Deterministic checks, never skipped `[PR]`:** URL scheme allowlist; Safe Browsing; fee/payment keyword patterns; contact-detail patterns in fields where they are not permitted; repetition and entropy heuristics; block-list of known scam domains.

**Model pre-screen** returns scores on spam, scam, harassment, personal-data leak and off-topic. Thresholds per `AI_SYSTEM.md` §10.

**Fail-open for availability, fail-closed for money `[PR]`:** an AI outage never stops ordinary participation, but never lets a fee-bearing item or a flagged link through.

### 4.3 Impersonation
- Organisation claims require a **domain-matched email**. Non-matching claims require evidence and human review.
- Display names matching a verified organisation's name trigger review.
- Profiles claiming affiliation with a verified organisation are not badged unless the organisation confirms.

---

## 5. REPORTING

One-tap on every opportunity, project, profile, team and message. Typed reasons (see `DATA_MODEL.md` §11). Optional detail ≤1000 chars.

**Reporters are always told the outcome.** A report that vanishes teaches people not to report. `[PR]`

**Reporter weighting:** a reporter whose reports are upheld gains weight — their single report triggers what normally needs two corroborations. Consistently dismissed reports lose weight. Weight is invisible to users and never used to punish, only to prioritise.

**Logged-out reporting is allowed** on opportunities (broken link, expired, scam), Turnstile-gated, 5/day/IP. Most people spotting a dead link will not have an account, and we want that signal.

---

## 6. ENFORCEMENT LADDER

Escalating restriction, never an instant ban, except for the two cases below. `[PR]`

| Step | Trigger | Effect | Duration |
|---|---|---|---|
| 1. Soft warning | First confirmed low-severity violation | In-app notice explaining exactly what and why | — |
| 2. Rate reduction | Repeat | Request and message limits halved | 7 days |
| 3. Restriction | Repeat or one medium violation | Read-only: no requests, no messages, no new projects, no intent | 14–30 days |
| 4. Suspension | Severe or persistent | Account disabled, public content hidden | Indefinite, appealable |
| 5. Termination | Fraud, sexual content involving minors, credible threats, coordinated scams | Permanent, content removed | Permanent |

**Immediate escalation to step 4 or 5, bypassing the ladder:** any child-safety concern, credible threat of violence, or a coordinated scam operation.

**Appeals:** every restriction and suspension notice includes an appeal path to a human, and every appeal receives a reply. One operator, so the SLA is 7 days and it is stated honestly rather than promised as instant.

---

## 7. RATE LIMITS AS MODERATION

Rate limits do more moderation work than any human or model here. Full table in `API_SPEC.md` §15. The load-bearing ones:

| Action | Limit |
|---|---|
| Team/connection request | 10/day, 3/hour, 5 pending |
| Messages | 60/day/thread, 200/day total |
| Team creation | 5/day |
| Public submission | 3/day/IP (anon), 10/day (auth) |
| Reports | 5/day/IP (anon), 20/day (auth) |
| Project creation | 5/day |

Counters live in `rate_limit_counters` (exact, per user/action) with a coarse Cloudflare layer in front (per IP/ASN).

---

## 8. CHILD SAFETY `[PR]`

**Accounts are 18+.** Opportunities open to under-18s are listed and fully readable logged-out, with a clear note, but cannot be tracked or joined without an adult account.

- Age is self-asserted at signup with an explicit confirmation.
- Any credible signal that an account holder is under 18 → `account_state='restricted'` immediately: read-only, all social features removed, all threads closed. Not a punishment; a protection.
- Any report involving sexual content, grooming behaviour, or an adult seeking contact with a minor → immediate termination, content preserved for the record, and reported to the relevant authority where a mechanism exists.
- There is no appeal path that restores social features to an account believed to be held by a minor.

This policy exists because a zero-budget, solo-operated platform cannot responsibly run user-to-user contact for minors. It is a limitation stated plainly rather than a risk quietly accepted.

---

## 9. TRANSPARENCY

Published and kept current:
- **Content policy** — what is allowed, what is not, in plain language.
- **Verification explainer** — what each badge means and what it does not.
- **Anti-scam page** — how to spot advance-fee scams, our no-fee rule, how to report.
- **Crawler page** at `/bot` — what our crawler does, how to block it, how to request removal.
- **Takedown process** — a published address and a 48-hour SLA.
- **Quarterly transparency note `[FUT]`** — reports received, actions taken, listings rejected as scams, takedowns honoured. Short and honest, not a PR document.

---

## 10. WHAT WE DELIBERATELY DO NOT MODERATE

Stated so the boundary is clear:
- **Private tracker notes.** Never read, never scanned, never used for anything. `[PR]`
- **Eligibility profiles.** No admin read path exists (see `DATA_MODEL.md` §15).
- **Quality judgements on projects.** We remove spam, scams and abuse. We do not rank or gatekeep ambition.
- **Off-platform conduct**, except where it produces a credible on-platform safety concern.
- **Unaccepted requests' contents**, beyond automated pre-screen — a declined request is private to both parties.
