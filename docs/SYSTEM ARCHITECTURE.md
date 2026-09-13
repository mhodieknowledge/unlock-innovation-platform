# SYSTEM_ARCHITECTURE.md

Authoritative on **how** the product is built. Product behaviour is governed by `PRODUCT_SPEC.md`.

---

## 1. ARCHITECTURAL PRINCIPLES

1. **Static-first.** Every public page is pre-rendered or cached HTML. Personalisation is layered on top of a cacheable shell, never baked into it.
2. **Batch over request.** Anything expensive (embeddings, extraction, recommendations, verification, digests) runs in scheduled jobs on free CI compute, never in a user request.
3. **Deterministic core, AI at the boundary.** AI touches data on the way in. It never sits between a user and an answer.
4. **Every external dependency is behind an interface** with at least one fallback and one degraded mode. Free tiers disappear without notice.
5. **Byte budget is a build-time constraint**, enforced in CI, not a guideline.
6. **The system must remain truthful when unmaintained.** Absence of ingestion produces visible staleness, never silent lies.

---

## 2. TOPOLOGY

```
 ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 │   Browser    │   │ Telegram Bot │   │  RSS reader  │
 │  (PWA, SW)   │   │   clients    │   │              │
 └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
        │                  │                  │
        ▼                  ▼                  ▼
 ┌───────────────────────────────────────────────────────┐
 │  Cloudflare edge — Pages (static) + Workers (dynamic)  │
 │  cache, WAF, Turnstile, rate limiting, image passthru  │
 └───────────────┬───────────────────────────┬───────────┘
                 │                           │
                 ▼                           ▼
      ┌────────────────────┐        ┌──────────────────┐
      │ Next.js app        │        │ Worker endpoints │
      │ (OpenNext on CF)   │        │ /api/telegram    │
      │ RSC, server actions│        │ /api/cron/*      │
      └─────────┬──────────┘        └────────┬─────────┘
                │                            │
                ▼                            ▼
      ┌──────────────────────────────────────────────────┐
      │ Supabase — Postgres + pgvector + Auth + RLS      │
      │ Storage: Cloudflare R2 (logos, archived docs)    │
      │ KV: Cloudflare KV (hot cache, rate counters)     │
      └──────────────────────────────────────────────────┘
                             ▲
                             │  writes
      ┌──────────────────────┴───────────────────────────┐
      │ GitHub Actions — the batch tier (free, public repo)│
      │ ingest · extract · embed · dedupe · verify ·       │
      │ recommend · digest · rollup · backup               │
      └───────────────────────────────────────────────────┘
                             │
                             ▼
      ┌───────────────────────────────────────────────────┐
      │ LLM providers behind one interface:                │
      │ Groq → Gemini → Cerebras → Workers AI → NO_AI      │
      └───────────────────────────────────────────────────┘
```

---

## 3. FRONTEND

### 3.1 Framework `[TD]`
**Next.js 15 App Router**, deployed to **Cloudflare Workers via OpenNext**.

**Alternatives considered and rejected:**
| Option | Why not |
|---|---|
| Next.js on Vercel Hobby | Hobby forbids commercial use; donations are permitted but any revenue breaches it. Thin African edge presence. |
| Astro + Svelte islands | Genuinely lower JS and better for the byte budget. Rejected because a single framework is materially easier for a coding agent to build and maintain consistently, and RSC gets us most of the way. **Revisit if byte budgets fail in testing.** |
| SvelteKit | Smallest bundles, but much smaller agent/ecosystem familiarity — higher implementation risk. |
| SPA + separate API | Worst possible choice for byte budget and SEO. |

### 3.2 Rendering strategy
| Route class | Strategy | Revalidate |
|---|---|---|
| `/opportunities/[slug]` | SSG + ISR | 15 min, plus on-write purge |
| `/opportunities` (filtered) | Server-rendered, edge-cached by query key | 5 min |
| `/countries/[slug]`, `/categories/[slug]` | SSG + ISR | 1 h |
| `/organisations/[slug]` | SSG + ISR | 6 h |
| `/` | SSG + ISR | 5 min |
| `/dashboard`, `/tracker`, `/settings` | Server-rendered, `private, no-store` | — |
| `/rooms/[oppSlug]` | Server-rendered, short private cache | 60 s |

**Personalisation on cached pages `[TD]`:** the eligibility verdict block on a cached opportunity page is rendered by a small client island that calls `POST /api/eligibility/evaluate`. The page HTML stays identical for every viewer and remains fully cacheable. Logged-out users get the same island, backed by localStorage inputs.

