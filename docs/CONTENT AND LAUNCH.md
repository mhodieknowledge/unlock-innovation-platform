# CONTENT_AND_LAUNCH.md

**Additional document, not in the brief's required list.** Added because the analysis in `01_PASS2_CRITIQUE.md` concluded that the most likely cause of failure is not architecture or cost — it is a thin, stale catalogue and a cold start that never resolves. That is a content and distribution problem, and it needs a specification like everything else.

---

## 1. CONTENT PRINCIPLES `[PR]`

1. **No fabrication, ever.** No fake users, no seeded teams, no invented projects, no placeholder organisations, no "1,200+ opportunities" when there are 300.
2. **Every number shown is true and computed live.** If the homepage says 312 open, it is 312 right now.
3. **Depth before breadth.** 300 verified opportunities well-covered for six countries beats 3,000 unverified across 54.
4. **Empty is better than fake.** Density floors hide thin surfaces rather than padding them.
5. **Examples are labelled as examples.** If a sample project is ever shown for onboarding, it is unmistakably marked and is not counted anywhere.

---

## 2. SEED TARGET

**Before public launch:**

| Requirement | Target |
|---|---|
| Published opportunities | ≥ 300 |
| Currently open (not expired) | ≥ 180 |
| With complete eligibility rules | ≥ 85% |
| Human-verified (not `auto`) | ≥ 120 |
| Open to each Tier-1 country | ≥ 40 each |
| Organisations, deduplicated | ≥ 80 |
| Categories with ≥ 10 open | ≥ 8 |
| Country × category pages meeting the 5-item indexing floor | ≥ 30 |

Tier-1 countries: Zimbabwe, Zambia, Botswana, Namibia, Malawi, Mozambique.

**Why 40 per country:** below roughly 40, a country page reads as abandoned and a weekly digest cannot be assembled without repetition. This is the minimum density at which the product looks alive to its first honest visitor.

---

## 3. SEEDING SEQUENCE

**Weeks 1–2 — the high-yield feeds.** Connect RSS from Opportunity Desk, Opportunities for Africans, After School Africa, Scholarship Region, TechCabal, Techpoint and Disrupt Africa. High volume, legally clean, immediate. Expect heavy filtering: most items will be global scholarships rather than builder opportunities, so category and relevance filters do the work.

**Weeks 2–3 — the APIs.** Kaggle competitions, GitHub `good first issue` and programme repositories, Eventbrite. Clean, structured, sanctioned.

**Weeks 3–5 — the organisation sources.** Direct pages for Zindi, Tony Elumelu Foundation, Mastercard Foundation, Anzisha Prize, Africa's Business Heroes, Deep Learning Indaba and IndabaX, ALX, MEST, CcHUB, iHub, Injini, Flat6Labs, She Code Africa, Ingressive for Good, Milken–Motsepe, Hult Prize, UNDP timbuktoo. Each needs an individual robots and ToS check before activation.

**Weeks 4–8 — the defensible layer.** University innovation programmes, national innovation hubs, GDG and GDG on Campus chapters, and ministry or regulator programmes across the six Tier-1 countries.

This last group is low-volume, awkward to fetch, and **almost entirely absent from every incumbent**. It is the hardest work in the seeding plan and the only part that produces something a competitor cannot replicate in a week. Weight the effort accordingly. `[C]`

**Ongoing — manual quick-add.** The admin paste-a-URL tool is the fastest path from "someone mentioned an opportunity in a WhatsApp group" to a published record. Expect this to be the single most-used admin feature in months one to three.

---

## 4. EDITORIAL STANDARDS `[PR]`

**Summaries** are written by us, ≤400 characters, factual, and validated against an 8-consecutive-word overlap check with the source. They state what it is, who it is for, and what you get. No adjectives borrowed from the organisation's own marketing.

Good: *"A pan-African data science competition on crop disease detection. Open to teams of 2–5 from any African country. $10,000 prize pool, free to enter."*

Bad: *"An exciting opportunity for passionate innovators to transform African agriculture!"*

**Descriptions** are normalised into our own structure — what it is, who can apply, what you do, what you get, how to apply — never a copy of the source page.

**Voice:** plain, specific, unexcited. The audience is choosing how to spend scarce time and data. Enthusiasm reads as sales; specificity reads as respect.

---

## 5. LAUNCH SEQUENCE

### Stage 0 — Private validation (4 weeks, before any build is public)
Run a manual digest to 30–50 real builders in Zimbabwe and Zambia, recruited through university and GDG contacts. Hand-curated, sent by email or Telegram, no product behind it.

**Proceed-or-stop thresholds `[PR]`:**
| Signal | Threshold |
|---|---|
| Open rate | ≥ 40% |
| Reply or click rate | ≥ 15% |
| "Would you miss this?" (direct question at week 4) | ≥ 50% yes |
| Applications actually started, self-reported | ≥ 5 |

**If these fail, stop.** Not "iterate on the product" — stop. A hand-curated digest to a warm audience is the most favourable possible version of this product. If it cannot hold attention, no amount of AI, matching or design will fix it. This is the cheapest kill point available and it should be honoured.

