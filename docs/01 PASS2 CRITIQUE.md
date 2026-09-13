# PASS 2 — ATTACK THE CONCEPT

**Role:** hostile product strategist. The brief is not protected. Nothing here is softened to be agreeable.

---

## A. WEAK ASSUMPTIONS IN THE ORIGINAL BRIEF

**A1. "Opportunities are hard to find."**
Mostly false. Opportunities are *relentlessly* pushed at African builders through Telegram and WhatsApp channels, campus groups, and X. Opportunity Desk, Scholarship Region, Opportunities for Africans and After School Africa publish continuously and have distribution we do not have. The scarce good is not *listings*; it is *certainty and relevance*. If the product is built on the "hard to find" premise it will produce a slightly prettier aggregator and lose to incumbents with ten years of SEO.

**A2. "If we build the three worlds, they will interconnect."**
The interconnection is the *reward* for liquidity, not a substitute for it. Opportunities have supply without users. People and Projects have supply only if users show up. Building all three at once means two of the three are permanently empty, and an empty People directory actively signals a dead product.

**A3. "AI is a genuine product capability here."**
Partly true, mostly overstated in the brief. Of the seven AI features requested, exactly two are defensible (structured extraction at ingestion; eligibility rule derivation). The rest — idea generation, hackathon copilot, judging simulation — are commodity LLM outputs that any user can get free from ChatGPT, Claude or Gemini in one prompt, with better models than our free-tier quota allows. Shipping worse versions of a free commodity is negative differentiation.

**A4. "$0/month is a cost constraint."**
It is a *product* constraint, and the brief under-reads it. At $0 you get roughly 300 emails/day (Brevo), 100,000 edge requests/day, a 500 MB database and a few thousand LLM calls/day. That does not merely limit infrastructure — it caps how many humans you can notify, which caps retention. Any design that assumes "email everyone their daily digest" breaks at ~300 users. This must be architected for, not discovered later.

**A5. "The coding agent is capable of building a large system, so plan everything."**
A coding agent can produce a large system. It cannot *operate* one. Every feature in this brief creates ongoing human labour: moderation queues, extraction review, report triage, org verification, dispute handling. A solo operator has maybe 5 hours a week. A design that needs 20 hours/week of moderation is not a design, it is a resignation letter.

**A6. "Mobile-first" is a layout instruction.**
No. At $43.75/GB in Zimbabwe and $8.01/GB in Zambia, page weight is a cost passed to the user. A 2 MB app shell costs a Zimbabwean student ~$0.09 per cold load. "Mobile-first" here means a byte budget, not a breakpoint.

**A7. Unstated assumption: that organisations want a discovery layer.**
Some do. Many run closed, invite-based, or partner-channel programmes deliberately, and some have terms that restrict republication. Assuming organisations will welcome, verify and maintain listings is optimistic; design for them being absent.

---

## B. FEATURES WITH EXCELLENT EXISTING ALTERNATIVES — do not compete

| Brief feature | Incumbent | Verdict |
|---|---|---|
| Open-source project discovery (§3, §36) | GitHub label search, up-for-grabs.net, goodfirstissue.dev, CodeTriage, firsttimersonly.com | **Do not build.** Ingest `good first issue` via GitHub API as an opportunity type; link out. |
| AI project idea generator (§20) | ChatGPT / Claude / Gemini free tiers, with better models than ours | **Cut as designed.** Only a *grounded* variant survives (see D3). |
| AI hackathon copilot (§21) | Same. Plus Notion, Linear, any LLM | **Cut.** |
| AI judging simulator (§22) | Same, and it invents authority we do not have | **Cut.** See C1. |
| Generic teammate matching (§17, §24) | Devpost Participants tab, HackerEarth "Looking for teammates" toggle, Discord servers (MLH 500K+, Devpost 45K+), plus a graveyard of failed clones (TeamFinder, HackTeam, DevMatchups, Find Your HackathonMates) | **Do not rebuild.** Re-scope to opportunities *without* host tooling, anchored to declared intent. |
| Person↔person co-founder matching | YC Co-Founder Matching, CoFoundersLab, CoffeeSpace, Antler | **Out of scope.** Different timescale (~100-day median match vs a 12-day hackathon). |
| General messaging / DMs | WhatsApp, Telegram, Discord — already installed, already used | **Do not build a messenger.** Hand off to the channel they already use, after consent. |

