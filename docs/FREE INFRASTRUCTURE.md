# FREE_INFRASTRUCTURE.md

**Research current as of 12 September 2026.** Free tiers change frequently and several changed materially in the last 24 months. **Every figure here must be re-verified against the official pricing page before implementation.** Items marked `[UNVERIFIED]` were not confirmed at a primary source during research and must be checked first.

---

## 1. THE CONSTRAINT, RESTATED

$0/month is not a cost target. It is a **product constraint** that determines how many humans can be reached.

At $0 the binding limits are:
- **~300 emails/day** — shared between auth and digests. This caps the retention mechanism, not the server bill.
- **100,000 edge requests/day** — forces static-first rendering.
- **500 MB database** — forces archiving `raw_documents` to object storage.
- **Review labour**, which no free tier supplies.

Every architectural decision in `SYSTEM_ARCHITECTURE.md` traces back to one of these four.

---

## 2. THE SELECTED STACK

| Layer | Service | Free limit | Card? | At quota | Fallback |
|---|---|---|---|---|---|
| Static host | **Cloudflare Pages** | 500 builds/mo, unlimited static requests, 20k files | No | Static unmetered | Netlify, GitHub Pages |
| Dynamic | **Cloudflare Workers** | 100k req/day, 10ms CPU, 128MB | No | Hard stop, resets 00:00 UTC | Workers Paid $5/mo |
| Database | **Supabase** | 500MB Postgres, 1GB files, 5GB egress, 50k MAU auth | No | HTTP 402 on egress; **pauses after 7 days idle** | Neon |
| Auth | **Supabase Auth** | ~50k MAU, bundled | No | — | Better Auth self-hosted |
| Vector | **pgvector** (in Supabase) | Bounded by 500MB | No | — | Qdrant free cluster |
| Search | **Postgres FTS** | Bounded by DB | No | — | — |
| Object store | **Cloudflare R2** | 10GB, 1M Class A, 10M Class B, **egress always free** | No | Cheap overage ($0.015/GB-mo) | Backblaze B2 (card required) |
| Cache/KV | **Cloudflare KV** | 100k reads/day, 1k writes/day, 1GB | No | Hard stop | In-memory + Postgres |
| LLM | **Groq** | 14,400 rpd, 6k tpm, 30 rpm (8B) | No | 429 | Gemini → Cerebras → Workers AI |
| LLM (long) | **Gemini Flash** | ~1,500 rpd, 250k tpm, 1M context | No | 429 | Groq |
| LLM (edge) | **Workers AI** | 10,000 neurons/day | No | Error | Groq |
| Embeddings | **Local `bge-small` in CI** | **Unlimited** | No | — | Workers AI |
| Email | **Brevo** | 300/day (~9,000/mo), 100k contacts | No | Sending pauses | Resend (3,000/mo, 100/day) |
| Push | **Telegram Bot API** | **Unmetered** | No | — | Email, in-app |
| Cron/batch | **GitHub Actions** | **Unlimited on public repos** | No | — | Cloudflare Cron (5 triggers) |
| Bot protection | **Cloudflare Turnstile** | Effectively unlimited, 20 widgets | No | — | hCaptcha |
| Link safety | **Google Safe Browsing** | Free with quota | No | Fail closed | Domain denylist |
| Errors | **Sentry** | ~5k errors/mo, 1 project | No | Dropped | Self-hosted GlitchTip |
| Uptime | **UptimeRobot** | 50 monitors, 5-min | No | — | Cron ping |
| Analytics | **First-party in Postgres** + Cloudflare Web Analytics | — | No | — | — |
| CDN/DNS/WAF | **Cloudflare free** | — | No | — | — |

**Total recurring cost: $0.** One optional cost appears at scale: Cloudflare Workers Paid at $5/month when daily requests exceed 100,000.

---

## 3. SERVICE-BY-SERVICE EVALUATION

Against the nine questions in the brief.

### 3.1 Hosting — Cloudflare Pages + Workers
Genuinely free · no card · hard-stops rather than billing · **no risk of surprise charges** on the free plan · open-source alternative exists (self-hosting, but needs a host) · suitable for production.

