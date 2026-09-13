# IMPLEMENTATION_PLAN.md

**Sequencing rule `[PR]`:** build in the order that makes the product **useful to one user with nobody else present**, then add the features that require density. Every phase ships something a real person can use.

**Scope commitment:** every capability in `PRODUCT_SPEC.md` is represented somewhere in this plan. Phasing orders the work; it does not delete the vision.

---

## 1. DEPENDENCY GRAPH

```
P0 Foundation
   │
   ├──► P1 Opportunity core (public, no accounts) ◄── the product works here
   │        │
   │        ├──► P2 Accounts · eligibility profile · tracker · Telegram
   │        │        │
   │        │        ├──► P3 Ingestion automation · freshness  ◄── it stays true here
   │        │        │        │
   │        │        │        ├──► P4 Search & recommendations
   │        │        │        │        │
   │        │        │        │        ├──► P5 Intent & team rooms   (needs density)
   │        │        │        │        ├──► P6 Projects & matching
   │        │        │        │        └──► P7 Organisations self-serve
   │        │        │        │
   │        │        │        └──► P8 Admin hardening & moderation at scale
   │        │        │
   │        │        └──► P9 PWA · offline · low-data
   │        │
   │        └──► P10 SEO & country/category matrix
   │
   └──► P11 Polish · accessibility audit · performance
```

**Critical path: P0 → P1 → P2 → P3.** Everything after P3 is additive. If the project stops at P3, the result is a genuinely useful product that tells the truth. That is the design's insurance policy.

---

## 2. PHASE 0 — FOUNDATION (1–2 weeks)

**Build:** repository and CI; Cloudflare Pages + Workers deployment; Supabase project with migrations; design tokens and base components; **byte-budget check in CI**; error tracking; health endpoint; feature-flag table; `countries`, `regions`, `categories`, `tags` seeded.

**Acceptance:**
- A styled page deploys to production.
- CI **fails** a deliberately oversized bundle.
- Migrations run forward and backward.
- All 54 African countries and the full category set are in the database.

**Do not skip:** the byte-budget CI check. Retrofitting a performance budget after the UI exists never works, and this product's constraint is real money for its users.

---

## 3. PHASE 1 — OPPORTUNITY CORE (3–4 weeks)

**The product becomes useful here, with no accounts and no other users.**

**Build:** `opportunities`, `organisations`, `eligibility_rules` schema with RLS; **the deterministic eligibility engine** plus its 60-item golden test corpus; opportunity list with filters (URL state); opportunity detail page; verdict block with source quotes; anonymous eligibility check with localStorage; organisation pages; admin quick-add; manual publishing; report form (logged-out, Turnstile).

**Acceptance `[PR]`:**
- A logged-out visitor gets a truthful verdict with quoted source sentences.
- The eligibility test suite passes, including the invariant that ambiguity resolves to `unclear` and **never** to `eligible`.
- Opportunity detail page transfers **≤ 120 KB** on first visit.
- No page requires JavaScript to display its content.
- 50 opportunities entered manually and published.

**Risks:** the eligibility engine's aggregation logic is the product's spine — it deserves more test coverage than any other module in the codebase.

---

## 4. PHASE 2 — ACCOUNTS, TRACKER, TELEGRAM (3 weeks)

**Build:** Supabase Auth with GitHub and Google OAuth plus email OTP; 18+ gate; eligibility profile UI with per-field "what this unlocks"; tracker with all states; personal verdicts; saved items; Telegram bot and account linking; notification tables, preferences and the budgeted dispatcher; deadline reminders; export and delete.

**Acceptance `[PR]`:**
- Sign-in completes in under 3 taps from a save action, returning the user to where they were.
- Local eligibility inputs are offered as a prefill on first signup.
- A Telegram-linked user receives a deadline reminder without any email being sent.
- Email dispatcher respects the 280/day budget and defers by priority rather than dropping.
- Export produces complete JSON; delete removes the account within the stated 30 days.
- **RLS test suite proves `eligibility_profiles` is unreadable by every principal except its owner, including admins.**

---

## 5. PHASE 3 — INGESTION AND FRESHNESS (4 weeks)

**This is where the product's promise becomes structural rather than manual.**

**Build:** `sources` registry with robots and ToS posture; GitHub Actions batch tier; fetch, normalise, canonicalise; the LLM provider abstraction with fallback chain and `NO_AI` handling; structured extraction; **eligibility rule derivation with verbatim-quote validation**; dedupe; confidence gating; review queues; link health checks; re-verification cadence; change detection with tracker notifications; expiry; source health alerting; nightly backup to R2 with a tested restore.

**Acceptance `[PR]`:**
- 10 sources ingesting on schedule.
- No rule is ever stored without a source quote that verbatim-matches the document.
- Golden-set metrics meet the thresholds in `AI_SYSTEM.md` §12.
- With every LLM provider disabled, the site still serves, search still works, and nothing false is displayed.
- A deadline change on a tracked opportunity produces exactly one notification showing old and new values.
- Backup restore tested and documented.