---

## C. FEATURES THAT CREATE LITTLE VALUE, OR ACTIVE HARM

**C1. AI Judging Simulator — cut.**
It outputs numeric scores (Innovation 8/10) that carry false precision and no calibration against the actual judges. Users will optimise against a fiction. It burns the most expensive kind of LLM call (long input, long output) for the least defensible output. Worst case: a team reworks a genuinely strong project because a rate-limited 8B model scored their impact section 6/10. Labelling it "simulation" does not remove the anchoring effect.

**C2. Open builder directory — harmful as specified.**
A browsable directory of "AI developers in Africa" with 40 profiles is a *negative* trust signal, and it invites recruiter scraping, harassment and impersonation — a moderation burden with no offsetting value while thin. It also makes the platform legible as "a social network," which the brief explicitly does not want.

**C3. Achievements — defer.**
"Hackathon participant" badges are unverifiable claims. Either we verify them (impossible at $0 across dozens of organisers) or we display self-asserted trophies, which corrodes the trust the whole product is built on.

**C4. Africa map as navigation — cut.**
The brief already warns against a decorative map. Map tiles cost data (the one thing our users cannot spare) and a choropleth of 54 countries answers no question that a country list does not answer faster. Replace with a country index page, which also serves SEO.

**C5. Natural-language search as the primary interface — demote.**
An LLM sitting in front of search is a latency tax, a quota tax, and a hallucination surface. NL should compile to visible filters the user can see and correct, then run deterministic search. If the parser is down, the filters still work.

**C6. "Endless feeds" risk.**
The brief rejects engagement bait but then specifies a personalised feed, a project board, notifications and activity. Without discipline these reconverge on a feed. The personalised surface must be **bounded and dated** — "here are the 6 things closing in your window" — not infinite scroll.

---

## D. WHAT SURVIVES, AND WHAT IT SHOULD BECOME

**D1. Eligibility → the product's spine.**
Redesign: extract eligibility **once at ingestion** into a machine-evaluable JSON rule set with source quotes and per-rule confidence. Evaluate **deterministically** against the user's eligibility profile at query time. Zero LLM calls per user. Four verdicts: `eligible` / `likely_eligible` / `unclear` / `not_eligible`, each with per-rule reasons and the quoted sentence it came from. `unclear` must be first-class and common — honest uncertainty is the trust-building behaviour, not a failure state.

This is the only feature in the entire brief that is simultaneously: highly valuable, uniquely Africa-relevant, unserved by incumbents, deterministic, free to run, and useful to the very first user with nobody else on the platform.

**D2. Freshness → the product's promise.**
Every record carries `last_verified_at`, `verification_state`, and automated checks (link health, deadline passage). Stale records are visibly downranked and labelled, not silently served. One-tap reporting ("this closed", "link broken", "deadline changed"). The marketing claim is *"we never show you a dead opportunity"* — falsifiable, defensible, and the thing incumbents are worst at.

**D3. AI idea generation → replace with the Brief Decoder.**
Not "give me ideas." Instead: take the official rules/PDF and output a *structured* decomposition — theme, eligibility, deliverables, judging criteria and weights, submission format, key dates, prohibited things — each with a source quote. It is extraction, not generation. It cannot hallucinate an opportunity. It is genuinely useful on a phone over expensive data because it replaces downloading a 4 MB PDF. And it runs once per opportunity, cached forever, not once per user.

**D4. Team formation → Intent + Team Rooms, scoped to an opportunity.**
Nobody appears in a people directory. You become visible **only** inside the room for an opportunity you have declared intent on, and only for as long as that opportunity is open. This inverts the cold-start problem: a room with 4 people is useful; a directory with 4 people is embarrassing. Prioritise opportunities *without* host-platform team tooling — grants, fellowships, local competitions, university challenges — where we are not competing with Devpost's registrant list.

