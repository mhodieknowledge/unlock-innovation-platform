# PRODUCT_SPEC.md

**Source of truth for the product.** Architecture (`SYSTEM_ARCHITECTURE.md`), design (`DESIGN_SYSTEM.md`, `UX_FLOWS.md`) and implementation (`IMPLEMENTATION_PLAN.md`) derive from this document. Where any other document conflicts with this one, this one wins on *what the product does*; `SYSTEM_ARCHITECTURE.md` wins on *how it is built*.

**Requirement tags:** `[PR]` product requirement (non-negotiable), `[TD]` technical decision (documented in the architecture docs), `[OPT]` optional implementation choice, `[FUT]` future scalability consideration — specified but not built in Phase 1.

---

## 1. WORKING BRAND

The name is a **configuration token**, not a hard-coded string. Implement as `BRAND_NAME`, `BRAND_DOMAIN`, `BRAND_HANDLE` in a single config module. `[PR]`

- **Working codename: Mbele** — Swahili *mbele*, "forward / ahead". Chosen because the product's promise is "what can I do next".
- Alternates, in order: **Njia** (Swahili, "path"), **Jengo** (Swahili, "building"), **Kesho** (Swahili, "tomorrow"), **Sasa** (Swahili, "now").
- **Not verified:** trademark clearance and domain availability for any of these. Several adjacent names are known to be taken (Jenga — game trademark and a Kenyan fintech; Anzisha — the Anzisha Prize; Ubuntu — Canonical). A trademark and domain check across `.com / .africa / .io / .dev`, plus native-speaker connotation review across Swahili, Shona, Ndebele, Zulu, Yoruba, Igbo, Hausa and Amharic, is **required before any public launch**. Until then the codename is provisional.

---

## 2. PRODUCT PURPOSE

Give any African builder a **true, fast, personal answer** to four questions about any opportunity:

1. **Is it open?**
2. **Can I apply?**
3. **What is actually required?**
4. **Who else is going for it?**

Everything else in the product exists to make one of those four answers better.

---

## 3. THE CORE PROBLEM

African builders are not short of opportunities. They are short of **certainty**.

Opportunities arrive as an unfiltered firehose through Telegram channels, WhatsApp groups, campus communities and X. For every one, the builder must personally determine whether it is still live, whether their country qualifies, whether their year of study qualifies, what the deliverables are, and who would do it with them — by reading source documents on a phone over data that costs up to $43.75/GB. Thousands of people repeat that same work against the same handful of documents. Much of it is wasted, because the answer was "you were never eligible" or "this closed three weeks ago".

The product does that work **once, structurally**, and gives everyone the answer.

---

## 4. TARGET USERS

### 4.1 Primary
African builders: students, self-taught developers, designers, data scientists, early-career engineers, researchers and first-time founders, aged 18+, mobile-primary, cost-sensitive, English-reading at launch.

### 4.2 Geographic priority
**Tier 1 (launch focus):** Zimbabwe, Zambia, Botswana, Namibia, Malawi, Mozambique — highest awareness gap, weakest incumbent coverage.
**Tier 2:** Ghana, Kenya, Nigeria, Rwanda, Uganda, Tanzania, South Africa.
**Tier 3:** remainder of the 54, plus diaspora where eligibility permits.

Tiering affects **content seeding and promotion only**, never eligibility logic or data model. All 54 countries are first-class from day one. `[PR]`

### 4.3 Secondary users
- **Organisations** — publish and maintain their own opportunities.
- **Community leaders** — GDG/campus organisers who redistribute to their groups.
- **Administrators** — operate the platform.

### 4.4 Explicit non-users at launch
Recruiters and talent sourcers, investors sourcing dealflow, under-18s (see §22), organisations seeking paid promotion.

---

## 5. PERSONAS

