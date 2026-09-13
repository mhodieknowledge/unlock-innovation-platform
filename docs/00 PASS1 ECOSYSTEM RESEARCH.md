# PASS 1 — ECOSYSTEM EXPLORATION

**Status:** Research output. Not a product definition.
**Date:** 12 September 2026.
**Evidence convention used throughout this package:**

| Tag | Meaning |
|---|---|
| `[V]` | **Verified** — found in a named source during research, cited inline. |
| `[R]` | **Reported** — secondary/aggregator source, plausible but not confirmed at primary source. |
| `[C]` | **Conclusion** — my analysis or inference, not a fact. Argue with it. |
| `[U]` | **Unverified** — asserted in the brief or assumed, and *not* checked. Must be checked before it drives a decision. |

---

## 1. ECOSYSTEM FINDINGS

### 1.1 How African builders actually discover opportunities today

The single most important finding, because it contradicts the brief's implicit assumption that people go to *websites* to find opportunities:

**Discovery is overwhelmingly push-based and runs through messaging apps, not search.** `[V]`

- Scholarship Region operates a Telegram channel that posts individual opportunities in a fixed format (host country, eligible countries, benefits, apply link, deadline) and appends to nearly every post: *join our WhatsApp channel for the fastest scholarship notifications.* `[V]` Telegram post volume is high and continuous (post IDs in the 20,000s). `[V]`
- Techbuild Africa runs a Telegram community (~1.1K subscribers) pushing funding updates, career opportunities and events across Africa. `[V]`
- Binaree Africa runs a Telegram group specifically for "African Techies" covering opportunities, jobs and events. `[V]`
- Guidance written for Nigerian developers explicitly advises staying "plugged into Nigerian tech Twitter/X and developer communities for the latest announcements," because programmes open and close unpredictably — *"One that was accepting applications in March might not open again until September."* `[V]`
- Community infrastructure is Slack/WhatsApp/Telegram-based: ForLoop, Andela Learning Community, DevCenter, Facebook/Meta Developer Circles, Figma Africa, GitHub Education were all documented as the on-ramps for Nigerian/African developers. `[R]` (source is dated, treat membership claims as stale)

**Implication `[C]`:** A website that requires people to *come and look* is competing against a notification that arrives in a chat app they already have open. Any product here that is web-only starts at a structural disadvantage. Push distribution is not a growth channel bolted on later — it is the primary interface.

### 1.2 The publisher layer

Opportunities reach builders through a chain: **originating organisation → aggregator/newsletter → Telegram/WhatsApp channel → peer forward.** Each hop adds latency and loses structure.

Originating organisations verified as active: `[V]`
- **Competitions / data science:** Zindi (pan-African data science competitions, Cape Town-founded 2018, runs UmojaHack Africa inter-university ML hackathon), Moonshot by TechCabal (TC Battlefield pitch competition — 960 applicants, 14 winners, $105,000 awarded since 2023; 12,650+ attendees across editions from 44+ countries), Zenith Tech Fair "Zecathon" (Nigeria; ₦140M across 10 finalists from 2,000+ contestants in 2025).
- **Training / scholarship:** ALX Africa (incl. ALX African Tech Championship with host cities Accra, Kigali, Addis Ababa), Google Africa Developer Scholarship (running under varying names since 2017; free Pluralsight/ALC access; African residents typically 18+; no degree required; Nigeria receives the largest share of places), HNG Internship (free, annual), She Code Africa (funded training, mentorship, laptop scholarship), NITDA grants, Mastercard Foundation Scholars Program, Andela Learning Community.
- **Entrepreneurship:** Tony Elumelu Foundation ($5,000 non-refundable seed + training, open across all 54 countries), Anzisha Prize (15–22), Africa's Business Heroes (Jack Ma Foundation, $1.5M annual pool), Milken–Motsepe Prize, Hult Prize, UNDP timbuktoo, MEST Africa, CcHUB, iHub, Injini, Flat6Labs, AfricArena, Villgro Africa, Jasiri, Westerwelle, Orange Digital Centers, Huawei Seeds for the Future / ICT Competition, Ingressive for Good.
- **Research / AI:** Deep Learning Indaba + IndabaX country chapters, Data Science Africa, Masakhane, AI4D Africa / IDRC, Lacuna Fund.
- **Community:** Google Developer Groups and GDG on Campus chapters across the continent, including the smaller markets.