**D5. Projects → keep, but justify them by the opportunity join.**
A project's payoff is not a profile ornament; it is: *"your project matches these 5 open calls you are eligible for."* That is a real, novel, cheap-to-compute value exchange that gives people a reason to create a project record.

**D6. Natural language → a transparent query compiler.**
"Remote AI hackathons open to people in Zimbabwe" → renders the chips `[remote] [category: hackathon] [topic: AI] [eligible: ZW] [status: open]`, which the user can edit. Deterministic search runs underneath. Falls back to plain keyword + filters when the parser is unavailable.

**D7. Messaging → connection requests with channel handoff.**
No open DMs. A request must be attached to a context (an opportunity intent, a team, or a project role), carries a short capped message, is rate-limited, and opens a thread **only on mutual accept**. After accept, the product offers to hand off to Telegram/WhatsApp/email rather than building a messenger. This collapses the moderation surface by an order of magnitude and matches what users actually do.

---

## E. RISK REGISTER

### E1. Cold-start
- **Opportunities:** solvable unilaterally by ingestion. Not a real risk.
- **People:** severe if built as a directory; manageable if built as opportunity-scoped rooms. Gate the rooms UI behind a minimum-density flag so an empty room is never shown to a first-time user.
- **Projects:** severe. Do not surface a "browse projects" tab until there is a floor of real projects; until then, projects exist only as private records that unlock opportunity matches.
- **Hardest version of the problem:** intent is only useful if two people declare it on the *same* opportunity within the same window. With a wide catalogue and few users, collision probability approaches zero. **Mitigation: deliberately narrow the launch catalogue** to a small number of high-salience opportunities per market, and concentrate promotion on them.

### E2. Data quality
- LLM extraction will get dates, eligibility nuance and prize amounts wrong. Never auto-publish below a confidence threshold.
- Deadline timezone ambiguity ("closes September 30") is a systematic error source — model a date plus a `time_precision` enum plus a timezone, and display conservatively.
- Duplicate opportunities across sources will be common. Dedupe on canonical URL, then title trigram + organisation + deadline, then embedding similarity, with merge review.
- **Country eligibility is the highest-stakes field.** Wrongly telling someone they are eligible wastes their time and money; wrongly excluding them is worse. Default to `unclear`, never to `eligible`, when the source is ambiguous.

### E3. Moderation and trust/safety
- **Scam opportunities are the existential risk.** "Pay a $50 processing fee" scams target exactly this audience. A scam listed on a platform that brands itself as verified is reputationally fatal. Require: no opportunity with an application fee is published without manual review; automatic scanning of outbound links; a prominent report path; a published "we never ask you to pay" statement.
- Impersonation of organisations via the claim flow — require domain-matched email for org claims.
- Harassment via connection requests — rate limits, blocking, mutual-consent threads, and no exposure of contact details before accept.
- Minors: Anzisha Prize accepts 15-year-olds, ALX runs high-school categories. If the product handles under-18 users, team rooms and messaging create a child-safety surface. **Recommendation: set a hard 16+ (or 18+) account minimum, display under-age-eligible opportunities publicly without requiring an account, and disable all connection features for anyone who is not verified 18+.** This must be decided before launch, not after.

### E4. Legal / ToS
- Scraping public pages is defensible post-*hiQ* on CFAA grounds, but *hiQ still lost on contract grounds* — $500,000 consent judgment and permanent injunction, December 2022, and the company shut down. Therefore: honour robots.txt, never create accounts to scrape, never bypass auth, prefer RSS/JSON-LD/APIs, store source attribution, and honour takedown requests within 48 hours.
- Republishing full article text from aggregators is a copyright problem. Store structured facts (deadline, eligibility, link), write our own summaries, always link to the source.
- NDPA/POPIA/DPA exposure begins early — Nigeria's "major importance" threshold is >200 data subjects in six months.