### Stage 1 — Soft launch (weeks 5–10)
Public site, seeded catalogue, Telegram bot, no accounts required for the core value. Distribution: the Stage 0 group, 2–3 university communities, 2–3 GDG chapters. Target 200–500 users.
**Watch:** eligibility-check rate per opportunity view, return-within-7-days, stale share, `zero_results` by country.

### Stage 2 — Accounts and tracker (weeks 10–16)
Sign-in, tracker, digests, saved items, eligibility profile. Target 500–1,500 users.
**Watch:** Telegram adoption (must reach 40% or the email budget binds), digest open rate, deadline-reminder delivery rate.

### Stage 3 — Intent and rooms (weeks 16–24)
Team rooms on a **curated set of 10–20 opportunities per market per month**, not the whole catalogue.
**Watch:** room fill rate, request acceptance rate. Kill criterion from `TEAM_FORMATION.md` §8 applies: under 15% of rooms reaching 3+ intents after three months means withdraw the feature rather than redesign it repeatedly.

### Stage 4 — Projects and organisations (weeks 24–36)
Project records, project→opportunity matching, organisation claim and self-serve publishing.
**Watch:** projects created, match-view rate, organisation claims completed.

### Stage 5 — Expansion (month 9+)
Tier-2 countries, French and Portuguese localisation, embeddable widget, public project browse if the density floor is met.

---

## 6. DISTRIBUTION

Ranked by expected yield per unit of effort, given what the research found about how this audience actually discovers things.

1. **Telegram and WhatsApp channels.** This is where opportunity discovery already happens — established publishers run these channels and explicitly promote them as the fastest notification path. Our RSS feeds are designed to be consumable by existing channel bots, so we can propagate *through* the ecosystem rather than compete with it.
2. **University and GDG chapters** in Tier-1 countries. A single chapter lead forwarding a country page reaches a warm, geographically concentrated group — which is also exactly what team rooms need to reach collision density.
3. **Country pages as the shareable unit.** One URL, fast, cheap to load, immediately useful. This is the growth loop, and it is why country pages get the SEO investment.
4. **Organisations.** Claiming a page gives them a reason to link to it. Free distribution, and it improves data quality at the same time.
5. **Long-tail search.** Slow to compound but durable. Country × category pages are the asset.
6. **Community leads and lecturers.** Low volume, high trust.

**Not used `[PR]`:** paid acquisition (no budget), growth hacking, cold email, scraped contact lists, engagement-bait content, or anything that would require claiming numbers we cannot verify.

---

## 7. ONBOARDING CONTENT

| Surface | Content |
|---|---|
| First visit | The closing board itself. No tour, no modal, no carousel. |
| First eligibility check | Three fields with the promise "No account needed" |
| First save | Sign-in prompt framed by the benefit: "Get a reminder before it closes" |
| After first save | The Telegram link offer — highest intent, highest conversion moment |
| First project | The matched-opportunities list, immediately, before any other prompt |
| Empty states | One sentence, one action (`DESIGN_SYSTEM.md` §6.4) |

**No onboarding tour anywhere.** The product's value should be visible in the first screen; if it needs explaining, the screen is wrong. `[PR]`

---

## 8. MAINTENANCE CADENCE

This is what actually keeps the product alive, and it is a commitment, not an aspiration.

| Cadence | Work | Time |
|---|---|---|
| Daily | Clear priority-1 and 2 queues; check source health | 15–30 min |
| Weekly | Clear remaining queues; review coverage gaps; add 2–3 sources; review guardrails | 2 h |
| Monthly | Re-verify top 50 by traffic; review source trust scores; test a backup restore | 3 h |
| Quarterly | Re-verify free-tier limits against official pages; density-floor review; **feature removal review** | 4 h |

**The honest warning `[C]`:** the most likely cause of this product's death is six weeks of skipped maintenance, after which the catalogue is stale and the trust claim is false. The alerting in `ADMIN_SYSTEM.md` §9 exists specifically to make that failure visible early. If the weekly commitment cannot be met, the correct response is to narrow the catalogue until it can be — not to let it rot at full width.

---

## 9. SUCCESS AND FAILURE CRITERIA

**Month 6 success:**
| Metric | Target |
|---|---|
| Published, open opportunities | ≥ 600 |
| Stale share | < 5% |
| Monthly active users | ≥ 1,500 |
| Return within 30 days | ≥ 35% |
| Telegram-linked share of active users | ≥ 40% |
| Eligibility checks per week | ≥ 2,000 |
| `apply_clicked` per week | ≥ 300 |
| Scam listings published | **0** |

**Month 6 failure signals — each with a named response:**
| Signal | Response |
|---|---|
| Return rate < 15% | The core loop is not valuable. Return to Stage 0 questioning. |
| Stale share > 15% | Maintenance is not happening. Narrow the catalogue. |
| Telegram adoption < 20% | Email will bind. Move the prompt earlier or accept a paid tier. |
| Rooms below 15% fill | Withdraw team formation (`TEAM_FORMATION.md` §8). |
| Any scam published under a badge | Full stop on ingestion until the gate is fixed. |

The failure responses are written now, in advance, because they are much harder to choose honestly later.