Aggregators verified as active: Opportunity Desk, Opportunities for Africans, After School Africa (claims 400+ scholarships), Scholarship Region, Advance-Africa, plus media (TechCabal, Techpoint Africa, Disrupt Africa, MSMEAfrica). `[V]`

### 1.3 Where the ecosystem is genuinely fragmented

Fragmentation is real but it is **not primarily a listing problem** — aggregators already list a great deal. `[C]` The fragmentation that actually hurts is:

1. **Eligibility fragmentation.** Every opportunity encodes eligibility differently — country vs citizenship vs residency, age bands, student status, year of study, team size, institution type. No aggregator normalises this. A Zimbabwean second-year student must read the fine print of every listing to learn they were never eligible. `[C], supported by [V]` on the wide variance in "eligible country" fields observed in Telegram posts (ranging from "All Countries" to "West African Countries" to single-country).
2. **Freshness fragmentation.** Programmes open and close on irregular, unannounced cycles. `[V]` Aggregators optimise for publication volume and SEO, not for retraction — expired items linger.
3. **Awareness fragmentation by market.** Pan-African programmes are formally open to Zimbabwe, Zambia, Botswana, Namibia, Malawi and Mozambique, but promotion concentrates in Nigeria, Kenya, South Africa, Ghana, Egypt and Rwanda. Google's own scholarship is documented as allocating the largest share to Nigeria on population grounds. `[V]` The gap is *awareness*, not *entitlement*. `[C]`
4. **Format fragmentation.** The same opportunity exists as a Telegram post, a WordPress article, a PDF, an Airtable form and a Google Form, with different deadlines quoted in each. `[C]`

### 1.4 How teammates and teams are actually found

This is the finding that most changes the product. **Team formation is already solved, adequately, inside each host platform, and it happens after registration, not before.** `[V]`

- **Devpost:** a Participants tab where registrants browse each other and initiate contact, a discussion board for pitching ideas, and — on Devpost for Teams — a "Projects → Open for team building" filter plus direct invite from a People directory. `[V]`
- **HackerEarth:** team size is declared per hackathon; a team leader invites by email or from the registered-participant list; a "Looking for teammates" toggle publishes the team as open. `[V]`
- **Discord is the dominant informal venue.** Guidance for designers entering hackathons names Discord as "the primary platform for hackathon team formation" and advises joining communities 2–4 weeks before the event and introducing yourself with role, timezone, experience level and desired skills. `[V]` Community sizes cited: Design Buddies 92K+, Devpost Discord 45K+, MLH Community 500K+. `[R]`
- **Many people have already built the cross-platform team finder, repeatedly, and none has taken hold.** Devpost's own project archive contains a long tail of hackathon-team-matching apps — "Find Your HackathonMates", "HackTeam", "TeamFinder" (explicitly a Tinder-style swipe matcher), a 2025 "AI-powered team formation platform" whose stated inspiration is *"scattered Discord posts, endless Devpost listings, and last-minute scrambling to find teammates."* `[V]` Independent projects like DevMatchups exist on GitHub with the same premise. `[V]`

**Implication `[C]`:** The problem is real and repeatedly felt — but a standalone cross-platform teammate matcher is a graveyard. It fails because (a) it has no liquidity at the moment of need, (b) the host platform already has the registrant list and the product cannot, and (c) the need is spiky and short-lived, so nobody maintains a profile there between events. Any team formation we build must be anchored to something we uniquely have, and must not pretend to replace the host platform's registrant directory.

### 1.5 How people find projects to contribute to

**Effectively solved, by an ecosystem we should not rebuild.** `[V]`

GitHub's own documented path is label-based search (`label:"good first issue"`, `help wanted`, `up-for-grabs`), `github.com/topics/`, and personalised recommendations in Explore based on past contributions. `[V]` Curated aggregators on top of it: up-for-grabs.net, goodfirstissue.dev, firsttimersonly.com, goodfirstissues.com, CodeTriage. `[V]` Good First Issue's admission criterion is that a repo carry at least three `good first issue` labelled issues. `[V]`