### E5. Free-infrastructure fragility
- **Email is the binding constraint:** ~300/day on Brevo, shared with auth magic links. Design implication: OAuth-first sign-in, Telegram as the primary push channel, email digests as a *budgeted queue* with priority scoring, not a broadcast.
- Supabase free projects pause after 7 days idle; Neon scales to zero. Need a keep-alive.
- Cloudflare Workers free: 100,000 requests/day, 10 ms CPU — hard-stops. Static-first rendering is mandatory, not optional.
- Free LLM catalogues are volatile (Cerebras dropped models without notice; Gemini removed Pro from free). **Never hard-code a model.** Provider abstraction with ordered fallback and a deterministic no-AI path.
- Vercel Hobby forbids commercial use; donations are permitted. Do not build a dependency on it.

### E6. Competitive threats
- Any incumbent aggregator could add country filtering in a week. **Our moat is not the filter; it is the structured eligibility corpus plus the freshness discipline plus the underserved-market relationship.** The corpus compounds; the filter does not.
- A host platform (Devpost, Zindi) expanding into discovery would be a real threat, but they are vertically motivated, not horizontally.
- The likeliest killer is not a competitor. It is **the operator stopping ingestion maintenance for six weeks**, after which the catalogue is stale and trust is gone. Automation and alerting on source health is therefore a *product* requirement, not ops hygiene.

### E7. Why users might never return
- The catalogue is thin for their country → mitigate by narrow market focus.
- They got a digest with 30 irrelevant items → mitigate by eligibility-filtered, capped digests.
- They clicked through and the opportunity had closed → this is the trust-killer; mitigate with the freshness system.
- They had to create an account before seeing value → **all opportunity content must be readable without an account.**
- Signing in cost them data and time on a slow connection → OAuth-first, tiny pages, offline tolerance.

---

## F. VERDICTS

### KEEP (unchanged in intent)
1. Opportunity directory with normalised structured records.
2. Deadline states, saving, and personal tracking (saved → planning → applied → participating → completed → outcome).
3. Country/region modelling as 54 distinct jurisdictions plus regional and global scopes.
4. Organisations as first-class entities with their own pages.
5. Trust/verification states and community reporting.
6. Extensible opportunity taxonomy (hackathons through fellowships, grants, scholarships, internships, accelerators, developer programmes, research and open-source calls).
7. Admin system as part of the product.
8. Mobile-first, accessibility, SEO, anti-social-network philosophy, $0 constraint.
9. Notifications — but see Modify.

### MODIFY
1. **Eligibility analysis** → deterministic evaluation of AI-extracted structured rules; four verdicts with source quotes; `unclear` is normal.
2. **Natural-language search** → transparent query compiler producing editable filter chips; deterministic search underneath; degrades to filters.
3. **Recommendations** → deterministic eligibility gate + embedding similarity + deadline urgency, precomputed in batch; explanation strings templated from matched rules, not LLM-generated per user.
4. **Team formation** → declared **Intent** + opportunity-scoped **Team Rooms** that open when the opportunity opens and archive when it closes.
5. **Builder discovery** → removed as a global directory; exists only inside Team Rooms and, later, as an opt-in searchable index gated on density.
6. **Projects** → private-by-default records whose primary payoff is matched open calls; public project pages only once a density floor is met.
7. **Collaboration** → context-bound connection requests, mutual-accept threads, then hand off to Telegram/WhatsApp/email.
8. **AI idea generation** → replaced by the **Brief Decoder** (structured extraction of rules, criteria, deliverables with source quotes).
9. **Notifications** → Telegram-first, email as a budgeted priority queue, hard per-user caps, digest not firehose.
10. **Africa map** → country index pages (also the SEO engine), no map tiles.
11. **Personalised feed** → a bounded, dated "Your window" surface, never infinite scroll.

### REMOVE
1. AI judging simulator.
2. AI hackathon copilot as a standalone surface.
3. Generic AI project idea generation.
4. Global browsable builder directory (as originally specified).
5. Open DMs / general messaging.
6. Open-source project discovery as an owned surface (ingest via GitHub API instead).
7. Achievements/gamification at launch (revisit only when participation can be verified).
8. Interactive map tiles.
9. "Compare ideas / evaluate ideas" flows (§37).

