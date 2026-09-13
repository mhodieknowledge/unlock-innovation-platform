# UX_FLOWS.md

Every major page and workflow. Each entry: **purpose · user goal · information hierarchy · components · actions · states · mobile behaviour**.

Visual tokens and component definitions live in `DESIGN_SYSTEM.md`. This document is about structure and sequence.

---

## 1. GLOBAL PATTERNS

**Navigation (mobile bottom bar):** Board · Search · Tracker · Rooms · You.
**Navigation (desktop top bar):** logotype · Board · Search · Countries · Tracker · Rooms · account.

**Universal rules `[PR]`:**
- All opportunity, organisation and country content is readable logged-out. Sign-in is requested only at the point of a personal action (track, intent, request), never as a gate.
- Filters and search are URL state. Back always works; every view is shareable.
- Every opportunity surface shows verdict, countdown, verification and freshness. No exceptions.
- No interstitials, no modals on arrival, no cookie banner (no non-essential cookies are set).

---

## 2. HOMEPAGE — "The board"

**Purpose:** prove in one screen that this is current and true.
**User goal:** see what is closing and whether any of it is for me.

**Hierarchy:**
1. One line stating what this is and the country scope.
2. Search field with a single example query as placeholder.
3. **The closing board** — 8 opportunity rows, soonest deadline first, server-rendered above the fold.
4. If a country is known (profile or IP hint, with a visible "not your country?" control): "Open to [country]" strip.
5. Country and category entry points as plain links.
6. Footer: counts that are true (published, last ingestion time), anti-scam statement, crawler page link.

**Deliberately absent:** hero image, illustration, gradient, big animated statistic, testimonials, fabricated community numbers, any count the product cannot verify.

**Rationale:** the most characteristic thing in this product's world is a live list of things about to close. Showing it *is* the hero. A marketing hero above it would push the actual value below the fold and cost bytes.

**Actions:** search · open an opportunity · save (prompts sign-in) · change country · browse a country or category.

**States:** normal · country selected · low-data (no logos, 2-fact grid) · offline (cached board with "Last updated" line) · degraded search (quiet `meta` note).

**Mobile:** single column, board starts within ~180px of the top. Search collapses to an icon on scroll; the board never does.

---

## 3. OPPORTUNITY DISCOVERY (`/opportunities`)

**Purpose:** narrow a large catalogue to a decision.
**User goal:** find something I can actually enter.

**Hierarchy:** search field → active chip strip → result count and sort → results → pagination.