### 3.3 Client budget
- One variable font family, subset to Latin + Latin Extended-A (covers French, Portuguese, and most African Latin orthographies), woff2, ≤ 60 KB.
- No component library at runtime. Tailwind, purged. No CSS-in-JS.
- Islands only: eligibility checker, filter panel, search box, tracker buttons, request forms, notification bell. Everything else is server HTML.
- No third-party scripts of any kind on public pages — including analytics.
- Icons: inline SVG sprite, only icons actually used, ≤ 4 KB.

### 3.4 PWA and offline `[PR]`
Service worker with:
- **App shell:** cache-first, versioned.
- **Opportunity pages:** stale-while-revalidate, LRU 50.
- **User data (tracker, saved):** network-first with cache fallback.
- **Writes offline:** queued in IndexedDB with a visible "pending sync" state, replayed on reconnect with conflict resolution by server timestamp.
- **Low-data mode:** cookie `ld=1`, also set automatically when `Save-Data: on` is present, read server-side so the first paint is already light. Suppresses all images, disables prefetch, forces list density.

### 3.5 Byte budget enforcement `[TD]`
CI step runs a headless build-size check per route against the table in `PRODUCT_SPEC.md` §25.1. **Exceeding the budget fails the build.** No exceptions without an explicit override flag recorded in the PR.

---

## 4. BACKEND

### 4.1 Shape
No separate backend service. Three execution contexts:
1. **Request tier** — Next.js server components, route handlers and server actions running on Cloudflare Workers. Constrained to 10 ms CPU per request, so no heavy computation here.
2. **Edge tier** — standalone Workers for the Telegram webhook, cron triggers, link health pings and rate limiting.
3. **Batch tier** — GitHub Actions. All expensive work. No CPU limit, unlimited minutes on a public repo.

### 4.2 What must never run in the request tier `[TD]`
Embedding generation, LLM calls other than the cached query compiler, ingestion, dedupe, bulk recommendation computation, digest assembly, image processing. These are all batch-tier.

### 4.3 Job inventory (GitHub Actions)

| Job | Schedule | Purpose |
|---|---|---|
| `ingest-feeds` | every 3 h | Fetch all due sources, write `raw_documents` |
| `extract` | every 3 h (after ingest) | LLM extraction → `extraction_runs` → candidate opportunities |
| `dedupe` | every 3 h | Candidate pairing and merge proposals |
| `embed` | nightly | Embeddings for new opportunities, projects, profiles (local `sentence-transformers`, free, unlimited) |
| `verify-links` | every 6 h | HEAD/GET on `apply_url`/`official_url`, set `link_ok` |
| `reverify` | nightly | Re-fetch records past `next_verify_at`; diff; write `opportunity_changes` |
| `expire` | hourly | Deadline passage → `expired`; notify trackers |
| `recommend` | nightly | Per-user and per-project match precomputation |
| `digest` | daily 05:00 per timezone bucket | Assemble and enqueue digests within budget |
| `rollup` | nightly | Events → `event_rollups_daily`, prune raw events |
| `archive` | weekly | `raw_documents.text_raw` older than 90 days → R2 |
| `keepalive` | every 6 h | Trivial query to prevent Supabase 7-day pause |
| `backup` | nightly | `pg_dump` → R2, 14-day retention, restore tested monthly |
| `budget-report` | daily | Quota consumption across all providers → admin alert |

**Secrets** live in GitHub Actions secrets. The repo is public for free minutes, so **no secret may ever be committed**, and the ingestion code must be safe to read publicly.

---

## 5. DATA TIER

**Primary:** Supabase Postgres (free) with `pgvector`. RLS enabled on every table (see `DATA_MODEL.md` §15).
**Fallback documented:** Neon (scale-to-zero, 0.5 GB). Access goes through a thin repository layer so the swap is a config change plus a migration, not a rewrite. `[TD]`

**Caching layers, in order:**
1. Cloudflare edge cache (HTML, JSON for anonymous requests).
2. Cloudflare KV — hot lookups: country/category counts, density-floor booleans, compiled NL queries, rate-limit counters. TTL 5–60 min.
3. Postgres materialised views for expensive aggregates, refreshed nightly.
4. In-request memoisation.

**Keep-alive `[TD]`:** Supabase free projects pause after 7 days idle. The `keepalive` job prevents it. Alerting fires if it fails twice.

---

## 6. SEARCH