**Why not Vercel `[PR]`:** the Hobby plan is restricted to non-commercial personal use — *"any Deployment that is used for the purpose of financial gain of anyone involved in any part of the production of the project, including a paid employee or consultant writing the code."* Donations are explicitly permitted. Enforcement is by disabling projects. Building a product that may one day earn revenue on Hobby is a licensing failure waiting to happen. Cloudflare also has materially better African edge presence.

**Rejected:** Railway (removed its free tier), Render (free services sleep), Fly.io (moved to pay-as-you-go with small credits). None is reliably $0 for always-on service in 2026. `[UNVERIFIED — re-confirm current terms]`

### 3.2 Database — Supabase
Genuinely free · no card · commercial use permitted · 402 on egress rather than billing · Postgres is open source and self-hostable.

**Two operational hazards, both mitigated `[PR]`:**
1. **Free projects pause after 7 days of inactivity.** The `keepalive` GitHub Action runs every 6 hours; failure twice in a row is an urgent Telegram alert.
2. **No backups on the free plan.** A nightly `pg_dump` to R2 with 14-day retention, and a **restore tested monthly**. An untested backup is not a backup.

**Storage headroom** is the real limit (see `DATA_MODEL.md` §14): projected ~407 MB at 12 months without mitigation. `raw_documents.text_raw` archives to R2 after 90 days and `events` roll up after 30 — both required from day one, not later.

**Alternative:** Neon (100 CU-hours, 0.5 GB/project, scale-to-zero with ~1–2s cold start). Access goes through a repository layer so switching is configuration plus a migration.
**Not viable:** PlanetScale removed its free tier entirely in April 2024.

### 3.3 Auth — Supabase Auth
Bundled, ~50k MAU, no card. Chosen over Clerk because Clerk's free allowance is reported inconsistently (10,000 MAU in older documentation versus 50,000 monthly *retained* users in 2026 materials — **a different metric as well as a different number** `[UNVERIFIED]`) and it bills at $0.02/MAU beyond the free tier, which is a real surprise-billing surface.

**The email consequence `[PR]`:** magic links and OTP consume the same ~300/day Brevo budget as digests. Therefore **OAuth is offered first** (GitHub, Google) and email OTP second. This is why `UX_FLOWS.md` §17 orders the buttons the way it does.

### 3.4 Search and vector — Postgres FTS + pgvector
No additional service, no additional cost, sufficient below ~50k records.

**Rejected:** Typesense Cloud and Meilisearch Cloud have **no permanent free tier** (720-hour and 14-day trials respectively). Algolia's free tier is limited and its record allowance is reported inconsistently across sources `[UNVERIFIED]`. Qdrant's free cluster (0.5 vCPU, 1GB RAM, 4GB disk `[UNVERIFIED]`) is a viable fallback if pgvector outgrows the database.

**Storage decision:** 384-dimension embeddings stored as `halfvec` (2 bytes/dim). At 1,536 dimensions, one million vectors would be roughly 6 GB — twelve times the entire free database. This single choice is what makes vector search possible at $0.

### 3.5 AI inference
All four providers are genuinely free with no credit card. The chain and routing are in `AI_SYSTEM.md` §3.

**Risks and mitigations:**
- **Catalogue volatility.** Cerebras has dropped models without notice; Gemini removed Pro from the free tier in 2026 and stopped publishing exact free-tier rate tables. → **Never hard-code a model name.** Models are configuration rows. `[PR]`
- **Training on inputs.** Gemini's free tier states prompts may be used to improve Google's products; Mistral's experiment tier requires opting into training. → No user personal data is sent to any LLM at all; only public web content goes to these providers. `[PR]`
- **TPM binds before RPD on Groq** (6,000 tokens/minute versus 14,400 requests/day) — batch jobs must pace themselves, not burst.
- **Total need is ~245 calls/day** against a combined ceiling in the tens of thousands. Roughly 50× headroom, which is the margin that absorbs a provider vanishing.

**The decisive move:** embeddings are generated locally inside GitHub Actions using `bge-small-en-v1.5`. Free, unlimited, no rate limit, no vendor. Without this, embedding 8,000 opportunities plus 5,000 profiles plus re-embedding on edit would exhaust every free API within days.