**Risks:** extraction quality below the gate produces a growing review queue rather than bad data — that is the intended failure mode, but it means **operator time is the real constraint**. Do not widen the source list faster than the queue can be cleared.

---

## 6. PHASE 4 — SEARCH AND RECOMMENDATIONS (2–3 weeks)

**Build:** `tsvector` FTS with weighting; local embedding generation in CI; pgvector HNSW; hybrid retrieval with RRF; ranking formula in one constants file; NL query compiler with visible chips and heuristic fallback; nightly recommendation precomputation; "Your window"; "What should I do next".

**Acceptance:**
- Search returns in under 300ms at p95 on the seeded corpus.
- Disabling embeddings degrades to FTS with no error shown to the user.
- NL query renders editable chips; disabling the compiler falls back to heuristics silently.
- "Your window" is capped at 8 and dated; "next actions" at 5, each with a reason.
- Cold-start users see an honestly-labelled country board, never an empty panel.

---

## 7. PHASE 5 — INTENT AND TEAM ROOMS (3 weeks)

**Gated on P3 and a seeded catalogue. Do not start before the catalogue is real.**

**Build:** intents with auto-expiry; density-floor evaluation and feature flags; team rooms; teams and members; join requests with rate limits; accept/decline; minimal threads; handoff with two-sided consent; blocking; room archival; host-platform link-out banner.

**Acceptance `[PR]`:**
- A room below its floor is **never rendered** — the route returns the opportunity page with a single CTA.
- Intent count is hidden entirely below 5.
- No endpoint returns another user's contact details at any point before mutual handoff consent.
- `max_size` is validated against the opportunity's own team-size rule.
- Rate limits enforced and visible to the user before composing.

**Kill criterion:** `TEAM_FORMATION.md` §8 — under 15% of enabled rooms reaching 3+ intents after three months, withdraw rather than iterate.

---

## 8. PHASE 6 — PROJECTS (2–3 weeks)

**Build:** project CRUD with visibility levels; embeddings; project→opportunity matching (synchronous first pass plus nightly batch); matched-calls display with reasons; roles needed; interest requests; project members; submissions; lifecycle and inactivity handling.

**Acceptance:**
- Matched opportunities render within seconds of project creation, **before any other prompt**.
- A private project still receives matches.
- Public project browse does not exist below 40 public projects — the route is absent, not empty.

---

## 9. PHASE 7 — ORGANISATIONS SELF-SERVE (2 weeks)

**Build:** claim flow with domain-matched email verification; organisation members; self-serve opportunity submission and editing; `official` verification; re-review on eligibility, date or cost edits; public submission form with Turnstile.

**Acceptance:** a domain-matched claim completes end to end; an organisation edit to a deadline re-enters review and notifies trackers.

---

## 10. PHASE 8 — ADMIN AND MODERATION AT SCALE (2–3 weeks)

**Build:** the full admin dashboard; all seven queues with claiming; the review card with side-by-side source quotes; merge tooling; source management UI including the robots gate; user actions and the enforcement ladder; report inbox with grouping and reporter notification; reporter weighting; moderation pre-screen wiring; audit log; the alert set in `ADMIN_SYSTEM.md` §9.

**Acceptance `[PR]`:**
- All queues clearable one-handed on a phone.
- Admin routes stay within the 200 KB budget.
- Every state-changing action writes an audit row with before and after.
- The rule editor refuses to save an eligibility rule without a source quote.
- Priority-1 SLA breach fires a Telegram alert.

---

## 11. PHASE 9 — PWA, OFFLINE, LOW-DATA (2 weeks)

**Build:** service worker with the caching strategies in `SYSTEM_ARCHITECTURE.md` §3.4; offline write queue in IndexedDB with visible pending state and replay; low-data mode (cookie plus `Save-Data` header, server-side); monogram fallbacks; install prompt at an appropriate moment.

**Acceptance:** tracker and last 50 opportunities readable offline; a tracker change made offline syncs on reconnect with one confirmation toast; low-data list page transfers **under 40 KB**.

---

## 12. PHASE 10 — SEO AND THE COUNTRY MATRIX (1–2 weeks, can run parallel to P4+)

**Build:** JSON-LD per category type; country and category pages; the country × category matrix with the 5-item generation floor; segmented sitemaps; canonicals; `410` handling for merged records; RSS feeds; static OG card; metadata templates.

**Acceptance:** structured data validates for every category type; country × category pages below 5 items redirect rather than render; `noindex` verified on every private route and on non-opted-in profiles and projects.

---

## 13. PHASE 11 — POLISH (2 weeks, continuous thereafter)

Full axe audit on every public route; manual keyboard and screen-reader pass; contrast verification of every token pair; field performance against the byte budgets on a real mid-tier Android over a throttled connection; empty, loading and error states reviewed against `DESIGN_SYSTEM.md` §6; copy review for the voice rules; `prefers-reduced-motion` verified.

---

## 14. PHASES vs THE ORIGINAL BRIEF