### 6.1 Hybrid retrieval `[TD]`
```
candidates = FTS(query)  ∪  ANN(embedding(query))
score      = RRF(rank_fts, rank_vec, k=60)
final      = score × eligibility_boost × urgency_boost × freshness_penalty × diversity
```

- **FTS:** `tsvector` over `setweight(title,'A') || setweight(org,'B') || setweight(summary,'C') || setweight(tags,'D')`, `unaccent`-normalised, GIN index.
- **ANN:** `halfvec(384)` with HNSW, cosine. Query embedding from Workers AI (`bge-small-en-v1.5`) with a KV cache keyed by normalised query string.
- **eligibility_boost:** `eligible` 1.35, `likely_eligible` 1.15, `unclear` 1.0, `not_eligible` 0.25 (down-ranked, never hidden — the user may be checking for someone else).
- **urgency_boost:** peaks at 7 days out, decays to 0 after the deadline.
- **freshness_penalty:** ×0.8 when `verification='stale'`, ×0.5 when `disputed`.
- **diversity:** max 2 per organisation, 3 per category in the first 20 results.

All weights live in a single `ranking.ts` constants file with a comment explaining each. `[TD]`

### 6.2 Degraded mode
If the embedding provider is unavailable: FTS-only with a quiet indicator in the admin dashboard. Users see no error. `[PR]`

### 6.3 Why not Typesense/Meilisearch/Algolia `[TD]`
Typesense Cloud and Meilisearch Cloud have **no permanent free tier** (trials only). Algolia's free tier is limited and its record-count terms are inconsistent across sources. Self-hosting either needs a host we do not have at $0. Postgres FTS + pgvector is already paid for by the database we need anyway, and is sufficient at this corpus size (<50K records).

---

## 7. ELIGIBILITY ENGINE `[TD]`

A **pure function**, implemented once in TypeScript and mirrored as a Postgres function for batch use.

```ts
evaluate(rules: EligibilityRule[], profile: EligibilityInput): Verdict
```

Properties:
- **No I/O, no LLM, no network.** Fully unit-testable.
- Deterministic and total — every input produces a verdict.
- Returns `{ verdict, ruleResults[], missingFields[], confidence }` where each `ruleResult` carries the rule, the outcome and the `source_quote`.
- Aggregation logic exactly as `PRODUCT_SPEC.md` §12.3.
- **Bias rule:** ambiguity resolves to `unclear`, never to `eligible`. Encoded as a test suite invariant.

**Test corpus requirement `[PR]`:** at least 60 hand-labelled real opportunities covering every rule type and each of the six Tier-1 countries, as a regression suite. Eligibility changes cannot merge without it passing.

**Batch use:** the nightly `recommend` job calls the Postgres mirror to compute verdicts for every (active user × open opportunity) pair that passes a cheap pre-filter (country array overlap), storing only the positives.

---

## 8. RECOMMENDATION ENGINE `[TD]`

Nightly, per active user (seen in the last 30 days):

```
1. Pre-filter: published, deadline within 60 days,
   eligible_countries && [user country] OR scope in (africa_wide, global)
2. Eligibility gate: verdict in (eligible, likely_eligible)
3. Similarity: cosine(user.embedding, opportunity.embedding)
4. Score = 0.45·similarity + 0.35·urgency + 0.20·quality
     quality = verification weight × source trust × completeness
5. Diversity cap, then top 20 stored
6. Reasons: templated from matched rules + overlapping tag names
```

Stored in a `user_recommendations` table (same shape as `project_opportunity_matches`). Read is a single indexed query. **Zero compute at request time.**

Cold-start user (no embedding yet): fall back to country + category + urgency ranking. Never show an empty recommendation surface — show the country's closing-soon list with an honest label instead. `[PR]`

---

## 9. AI TIER

Full detail in `AI_SYSTEM.md`. Architectural facts:

**Provider abstraction `[TD]`:**
```ts
interface LLMProvider {
  id: string; complete(req: LLMRequest): Promise<LLMResponse>;
  limits: { rpm: number; rpd: number; tpm: number };
}
```
Ordered chain with per-provider circuit breakers and a shared token-bucket accountant persisted in KV. On exhaustion of all providers the caller receives `NO_AI`, and **every caller must handle `NO_AI`** — enforced by the type system (the return type is a discriminated union, not a nullable string). `[TD]`

**Never hard-code a model name in application code.** Models are configuration rows, hot-swappable without deploy — free catalogues change without notice. `[PR]`