### 3.6 Email — Brevo
300/day (~9,000/month), 100,000 contacts, no card. The most generous durable free tier found.

**Rejected:** SendGrid (no durable free tier — 100/day for 60 days then paid); Amazon SES (no standing free allowance for new accounts, requires a card); Postmark (100/month). Resend (3,000/month, 100/day) is the fallback.

**Budget design `[PR]`:** daily cap set to **280**, leaving 20 headroom for auth. Email is a **priority queue**, not a broadcast:
| Priority | Type | Behaviour |
|---|---|---|
| 1 | Auth OTP, security | Always sends; reserved allocation |
| 2 | Deadline ≤48h on a tracked item | Always sends |
| 3 | Request received / accepted | Sends if budget remains |
| 4 | Digest | Sends only within remaining budget; otherwise defers a day or downgrades to in-app |
| 5 | Product announcements | Weekly windows only |

Deliverability requires SPF, DKIM and DMARC on a verified sending domain. Shared free-tier IPs have weaker inbox placement, which is a further reason Telegram carries the load.

**The hard arithmetic:** 280 emails/day supports roughly 280 daily digest recipients. **Email alone cannot be the retention mechanism past a few hundred users.** This is the single most consequential free-tier limit in the system.

### 3.7 Push — Telegram Bot API
Free, unmetered, no card, and the channel this audience already uses — research found opportunity publishers running Telegram and WhatsApp channels and explicitly promoting them as the fastest notification path.

WhatsApp Business API is **not free** and is not used. Telegram carries push; email is secondary; in-app is always available.

This is the decision that makes retention viable at $0.

### 3.8 Batch compute — GitHub Actions
**Unlimited minutes on public repositories** (2,000/month on private). Projected need is ~8 minutes/day. No CPU ceiling, so it hosts everything the 10ms Worker limit forbids.

**Condition `[PR]`:** the repository must be public, therefore **no secret may ever be committed** and the ingestion code must be safe to read publicly. Secrets live in Actions secrets. This is a security requirement, not a preference.

### 3.9 Storage, CDN, protection
- **R2**: 10 GB, **egress always free** — decisive versus S3-class alternatives. Overage is cheap and predictable.
- **Backblaze B2** requires a card to open an account, so it is the fallback rather than the default.
- **No image transformation service.** Client-side resize to three fixed sizes before upload avoids Cloudinary and ImageKit quotas entirely, and low-data mode suppresses images altogether.
- **Turnstile**: effectively unlimited, no card, no requirement to use Cloudflare DNS. Preferred over hCaptcha, whose free limit is reported inconsistently `[UNVERIFIED]`.

### 3.10 Analytics and monitoring
First-party events in Postgres plus Cloudflare Web Analytics. No third-party analytics script runs on any public page — this is a **byte-budget decision first** (a typical analytics bundle would consume a quarter of the homepage budget) and a privacy decision second. PostHog's free tier is generous but its client bundle is not affordable here.

---

## 4. QUOTA EXHAUSTION MATRIX `[PR]`

The design requirement: **exhausting any quota degrades quality, never function.**

| Exhausted | Immediate effect | Degraded behaviour | User sees |
|---|---|---|---|
| Workers 100k req/day | Dynamic routes fail | Static pages still served from cache | Cached content; personal features unavailable |
| KV reads | Cache misses | Falls through to Postgres | Slightly slower |
| All LLM providers | No extraction, no brief, no NL compile | Deterministic heuristics; cached outputs intact | Chips from heuristics; no new listings publish |
| Workers AI neurons | No query embeddings | FTS-only search | Slightly worse ranking, quiet note |
| Brevo 300/day | No email | Telegram and in-app unaffected; queue defers | Nothing, if Telegram is linked |
| Supabase egress | 402 | Edge cache serves reads | Cached content; writes fail with retry |
| Supabase storage full | Writes fail | **Prevented by archiving** | — |
| R2 | Uploads fail | Monogram fallback | No logos |
| Safe Browsing | Link checks fail | **Fail closed** — links render as plain text | Links not clickable, with an explanation |
| GitHub Actions | Jobs stop | Catalogue goes stale visibly | Stale badges appear; nothing false is shown |