| # | Persona | Situation | Primary need | Success for them |
|---|---|---|---|---|
| P1 | **Tari** — 2nd-year CS student, Bulawayo | Prepaid data, low-end Android, no professional network, 3 free weeks | Find something real she can *actually* enter | Applies to one thing she qualifies for, without wasting data discovering she didn't |
| P2 | **Kofi** — self-taught full-stack dev, Kumasi | Working, wants portfolio and prize money | Filter by remote + team + prize, fast | Finds a remote hackathon, forms a team, submits |
| P3 | **Amara** — designer, Lagos | Skilled, but no dev teammates | Join a team that needs a designer | Gets accepted into a team room and ships |
| P4 | **Chipo** — has a project idea, Lusaka | Solo, needs collaborators and funding | Find both people and matching open calls | Project matched to 3 grants she's eligible for |
| P5 | **Dr Musa** — lecturer/community lead, Kano | Runs a GDG chapter | A trustworthy list to forward | Shares a country page weekly |
| P6 | **Programme officer** — pan-African foundation | Wants applicants from underrepresented markets | Publish once, reach the right people | Listing verified and distributed |
| P7 | **Admin** — operator | 5 hours/week | Keep the catalogue true with minimum labour | Queues cleared, sources healthy |

---

## 6. USER MOTIVATIONS

| Motivation | Product response |
|---|---|
| Not wasting scarce time and data | Eligibility verdict before the click; tiny pages; Telegram delivery |
| Fear of missing a deadline | Deadline-first surfaces, saved-item reminders, digests |
| Fear of being scammed | Verification states, source attribution, anti-fee policy |
| Wanting to be taken seriously | Serious visual and editorial tone; no gamification |
| Needing people | Intent + team rooms scoped to a real, dated opportunity |
| Wanting their existing work to pay off | Project → matching open calls |

---

## 7. CORE VALUE PROPOSITION

> **Everything here is open, and we tell you whether you can apply.**

Three claims, in priority order, each falsifiable:
1. **Live.** We do not show dead opportunities. Every record shows when it was last verified.
2. **Eligible.** We tell you, per opportunity, whether *you* qualify — and show the sentence we based it on.
3. **Together.** Where a real cohort exists for an opportunity, we show it to you.

---

## 8. PRODUCT PRINCIPLES

1. **Truth over volume.** A smaller, verified catalogue beats a larger, rotting one. `[PR]`
2. **Uncertainty is stated, never hidden.** `unclear` is a first-class verdict shown proudly. Never assert eligibility we cannot support. `[PR]`
3. **No account required to receive value.** All opportunity, organisation and country content is fully public and readable logged-out. `[PR]`
4. **Bytes are money.** Every route has a byte budget; every feature is weighed against it. `[PR]`
5. **Deterministic by default, AI at the edges.** AI runs at ingestion, not at query time. The product must work fully with every AI quota exhausted. `[PR]`
6. **People appear where they are dense.** No surface displays a social list unless it passes a density floor. `[PR]`
7. **Consent before contact.** No contact detail is revealed, and no thread opens, without mutual acceptance. `[PR]`
8. **Low operator load.** Any feature that cannot be moderated in minutes per day is redesigned or cut. `[PR]`
9. **Attribution always.** Every opportunity links to and names its official source. `[PR]`
10. **Not a social network.** No follower counts, no likes, no infinite feed, no engagement metrics shown to users. `[PR]`

---

## 9. CORE PRODUCT LOOP

```
        ┌──────────────────────────────────────────────┐
        │                                              │
        ▼                                              │
   DISCOVER ──► CHECK ELIGIBILITY ──► TRACK ──► DECLARE INTENT
   (search,      (deterministic       (save,      (I'm going
    digest,       verdict + why)       applied)    for this)
    Telegram)                                          │
                                                       ▼
                                                  FIND PEOPLE
                                                  (team room for
                                                   this opportunity)
                                                       │
                                                       ▼
                                                     BUILD
                                                  (project record)
                                                       │
                                                       ▼
                                              PROJECT UNLOCKS MORE
                                              (matched open calls)
                                                       │
                                                       └──────────┘
```

Each arrow must deliver value even if the next arrow is never taken. `[PR]`

---

## 10. ENTITY MODEL (product-level)

Six core entities. Full schema in `DATA_MODEL.md`.

1. **Opportunity** — a dated, eligibility-bearing thing you can apply for or enter.
2. **Organisation** — who runs it.
3. **Builder** (user + profile + **eligibility profile**) — who might apply.
4. **Intent** — a builder's declared commitment to pursue a specific opportunity. *The liquidity primitive.*
5. **Team** — an opportunity-scoped group formed from intents.
6. **Project** — a durable thing a builder is building, independent of any opportunity.

