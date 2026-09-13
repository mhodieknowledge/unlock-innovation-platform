# API_SPEC.md

**Style:** REST-ish JSON over Next.js route handlers, plus server actions for authenticated mutations originating in the app's own UI. Public read endpoints exist so the Telegram bot, RSS generation and future clients share one contract.

**Base:** `/api/v1`. **Auth:** session cookie, or `Authorization: Bearer <service_token>` for internal batch jobs.
**Content type:** `application/json; charset=utf-8`. All timestamps ISO 8601 UTC.

---

## 1. CONVENTIONS

### 1.1 Envelope
```jsonc
// success
{ "data": { }, "meta": { "cached_at": "...", "next_cursor": "..." } }
// error
{ "error": { "code": "ELIGIBILITY_INPUT_INVALID",
             "message": "country_of_residence must be an ISO 3166-1 alpha-2 code",
             "field": "country_of_residence" } }
```

### 1.2 Error codes
| HTTP | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Body/query failed schema validation |
| 401 | `AUTH_REQUIRED` | No valid session |
| 403 | `FORBIDDEN` | Authenticated but not permitted |
| 403 | `ACCOUNT_RESTRICTED` | Under-18 or moderation restriction |
| 404 | `NOT_FOUND` | Includes unpublished opportunities for non-admins |
| 409 | `CONFLICT` | Duplicate intent, request already exists |
| 410 | `GONE` | Opportunity expired or merged (response includes `merged_into`) |
| 422 | `DENSITY_FLOOR_NOT_MET` | Social surface not available yet |
| 429 | `RATE_LIMITED` | Includes `Retry-After` |
| 451 | `REMOVED_ON_REQUEST` | Source takedown honoured |
| 503 | `DEGRADED` | Dependency unavailable; `meta.degraded_features[]` lists what |

**Rule `[PR]`:** a degraded dependency never returns 5xx to a user-facing read. Search without embeddings returns 200 with `meta.degraded_features: ["semantic_search"]`.

### 1.3 Pagination
Cursor-based. `?limit=20&cursor=<opaque>`. Max `limit` 50. Never offset (deep offsets are expensive on free-tier Postgres).

### 1.4 Caching
| Endpoint class | `Cache-Control` |
|---|---|
| Public opportunity/org/country reads | `public, s-maxage=900, stale-while-revalidate=3600` |
| Public search | `public, s-maxage=300, stale-while-revalidate=600` |
| Eligibility evaluate | `private, no-store` |
| Any authenticated read | `private, no-store` |

---

## 2. PUBLIC READ — OPPORTUNITIES

### `GET /api/v1/opportunities`
Query: `q, country, eligible_for_me, region, category, tag, skill, technology, industry, mode, team, level, student, cost, has_prize, deadline_state, organisation, verification, sort, limit, cursor`.

`deadline_state` ∈ `closing_today | closing_2_days | closing_this_week | closing_this_month | open | opens_soon | rolling`.
`sort` ∈ `urgency` (default) `| relevance | newest | prize`.

```jsonc
{ "data": { "results": [ {
      "id": "…", "slug": "agritech-ai-challenge-2026",
      "title": "AgriTech AI Challenge 2026",
      "organisation": { "slug": "…", "name": "…", "verification": "verified" },
      "summary": "…",
      "category": { "code": "ai_challenge", "name": "AI challenge" },
      "deadline_at": "2026-09-30T21:59:00Z",
      "deadline_precision": "date_only",
      "deadline_raw": "Applications close September 30",
      "deadline_state": "closing_this_month",
      "participation_mode": "online",
      "eligibility_scope": "africa_wide",
      "eligible_countries": ["ZW","ZM","KE"],
      "team": { "required": true, "min": 2, "max": 5 },
      "prize": { "amount": 10000, "currency": "USD" },
      "cost": "free",
      "verification": "verified",
      "last_verified_at": "2026-09-11T06:00:00Z",
      "intent_count": 14            // omitted entirely below the density floor
  } ], "total_estimate": 137 },
  "meta": { "applied_filters": { }, "degraded_features": [] } }
```

### `GET /api/v1/opportunities/{slug}`
Adds `description_md`, `eligibility_rules[]` (with `source_quote`), `official_url`, `apply_url`, `source` attribution, `brief` (if decoded), `changes[]` (last 5), `related[]`.
Returns `410 GONE` with `merged_into` for merged records — never a silent redirect, so shared links stay honest.

### `GET /api/v1/opportunities/{slug}/brief`
Brief Decoder output. `404` if not yet generated. `POST` to the same path (authenticated, rate-limited 3/day/user) triggers generation; returns `202` with a poll URL.

### `GET /api/v1/countries/{iso2}` · `GET /api/v1/categories/{slug}` · `GET /api/v1/organisations/{slug}`
Index payloads: entity detail, counts by category/deadline state, and the first page of opportunities.

### `GET /api/v1/feeds/{scope}.xml`
RSS 2.0 for `country/{iso2}`, `category/{slug}`, `organisation/{slug}`, `closing-soon`. Free distribution channel, zero JS, cache 1 h. `[PR]`