**Embeddings `[TD]`:** generated in the batch tier using local `sentence-transformers` (`bge-small-en-v1.5`, 384-dim) inside GitHub Actions — free, unlimited, no quota. Only *query* embeddings use Workers AI at request time, and those are KV-cached. This is the single most important cost decision in the system: it removes embedding generation from the quota budget entirely.

**No personal data to training-tier providers `[PR]`:** Gemini's free tier and Mistral's experiment tier use inputs for improvement. Routing rule: extraction and brief decoding (public web content) may use any provider; anything containing user profile text may use **only** Workers AI or a provider with a no-training guarantee — and in practice, no user data is sent to any LLM at all, because matching is embedding-and-rules based.

---

## 10. INGESTION

Full detail in `OPPORTUNITY_INGESTION.md`. Architectural summary: a nine-stage pipeline (`discover → fetch → normalise → extract → structure → dedupe → score → review → publish`) plus a continuous `monitor → reverify → expire` loop, all in the batch tier, with `sources` as managed entities carrying robots/ToS posture and health.

---

## 11. AUTHENTICATION AND AUTHORISATION

### 11.1 Auth `[TD]`
**Supabase Auth.** Order of preference, deliberately: **GitHub OAuth → Google OAuth → email OTP**.

Rationale: email OTP consumes the same ~300/day Brevo budget as digests. OAuth-first protects the notification budget, which is the retention mechanism. Email OTP remains available because not every user has GitHub or Google.

Sessions: HTTP-only, `Secure`, `SameSite=Lax` cookies; 30-day sliding refresh; server-side session validation on every authenticated request.

### 11.2 Roles
`anonymous` · `user` · `org_editor` / `org_owner` (scoped to an organisation) · `reviewer` (queues, publish/reject) · `moderator` (reviewer + user actions) · `superadmin`.

Authorisation is enforced **twice**: in RLS at the database, and in a server-side policy module. RLS is the backstop, not the only check. `[TD]`

### 11.3 Age gate `[PR]`
Signup requires an explicit 18+ confirmation. Under-18 self-identification, or credible report, sets `account_state='restricted'`: read-only, no intents, no teams, no requests, no messages, no public profile.

---

## 12. NOTIFICATIONS ARCHITECTURE

Full detail in `NOTIFICATIONS.md`. Architecturally:

- `notifications` rows are created by any tier. Delivery is a **separate, budgeted queue**.
- A dispatcher job runs every 15 min: selects `queued` deliveries ordered by `priority, scheduled_for`, checks `send_budget` for the channel and day, sends or defers.
- **Telegram is the primary push channel.** Bot API is free and unmetered; a single Worker handles webhooks. This decision is what makes retention viable at $0.
- Email is capped at ~280/day (300 minus headroom for auth OTP). Priority 1–2 (request received, deadline ≤48 h) always send; priority 4–5 (digest) send only within the remaining budget and otherwise defer or downgrade to in-app.
- Per-user caps enforced before enqueue, not at send.

---

## 13. COLLABORATION ARCHITECTURE

Full detail in `COLLABORATION_SYSTEM.md` and `TEAM_FORMATION.md`. Architecturally: intents are cheap rows scoped to an opportunity and auto-expiring; teams and requests are simple state machines; threads open only on mutual accept and are deliberately minimal (no realtime, no typing indicators, no read receipts — all of which cost bytes and moderation surface). Polling on thread open is sufficient at this scale; Supabase Realtime is available but **not used in Phase 1** to protect the byte budget. `[TD]`

---

## 14. MEDIA HANDLING `[TD]`

- Uploads: organisation logos and optional avatars only. No user-uploaded images anywhere else.
- **Client-side resize before upload** (canvas → webp) to exactly three sizes: 32, 64, 128 px. Server validates dimensions, type and size (≤ 30 KB).
- Stored in **Cloudflare R2**, served through the CDN with immutable cache headers and content-hashed keys.
- **No server-side image transformation** — avoids Cloudinary/ImageKit quotas entirely.
- Suppressed completely in low-data mode; replaced by a two-letter monogram rendered in CSS.

---

## 15. SECURITY, RATE LIMITING, ABUSE

Full detail in `SECURITY.md` and `MODERATION_AND_TRUST.md`. Architecturally:
- Cloudflare WAF + Turnstile on every unauthenticated write (report, eligibility check burst, org claim, signup).
- Rate limiting at two layers: Cloudflare (IP/ASN, coarse) and Postgres `rate_limit_counters` (per user/action, exact).
- All outbound user-supplied and ingested URLs pass a link check (scheme allowlist, resolved-host check, Google Safe Browsing lookup) before display; failures render the link as plain text with a warning.
- CSP with no `unsafe-inline`, nonce-based; `Strict-Transport-Security`; `Referrer-Policy: strict-origin-when-cross-origin`; `Permissions-Policy` denying geolocation, camera, microphone.