Relationships the product must express: Opportunity↔Organisation, Opportunity↔Builder (via Intent and Tracker), Opportunity↔Team, Opportunity↔Project (match + submission), Builder↔Team, Builder↔Project, Project↔Project (none — no project graph). `[PR]`

---

## 11. OPPORTUNITY SYSTEM

### 11.1 Taxonomy `[PR]`
Categories (extensible via admin, never hard-coded in UI): `hackathon`, `coding_competition`, `ai_challenge`, `data_competition`, `innovation_challenge`, `startup_competition`, `pitch_competition`, `grant`, `fellowship`, `scholarship`, `internship`, `accelerator`, `incubator`, `bootcamp`, `developer_program`, `research_opportunity`, `open_source_program`, `entrepreneurship_program`, `conference_cfp`, `community_challenge`, `other`.

Adding a category must require **no code change**. `[PR]`

### 11.2 Required record fields
See `DATA_MODEL.md` for types. Product-level requirements:
- Title, organisation, summary (our words, ≤400 chars), description (normalised, never a verbatim copy of the source article) `[PR]`
- Category + subcategories + tags + skills + technologies + industries
- **Geography:** eligibility scope (`country_list` / `region` / `africa_wide` / `global` / `unclear`), participation mode (`online` / `in_person` / `hybrid`), physical location if applicable
- **Dates:** `opens_at`, `deadline_at`, `deadline_precision` (`exact_time` / `date_only` / `month_only` / `rolling` / `unknown`), `deadline_timezone`, `starts_at`, `ends_at`
- **Participation:** individual/team, team size min/max
- **Value:** prize amount + currency, funding, other benefits, and **cost to participate** (`free` / `paid` / `unknown`) `[PR]`
- **Eligibility rule set** (structured — §12)
- **Provenance:** source, source URL, official URL, apply URL, first seen, last checked, extraction confidence, verification state
- **Lifecycle status:** `draft`, `in_review`, `published`, `closing_soon`, `closed`, `expired`, `cancelled`, `rejected`, `merged`