Every capability the brief asked for, and where it lands. **Nothing is silently dropped** — items that were removed are named with the reason.

| Brief capability | Phase | Note |
|---|---|---|
| Opportunity directory, structured records | P1 | |
| Opportunity discovery and filters | P1 | |
| Natural language search | P4 | Reframed as a transparent query compiler |
| AI opportunity matching | P4 | Deterministic gate + embeddings, precomputed |
| AI eligibility analysis | **P1** | Rules engine, not per-query AI. The spine. |
| Personalised feed | P4 | Bounded "Your window", not infinite |
| "What should I do next" | P4 | Deterministic rules over the user's own state |
| Project board | P6 | |
| Project lifecycle | P6 | |
| Project collaboration | P6 | Consent-bound requests |
| Hackathon team formation | P5 | Intent + opportunity-scoped rooms |
| AI team matching | P5 | Role complementarity only — no compatibility scoring |
| Project → opportunity matching | P6 | |
| Opportunity → project | P6 | Behind a density floor |
| AI project idea generator | — | **Removed.** Replaced by the Brief Decoder (P3). Commodity LLM output. |
| AI hackathon copilot | — | **Removed.** Feature creep into a chat product. |
| AI judging simulator | — | **Removed.** Manufactures false authority; users optimise against a fiction. |
| Builder profiles | P2 / P5 | Two-layer: private eligibility, opt-in public |
| Builder discovery | P5 | Rooms only. Global index behind a density floor, not built. |
| Community philosophy | All | Enforced by the absence of feeds, likes and follower counts |
| Opportunity data collection | P3 | |
| Automatic structuring | P3 | |
| Data quality | P3 | |
| Organisation pages | P1 / P7 | |
| Deadlines and states | P1 | |
| Opportunity tracking | P2 | |
| Achievements | — | **Deferred.** Unverifiable at $0; revisit with two-party attestation. |
| Africa map | — | **Removed.** Replaced by country index pages. Tiles breach the data budget. |
| Homepage | P1 | The live closing board |
| All user journeys | P1–P6 | `UX_FLOWS.md` |
| Trust and verification | P1 / P3 | |
| UGC moderation | P5 / P8 | |
| Privacy | P2 | Plus `PRIVACY_AND_COMPLIANCE.md` |
| Free-first | All | `FREE_INFRASTRUCTURE.md` |
| Admin system | P1 (minimal) / P8 (full) | |
| Analytics | P3 onward | `ANALYTICS.md` |
| Notifications | P2 | Budgeted queue, Telegram-first |
| Search relationships | P4 | |
| Mobile-first | All | Byte budgets in CI |
| Design quality | P0 / P11 | `DESIGN_SYSTEM.md` |
| Branding | Pre-launch | Parameterised; trademark and domain checks required |
| Responsive system | P0 / P11 | |
| Accessibility | P0 / P11 | WCAG 2.1 AA in CI |
| Technical planning | P0 | `SYSTEM_ARCHITECTURE.md` |
| Free infrastructure research | Done | `FREE_INFRASTRUCTURE.md` |
| AI cost strategy | P3 | `AI_SYSTEM.md` §11 |
| Security | All | `SECURITY.md` |
| Performance | All | Byte budgets |
| SEO | P10 | |
| Content strategy | Pre-launch | `CONTENT_AND_LAUNCH.md` |

---

## 15. WHAT A CODING AGENT SHOULD BUILD FIRST

Strict order for the first two weeks, chosen because each step de-risks the next:

1. **The eligibility engine as a pure function, with its test corpus.** No UI, no database. It is the product's spine and everything else assumes it works.
2. **The `opportunities` + `eligibility_rules` schema with RLS.**
3. **The opportunity detail page, server-rendered, under 120 KB.**
4. **The anonymous eligibility check.**
5. **The admin quick-add tool**, so real data can enter immediately.

After step 5 there is a working, honest, useful product with fifty hand-entered opportunities. Everything else in this plan makes that product bigger, fresher and more social — but step 5 is the point at which it is already worth someone's time.

---

## 16. RULES FOR THE CODING AGENT `[PR]`

1. **Never publish an opportunity without a source URL.**
2. **Never store an eligibility rule without a verbatim source quote.**
3. **Never resolve eligibility ambiguity to `eligible`.** Ambiguity is `unclear`.
4. **Never render a social surface below its density floor.** Absent, not empty.
5. **Never exceed a byte budget.** CI enforces it; do not add an override.
6. **Never send user personal data to an LLM provider.**
7. **Never hard-code a model name.** Models are configuration.
8. **Never call an LLM in a request handler** except the cached query compiler.
9. **Never create fake users, teams, projects or counts.**
10. **Never let an AI failure produce a user-facing error.** Degrade and state it plainly.
11. **Never commit a secret** — the batch repository is public.
12. **Never add a third-party script to a public page.**
13. **Every feature must have its empty, loading, error and offline state specified before it is built.**
14. **When a spec and an implementation convenience conflict, raise it — do not silently resolve it.** The specifications were written with reasons; some of those reasons are not obvious from the code.