---

## 16. LOGGING, MONITORING, ALERTING `[TD]`

| Concern | Tool | Notes |
|---|---|---|
| Errors | Sentry free, 10% trace sampling, PII scrubbing on | Alert on new issue types only |
| Request logs | Cloudflare Workers Logs / Logpush to R2 | Short retention |
| Job outcomes | `source_fetches`, `ai_usage`, job summary rows → admin dashboard | The primary operational view |
| Uptime | UptimeRobot free, 5-min checks on `/` and `/api/health` | |
| Quota | `budget-report` job → Telegram message to the admin | The single most important alert |

**Alert conditions that page the operator:** ingestion failing on ≥3 sources for ≥12 h; email budget exhausted before 18:00 two days running; extraction success rate below 70%; any `possible_scam` report open for >12 h; database above 450 MB.

---

## 17. SEO INFRASTRUCTURE

Full detail in `SEO.md`. Architecturally: static generation of all public pages, JSON-LD injected server-side, segmented sitemaps regenerated nightly, canonical URLs on every page, `noindex` on all authenticated routes and on profiles/projects that have not opted in.

---

## 18. EXTERNAL INTEGRATIONS

| Integration | Purpose | Auth | Failure mode |
|---|---|---|---|
| Telegram Bot API | Primary push + a read-only client | Bot token | Queue and retry; in-app unaffected |
| GitHub API | `good first issue` ingestion, OAuth | App token / OAuth | Source marked failing |
| Kaggle API | Competition ingestion | API key | Source marked failing |
| Eventbrite API | Event ingestion | OAuth token | Source marked failing |
| Google Safe Browsing | Link scanning | API key | Fail closed — links render unlinked |
| Brevo | Transactional email | API key | Deliveries defer; in-app persists |
| Cloudflare R2 / KV | Storage, cache | Bindings | Cache miss → DB; upload disabled |

Each has a `sources`/config row, a health signal and an explicit degraded behaviour. `[PR]`

---

## 19. ENVIRONMENTS AND DELIVERY

- `local` (Supabase CLI + Docker), `preview` (per-PR Cloudflare preview + branch database), `production`.
- Migrations are versioned SQL, forward-only, applied in CI before deploy.
- Feature flags (`feature_flags` table) gate every density-dependent surface, so Phase-2+ features can ship dark.
- Rollback: Cloudflare deployment rollback + a tested `pg_restore` path from the nightly R2 backup.

---

## 20. DECISION LOG (summary)

| # | Decision | Chosen | Main alternative | Why |
|---|---|---|---|---|
| 1 | Host | Cloudflare Pages + Workers | Vercel Hobby | Hobby forbids commercial use; CF has better African edge presence |
| 2 | Framework | Next.js on OpenNext | Astro islands | Agent buildability; revisit if byte budgets fail |
| 3 | Database | Supabase Postgres | Neon | Auth + Storage + pgvector + RLS in one free tier |
| 4 | Search | Postgres FTS + pgvector | Typesense/Meilisearch/Algolia | No permanent free tier on the alternatives |
| 5 | Vector dims | 384 (`halfvec`) | 768 / 1536 | Storage: 1M×1536 ≈ 6 GB vs 384 ≈ 1.5 GB raw |
| 6 | Embedding generation | Local model in GitHub Actions | Hosted embedding API | Free and unlimited; removes the largest quota consumer |
| 7 | Primary push channel | Telegram | Email / WhatsApp | Free and unmetered; WhatsApp Business API is not free; email is capped at ~300/day |
| 8 | Batch compute | GitHub Actions (public repo) | Worker cron only | Unlimited minutes, no CPU ceiling |
| 9 | Eligibility | Deterministic rules engine | Per-query LLM | Free, fast, testable, auditable, quotable |
| 10 | Images | Client-side resize → R2 | Cloudinary/ImageKit | Zero quota, zero transformation cost |
| 11 | Analytics | First-party events in Postgres | PostHog/GA | No third-party JS on public pages (byte budget + privacy) |
| 12 | Realtime | None in Phase 1 (polling) | Supabase Realtime | Byte budget; no user need at this scale |
| 13 | Maps | Static country index, no tiles | Mapbox/Leaflet | Data cost; a map answers no question a list does not |