**Components:** search input with NL support; filter chips; filter sheet (mobile) or left rail (desktop); opportunity rows; sort control (`Closing soonest` default, `Best match`, `Newest`, `Largest prize`); "Eligible for me" toggle (prominent — the product's differentiator, and it works logged-out using locally-stored profile inputs).

**Filter sheet organisation** (mobile, grouped and collapsed by default except the first two):
Eligibility (country, eligible-for-me, student, age) · Timing (deadline state) · Type (category) · Format (online/in-person/hybrid, individual/team) · Topic (skills, technologies, industries) · Value (prize, cost) · Source (organisation, verification).

**NL search behaviour `[PR]`:** typing "remote AI hackathons open to Zimbabwe" renders chips `Remote`, `Hackathons`, `AI`, `Open to Zimbabwe` above the results, labelled "from your search", each individually removable. The user always sees the interpretation. Unmapped words fall through to keyword search and are shown as a `"…"` chip.

**Actions:** search · add/remove filters · toggle eligible-for-me · sort · open · save · share the filtered URL.

**States:** results · zero results (clear-filters and widen-to-Africa actions) · loading (skeleton rows matching final height, first page only) · degraded (keyword-only note) · low-data · offline (cached results, "Showing what you've seen before").

**Mobile:** filters in a bottom sheet; applied chips scroll horizontally; results are infinite-scroll-free — an explicit "Show 20 more" button, because infinite scroll on metered data spends the user's money without asking. `[PR]`

---

## 4. OPPORTUNITY DETAIL (`/opportunities/[slug]`)

The most important page in the product, and the main SEO landing page.

**Purpose:** answer *is it open · can I apply · what's required · who else is going* without leaving.
**User goal:** decide in under a minute.

**Hierarchy (mobile, top to bottom):**
1. Title, organisation (linked), verification badge.
2. **Countdown** — black, tabular, weight by urgency, with the absolute date and the raw source string when precision is coarse.
3. **Verdict block** — the four-state verdict, per-rule outcomes each with its quoted source sentence, missing-field prompts, disclaimer, and a link to the official page.
4. Primary actions: `Apply on official site ↗` (outbound, `rel="noopener nofollow ugc"`) and `Save`.
5. Fact grid: format, team size, prize, cost, dates, location.
6. Summary (our words, ≤400 chars).
7. **Brief** (Brief Decoder output) if available: theme, deliverables, judging criteria with weights, key dates, prohibitions — each expandable to its source quote.
8. Description (normalised).
9. Eligibility rules in full.
10. Freshness and provenance: "Last checked 11 Sep · Source: [name] ↗ · First seen 3 Aug".
11. Team room entry **only above the density floor**.
12. Related opportunities.
13. Report control.

**Desktop:** two columns — narrative left (8), sticky right rail (4) holding countdown, verdict, actions and facts.

**Actions:** check eligibility (works logged-out; inputs stored locally) · apply · save · track-state change · declare intent · generate brief · report · share · view source.

**States:**
- **Open, eligible** — green rail, verdict block green wash.
- **Open, unclear** — ochre; missing-field prompts are the primary in-block action.
- **Open, not eligible** — oxblood; the block explains which rule failed and quotes it; the page still shows everything, and offers "Show similar opportunities you are eligible for".
- **No profile** — neutral; the block becomes a three-field inline form (country, student status, birth year) with the promise "No account needed".
- **Closing today** — countdown at weight 700 with an ochre dot; a sticky bottom bar on mobile carrying `Apply` and `Save`.
- **Expired** — muted page, strikethrough countdown, banner: "This closed on 30 August. It's kept here for reference." plus "See what's open from this organisation". `noindex`.
- **Disputed** — oxblood banner at the very top, apply button demoted to secondary with a warning, outbound link unstyled.
- **Merged** — notice and link to the canonical record (never a silent redirect).
- **Stale** — ochre freshness dot and "We haven't been able to re-check this since 18 Aug."
- **Rules unknown (`NO_AI` or low confidence)** — verdict block reads: "We haven't confirmed the eligibility rules for this one. Check the official page." Honest, not hidden.

**Mobile:** verdict block is above the description, always. Sticky bottom action bar appears once the page scrolls past the primary actions.

---

## 5. ELIGIBILITY CHECK (logged-out flow)

**Purpose:** deliver the core value with zero friction.
**Goal:** know whether I qualify.

**Flow:**
```
Opportunity page → "Check if you can apply"
  → 3 inline fields: country · student status · birth year
     ("No account needed. Stays on your device.")
  → Verdict renders in place, ~300ms
  → Missing-field prompts if unclear
  → Offer: "Save these details on this device so every opportunity
            shows your verdict"  [Yes / No]
  → Later offer: "Get a reminder before this closes" → Telegram or email
```

Inputs live in localStorage and are sent per-request; **nothing is persisted server-side for anonymous users** `[PR]`. On later signup they are offered as a prefill.

**States:** empty form · verdict · unclear with prompts · error (field-level) · degraded (rules unavailable — states so plainly).

---

## 6. TRACKER (`/tracker`)

**Purpose:** the personal pipeline nobody else provides.
**Goal:** know what I've committed to and what's next.

**Hierarchy:** counts by state (as filter tabs, not decoration) → "Closing soon" group → grouped list by state → export.

**Components:** state tabs; rows with countdown, verdict, state selector; inline note; reminder control; empty state.

**Actions:** change state (one tap, no confirm) · add note · set reminder · remove · export JSON/CSV · jump to opportunity.

**States:** empty (as `DESIGN_SYSTEM.md` §6.4) · populated · has-closing-today (pinned group at top) · has-expired (a "Clear 3 expired" action) · offline (cached, queued changes marked "will sync").

**Mobile:** state change via a bottom sheet listing valid transitions only. Swipe-right archives; swipe-left removes; both undoable via toast.

---

## 7. YOUR WINDOW (`/dashboard`)

**Purpose:** the bounded personalised surface that replaces a feed.
**Goal:** what should I do next.

**Hierarchy:**
1. "What should I do next" — up to 5 deterministic actions, each with its reason and one link.
2. "Closing in your window" — up to 8 eligible opportunities with deadlines ≤30 days.
3. Your teams and pending requests (only if any exist).
4. Your projects and their new matches (only if any exist).

**Explicitly finite.** The page ends. There is no more to scroll. `[PR]`

**States:** cold start (no profile → a three-field prompt plus the user's country board, honestly labelled "Popular in Ghana right now, not personalised yet") · normal · nothing closing ("Nothing you're eligible for closes in the next 30 days. Here's what's further out.") · all AI degraded (window built from country + category + urgency only, unlabelled — the user does not need to know).

**Mobile:** sections collapse to headers with counts; the next-actions list is always expanded.

---

## 8. BUILDER PROFILE

### 8.1 Own profile (`/you`)
Tabs: Public profile · Eligibility · Notifications · Account.

**Eligibility tab** is the most important settings screen in the product. Each field shows what it unlocks: *"Year of study — resolves eligibility on 23 opportunities you've viewed."* A completeness meter with the single highest-impact next field named.

Explicit statement at the top: **"Only you can see this. It is never shown to other users and never sent to any AI service."** `[PR]`

**Public profile tab** defaults to `private` with a clear explanation of the three visibility levels and exactly who can see what at each.

### 8.2 Someone else's profile (`/b/[handle]`)
Reachable only from a room, team, project or direct link (no global index in Phase 1).

Shows: name, country, headline, bio, skills, roles offered, public projects, `open_to`. **No contact details, ever.** Actions: send a contextual request (only from a shared context), block, report.

**States:** public · discoverable-in-rooms (viewer must share an active intent, else 404) · private (404) · restricted/suspended (404).

---

## 9. PROJECTS

### 9.1 Create (`/projects/new`)
Two fields to start: title and one-line pitch. `Create` is enabled immediately.

**Immediately after creation, before any other prompt**, the matched-opportunities list renders: *"4 open calls match this project and you're eligible for 3."* That moment is the feature's entire hook; nothing may be inserted before it. `[PR]`

Then progressive prompts: problem → solution → tags → roles needed → links → visibility.

### 9.2 Project detail (`/projects/[slug]`)
**Hierarchy:** title and pitch → state → matched opportunities (owner view) → problem/solution → tags → roles needed → members → links → interest action (public view).

**Actions (owner):** edit · change state · change visibility · manage members · review interest · link to an opportunity · record a submission.
**Actions (visitor):** express interest with a role and message · report · share.

**States:** private (owner only) · unlisted · public · paused (banner: "Paused since 12 July. Resume?") · archived · below density floor (no browse entry point exists).

### 9.3 Project discovery (`/projects`)
**Does not exist below 40 public projects.** Not an empty page, not a "coming soon" — the route is absent and the nav item is not rendered. `[PR]`

---

## 10. TEAM ROOM (`/opportunities/[slug]/room`)

**Purpose:** find people for *this* opportunity.
**Goal:** join or form a team before the deadline.

**Hierarchy:** opportunity header (countdown, team-size rule, your verdict) → your status → open teams → builders looking for a team → your pending requests.

**Components:** team cards (name, pitch, roles needed, size n/max, country mix, request action); builder cards (name, country, roles offered, note, request/invite action); intent control.

**Actions:** declare/change/withdraw intent · create a team · request to join · invite (owners) · decide on requests (owners) · block · report.

**States:**
- **Below floor** — the room route returns the opportunity page with a single CTA: "No one has said they're going for this yet. Say you're going." No empty list is rendered.
- **Open, no teams** — solo builders list only, plus "Start a team".
- **Active** — full room.
- **Host-platform banner** — for Devpost/MLH/HackerEarth/Devfolio/Unstop-hosted events: "This hackathon has its own teammate finder — [link]. This room is for builders in your region who are planning to enter."
- **You have a team** — your team pinned at top with its pending requests.
- **Closed** — read-only archive banner.
- **Not eligible** — a note that you can still join a team (some opportunities allow mixed teams), with the relevant rule quoted.

**Mobile:** teams and builders as separate tab panels; request composer is a bottom sheet with the 500-character counter visible.

---

## 11. REQUESTS AND THREADS

### 11.1 Sending
Bottom sheet: role selector, message (500-char counter), a reminder that links are not shown until accepted, and the send action. Rate-limit state is shown *before* composing: "You have 7 requests left today." `[PR]`

### 11.2 Deciding (`/requests`)
Grouped by context. Each shows requester name, country, roles, message and profile link. Actions: accept, decline, block, report. Bulk decline available; bulk accept deliberately is not.

### 11.3 Thread (`/threads/[id]`)
Minimal: context header (which team/project/opportunity), messages, composer, handoff banner, overflow menu (block, report, leave).

**Handoff banner** is persistent until acted on: "Move this to Telegram or WhatsApp?" → propose → other party accepts → identifiers exchanged, one channel only.

**States:** active · awaiting handoff consent · handed off (banner becomes "You're connected on Telegram") · closed (read-only, with reason) · blocked (thread disappears entirely).

---

## 12. ORGANISATION PAGE (`/organisations/[slug]`)

**Purpose:** ecosystem navigation and a trust anchor. Major SEO surface.

**Hierarchy:** name, verification, country → description → counts (open / total / typical categories) → open opportunities → past opportunities (collapsed) → website link → claim control.

**States:** unclaimed (a quiet "Is this your organisation?" line) · claim pending · verified (badge with the verification date) · suspended (listings hidden, a neutral notice).

---

## 13. COUNTRY AND CATEGORY INDEX

`/countries/[slug]`, `/categories/[slug]`, `/countries/[slug]/[category]`.

**Purpose:** the acquisition engine and the most shareable unit in the product. A community leader forwards `/countries/zimbabwe` to a WhatsApp group; that is the growth loop.

**Hierarchy:** "Open to [country]" heading with a live count → closing-this-week → all open, paginated → categories within the country → organisations active there → RSS link.

**States:** healthy · thin (fewer than 10 open: honest note plus a "suggest a source" action, and a link to Africa-wide opportunities) · empty (never shown as a bare page — always falls back to Africa-wide with a clear explanation).

---

## 14. SETTINGS

`/you/notifications` — per type × channel matrix with plain-language descriptions, quiet hours, digest frequency (daily/weekly/off), Telegram link/unlink, and a visible statement of the caps: "At most one digest a day and three other messages."

`/you/account` — email, connected accounts, low-data mode, language, timezone, **export my data**, **delete my account** (with a plain description of what happens to public content and the 30-day timeline).

---

## 15. TELEGRAM BOT

A first-class read client, not a notification pipe. `[PR]`

| Command | Response |
|---|---|
| `/start` | What this is, how to link, privacy in two lines |
| `/link <code>` | Connects to the account |
| `/today` | Up to 5 eligible items closing within 7 days |
| `/closing` | Next 10 by deadline, country-filtered |
| `/country ZW` | Opens the country board |
| `/search <q>` | Top 5 results |
| `/save <id>` | Adds to tracker |
| `/me` | Tracker summary |
| `/pause` | Suspends pushes for 30 days |
| `/stop` | Unlinks completely |

Plain text, at most three inline buttons, no images, no media. Every push states why it was sent and offers `/pause`.

---

## 16. ADMIN FLOWS

Specified in `ADMIN_SYSTEM.md`. Two UX requirements restated because they are easy to lose:
1. **Queue cards are one-thumb operable on a phone.** That is when clearing actually happens.
2. **The rule editor requires a source quote** for any eligibility rule an admin adds or edits — the same invariant the machine is held to.

---

## 17. CROSS-CUTTING FLOW: SIGN-IN

Triggered only by a personal action, never by arrival. `[PR]`

```
User taps Save / Declare intent / Request
  → Sheet: "Save this and get a reminder before it closes."
  → [Continue with GitHub] [Continue with Google] [Use email instead]
  → 18+ confirmation checkbox (required)
  → Returns to exactly where they were, action completed
  → If local eligibility inputs exist: "Use the details you already
     entered?"  [Yes / Start fresh]
```

GitHub and Google are listed first because email OTP consumes the same daily budget as the digests that drive retention (see `FREE_INFRASTRUCTURE.md` §4). This ordering is a product decision with an infrastructure cause, and it should not be reshuffled for aesthetic reasons.

---

## 18. ERROR AND OFFLINE FLOWS

**Offline:** an unobtrusive `meta` bar, "You're offline. Showing what's saved." Cached opportunities, tracker and saved items remain readable. Writes queue with a visible "will sync" marker and a manual retry. On reconnect, a single toast: "3 changes synced."

**Slow connection (>3s to first byte):** the server-rendered shell arrives first regardless; only the verdict block and recommendations show skeletons.

**Partial degradation:** never surfaced as an error. Search without embeddings renders results with a quiet note. Rules unavailable renders an honest verdict block. The product's failure style is *reduced certainty stated plainly*, never a broken page. `[PR]`