**The invariant: no exhaustion path causes the product to state something untrue.** Staleness is visible; certainty degrades honestly.

---

## 5. SURPRISE-BILLING AUDIT `[PR]`

| Service | Can it bill me by surprise? |
|---|---|
| Cloudflare Pages/Workers/KV free | **No** — hard stops |
| Supabase free | **No** — 402, and spend cap blocks upgrade |
| R2 | Only above 10 GB, at $0.015/GB-month. **Set a billing alert at $1.** |
| Groq / Gemini / Cerebras / Workers AI free | **No** — 429 |
| Brevo free | **No** — sending pauses |
| GitHub Actions (public repo) | **No** |
| Turnstile | **No** |
| Sentry free | **No** — events dropped |
| Clerk (if ever used) | **Yes** — $0.02/MAU beyond free. Avoided. |
| Backblaze B2 | **Yes** — card on file. Fallback only. |

**Required practice:** no payment method is attached to any account except where unavoidable (B2, if used); billing alerts are set at $1 where a card exists; spend caps are enabled everywhere they are offered.

---

## 6. VENDOR RISK

Free tiers removed or degraded in the last 24 months, as found during research:
- **PlanetScale** — free tier removed entirely (April 2024)
- **SendGrid** — durable free tier ended; now a 60-day trial
- **Railway** — standing free tier removed
- **Fly.io, Render** — always-on free usage curtailed
- **Xata** — moved to trial plus usage
- **Cloudflare D1** — began hard-enforcing daily row limits (September 2026)
- **Gemini** — removed Pro from the free tier; stopped publishing exact rate tables

**Conclusion `[C]`:** the most durable anchors are the **Cloudflare ecosystem** and **Postgres** (Supabase or Neon — and Postgres itself is portable). Concentrate there, and keep an abstraction layer on database access, email, LLM calls and object storage from day one so any single vendor is a configuration change rather than a rewrite.

---

## 7. WHAT CHANGES AS IT GROWS

| Trigger | Change | Cost |
|---|---|---|
| >100k requests/day | Cloudflare Workers Paid | **$5/mo** — the first unavoidable cost |
| >280 digest recipients/day | Migrate digests fully to Telegram, or paid email | $0, or ~$9/mo (Brevo Starter) |
| DB >450 MB | Archive aggressively; then Supabase Pro | $0, then $25/mo |
| >50k MAU | Supabase Pro | $25/mo |
| >50k vectors or slow ANN | External vector store | $0 (Qdrant free) → paid |
| Review queue >30 min/day | **Add a human reviewer** | The real scaling cost |
| >200 new documents/day | Batch extraction nightly; raise dedupe thresholds | $0 |
| Legal threshold crossed (e.g. NDPA >200 data subjects/6 months) | Registration and DPO obligations | ₦100,000 + time |

**Realistic path:** $0 → $5/mo (Workers) → $30/mo (Workers + Supabase Pro) at roughly 10,000 MAU.

**The honest observation `[C]`:** the money is never the constraint. Human review time is. At 200 new documents a day the free infrastructure is comfortable and the operator is not. Plan for a second reviewer long before planning for a bigger server.

---

## 8. WHAT GENUINELY CANNOT BE DONE AT $0

Stated plainly, as the brief requires:

1. **Email at scale.** Beyond a few hundred daily recipients, email requires payment. Mitigated by Telegram, not solved.
2. **WhatsApp.** The Business API is not free. Not attempted.
3. **SMS.** No free tier anywhere. Not attempted — a real gap for users without smartphones or data, and an honest limitation of a web-and-Telegram product.
4. **OCR of scanned PDFs.** Some organisation PDFs are image-only. These are flagged `needs_manual` and entered by hand.
5. **Guaranteed uptime.** Free tiers hard-stop. The product is designed to degrade visibly rather than promise availability it cannot deliver.
6. **Database backups from the provider.** Replaced with self-managed `pg_dump` to R2, tested monthly.
7. **Human moderation.** No free tier supplies attention. This is the binding constraint on the whole system, and it is why the moderation surface was deliberately minimised in `01_PASS2_CRITIQUE.md`.