### ADD
1. **Eligibility Profile** as a first-class entity — the object everything keys off.
2. **Intent** on an opportunity — the liquidity primitive and the platform's most valuable proprietary signal.
3. **Telegram bot as a first-class client** (browse, filter, subscribe, receive alerts, save) — free, unmetered, and where the audience already is.
4. **Low-data mode + offline-tolerant PWA**, with an enforced byte budget per route.
5. **Source Registry** — sources as managed entities with health, cadence, robots/ToS posture, and failure alerting.
6. **Organisation self-serve submission + domain-verified claim flow.**
7. **Freshness/decay model** with scheduled re-verification and visible state.
8. **Anti-scam policy and enforcement path**, including a hard rule on application-fee listings.
9. **Deterministic fallback for every AI path** — quota exhaustion degrades quality, never function.
10. **Age policy** decided explicitly, gating all social features.
11. **Brand parameterisation** — treat the name as a config token until trademark and domain checks are complete.

---

## G. BIGGEST RISKS (ranked)

1. **Operator abandonment → catalogue staleness.** The product dies quietly. Mitigation: automation, source-health alerting, and a design that stays honest when unmaintained (stale labels rather than silent lies).
2. **Scam or fee-bearing listing published under our verification badge.** Mitigation: manual gate on any listing with a cost, link scanning, prominent reporting.
3. **Intent never reaches collision density.** Mitigation: narrow launch catalogue, narrow market, concentrated promotion.
4. **Eligibility extraction errors on country rules.** Mitigation: conservative defaults, `unclear` bias, source quotes always shown, user-correctable.
5. **Email quota caps the retention mechanism at ~300 users/day.** Mitigation: Telegram-first, priority queue, OAuth-first auth.
6. **Free-tier vendor change breaks a dependency.** Mitigation: abstraction layers on DB, email, LLM, storage from day one.
7. **Legal/ToS action from a source.** Mitigation: feeds and APIs first, robots.txt honoured, structured facts not article text, 48-hour takedown SLA.
8. **Child-safety exposure via under-18 users in social features.** Mitigation: explicit age gate before launch.

## H. BIGGEST OPPORTUNITIES (ranked)

1. **Own structured eligibility for Africa.** A compounding, proprietary corpus nobody else is building.
2. **Own freshness.** A falsifiable trust claim incumbents cannot match without changing their business model.
3. **Own the underserved markets.** Zimbabwe, Zambia, Botswana, Namibia, Malawi, Mozambique — high need, low competition, and the founder's own context.
4. **Own intent data.** Nobody knows who is going for what, before the deadline. That signal powers team rooms, recommendations, organiser value, and eventually the business model.
5. **Own the project→opportunity join.** Structurally novel and cheap.
6. **Telegram-native distribution.** Free rails into the audience's existing habit.

---

## I. FINAL PRODUCT THESIS AFTER CRITIQUE

> **A trust layer over African opportunity, with collaboration that the opportunity itself creates.**
>
> The product resolves four questions, truthfully and fast, for one person with no network:
> **Is it open? Can I apply? What is actually required? Who else is going for it?**
>
> It does that by extracting structured eligibility and requirements once, evaluating them deterministically per person, guaranteeing freshness, and reaching people through Telegram and email before the web.
>
> People and Projects are not a network bolted onto a directory — they are liquidity generated by declared intent on a specific, dated opportunity, and they appear only where they are dense enough to be useful.
>
> AI is used exactly twice where it is irreplaceable: **turning unstructured pages into structured records**, and **turning rules documents into readable briefs**. Everywhere else the system is deterministic, cached, precomputed, and works when every AI quota is exhausted.

**Scope discipline rule for the rest of this package:** every feature must survive the question *"does this help a single user with no other users present, or does it create the density that makes another feature work?"* If neither, it does not ship in Phase 1 — though it may still be specified, because the brief requires the full vision to be preserved.