One dissenting and useful view from within the open-source community: *"good first issues don't exist; the best issue for you is probably the one that you write yourself."* `[V]`

**Implication `[C]`:** Building open-source project discovery would be redundant and would lose. If we want open-source in the product, ingest `good first issue` / `help wanted` via the GitHub API as an *opportunity type* and link out. Do not build a contribution marketplace.

### 1.6 How project ideas become teams, and how opportunities connect to projects

No verified product does this well; the brief's intuition here is sound. `[C]` What exists:
- Devpost for Teams lets a project be flagged "open for team building" — but only inside one organisation's hackathon. `[V]`
- Co-founder matching (YC Co-Founder Matching, CoFoundersLab, CoffeeSpace, Antler) does person↔person matching for company formation, on a months-long timescale — YC's median signup-to-match is ~100 days. `[R]` That is the wrong timescale for a hackathon with a 12-day deadline. `[C]`

The unoccupied space is the **join between a dated, deadline-bearing opportunity and a durable project record.** `[C]` Nobody answers "which open calls does the thing I am already building qualify for?" — and that question is answerable deterministically from structured eligibility plus topic similarity, without inventing anything.

### 1.7 African context constraints that must shape the product

From the prior infrastructure research pass, carried forward because they are binding design inputs:

- **Mobile data prices vary by two orders of magnitude across target markets.** Approx. per GB: Malawi $0.38, Nigeria $0.39, Ghana $0.40, Rwanda $0.55, Kenya $0.59, Egypt $0.65, Mozambique $0.78, South Africa $1.81, **Zambia $8.01**, Botswana ~$15.55, **Zimbabwe $43.75** — the most expensive measured price globally. In Zimbabwe 1 GB is roughly 22% of average monthly income against a UN affordability target of 2%. `[V]`
- Mobile-dominant access, low-end Android prevalence, recurring undersea cable disruption, and load-shedding in South Africa, Zimbabwe, Zambia and Nigeria shaping usage into narrow power/connectivity windows. `[V/R]`
- Language: English is the practical lingua franca; French, Portuguese, Swahili, Arabic and Amharic matter for reach. `[C]`
- Data protection: Nigeria's NDPA 2023 has extraterritorial reach and defines a "Data Controller of Major Importance" to include processing personal data of **more than 200 data subjects within six months**; ₦100,000 registration; penalties up to ₦10M or 2% of annual gross revenue. Kenya DPA 2019, South Africa POPIA, Ghana DPA 2012, Zimbabwe Cyber and Data Protection Act all impose registration or compliance duties. `[V]`

**Implication `[C]`:** A 2 MB React dashboard costs a Zimbabwean student roughly 9 US cents to load once. Page weight is not a performance nicety here; it is an access-equity constraint and it should be treated as a hard budget in the same way the $0/month rule is treated as a hard budget. It also rules out map tiles, heavy third-party analytics scripts, and image-heavy layouts.

---

## 2. COMPETITIVE LANDSCAPE

