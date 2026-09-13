# ADMIN_SYSTEM.md

**Design target `[PR]`: the whole platform is operable in 30 minutes a day, on a phone, on a bad connection.**

The admin system is not back-office scaffolding. It is the product surface that determines whether the catalogue stays true, and therefore whether the product survives. It is specified and built with the same care as the public pages.

---

## 1. ROLES

| Role | Can do | Cannot do |
|---|---|---|
| `reviewer` | Work queues; publish, edit, reject, merge opportunities; edit eligibility rules; verify organisations | Touch user accounts; change sources; see audit log |
| `moderator` | Reviewer, plus restrict/suspend users, resolve safety reports, remove UGC | Change sources; manage roles |
| `superadmin` | Everything, including sources, feature flags, roles, exports | — |

**Nobody, at any role, can read `eligibility_profiles`, tracker contents or unflagged messages.** This is enforced in RLS, not policy. A superadmin who needs eligibility data for debugging gets it only via aggregate, non-identifying queries. `[PR]`

---

## 2. HOME — the operator's dashboard

One screen, mobile-first, that answers "is anything wrong, and what do I do next?"

```
┌─────────────────────────────────────┐
│ NEEDS YOU                           │
│ ● 2 scam reports        12h SLA ⚠   │
│ ● 7 low-confidence extractions      │
│ ● 1 organisation claim              │
│ ● 3 duplicate candidates            │
├─────────────────────────────────────┤
│ SYSTEM                              │
│ Sources    38 ok · 2 degraded ⚠     │
│ Ingestion  last run 41m ago  ok     │
│ AI quota   Groq 22% · Gemini 31%    │
│ Email      118/280 used today       │
│ Database   312 MB / 500 MB          │
│ Published  3,412 · stale 47 · exp 8 │
├─────────────────────────────────────┤
│ TODAY                               │
│ +14 published · 4 expired           │
│ 9 reports · 6 resolved              │
└─────────────────────────────────────┘
```

Red states only for things requiring action. **No vanity metrics, no charts that do not drive a decision.** `[PR]`

---

## 3. QUEUES

Seven queues (`MODERATION_AND_TRUST.md` §3), all sharing one interface pattern.

### 3.1 The review card
Designed for one-thumb operation:

```
┌─────────────────────────────────────┐
│ AgriTech AI Challenge 2026          │
│ Kumasi Hive · auto · conf 0.71      │
│─────────────────────────────────────│
│ EXTRACTED          │ SOURCE         │
│ Deadline 30 Sep    │ "Applications  │
│   0.62 ⚠           │  close         │
│ Countries africa   │  September 30" │
│   0.88             │ "Open to       │
│ Team 2–5  0.91     │  students and  │
│ Cost free 0.95     │  young devs    │
│                    │  across        │
│                    │  Africa."      │
│─────────────────────────────────────│
│ [Approve] [Edit] [Reject] [Merge]   │
│ [Open source ↗]                     │
└─────────────────────────────────────┘
```

- Low-confidence fields highlighted and ordered first.
- Every rule shows its `source_quote` adjacent to the extracted value.
- **The editor requires a `source_quote` for any eligibility rule the admin adds or changes.** The invariant applies to humans too. `[PR]`
- Keyboard shortcuts on desktop: `a` approve, `e` edit, `r` reject, `m` merge, `j`/`k` navigate.
- Queue items are claimable, so parallel reviewers do not collide.

### 3.2 Duplicate merge card
Side-by-side diff of the two records with per-field "keep left / keep right" toggles, defaulting to the conservative choice (earliest deadline, highest verification, union of eligible countries). One action to merge, which sets `duplicate_of` and makes the loser's URL return `410 GONE` with `merged_into`.

### 3.3 Organisation claim card
Shows claim email, computed domain match, the organisation's website domain, evidence URL and existing listings. Domain match is displayed prominently — it is the decision in most cases.

---

## 4. OPPORTUNITY MANAGEMENT

- **Quick-add**: paste a URL → pipeline runs synchronously → review card appears → publish. **This is the primary seeding tool** and must be fast, because it is what the operator uses most in the first months.
- Full CRUD with field-level history (`opportunity_changes`).
- Bulk actions: expire, re-verify, retag, reassign organisation — capped at 100 records per action with a confirmation showing exactly what will change.
- Manual state overrides with a mandatory reason, recorded in the audit log.
- Force re-verify: triggers an immediate re-fetch and diff.
- "Notify trackers" toggle on any edit, defaulting to on for deadline, eligibility, cost and apply-URL changes.