### 11.3 Deadline states `[PR]`
Derived, never stored as a status: `closing_today` (<24h), `closing_in_2_days`, `closing_this_week` (≤7d), `closing_this_month` (≤31d), `open`, `opens_soon`, `rolling`, `closed`, `unknown`.
When `deadline_precision` is coarser than `exact_time`, display conservatively (treat "September 30" as expiring at the **start** of 30 September in the user's timezone when warning, and show the raw source string).

### 11.4 Verification states `[PR]`
`official` (submitted or claimed by a verified organisation) · `verified` (human-reviewed against the official source) · `auto` (machine-extracted, published above confidence threshold, not human-reviewed) · `community_flagged` · `stale` (past re-verification window) · `expired` · `disputed`.

The state and the `last_verified_at` timestamp are **always visible on the opportunity page and card**. `[PR]`

### 11.5 The anti-scam rule `[PR]`
Any opportunity with `cost = paid`, or any unknown cost where the source mentions a fee, **cannot be published without human review**. The platform displays a permanent statement that it never asks users to pay to apply, and any listing requiring payment to *apply* (as opposed to participate, e.g. conference tickets) is rejected outright.

---

## 12. ELIGIBILITY SYSTEM — the spine

### 12.1 Eligibility Profile `[PR]`
A first-class user object, separate from the public profile, **private by default**:
`country_of_residence`, `nationalities[]`, `date_of_birth` or `age_band`, `student_status` (`not_student` / `secondary` / `undergraduate` / `postgraduate` / `recent_graduate`), `year_of_study`, `institution`, `field_of_study`, `years_experience`, `languages[]`, `availability_hours_per_week`, `available_from`/`available_until`, `can_travel`, `has_valid_passport`, `willing_remote_only`.

Every field is optional. Missing fields produce `unclear` on rules that need them, plus a prompt to fill exactly that field. `[PR]`

### 12.2 Eligibility rules
Extracted **once per opportunity at ingestion** into a machine-evaluable rule set. Each rule carries a type, parameters, the **verbatim source sentence** it came from, and a confidence score. Rule types at minimum:
`country_in`, `country_not_in`, `nationality_in`, `residency_required`, `age_between`, `student_status_in`, `year_of_study_in`, `institution_type_in`, `experience_between`, `team_size_between`, `individual_only`, `team_only`, `gender_restricted`, `language_required`, `cost`, `travel_required`, `other_unstructured`.

`gender_restricted` exists because women-in-tech programmes are a real and important category; it is evaluated only against a field the user has explicitly and optionally provided, and is never inferred. `[PR]`

### 12.3 Evaluation `[PR]`
**Deterministic. No LLM call at query time. Ever.**

Per rule: `pass` / `fail` / `unknown` (user data missing) / `unparsed` (rule confidence too low).
Aggregate verdict:
- any `fail` → **`not_eligible`**
- else any `unparsed` on a high-stakes rule type (country, age, student status) → **`unclear`**
- else any `unknown` → **`unclear`**, naming exactly which profile field would resolve it
- else all `pass` with high confidence → **`eligible`**
- else all `pass` but some rule confidence below threshold → **`likely_eligible`**

### 12.4 Presentation `[PR]`
The verdict is displayed with a per-rule breakdown, each line showing the rule, the outcome, and the **quoted source sentence**. Every verdict carries: *"Always confirm on the official page — rules change."* with a direct link. A user can flag a wrong verdict in one tap, which creates a moderation item.

The product must **never** state "you are eligible" without a source quote backing every passing rule. `[PR]`

---

## 13. DISCOVERY AND SEARCH

### 13.1 Filters `[PR]`
Country (and "eligible for me"), region, category, deadline state, participation mode, individual/team, experience level, student-eligible, cost, prize present, organisation, skills, technologies, industries, language, verification state.

Filters are URL state (shareable, back-button-correct, server-renderable). `[PR]`

### 13.2 Search `[TD]`
Hybrid: Postgres full-text (weighted title/org/summary/tags) + vector similarity, fused by reciprocal rank. Deterministic ranking with a documented, tunable formula (see `SYSTEM_ARCHITECTURE.md` §Search).

### 13.3 Natural-language query compiler `[PR]`
NL input is **compiled to visible, editable filter chips**, then deterministic search runs. The user always sees what the system understood. If the compiler is unavailable (quota, outage), input falls back to keyword search with a quiet notice. The compiler never returns results directly and never generates prose answers about opportunities. `[PR]`

### 13.4 Default sort
`deadline urgency × eligibility verdict × freshness`, documented and tunable. Never "relevance" alone — this is a deadline product.

---

## 14. PERSONALISATION AND RECOMMENDATIONS

### 14.1 "Your window" `[PR]`
Replaces the infinite feed. A **bounded, dated** surface: at most 8 items, all with deadlines in the next 30 days, all `eligible` or `likely_eligible`, ordered by urgency then fit. States what it is doing and why each item is there.

### 14.2 "What should I do next" `[PR]`
A small, capped action list (max 5) assembled from **deterministic rules over the user's own state**, not from an LLM. Rule examples: a saved item closing in ≤5 days; an eligible item closing in ≤7 days matching ≥2 profile skills; a team room they joined with an unanswered request; a project with new matched calls; an incomplete eligibility field blocking ≥5 verdicts.

Each item states the reason and links to one action. No motivational filler. `[PR]`

### 14.3 Matching mechanics `[TD]`
1. **Deterministic gate:** eligibility verdict ∈ {eligible, likely_eligible} and status is open.
2. **Similarity:** cosine between the user's profile embedding (skills + interests + technologies + projects) and the opportunity embedding.
3. **Urgency weight:** rises as the deadline approaches, drops to zero after.
4. **Diversity:** at most 2 items per organisation, at most 3 per category.
5. **Explanation:** templated from matched rules and overlapping tags — *"Zimbabwe eligible · remote · Python and ML match your profile · closes in 5 days."* Never free-generated. `[PR]`

All of this is **precomputed in batch** and cached. `[TD]`

---

## 15. TRACKING

Personal tracker states `[PR]`: `saved`, `planning_to_apply`, `applied`, `submitted`, `participating`, `completed`, `outcome_won`, `outcome_placed`, `outcome_not_selected`, `withdrawn`, `missed_deadline`.

Requirements: private by default; optional personal note and application date; one-tap transitions; deadline reminders driven by tracker state; a personal timeline view; export of the user's tracker as CSV/JSON `[PR]`.

`outcome_*` states are the seed for future verified participation records `[FUT]`.

---

## 16. BUILDER PROFILES

### 16.1 Two-layer model `[PR]`
- **Eligibility profile** — private, never displayed to other users, used only for verdicts and matching.
- **Public builder profile** — opt-in, off by default. Contains display name, country, headline, bio, skills, technologies, interests, links (GitHub, portfolio, one social), collaboration availability, public projects, and team memberships the user chose to show.

A user can use the entire opportunity product with **no public profile at all**. `[PR]`

### 16.2 Visibility levels `[PR]`
`private` (default) · `discoverable_in_rooms` (visible only inside team rooms for opportunities you declared intent on) · `public` (indexable page).

### 16.3 Builder discovery `[PR]`
- **Phase 1:** exists **only** inside team rooms. No global directory.
- **Later:** a searchable builder index unlocks **only** when a density floor is met (see §24), and only includes users at `public` visibility.

Contact details are never shown on a profile. Contact happens through connection requests. `[PR]`

---

## 17. PROJECTS

### 17.1 Purpose
A project's payoff is **matched open calls**, collaborators, and a durable record — in that order.

### 17.2 Fields
Title, one-line pitch, problem, solution, target users, stage, categories/industries, skills and technologies used, skills needed, roles needed, links (repo, demo, docs), visibility, connected opportunities, members and roles.

### 17.3 Lifecycle `[PR]`
`idea` → `looking_for_collaborators` → `team_forming` → `building` → `testing` → `launched` → `completed` → `paused` → `archived`. Transitions are manual; a project inactive for 120 days is prompted, and after 180 days is auto-set `paused` (never deleted). `[PR]`

### 17.4 Visibility `[PR]`
`private` (default) · `unlisted` (link only) · `public`. A project at `private` still receives opportunity matches — this is the point.

### 17.5 Project → Opportunity matching `[PR]`
On creation and on a nightly batch, compute matched open calls using the same gate-then-similarity mechanic as §14.3, with the *owner's* eligibility profile applied. Display as "N open calls match this project", with per-item reasons.

### 17.6 Opportunity → Project `[PR]`
On an opportunity page, show relevant public projects and teams seeking members — **only if the density floor is met** for that opportunity.

---

## 18. INTENT AND TEAM FORMATION

Full specification in `TEAM_FORMATION.md`. Product-level requirements:

### 18.1 Intent `[PR]`
On any open opportunity a signed-in user may declare intent, choosing exactly one stance: `going_solo`, `looking_for_team`, `have_team_looking_for_roles`, `just_interested`.
- Intent is **public within that opportunity's room only**, never elsewhere.
- Intent **expires automatically** when the opportunity closes.
- Aggregate counts ("14 builders declared intent") are shown publicly on the opportunity page once ≥5, as a trust and momentum signal. Below 5, no count is shown. `[PR]`

### 18.2 Team rooms `[PR]`
One room per opportunity, open while the opportunity is open, archived after. Contains: open teams with the roles they need, solo builders looking for a team, and a request mechanism. No chat. No feed.

### 18.3 Teams `[PR]`
Created by a builder, named, with a pitch, declared roles needed, and a size limit bounded by the opportunity's own `team_size` rule. States: `forming`, `open_for_roles`, `full`, `submitted`, `disbanded`. Owner can accept/decline requests, transfer ownership and remove members. Members can leave.

### 18.4 Requests `[PR]`
Join requests carry a role and a message capped at 500 characters. Rate-limited (see `MODERATION_AND_TRUST.md`). No contact information is exchanged until acceptance. On acceptance, a minimal thread opens **and** the product offers handoff to Telegram/WhatsApp/email with explicit consent from both sides. `[PR]`

### 18.5 Prioritisation `[PR]`
Team rooms are enabled by default for opportunities **without** host-platform team tooling (grants, fellowships, local and university competitions) and for team-required opportunities. For opportunities hosted on platforms with their own registrant directory, the room is shown with a link to the host's own tooling.

---

## 19. ORGANISATIONS

Fields: name, description, country, region, website, logo, categories, verification state, contact for listings, opportunities.

`unclaimed` (created by ingestion) · `claimed_pending` · `verified` (domain-matched email confirmed) · `rejected` · `suspended`. `[PR]`

Verified organisations may submit and edit their own opportunities, which publish with `official` verification. Edits by an organisation to a previously verified record re-enter review if they change eligibility, dates or cost. `[PR]`

Organisation pages are public and indexable and carry all their opportunities, past and present. `[PR]`

---

## 20. AI CAPABILITIES (exhaustive — nothing else is AI)

Full specification in `AI_SYSTEM.md`.

| # | Capability | When it runs | Fallback if unavailable |
|---|---|---|---|
| 1 | **Structured extraction** — unstructured page → opportunity record | Ingestion, once per document | Record queued for manual entry; nothing published |
| 2 | **Eligibility rule derivation** — prose → rule set + source quotes | Ingestion, once per document | Rules empty; every verdict is `unclear` |
| 3 | **Brief Decoder** — official rules → structured brief (theme, deliverables, judging criteria, key dates, prohibitions), each with a source quote | Once per opportunity, on demand, then cached forever | Section hidden; link to source shown |
| 4 | **Query compiler** — NL string → filter chips | Query time, cached by normalised query string | Keyword search + manual filters |
| 5 | **Embeddings** — opportunities, projects, profiles | Batch, plus query-time for the query string | Cached embeddings only; keyword search |
| 6 | **Duplicate candidate scoring** | Ingestion | Deterministic URL + trigram + date matching only |
| 7 | **Moderation pre-screen** — free text and links | On submit | Everything routes to the human queue |

**Explicitly not built:** judging simulation, hackathon copilot chat, generic idea generation, AI-written opportunity descriptions presented as ours, chat assistant of any kind. `[PR]`

**Hard AI rules** `[PR]`:
- AI never invents an opportunity. Every user-visible opportunity fact traces to a stored, sourced record.
- AI output that fails schema validation is discarded, never rendered.
- Anything AI-derived and user-visible is labelled and carries its source quote.
- No user personal data is ever sent to a provider whose free tier trains on inputs.
- Every AI path has a deterministic fallback and the product remains fully usable without any of them.

---

## 21. NOTIFICATIONS

Full specification in `NOTIFICATIONS.md`. Product-level:

**Channels** `[PR]`: in-app, **Telegram (primary push)**, email (budgeted), web push `[OPT]`, RSS per country/category `[PR]`.

**Types:** deadline reminder for tracked items, digest of new matches, join request received, request accepted/declined, team update, opportunity changed (deadline/eligibility/closed) for tracked items, project match found, moderation outcome.

**Rules** `[PR]`:
- Hard cap: **one digest per user per day** and **no more than 3 transactional notifications per user per day**, excluding direct request/accept events.
- Email is a **priority queue against a daily budget**, not a broadcast. When the budget is exhausted, the queue defers by priority; it never silently drops without being visible in-app.
- Every message states why it was sent and carries a one-tap unsubscribe for that type.
- Quiet hours honoured in the user's timezone.
- Zero engagement-bait notifications. No "you have 3 unread", no re-engagement nudges. `[PR]`

---

## 22. AGE POLICY, PRIVACY AND PUBLIC/PRIVATE BOUNDARIES

### 22.1 Age `[PR]`
**Minimum account age: 18.** Rationale: the product includes user-to-user contact, and safe operation of that surface for minors cannot be assured by a zero-budget, solo-operated platform.
Consequences: opportunities open to under-18s (Anzisha 15–22, ALX high-school categories) are **still listed and fully readable logged-out**; they simply cannot be tracked or joined without an adult account. This is stated plainly on such listings. Age is collected at signup and self-asserted; any user found to be under 18 has their account restricted to read-only and all social features removed.

### 22.2 Public by default
Opportunities, organisations, country and category index pages, public projects, public profiles.

### 22.3 Private by default `[PR]`
Eligibility profile, tracker and all its states, notes, saved items, digests, connection requests, threads, intent (outside its own room), analytics.

### 22.4 Never public
Email address, phone, date of birth, precise location, IP, tracker history, rejected requests, moderation reports and reporter identity.

### 22.5 Rights `[PR]`
Self-serve export (JSON) and account deletion, deletion within 30 days with public content anonymised or removed at the user's choice, and a clear statement of what is kept (aggregate counts) and why.

---

## 23. TRUST, MODERATION AND ADMIN

Full specifications in `MODERATION_AND_TRUST.md` and `ADMIN_SYSTEM.md`. Product-level requirements:

- One-tap reporting on every opportunity, project, profile, team and message, with typed reasons. `[PR]`
- Report → queue → admin action, with the reporter notified of the outcome. `[PR]`
- Automatic link scanning on every user-supplied and ingested URL. `[PR]`
- Rate limits on every write path, with escalating restriction rather than instant bans. `[PR]`
- Blocking is absolute and bidirectional in discovery surfaces. `[PR]`
- A full admin audit log of every state-changing admin action. `[PR]`
- The admin system is designed for **≤30 minutes of work per day** at Phase 1 scale; queues must be clearable on a phone. `[PR]`

---

## 24. DENSITY FLOORS — the anti-empty-room mechanism `[PR]`

A named product mechanism, implemented as feature flags with computed conditions:

| Surface | Floor before it is shown | Below the floor |
|---|---|---|
| Intent count on an opportunity | ≥5 intents | Count hidden entirely |
| Team room entry point | ≥3 intents **or** ≥1 team | "Be the first to declare intent" CTA only |
| Teams list in a room | ≥1 open team | Solo-builder list only |
| "Builders also going for this" | ≥5 discoverable builders | Hidden |
| Public project browse | ≥40 public projects platform-wide | Projects remain private tools only |
| Global builder index | ≥250 public profiles **and** ≥1,000 MAU | Not built |
| "Related projects" on an opportunity | ≥3 matching public projects | Hidden |

The product **never** shows an empty or near-empty social surface to any user. `[PR]`

---

## 25. MOBILE AND PERFORMANCE

### 25.1 Byte budgets `[PR]` — hard, enforced in CI
| Route | HTML+CSS+JS transferred, gzipped, first visit | JS executed |
|---|---|---|
| Opportunity detail | ≤ 120 KB | ≤ 30 KB |
| Opportunity list / search | ≤ 150 KB | ≤ 40 KB |
| Homepage | ≤ 120 KB | ≤ 25 KB |
| Country / category index | ≤ 100 KB | ≤ 15 KB |
| Authenticated dashboard | ≤ 200 KB | ≤ 70 KB |
| Any route | never > 250 KB | never > 90 KB |

Images: no hero images anywhere; organisation logos ≤ 12 KB, served at exact display size; no icon fonts; inline SVG only for icons actually used. Fonts: one variable family, subset, woff2, ≤ 60 KB total, `font-display: swap` with a system-font fallback stack that does not shift layout. `[PR]`

### 25.2 Low-data mode `[PR]`
A user-toggled and `Save-Data`-header-respecting mode that suppresses all images including logos, disables prefetch, and serves list views only. Persisted in a cookie so it applies server-side on first paint.

### 25.3 Offline tolerance `[PR]`
PWA, installable. Service worker caches the app shell, the last 50 viewed opportunities, the user's tracker and their saved items. Offline: cached content readable; writes queued and replayed on reconnect with clear pending state. Designed explicitly for load-shedding and cable-outage conditions.

### 25.4 Rendering `[TD]`
Public pages are server-rendered/statically generated with near-zero client JS. Interactivity is added as islands only where a flow requires it.

---

## 26. SEO AND PUBLIC DISCOVERY

Full specification in `SEO.md`. Product-level: opportunity pages, organisation pages, and country × category index pages are the acquisition engine and must be indexable, fast and structured-data-rich. Private surfaces are `noindex`. Public profiles and projects are indexable only at the user's explicit choice, default off. `[PR]`

---

## 27. ANALYTICS

Full specification in `ANALYTICS.md`. Product-level: first-party only, no third-party tracking scripts (byte budget and privacy), and **no vanity metrics shown to users**. `[PR]`

**North-star metric:** *weekly builders who reach an eligible opportunity they did not previously know about.*
**Guardrail metrics:** share of published opportunities that are stale; false-eligibility reports per 1,000 verdicts; median page weight; digest unsubscribe rate; admin queue age.

---

## 28. COUNTRY AND REGION HANDLING `[PR]`

- All 54 African countries plus the rest of the world, ISO 3166-1 alpha-2.
- Regions: Northern, Western, Central, Eastern, Southern Africa; plus `africa_wide`, `global`, `remote_accessible`.
- A country is never a filter checkbox alone — each has a **page** (opportunities, organisations, and later builders and projects) which is a primary SEO and sharing surface.
- Eligibility distinguishes **residency** from **nationality**; the data model must carry both and the UI must not conflate them.
- Never display "Africa" as a single origin or destination in any eligibility context. `[PR]`

---

## 29. COMPLETE USER JOURNEYS

### J1 — Logged-out discovery (Tari, Bulawayo)
Arrives from a Telegram link → opportunity page renders in <120 KB with deadline, summary, eligibility rules and source → sees "Check if you're eligible" → enters country and student status **without creating an account** (stored locally) → gets a verdict with source quotes → taps "Remind me" → chooses Telegram → connects the bot → receives a reminder 5 days before the deadline. **No account was ever required.** `[PR]`

### J2 — Opportunity-first with a team (Kofi, Kumasi)
Search "remote AI hackathon team" → chips render, results filter → eligible item found → track as `planning_to_apply` → declare intent `looking_for_team` → room shows 2 open teams → request to join one with role `backend` → accepted → thread opens → both consent to a Telegram handoff → team marks `submitted` → outcome recorded.

### J3 — Project-first (Chipo, Lusaka)
Creates a private project ("open transport data for Lusaka") → within seconds sees 4 matched open calls she is eligible for → tracks two → sets the project to `looking_for_collaborators` and lists roles → receives a collaboration request → accepts → project moves to `team_forming`.

### J4 — "I don't know what to do"
Opens "What should I do next" → up to 5 deterministic, reasoned items → one is "complete your student status — it will resolve eligibility on 12 opportunities" → completes it → verdicts resolve → tracks one.

### J5 — Organisation (programme officer)
Finds their own listing already ingested and `auto` → clicks "Is this yours?" → claims with a domain-matched email → verified → corrects the deadline → record becomes `official` → future edits touching eligibility re-enter review.

### J6 — Admin (expired opportunity)
Nightly job detects a passed deadline and a 404 on the apply URL → status → `expired`, removed from all active surfaces → users who tracked it get one notification → the organisation page retains it in an archive.

### J7 — Report of a suspicious opportunity
User taps report → `possible_scam` → item is immediately de-ranked and labelled `disputed` pending review → admin reviews within SLA → if confirmed, status → `rejected`, the source's trust score drops, and everyone who tracked it is notified. `[PR]`

### J8 — Returning user
Opens the Telegram bot → `/today` → up to 5 eligible items closing this week, each with a verdict → taps through to one page.

### J9 — Deadline change on a tracked item
Ingestion detects a changed deadline → record updated with a change log entry → everyone tracking it is notified once, with the old and new values and the source.

### J10 — Low-connectivity session
Load-shedding; user opens the installed PWA offline → sees cached tracker and last-viewed opportunities → marks one `applied` → change queues → syncs on reconnect with a confirmation.

---

## 30. SUCCESS CRITERIA FOR THE PRODUCT AS SPECIFIED

The build is correct if, with **one user and no other humans on the platform**, that user can:
1. Find a real, currently-open opportunity relevant to their country. ✅
2. Receive a truthful eligibility verdict with source quotes. ✅
3. Track it and be reminded before it closes, via Telegram, without an email. ✅
4. Read a structured brief instead of downloading a PDF. ✅
5. Do all of it in under 500 KB total transfer. ✅
6. Encounter **no empty social surface** anywhere. ✅

Everything involving other people is additive on top of a product that already works alone. That is the design's central bet.