---

## 3. ELIGIBILITY

### `POST /api/v1/eligibility/evaluate`
Works **logged out**. Inputs are never persisted for anonymous callers. `[PR]`

```jsonc
// request
{ "opportunity_ids": ["…"],                 // max 25
  "profile": { "country_of_residence": "ZW", "nationalities": ["ZW"],
               "birth_year": 2004, "student_status": "undergraduate",
               "year_of_study": 2, "years_experience": 1,
               "remote_only": true } }      // any subset; omitted fields → unknown

// response
{ "data": { "verdicts": [ {
    "opportunity_id": "…",
    "verdict": "likely_eligible",
    "confidence": 0.78,
    "rules": [
      { "type": "country_in", "outcome": "pass", "confidence": 0.94,
        "source_quote": "Open to applicants resident in any African country.",
        "explanation": "Zimbabwe is included." },
      { "type": "student_status_in", "outcome": "pass", "confidence": 0.71,
        "source_quote": "Open to students and young developers across Africa.",
        "explanation": "Undergraduate students qualify." },
      { "type": "age_between", "outcome": "unknown",
        "source_quote": "Applicants must be under 26.",
        "explanation": "Add your birth year to resolve this.",
        "resolves_with": ["birth_year"] }
    ],
    "missing_fields": ["birth_year"],
    "disclaimer": "Always confirm on the official page — rules change."
  } ] } }
```

Rate limit: 60/min per IP anonymous (Turnstile above that), 300/min authenticated.
**Invariant `[PR]`:** every `pass`/`fail` rule carries a non-empty `source_quote`. A response failing that invariant is a bug, not a degraded mode.

### `POST /api/v1/eligibility/flag`
Report an incorrect verdict. `{ opportunity_id, rule_id?, reason, detail? }` → creates a `reports` row with reason `wrong_eligibility`.

---

## 4. SEARCH

### `GET /api/v1/search?q=…&types=opportunity,organisation,project`
Hybrid search across permitted entity types. Respects visibility and density floors.

### `POST /api/v1/search/compile`
The NL query compiler. Returns **filters, never results**. `[PR]`
```jsonc
// request  { "q": "Remote AI hackathons open to people in Zimbabwe" }
// response
{ "data": { "filters": { "category": ["hackathon"], "tag": ["ai"],
                         "mode": "online", "country": "ZW",
                         "deadline_state": "open" },
            "chips": [ { "label": "Hackathons", "key": "category", "value": "hackathon" },
                       { "label": "AI", "key": "tag", "value": "ai" },
                       { "label": "Remote", "key": "mode", "value": "online" },
                       { "label": "Open to Zimbabwe", "key": "country", "value": "ZW" } ],
            "unmapped_terms": [],
            "source": "llm" } }          // "llm" | "cache" | "heuristic"
```
When the LLM chain is exhausted, `source: "heuristic"` returns whatever a keyword/dictionary matcher can extract, plus `meta.degraded_features: ["nl_compile"]`. Never an error. `[PR]`

---

## 5. TRACKER (authenticated)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/v1/tracker` | Filter by `state`, sorted by deadline |
| `PUT` | `/api/v1/tracker/{opportunityId}` | `{ state, note?, applied_at?, remind_at? }`; upsert |
| `DELETE` | `/api/v1/tracker/{opportunityId}` | |
| `GET` | `/api/v1/tracker/export?format=json\|csv` | Full personal export `[PR]` |

Invalid transitions (e.g. `saved → outcome_won`) return `409` with `allowed_transitions`.

---

## 6. RECOMMENDATIONS (authenticated)

### `GET /api/v1/me/window`
The bounded "Your window" surface. Max 8, precomputed.
```jsonc
{ "data": { "items": [ { "opportunity": { }, "verdict": "eligible",
    "reasons": ["Zimbabwe eligible","Remote","Python and ML match your profile"],
    "closes_in_days": 5 } ],
    "computed_at": "2026-09-12T02:14:00Z" },
  "meta": { "fallback": false } }   // true when cold-start country ranking was used
```

### `GET /api/v1/me/next-actions`
Max 5 deterministic actions. Each: `{ kind, reason, cta_label, href, priority }`.

---

## 7. INTENT AND TEAMS (authenticated)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/opportunities/{slug}/intent` | `{ stance, roles_offered?, note? }`; 409 if exists; `expires_at` set server-side |
| `DELETE` | `/api/v1/opportunities/{slug}/intent` | Withdraw |
| `GET` | `/api/v1/opportunities/{slug}/room` | `422 DENSITY_FLOOR_NOT_MET` with `{ current, required }` when below floor `[PR]` |
| `POST` | `/api/v1/opportunities/{slug}/teams` | `{ name, pitch, roles_needed, max_size }`; `max_size` validated against the opportunity's own rule |
| `GET` | `/api/v1/teams/{id}` | Members hidden from non-members except count and roles needed |
| `PATCH` | `/api/v1/teams/{id}` | Owner only |
| `POST` | `/api/v1/teams/{id}/requests` | `{ role_id, message }`; rate-limited |
| `POST` | `/api/v1/teams/{id}/requests/{reqId}/decide` | `{ decision: "accept"\|"decline" }`; accept opens a thread |
| `DELETE` | `/api/v1/teams/{id}/members/{userId}` | Owner removes, or self-leave |