---

## 5. SOURCE MANAGEMENT

Adding a source is a form, never a deploy. `[PR]`

Fields: name, kind, URL, cadence, organisation link, default category/region hints, robots posture, ToS URL and posture, legal note, attribution requirement, credentials reference.

Per-source view: health history, last 20 fetches with status, records produced, records published, records rejected, reports attributable to it, and the trust score with its movement history.

Actions: run now, pause, deactivate, adjust cadence, re-run extraction on stored documents with a new prompt version (no re-fetch — important for prompt iteration without hammering publishers).

**Robots check is run and displayed before a source can be activated.** A source whose robots.txt disallows our path cannot be enabled through the UI. `[PR]`

---

## 6. USER AND ORGANISATION MANAGEMENT

**Users:** search by handle/email; view account state, join date, public profile, counts of projects/teams/requests/reports; actions — warn, restrict, suspend, reinstate, force-logout, delete (GDPR-style, with the 30-day process in `PRIVACY_AND_COMPLIANCE.md`).

**Never visible to any admin `[PR]`:** eligibility profile, tracker contents, saved items, unflagged message bodies, digest history.

**Organisations:** verify, reject, suspend, merge duplicates, edit, assign members, adjust trust score with a mandatory reason.

---

## 7. AI AND INGESTION OPERATIONS

- **Prompt versions**: view active version per task, the golden-set scores for each, and roll back. Changing the active version requires the golden set to pass and writes an audit row. `[PR]`
- **Provider health**: per-provider request counts, error rates, breaker state, quota consumption against known limits.
- **Extraction quality**: rolling accuracy against reviewer decisions — approve-without-edit rate is the headline number, because it directly measures whether the pipeline is saving or creating work.
- **Re-run extraction** on stored `raw_documents` with a new prompt version, as a dry run producing a diff before anything is written.

---

## 8. MODERATION TOOLS

Report inbox grouped by subject (all reports about one opportunity in one card, not five separate items). Actions: uphold (with the action taken), dismiss (with a reason), escalate, merge duplicate reports.

Every resolution **notifies the reporter**. Reporter weighting updates automatically.

Safety reports (harassment, impersonation, child-safety) are visually separated and never batched with data-quality reports — different urgency, different mindset.

---

## 9. SYSTEM HEALTH AND ALERTS

| Alert | Condition | Channel |
|---|---|---|
| Scam report open | > 12 h | Telegram, immediate |
| Sources degraded | ≥ 3 for ≥ 12 h | Telegram |
| Ingestion silent | No successful run in 8 h | Telegram |
| Email budget | Exhausted before 18:00 twice running | Telegram |
| AI quota | Any provider > 90% daily | Telegram |
| Database size | > 450 MB | Telegram |
| Supabase pause risk | Keep-alive failed twice | Telegram, urgent |
| Extraction quality | Approve-without-edit < 60% over 50 reviews | Dashboard |
| Backup | Nightly backup failed | Telegram |

All alerts go to Telegram because that is the channel the operator actually reads, and because it costs nothing.

---

## 10. ANALYTICS VIEW

Admin-only, decision-oriented (full metric definitions in `ANALYTICS.md`):
- North-star: weekly builders reaching an eligible opportunity new to them.
- Catalogue health: published, by country, by category, by verification state, stale share.
- Funnel: view → eligibility check → track → apply-click.
- Digest performance: sent, opened, clicked, unsubscribed — by channel.
- Country coverage gaps: countries with fewer than 10 open opportunities, which directly drives sourcing work.
- Density-floor status per surface, so the operator can see what is about to unlock.

---

## 11. AUDIT LOG

Every state-changing admin action writes `admin_audit_log` with actor, action, subject, before/after JSON, timestamp and hashed IP. `[PR]`

Immutable (insert-only; no update or delete grants). Searchable by actor, subject and date. Superadmin-only read. Retained 24 months.

---

## 12. ADMIN UI CONSTRAINTS

- Same design system as the public product, distinguished by a persistent admin bar — never a different visual language.
- **Byte budget applies**: ≤ 200 KB per admin route. The operator is often on the same expensive connection as the users.
- Mobile-first for queues specifically. Queue clearing must work one-handed on a phone, because that is when it will actually happen.
- Destructive actions require typed confirmation of the subject's name, not just an "Are you sure?" dialog.
- Every admin action is idempotent and safe to retry — connections drop.