| Layer | Who holds it | What they do well | Where they fail |
|---|---|---|---|
| **Opportunity aggregation (Africa)** | Opportunity Desk, Opportunities for Africans, After School Africa, Scholarship Region, Advance-Africa | Enormous volume, strong SEO, real audiences, established Telegram/WhatsApp distribution `[V]` | Ad-heavy, no structured eligibility, no personalisation, no retraction of expired items, desktop-era layouts, article-shaped not record-shaped `[C]` |
| **Push distribution** | Telegram + WhatsApp channels run by those same aggregators, plus Techbuild Africa, Binaree Africa `[V]` | Instant, zero-friction, zero data cost relative to browsing, already habitual | Unstructured, unfilterable, no eligibility check, high noise, no state (you can't mark "applied") `[C]` |
| **Hackathon hosting + team formation** | Devpost, MLH, HackerEarth, Devfolio, Unstop, DoraHacks | Own the registrant list; built-in teammate discovery and invites `[V]` | Cross-platform discovery is nonexistent; Africa-specific eligibility invisible; no pre-registration intent `[C]` |
| **Data science competitions (Africa)** | Zindi | Genuinely pan-African, high-quality, strong community `[V]` | Single vertical; not a discovery layer for anything else `[C]` |
| **Open-source contribution** | GitHub labels, up-for-grabs, goodfirstissue.dev, CodeTriage, firsttimersonly `[V]` | Comprehensive, free, canonical | Not Africa-aware, but this does not matter much for code contribution `[C]` |
| **Person↔person matching** | YC Co-Founder Matching, CoFoundersLab, CoffeeSpace, Antler, Polywork, Wellfound | Scale, brand, funding `[R]` | Wrong timescale for hackathons; weak African coverage; low intent density `[C]` |
| **Repeated failed attempts at exactly our team-matching idea** | A long tail of hackathon projects and side projects: TeamFinder, HackTeam, Find Your HackathonMates, DevMatchups, "AI-powered team formation platform" `[V]` | — | All died. Cold start, no liquidity, host platform owns the registrants `[C]` |

---

## 3. EXISTING ALTERNATIVES — what a builder does today

| Job | Current tool | Quality of current solution |
|---|---|---|
| Find out an opportunity exists | Telegram/WhatsApp channel, X, campus GDG, friend forwards `[V]` | **Good coverage, poor precision.** High volume, no filtering. |
| Check whether they can apply | Read the official rules page themselves | **Bad.** Manual, slow, error-prone, and the most common cause of wasted effort. `[C]` |
| Track what they've applied to | Notes app, spreadsheet, memory `[C]` | **Bad.** No product serves this. |
| Find teammates | Host platform participants tab; Discord; WhatsApp class group `[V]` | **Adequate where the host provides it; bad where it doesn't** (grants, fellowships, local competitions). |
| Find a project to join | GitHub labels; personal network `[V]` | **Good for code; nonexistent for non-code and for early-stage venture ideas.** `[C]` |
| Find an opportunity for an existing project | Nothing systematic `[C]` | **Nonexistent.** |
| Know if a listing is still live | Click the link and find out | **Bad.** `[C]` |

---

## 4. UNSOLVED PROBLEMS (ranked by how badly they are served)

1. **"Can I actually apply?"** — structured, per-person eligibility. Nobody does it. Highest value, most Africa-specific, fully deterministic once eligibility is extracted. `[C]`
2. **"Is this still live?"** — freshness and retraction as a first-class guarantee. Nobody does it. `[C]`
3. **"What is open to *my* country?"** — country-level normalisation that treats Africa as 54 jurisdictions, not one filter checkbox. Partially done, badly. `[C]`
4. **"What have I applied to and what's next?"** — a personal pipeline. Nobody does it. `[C]`
5. **"Which open calls fit the thing I'm already building?"** — project→opportunity direction. Nobody does it. `[C]`
6. **"Who else near me is going for this?"** — teammate discovery *for opportunities that have no host platform tooling*. Partially done, only where the host provides it. `[C]`
7. **"What are the actual judging criteria and deliverables?"** — brief decoding. Currently requires reading a PDF on a phone over expensive data. `[C]`

Note that items 1–4 require **no AI at query time, no network effects, and no other users.** They are deliverable by one person at $0 and are valuable on day one to a single user. Items 5–7 require content density or other users. `[C]`

---

## 5. OPPORTUNITIES AND GAPS

**Gap A — Structured eligibility as a product primitive.** Extract eligibility *once* at ingestion into a machine-evaluable rule set; evaluate deterministically against a user's eligibility profile. Produces a verdict with per-rule reasons and quoted source text. This is the defensible core. `[C]`

**Gap B — Freshness as a promise, not a hope.** Every record carries `last_verified_at`, a verification state, automated link-health and deadline checks, and one-tap community reporting. "We never show you a dead opportunity" is a stronger claim than "we have the most opportunities." `[C]`

**Gap C — Push-first distribution on free rails.** Telegram Bot API is free and unmetered; it is where the audience already is. `[V on audience, C on strategy]` A Telegram bot delivering *personalised, eligibility-filtered* alerts is a direct upgrade on the incumbent channels' unfiltered firehose, and it costs nothing.

**Gap D — The underserved-market wedge.** Start where the awareness gap is widest and incumbents are weakest — Zimbabwe, Zambia, Botswana, Namibia, Malawi, Mozambique — rather than fighting for Lagos and Nairobi SEO. `[C]`

**Gap E — Intent as the liquidity primitive.** Let people declare "I'm going for this" *before* registration closes. Intent is a lightweight, honest signal that creates a per-opportunity pool of real, time-bound, motivated people — which is exactly what every failed teammate-matcher lacked. `[C]`

**Gap F — Project→opportunity matching.** Structurally novel, cheap to compute (embedding similarity + deterministic eligibility), and it gives projects a reason to exist on the platform beyond vanity. `[C]`

---

## 6. WHAT SHOULD CHANGE IN THE ORIGINAL CONCEPT

*(Detailed argument in Pass 2; summary here.)*

**Strong and should be kept:**
- The three-worlds model (Opportunities / People / Projects) as a *data* model. `[C]`
- Opportunity directory with normalised structured fields.
- AI eligibility analysis — but redesigned as deterministic rule evaluation over AI-extracted rules.
- Deadline states and personal tracking.
- Trust/verification states and community reporting.
- Africa-first country modelling (54 jurisdictions, not one filter).
- Mobile-first, accessibility, the $0 constraint, the anti-social-network philosophy.
- Organisations as first-class entities.

**Weak, redundant, or actively harmful:**
- **Open builder discovery directory** — a social network with no liquidity; the graveyard pattern. Must be re-scoped to opportunity-anchored.
- **AI judging simulator** — fabricates authority, consumes scarce free quota, and a general chatbot does it better. `[C]`
- **AI hackathon copilot** — feature creep into a chat product we cannot win.
- **AI project idea generator** — commodity; identical output available free elsewhere.
- **Natural-language search as the primary search** — should be a transparent query *parser*, never an answering layer.
- **Africa map as a navigation surface** — the brief already warns against decoration; map tiles also violate the data budget. Replace with a lightweight country index.
- **Achievements** — gamification without a reason; defer.
- **Open messaging/DMs** — the single largest moderation liability for a zero-budget solo-operated platform.
- **Open-source project discovery** — GitHub and up-for-grabs own this; ingest, don't rebuild.

**Missing and important:**
- **Eligibility profile** as a first-class object (country, citizenship, residency, student status, year, age band, institution, languages, availability).
- **Intent declaration** on an opportunity — the liquidity primitive.
- **Telegram bot as a first-class client**, not a notification afterthought.
- **Low-data mode and offline-tolerant PWA** with an explicit page-weight budget.
- **Source registry and provenance** as a named system with its own admin surface.
- **Organisation self-serve submission and claim flow** — the only way to fight staleness at $0.
- **An explicit freshness/decay model** with automated re-verification.
- **Deterministic fallbacks for every AI path**, so quota exhaustion degrades quality, never function.

---

## 7. REFINED PRODUCT THESIS (end of Pass 1)

> **African builders do not lack opportunities. They lack certainty.**
>
> They are flooded with unfiltered listings through Telegram and WhatsApp, and for each one they must personally determine whether it is still open, whether their country qualifies, whether their year of study qualifies, what is actually required, and who would do it with them. That work is repeated by thousands of people against the same handful of documents.
>
> The product does that work once, structurally, and gives every builder a straight answer:
> **this is open, you are eligible, here is why, here is the deadline, here is who else is going for it, and here is what you already have that fits.**
>
> It reaches them where they already are — a Telegram bot and email digest first, a fast low-data web app second — and it earns trust by never showing a dead opportunity.
>
> People and Projects are not a social network attached to a directory. They are **liquidity that the opportunity creates**: you become visible to others only in the context of an opportunity you have declared intent on, and a project becomes valuable because it unlocks opportunities you did not know you qualified for.

**The one-line test the product must pass:** a second-year Computer Science student in Bulawayo with no network, on an expensive prepaid connection, opens one message and learns something true and actionable that they would not otherwise have found. Everything in the specification either serves that or is cut.