**Contact rule `[PR]`:** no endpoint ever returns another user's email, phone or Telegram handle. Handoff happens via `POST /api/v1/threads/{id}/handoff` with `{ channel }` and requires both participants to have consented; only then is a channel identifier exchanged.

---

## 8. PROJECTS (authenticated)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/projects` | Returns the project **and** triggers a synchronous first-pass match |
| `GET` | `/api/v1/projects/{slug}` | Visibility enforced |
| `PATCH` | `/api/v1/projects/{slug}` | Owner/member |
| `GET` | `/api/v1/projects/{slug}/matches` | Precomputed matched open calls with reasons |
| `POST` | `/api/v1/projects/{slug}/interest` | `{ role_id, message }` → connection request |
| `POST` | `/api/v1/projects/{slug}/submissions` | Link a project to an opportunity entry |

---

## 9. CONNECTIONS AND THREADS (authenticated)

`GET/POST /api/v1/connections` · `POST /api/v1/connections/{id}/decide` · `GET /api/v1/threads` · `GET/POST /api/v1/threads/{id}/messages` · `POST /api/v1/threads/{id}/handoff` · `POST /api/v1/blocks` · `DELETE /api/v1/blocks/{userId}`.

Messages are polled (`If-Modified-Since`), not streamed. No realtime in Phase 1.

---

## 10. NOTIFICATIONS AND CHANNELS (authenticated)

`GET /api/v1/notifications` · `POST /api/v1/notifications/read` · `GET/PUT /api/v1/notifications/preferences` · `POST /api/v1/channels/telegram/link` (returns a one-time deep-link code) · `DELETE /api/v1/channels/{channel}` · `GET /api/v1/unsubscribe/{token}` (works **without** a session, one-tap, per-type) `[PR]`.

---

## 11. ORGANISATION SELF-SERVE

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/organisations/{slug}/claim` | `{ claim_email, evidence_url? }`; domain match computed server-side |
| `POST` | `/api/v1/organisations/claims/{id}/confirm` | Email token |
| `POST` | `/api/v1/organisations/{slug}/opportunities` | Publishes as `official`; edits touching eligibility, dates or cost re-enter review `[PR]` |
| `POST` | `/api/v1/submit` | Public submission by anyone; Turnstile required; lands in the review queue as `draft` |

---

## 12. ADMIN (`/api/v1/admin/*`, role-gated)

Queues (`GET /queues/{queue}`, `POST /queues/{id}/claim`), opportunity review (`POST /opportunities/{id}/publish|reject|merge`), rule editing (`PATCH /eligibility-rules/{id}` — editing a rule **requires** supplying a `source_quote`), sources CRUD and `POST /sources/{id}/run`, org verification, user actions (`restrict|suspend|reinstate`), reports resolution, `GET /health` (source health, quota consumption, queue depth, DB size), `GET /audit`.

Every admin mutation writes `admin_audit_log` with before/after. `[PR]`

---

## 13. TELEGRAM BOT (`POST /api/v1/telegram/webhook`)

Secret-token verified. Commands: `/start`, `/link <code>`, `/today`, `/closing`, `/country <iso2>`, `/search <q>`, `/save <id>`, `/me`, `/pause`, `/stop`, `/help`.

Bot responses are plain text with at most 3 inline buttons, no images, no media. It is a first-class read client, not a notification pipe. `[PR]`

---

## 14. INTERNAL (service token only)

`POST /api/v1/internal/ingest/callback` · `POST /api/v1/internal/cache/purge` · `POST /api/v1/internal/notifications/dispatch` · `GET /api/v1/internal/budget`. Not routable from the public edge (Worker-level origin check plus token).

---

## 15. RATE LIMITS

| Action | Anonymous | Authenticated |
|---|---|---|
| Read (any GET) | 120/min/IP | 300/min |
| `eligibility/evaluate` | 60/min/IP | 300/min |
| `search/compile` | 10/min/IP | 30/min |
| Report | 5/day/IP + Turnstile | 20/day |
| Public submit | 3/day/IP + Turnstile | 10/day |
| Team/connection request | — | **10/day, 3/hour** |
| Team creation | — | 5/day |
| Message | — | 60/day/thread, 200/day total |
| Brief generation | — | 3/day |

Exceeding returns `429` with `Retry-After` and a human-readable message. Repeated abuse escalates to `account_state='restricted'` rather than a hard ban. `[PR]`

---

## 16. VERSIONING AND STABILITY

`/api/v1` is stable once Phase 3 ships. Additive changes only; removals require `/v2`. The Telegram bot and RSS feeds are consumers of this contract and must not be broken by UI changes.
